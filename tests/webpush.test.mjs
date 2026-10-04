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
