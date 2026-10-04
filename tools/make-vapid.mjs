// Generates the VAPID key pair for rest-alert pushes.
//   node tools/make-vapid.mjs | npx wrangler secret put VAPID_PRIVATE_KEY
// The private JWK goes to stdout (for piping); the public key is printed to stderr for reference.
import { publicKeyFromJwk } from '../worker/webpush.js';

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
console.error(`public key: ${publicKeyFromJwk(jwk)}`);
process.stdout.write(JSON.stringify(jwk));
