// ============================================================
//  Google Apps Script — סנכרון גיבוש (גרסת LITE)
//  קובץ לכל צוות · טאב לכל מועמד · קובץ אישי לכל מעריך.
//  שורה לכל (תחנה × סבב × מעריך) — כל ההערכות, בלי ממוצע.
// ============================================================

// ---------- Settings ----------
var SHEET_ID       = "1MHJBLY5a7idjjQG783aYYf_lraHXmGmvivIZ1n0pqDE";
var API_SECRET_KEY = "YOUR_SECRET_KEY_HERE";

var TIMESTAMP_FORMAT = "yyyy-MM-dd HH:mm:ss";
var TIMEZONE         = "Asia/Jerusalem";

// רישומים בקובץ הראשי (מרכזייה בלבד — לא מחזיק נתוני הערכה)
var EVAL_REGISTRY_TAB     = "קבצי מעריכים";
var EVAL_FOLDER_NAME      = "קבצי מעריכים";
var EVAL_REGISTRY_HEADERS = ["UID", "שם מעריך", "צוות", "File ID", "קישור", "נוצר"];
var TEAM_REGISTRY_TAB     = "קבצי צוותים";
var TEAM_FOLDER_NAME      = "קבצי צוותים";
var TEAM_REGISTRY_HEADERS = ["צוות", "File ID", "קישור", "נוצר"];

// תיקיית האירוע ב-Drive — אחת לכל האירוע (2–4 ימים). ריק = מחושב אוטומטית
// "גיבוש <חודש> <שנה>" מהתאריך הנוכחי (אירוע אחד בחודש). אפשר לקבע שם ידני.
var EVENT_FOLDER_NAME = "";

// כותרות טאב מועמד (מבנה קבוע)
var PARTICIPANT_HEADERS = ["תחנה", "סבב", "מקום", "מספר", "פרמטר א׳", "ציון א׳", "פרמטר ב׳", "ציון ב׳", "מעריך", "הערות"];
var GENERAL_STATION_LABEL = "(הערה כללית)";

// ---------- סוגי תחנות (מסונכרן עם frontend/js/station-types.js) ----------
var STATION_TYPES = {
  jerrycans: { name: "סחיבת ג׳ריקנים", measure: "reps", measureLabel: "מספר חזרות", params: ["חוסן וכושר הסתגלות"] },
  stretcher: { name: "אלונקה סוציומטרית", measure: "place", params: ["אקטיביות", "אינטליגנציה חברתית"] },
  crawls: { name: "זחילות", measure: "reps", measureLabel: "מספר חזרות", params: ["חוסן וכושר הסתגלות"] },
  sprints: { name: "ספרינטים", measure: "place", params: ["חוסן וכושר הסתגלות"] },
  ironNerves: { name: "עצבים מברזל", measure: "reps", measureLabel: "מספר ברגים", params: ["חוסן וכושר הסתגלות"] },
  magen: { name: "מגנן", measure: "none", params: ["אינטליגנציה חברתית", "אקטיביות"] },
  dynamicFitness: { name: "תרגיל כושר דינמי", measure: "none", params: ["חוסן וכושר הסתגלות"] },
  tent: { name: "אוהל", measure: "none", params: ["אקטיביות", "אינטליגנציה חברתית"] },
  checkers: { name: "דמקה", measure: "none", params: ["אסרטיביות", "ניתוח מידע ושיקול דעת"] },
  spiderWeb: { name: "קורי עכביש", measure: "none", params: ["אינטליגנציה חברתית", "אקטיביות"] },
  pullup: { name: "מתח", measure: "none", params: ["חוסן וכושר הסתגלות"] },
  minefield: { name: "שדה מוקשים", measure: "none", params: ["אקטיביות", "אסרטיביות"] },
  sackFill: { name: "מילוי שק", measure: "reps", measureLabel: "מספר חזרות", params: ["אקטיביות"] },
  ladder: { name: "צא מזה – סולם ההצלחה", measure: "reps", measureLabel: "שלב שהגיע אליו", params: ["חוסן וכושר הסתגלות", "ניתוח מידע ושיקול דעת"] },
  puzzleA: { name: "פאזל + בניית A", measure: "none", params: ["חוסן וכושר הסתגלות", "אינטליגנציה חברתית"] },
  debate: { name: "דיבייט", measure: "none", params: ["אסרטיביות"] },
  discussion: { name: "דיון", measure: "none", params: ["אינטליגנציה חברתית"] }
};
var STATION_ORDER = ["jerrycans", "stretcher", "crawls", "sprints", "ironNerves", "magen", "dynamicFitness", "tent", "checkers", "spiderWeb", "pullup", "minefield", "sackFill", "ladder", "puzzleA", "debate", "discussion"];

// ---------- Router ----------
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    var payload = JSON.parse(e.postData.contents || "{}");

    if (API_SECRET_KEY && API_SECRET_KEY !== "YOUR_SECRET_KEY_HERE") {
      if (payload.key !== API_SECRET_KEY) return buildResponse(false, "Unauthorized");
    }

    var ss = SpreadsheetApp.openById(SHEET_ID);
    var type = String(payload.type || "").trim();

    if (type === "general_note")           return handleGeneralNote_(ss, payload);
    if (type === "ensure_evaluator_sheet") return handleEnsureEvaluatorSheet_(ss, payload);
    return handleRaceRow_(ss, payload);

  } catch (err) {
    return buildResponse(false, "Error: " + err.message);
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function doGet(e) {
  return buildResponse(true, "Gibush sync alive — קובץ לצוות · טאב למועמד");
}

// ---------- זיהוי סוג התחנה ----------
function resolveType_(payload) {
  var id = String(payload.station_type || "").trim();
  if (id && STATION_TYPES[id]) return { id: id, def: STATION_TYPES[id] };

  var name = String(payload.station_name || "").trim();
  if (name) for (var k in STATION_TYPES) if (STATION_TYPES[k].name === name) return { id: k, def: STATION_TYPES[k] };

  var n = parseInt(String(payload.station || "").replace(/\D+/g, ""), 10);
  if (n >= 1 && STATION_ORDER[n - 1]) { var kk = STATION_ORDER[n - 1]; return { id: kk, def: STATION_TYPES[kk] }; }
  return null;
}

// ---------- Race row handler ----------
function handleRaceRow_(ss, payload) {
  var pid = participantId_(payload);
  if (!pid) return buildResponse(false, "Missing id");
  var t = resolveType_(payload);
  if (!t) return buildResponse(false, "Unknown station");

  // הגדרה אפקטיבית: מעדיף מה שה-app שלח (משקף עריכות מנהל ב-Firestore),
  // ונופל חזרה ל-STATION_TYPES המוטמע כאן.
  var def = effectiveDef_(payload, t.def);

  var team = teamId_(payload);
  if (team) {
    var teamSs = getTeamFile_(ss, team);
    if (teamSs) writeParticipantRow_(teamSs, payload, def);
  }
  mirrorToEvaluatorFile_(ss, payload, function (evalSs) { writeParticipantRow_(evalSs, payload, def); });

  return buildResponse(true, "OK: " + def.name + " / מועמד " + pid);
}

// שמות פרמטרים/מדידה/שם תחנה — מה-payload אם הגיע, אחרת מברירת המחדל
function effectiveDef_(payload, def) {
  var params = (Array.isArray(payload.params) && payload.params.length) ? payload.params.slice() : def.params;
  return {
    name:         payload.station_name  ? String(payload.station_name) : def.name,
    measure:      payload.measure        ? String(payload.measure)      : def.measure,
    measureLabel: (payload.measure_label !== undefined) ? String(payload.measure_label) : def.measureLabel,
    params:       params
  };
}

// כותב שורת הערכה לטאב המועמד בקובץ נתון (קובץ צוות או קובץ מעריך)
function writeParticipantRow_(ss, payload, def) {
  var pid = participantId_(payload);
  if (!pid) return;
  var sheet = getOrCreateSheet_(ss, String(pid));
  ensureHeaders_(sheet, PARTICIPANT_HEADERS, "#4a86e8");

  var round    = Number(payload.round || 0);
  var evalName = String(payload.evaluator_name || "");
  var vals     = buildParticipantRow_(payload, def, round, evalName);

  var rowIndex = findParticipantRow_(sheet, def.name, round, evalName);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, PARTICIPANT_HEADERS.length).setValues([vals]);
  else sheet.appendRow(vals);
}

// עמודות: תחנה·סבב·מקום·מספר·פרמטר א׳·ציון א׳·פרמטר ב׳·ציון ב׳·מעריך·הערות
function buildParticipantRow_(payload, def, round, evalName) {
  var vals = [];
  for (var i = 0; i < PARTICIPANT_HEADERS.length; i++) vals.push("");
  vals[0] = def.name;
  vals[1] = round;

  if (def.measure === "place") {
    if (payload.place !== undefined && payload.place !== "" && payload.place !== null)
      vals[2] = Number(payload.place) || "";
  } else if (def.measure === "reps") {
    if (payload.reps !== undefined && payload.reps !== "" && payload.reps !== null)
      vals[3] = Number(payload.reps);
  }

  var scores = payload.scores || {};
  var params = def.params || [];
  if (params[0]) { vals[4] = params[0]; vals[5] = scoreVal_(scores[params[0]]); }
  if (params[1]) { vals[6] = params[1]; vals[7] = scoreVal_(scores[params[1]]); }

  vals[8] = evalName;
  vals[9] = notesToCell_(payload.comments);
  return vals;
}

function findParticipantRow_(sheet, stationName, round, evalName) {
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var vals = sheet.getRange(2, 1, last - 1, PARTICIPANT_HEADERS.length).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0]) === String(stationName) &&
        Number(vals[i][1]) === Number(round) &&
        String(vals[i][8] || "") === String(evalName)) {
      return 2 + i;
    }
  }
  return -1;
}

// ---------- General note handler ----------
function handleGeneralNote_(ss, payload) {
  var pid  = parseInt(payload.participant_id, 10);
  var note = String(payload.note || "");
  if (!pid || !note) return buildResponse(false, "Missing pid/note");

  var team = parseInt(String(payload.team_id || "").replace(/\D+/g, ""), 10);
  if (team) {
    var teamSs = getTeamFile_(ss, team);
    if (teamSs) writeGeneralNoteRow_(teamSs, payload);
  }
  mirrorToEvaluatorFile_(ss, payload, function (evalSs) { writeGeneralNoteRow_(evalSs, payload); });

  return buildResponse(true, "Note recorded for pid " + pid);
}

function writeGeneralNoteRow_(ss, payload) {
  var pid  = parseInt(payload.participant_id, 10);
  var note = String(payload.note || "");
  if (!pid || !note) return;
  var evalName = String(payload.evaluator_name || "");

  var sheet = getOrCreateSheet_(ss, String(pid));
  ensureHeaders_(sheet, PARTICIPANT_HEADERS, "#4a86e8");

  // dedup: אותה הערה כללית מאותו מעריך לא נוספת פעמיים
  var last = sheet.getLastRow();
  if (last >= 2) {
    var vals = sheet.getRange(2, 1, last - 1, PARTICIPANT_HEADERS.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]) === GENERAL_STATION_LABEL &&
          String(vals[i][8] || "") === evalName &&
          String(vals[i][9] || "") === note) return;
    }
  }
  var row = [];
  for (var j = 0; j < PARTICIPANT_HEADERS.length; j++) row.push("");
  row[0] = GENERAL_STATION_LABEL;
  row[8] = evalName;
  row[9] = note;
  sheet.appendRow(row);
}

// ---------- קבצי צוותים ----------
function getTeamFile_(ss, team) {
  var entry = findTeamEntry_(ss, team);
  if (entry && entry.fileId) {
    try { DriveApp.getFileById(entry.fileId); return SpreadsheetApp.openById(entry.fileId); }
    catch (gone) { /* נמחק — ניצור חדש */ }
  }
  var newSs = SpreadsheetApp.create("צוות " + team + " — גיבוש");
  try { DriveApp.getFileById(newSs.getId()).moveTo(teamFolder_()); } catch (moveErr) {}

  var first = newSs.getSheets()[0];
  first.setName("אודות");
  first.getRange(1, 1).setValue("קובץ צוות " + team + " — טאב לכל מועמד");
  first.getRange(2, 1).setValue("הטאבים נוצרים אוטומטית עם הסנכרון (טאב לכל מספר מועמד).");
  first.getRange(1, 1, 2, 1).setFontWeight("bold");

  var reg = getTeamRegistrySheet_(ss);
  reg.appendRow([String(team), newSs.getId(), newSs.getUrl(),
                 Utilities.formatDate(new Date(), TIMEZONE, TIMESTAMP_FORMAT)]);
  return newSs;
}

function findTeamEntry_(ss, team) {
  var sheet = ss.getSheetByName(TEAM_REGISTRY_TAB);
  if (!sheet || sheet.getLastRow() < 2) return null;
  var vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  var found = null;
  for (var i = 0; i < vals.length; i++) {
    if (Number(vals[i][0]) === Number(team)) found = { fileId: String(vals[i][1] || ""), url: String(vals[i][2] || "") };
  }
  return found;
}

function getTeamRegistrySheet_(ss) {
  var sheet = getOrCreateSheet_(ss, TEAM_REGISTRY_TAB);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(TEAM_REGISTRY_HEADERS);
    sheet.getRange(1, 1, 1, TEAM_REGISTRY_HEADERS.length)
         .setFontWeight("bold").setBackground("#0f766e").setFontColor("white");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function teamFolder_()      { return getOrCreateFolderIn_(eventFolder_(), TEAM_FOLDER_NAME); }
function evaluatorFolder_() { return getOrCreateFolderIn_(eventFolder_(), EVAL_FOLDER_NAME); }

// תיקיית האירוע — לצד הקובץ הראשי, כל קבצי הצוותים והמעריכים בתוכה
function eventFolder_() {
  var name = EVENT_FOLDER_NAME ||
             ("גיבוש " + hebMonth_() + " " + Utilities.formatDate(new Date(), TIMEZONE, "yyyy"));
  return getOrCreateFolderIn_(driveParent_(), name);
}

function driveParent_() {
  try {
    var parents = DriveApp.getFileById(SHEET_ID).getParents();
    return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  } catch (e) { return DriveApp.getRootFolder(); }
}

function getOrCreateFolderIn_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function hebMonth_() {
  var months = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
                "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
  var mm = parseInt(Utilities.formatDate(new Date(), TIMEZONE, "MM"), 10);
  return months[mm - 1] || "";
}

// ---------- קבצי מעריכים ----------
function handleEnsureEvaluatorSheet_(ss, payload) {
  var uid  = String(payload.uid || "").trim();
  var name = String(payload.name || "").trim();
  if (!uid && !name) return buildResponse(false, "Missing uid/name");

  var entry = findEvaluatorEntry_(ss, uid, name);
  if (entry && entry.fileId) {
    try {
      DriveApp.getFileById(entry.fileId);
      return buildDataResponse_(true, "Evaluator sheet exists", { url: entry.url, fileId: entry.fileId });
    } catch (gone) { /* נמחק — ניצור חדש */ }
  }

  var newSs = SpreadsheetApp.create("שיט מעריך — " + (name || uid));
  try { DriveApp.getFileById(newSs.getId()).moveTo(evaluatorFolder_()); } catch (moveErr) {}

  var first = newSs.getSheets()[0];
  first.setName("אודות");
  first.getRange(1, 1).setValue("קובץ שיט אישי — " + (name || uid));
  first.getRange(2, 1).setValue("טאב לכל מועמד שהערכת ייווצר אוטומטית עם הסנכרון.");
  first.getRange(1, 1, 2, 1).setFontWeight("bold");

  var reg = getEvalRegistrySheet_(ss);
  reg.appendRow([uid, name, String(payload.team || ""), newSs.getId(), newSs.getUrl(),
                 Utilities.formatDate(new Date(), TIMEZONE, TIMESTAMP_FORMAT)]);

  return buildDataResponse_(true, "Evaluator sheet created", { url: newSs.getUrl(), fileId: newSs.getId() });
}

function getEvalRegistrySheet_(ss) {
  var sheet = getOrCreateSheet_(ss, EVAL_REGISTRY_TAB);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(EVAL_REGISTRY_HEADERS);
    sheet.getRange(1, 1, 1, EVAL_REGISTRY_HEADERS.length)
         .setFontWeight("bold").setBackground("#9333ea").setFontColor("white");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findEvaluatorEntry_(ss, uid, name) {
  var sheet = ss.getSheetByName(EVAL_REGISTRY_TAB);
  if (!sheet || sheet.getLastRow() < 2) return null;
  var vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  var found = null;
  for (var i = 0; i < vals.length; i++) {
    var rowUid  = String(vals[i][0] || "").trim();
    var rowName = String(vals[i][1] || "").trim();
    var matches = (uid && rowUid && rowUid === uid) || (!uid && name && rowName === name) ||
                  (uid && !rowUid && name && rowName === name);
    if (matches) found = { fileId: String(vals[i][3] || ""), url: String(vals[i][4] || "") };
  }
  return found;
}

function mirrorToEvaluatorFile_(ss, payload, fn) {
  try {
    var uid  = String(payload.evaluator_uid || "").trim();
    var name = String(payload.evaluator_name || "").trim();
    if (!uid && !name) return;
    var entry = findEvaluatorEntry_(ss, uid, name);
    if (!entry || !entry.fileId) return;
    fn(SpreadsheetApp.openById(entry.fileId));
  } catch (err) { /* best-effort */ }
}

// ---------- Generic helpers ----------
function ensureHeaders_(sheet, headers, bg) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length)
         .setFontWeight("bold").setBackground(bg).setFontColor("white");
    sheet.setFrozenRows(1);
    return;
  }
  var existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var mismatch = false;
  for (var i = 0; i < headers.length; i++) {
    if (String(existing[i] || "") !== String(headers[i])) { mismatch = true; break; }
  }
  if (mismatch) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function scoreVal_(v) {
  return (v !== undefined && v !== "" && v !== null) ? Number(v) : "";
}

function notesToCell_(comments) {
  return String(comments || "").split("|")
    .map(function (s) { return s.trim(); })
    .filter(Boolean).join("; ");
}

function participantId_(payload) {
  if (payload.id !== undefined && String(payload.id).trim() !== "") {
    var n = parseInt(String(payload.id).replace(/\D+/g, ""), 10);
    return Number.isFinite(n) ? n : 0;
  }
  return pidFromEpc_(payload.epc);
}

function teamId_(payload) {
  var t = (payload.team !== undefined) ? payload.team : payload.evaluator_team;
  if (t !== undefined && String(t).trim() !== "") {
    var n = parseInt(String(t).replace(/\D+/g, ""), 10);
    if (Number.isFinite(n)) return n;
  }
  return teamFromEpc_(payload.epc);
}

// תאימות לאחור: EPC סינתטי ישן (TTPPPP)
function pidFromEpc_(epc) {
  var s = String(epc || "");
  if (s.length < 4) return 0;
  var n = parseInt(s.slice(-4), 10);
  return Number.isFinite(n) ? n : 0;
}
function teamFromEpc_(epc) {
  var s = String(epc || "");
  if (s.length < 6) return 0;
  var n = parseInt(s.slice(-6, -4), 10);
  return Number.isFinite(n) ? n : 0;
}

function getOrCreateSheet_(ss, name) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function buildResponse(success, message) {
  return ContentService.createTextOutput(JSON.stringify({ success: success, message: message }))
                       .setMimeType(ContentService.MimeType.JSON);
}

function buildDataResponse_(success, message, data) {
  var out = { success: success, message: message };
  for (var k in data) out[k] = data[k];
  return ContentService.createTextOutput(JSON.stringify(out))
                       .setMimeType(ContentService.MimeType.JSON);
}
