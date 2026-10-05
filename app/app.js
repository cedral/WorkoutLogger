/* Workout Logger — offline-first PWA. Vanilla JS, no build step.
 *
 * Data flow: every set is written to IndexedDB ("sets") and, in the same
 * transaction, to the "outbox". flush() POSTs the outbox to the Apps Script
 * backend and removes only what the server acknowledged. Sets carry a
 * client-generated UUID so retries are idempotent on the server.
 */
'use strict';
(() => {
  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const DB_NAME = 'workout-logger';
  const DB_VERSION = 1;
  const HISTORY_LIMIT = 1000;
  const BATCH_SIZE = 200;
  const MAX_BACKOFF_MS = 5 * 60 * 1000;
  const DAYS = {
    A: 'Squat focus',
    B: 'Hinge focus',
    C: 'Unilateral focus',
  };
  const PAIN = ['none', 'muscle', 'joint', 'sharp'];

  // Fallback plan (same as the sheet's seed) so the app works before the first sync.
  const SEED_PLAN = [
    ['A', 1, 'Barbell back squat', 3, '8', '105 lb', 120, ''],
    ['A', 2, 'Bench press', 3, '8', '100 lb', 120, ''],
    ['A', 3, 'Seated cable row', 3, '10', '85 lb', 90, ''],
    ['A', 4, 'DB walking lunges', 3, '10/leg', '5 lb DBs', 60, 'Weight is per dumbbell'],
    ['A', 5, 'DB lateral raises', 3, '12', '10 lb DBs', 60, 'Stop at shoulder height'],
    ['A', 6, 'Plank', 3, '30 sec', 'bodyweight', 60, ''],
    ['B', 1, 'Romanian deadlift', 3, '8', '95–115 lb', 120, ''],
    ['B', 2, 'Overhead press (fixed bar)', 3, '10', '60 lb', 120, 'Warm-up: 8 @ 40 lb, then 3–5 @ 50 lb'],
    ['B', 3, 'Lat pulldown', 3, '10', '80–100 lb', 90, ''],
    ['B', 4, 'Leg curl machine', 3, '12', '50–70 lb', 60, ''],
    ['B', 5, 'DB bicep curls', 3, '12', '20–25 lb DBs', 60, 'Weight is per dumbbell'],
    ['B', 6, 'Farmer carry', 3, '~40 yd', '40–50 lb DBs', 60, 'Weight is per dumbbell'],
    ['C', 1, 'Goblet squat', 3, '10', '35–50 lb', 90, ''],
    ['C', 2, 'Landmine press', 3, '10', 'TBD', 90, 'Placeholder: replaces incline DB press (left shoulder). Pick a weight.'],
    ['C', 3, 'One-arm DB row', 3, '10/side', '35–45 lb', 90, ''],
    ['C', 4, 'Bulgarian split squat', 3, '8/leg', 'bodyweight', 90, ''],
    ['C', 5, 'Tricep pushdown', 3, '12', '40–50 lb', 60, ''],
    ['C', 6, 'Hanging knee raise', 3, '10–12', 'bodyweight', 60, ''],
  ].map(([day, order, exercise, sets, target_reps, target_weight, rest_sec, notes]) =>
    ({ day, order, exercise, sets, target_reps, target_weight, rest_sec, notes }));

  // ---------------------------------------------------------------------------
  // IndexedDB
  // ---------------------------------------------------------------------------
  let dbPromise;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore('kv');
          const sets = d.createObjectStore('sets', { keyPath: 'set_id' });
          sets.createIndex('session_id', 'session_id');
          d.createObjectStore('sessions', { keyPath: 'session_id' });
          d.createObjectStore('outbox', { keyPath: 'key' });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return dbPromise;
  }
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function idbGet(store, key) { return req((await db()).transaction(store).objectStore(store).get(key)); }
  async function idbAll(store) { return req((await db()).transaction(store).objectStore(store).getAll()); }
  async function idbCount(store) { return req((await db()).transaction(store).objectStore(store).count()); }
  /** Atomic multi-store write. ops: [store, 'put'|'delete', valueOrKey, key?] */
  async function idbWrite(ops) {
    const d = await db();
    const stores = [...new Set(ops.map((o) => o[0]))];
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, 'readwrite');
      for (const [store, op, v, k] of ops) {
        const os = t.objectStore(store);
        if (op === 'put') k === undefined ? os.put(v) : os.put(v, k);
        else os.delete(v);
      }
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error);
    });
  }
  const kvSet = (key, value) => idbWrite([['kv', 'put', value, key]]);
  const kvDel = (key) => idbWrite([['kv', 'delete', key]]);

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  /** ISO 8601 with the local UTC offset, e.g. 2026-10-04T18:22:05-05:00 */
  function isoLocal(d = new Date()) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }
  function fmtDate(ymd) {
    if (!ymd) return '';
    const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function daysAgo(ymd) {
    const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
    const n = Math.round((new Date(localDate()) - new Date(`${y}-${pad(m)}-${pad(d)}`)) / 864e5);
    return n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
  }
  const fmtNum = (n) => (n === '' || n == null || isNaN(n) ? '–' : String(Math.round(Number(n) * 100) / 100));
  const fmtRest = (s) => `${Math.floor(s / 60)}:${pad(Math.floor(s % 60))}`;
  /** First number in a target string: "95–115 lb" → 95, "~40 yd" → 40, "bodyweight" → 0 */
  function firstNum(text) {
    const m = String(text ?? '').match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }
  function unitOf(targetReps) {
    const t = String(targetReps).toLowerCase();
    if (/\bsec|\bs\b|second/.test(t)) return 'sec';
    if (/\byd|yard/.test(t)) return 'yd';
    return 'reps';
  }
  const numOrBlank = (v) => (v === '' || v == null || isNaN(Number(v)) ? '' : Number(v));
  const sortSets = (a, b) => String(a.logged_at).localeCompare(String(b.logged_at)) || a.set_number - b.set_number;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    view: 'home',
    config: null,          // { url, token }
    plan: null,            // { rows, fetched_at }
    history: null,         // { sets, sessions, fetched_at }  (server copy)
    localSets: [],         // every set logged on this device
    localSessions: [],
    active: null,          // in-progress session
    summary: null,
    pending: 0,
    persisted: null,
    chartExercise: null,
    reg: null,
    push: null,           // PushSubscription JSON when rest alerts are on
  };
  const sync = { running: false, again: false, failures: 0, nextAt: 0, timer: null, lastError: null, lastSyncAt: null };

  async function loadLocal() {
    const [config, plan, history, active, syncInfo, sets, sessions, pending, push] = await Promise.all([
      idbGet('kv', 'config'), idbGet('kv', 'plan'), idbGet('kv', 'history'), idbGet('kv', 'active'),
      idbGet('kv', 'sync'), idbAll('sets'), idbAll('sessions'), idbCount('outbox'), idbGet('kv', 'push'),
    ]);
    Object.assign(state, { config, plan, history, active, localSets: sets, localSessions: sessions, pending, push });
    if (syncInfo) sync.lastSyncAt = syncInfo.lastSyncAt;
  }

  const planRows = () => (state.plan && state.plan.rows && state.plan.rows.length ? state.plan.rows : SEED_PLAN);
  const planFor = (day) => planRows().filter((r) => r.day === day).sort((a, b) => a.order - b.order);

  function normSet(s) {
    return {
      ...s,
      set_number: Number(s.set_number) || 0,
      weight_lb: numOrBlank(s.weight_lb),
      reps_or_amount: numOrBlank(s.reps_or_amount),
      rir: numOrBlank(s.rir),
      date: String(s.date || '').slice(0, 10),
    };
  }
  /** Local sets ∪ server history, de-duplicated by set_id (local copy wins). */
  function allSets() {
    const m = new Map();
    for (const s of (state.history && state.history.sets) || []) m.set(s.set_id, normSet(s));
    for (const s of state.localSets) m.set(s.set_id, normSet(s));
    return [...m.values()];
  }
  function allSessions() {
    const m = new Map();
    for (const s of (state.history && state.history.sessions) || []) m.set(s.session_id, { ...s, date: String(s.date || '').slice(0, 10) });
    for (const s of state.localSessions) m.set(s.session_id, s);
    return [...m.values()];
  }

  /** Sets from the most recent earlier session that included this exercise. */
  function lastTime(exercise, excludeSession) {
    const sets = allSets().filter((s) => s.exercise === exercise && s.session_id !== excludeSession);
    if (!sets.length) return null;
    const bySession = new Map();
    for (const s of sets) {
      if (!bySession.has(s.session_id)) bySession.set(s.session_id, []);
      bySession.get(s.session_id).push(s);
    }
    let best = null;
    for (const list of bySession.values()) {
      list.sort(sortSets);
      const key = list[0].date + list[0].logged_at;
      if (!best || key > best.key) best = { key, date: list[0].date, sets: list };
    }
    best.sets.sort((a, b) => a.set_number - b.set_number);
    return best;
  }

  function lastDone(day) {
    let best = '';
    for (const s of allSessions()) if (s.day === day && s.date > best && (!state.active || s.session_id !== state.active.session_id)) best = s.date;
    for (const s of allSets()) if (s.day === day && s.date > best && (!state.active || s.session_id !== state.active.session_id)) best = s.date;
    return best;
  }

  // ---------------------------------------------------------------------------
  // Backend API
  // ---------------------------------------------------------------------------
  async function api(method, params = {}, body = null) {
    const cfg = state.config;
    if (!cfg || !cfg.url) throw new Error('Backend not configured');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      let res;
      if (method === 'GET') {
        const u = new URL(cfg.url);
        for (const [k, v] of Object.entries({ ...params, token: cfg.token })) u.searchParams.set(k, v);
        res = await fetch(u.toString(), { signal: ctrl.signal, cache: 'no-store', redirect: 'follow' });
      } else {
        // text/plain = "simple" CORS request → no preflight (Apps Script can't answer OPTIONS).
        res = await fetch(cfg.url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ ...body, token: cfg.token }),
          signal: ctrl.signal,
          redirect: 'follow',
        });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let j;
      try { j = await res.json(); } catch { throw new Error('Bad response (is the web app URL right?)'); }
      if (!j.ok) throw new Error(j.error === 'unauthorized' ? 'Bad token' : j.error || 'Server error');
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Timed out');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refreshPlan() {
    const j = await api('GET', { action: 'plan' });
    if (Array.isArray(j.plan) && j.plan.length) {
      state.plan = { rows: j.plan, fetched_at: new Date().toISOString() };
      await kvSet('plan', state.plan);
    }
  }
  async function refreshHistory() {
    const j = await api('GET', { action: 'history', limit: HISTORY_LIMIT });
    state.history = { sets: j.sets || [], sessions: j.sessions || [], fetched_at: new Date().toISOString() };
    await kvSet('history', state.history);
  }
  async function backgroundRefresh() {
    if (!state.config || !navigator.onLine) return;
    try {
      await Promise.all([refreshPlan(), refreshHistory()]);
      if (state.view === 'home' || state.view === 'history') render();
    } catch (e) {
      console.warn('background refresh failed', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Sync (outbox flush)
  // ---------------------------------------------------------------------------
  async function updatePending() {
    state.pending = await idbCount('outbox');
    renderSync();
  }

  function renderSync() {
    const el = $('#sync-indicator');
    let text, cls;
    if (!state.config) { text = 'not set up'; cls = 'offline'; }
    else if (!navigator.onLine) { text = state.pending ? `offline · ${state.pending}` : 'offline'; cls = 'offline'; }
    else if (sync.running) { text = 'syncing…'; cls = 'pending'; }
    else if (state.pending) { text = `${state.pending} pending`; cls = sync.lastError ? 'error' : 'pending'; }
    else { text = '✓ synced'; cls = 'ok'; }
    el.textContent = text;
    el.className = `sync ${cls}`;
    el.title = sync.lastError ? `Last error: ${sync.lastError}` : '';
    if (state.view === 'settings') {
      const p = $('#settings-sync');
      if (p) p.innerHTML = syncDetails();
    }
  }

  function scheduleRetry() {
    sync.failures++;
    const base = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (sync.failures - 1));
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    sync.nextAt = Date.now() + delay;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(() => flush(), delay);
  }

  /**
   * Push the outbox to the server. Called on open, `online`, return to
   * foreground, after each set, and from "Force sync". `force` ignores the
   * backoff window (used for user-ish events); background retries respect it.
   */
  async function flush({ force = false } = {}) {
    if (!state.config || !navigator.onLine) return updatePending();
    if (sync.running) { sync.again = true; return; }
    if (!force && Date.now() < sync.nextAt) return;
    sync.running = true;
    renderSync();
    try {
      for (;;) {
        const items = (await idbAll('outbox')).slice(0, BATCH_SIZE);
        if (!items.length) break;
        const sets = items.filter((i) => i.kind === 'set').map((i) => i.data);
        const sessions = items.filter((i) => i.kind === 'session').map((i) => i.data);
        const res = await api('POST', {}, { sets, sessions });
        const okSets = new Set(res.set_ids || []);
        const okSessions = new Set(res.session_ids || []);
        const acked = items.filter((i) => (i.kind === 'set' ? okSets.has(i.data.set_id) : okSessions.has(i.data.session_id)));
        if (!acked.length) throw new Error('Server acknowledged nothing');
        await removeAcked(acked);
        await updatePending();
      }
      sync.failures = 0;
      sync.nextAt = 0;
      sync.lastError = null;
      sync.lastSyncAt = new Date().toISOString();
      await kvSet('sync', { lastSyncAt: sync.lastSyncAt });
    } catch (e) {
      sync.lastError = e.message || String(e);
      console.warn('sync failed', e);
      scheduleRetry();
    } finally {
      sync.running = false;
      await updatePending();
      if (sync.again) { sync.again = false; flush(); }
    }
  }

  /** Delete acknowledged outbox entries — unless they were rewritten while the request was in flight. */
  async function removeAcked(acked) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('outbox', 'readwrite');
      const os = t.objectStore('outbox');
      for (const it of acked) {
        const g = os.get(it.key);
        g.onsuccess = () => { if (g.result && g.result.rev === it.rev) os.delete(it.key); };
      }
      t.oncomplete = () => resolve();
      t.onerror = t.onabort = () => reject(t.error);
    });
  }

  let revCounter = 0;
  const nextRev = () => `${Date.now()}-${++revCounter}`;
  const outboxSession = (s) => ['outbox', 'put', { key: `session:${s.session_id}`, kind: 'session', rev: nextRev(), data: s }];

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------
  async function saveActive() {
    if (state.active) await kvSet('active', state.active);
  }

  async function startSession(day) {
    const now = new Date();
    const session = {
      session_id: uuid(), date: localDate(now), day, start_time: isoLocal(now), end_time: '',
      duration_min: '', bodyweight_lb: '', energy: '', session_notes: '',
    };
    state.active = {
      session_id: session.session_id, day, date: session.date, start_time: session.start_time,
      started_ms: now.getTime(),
      plan: planFor(day),     // snapshot so a Plan edit mid-workout can't shuffle cards
      ex: {},                 // per-exercise UI state: skipped, note, extra, drafts
      rest: null,
    };
    // The Sessions row is only uploaded on "Finish", so a discarded session leaves nothing behind.
    await idbWrite([
      ['sessions', 'put', session],
      ['kv', 'put', state.active, 'active'],
    ]);
    state.localSessions.push(session);
    go('workout');
  }

  const exState = (i) => (state.active.ex[i] ||= { skipped: false, note: '', extra: 0, drafts: {} });
  const sessionSets = () => state.localSets.filter((s) => s.session_id === state.active.session_id);
  const loggedFor = (exercise) => sessionSets().filter((s) => s.exercise === exercise).sort((a, b) => a.set_number - b.set_number);

  /** Prefill: target (low end of a range), or last time if that was more. Weight carries over from the previous set today. */
  function prefill(i, n) {
    const pe = state.active.plan[i];
    const tW = firstNum(pe.target_weight);
    const tR = firstNum(pe.target_reps);
    let w = tW, r = tR;
    const last = lastTime(pe.exercise, state.active.session_id);
    if (last) {
      const ls = last.sets.find((s) => s.set_number === n) || last.sets[last.sets.length - 1];
      const lw = Number(ls.weight_lb) || 0, lr = Number(ls.reps_or_amount) || 0;
      if (lw > tW || (lw === tW && lr > tR)) { w = lw; r = lr; }
    }
    const prev = loggedFor(pe.exercise).filter((s) => s.set_number < n).pop();
    if (prev && prev.weight_lb !== '') w = prev.weight_lb;
    return { w, r, rir: '', pain: 'none', note: '' };
  }
  function draft(i, n) {
    const ex = exState(i);
    return ex.drafts[n] || prefill(i, n);
  }
  function setDraft(i, n, patch) {
    const ex = exState(i);
    ex.drafts[n] = { ...draft(i, n), ...patch };
    saveActive();
    return ex.drafts[n];
  }

  const saving = new Set();
  async function logSet(i, n) {
    const key = `${i}:${n}`;
    if (saving.has(key)) return;
    saving.add(key);
    try {
      const a = state.active;
      const pe = a.plan[i];
      const d = draft(i, n);
      const rec = {
        set_id: uuid(),
        session_id: a.session_id,
        logged_at: isoLocal(),
        date: a.date,
        day: a.day,
        exercise: pe.exercise,
        set_number: n,
        weight_lb: numOrBlank(d.w),
        reps_or_amount: numOrBlank(d.r),
        unit: unitOf(pe.target_reps),
        rir: numOrBlank(d.rir),
        pain_flag: PAIN.includes(d.pain) ? d.pain : 'none',
        set_note: String(d.note || '').trim(),
      };
      delete exState(i).drafts[n];
      if (rec.pain_flag === 'sharp') exState(i).sharp = true;
      a.rest = { endsAt: Date.now() + (Number(pe.rest_sec) || 0) * 1000, alerted: false };
      await idbWrite([
        ['sets', 'put', rec],
        ['outbox', 'put', { key: `set:${rec.set_id}`, kind: 'set', rev: nextRev(), data: rec }],
        ['kv', 'put', a, 'active'],
      ]);
      state.localSets.push(rec);
      if (!(Number(pe.rest_sec) > 0)) a.rest = null;
      restAlert(a.rest && a.rest.endsAt);
      render();
      tickRest();
      await updatePending();
      if (navigator.onLine) flush();
    } finally {
      saving.delete(key);
    }
  }

  async function finishSession({ energy, bodyweight, notes }) {
    const a = state.active;
    const end = new Date();
    const extra = [];
    a.plan.forEach((pe, i) => {
      const ex = a.ex[i];
      if (!ex) return;
      if (ex.skipped) extra.push(`Skipped: ${pe.exercise}`);
      if (ex.note) extra.push(`${pe.exercise}: ${ex.note}`);
    });
    const session = {
      session_id: a.session_id, date: a.date, day: a.day, start_time: a.start_time, end_time: isoLocal(end),
      duration_min: Math.max(0, Math.round((end.getTime() - a.started_ms) / 60000)),
      bodyweight_lb: numOrBlank(bodyweight), energy: Number(energy),
      session_notes: [String(notes || '').trim(), ...extra].filter(Boolean).join(' | '),
    };
    const sets = sessionSets();
    await idbWrite([['sessions', 'put', session], outboxSession(session), ['kv', 'delete', 'active']]);
    state.localSessions = state.localSessions.filter((s) => s.session_id !== session.session_id).concat(session);
    state.active = null;
    state.summary = { session, sets, plan: a.plan };
    hideRest();
    restAlert(null);
    await updatePending();
    go('summary');
    if (navigator.onLine) flush();
  }

  async function discardSession() {
    const a = state.active;
    if (sessionSets().length) return alert('Sets are already logged, so finish the session instead.');
    await idbWrite([
      ['sessions', 'delete', a.session_id],
      ['outbox', 'delete', `session:${a.session_id}`],
      ['kv', 'delete', 'active'],
    ]);
    state.localSessions = state.localSessions.filter((s) => s.session_id !== a.session_id);
    state.active = null;
    hideRest();
    restAlert(null);
    await updatePending();
    go('home');
  }

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
      // A leftover subscription made with a different key makes subscribe() throw InvalidStateError.
      const old = await reg.pushManager.getSubscription();
      if (old) await old.unsubscribe();
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
        <button class="btn" data-act="test-alert">Send a test alert in 5 s</button>
        <button class="btn small" data-act="enable-alerts">Re-register</button>`;
    else body = `<p class="small muted">Get a notification when rest ends, so your watch buzzes.</p>
        <button class="btn primary" data-act="enable-alerts">Enable rest alerts</button>`;
    return `<div class="card stack"><h3>Rest alerts</h3>${body}</div>`;
  }

  // ---------------------------------------------------------------------------
  // Rest timer — derived from a timestamp so it survives lock/background/kill.
  // ---------------------------------------------------------------------------
  let audioCtx = null;
  function unlockAudio() {
    try {
      if (audioCtx && audioCtx.state === 'running') return;
      // 'ambient' mixes with Music/Audible; 'playback' would interrupt them.
      if (navigator.audioSession) navigator.audioSession.type = 'ambient';
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const b = audioCtx.createBuffer(1, 1, 22050);
      const s = audioCtx.createBufferSource();
      s.buffer = b; s.connect(audioCtx.destination); s.start(0);
    } catch { /* no audio, flash still works */ }
  }
  function beep() {
    try {
      if (!audioCtx) return;
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t0 = audioCtx.currentTime + 0.02;
      [0, 0.25, 0.5].forEach((dt, k) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = k === 2 ? 1320 : 880;
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.exponentialRampToValueAtTime(0.6, t0 + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.18);
        o.connect(g).connect(audioCtx.destination);
        o.start(t0 + dt);
        o.stop(t0 + dt + 0.2);
      });
    } catch { /* ignore */ }
  }
  function flash() {
    const f = $('#flash');
    f.classList.remove('on');
    void f.offsetWidth; // restart animation
    f.classList.add('on');
  }
  function hideRest() {
    $('#rest-bar').hidden = true;
    document.body.classList.remove('resting');
  }
  function tickRest() {
    const a = state.active;
    if (!a || !a.rest || state.view !== 'workout') return hideRest();
    const remaining = Math.ceil((a.rest.endsAt - Date.now()) / 1000);
    const bar = $('#rest-bar');
    bar.hidden = false;
    document.body.classList.add('resting');
    if (remaining > 0) {
      bar.classList.remove('done');
      $('#rest-time').textContent = fmtRest(remaining);
      return;
    }
    bar.classList.add('done');
    $('#rest-time').textContent = 'Go!';
    if (!a.rest.alerted) {
      a.rest.alerted = true;
      saveActive();
      if (-remaining < 120) { beep(); flash(); } // don't blast a stale alarm when coming back much later
    }
    if (-remaining > 90) { a.rest = null; saveActive(); hideRest(); }
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------
  const main = () => $('#view');

  function go(view) {
    state.view = view;
    main().scrollTop = 0;
    render();
  }

  function render() {
    const v = state.view;
    const scroll = main().scrollTop;
    document.body.classList.toggle('in-workout', v === 'workout');
    $('#btn-back').hidden = !(v === 'workout' || v === 'summary');
    document.querySelectorAll('#tabbar button').forEach((b) => {
      b.classList.toggle('active', b.dataset.nav === v || (b.dataset.nav === 'home' && (v === 'workout' || v === 'summary')));
    });
    const views = { setup: viewSetup, home: viewHome, workout: viewWorkout, summary: viewSummary, history: viewHistory, settings: viewSettings };
    (views[v] || viewHome)();
    if (v === 'workout') main().scrollTop = scroll;
    tickRest();
    renderSync();
  }

  function setTitle(t) { $('#title').textContent = t; }

  // ----- Setup -----
  function viewSetup() {
    setTitle('Set up');
    const c = state.config || {};
    main().innerHTML = `
      <div class="card stack">
        <h2>Connect your Google Sheet</h2>
        <p class="muted small">Paste the Apps Script <b>web app URL</b> (ends in <code>/exec</code>) and the token that <code>setup()</code> printed. You only do this once; both are stored on this phone.</p>
        <div><label class="lbl" for="cfg-url">Backend URL</label>
          <input id="cfg-url" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(c.url)}"></div>
        <div><label class="lbl" for="cfg-token">Token</label>
          <input id="cfg-token" type="text" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="long random token" value="${esc(c.token)}"></div>
        <div id="cfg-msg" class="small muted"></div>
        <button class="btn primary" data-act="save-config">Save &amp; connect</button>
      </div>`;
  }

  async function saveConfig() {
    const url = $('#cfg-url').value.trim();
    const token = $('#cfg-token').value.trim();
    const msg = $('#cfg-msg');
    if (!/^https?:\/\//.test(url) || !token) { msg.textContent = 'Both the URL and the token are required.'; return; }
    const prev = state.config;
    state.config = { url, token };
    if (navigator.onLine) {
      msg.textContent = 'Testing connection…';
      try {
        await api('GET', { action: 'ping' });
      } catch (e) {
        if (!confirm(`Couldn't reach the backend (${e.message}). Save anyway?`)) { state.config = prev; msg.textContent = e.message; return; }
      }
    }
    await kvSet('config', state.config);
    sync.failures = 0; sync.nextAt = 0; sync.lastError = null;
    go(state.view === 'setup' ? 'home' : state.view);
    toast('Saved', 1500);
    flush({ force: true });
    backgroundRefresh();
  }

  // ----- Home -----
  function viewHome() {
    setTitle('Workout');
    const a = state.active;
    let html = '';
    if (a) {
      const n = sessionSets().length;
      html += `<button class="day-btn resume" data-act="resume">
        <div><span class="big">Resume</span><span class="focus">Day ${esc(a.day)}</span></div>
        <div class="last">Started ${new Date(a.started_ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${n} set${n === 1 ? '' : 's'} logged</div>
      </button>`;
    }
    for (const day of Object.keys(DAYS)) {
      const ld = lastDone(day);
      html += `<button class="day-btn" data-act="start" data-day="${day}">
        <div><span class="big">Day ${day}</span><span class="focus">${DAYS[day]}</span></div>
        <div class="last">${ld ? `Last done ${fmtDate(ld)} · ${daysAgo(ld)}` : 'Not done yet'}</div>
      </button>`;
    }
    if (!state.plan) html += `<p class="small muted center">Using the built-in plan until the sheet's Plan tab is downloaded.</p>`;
    main().innerHTML = html;
  }

  // ----- Workout -----
  function targetText(pe) {
    const w = String(pe.target_weight || '').trim();
    return `${pe.sets} × ${esc(pe.target_reps)}${w ? ` @ ${esc(w)}` : ''} · rest ${fmtRest(Number(pe.rest_sec) || 0)}`;
  }
  function setText(s) {
    const u = s.unit === 'reps' ? '' : ` ${s.unit}`;
    const w = Number(s.weight_lb) ? `${fmtNum(s.weight_lb)}×` : 'BW×';
    return `${w}${fmtNum(s.reps_or_amount)}${u}`;
  }

  function viewWorkout() {
    const a = state.active;
    if (!a) return go('home');
    setTitle(`Day ${a.day} · ${DAYS[a.day] || ''}`);
    let html = '';
    a.plan.forEach((pe, i) => {
      const ex = exState(i);
      const logged = loggedFor(pe.exercise);
      const unit = unitOf(pe.target_reps);
      const total = Math.max(Number(pe.sets) + ex.extra, logged.length ? logged[logged.length - 1].set_number : 0);
      const last = lastTime(pe.exercise, a.session_id);
      const sharp = ex.sharp || logged.some((s) => s.pain_flag === 'sharp') || Object.values(ex.drafts).some((d) => d.pain === 'sharp');
      html += `<section class="card ex${ex.skipped ? ' skipped' : ''}" data-ex="${i}">
        <div class="ex-head"><h3>${esc(pe.exercise)}</h3><span class="muted small">${logged.length}/${total}</span></div>
        <div class="ex-target">${targetText(pe)}</div>
        ${pe.notes ? `<div class="ex-notes">${esc(pe.notes)}</div>` : ''}
        <div class="ex-last">${last ? `Last time (${fmtDate(last.date)}): <b>${last.sets.map(setText).join(', ')}</b>` : 'Last time: —'}</div>
        ${sharp ? '<div class="banner-sharp">⚠️ Stop this lift for today.</div>' : ''}`;
      if (!ex.skipped) {
        for (let n = 1; n <= total; n++) {
          const done = logged.find((s) => s.set_number === n);
          html += done ? doneRow(done) : editRow(i, n, unit);
        }
      }
      html += `<div class="ex-actions">
          <button class="btn" data-act="add-set" data-ex="${i}">＋ Set</button>
          <button class="btn" data-act="note" data-ex="${i}">✎ Note</button>
          <button class="btn" data-act="skip" data-ex="${i}">${ex.skipped ? 'Unskip' : 'Skip'}</button>
        </div>
        ${ex.note ? `<div class="ex-note-view">“${esc(ex.note)}”</div>` : ''}
      </section>`;
    });
    html += `<button class="btn good" data-act="finish">Finish session</button>
      <div class="spacer"></div>
      ${sessionSets().length ? '' : '<button class="btn danger" data-act="discard">Discard session</button>'}
      <div class="spacer"></div>`;
    main().innerHTML = html;
  }

  function doneRow(s) {
    const extras = [];
    if (s.rir !== '') extras.push(`RIR ${s.rir}`);
    if (s.pain_flag && s.pain_flag !== 'none') extras.push(`pain: ${s.pain_flag}`);
    if (s.set_note) extras.push(esc(s.set_note));
    const amount = `${fmtNum(s.reps_or_amount)} ${s.unit}`;
    return `<div class="set done"><div class="set-main">
      <div class="set-no">${s.set_number}</div>
      <div class="set-summary">${Number(s.weight_lb) ? `${fmtNum(s.weight_lb)} lb × ` : ''}${amount}
        ${extras.length ? `<div class="muted">${extras.join(' · ')}</div>` : ''}</div>
      <div class="check" aria-label="Logged" style="display:flex;align-items:center;justify-content:center">✓</div>
    </div></div>`;
  }

  function editRow(i, n, unit) {
    const d = draft(i, n);
    const rStep = unit === 'reps' ? 1 : 5;
    const open = d.open;
    let extra = '';
    if (open) {
      extra = `<div class="set-extra">
        <div class="chips"><span class="lbl">RIR</span>${[0, 1, 2, 3, 4].map((v) =>
          `<button class="chip${d.rir === v ? ' on' : ''}" data-act="rir" data-ex="${i}" data-set="${n}" data-v="${v}">${v}</button>`).join('')}</div>
        <div class="chips"><span class="lbl">Pain</span>${PAIN.map((p) =>
          `<button class="chip pain-${p}${(d.pain || 'none') === p ? ' on' : ''}" data-act="pain" data-ex="${i}" data-set="${n}" data-v="${p}">${p}</button>`).join('')}</div>
        <input type="text" placeholder="Set note (optional)" data-field="note" data-ex="${i}" data-set="${n}" value="${esc(d.note)}">
      </div>`;
    }
    return `<div class="set" data-ex="${i}" data-set="${n}">
      <div class="set-main">
        <div class="set-no">${n}</div>
        <div class="field">
          <div class="stepper">
            <button data-act="step" data-ex="${i}" data-set="${n}" data-field="w" data-delta="-5" aria-label="Weight minus 5">−</button>
            <input type="text" inputmode="decimal" data-field="w" data-ex="${i}" data-set="${n}" value="${esc(fmtNum(d.w) === '–' ? '' : fmtNum(d.w))}" aria-label="Weight lb">
            <button data-act="step" data-ex="${i}" data-set="${n}" data-field="w" data-delta="5" aria-label="Weight plus 5">+</button>
          </div>
          <div class="field-label">lb</div>
        </div>
        <div class="field">
          <div class="stepper">
            <button data-act="step" data-ex="${i}" data-set="${n}" data-field="r" data-delta="-${rStep}" aria-label="Minus">−</button>
            <input type="text" inputmode="numeric" pattern="[0-9]*" data-field="r" data-ex="${i}" data-set="${n}" value="${esc(fmtNum(d.r) === '–' ? '' : fmtNum(d.r))}" aria-label="${unit}">
            <button data-act="step" data-ex="${i}" data-set="${n}" data-field="r" data-delta="${rStep}" aria-label="Plus">+</button>
          </div>
          <div class="field-label">${unit}</div>
        </div>
        <button class="check" data-act="log" data-ex="${i}" data-set="${n}" aria-label="Save set ${n}">✓</button>
      </div>
      <div class="row" style="margin-top:4px"><button class="chip" data-act="more" data-ex="${i}" data-set="${n}" style="flex:none">${open ? 'Hide RIR / pain / note' : 'RIR · pain · note'}${d.rir !== '' ? ` · RIR ${d.rir}` : ''}${d.pain && d.pain !== 'none' ? ` · ${d.pain}` : ''}</button></div>
      ${extra}
    </div>`;
  }

  // ----- Finish modal & summary -----
  function openFinish() {
    const m = $('#modal');
    let energy = null;
    m.innerHTML = `<div class="sheet">
      <h2>Finish session</h2>
      <label class="lbl">Energy (1 = drained, 5 = great)</label>
      <div class="energy">${[1, 2, 3, 4, 5].map((v) => `<button class="chip" data-energy="${v}">${v}</button>`).join('')}</div>
      <label class="lbl" for="fin-bw">Bodyweight (lb, optional)</label>
      <input id="fin-bw" type="text" inputmode="decimal" placeholder="e.g. 182.4">
      <label class="lbl" for="fin-notes">Notes (optional)</label>
      <textarea id="fin-notes" placeholder="How did it go?"></textarea>
      <div class="spacer"></div>
      <button class="btn good" id="fin-save" disabled>Save &amp; finish</button>
      <div class="spacer"></div>
      <button class="btn" id="fin-cancel">Keep training</button>
    </div>`;
    m.hidden = false;
    m.onclick = async (e) => {
      const eb = e.target.closest('[data-energy]');
      if (eb) {
        energy = Number(eb.dataset.energy);
        m.querySelectorAll('[data-energy]').forEach((b) => b.classList.toggle('on', b === eb));
        $('#fin-save').disabled = false;
      } else if (e.target.id === 'fin-cancel' || e.target === m) {
        m.hidden = true;
      } else if (e.target.id === 'fin-save' && energy) {
        e.target.disabled = true;
        const bodyweight = $('#fin-bw').value.replace(',', '.').trim();
        const notes = $('#fin-notes').value;
        m.hidden = true;
        await finishSession({ energy, bodyweight, notes });
      }
    };
  }

  function topSet(sets) {
    return sets.reduce((best, s) => {
      const w = Number(s.weight_lb) || 0, r = Number(s.reps_or_amount) || 0;
      if (!best || w > best.w || (w === best.w && r > best.r)) return { w, r, s };
      return best;
    }, null);
  }

  function viewSummary() {
    const sm = state.summary;
    if (!sm) return go('home');
    const { session: s, sets, plan } = sm;
    setTitle('Session summary');
    const volume = sets.filter((x) => x.unit === 'reps').reduce((t, x) => t + (Number(x.weight_lb) || 0) * (Number(x.reps_or_amount) || 0), 0);
    const pains = sets.filter((x) => x.pain_flag && x.pain_flag !== 'none');
    const exercises = [...new Set([...plan.map((p) => p.exercise), ...sets.map((x) => x.exercise)])];
    main().innerHTML = `
      <div class="card">
        <h2>Day ${esc(s.day)} done 💪</h2>
        <div class="summary-stat"><span>Date</span><b>${fmtDate(s.date)}</b></div>
        <div class="summary-stat"><span>Duration</span><b>${s.duration_min} min</b></div>
        <div class="summary-stat"><span>Sets logged</span><b>${sets.length}</b></div>
        <div class="summary-stat"><span>Volume (weight × reps)</span><b>${Math.round(volume).toLocaleString()} lb</b></div>
        <div class="summary-stat"><span>Energy</span><b>${s.energy}/5</b></div>
        ${s.bodyweight_lb !== '' ? `<div class="summary-stat"><span>Bodyweight</span><b>${fmtNum(s.bodyweight_lb)} lb</b></div>` : ''}
        ${pains.length ? `<div class="summary-stat"><span>Pain flags</span><b style="color:var(--warn)">${pains.map((p) => `${esc(p.exercise)} (${p.pain_flag})`).join(', ')}</b></div>` : ''}
      </div>
      <div class="card"><h3>Top sets</h3>
        ${exercises.map((ex) => {
          const list = sets.filter((x) => x.exercise === ex);
          const t = topSet(list);
          return `<div class="kv"><span>${esc(ex)}</span><span>${t ? `${setText(t.s)} · ${list.length} sets` : 'skipped'}</span></div>`;
        }).join('')}
      </div>
      ${s.session_notes ? `<div class="card small muted">${esc(s.session_notes)}</div>` : ''}
      <button class="btn primary" data-act="home">Done</button>`;
  }

  // ----- History -----
  function viewHistory() {
    setTitle('History');
    const sets = allSets();
    const sessions = allSessions()
      .filter((s) => !state.active || s.session_id !== state.active.session_id)
      .sort((a, b) => String(b.start_time || b.date).localeCompare(String(a.start_time || a.date)))
      .slice(0, 10);
    const exercises = [...new Set([...planRows().map((p) => p.exercise), ...sets.map((s) => s.exercise)])];
    if (!state.chartExercise || !exercises.includes(state.chartExercise)) {
      state.chartExercise = exercises.find((e) => sets.some((s) => s.exercise === e)) || exercises[0];
    }
    let html = `<div class="card">
      <h3>Top set over time</h3>
      <div class="spacer" style="height:8px"></div>
      <select id="chart-ex">${exercises.map((e) => `<option${e === state.chartExercise ? ' selected' : ''}>${esc(e)}</option>`).join('')}</select>
      <div class="spacer" style="height:8px"></div>
      ${chartSvg(sets.filter((s) => s.exercise === state.chartExercise))}
    </div>
    <h2>Last ${sessions.length} sessions</h2>`;
    if (!sessions.length) html += '<p class="muted">Nothing logged yet.</p>';
    for (const s of sessions) {
      const ss = sets.filter((x) => x.session_id === s.session_id).sort((a, b) => a.set_number - b.set_number);
      const byEx = new Map();
      ss.sort(sortSets).forEach((x) => { if (!byEx.has(x.exercise)) byEx.set(x.exercise, []); byEx.get(x.exercise).push(x); });
      html += `<details class="card hist-item">
        <summary><b>Day ${esc(s.day)}</b><span class="muted">${fmtDate(s.date)}</span>
          <span class="muted small" style="margin-left:auto">${s.duration_min !== '' && s.duration_min != null ? `${s.duration_min} min · ` : ''}${ss.length} sets${s.energy ? ` · E${s.energy}` : ''}</span></summary>
        <div class="hist-sets">
          ${[...byEx].map(([ex, list]) => `<div><b>${esc(ex)}</b>: <span class="muted">${list.sort((a, b) => a.set_number - b.set_number).map(setText).join(', ')}</span></div>`).join('') || '<div class="muted">No sets on this device or in recent history.</div>'}
          ${s.session_notes ? `<div class="muted small">${esc(s.session_notes)}</div>` : ''}
        </div>
      </details>`;
    }
    main().innerHTML = html;
  }

  /** Plain SVG line chart of the top set (heaviest weight, then most reps) per session. */
  function chartSvg(sets) {
    const bySession = new Map();
    for (const s of sets) {
      if (!bySession.has(s.session_id)) bySession.set(s.session_id, []);
      bySession.get(s.session_id).push(s);
    }
    const pts = [...bySession.values()].map((list) => {
      const t = topSet(list);
      return { date: list[0].date, w: t.w, r: t.r, s: t.s };
    }).sort((a, b) => a.date.localeCompare(b.date)).slice(-20);
    if (!pts.length) return '<p class="muted small">No sets logged for this exercise yet.</p>';
    const useReps = pts.every((p) => !p.w); // bodyweight lifts: chart reps/seconds instead
    const val = (p) => (useReps ? p.r : p.w);
    const W = 340, H = 210, L = 38, R = 14, T = 22, B = 30;
    let lo = Math.min(...pts.map(val)), hi = Math.max(...pts.map(val));
    if (lo === hi) { lo -= 5; hi += 5; }
    const padv = (hi - lo) * 0.12; lo = Math.max(0, lo - padv); hi += padv;
    const x = (i) => (pts.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1));
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const ticks = [lo, (lo + hi) / 2, hi];
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(val(p)).toFixed(1)}`).join(' ');
    const labelEvery = Math.ceil(pts.length / 6);
    const unit = useReps ? (pts[0].s.unit || 'reps') : 'lb';
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Top set chart">
      ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v)}</text>`).join('')}
      <text x="${L - 6}" y="12" text-anchor="end">${unit}</text>
      <path class="line" d="${path}"/>
      ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(val(p))}" r="4"/>
        ${i % labelEvery === 0 || i === pts.length - 1 ? `<text class="pt-label" x="${x(i)}" y="${y(val(p)) - 9}" text-anchor="middle">${esc(setText(p.s))}</text>
        <text x="${x(i)}" y="${H - 10}" text-anchor="middle">${esc(p.date.slice(5))}</text>` : ''}`).join('')}
    </svg>`;
  }

  // ----- Settings -----
  function syncDetails() {
    const rows = [
      ['Pending uploads', state.pending],
      ['Network', navigator.onLine ? 'online' : 'offline'],
      ['Last successful sync', sync.lastSyncAt ? new Date(sync.lastSyncAt).toLocaleString() : 'never'],
      ['Last error', sync.lastError || '—'],
      ['Next retry', sync.nextAt > Date.now() ? `in ${Math.ceil((sync.nextAt - Date.now()) / 1000)} s` : '—'],
    ];
    return rows.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${esc(v)}</span></div>`).join('');
  }

  async function viewSettings() {
    setTitle('Settings');
    const c = state.config || {};
    main().innerHTML = `
      <div class="card stack">
        <h3>Sync</h3>
        <div id="settings-sync">${syncDetails()}</div>
        <button class="btn primary" data-act="force-sync">Force sync</button>
        <button class="btn" data-act="refresh">Re-download plan &amp; history</button>
      </div>
      ${alertsCard()}
      <div class="card stack">
        <h3>Backup</h3>
        <p class="small muted">Everything on this phone: sets, sessions, unsynced queue, plan.</p>
        <button class="btn" data-act="export">Export all data (JSON)</button>
      </div>
      <div class="card stack">
        <h3>Backend</h3>
        <div><label class="lbl" for="cfg-url">Backend URL</label>
          <input id="cfg-url" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(c.url)}"></div>
        <div><label class="lbl" for="cfg-token">Token</label>
          <input id="cfg-token" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(c.token)}"></div>
        <div id="cfg-msg" class="small muted"></div>
        <button class="btn" data-act="save-config">Save backend</button>
      </div>
      <div class="card">
        <h3>App</h3>
        <div id="app-info" class="small"></div>
        <div class="spacer"></div>
        <button class="btn" data-act="check-update">Check for update</button>
      </div>`;
    const keys = 'caches' in window ? (await caches.keys()).filter((k) => k.startsWith('wl-shell-')) : [];
    const info = [
      ['Version', keys.join(', ') || 'not cached yet'],
      ['Plan', state.plan ? `from sheet, ${new Date(state.plan.fetched_at).toLocaleString()}` : 'built-in'],
      ['Sets on this device', state.localSets.length],
      ['Persistent storage', state.persisted == null ? 'unknown' : state.persisted ? 'granted' : 'not granted'],
      ['Installed (standalone)', window.navigator.standalone || matchMedia('(display-mode: standalone)').matches ? 'yes' : 'no'],
    ];
    const el = $('#app-info');
    if (el) el.innerHTML = info.map(([k, v]) => `<div class="kv"><span>${k}</span><span>${esc(v)}</span></div>`).join('');
  }

  async function exportData() {
    const [sets, sessions, outbox, plan, history, active] = await Promise.all([
      idbAll('sets'), idbAll('sessions'), idbAll('outbox'), idbGet('kv', 'plan'), idbGet('kv', 'history'), idbGet('kv', 'active'),
    ]);
    const data = {
      exported_at: isoLocal(), app: 'workout-logger', backend_url: state.config && state.config.url,
      sets: sets.sort(sortSets), sessions, unsynced_outbox: outbox, active_session: active || null,
      plan: plan || { rows: SEED_PLAN, fetched_at: null }, server_history_cache: history || null,
    };
    const name = `workout-log-${localDate()}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const file = new File([blob], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  let toastTimer;
  function toast(text, ms, onTap) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    t.onclick = onTap || (() => { t.hidden = true; });
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function bindEvents() {
    document.addEventListener('touchend', unlockAudio, { passive: true });
    document.addEventListener('click', unlockAudio);

    $('#tabbar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-nav]');
      if (!b) return;
      if (!state.config && b.dataset.nav !== 'settings') return go('setup');
      go(b.dataset.nav === 'home' && state.view === 'summary' ? 'home' : b.dataset.nav);
    });
    $('#btn-back').addEventListener('click', () => go('home'));
    $('#sync-indicator').addEventListener('click', () => { flush({ force: true }); toast(navigator.onLine ? 'Syncing…' : 'Offline — sets are saved on this phone', 1800); });
    $('#rest-plus').addEventListener('click', () => {
      if (!state.active || !state.active.rest) return;
      const r = state.active.rest;
      r.endsAt = Math.max(r.endsAt, Date.now()) + 30000;
      r.alerted = false;
      saveActive(); tickRest(); restAlert(r.endsAt);
    });
    $('#rest-skip').addEventListener('click', () => { if (state.active) { state.active.rest = null; saveActive(); } hideRest(); restAlert(null); });

    main().addEventListener('click', onMainClick);
    main().addEventListener('input', onMainInput);
    main().addEventListener('change', (e) => {
      if (e.target.id === 'chart-ex') { state.chartExercise = e.target.value; render(); }
    });
    // Select-all on focus so a sweaty thumb can just type the new number.
    main().addEventListener('focusin', (e) => {
      if (e.target.matches('.stepper input')) setTimeout(() => e.target.select(), 0);
    });

    window.addEventListener('online', () => { renderSync(); flush({ force: true }); backgroundRefresh(); });
    window.addEventListener('offline', renderSync);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      tickRest();
      renderSync();
      flush({ force: true });
      if (state.reg) state.reg.update().catch(() => {});
    });
    // Block pinch-zoom gestures on iOS (user-scalable=no is ignored by Safari).
    document.addEventListener('gesturestart', (e) => e.preventDefault());
  }

  async function onMainClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const i = Number(b.dataset.ex);
    const n = Number(b.dataset.set);
    switch (act) {
      case 'save-config': return saveConfig();
      case 'resume': return go('workout');
      case 'start': {
        const day = b.dataset.day;
        if (state.active) {
          if (state.active.day === day || confirm(`Day ${state.active.day} is in progress. Resume it?`)) go('workout');
          return;
        }
        return startSession(day);
      }
      case 'home': state.summary = null; return go('home');
      case 'step': {
        const d = draft(i, n);
        const f = b.dataset.field;
        const cur = Number(d[f]) || 0;
        const next = Math.max(0, Math.round((cur + Number(b.dataset.delta)) * 100) / 100);
        setDraft(i, n, { [f]: next });
        const inp = main().querySelector(`input[data-field="${f}"][data-ex="${i}"][data-set="${n}"]`);
        if (inp) inp.value = fmtNum(next);
        return;
      }
      case 'log': return logSet(i, n);
      case 'more': setDraft(i, n, { open: !draft(i, n).open }); return render();
      case 'rir': { const v = Number(b.dataset.v); setDraft(i, n, { rir: draft(i, n).rir === v ? '' : v }); return render(); }
      case 'pain': setDraft(i, n, { pain: b.dataset.v }); return render();
      case 'add-set': exState(i).extra++; await saveActive(); return render();
      case 'skip': exState(i).skipped = !exState(i).skipped; await saveActive(); return render();
      case 'note': {
        const ex = exState(i);
        const v = prompt(`Note for ${state.active.plan[i].exercise}`, ex.note || '');
        if (v !== null) { ex.note = v.trim(); await saveActive(); render(); }
        return;
      }
      case 'finish': return openFinish();
      case 'discard': if (confirm('Discard this session?')) await discardSession(); return;
      case 'force-sync': sync.nextAt = 0; await flush({ force: true }); toast(state.pending ? `${state.pending} still pending${sync.lastError ? ` (${sync.lastError})` : ''}` : '✓ All synced', 2500); return;
      case 'refresh':
        try { await Promise.all([refreshPlan(), refreshHistory()]); toast('Plan & history updated', 2000); render(); } catch (err) { toast(`Failed: ${err.message}`, 3000); }
        return;
      case 'enable-alerts': return enableAlerts();
      case 'test-alert': restAlert(Date.now() + 5000); toast('Test alert in 5 s. Lock your phone now.', 3000); return;
      case 'export': return exportData();
      case 'check-update':
        if (!state.reg) return toast('Service worker not active', 2000);
        try { await state.reg.update(); } catch { /* offline */ }
        if (!state.reg.waiting && !state.reg.installing) toast('You have the latest version', 2000);
        return;
      default:
    }
  }

  function onMainInput(e) {
    const t = e.target;
    if (!state.active || !t.dataset.field || t.dataset.ex === undefined) return;
    const i = Number(t.dataset.ex), n = Number(t.dataset.set), f = t.dataset.field;
    if (f === 'note') setDraft(i, n, { note: t.value });
    else {
      const v = t.value.replace(',', '.').trim();
      setDraft(i, n, { [f]: v === '' || isNaN(Number(v)) ? '' : Number(v) });
    }
  }

  // ---------------------------------------------------------------------------
  // Service worker & updates
  // ---------------------------------------------------------------------------
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    let userAskedReload = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (userAskedReload) location.reload();
    });
    const offer = (worker) => toast('Update available — tap to reload', 0, () => {
      userAskedReload = true;
      $('#toast').hidden = true;
      worker.postMessage({ type: 'SKIP_WAITING' });
    });
    navigator.serviceWorker.register('sw.js').then((reg) => {
      state.reg = reg;
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
    }).catch((e) => console.warn('SW registration failed', e));
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function init() {
    await loadLocal();
    bindEvents();
    registerSW();
    refreshPush();
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then((p) => { state.persisted = p; }).catch(() => {});
    }
    go(state.config ? (state.active ? 'workout' : 'home') : 'setup');
    setInterval(tickRest, 250);
    flush({ force: true });
    backgroundRefresh();
  }

  window.__wl = { state, sync, flush }; // handy for debugging in Safari's Web Inspector
  init().catch((e) => {
    console.error(e);
    main().innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p></div>`;
  });
})();
