/* Cloudflare Worker. Static files in app/ are served by the assets layer
 * (wrangler.jsonc) before this code runs, so only /api/* and misses reach here.
 *
 *   GET    /api/vapid-public-key   the key the phone subscribes with (no auth)
 *   PUT    /api/rest  {endsAt, subscription}   alert when this rest ends
 *   DELETE /api/rest                           cancel the pending alert
 */
import { publicKeyFromJwk, sendPush } from './webpush.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/vapid-public-key' && request.method === 'GET') {
      if (!env.VAPID_PRIVATE_KEY) return new Response('VAPID key not configured', { status: 503 });
      return new Response(publicKeyFromJwk(JSON.parse(env.VAPID_PRIVATE_KEY)), {
        headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' },
      });
    }
    if (url.pathname !== '/api/rest') return new Response('Not found', { status: 404 });
    if (!env.APP_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.APP_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (request.method !== 'PUT' && request.method !== 'DELETE') return new Response('Method not allowed', { status: 405 });

    const timer = env.REST_TIMER.get(env.REST_TIMER.idFromName('me'));
    let body;
    if (request.method === 'PUT') {
      const data = await request.json().catch(() => ({}));
      body = JSON.stringify({ ...data, subject: url.origin }); // VAPID "sub": who to contact about these pushes
    }
    return timer.fetch('https://rest-timer/', { method: request.method, body });
  },
};

/** One instance (idFromName('me')): the phone's push subscription and a single alarm at the end of the rest. */
export class RestTimer {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const storage = this.ctx.storage;
    if (request.method === 'DELETE') {
      await storage.deleteAlarm();
      return new Response(null, { status: 204 });
    }
    const { endsAt, subscription, subject } = await request.json();
    if (!Number.isFinite(endsAt) || !subscription || !/^https:\/\//.test(subscription.endpoint || '')) {
      return new Response('Bad request', { status: 400 });
    }
    await storage.put('target', { subscription, subject });
    await storage.setAlarm(Math.max(endsAt, Date.now()));
    return new Response(null, { status: 204 });
  }

  async alarm() {
    const target = await this.ctx.storage.get('target');
    if (!target) return;
    try {
      const res = await sendPush(target.subscription, JSON.parse(this.env.VAPID_PRIVATE_KEY), target.subject);
      if (res.status === 404 || res.status === 410) await this.ctx.storage.delete('target');
      else if (!res.ok) console.error('push rejected', res.status, await res.text());
    } catch (e) {
      // Don't throw: Cloudflare would retry the alarm, and a late rest alert is worse than none.
      console.error('push failed', e);
    }
  }
}
