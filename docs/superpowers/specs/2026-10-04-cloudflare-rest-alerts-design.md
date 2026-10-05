# Cloudflare hosting + rest-timer push alerts

**Date:** 2026-10-04
**Status:** approved

## Goal

When a rest timer ends, the phone gets a real notification, so the Apple Watch buzzes when the phone is locked. The app moves off GitHub Pages onto Cloudflare, which leaves two providers: Cloudflare (app + alerts) and Google (Sheet + sync). GitHub only holds the code and runs CI.

Also in scope: stop the app from interrupting Apple Music and Audible. The audio session type changes from `playback` to `ambient` (already in the working tree).

## Non-goals

- Using a custom domain. The app lives on `*.workers.dev`, and moving DNS to Cloudflare is a later, separate decision.
- Changing the Apps Script backend, the Sheet layout or the coach's access to them.
- Putting the exercise name in the notification. That needs encrypted push payloads, so the notification text is fixed.
- Queuing alerts while offline. A late rest alert is useless.

## Architecture

```
iPhone PWA (workout-logger.<sub>.workers.dev)
  ├─ sets & sessions ──► Google Apps Script ──► Sheet           (unchanged)
  └─ rest timer ──► Worker /api/rest ──► RestTimer Durable Object
                                          └─ alarm at endsAt ──► Web Push ──► phone + watch
```

There is one Worker, `workout-logger`, configured in `wrangler.jsonc` at the repo root:

- **Static assets:** serves `app/` (the `assets` binding). Every non-`/api/*` request goes to assets.
- **`/api/rest`:** authenticated with `Authorization: Bearer <APP_TOKEN>`. Any other token gets a 401.
  - `PUT /api/rest` with body `{ endsAt: <epoch ms>, subscription: <PushSubscription JSON> }` stores the subscription and sets the alarm to `endsAt`. Calling it again replaces both, which is what the +30 s button uses.
  - `DELETE /api/rest` deletes the alarm. It's idempotent.
- **`RestTimer` Durable Object** (SQLite-backed, so it's on the free plan): a single instance (`idFromName('me')`). It stores the latest subscription and holds one alarm. `alarm()` sends a Web Push with **no payload**, signed with VAPID (an ES256 JWT built with WebCrypto, `aud` = the push endpoint's origin, `sub` = the Worker's own `https://` origin, 12 h expiry), with `TTL: 60` and `Urgency: high`.
  - If the push service returns 404 or 410, the subscription is deleted.
  - Other failures are logged and not retried.
- **Secrets and variables:**
  - `APP_TOKEN` (secret): the same token as Apps Script.
  - `VAPID_PRIVATE_KEY` (secret): a JWK.
  - The page gets the public key from `GET /api/vapid-public-key`, which needs no auth.
- `tools/make-vapid.mjs` generates the key pair and prints the private JWK (the public key is derived from it).

## App changes (`app/`)

- **Settings:** an **Enable rest alerts** button, shown only when `PushManager` exists. Tapping it:
  1. calls `Notification.requestPermission()`,
  2. then `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`,
  3. stores the subscription JSON in IndexedDB `kv`.
  The button's label shows the current state: off, on or blocked. Outside the home-screen app, Settings shows a one-line hint instead.
- **Rest start** (after ✓, where `a.rest` is set) and **+30 s:** if a subscription exists, fire-and-forget `PUT /api/rest` with the new `endsAt`.
- **Rest cancel** (skip, the next ✓ while resting, finish, discard): fire-and-forget `DELETE /api/rest`. A failure is ignored. At worst a stale alert arrives.
- **Calls go to the app's own origin** (`/api/rest`, same-origin, no CORS) with the token from `state.config`.
- **Service worker (`sw.js`):**
  - `push`: show "Rest over" with body "Time for your next set", `tag: 'rest'` (each alert replaces the last) and the app icon.
  - `notificationclick`: focus an open window or open the app.
  - `/api/*` requests are never cached.
- The in-app beep and flash stay as they are.

## Deploy

- **`.github/workflows/deploy.yml`** replaces `pages.yml`:
  - The `test` job is unchanged.
  - The `deploy` job runs only on the default branch. It stamps `BUILD` in `app/sw.js` as today, then runs `npx wrangler deploy`.
  - GitHub secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- **One-time setup** (in the README):
  1. Create the API token.
  2. `wrangler secret put APP_TOKEN` and `wrangler secret put VAPID_PRIVATE_KEY`.
- **Cutover:**
  1. First deploy.
  2. Confirm the old app shows ✓ synced.
  3. Install the new URL to the home screen and paste the Apps Script URL and token.
  4. Enable rest alerts.
  5. Disable GitHub Pages and delete the `github-pages` environment.
  6. Update the README.

## Testing

- **Playwright (`tests/offline.test.mjs`):** the existing test server adds a fake `/api/rest`. The test grants notification permission and stubs `pushManager.subscribe`, then asserts:
  - a PUT with the right `endsAt` after ✓,
  - a PUT with the extended `endsAt` after +30 s,
  - a DELETE after skip and after finish,
  - that the offline flow still passes when `/api/rest` is unreachable.
- **Worker unit test (`tests/worker.test.mjs`, `node --test`):** imports `worker/index.js` and runs it with a fake Durable Object storage and stubbed `fetch`. It checks:
  - 401 on a bad or missing token,
  - PUT sets the alarm and stores the subscription,
  - DELETE clears the alarm,
  - `alarm()` POSTs to the endpoint with a VAPID `Authorization` header whose JWT verifies against the public key,
  - a 410 response deletes the subscription.
- **Manual:** the real buzz on the watch, checked on the phone after cutover.
