// End-to-end offline test (run with: npm test).
//
// 1. Serves /app and a mock Apps Script endpoint (the real Code.gs running on fakes).
// 2. Sets the app up online, then goes offline AND shuts both servers down.
// 3. Logs a full Day A session, killing the browser halfway through and again at the end.
// 4. Brings the network back with the first POST "losing" its response (server
//    commits but returns 500) to force a retry.
// 5. Asserts every set landed in the Log tab exactly once and the session row is complete.
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createBackend } from './fake-gas.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_DIR = join(ROOT, 'app');
const PROFILE = join(ROOT, '.test-profile');
const APP_PORT = 8787;
const API_PORT = 8788;
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;
const API_URL = `http://127.0.0.1:${API_PORT}/exec`;
const HEADLESS = process.env.HEADED ? false : true;

const log = (...a) => console.log('•', ...a);

// ---------- servers ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function startServer(port, handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
function stopServer(srv) {
  return new Promise((resolve) => { srv.closeAllConnections(); srv.close(() => resolve()); });
}

let swBuild = null; // when set, serve sw.js as if a new version was deployed
const appHandler = async (req, res) => {
  if (new URL(req.url, APP_URL).pathname.startsWith('/api/')) return fakeWorker(req, res);
  let p = decodeURIComponent(new URL(req.url, APP_URL).pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(APP_DIR, p));
  if (!file.startsWith(APP_DIR)) { res.writeHead(403); return res.end(); }
  try {
    let body = await readFile(file);
    if (swBuild && file.endsWith('sw.js')) body = body.toString().replace("const BUILD = 'dev'", `const BUILD = '${swBuild}'`);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
};

const backend = createBackend();
const TOKEN = backend.ctx.setup();
const traffic = { posts: 0, options: 0, contentTypes: [], failNextPostAfterCommit: 0 };

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

const apiHandler = (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const u = new URL(req.url, API_URL);
  if (req.method === 'OPTIONS') { traffic.options++; res.writeHead(405, cors); return res.end(); }
  if (req.method === 'GET') {
    const out = backend.ctx.doGet({ parameter: Object.fromEntries(u.searchParams) });
    res.writeHead(200, cors); return res.end(out.getContent());
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    traffic.posts++;
    traffic.contentTypes.push(req.headers['content-type']);
    const out = backend.ctx.doPost({ postData: { contents: body, type: req.headers['content-type'] } });
    if (traffic.failNextPostAfterCommit > 0) {
      traffic.failNextPostAfterCommit--;
      log('mock: committed the batch but answering 500 (simulated lost response)');
      res.writeHead(500, cors); return res.end('{"ok":false}');
    }
    res.writeHead(200, cors); res.end(out.getContent());
  });
};

// ---------- browser helpers ----------
async function launch() {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    // PW_CHANNEL=chrome uses the installed Google Chrome instead of Playwright's Chromium.
    channel: process.env.PW_CHANNEL || undefined,
    headless: HEADLESS,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'allow',
  });
  ctx.on('weberror', (e) => console.error('PAGE ERROR', e.error()));
  await ctx.grantPermissions(['notifications'], { origin: `http://127.0.0.1:${APP_PORT}` });
  // Headless Chromium has no push service, so pretend the browser subscribed.
  await ctx.addInitScript(() => {
    if (!self.PushManager) return;
    const json = { endpoint: 'https://push.example/sub1', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } };
    const sub = { endpoint: json.endpoint, toJSON: () => json, unsubscribe: async () => true };
    PushManager.prototype.subscribe = async () => sub;
    PushManager.prototype.getSubscription = async () => sub;
  });
  return ctx;
}
async function openApp(ctx) {
  const page = ctx.pages()[0] || await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => console.error('PAGE ERROR', e));
  await page.goto(APP_URL);
  return page;
}
const syncText = (page) => page.locator('#sync-indicator').innerText();
const outboxCount = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('workout-logger');
  r.onsuccess = () => { const q = r.result.transaction('outbox').objectStore('outbox').count(); q.onsuccess = () => { res(q.result); r.result.close(); }; };
}));
const localSetIds = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('workout-logger');
  r.onsuccess = () => { const q = r.result.transaction('sets').objectStore('sets').getAllKeys(); q.onsuccess = () => { res(q.result); r.result.close(); }; };
}));

async function logSet(page, ex, set) {
  const done = page.locator(`section[data-ex="${ex}"] .set.done`);
  const before = await done.count();
  await page.click(`[data-act="log"][data-ex="${ex}"][data-set="${set}"]`);
  await assertEventually(async () => (await done.count()) === before + 1, `set ${ex}/${set} saved`);
}
// Drag an element horizontally with the mouse (pointer events), by fractions of its width.
async function swipe(page, selector, fromFrac, toFrac) {
  const box = await page.locator(selector).boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * fromFrac, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * toFrac, y, { steps: 8 });
  await page.mouse.up();
}
const swipeLeft = (page, selector) => swipe(page, selector, 0.8, 0.15);
async function assertEventually(fn, what, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ---------- the test ----------
async function main() {
  await rm(PROFILE, { recursive: true, force: true });
  let appSrv = await startServer(APP_PORT, appHandler);
  let apiSrv = await startServer(API_PORT, apiHandler);

  // Backend sanity checks against the real Code.gs
  const planTab = backend.sheet('Plan').objects();
  assert.equal(planTab.length, 18, 'Plan seeded with 18 rows');
  assert.equal(backend.name(), 'Joseph Workout Log');
  assert.equal(JSON.parse(backend.ctx.doGet({ parameter: { action: 'plan', token: 'nope' } }).getContent()).error, 'unauthorized', 'bad token rejected');
  assert.equal(JSON.parse(backend.ctx.doPost({ postData: { contents: JSON.stringify({ token: 'x'.repeat(64), sets: [] }) } }).getContent()).error, 'unauthorized', 'bad POST token rejected');
  log('Code.gs: setup() seeded Plan, bad tokens rejected');

  // --- 1. First run, online: setup screen ---
  let ctx = await launch();
  let page = await openApp(ctx);
  await page.fill('#cfg-url', API_URL);
  await page.fill('#cfg-token', TOKEN);
  await page.click('[data-act="save-config"]');
  await page.waitForSelector('[data-act="start"][data-day="A"]');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.waitForFunction(() => window.__wl.state.plan && window.__wl.state.history);
  const cacheKeys = await page.evaluate(() => caches.keys());
  assert.ok(cacheKeys.some((k) => k.startsWith('wl-shell-')), 'app shell precached');
  await assertEventually(async () => (await syncText(page)).includes('synced'), 'synced indicator');
  log('setup done, SW controlling, plan cached, indicator:', await syncText(page));
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
  await page.click('[data-nav="settings"]');
  await page.click('[data-act="enable-alerts"]');
  await page.waitForSelector('[data-act="test-alert"]');
  assert.equal(await page.evaluate(() => window.__wl.state.push.endpoint), 'https://push.example/sub1');
  await page.click('[data-nav="home"]');
  await page.waitForSelector('[data-act="start"][data-day="A"]');
  log('rest alerts enabled');

  // --- 2. Go offline for real: emulate offline AND kill both servers ---
  await ctx.setOffline(true);
  await stopServer(appSrv);
  await stopServer(apiSrv);
  await assertEventually(async () => (await syncText(page)) === 'offline', 'offline indicator');
  log('offline; indicator:', await syncText(page));

  // --- 3. Log Day A ---
  await page.click('[data-act="start"][data-day="A"]');
  await page.waitForSelector('section[data-ex="0"]');
  const exNames = await page.locator('section.ex h3').allInnerTexts();
  assert.deepEqual(exNames, ['Barbell back squat', 'Bench press', 'Seated cable row', 'DB walking lunges', 'DB lateral raises', 'Plank']);
  assert.equal(await page.inputValue('input[data-field="w"][data-ex="0"][data-set="1"]'), '105', 'prefilled from target');
  // On narrow phones (iPhone mini = 375 pt) the number must still fit inside its box.
  for (const width of [375, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const fit = await page.evaluate(() => [...document.querySelectorAll('section[data-ex="0"] .set .stepper input')].slice(0, 2).map((i) => {
      const cs = getComputedStyle(i);
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      return { room: i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), text: ctx.measureText('102.5').width };
    }));
    for (const f of fit) assert.ok(f.room >= f.text, `at ${width}px a weight like 102.5 fits its box (${Math.round(f.room)} ≥ ${Math.round(f.text)})`);
  }

  // Squat set 1: bump weight +5 → 110 and verify set 2 carries it.
  await page.click('[data-act="step"][data-ex="0"][data-set="1"][data-field="w"][data-delta="5"]');
  assert.equal(await page.inputValue('input[data-field="w"][data-ex="0"][data-set="1"]'), '110');
  await logSet(page, 0, 1);
  assert.ok(await page.isVisible('#rest-bar'), 'rest timer started');
  assert.equal(await page.inputValue('input[data-field="w"][data-ex="0"][data-set="2"]'), '110', 'weight carried to next set');
  await logSet(page, 0, 2);
  await logSet(page, 0, 3);

  // Bench set 2 with RIR + pain flag.
  await logSet(page, 1, 1);
  await page.click('[data-act="more"][data-ex="1"][data-set="2"]');
  await page.click('[data-act="rir"][data-ex="1"][data-set="2"][data-v="2"]');
  await page.click('[data-act="pain"][data-ex="1"][data-set="2"][data-v="muscle"]');
  await page.fill('input[data-field="note"][data-ex="1"][data-set="2"]', 'grip slipped');
  await logSet(page, 1, 2);
  await logSet(page, 1, 3);
  await page.screenshot({ path: join(ROOT, 'test-results', 'workout.png') }).catch(() => {});
  for (const s of [1, 2, 3]) await logSet(page, 2, s);
  assert.equal(await outboxCount(page), 9, '9 sets queued');

  // --- Kill the app mid-session and reopen (servers still down → served by SW) ---
  await ctx.close();
  ctx = await launch();
  await ctx.setOffline(true);
  page = await openApp(ctx);
  await page.waitForSelector('section[data-ex="0"]');
  assert.equal(await page.locator('.set.done').count(), 9, 'in-progress session survived the kill');
  log('killed & reopened offline: session resumed with 9 sets');

  for (const s of [1, 2, 3]) await logSet(page, 3, s);
  // Lateral raises: sharp pain on set 3 → red banner.
  await logSet(page, 4, 1);
  await logSet(page, 4, 2);
  await page.click('[data-act="more"][data-ex="4"][data-set="3"]');
  await page.click('[data-act="pain"][data-ex="4"][data-set="3"][data-v="sharp"]');
  assert.ok(await page.isVisible('section[data-ex="4"] .banner-sharp'), 'sharp → stop banner');
  await logSet(page, 4, 3);
  for (const s of [1, 2, 3]) await logSet(page, 5, s);
  assert.equal(await page.inputValue('input[data-field="r"][data-ex="5"][data-set="4"]').catch(() => 'none'), 'none');

  // Finish
  await page.click('[data-act="finish"]');
  await page.click('[data-energy="4"]');
  await page.fill('#fin-bw', '181.5');
  await page.fill('#fin-notes', 'Felt strong');
  await page.click('#fin-save');
  await page.waitForSelector('text=Day A done');
  await page.screenshot({ path: join(ROOT, 'test-results', 'summary.png') }).catch(() => {});
  assert.match(await page.locator('main').innerText(), /Sets logged\s*18/);
  assert.equal(await outboxCount(page), 19, '18 sets + 1 session pending');
  assert.equal(await syncText(page), 'offline · 19');
  log('session finished offline; indicator:', await syncText(page));

  // --- Kill again while everything is still unsynced ---
  await ctx.close();
  ctx = await launch();
  await ctx.setOffline(true);
  page = await openApp(ctx);
  await page.waitForSelector('[data-act="start"][data-day="A"]');
  await page.screenshot({ path: join(ROOT, 'test-results', 'home.png') }).catch(() => {});
  assert.equal(await outboxCount(page), 19, 'outbox survived the kill');
  assert.equal(backend.sheet('Log').objects().length, 0, 'nothing reached the sheet while offline');
  log('killed & reopened again: 19 items still queued');

  // --- 4. Back online. First POST commits but its response is "lost" (500). ---
  appSrv = await startServer(APP_PORT, appHandler);
  apiSrv = await startServer(API_PORT, apiHandler);
  traffic.failNextPostAfterCommit = 1;
  await ctx.setOffline(false);
  await assertEventually(async () => (await syncText(page)) === '✓ synced', '✓ synced after reconnect', 30000);
  log('back online; indicator:', await syncText(page), `(POSTs: ${traffic.posts})`);

  // --- 5. Assertions on the sheet ---
  const rows = backend.sheet('Log').objects();
  const ids = rows.map((r) => r.set_id);
  const local = await localSetIds(page);
  assert.equal(rows.length, 18, 'exactly 18 Log rows');
  assert.equal(new Set(ids).size, 18, 'no duplicate set_ids');
  assert.deepEqual([...ids].sort(), [...local].sort(), 'sheet matches device');
  assert.ok(traffic.posts >= 2, 'a retry happened after the lost response');
  assert.equal(traffic.options, 0, 'no CORS preflight');
  assert.ok(traffic.contentTypes.every((t) => t.startsWith('text/plain')), 'POSTs are text/plain');

  const squat1 = rows.find((r) => r.exercise === 'Barbell back squat' && r.set_number === 1);
  assert.equal(squat1.weight_lb, 110);
  assert.equal(squat1.reps_or_amount, 8);
  assert.equal(squat1.unit, 'reps');
  assert.equal(squat1.day, 'A');
  assert.match(squat1.logged_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  const bench2 = rows.find((r) => r.exercise === 'Bench press' && r.set_number === 2);
  assert.equal(bench2.rir, 2);
  assert.equal(bench2.pain_flag, 'muscle');
  assert.equal(bench2.set_note, 'grip slipped');
  assert.equal(rows.find((r) => r.exercise === 'DB lateral raises' && r.set_number === 3).pain_flag, 'sharp');
  const plank = rows.find((r) => r.exercise === 'Plank');
  assert.equal(plank.unit, 'sec');
  assert.equal(plank.reps_or_amount, 30);
  assert.equal(rows.find((r) => r.exercise === 'DB walking lunges').weight_lb, 5);

  const sessions = backend.sheet('Sessions').objects();
  assert.equal(sessions.length, 1, 'one Sessions row (upserted, not duplicated)');
  assert.equal(sessions[0].energy, 4);
  assert.equal(sessions[0].bodyweight_lb, 181.5);
  assert.equal(sessions[0].session_notes, 'Felt strong');
  assert.ok(sessions[0].end_time, 'end_time set');
  assert.equal(typeof sessions[0].duration_min, 'number');
  log('sheet: 18 Log rows, 18 unique set_ids, 1 complete Sessions row');

  // --- 6. Idempotency: force sync + replaying the same batch adds nothing ---
  await page.click('[data-nav="settings"]');
  await page.click('[data-act="force-sync"]');
  const replay = await page.evaluate(async ({ url, token }) => {
    const sets = await new Promise((res) => {
      const r = indexedDB.open('workout-logger');
      r.onsuccess = () => { const q = r.result.transaction('sets').objectStore('sets').getAll(); q.onsuccess = () => res(q.result); };
    });
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token, sets }) });
    return resp.json();
  }, { url: API_URL, token: TOKEN });
  assert.equal(replay.sets_inserted, 0);
  assert.equal(replay.sets_skipped, 18);
  assert.equal(backend.sheet('Log').objects().length, 18, 'still 18 rows after replay');
  log('replayed all 18 sets: 0 inserted, 18 skipped');

  // --- 7. "Last time" + "last done" + history chart ---
  await page.click('[data-nav="home"]');
  assert.match(await page.locator('[data-day="A"] .last').innerText(), /today/);
  await page.click('[data-act="start"][data-day="A"]');
  await page.waitForSelector('section[data-ex="0"]');
  assert.match(await page.locator('section[data-ex="0"] .ex-last').innerText(), /110×8, 110×8, 110×8/);
  assert.equal(await page.inputValue('input[data-field="w"][data-ex="0"][data-set="1"]'), '110', 'prefilled from last time (more than target)');
  await page.click('#btn-back');
  await page.waitForSelector('.swipe .day-btn.resume');
  await swipeLeft(page, '.swipe .day-btn.resume');
  assert.equal((await page.locator('.swipe-action').innerText()).trim(), 'Discard');
  assert.ok(await page.locator('.swipe-action').isVisible(), 'action visible after swipe');
  await page.screenshot({ path: join(ROOT, 'test-results', 'swipe.png') }).catch(() => {});
  await page.click('.swipe-action');
  await assertEventually(async () => (await page.locator('.day-btn.resume').count()) === 0, 'resume card gone after swipe-Discard');
  assert.equal(await page.evaluate(() => window.__wl.state.active), null);
  await page.waitForSelector('[data-act="start"][data-day="A"]');
  await page.click('[data-nav="history"]');
  await page.waitForSelector('svg.chart');
  assert.equal(await page.locator('details.hist-item').count(), 1);
  await page.screenshot({ path: join(ROOT, 'test-results', 'history.png') }).catch(() => {});
  log('last-time prefill, last-done date and history chart OK');

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
  // Swipe detour: with a set logged the card offers Finish; swiping back closes it; tap resumes.
  await page.click('#btn-back');
  await page.waitForSelector('.swipe .day-btn.resume');
  await swipeLeft(page, '.swipe .day-btn.resume');
  assert.equal((await page.locator('.swipe-action').innerText()).trim(), 'Finish');
  await swipe(page, '.swipe .day-btn.resume', 0.15, 0.8);
  await assertEventually(async () => !(await page.locator('.swipe').evaluate((el) => el.classList.contains('open'))), 'swipe closed');
  await assertEventually(async () => /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(await page.locator('.swipe .day-btn.resume').evaluate((el) => getComputedStyle(el).transform)), 'card back at translateX 0');
  assert.ok(!(await page.locator('.swipe-action').click({ timeout: 1000, trial: true }).then(() => true, () => false)), 'closed action is not clickable');
  // Tapping the open card closes it (does not resume).
  await swipeLeft(page, '.swipe .day-btn.resume');
  await page.click('.swipe .day-btn.resume');
  await assertEventually(async () => /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(await page.locator('.swipe .day-btn.resume').evaluate((el) => getComputedStyle(el).transform)), 'tap on open card closes it');
  assert.equal(await page.evaluate(() => window.__wl.state.view), 'home');
  assert.ok(!(await page.locator('.swipe-action').click({ timeout: 1000, trial: true }).then(() => true, () => false)), 'action not clickable after tap-close');
  await swipeLeft(page, '.swipe .day-btn.resume');
  await page.click('.swipe-action');
  await page.waitForSelector('#fin-save');
  await page.click('#fin-cancel');
  await page.waitForSelector('#fin-save', { state: 'hidden' });
  await page.waitForSelector('section[data-ex="0"]');
  // Tap on the closed card resumes.
  await page.click('#btn-back');
  await page.click('.swipe .day-btn.resume');
  await page.waitForSelector('section[data-ex="0"]');
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

  // --- 9. Deploying a new version shows the update toast; tapping it reloads onto the new SW ---
  swBuild = 'v2test';
  await page.click('[data-nav="settings"]');
  await page.click('[data-act="check-update"]');
  await page.waitForSelector('#toast:has-text("Update available")');
  await Promise.all([page.waitForEvent('load'), page.click('#toast')]);
  await assertEventually(async () => (await page.evaluate(() => caches.keys())).join() === 'wl-shell-1.0.0-v2test', 'new cache active, old one deleted');
  log('update toast shown; reload activated the new version');

  await ctx.close();
  await stopServer(appSrv);
  await stopServer(apiSrv);
  await rm(PROFILE, { recursive: true, force: true });
  console.log('\nPASS — offline session logged, app killed twice, every set synced exactly once.');
}

main().catch(async (e) => {
  console.error('\nFAIL:', e);
  process.exit(1);
});
