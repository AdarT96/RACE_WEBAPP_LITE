import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAppsScriptEnv } from './helpers/apps-script-mock.js';
import {
  SCENARIOS, EVENT, ensurePerItem, ensureBatched, stationRow, makeRows
} from './helpers/sheets-sync-scenarios.js';

const codePath = fileURLToPath(new URL('../scripts/Code.gs', import.meta.url));
const golden = JSON.parse(readFileSync(new URL('./fixtures/sheets-sync-golden.json', import.meta.url), 'utf8'));
const newEnv = () => createAppsScriptEnv({ codePath });
const clean = value => JSON.parse(JSON.stringify(value));

// ה-golden הופק מהרצת Code.gs המקורי (לפני האצווה והאופטימיזציה) על אותם תרחישים.
// ensure: הנתיב הישן (בקשה לכל פריט) — וגם הנתיב החדש (ensure_files) חייב לתת אותו מצב סופי.
const ensureModes = {
  'per-item requests': ensurePerItem,
  'ensure_files': (env, rows) => ensureBatched(env, rows)
};

for (const [mode, ensure] of Object.entries(ensureModes)) {
  for (const name of ['stationSync', 'repeatSync', 'newTabs', 'generalNotes', 'preexistingRows']) {
    test(`${name} matches the original Code.gs output (${mode})`, () => {
      const actual = clean(SCENARIOS[name]({ env: newEnv(), ensure }));
      assert.deepEqual(actual, golden[name]);
    });
  }
}

test('station sync: rows sorted by round then place, header formatted and frozen', () => {
  const state = golden.stationSync.state;
  const teamKey = Object.keys(state).find(k => k.startsWith('צוות 1'));
  const tab = state[teamKey].find(t => t.name === 'ספרינטים');
  assert.equal(tab.frozen, 1);
  assert.equal(tab.formats['1,1'].fontWeight, 'bold');
  assert.equal(tab.formats['1,1'].background, '#0f766e');
  assert.equal(tab.formats['1,1'].fontColor, 'white');
  assert.deepEqual(tab.rows.slice(1).map(r => [r[0], r[1]]), [[1, 1], [1, 1], [1, 3], [2, 2]]);
});

test('repeat sync overwrites by key and never duplicates rows', () => {
  const env = newEnv();
  const row = place => stationRow({ team: 1, pid: 101, round: 1, station: 0, evaluator: { uid: 'u', name: 'דנה' }, place });
  ensureBatched(env, [row(1)]);
  env.call({ type: 'sync_batch', rows: [row(1)] });
  env.call({ type: 'sync_batch', rows: [row(3)] });
  env.call({ type: 'sync_batch', rows: [row(3)] });
  const teamSs = env.findSpreadsheetByName('צוות 1');
  const tab = teamSs._sheets.find(s => s._name === 'ספרינטים');
  assert.equal(tab._rows.length, 2);
  assert.equal(tab._rows[1][1], 3);
});

test('new participant tab in an evaluator file gets header formatting', () => {
  const env = newEnv();
  const rows = [stationRow({ team: 1, pid: 104, round: 1, station: 2, evaluator: { uid: 'u', name: 'דנה' } })];
  ensureBatched(env, rows);
  env.call({ type: 'sync_batch', rows });
  const tab = env.findSpreadsheetByName('שיט מעריך')._sheets.find(s => s._name === '104');
  assert.ok(tab);
  assert.equal(tab._frozen, 1);
  assert.deepEqual(tab._fmt['1,1'], { fontWeight: 'bold', background: '#4a86e8', fontColor: 'white' });
  assert.deepEqual(tab._fmt['1,10'], { fontWeight: 'bold', background: '#4a86e8', fontColor: 'white' });
  assert.equal(tab._fmt['2,1'], undefined);
});

test('a batch never shortens a tab: unrelated pre-existing rows survive', () => {
  const state = golden.preexistingRows.state;
  const teamKey = Object.keys(state).find(k => k.startsWith('צוות 1'));
  const flat = tabName => state[teamKey].find(t => t.name === tabName).rows.map(r => r.join('|')).join('\n');
  assert.match(flat('ספרינטים'), /מעריך אחר/);
  assert.match(flat('ספרינטים'), /סבב אחר/);
  assert.match(flat('הערות כלליות'), /הערה ישנה/);
  const evKey = Object.keys(state).find(k => k.startsWith('שיט מעריך — דנה'));
  assert.match(state[evKey].find(t => t.name === '101').rows.map(r => r.join('|')).join('\n'), /לא לגעת/);
});

// ───────────── ensure_files ─────────────
const normalizePerItem = (responses, kinds) => responses.map((r, i) => ({
  kind: kinds[i].kind, key: kinds[i].key, ok: r.success,
  created: r.success ? /created$/.test(r.message) : false,
  ...(r.success ? { url: r.url, fileId: r.fileId } : { error: r.message.replace(/^Error: /, '') }),
  ...(r.warning ? { warning: r.warning } : {})
}));

test('ensure_files: mix of existing / trashed / missing / failing items equals the per-item results', () => {
  const baseline = SCENARIOS.ensureMix({ env: newEnv(), ensure: ensurePerItem });
  const batchedEnv = newEnv();
  let response;
  const batched = clean(SCENARIOS.ensureMix({
    env: batchedEnv, ensure: (env, rows) => (response = ensureBatched(env, rows))
  }));

  // המצב הסופי של כל הקבצים זהה בדיוק
  assert.deepEqual(batched.state, clean(baseline).state);
  assert.deepEqual(clean(baseline), golden.ensureMix);

  const kinds = [
    { kind: 'team', key: '1' }, { kind: 'team', key: '2' }, { kind: 'team', key: '3' }, { kind: 'team', key: '4' },
    { kind: 'evaluator', key: 'uid-a' }, { kind: 'evaluator', key: 'uid-b' },
    { kind: 'evaluator', key: 'uid-c' }, { kind: 'evaluator', key: 'uid-x' }
  ];
  assert.equal(response.success, true);
  assert.deepEqual(response.results, normalizePerItem(golden.ensureMix.results, kinds));
  assert.deepEqual(response.results.map(r => [r.key, r.ok, r.created]), [
    ['1', true, false], ['2', true, true], ['3', true, true], ['4', false, false],
    ['uid-a', true, false], ['uid-b', true, false], ['uid-c', true, true], ['uid-x', false, false]
  ]);
  assert.match(response.results[3].error, /quota exceeded/);
  assert.equal(typeof response.timings.totalMs, 'number');
});

test('ensure_files: invalid items fail alone and are reported with the legacy message', () => {
  const env = newEnv();
  const res = env.call({ type: 'ensure_files', ...EVENT, teams: ['abc', 7], evaluators: [{ uid: '', name: '' }, { uid: 'u9', name: 'עדי', team: '7' }] });
  assert.equal(res.success, true);
  assert.deepEqual(res.results.map(r => [r.kind, r.ok]), [['team', false], ['team', true], ['evaluator', false], ['evaluator', true]]);
  assert.equal(res.results[0].error, 'Missing team');
  assert.equal(res.results[2].error, 'Missing uid/name');
  assert.equal(env.call({ type: 'ensure_team_sheet', team: 'abc', ...EVENT }).message, 'Missing team');
  assert.equal(env.call({ type: 'ensure_evaluator_sheet', ...EVENT }).message, 'Missing uid/name');
});

test('ensure_files is idempotent and opens each file once per request', () => {
  const env = newEnv();
  const rows = makeRows({ teams: 2, participants: 1, stations: 1, rounds: 1, evaluatorsPerTeam: 2, withNotes: false });
  const first = ensureBatched(env, rows);
  assert.ok(first.results.every(r => r.ok && r.created));
  env.resetCounts();
  const second = ensureBatched(env, rows);
  assert.ok(second.results.every(r => r.ok && !r.created));
  assert.equal(env.counts['SpreadsheetApp.openById'], 1);   // רק הקובץ הראשי, פעם אחת לכל הפריטים
});

test('old request types answer exactly as before', () => {
  const env = newEnv();
  const team = env.call({ type: 'ensure_team_sheet', team: '5', ...EVENT });
  assert.deepEqual(Object.keys(team), ['success', 'message', 'url', 'fileId', 'warning']);
  assert.equal(team.message, 'Team sheet created');
  const again = env.call({ type: 'ensure_team_sheet', team: '5', ...EVENT });
  assert.deepEqual(Object.keys(again), ['success', 'message', 'url', 'fileId']);
  assert.equal(again.message, 'Team sheet exists');
  assert.equal(again.url, team.url);

  const ev = env.call({ type: 'ensure_evaluator_sheet', uid: 'u1', name: 'דנה', team: '5', ...EVENT });
  assert.deepEqual(Object.keys(ev), ['success', 'message', 'url', 'fileId', 'warning']);
  assert.equal(ev.message, 'Evaluator sheet created');
  assert.equal(env.call({ type: 'ensure_evaluator_sheet', uid: 'u1', name: 'דנה', team: '5', ...EVENT }).message, 'Evaluator sheet exists');
});

test('doGet declares ensure_files and a bumped version', () => {
  const info = newEnv().get();
  assert.ok(info.features.includes('ensure_files'));
  assert.ok(info.features.includes('sync_batch'));
  assert.match(info.version, /batched-file-check/);
});

// ───────────── fewer Sheets calls ─────────────
test('batch write on existing tabs: no per-tab getSheetByName, about 5 Sheets calls per tab', () => {
  const env = newEnv();
  const rows = makeRows({ teams: 1, participants: 10, stations: 1, rounds: 1, evaluatorsPerTeam: 1, withNotes: false });
  ensureBatched(env, rows);
  env.call({ type: 'sync_batch', rows });      // יוצר את הטאבים
  env.resetCounts();
  env.call({ type: 'sync_batch', rows });      // סנכרון חוזר: כל הטאבים כבר קיימים
  // 10 טאבי מועמד + טאב תחנה אחד. הנתיב הישן עלה כ-9 קריאות לטאב (לפני מיון).
  assert.equal(env.counts['Spreadsheet.getSheetByName'] || 0, 2);   // רק דפי הרישום (צוות + מעריך)
  assert.equal(env.counts['Spreadsheet.getSheets'], 2);             // פעם אחת לקובץ
  assert.equal(env.counts['Range.setValues'], 11);                  // כתיבה אחת לטאב
  assert.ok(env.sheetsCalls() <= 11 * 5 + 40, `too many Sheets calls: ${env.sheetsCalls()}`);
});
