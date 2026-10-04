// Runs apps-script/Code.gs inside Node with in-memory fakes of the Apps Script
// services it uses (SpreadsheetApp, PropertiesService, LockService, …), so the
// test exercises the real backend code rather than a re-implementation.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

class FakeRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sheet.rows[this.r - 1 + i] || [];
      out.push(Array.from({ length: this.nc }, (_, j) => (row[this.c - 1 + j] ?? '')));
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.nr || values.some((v) => v.length !== this.nc)) throw new Error('setValues: dimension mismatch');
    if (this.r - 1 + this.nr > this.sheet.maxRows) throw new Error('setValues: range beyond sheet');
    values.forEach((row, i) => {
      const target = (this.sheet.rows[this.r - 1 + i] ||= []);
      row.forEach((v, j) => {
        const fmt = this.sheet.formatAt(this.r + i, this.c + j);
        target[this.c - 1 + j] = fmt === '@' && v !== '' ? String(v) : v;
      });
    });
    return this;
  }
  setNumberFormats(f) { f.forEach((row, i) => row.forEach((fmt, j) => this.sheet.formats.set(`${this.r + i}:${this.c + j}`, fmt))); return this; }
  setNumberFormat(fmt) { this.sheet.colFormats.set(this.c, fmt); return this; }
  setFontWeight() { return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; this.maxRows = 1000; this.formats = new Map(); this.colFormats = new Map(); }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.rows.length - 1; i >= 0; i--) if ((this.rows[i] || []).some((v) => v !== '' && v != null)) return i + 1;
    return 0;
  }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_after, n) { this.maxRows += n; }
  getRange(r, c, nr = 1, nc = 1) { return new FakeRange(this, r, c, nr, nc); }
  setFrozenRows() {}
  formatAt(r, c) { return this.formats.get(`${r}:${c}`) || this.colFormats.get(c) || 'General'; }
  /** Test helper: data rows as objects keyed by header. */
  objects() {
    const [header, ...data] = this.rows.slice(0, this.getLastRow());
    return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  }
}

export function createBackend() {
  const sheets = [new FakeSheet('Sheet1')];
  let name = 'Untitled spreadsheet';
  const props = {};
  const ss = {
    getName: () => name,
    rename: (n) => { name = n; },
    getSheetByName: (n) => sheets.find((s) => s.name === n) || null,
    insertSheet: (n) => { const s = new FakeSheet(n); sheets.push(s); return s; },
    getSheets: () => sheets.slice(),
    deleteSheet: (s) => sheets.splice(sheets.indexOf(s), 1),
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ content: s, setMimeType() { return this; }, getContent() { return this.content; } }),
    },
    Utilities: { getUuid: () => randomUUID(), formatDate: (d) => d.toISOString().slice(0, 10) },
    Session: { getScriptTimeZone: () => 'Etc/UTC' },
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8'), ctx, { filename: 'Code.gs' });
  return { ctx, ss, props, sheet: (n) => ss.getSheetByName(n), name: () => name };
}
