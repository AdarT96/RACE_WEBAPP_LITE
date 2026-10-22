// Minimal in-memory Google Apps Script runtime, just enough to run scripts/Code.gs
// under node:vm. It exists to (a) check the batch sync writes exactly what the
// older code wrote and (b) count Sheets/Drive API calls (every public method
// call on SpreadsheetApp / Spreadsheet / Sheet / Range is counted).
//
// Not a faithful emulation of Google's quirks; it only models what Code.gs uses:
// numeric strings become numbers on write (as in Sheets), blanks sort last,
// out-of-shape setValues throw, ranges must have >= 1 row/column.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const FIXED_NOW = '2026-01-01 00:00:00';

function parseCell(v) {
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) && v.trim() === v) return Number(v);
  if (v === null || v === undefined) return '';
  return v;
}

function colCompare(a, b) {
  const aBlank = a === '' || a == null, bBlank = b === '' || b == null;
  if (aBlank || bBlank) return aBlank === bBlank ? 0 : (aBlank ? 1 : -1);
  const aNum = typeof a === 'number', bNum = typeof b === 'number';
  if (aNum && bNum) return a - b;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export function createAppsScriptEnv({ codePath, source, mainSheetId } = {}) {
  const src = source ?? readFileSync(codePath, 'utf8');
  const counts = {};
  const files = new Map();      // id -> { id, name, trashed, spreadsheet, parent }
  const folders = new Map();    // id -> folder object
  const props = new Map();
  const hooks = { onCreate: null, failOpen: new Set(), driveMissing: new Set() };
  let nextId = 1;

  const tick = name => { counts[name] = (counts[name] || 0) + 1; };

  class Range {
    constructor(sheet, row, col, nr, nc) {
      if (row < 1 || col < 1) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      if (nr < 1 || nc < 1) throw new Error('The number of rows/columns in the range must be at least one.');
      Object.assign(this, { sheet, row, col, nr, nc });
    }
    getValues() {
      tick('Range.getValues');
      const out = [];
      for (let r = 0; r < this.nr; r++) {
        const line = [];
        for (let c = 0; c < this.nc; c++) {
          const v = (this.sheet._rows[this.row - 1 + r] || [])[this.col - 1 + c];
          line.push(v === undefined ? '' : v);
        }
        out.push(line);
      }
      return out;
    }
    setValues(values) {
      tick('Range.setValues');
      if (!Array.isArray(values) || values.length !== this.nr) {
        throw new Error(`The number of rows in the data does not match the number of rows in the range. The data has ${values && values.length} but the range has ${this.nr}.`);
      }
      for (let r = 0; r < this.nr; r++) {
        if (!Array.isArray(values[r]) || values[r].length !== this.nc) {
          throw new Error(`The number of columns in the data does not match the number of columns in the range. The data has ${values[r] && values[r].length} but the range has ${this.nc}.`);
        }
        for (let c = 0; c < this.nc; c++) this.sheet._put(this.row + r, this.col + c, values[r][c]);
      }
      return this;
    }
    setValue(v) {
      tick('Range.setValue');
      for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet._put(this.row + r, this.col + c, v);
      return this;
    }
    _fmt(key, v) {
      for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) {
        const k = `${this.row + r},${this.col + c}`;
        (this.sheet._fmt[k] = this.sheet._fmt[k] || {})[key] = v;
      }
      return this;
    }
    setFontWeight(v) { tick('Range.setFontWeight'); return this._fmt('fontWeight', v); }
    setBackground(v) { tick('Range.setBackground'); return this._fmt('background', v); }
    setFontColor(v) { tick('Range.setFontColor'); return this._fmt('fontColor', v); }
    sort(specs) {
      tick('Range.sort');
      const block = [];
      for (let r = 0; r < this.nr; r++) {
        const line = [];
        for (let c = 0; c < this.nc; c++) {
          const v = (this.sheet._rows[this.row - 1 + r] || [])[this.col - 1 + c];
          line.push(v === undefined ? '' : v);
        }
        block.push({ line, i: r });
      }
      block.sort((a, b) => {
        for (const s of specs) {
          const d = colCompare(a.line[s.column - 1], b.line[s.column - 1]);
          if (d) return s.ascending === false ? -d : d;
        }
        return a.i - b.i;
      });
      block.forEach((b, r) => b.line.forEach((v, c) => this.sheet._put(this.row + r, this.col + c, v)));
      return this;
    }
  }

  class Sheet {
    constructor(ss, name) {
      Object.assign(this, { _ss: ss, _name: name, _rows: [], _fmt: {}, _frozen: 0 });
    }
    _put(r, c, v) {
      while (this._rows.length < r) this._rows.push([]);
      const row = this._rows[r - 1];
      while (row.length < c) row.push('');
      row[c - 1] = parseCell(v);
    }
    getName() { tick('Sheet.getName'); return this._name; }
    setName(n) { tick('Sheet.setName'); this._name = n; return this; }
    getLastRow() {
      tick('Sheet.getLastRow');
      for (let r = this._rows.length; r >= 1; r--) if (this._rows[r - 1].some(v => v !== '' && v !== undefined)) return r;
      return 0;
    }
    getRange(row, col, nr = 1, nc = 1) { tick('Sheet.getRange'); return new Range(this, row, col, nr, nc); }
    appendRow(values) {
      tick('Sheet.appendRow');
      const last = this.getLastRowQuiet_();
      values.forEach((v, i) => this._put(last + 1, i + 1, v));
      return this;
    }
    getLastRowQuiet_() {
      for (let r = this._rows.length; r >= 1; r--) if (this._rows[r - 1].some(v => v !== '' && v !== undefined)) return r;
      return 0;
    }
    setFrozenRows(n) { tick('Sheet.setFrozenRows'); this._frozen = n; return this; }
    deleteRows(start, n) { tick('Sheet.deleteRows'); this._rows.splice(start - 1, n); return this; }
  }

  class Spreadsheet {
    constructor(name) {
      this._id = `sheet-${nextId++}`;
      this._name = name;
      this._sheets = [new Sheet(this, 'Sheet1')];
    }
    getId() { tick('Spreadsheet.getId'); return this._id; }
    getUrl() { tick('Spreadsheet.getUrl'); return `https://docs.google.com/spreadsheets/d/${this._id}/edit`; }
    getName() { tick('Spreadsheet.getName'); return this._name; }
    getSheets() { tick('Spreadsheet.getSheets'); return this._sheets.slice(); }
    getSheetByName(name) {
      tick('Spreadsheet.getSheetByName');
      return this._sheets.find(s => s._name === name) || null;
    }
    insertSheet(name) {
      tick('Spreadsheet.insertSheet');
      if (this._sheets.some(s => s._name === name)) throw new Error(`A sheet with the name "${name}" already exists.`);
      const s = new Sheet(this, name);
      this._sheets.push(s);
      return s;
    }
  }

  const registerFile = (ss, parent) => {
    files.set(ss._id, { id: ss._id, name: ss._name, trashed: false, spreadsheet: ss, parent: parent || null, editors: [] });
  };

  const SpreadsheetApp = {
    openById(id) {
      tick('SpreadsheetApp.openById');
      const f = files.get(id);
      if (!f || hooks.failOpen.has(id)) throw new Error(`Unexpected error while getting the method or property openById on object SpreadsheetApp.`);
      return f.spreadsheet;
    },
    create(name) {
      tick('SpreadsheetApp.create');
      if (hooks.onCreate) hooks.onCreate(name);
      const ss = new Spreadsheet(name);
      registerFile(ss, null);
      return ss;
    },
    flush() { tick('SpreadsheetApp.flush'); }
  };

  const makeFolder = (name, parent) => {
    const f = {
      _id: `folder-${nextId++}`, _name: name, _parent: parent, _children: [],
      getName() { return name; },
      getFoldersByName(n) {
        tick('Drive.getFoldersByName');
        const list = f._children.filter(c => c._name === n);
        let i = 0;
        return { hasNext: () => i < list.length, next: () => list[i++] };
      },
      createFolder(n) { tick('Drive.createFolder'); const c = makeFolder(n, f); f._children.push(c); return c; }
    };
    folders.set(f._id, f);
    return f;
  };
  const root = makeFolder('root', null);

  const fileHandle = rec => ({
    isTrashed() { return rec.trashed; },
    moveTo(folder) { rec.parent = folder; return this; },
    addEditor(e) { rec.editors.push(e); return this; },
    getParents() { let done = false; return { hasNext: () => !done && !!rec.parent, next: () => { done = true; return rec.parent; } }; }
  });

  const DriveApp = {
    getFileById(id) {
      tick('Drive.getFileById');
      const rec = files.get(id);
      if (!rec || hooks.driveMissing.has(id)) throw new Error('No item with the given id could be found, or you do not have permission to access it.');
      return fileHandle(rec);
    },
    getFolderById(id) {
      tick('Drive.getFolderById');
      const f = folders.get(id);
      if (!f) throw new Error('No item with the given id could be found.');
      return f;
    },
    getRootFolder() { tick('Drive.getRootFolder'); return root; }
  };

  const ContentService = {
    MimeType: { JSON: 'JSON' },
    createTextOutput(text) {
      return { _text: text, setMimeType() { return this; }, getContent() { return text; } };
    }
  };

  const LockService = {
    getScriptLock() { return { waitLock() {}, releaseLock() {} }; }
  };
  const PropertiesService = {
    getScriptProperties() {
      return {
        getProperty: k => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v),
        deleteProperty: k => props.delete(k)
      };
    }
  };
  const Utilities = { formatDate() { return FIXED_NOW; } };

  const ctx = vm.createContext({
    SpreadsheetApp, DriveApp, ContentService, LockService, PropertiesService, Utilities, console
  });
  vm.runInContext(src, ctx, { filename: 'Code.gs' });

  // הקובץ הראשי חייב להתקיים תחת ה-SHEET_ID שב-Code.gs
  const mainId = mainSheetId || ctx.SHEET_ID;
  const main = new Spreadsheet('main');
  main._id = mainId;
  registerFile(main, root);

  const call = payload => {
    const out = ctx.doPost({ postData: { contents: JSON.stringify(payload) } });
    return JSON.parse(out.getContent());
  };

  // תמונת מצב ניתנת להשוואה: שמות טאבים, ערכים (בלי שורות ריקות בסוף), עיצוב, שורה קפואה.
  const snapshotSpreadsheet = ss => ss._sheets.map(s => {
    let rows = s._rows.map(r => r.slice());
    while (rows.length && rows[rows.length - 1].every(v => v === '' || v === undefined)) rows.pop();
    rows = rows.map(r => { const x = r.slice(); while (x.length && x[x.length - 1] === '') x.pop(); return x; });
    return { name: s._name, rows, frozen: s._frozen, formats: JSON.parse(JSON.stringify(s._fmt)) };
  });
  const snapshotAll = () => {
    const out = {};
    for (const [id, f] of files) out[`${f.name}#${id}`] = snapshotSpreadsheet(f.spreadsheet);
    return out;
  };

  return {
    ctx, call, counts, files, hooks, props,
    get: () => JSON.parse(ctx.doGet({}).getContent()),
    mainSpreadsheet: main,
    resetCounts() { for (const k of Object.keys(counts)) delete counts[k]; },
    // כל קריאות Sheets (לא כולל Drive)
    sheetsCalls() { return Object.entries(counts).filter(([k]) => !k.startsWith('Drive.')).reduce((n, [, v]) => n + v, 0); },
    snapshotAll,
    snapshotOf: id => snapshotSpreadsheet(files.get(id).spreadsheet),
    // יצירת קובץ ישירות (לא דרך Code.gs), למשל קובץ שנמחק ב-Drive
    createRawSpreadsheet(name) { const ss = new Spreadsheet(name); registerFile(ss, root); return ss; },
    trash(id) { files.get(id).trashed = true; },
    findSpreadsheetByName(prefix) {
      for (const f of files.values()) if (f.name.startsWith(prefix)) return f.spreadsheet;
      return null;
    }
  };
}

export function tabRows(ss, name) {
  const s = ss._sheets.find(x => x._name === name);
  if (!s) return null;
  return s._rows.map(r => r.slice());
}
