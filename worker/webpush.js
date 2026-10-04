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
