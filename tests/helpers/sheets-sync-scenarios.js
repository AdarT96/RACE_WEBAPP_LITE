// Scenarios that drive scripts/Code.gs through the Apps Script mock.
// The golden file (tests/fixtures/sheets-sync-golden.json) was produced by running
// these SAME scenarios against the code before the batching/speed-up change
// (perf/offline-cache-timer-reads:scripts/Code.gs), so a passing test means
// "new Code.gs writes exactly what the old one wrote".

export const EVENT = { eventId: 'ev1', eventName: 'גיבוש בדיקה' };

const STATIONS = [
  { station_type: 'sprints', params: ['חוסן וכושר הסתגלות'] },        // measure: place
  { station_type: 'crawls', params: ['חוסן וכושר הסתגלות'] },         // measure: reps
  { station_type: 'stretcher', params: ['אקטיביות', 'אינטליגנציה חברתית'] },
  { station_type: 'debate', params: ['אסרטיביות'] }
];

export function stationRow({ team, pid, round, station, evaluator, score = 5, place, reps, comments = '' }) {
  const st = STATIONS[station];
  const scores = {};
  st.params.forEach((p, i) => { scores[p] = score + i; });
  return {
    team: String(team).padStart(2, '0'), id: String(pid), round,
    station_type: st.station_type,
    evaluator_uid: evaluator.uid, evaluator_name: evaluator.name, evaluator_team: String(team),
    scores, comments, place, reps, first_ms: place ? 61000 + pid : 0,
    ...EVENT
  };
}

export function noteRow({ team, pid, evaluator, note }) {
  return {
    type: 'general_note', team_id: String(team).padStart(2, '0'), participant_id: String(pid),
    evaluator_uid: evaluator.uid, evaluator_name: evaluator.name, note, ...EVENT
  };
}

export function makeRows({ teams, participants, stations, rounds, evaluatorsPerTeam, withNotes = true, scoreBase = 5 }) {
  const rows = [];
  for (let t = 1; t <= teams; t++) {
    const evs = [];
    for (let e = 1; e <= evaluatorsPerTeam; e++) evs.push({ uid: `uid-t${t}-e${e}`, name: `מעריך ${t}-${e}` });
    for (let p = 1; p <= participants; p++) {
      const pid = t * 100 + p;
      for (let s = 0; s < stations; s++) for (let r = 1; r <= rounds; r++) {
        for (const ev of evs) {
          rows.push(stationRow({
            team: t, pid, round: r, station: s, evaluator: ev,
            score: ((pid + s + r) % 5) + scoreBase - 4, place: s === 0 ? ((p + r) % participants) + 1 : undefined,
            reps: s === 1 ? 10 + p : undefined, comments: p % 3 === 0 ? 'מהיר | עקבי' : ''
          }));
        }
      }
      if (withNotes) rows.push(noteRow({ team: t, pid, evaluator: evs[0], note: `הערה כללית על ${pid}` }));
    }
  }
  return rows;
}

export function filesNeeded(rows) {
  const teams = new Set(), evaluators = new Map();
  for (const row of rows) {
    const team = String(row.team || row.team_id || '').replace(/\D+/g, '');
    if (team) teams.add(String(Number(team)));
    const uid = row.evaluator_uid || '', name = row.evaluator_name || '';
    if (uid || name) evaluators.set(uid || name, { uid, name, team: String(row.evaluator_team || team || '') });
  }
  return { teams: [...teams], evaluators: [...evaluators.values()] };
}

// ה-batch מקובץ לפי צוות, כמו sendRowsBatched בלקוח
export function groupByTeam(rows) {
  const by = new Map();
  for (const row of rows) {
    const team = String(row.team ?? row.team_id ?? '').replace(/\D+/g, '') || '?';
    if (!by.has(team)) by.set(team, []);
    by.get(team).push(row);
  }
  return by;
}

const stripTimings = r => { const c = { ...r }; delete c.timings; return c; };

// הנתיב הישן: בקשה לכל צוות ולכל מעריך (גם הלקוח הישן וגם הפריסה הישנה)
export function ensurePerItem(env, rows) {
  const { teams, evaluators } = filesNeeded(rows);
  const out = [];
  for (const team of teams) out.push(stripTimings(env.call({ type: 'ensure_team_sheet', team, ...EVENT })));
  for (const ev of evaluators) {
    out.push(stripTimings(env.call({ type: 'ensure_evaluator_sheet', uid: ev.uid, name: ev.name, team: ev.team, ...EVENT })));
  }
  return out;
}

export function ensureBatched(env, rows) {
  const { teams, evaluators } = filesNeeded(rows);
  return env.call({ type: 'ensure_files', ...EVENT, teams, evaluators });
}

export function syncAll(env, rows) {
  const out = [];
  for (const [, teamRows] of groupByTeam(rows)) out.push(stripTimings(env.call({ type: 'sync_batch', rows: teamRows })));
  return out;
}

const EV_A = { uid: 'uid-a', name: 'דנה' };
const EV_B = { uid: 'uid-b', name: 'רון' };
const EV_C = { uid: 'uid-c', name: 'מיכל' };

// כל תרחיש מקבל { env, ensure } ומחזיר אובייקט JSON פשוט להשוואה מול ה-golden.
// ensure(env, rows) הוא ensurePerItem (הישן) או ensureBatched (החדש) — התוצאה הסופית חייבת להיות זהה.
export const SCENARIOS = {
  stationSync({ env, ensure }) {
    const rows = [
      stationRow({ team: 1, pid: 101, round: 2, station: 0, evaluator: EV_A, place: 2 }),
      stationRow({ team: 1, pid: 102, round: 1, station: 0, evaluator: EV_A, place: 3, comments: 'לא מרוכז | איטי' }),
      stationRow({ team: 1, pid: 103, round: 1, station: 0, evaluator: EV_A, place: 1 }),
      stationRow({ team: 1, pid: 101, round: 1, station: 0, evaluator: EV_B, place: 1, score: 7 }),
      stationRow({ team: 1, pid: 101, round: 1, station: 1, evaluator: EV_A, reps: 14 }),
      stationRow({ team: 1, pid: 102, round: 1, station: 2, evaluator: EV_B }),
      stationRow({ team: 1, pid: 102, round: 1, station: 3, evaluator: EV_A, score: 9 })
    ];
    ensure(env, rows);
    return { sync: syncAll(env, rows), state: env.snapshotAll() };
  },

  repeatSync({ env, ensure }) {
    const first = [
      stationRow({ team: 1, pid: 101, round: 1, station: 0, evaluator: EV_A, place: 2, score: 4 }),
      stationRow({ team: 1, pid: 102, round: 1, station: 0, evaluator: EV_A, place: 1, score: 6 }),
      noteRow({ team: 1, pid: 101, evaluator: EV_A, note: 'הערה ראשונה' })
    ];
    ensure(env, first);
    const r1 = syncAll(env, first);
    const second = [
      stationRow({ team: 1, pid: 101, round: 1, station: 0, evaluator: EV_A, place: 1, score: 9, comments: 'עודכן' }),
      stationRow({ team: 1, pid: 102, round: 1, station: 0, evaluator: EV_A, place: 2, score: 2 }),
      stationRow({ team: 1, pid: 103, round: 1, station: 0, evaluator: EV_A, place: 3, score: 3 }),
      noteRow({ team: 1, pid: 101, evaluator: EV_A, note: 'הערה ראשונה' }),
      noteRow({ team: 1, pid: 101, evaluator: EV_A, note: 'הערה שנייה' })
    ];
    const r2 = syncAll(env, second);
    const r3 = syncAll(env, second);   // והפעם בפעם השלישית ללא שינוי
    return { sync: [r1, r2, r3], state: env.snapshotAll() };
  },

  newTabs({ env, ensure }) {
    const first = [stationRow({ team: 1, pid: 101, round: 1, station: 2, evaluator: EV_A })];
    ensure(env, first);
    const r1 = syncAll(env, first);
    // מעריך חדש (קובץ חדש) ומועמד חדש (טאב חדש) באותו צוות
    const second = [
      stationRow({ team: 1, pid: 104, round: 1, station: 2, evaluator: EV_A, score: 8 }),
      stationRow({ team: 1, pid: 101, round: 1, station: 2, evaluator: EV_C, score: 3 }),
      stationRow({ team: 1, pid: 104, round: 1, station: 3, evaluator: EV_C }),
      noteRow({ team: 1, pid: 104, evaluator: EV_C, note: 'חדש' })
    ];
    ensure(env, second);
    const r2 = syncAll(env, second);
    return { sync: [r1, r2], state: env.snapshotAll() };
  },

  generalNotes({ env, ensure }) {
    const rows = [
      noteRow({ team: 1, pid: 101, evaluator: EV_A, note: 'מוביל קבוצה' }),
      noteRow({ team: 1, pid: 101, evaluator: EV_B, note: 'שקט' }),
      noteRow({ team: 1, pid: 102, evaluator: EV_A, note: 'חזק פיזית' }),
      { ...noteRow({ team: 1, pid: 102, evaluator: EV_A, note: '' }) },           // ריקה — מדולגת
      stationRow({ team: 1, pid: 101, round: 1, station: 3, evaluator: EV_A })
    ];
    ensure(env, rows);
    const r1 = syncAll(env, rows);
    const r2 = syncAll(env, rows);
    return { sync: [r1, r2], state: env.snapshotAll() };
  },

  preexistingRows({ env, ensure }) {
    const rows = [
      stationRow({ team: 1, pid: 101, round: 2, station: 0, evaluator: EV_A, place: 1 }),
      stationRow({ team: 1, pid: 102, round: 1, station: 1, evaluator: EV_A, reps: 3 }),
      noteRow({ team: 1, pid: 101, evaluator: EV_A, note: 'חדשה' })
    ];
    ensure(env, rows);

    // שורות קיימות שלא קשורות לאצווה: מעריך אחר, סבב אחר, וכותרת שבורה בטאב אחד
    const teamSs = env.findSpreadsheetByName('צוות 1');
    const station = teamSs.insertSheet('ספרינטים');
    station.appendRow(['סבב', 'מקום', 'מועמד', 'זמן', 'מדידה', 'פרמטר א׳', 'ציון א׳', 'פרמטר ב׳', 'ציון ב׳', 'מעריך', 'הערות']);
    station.appendRow([1, 4, 105, '', '', 'חוסן וכושר הסתגלות', 2, '', '', 'מעריך אחר', 'נשאר']);
    station.appendRow([3, 1, 101, '1:05', '', 'חוסן וכושר הסתגלות', 7, '', '', EV_A.name, 'סבב אחר']);
    const crawls = teamSs.insertSheet('זחילות');                // כותרת שגויה
    crawls.appendRow(['x', 'y']);
    crawls.appendRow([1, 1, 102, '', 5, 'חוסן וכושר הסתגלות', 1, '', '', 'מישהו', 'קיים']);
    const notes = teamSs.insertSheet('הערות כלליות');
    notes.appendRow(['מועמד', 'מעריך', 'הערה']);
    notes.appendRow([999, 'ישן', 'הערה ישנה']);
    const evSs = env.findSpreadsheetByName('שיט מעריך — דנה');
    const t101 = evSs.insertSheet('101');
    t101.appendRow(['תחנה', 'סבב', 'מקום', 'מספר', 'פרמטר א׳', 'ציון א׳', 'פרמטר ב׳', 'ציון ב׳', 'מעריך', 'הערות']);
    t101.appendRow(['תחנה ישנה', 9, '', '', '', 1, '', '', 'דנה', 'לא לגעת']);
    const empty102 = evSs.insertSheet('102');                   // טאב קיים וריק

    const r1 = syncAll(env, rows);
    return { sync: r1, state: env.snapshotAll(), emptyTabRowsAfter: empty102._rows.length };
  },

  // תרחיש הקבצים: קיים / בסל / חסר / נכשל. ensure מחזיר את התשובות (נתיב ישן: מערך, חדש: תשובה אחת).
  ensureMix({ env, ensure }) {
    const base = [
      stationRow({ team: 1, pid: 101, round: 1, station: 0, evaluator: EV_A, place: 1 }),
      stationRow({ team: 2, pid: 201, round: 1, station: 0, evaluator: EV_B, place: 1 })
    ];
    ensurePerItem(env, base);                              // צוותים 1,2 ומעריכים A,B קיימים
    env.trash(env.findSpreadsheetByName('צוות 2')._id);    // קובץ צוות 2 בסל -> ייווצר מחדש

    const rows = [
      ...base,
      stationRow({ team: 3, pid: 301, round: 1, station: 0, evaluator: EV_C, place: 1 }),   // צוות 3 חסר; מעריך C חסר
      stationRow({ team: 4, pid: 401, round: 1, station: 0, evaluator: { uid: 'uid-x', name: 'נכשל' }, place: 1 })
    ];
    // צוות 4 ומעריך "נכשל" -> יצירת הקובץ נכשלת
    env.hooks.onCreate = name => { if (name.startsWith('צוות 4') || name.includes('נכשל')) throw new Error('quota exceeded'); };

    const results = ensure(env, rows);
    return { results, state: env.snapshotAll() };
  }
};
