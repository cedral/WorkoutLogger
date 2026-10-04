/** @OnlyCurrentDoc */
/**
 * Workout Logger backend — Google Apps Script web app bound to the
 * "Joseph Workout Log" spreadsheet.
 *
 *   GET  ?action=ping&token=…                → { ok: true }
 *   GET  ?action=plan&token=…                → { ok, plan: [ {day, order, exercise, …} ] }
 *   GET  ?action=history&token=…&limit=500   → { ok, sets: [ …last N Log rows ], sessions: [ … ] }
 *   POST (Content-Type: text/plain, body = JSON string)
 *        { token, sets: [ {set_id, …} ], sessions: [ {session_id, …} ] }
 *        → { ok, set_ids, session_ids, sets_inserted, sets_skipped, sessions_inserted, sessions_updated }
 *
 * Idempotency: Log rows are keyed by set_id and never inserted twice.
 * Sessions rows are keyed by session_id and upserted (latest write wins).
 *
 * Run setup() once from the editor to create the tabs, seed the Plan and
 * generate the shared token (stored in Script Properties as TOKEN).
 */

var BOOK_NAME = 'Joseph Workout Log';

var COLUMNS = {
  Plan: ['day', 'order', 'exercise', 'sets', 'target_reps', 'target_weight', 'rest_sec', 'notes'],
  Log: ['set_id', 'session_id', 'logged_at', 'date', 'day', 'exercise', 'set_number',
        'weight_lb', 'reps_or_amount', 'unit', 'rir', 'pain_flag', 'set_note'],
  Sessions: ['session_id', 'date', 'day', 'start_time', 'end_time', 'duration_min',
             'bodyweight_lb', 'energy', 'session_notes'],
};

// Columns stored as plain text ("@") so Sheets never turns "8" or "2026-10-04" into something else.
var TEXT_COLUMNS = {
  Plan: ['day', 'exercise', 'target_reps', 'target_weight', 'notes'],
  Log: ['set_id', 'session_id', 'logged_at', 'date', 'day', 'exercise', 'unit', 'pain_flag', 'set_note'],
  Sessions: ['session_id', 'date', 'day', 'start_time', 'end_time', 'session_notes'],
};

var UNITS = ['reps', 'sec', 'yd'];
var PAIN = ['none', 'muscle', 'joint', 'sharp'];

var SEED_PLAN = [
  // day, order, exercise, sets, target_reps, target_weight, rest_sec, notes
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
];

// ---------------------------------------------------------------------------
// One-time setup (run from the Apps Script editor)
// ---------------------------------------------------------------------------

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getName() !== BOOK_NAME) ss.rename(BOOK_NAME);

  Object.keys(COLUMNS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = COLUMNS[name];
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, cols.length).setValues([cols]);
    } else {
      var header = sh.getRange(1, 1, 1, cols.length).getValues()[0].map(String);
      if (header.join('|') !== cols.join('|')) {
        throw new Error('Tab "' + name + '" has unexpected headers: ' + header.join(', '));
      }
    }
    sh.getRange(1, 1, 1, cols.length).setFontWeight('bold');
    sh.setFrozenRows(1);
    TEXT_COLUMNS[name].forEach(function (col) {
      sh.getRange(1, cols.indexOf(col) + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    });
  });

  var plan = ss.getSheetByName('Plan');
  if (plan.getLastRow() < 2) appendRows_(plan, 'Plan', SEED_PLAN);

  // Remove the default empty tab a new spreadsheet comes with.
  ['Sheet1', 'Feuille 1', 'Hoja 1'].forEach(function (n) {
    var s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) props.setProperty('TOKEN', newToken_());
  Logger.log('Setup complete. Your app token is:\n%s', props.getProperty('TOKEN'));
  return props.getProperty('TOKEN');
}

/** Replace the token (the phone then needs the new one in Settings). */
function rotateToken() {
  var t = newToken_();
  PropertiesService.getScriptProperties().setProperty('TOKEN', t);
  Logger.log('New token:\n%s', t);
  return t;
}

function newToken_() {
  return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!checkToken_(p.token)) return json_({ ok: false, error: 'unauthorized' });
  try {
    switch (p.action) {
      case 'ping':
        return json_({ ok: true, server_time: new Date().toISOString() });
      case 'plan':
        return json_({ ok: true, plan: readPlan_() });
      case 'history': {
        var limit = Math.max(1, Math.min(5000, parseInt(p.limit, 10) || 500));
        return json_({ ok: true, sets: readTail_('Log', limit), sessions: readTail_('Sessions', 200) });
      }
      default:
        return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }
  if (!checkToken_(body.token)) return json_({ ok: false, error: 'unauthorized' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var res = {
      ok: true, set_ids: [], session_ids: [],
      sets_inserted: 0, sets_skipped: 0, sessions_inserted: 0, sessions_updated: 0,
    };

    // --- Log: insert-if-absent by set_id --------------------------------------
    var log = ss.getSheetByName('Log');
    var seen = {};
    columnValues_(log, 1).forEach(function (id) { seen[id] = true; });
    var newRows = [];
    (body.sets || []).forEach(function (s) {
      var id = String((s && s.set_id) || '').trim();
      if (!id) return;
      res.set_ids.push(id);
      if (seen[id]) { res.sets_skipped++; return; }
      seen[id] = true;
      newRows.push(setRow_(s, id));
    });
    if (newRows.length) appendRows_(log, 'Log', newRows);
    res.sets_inserted = newRows.length;

    // --- Sessions: upsert by session_id --------------------------------------
    var sess = ss.getSheetByName('Sessions');
    var rowOf = {};
    columnValues_(sess, 1).forEach(function (id, i) { rowOf[id] = i + 2; });
    var appendSess = [];
    (body.sessions || []).forEach(function (s) {
      var id = String((s && s.session_id) || '').trim();
      if (!id) return;
      res.session_ids.push(id);
      var row = sessionRow_(s, id);
      if (rowOf[id]) {
        var r = sess.getRange(rowOf[id], 1, 1, row.length);
        r.setNumberFormats([formats_('Sessions')]);
        r.setValues([row]);
        res.sessions_updated++;
      } else {
        rowOf[id] = -1; // de-dupe within the same batch
        appendSess.push(row);
      }
    });
    if (appendSess.length) appendRows_(sess, 'Sessions', appendSess);
    res.sessions_inserted = appendSess.length;

    SpreadsheetApp.flush();
    return json_(res);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Row builders (server-side validation of everything the phone sends)
// ---------------------------------------------------------------------------

function setRow_(s, id) {
  var unit = UNITS.indexOf(s.unit) >= 0 ? s.unit : 'reps';
  var pain = PAIN.indexOf(s.pain_flag) >= 0 ? s.pain_flag : 'none';
  var rir = num_(s.rir);
  if (rir !== '') rir = Math.max(0, Math.min(4, Math.round(rir)));
  return [
    id,
    text_(s.session_id),
    text_(s.logged_at),
    text_(s.date),
    text_(s.day),
    text_(s.exercise),
    num_(s.set_number),
    num_(s.weight_lb),
    num_(s.reps_or_amount),
    unit,
    rir,
    pain,
    text_(s.set_note),
  ];
}

function sessionRow_(s, id) {
  var energy = num_(s.energy);
  if (energy !== '') energy = Math.max(1, Math.min(5, Math.round(energy)));
  return [
    id,
    text_(s.date),
    text_(s.day),
    text_(s.start_time),
    text_(s.end_time),
    num_(s.duration_min),
    num_(s.bodyweight_lb),
    energy,
    text_(s.session_notes),
  ];
}

function text_(v) {
  if (v === null || v === undefined) return '';
  var s = String(v).slice(0, 2000);
  return /^[=]/.test(s) ? "'" + s : s; // never let a note become a formula
}

function num_(v) {
  if (v === null || v === undefined || v === '') return '';
  var n = Number(v);
  return isFinite(n) ? n : '';
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function formats_(tab) {
  return COLUMNS[tab].map(function (c) {
    return TEXT_COLUMNS[tab].indexOf(c) >= 0 ? '@' : 'General';
  });
}

function appendRows_(sheet, tab, rows) {
  var start = sheet.getLastRow() + 1;
  var overflow = start + rows.length - 1 - sheet.getMaxRows();
  if (overflow > 0) sheet.insertRowsAfter(sheet.getMaxRows(), overflow);
  var range = sheet.getRange(start, 1, rows.length, COLUMNS[tab].length);
  var fmt = formats_(tab);
  range.setNumberFormats(rows.map(function () { return fmt; }));
  range.setValues(rows);
}

function columnValues_(sheet, col) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, col, last - 1, 1).getValues().map(function (r) { return String(r[0]); });
}

function readPlan_() {
  var rows = readRows_('Plan', 0);
  return rows
    .filter(function (r) { return r.day && r.exercise; })
    .map(function (r) {
      return {
        day: String(r.day).trim().toUpperCase(),
        order: Number(r.order) || 0,
        exercise: String(r.exercise).trim(),
        sets: Number(r.sets) || 1,
        target_reps: String(r.target_reps),
        target_weight: String(r.target_weight),
        rest_sec: Number(r.rest_sec) || 0,
        notes: String(r.notes),
      };
    });
}

function readTail_(tab, limit) {
  return readRows_(tab, limit);
}

/** Returns rows as objects keyed by header. limit > 0 → only the last `limit` rows. */
function readRows_(tab, limit) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
  var cols = COLUMNS[tab];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var first = 2;
  if (limit > 0) first = Math.max(2, last - limit + 1);
  var values = sh.getRange(first, 1, last - first + 1, cols.length).getValues();
  var tz = Session.getScriptTimeZone();
  return values.map(function (row) {
    var o = {};
    cols.forEach(function (c, i) {
      var v = row[i];
      if (v instanceof Date) {
        v = c === 'date' ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : v.toISOString();
      }
      o[c] = v;
    });
    return o;
  });
}

function checkToken_(given) {
  var expected = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!expected || typeof given !== 'string' || given.length !== expected.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
