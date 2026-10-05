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

test('vapid-public-key is 503 when the key is not configured', async () => {
  delete env.VAPID_PRIVATE_KEY;
  const res = await call('GET', { path: '/api/vapid-public-key', token: null });
  assert.equal(res.status, 503);
  assert.equal(await res.text(), 'VAPID key not configured');
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
  assert.equal(init.body.byteLength, 0, 'explicit empty body so Content-Length: 0 is sent');
  assert.equal(init.headers.Topic, 'rest');
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
  const realError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a);
  try {
    await assert.doesNotReject(timer.alarm());
  } finally {
    console.error = realError;
  }
  assert.equal(logged.length, 1);
  assert.ok(storage.data.get('target'), 'subscription kept');
});

test('alarm() with no subscription does nothing', async () => {
  await timer.alarm();
  assert.equal(pushes.length, 0);
});
