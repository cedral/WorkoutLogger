# Cloudflare Hosting + Rest-Timer Push Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the PWA from a single Cloudflare Worker that also sends a Web Push when a rest timer ends, so the Apple Watch buzzes.

**Architecture:** One Worker (`workout-logger`) serves `app/` as static assets. Its code handles only `/api/*`:
- `GET /api/vapid-public-key`
- `PUT /api/rest` and `DELETE /api/rest`, which forward to a single SQLite-backed Durable Object (`RestTimer`). The Durable Object stores the phone's push subscription and holds one alarm.
- When the alarm fires, the Durable Object sends a payload-less Web Push signed with VAPID (ES256 via WebCrypto).

The Google Apps Script backend is unchanged.

**Tech Stack:** Cloudflare Workers (static assets, Durable Objects, alarms), Wrangler 4, vanilla JS PWA, Node 22 `node:test`, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-04-cloudflare-rest-alerts-design.md`

## Global Constraints

- **No build step, no frameworks.** The Worker and the app are plain ES modules and scripts.
- **The Worker must be importable by plain Node.** Don't import `cloudflare:workers`. The Durable Object is a plain class with `constructor(ctx, env)`, `fetch()` and `alarm()`.
- **The push has no payload.** Notification text is fixed in `sw.js`: title `Rest over`, body `Time for your next set`, tag `rest`.
- **Push headers:** `TTL: 60`, `Urgency: high`, `Topic: rest`. VAPID JWT: `aud` = the endpoint's origin, `exp` = now + 12 h, `sub` = the Worker's own `https://` origin.
- **Auth:** `/api/rest` requires the header `Authorization: Bearer <APP_TOKEN>`. `APP_TOKEN` is the same token as Apps Script.
- **Only one secret holds key material:** `VAPID_PRIVATE_KEY` (a P-256 private JWK as a JSON string). The public key is derived from its `x`/`y`. This is a simplification of the spec's separate `VAPID_PUBLIC_KEY` var.
- **Rest-alert calls from the app are fire-and-forget.** They're never queued and never block the UI.
- **Commit messages end with:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- **Don't push to `origin` until Task 6.** Pushing to `main` triggers a deploy.

## File Map

| File | Status | Responsibility |
|---|---|---|
| `worker/webpush.js` | create | base64url helpers, derive the public key, build the VAPID header, `sendPush()` |
| `worker/index.js` | create | Worker `fetch` router (auth + `/api/*`) and the `RestTimer` Durable Object |
| `wrangler.jsonc` | create | Worker config: assets = `./app`, DO binding + SQLite migration |
| `tools/make-vapid.mjs` | create | Generate the VAPID key pair (private JWK → stdout, public key → stderr) |
| `tests/webpush.test.mjs` | create | Unit tests for `worker/webpush.js` |
| `tests/worker.test.mjs` | create | Unit tests for the router and `RestTimer` (fake storage, stubbed `fetch`) |
| `app/sw.js` | modify | `push` and `notificationclick` handlers, never cache `/api/*`, navigation falls back to `./` |
| `app/app.js` | modify | `state.push`, Rest alerts card in Settings, `restAlert()` calls, subscription refresh at boot |
| `tests/offline.test.mjs` | modify | Fake `/api/*`, stubbed `PushManager`, rest-alert assertions, simulated push delivery |
| `package.json` | modify | `wrangler` devDependency; `test:unit` and `test` scripts |
| `.gitignore` | modify | Ignore `.wrangler/` and `.dev.vars` |
| `.github/workflows/deploy.yml` | create (replaces `pages.yml`) | Run the tests, then `wrangler deploy` on the default branch |
| `README.md` | modify | Cloudflare setup, cutover, alerts, dev commands |

---

### Task 1: Web Push signing (`worker/webpush.js`)

**Files:**
- Create: `worker/webpush.js`
- Create: `tests/webpush.test.mjs`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces:
  - `b64u(bytes: ArrayBuffer|Uint8Array): string` (base64url, no padding)
  - `unb64u(str: string): Uint8Array`
  - `publicKeyFromJwk(jwk: JsonWebKey): string` (65-byte uncompressed P-256 point, base64url)
  - `vapidAuthorization(endpoint: string, privateJwk: JsonWebKey, subject: string, now = Date.now()): Promise<string>`, which returns `vapid t=<jwt>, k=<publicKey>`
  - `sendPush(subscription: {endpoint: string}, privateJwk: JsonWebKey, subject: string): Promise<Response>`

- [ ] **Step 1: Write the failing test.** Create `tests/webpush.test.mjs`:

```js
// Unit tests for worker/webpush.js (run with: npm run test:unit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64u, unb64u, publicKeyFromJwk, vapidAuthorization } from '../worker/webpush.js';

async function makeKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    jwk: await crypto.subtle.exportKey('jwk', kp.privateKey),
    raw: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)),
  };
}
const decodeJson = (part) => JSON.parse(new TextDecoder().decode(unb64u(part)));

test('b64u/unb64u round-trip without padding', () => {
  const bytes = new Uint8Array([251, 255, 0, 1, 2]);
  const s = b64u(bytes);
  assert.doesNotMatch(s, /[+/=]/);
  assert.deepEqual(unb64u(s), bytes);
});

test('publicKeyFromJwk matches the raw public key', async () => {
  const { jwk, raw } = await makeKeys();
  assert.equal(publicKeyFromJwk(jwk), b64u(raw));
});

test('vapidAuthorization is an ES256 JWT that verifies against k', async () => {
  const { jwk } = await makeKeys();
  const now = Date.UTC(2026, 9, 4);
  const h = await vapidAuthorization('https://web.push.apple.com/QabC?x=1', jwk, 'https://wl.example.workers.dev', now);
  const m = h.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(m, h);
  const [, head, claims, sig, k] = m;
  assert.equal(k, publicKeyFromJwk(jwk));
  assert.deepEqual(decodeJson(head), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(decodeJson(claims), { aud: 'https://web.push.apple.com', exp: now / 1000 + 12 * 3600, sub: 'https://wl.example.workers.dev' });
  const pub = await crypto.subtle.importKey('raw', unb64u(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64u(sig), new TextEncoder().encode(`${head}.${claims}`));
  assert.ok(ok, 'signature verifies');
});
```

- [ ] **Step 2: Add the scripts and run the test to watch it fail.** In `package.json`, set `scripts` to:

```json
    "serve": "npx http-server app -p 8080 -c-1",
    "icons": "node tools/make-icons.mjs",
    "test:unit": "node --test tests/webpush.test.mjs",
    "test": "npm run test:unit && node tests/offline.test.mjs"
```

Run: `npm run test:unit`
Expected: it fails with `Cannot find module '.../worker/webpush.js'`.

- [ ] **Step 3: Implement.** Create `worker/webpush.js`:

```js
/* Web Push with no payload: a VAPID-signed (RFC 8292) empty POST to the
 * subscription's endpoint. The service worker shows fixed text, so nothing
 * needs encrypting.
 */
const enc = new TextEncoder();

export function b64u(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Uncompressed P-256 point (0x04 || x || y), base64url — the browser's applicationServerKey. */
export function publicKeyFromJwk(jwk) {
  return b64u(new Uint8Array([4, ...unb64u(jwk.x), ...unb64u(jwk.y)]));
}

export async function vapidAuthorization(endpoint, privateJwk, subject, now = Date.now()) {
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject,
  })));
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto returns the raw r||s signature, which is exactly what JWS ES256 wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${publicKeyFromJwk(privateJwk)}`;
}

export async function sendPush(subscription, privateJwk, subject) {
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, privateJwk, subject),
      TTL: '60',        // drop it if the phone can't be reached within a minute
      Urgency: 'high',
      Topic: 'rest',    // a newer alert replaces an undelivered older one
    },
  });
}
```

- [ ] **Step 4: Run the test and check it passes.**

Run: `npm run test:unit`
Expected: `# pass 3`, `# fail 0`.

- [ ] **Step 5: Commit.**

```bash
git add worker/webpush.js tests/webpush.test.mjs package.json
git commit -m "Worker: VAPID-signed Web Push helper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Worker router + RestTimer Durable Object + Wrangler config

**Files:**
- Create: `worker/index.js`
- Create: `tests/worker.test.mjs`
- Create: `wrangler.jsonc`
- Create: `tools/make-vapid.mjs`
- Modify: `package.json` (devDependency, `test:unit`)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `publicKeyFromJwk(jwk)` and `sendPush(subscription, privateJwk, subject)` from Task 1.
- Produces (HTTP, used by the app in Task 4):
  - `GET /api/vapid-public-key` → 200, `text/plain` body = base64url public key.
  - `PUT /api/rest`, header `Authorization: Bearer <token>`, JSON body `{ endsAt: number /* epoch ms */, subscription: PushSubscriptionJSON }` → 204. Missing or bad fields → 400.
  - `DELETE /api/rest` with the same auth → 204.
  - A wrong or missing token → 401. Any other path → 404.
- Produces (module): `export default { fetch(request, env) }` and `export class RestTimer { constructor(ctx, env); fetch(request); alarm() }`. Durable Object storage key `'target'` = `{ subscription, subject }`.
- Env: `APP_TOKEN` (secret), `VAPID_PRIVATE_KEY` (secret, a JWK JSON string), `REST_TIMER` (Durable Object namespace).

- [ ] **Step 1: Write the failing test.** Create `tests/worker.test.mjs`:

```js
// Unit tests for worker/index.js: the router and the RestTimer Durable Object,
// with a fake DO storage and a stubbed global fetch standing in for the push service.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { RestTimer } from '../worker/index.js';
import { publicKeyFromJwk } from '../worker/webpush.js';

const TOKEN = 't'.repeat(64);
const ORIGIN = 'https://workout-logger.example.workers.dev';
const SUB = { endpoint: 'https://web.push.apple.com/QabC', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } };

function fakeStorage() {
  const data = new Map();
  return {
    alarm: null,
    data,
    async get(k) { return data.get(k); },
    async put(k, v) { data.set(k, v); },
    async delete(k) { return data.delete(k); },
    async setAlarm(t) { this.alarm = t; },
    async deleteAlarm() { this.alarm = null; },
  };
}

let env, storage, timer, pushes, pushStatus;
beforeEach(async () => {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  storage = fakeStorage();
  env = { APP_TOKEN: TOKEN, VAPID_PRIVATE_KEY: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)) };
  timer = new RestTimer({ storage }, env);
  env.REST_TIMER = { idFromName: (name) => name, get: () => ({ fetch: (url, init) => timer.fetch(new Request(url, init)) }) };
  pushes = [];
  pushStatus = 201;
  globalThis.fetch = async (url, init) => {
    pushes.push({ url, init });
    if (pushStatus === 'throw') throw new Error('network down');
    return new Response(null, { status: pushStatus });
  };
});

const call = (method, { path = '/api/rest', token = TOKEN, body } = {}) => worker.fetch(new Request(ORIGIN + path, {
  method,
  headers: token ? { Authorization: `Bearer ${token}` } : {},
  body: body === undefined ? undefined : JSON.stringify(body),
}), env);

test('rejects a missing or wrong token', async () => {
  assert.equal((await call('PUT', { token: null, body: { endsAt: Date.now() + 1000, subscription: SUB } })).status, 401);
  assert.equal((await call('DELETE', { token: 'nope' })).status, 401);
  assert.equal(storage.alarm, null);
  assert.equal(storage.data.size, 0);
});

test('serves the VAPID public key without auth', async () => {
  const res = await call('GET', { path: '/api/vapid-public-key', token: null });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), publicKeyFromJwk(JSON.parse(env.VAPID_PRIVATE_KEY)));
});

test('unknown paths are 404', async () => {
  assert.equal((await call('GET', { path: '/api/nope' })).status, 404);
});

test('PUT stores the subscription and sets the alarm at endsAt', async () => {
  const endsAt = Date.now() + 90_000;
  const res = await call('PUT', { body: { endsAt, subscription: SUB } });
  assert.equal(res.status, 204);
  assert.equal(storage.alarm, endsAt);
  assert.deepEqual(storage.data.get('target'), { subscription: SUB, subject: ORIGIN });
});

test('PUT with an endsAt in the past fires right away', async () => {
  const before = Date.now();
  await call('PUT', { body: { endsAt: before - 5000, subscription: SUB } });
  assert.ok(storage.alarm >= before);
});

test('PUT with a bad body is 400', async () => {
  assert.equal((await call('PUT', { body: { endsAt: 'soon', subscription: SUB } })).status, 400);
  assert.equal((await call('PUT', { body: { endsAt: Date.now(), subscription: { endpoint: 'http://insecure' } } })).status, 400);
  assert.equal(storage.alarm, null);
});

test('DELETE clears the alarm', async () => {
  await call('PUT', { body: { endsAt: Date.now() + 60_000, subscription: SUB } });
  assert.equal((await call('DELETE')).status, 204);
  assert.equal(storage.alarm, null);
});

test('alarm() sends a VAPID-signed empty push', async () => {
  await call('PUT', { body: { endsAt: Date.now() + 1000, subscription: SUB } });
  await timer.alarm();
  assert.equal(pushes.length, 1);
  const { url, init } = pushes[0];
  assert.equal(url, SUB.endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.body, undefined);
  assert.equal(init.headers.TTL, '60');
  assert.equal(init.headers.Urgency, 'high');
  assert.match(init.headers.Authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${publicKeyFromJwk(JSON.parse(env.VAPID_PRIVATE_KEY))}$`));
});

test('alarm() forgets a subscription the push service says is gone', async () => {
  await call('PUT', { body: { endsAt: Date.now() + 1000, subscription: SUB } });
  pushStatus = 410;
  await timer.alarm();
  assert.equal(storage.data.get('target'), undefined);
  await timer.alarm();
  assert.equal(pushes.length, 1, 'nothing sent once forgotten');
});

test('alarm() swallows network errors (no retry storm)', async () => {
  await call('PUT', { body: { endsAt: Date.now() + 1000, subscription: SUB } });
  pushStatus = 'throw';
  await assert.doesNotReject(timer.alarm());
  assert.ok(storage.data.get('target'), 'subscription kept');
});

test('alarm() with no subscription does nothing', async () => {
  await timer.alarm();
  assert.equal(pushes.length, 0);
});
```

- [ ] **Step 2: Add the test to the unit script and watch it fail.** In `package.json`, change `test:unit` to:

```json
    "test:unit": "node --test tests/webpush.test.mjs tests/worker.test.mjs",
```

Run: `npm run test:unit`
Expected: `worker.test.mjs` fails with `Cannot find module '.../worker/index.js'`.

- [ ] **Step 3: Implement the Worker.** Create `worker/index.js`:

```js
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
```

- [ ] **Step 4: Run the tests and check they pass.**

Run: `npm run test:unit`
Expected: `# pass 14`, `# fail 0`.

- [ ] **Step 5: Add the Wrangler config, the key tool and the ignores.** Create `wrangler.jsonc`:

```jsonc
// One Worker: serves app/ and the rest-timer push API (worker/index.js).
{
  "name": "workout-logger",
  "main": "worker/index.js",
  "compatibility_date": "2026-09-01",
  "assets": { "directory": "./app" },
  "durable_objects": {
    "bindings": [{ "name": "REST_TIMER", "class_name": "RestTimer" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RestTimer"] }],
  "observability": { "enabled": true }
  // Secrets (wrangler secret put): APP_TOKEN, VAPID_PRIVATE_KEY
}
```

Create `tools/make-vapid.mjs`:

```js
// Generates the VAPID key pair for rest-alert pushes.
//   node tools/make-vapid.mjs | npx wrangler secret put VAPID_PRIVATE_KEY
// The private JWK goes to stdout (for piping); the public key is printed to stderr for reference.
import { publicKeyFromJwk } from '../worker/webpush.js';

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
console.error(`public key: ${publicKeyFromJwk(jwk)}`);
process.stdout.write(JSON.stringify(jwk));
```

Append to `.gitignore`:

```
.wrangler/
.dev.vars
```

Install Wrangler:

Run: `npm install --save-dev wrangler@4`
Expected: `package.json` gains a `"wrangler": "^4.x.y"` devDependency, and `package-lock.json` is updated.

- [ ] **Step 6: Check that the config builds without deploying.**

Run: `node tools/make-vapid.mjs > /dev/null && npx wrangler deploy --dry-run --outdir .wrangler/dry`
Expected: the key tool prints `public key: B…` (87 characters). Wrangler prints its bindings (`env.REST_TIMER (RestTimer)  Durable Object`), lists the assets, and ends with `--dry-run: exiting now.` If Wrangler rejects `compatibility_date` as being in the future, set it to the latest date Wrangler says it supports, then re-run.

- [ ] **Step 7: Commit.**

```bash
git add worker/index.js tests/worker.test.mjs wrangler.jsonc tools/make-vapid.mjs package.json package-lock.json .gitignore
git commit -m "Worker: /api/rest + RestTimer Durable Object that pushes when a rest ends

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Service worker shows the notification

**Files:**
- Modify: `app/sw.js`
- Modify: `tests/offline.test.mjs` (simulated push delivery after setup)

**Interfaces:**
- Consumes: a push event with no data (sent by the Worker).
- Produces: a notification with title `Rest over`, body `Time for your next set`, tag `rest`. Clicking it focuses or opens the app. `/api/*` is never served from cache.

- [ ] **Step 1: Write the failing test.** In `tests/offline.test.mjs`:
  - In `launch()`, after `chromium.launchPersistentContext(...)` and before `return ctx`, add:

```js
  await ctx.grantPermissions(['notifications'], { origin: `http://127.0.0.1:${APP_PORT}` });
```

  - In `main()`, directly after the line `log('setup done, SW controlling, plan cached, indicator:', await syncText(page));`, add:

```js
  // A push from the Worker (no payload) becomes the "Rest over" notification.
  const cdp = await ctx.newCDPSession(page);
  const swReg = new Promise((res) => cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => {
    const r = e.registrations.find((x) => !x.isDeleted);
    if (r) res(r);
  }));
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: `http://127.0.0.1:${APP_PORT}`, registrationId: (await swReg).registrationId, data: '' });
  await new Promise((r) => setTimeout(r, 1000)); // headless Chrome misses the notification if getNotifications() is polled straight away
  const shown = () => page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag })));
  await assertEventually(async () => (await shown()).length === 1, 'push shows a notification');
  assert.deepEqual(await shown(), [{ title: 'Rest over', body: 'Time for your next set', tag: 'rest' }]);
  await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).forEach((n) => n.close()));
  await cdp.detach();
  log('push → "Rest over" notification');
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `node tests/offline.test.mjs`
Expected: `FAIL: Error: Timed out waiting for: push shows a notification`.

- [ ] **Step 3: Implement.** In `app/sw.js`:
  - Update the header comment's mention of "The GitHub Pages workflow" to "The deploy workflow".
  - Remove the `'./index.html',` line from `SHELL`. On Cloudflare, `/index.html` redirects to `/`, and a navigation can't be answered with a cached redirect.
  - Replace the whole `fetch` listener with:

```js
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only the app's own static files. API calls (Apps Script, /api/*) go straight to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./', { cacheName: CACHE }).then((hit) => hit || fetch(req)),
    );
    return;
  }

  event.respondWith(
    caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then((hit) => hit || fetch(req)),
  );
});

// Rest alert from the Worker. iOS requires every push to show a notification.
self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('Rest over', {
    body: 'Time for your next set',
    tag: 'rest',        // each alert replaces the previous one
    renotify: true,     // ...and still buzzes
    icon: 'icons/icon-192.png',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) return wins[0].focus();
    return self.clients.openWindow('./');
  })());
});
```

- [ ] **Step 4: Run all the tests and check they pass.**

Run: `npm test`
Expected: the unit tests pass, the log shows `push → "Rest over" notification`, and it ends with `PASS — offline session logged, app killed twice, every set synced exactly once.`

- [ ] **Step 5: Commit.**

```bash
git add app/sw.js tests/offline.test.mjs
git commit -m "Service worker: show a Rest over notification on push

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: App tells the Worker about rests; Settings can enable alerts

**Files:**
- Modify: `app/app.js`
- Modify: `tests/offline.test.mjs`

**Interfaces:**
- Consumes: `GET api/vapid-public-key`, `PUT api/rest` and `DELETE api/rest` from Task 2 (relative URLs, same origin).
- Produces: `state.push` (a `PushSubscriptionJSON` or `null`, persisted in IndexedDB `kv` under `'push'`), and `restAlert(endsAt: number|null): void`. Settings buttons: `data-act="enable-alerts"` and `data-act="test-alert"`.

- [ ] **Step 1: Write the failing test.** In `tests/offline.test.mjs`:
  - After the `const traffic = …` line, add the fake Worker API:

```js
// Fake Worker API (/api/*), served by the app server like Cloudflare does.
const FAKE_VAPID_KEY = Buffer.from([4, ...new Array(64).fill(1)]).toString('base64url');
const restCalls = [];
function fakeWorker(req, res) {
  const path = new URL(req.url, APP_URL).pathname;
  if (path === '/api/vapid-public-key') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(FAKE_VAPID_KEY); }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    restCalls.push({ method: req.method, path, auth: req.headers.authorization, body: body ? JSON.parse(body) : null, at: Date.now() });
    res.writeHead(204); res.end();
  });
}
```

  - Make the first line of `appHandler`'s body (`fakeWorker` is a hoisted function declaration, so the order doesn't matter):

```js
  if (new URL(req.url, APP_URL).pathname.startsWith('/api/')) return fakeWorker(req, res);
```

  - In `launch()`, after the `grantPermissions` line added in Task 3, add:

```js
  // Headless Chromium has no push service, so pretend the browser subscribed.
  await ctx.addInitScript(() => {
    if (!self.PushManager) return;
    const json = { endpoint: 'https://push.example/sub1', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } };
    const sub = { endpoint: json.endpoint, toJSON: () => json };
    PushManager.prototype.subscribe = async () => sub;
    PushManager.prototype.getSubscription = async () => sub;
  });
```

  - In `main()`, after the `log('push → "Rest over" notification');` line from Task 3, add:

```js
  await page.click('[data-nav="settings"]');
  await page.click('[data-act="enable-alerts"]');
  await page.waitForSelector('[data-act="test-alert"]');
  assert.equal(await page.evaluate(() => window.__wl.state.push.endpoint), 'https://push.example/sub1');
  await page.click('[data-nav="home"]');
  await page.waitForSelector('[data-act="start"][data-day="A"]');
  log('rest alerts enabled');
```

  - Rename the comment `// --- 8. Deploying a new version …` to `// --- 9. Deploying a new version …`, and insert this before it:

```js
  // --- 8. Rest alerts: the Worker hears when each rest ends, and when it's cancelled ---
  restCalls.length = 0;
  const lastRest = () => restCalls[restCalls.length - 1];
  await page.click('[data-nav="settings"]');
  await page.click('[data-act="test-alert"]');
  await assertEventually(async () => restCalls.length === 1, 'test alert PUT');
  assert.equal(lastRest().method, 'PUT');
  assert.equal(lastRest().path, '/api/rest');
  assert.equal(lastRest().auth, `Bearer ${TOKEN}`);
  assert.equal(lastRest().body.subscription.endpoint, 'https://push.example/sub1');
  assert.ok(Math.abs(lastRest().body.endsAt - (lastRest().at + 5000)) < 2000, 'test alert in ~5 s');

  await page.click('[data-nav="home"]');
  await page.click('[data-act="start"][data-day="B"]');
  await page.waitForSelector('section[data-ex="0"]');
  await logSet(page, 0, 1); // Romanian deadlift: 120 s rest
  await assertEventually(async () => restCalls.length === 2, 'PUT after ✓');
  const put = lastRest();
  assert.equal(put.method, 'PUT');
  assert.ok(Math.abs(put.body.endsAt - (put.at + 120000)) < 2000, 'alert at the end of the 120 s rest');
  await page.click('#rest-plus');
  await assertEventually(async () => restCalls.length === 3, 'PUT after +30s');
  assert.equal(lastRest().body.endsAt, put.body.endsAt + 30000);
  await page.click('#rest-skip');
  await assertEventually(async () => restCalls.length === 4 && lastRest().method === 'DELETE', 'DELETE after skip');
  await logSet(page, 0, 2);
  await assertEventually(async () => restCalls.length === 5 && lastRest().method === 'PUT', 'PUT after next ✓');
  await page.click('[data-act="finish"]');
  await page.click('[data-energy="3"]');
  await page.click('#fin-save');
  await page.waitForSelector('text=Day B done');
  await assertEventually(async () => lastRest().method === 'DELETE', 'DELETE after finish');
  log('rest alerts: PUT on ✓, +30s and test; DELETE on skip and finish');
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `node tests/offline.test.mjs`
Expected: it fails waiting on the selector `[data-act="enable-alerts"]`.

- [ ] **Step 3: Implement the state and the helpers.** In `app/app.js`:
  - In the `state` object, after `reg: null,`, add `push: null,           // PushSubscription JSON when rest alerts are on`.
  - In `loadLocal()`, add `push` to the destructured names and `idbGet('kv', 'push')` to the `Promise.all` list in the same position. Add `push` to the `Object.assign(state, { … })` call.
  - Insert this block just before the `// Rest timer — derived from a timestamp…` section header:

```js
  // ---------------------------------------------------------------------------
  // Rest alerts — the Worker pushes a notification when a rest ends (watch buzz).
  // ---------------------------------------------------------------------------
  const pushSupported = () => 'PushManager' in window && 'serviceWorker' in navigator && 'Notification' in window;
  const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

  /** Tell the Worker when this rest ends (null = cancel). Best effort: offline, the in-app beep still fires. */
  function restAlert(endsAt) {
    if (!state.push || !state.config) return;
    fetch('api/rest', {
      method: endsAt ? 'PUT' : 'DELETE',
      headers: { Authorization: `Bearer ${state.config.token}`, 'Content-Type': 'application/json' },
      body: endsAt ? JSON.stringify({ endsAt, subscription: state.push }) : undefined,
    }).catch(() => {});
  }

  async function enableAlerts() {
    try {
      if (await Notification.requestPermission() !== 'granted') { toast('Notifications not allowed', 2500); return render(); }
      const reg = await navigator.serviceWorker.ready;
      const res = await fetch('api/vapid-public-key', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(await res.text()) });
      state.push = sub.toJSON();
      await kvSet('push', state.push);
      toast('Rest alerts on', 2000);
    } catch (e) {
      toast(`Couldn't turn on alerts: ${e.message}`, 3500);
    }
    render();
  }

  /** iOS can drop or rotate a subscription; keep our copy in step with the browser's. */
  async function refreshPush() {
    if (!state.push || !pushSupported()) return;
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      const json = sub && sub.toJSON();
      if (!json || Notification.permission !== 'granted') { state.push = null; await kvDel('push'); }
      else if (json.endpoint !== state.push.endpoint) { state.push = json; await kvSet('push', json); }
    } catch { /* keep what we have */ }
  }

  function alertsCard() {
    let body;
    if (!pushSupported()) body = '<p class="small muted">Open the app from its Home Screen icon to turn on rest alerts.</p>';
    else if (Notification.permission === 'denied') body = '<p class="small muted">Notifications are blocked. Allow them for Workout in iOS Settings → Notifications.</p>';
    else if (state.push) body = `<p class="small muted">On. When a rest ends you get a notification; with the phone locked, your watch buzzes.</p>
        <button class="btn" data-act="test-alert">Send a test alert in 5 s</button>`;
    else body = `<p class="small muted">Get a notification when rest ends, so your watch buzzes.</p>
        <button class="btn primary" data-act="enable-alerts">Enable rest alerts</button>`;
    return `<div class="card stack"><h3>Rest alerts</h3>${body}</div>`;
  }
```

- [ ] **Step 4: Wire up the call sites.** In `app/app.js`:
  - **`logSet()`:** directly after `if (!(Number(pe.rest_sec) > 0)) a.rest = null;`, add:
    ```js
          restAlert(a.rest && a.rest.endsAt);
    ```
  - **`finishSession()`:** directly after its `hideRest();`, add `restAlert(null);`.
  - **`discardSession()`:** directly after its `hideRest();`, add `restAlert(null);`.
  - **`bindEvents()`:** in the `#rest-plus` handler, change `saveActive(); tickRest();` to `saveActive(); tickRest(); restAlert(r.endsAt);`. Change the `#rest-skip` handler to:
    ```js
        $('#rest-skip').addEventListener('click', () => { if (state.active) { state.active.rest = null; saveActive(); } hideRest(); restAlert(null); });
    ```
  - **`viewSettings()`:** in the template, directly after the closing `</div>` of the Sync card (the card containing `data-act="refresh"`), insert `${alertsCard()}`.
  - **`onMainClick()` switch:** before `case 'export':`, add:
    ```js
          case 'enable-alerts': return enableAlerts();
          case 'test-alert': restAlert(Date.now() + 5000); toast('Test alert in 5 s. Lock your phone now.', 3000); return;
    ```
  - **`init()`:** after `registerSW();`, add `refreshPush();`.

- [ ] **Step 5: Run all the tests and check they pass.**

Run: `npm test`
Expected: the log shows `rest alerts enabled` and `rest alerts: PUT on ✓, +30s and test; DELETE on skip and finish`, and it ends with `PASS — …`. The offline part of the run still passes even though `restAlert` calls fail while the servers are down.

- [ ] **Step 6: Commit.**

```bash
git add app/app.js tests/offline.test.mjs
git commit -m "App: rest alerts — enable in Settings, tell the Worker when rests start/end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Deploy workflow + README

**Files:**
- Create: `.github/workflows/deploy.yml`
- Delete: `.github/workflows/pages.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: GitHub repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (they're set in Task 6).

- [ ] **Step 1: Replace the workflow.**

Run: `git rm -q .github/workflows/pages.yml`

Create `.github/workflows/deploy.yml`:

```yaml
name: Test & deploy to Cloudflare

on:
  push:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm test

  deploy:
    needs: test
    # Only the default branch is published.
    if: github.ref_name == github.event.repository.default_branch
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Stamp the service worker with this commit (forces an app update on phones)
        run: |
          sed -i "s/const BUILD = 'dev'/const BUILD = '${GITHUB_SHA::7}'/" app/sw.js
          grep -n "const BUILD" app/sw.js
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- [ ] **Step 2: Update the README.**
  - **Intro bullets:** the frontend is "hosted on a Cloudflare Worker, which also sends rest-timer alerts". Add a bullet: "**Worker:** `/worker`, which serves `app/` and pushes a notification when a rest ends."
  - **Layout block:** add `worker/  index.js (router + RestTimer Durable Object), webpush.js (VAPID)` and `wrangler.jsonc  Worker config`. Replace the `deploy/` line with `.github/workflows/deploy.yml  (test, then wrangler deploy)`. Add `tools/make-vapid.mjs` to the `tools/` line.
  - **Section 2:** replace all of it with:

```markdown
## 2. Deploy the app (Cloudflare Worker)

One Worker serves `app/` and the rest-alert API. It's on the free plan.

**One-time setup**
1. `npx wrangler login`
2. `npx wrangler deploy`. Note the URL it prints (`https://workout-logger.<you>.workers.dev`).
3. `node tools/make-vapid.mjs | npx wrangler secret put VAPID_PRIVATE_KEY` (the key that signs pushes).
4. `npx wrangler secret put APP_TOKEN`, then paste the **same token** as Apps Script.
5. For auto-deploys, create a Cloudflare API token (dashboard → My Profile → API Tokens → template **Edit Cloudflare Workers**), then:
   `gh secret set CLOUDFLARE_API_TOKEN` and `gh secret set CLOUDFLARE_ACCOUNT_ID` (the ID is shown by `npx wrangler whoami`).

After that, every push runs the tests, and pushes to the default branch run `wrangler deploy` (`.github/workflows/deploy.yml`).

Don't regenerate `VAPID_PRIVATE_KEY` casually. If you do, turn rest alerts off and on again on the phone (Settings).
```

  - **Section 3:**
    - Replace the Pages URL with the workers.dev URL.
    - After step 5, add: "6. **Settings → Rest alerts → Enable rest alerts**, then Allow. Tap **Send a test alert in 5 s** and lock the phone. Your watch should buzz."
  - **Section 4:** replace "Every deploy through the workflow stamps…" with "Every deploy stamps…". Remove the "With Option B…" sentence.
  - **Section 5, "Rest timer" paragraph:** replace the last two sentences ("iOS PWAs can't vibrate. On iOS 17+ the beep plays even with the silent switch on.") with: "The beep mixes with Music/Audible instead of pausing them, and it's silent when the ring/silent switch is on. With rest alerts on, the Worker also sends a notification at the end of each rest, so a locked phone's watch buzzes. That needs a connection when the rest starts. Offline, you only get the in-app beep and flash."
  - **Section 7, commands:** add `npm run test:unit    # Worker unit tests (node --test)` and `npx wrangler dev       # Worker + app locally; needs .dev.vars with APP_TOKEN and VAPID_PRIVATE_KEY`. Change the `npm test` line's comment to `# unit tests + end-to-end offline test`.

- [ ] **Step 3: Check that the workflow file is valid YAML and that nothing still mentions Pages.**

Run: `node -e "require('fs').readFileSync('.github/workflows/deploy.yml','utf8')" && grep -n -i "github pages\|pages.yml\|github.io" README.md app/sw.js`
Expected: the grep prints nothing.

- [ ] **Step 4: Run the tests one last time.**

Run: `npm test`
Expected: `PASS — …`

- [ ] **Step 5: Commit.**

```bash
git add -A .github README.md
git commit -m "Deploy to Cloudflare instead of GitHub Pages; document rest alerts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Cutover (with the user, not a subagent)

These steps use the user's Cloudflare and GitHub accounts and their phone. Do them interactively, and confirm each outward-facing step with the user.

- [ ] **Step 1:** The user runs `! npx wrangler login` and then `! npx wrangler whoami`. Note the account ID.
- [ ] **Step 2:** `npx wrangler deploy`. Record the `*.workers.dev` URL.
- [ ] **Step 3:** `node tools/make-vapid.mjs | npx wrangler secret put VAPID_PRIVATE_KEY`.
- [ ] **Step 4:** The user runs `! npx wrangler secret put APP_TOKEN` and pastes the Apps Script token.
- [ ] **Step 5: Smoke test.**
  - `curl -s <url>/api/vapid-public-key` should return an 87-character key.
  - `curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H 'Authorization: Bearer wrong' <url>/api/rest` should return `401`.
  - `curl -sI <url>/` should return `200` and `text/html`.
- [ ] **Step 6: GitHub secrets.**
  - The user creates the API token in the dashboard, then runs `! gh secret set CLOUDFLARE_API_TOKEN`.
  - Then run `gh secret set CLOUDFLARE_ACCOUNT_ID --body <id>`.
- [ ] **Step 7: Push and watch the run.**
  - `git push origin main`, then `gh run watch`.
  - Expected: both `test` and `deploy` pass.
- [ ] **Step 8: On the phone.**
  1. Open the old app online and confirm it shows **✓ synced**.
  2. Install the new URL from Safari (Share → Add to Home Screen), then enter the Apps Script URL and token.
  3. Enable rest alerts and send a test alert with the phone locked. The watch should buzz.
  4. Delete the old icon.
- [ ] **Step 9: Retire Pages** (after the user confirms the phone works):
  - `gh api -X DELETE repos/cedral/WorkoutLogger/pages`
  - `gh api -X DELETE repos/cedral/WorkoutLogger/environments/github-pages`
