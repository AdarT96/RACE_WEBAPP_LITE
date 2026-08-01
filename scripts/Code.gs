// ============================================================
//  Google Apps Script — סנכרון גיבוש (גרסת LITE)
//  טאב לכל סוג תחנה + טאב סיכום, וקבצי שיט אישיים למעריכים.
//  ציון 1–7 לכל פרמטר · הערות · מקום/מספר חזרות לפי סוג התחנה.
// ============================================================

// ---------- Settings ----------
var SHEET_ID       = "1MHJBLY5a7idjjQG783aYYf_lraHXmGmvivIZ1n0pqDE";
var API_SECRET_KEY = "YOUR_SECRET_KEY_HERE";

var TIMESTAMP_FORMAT = "yyyy-MM-dd HH:mm:ss";
var TIMEZONE         = "Asia/Jerusalem";

var SUMMARY_TAB          = "סיכום";
var GENERAL_NOTES_HEADER = "הערות כלליות";

// קבצי שיט אישיים למעריכים
var EVAL_REGISTRY_TAB = "קבצי מעריכים";
var EVAL_FOLDER_NAME  = "קבצי מעריכים";
var EVAL_REGISTRY_HEADERS = ["UID", "שם מעריך", "צוות", "File ID", "קישור", "נוצר"];

// ---------- סוגי תחנות (מסונכרן עם frontend/js/station-types.js) ----------
// measure: "place" (סדר הגעה) | "reps" (מספר חזרות/ברגים/שלב) | "none"
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
  return buildResponse(true, "Gibush sync alive — טאב לסוג תחנה + סיכום");
}

// ---------- זיהוי סוג התחנה ----------
function resolveType_(payload) {
  var id = String(payload.station_type || "").trim();
  if (id && STATION_TYPES[id]) return { id: id, def: STATION_TYPES[id] };

  var name = String(payload.station_name || "").trim();
  if (name) {
    for (var k in STATION_TYPES) if (STATION_TYPES[k].name === name) return { id: k, def: STATION_TYPES[k] };
  }
  var n = parseInt(String(payload.station || "").replace(/\D+/g, ""), 10);
  if (n >= 1 && STATION_ORDER[n - 1]) {
    var kk = STATION_ORDER[n - 1];
    return { id: kk, def: STATION_TYPES[kk] };
  }
  return null;
}

// ---------- טאב תחנה: כותרות דינמיות לפי סוג ----------
function stationHeaders_(def) {
  var h = ["ID", "סבב", "תאריך", "מעריך", "צוות"];
  if (def.measure === "place") { h.push("מקום"); h.push("זמן"); }
  else if (def.measure === "reps") { h.push(def.measureLabel || "מספר חזרות"); }
  for (var i = 0; i < def.params.length; i++) h.push("ציון: " + def.params[i]);
  h.push("הערות");
  return h;
}

// ---------- Race row handler ----------
function handleRaceRow_(ss, payload) {
  if (!participantId_(payload)) return buildResponse(false, "Missing id");
  var t = resolveType_(payload);
  if (!t) return buildResponse(false, "Unknown station");

  writeRaceRow_(ss, payload, t);
  mirrorToEvaluatorFile_(ss, payload, function (evalSs) { writeRaceRow_(evalSs, payload, t); });
  return buildResponse(true, "OK: " + t.def.name);
}

// כותב שורת הערכה (שורה לכל משתתף/סבב/מעריך) + מעדכן את הסיכום
function writeRaceRow_(ss, payload, t) {
  var def     = t.def;
  var sheet   = getOrCreateSheet_(ss, def.name);
  var headers = stationHeaders_(def);
  ensureHeaders_(sheet, headers, "#4a86e8");
  var col = headerIndex_(headers);

  var id       = participantId_(payload);
  var round    = Number(payload.round || 0);
  var evalName = String(payload.evaluator_name || "");

  var vals = new Array(headers.length);
  for (var i = 0; i < vals.length; i++) vals[i] = "";
  vals[col["ID"] - 1]    = id;
  vals[col["סבב"] - 1]   = round;
  vals[col["תאריך"] - 1] = Utilities.formatDate(new Date(), TIMEZONE, TIMESTAMP_FORMAT);
  vals[col["מעריך"] - 1] = evalName;
  vals[col["צוות"] - 1]  = String(payload.team || payload.evaluator_team || "");

  if (def.measure === "place") {
    if (payload.place !== undefined && payload.place !== "" && payload.place !== null)
      vals[col["מקום"] - 1] = Number(payload.place) || "";
    var ms = Number(payload.first_ms || 0);
    vals[col["זמן"] - 1] = ms > 0 ? msToClock_(ms) : "";
  } else if (def.measure === "reps") {
    var lbl = def.measureLabel || "מספר חזרות";
    if (payload.reps !== undefined && payload.reps !== "" && payload.reps !== null)
      vals[col[lbl] - 1] = Number(payload.reps);
  }

  var scores = payload.scores || {};
  for (var p = 0; p < def.params.length; p++) {
    var pn = def.params[p];
    var sc = scores[pn];
    vals[col["ציון: " + pn] - 1] = (sc !== undefined && sc !== "" && sc !== null) ? Number(sc) : "";
  }
  vals[col["הערות"] - 1] = cleanNotes_(payload.comments);

  var rowIndex = findRaceRow_(sheet, col, id, round, evalName);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([vals]);
  else sheet.appendRow(vals);

  updateSummary_(ss, payload, t);
}

function findRaceRow_(sheet, col, id, round, evalName) {
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var width = sheet.getLastColumn();
  var vals = sheet.getRange(2, 1, last - 1, width).getValues();
  var idC = col["ID"] - 1, rC = col["סבב"] - 1, eC = col["מעריך"] - 1;
  for (var i = vals.length - 1; i >= 0; i--) {
    if (Number(vals[i][idC]) === Number(id) &&
        Number(vals[i][rC]) === Number(round) &&
        String(vals[i][eC] || "") === String(evalName)) {
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

  writeGeneralNote_(ss, payload);
  mirrorToEvaluatorFile_(ss, payload, function (evalSs) { writeGeneralNote_(evalSs, payload); });
  return buildResponse(true, "Note recorded for pid " + pid);
}

function writeGeneralNote_(ss, payload) {
  var pid  = parseInt(payload.participant_id, 10);
  var team = payload.team_id;
  var note = String(payload.note || "");

  var sheet   = getOrCreateSheet_(ss, SUMMARY_TAB);
  var headers = summaryHeaders_();
  ensureHeaders_(sheet, headers, "#34a853");
  sheet.setFrozenColumns(2);
  var col = headerIndex_(headers);
  var row = findOrCreateSummaryRow_(sheet, headers, pid, team);

  var c   = col[GENERAL_NOTES_HEADER];
  var cur = String(sheet.getRange(row, c).getValue() || "");
  var parts = cur ? cur.split(" | ").map(function (s) { return s.trim(); }) : [];
  if (parts.indexOf(note) === -1) {
    parts.push(note);
    sheet.getRange(row, c).setValue(parts.join(" | "));
  }
}

// ---------- טאב סיכום (רחב, כל ההערכות — בלי ממוצע) ----------
function summaryHeaders_() {
  var h = ["משתתף", "צוות"];
  for (var i = 0; i < STATION_ORDER.length; i++) {
    var def = STATION_TYPES[STATION_ORDER[i]];
    if (def.measure === "place") h.push("מקום — " + def.name);
    else if (def.measure === "reps") h.push((def.measureLabel || "מספר חזרות") + " — " + def.name);
    for (var p = 0; p < def.params.length; p++) h.push("ציון — " + def.name + " · " + def.params[p]);
    h.push("הערות — " + def.name);
  }
  h.push(GENERAL_NOTES_HEADER);
  return h;
}

function updateSummary_(ss, payload, t) {
  var def = t.def;
  var sheet   = getOrCreateSheet_(ss, SUMMARY_TAB);
  var headers = summaryHeaders_();
  ensureHeaders_(sheet, headers, "#34a853");
  sheet.setFrozenColumns(2);
  var col = headerIndex_(headers);

  var id   = participantId_(payload);
  var team = teamId_(payload) || "";
  if (!id) return;
  var row      = findOrCreateSummaryRow_(sheet, headers, id, team);
  var evalName = String(payload.evaluator_name || "");

  // מקום / מספר חזרות — אובייקטיבי (זהה לכל המעריכים)
  if (def.measure === "place") {
    if (payload.place !== undefined && payload.place !== "" && payload.place !== null)
      sheet.getRange(row, col["מקום — " + def.name]).setValue(Number(payload.place) || "");
  } else if (def.measure === "reps") {
    var lbl = (def.measureLabel || "מספר חזרות") + " — " + def.name;
    if (payload.reps !== undefined && payload.reps !== "" && payload.reps !== null)
      sheet.getRange(row, col[lbl]).setValue(Number(payload.reps));
  }

  // ציונים — מיוחסים למעריך (כל ההערכות, בלי ממוצע; דריסה של אותו מעריך בלבד)
  var scores = payload.scores || {};
  for (var p = 0; p < def.params.length; p++) {
    var pn = def.params[p];
    var c  = col["ציון — " + def.name + " · " + pn];
    var sc = scores[pn];
    upsertAttributed_(sheet, row, c, evalName, (sc !== undefined && sc !== "" && sc !== null) ? String(sc) : "");
  }

  // הערות התחנה — מיוחסות למעריך
  var notes = cleanNotes_(payload.comments).split(" | ").filter(Boolean).join("; ");
  upsertAttributed_(sheet, row, col["הערות — " + def.name], evalName, notes);
}

function findOrCreateSummaryRow_(sheet, headers, pid, team) {
  var last = sheet.getLastRow();
  if (last >= 2) {
    var vals = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) if (Number(vals[i][0] || 0) === Number(pid)) return 2 + i;
  }
  var row = new Array(headers.length);
  for (var j = 0; j < row.length; j++) row[j] = "";
  row[0] = Number(pid);
  row[1] = team || "";
  sheet.appendRow(row);
  return sheet.getLastRow();
}

// כותב לתא ערך מיוחס למעריך: "יוסי: 5 | דנה: 6". דריסה של אותו מעריך = idempotent.
function upsertAttributed_(sheet, row, colIndex, name, value) {
  var cur = String(sheet.getRange(row, colIndex).getValue() || "");
  var entries = cur ? cur.split(" | ") : [];
  var order = [], map = {};
  entries.forEach(function (e) {
    var idx = e.indexOf(": ");
    var n = idx > 0 ? e.slice(0, idx) : "_";
    var v = idx > 0 ? e.slice(idx + 2) : e;
    if (!(n in map)) order.push(n);
    map[n] = v;
  });
  var key = name || "_";
  if (value) { if (!(key in map)) order.push(key); map[key] = value; }
  else { delete map[key]; order = order.filter(function (n) { return n !== key; }); }

  var out = order
    .filter(function (n) { return map[n] != null && map[n] !== ""; })
    .map(function (n) { return n === "_" ? map[n] : (n + ": " + map[n]); })
    .join(" | ");
  sheet.getRange(row, colIndex).setValue(out);
}

// ---------- Evaluator sheet files ----------
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

  var title = "שיט מעריך — " + (name || uid);
  var newSs = SpreadsheetApp.create(title);
  try {
    var file = DriveApp.getFileById(newSs.getId());
    file.moveTo(evaluatorFolder_());
  } catch (moveErr) { /* נשאר ב-My Drive */ }

  var first = newSs.getSheets()[0];
  first.setName("אודות");
  first.getRange(1, 1).setValue("קובץ שיט אישי — " + (name || uid));
  first.getRange(2, 1).setValue("טאב סיכום וטאבים לתחנות ייווצרו אוטומטית עם הסנכרון הראשון.");
  first.getRange(1, 1, 2, 1).setFontWeight("bold");

  var reg = getEvalRegistrySheet_(ss);
  reg.appendRow([
    uid, name, String(payload.team || ""),
    newSs.getId(), newSs.getUrl(),
    Utilities.formatDate(new Date(), TIMEZONE, TIMESTAMP_FORMAT)
  ]);

  return buildDataResponse_(true, "Evaluator sheet created", { url: newSs.getUrl(), fileId: newSs.getId() });
}

function evaluatorFolder_() {
  var parent;
  try {
    var parents = DriveApp.getFileById(SHEET_ID).getParents();
    parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  } catch (e) { parent = DriveApp.getRootFolder(); }
  var it = parent.getFoldersByName(EVAL_FOLDER_NAME);
  return it.hasNext() ? it.next() : parent.createFolder(EVAL_FOLDER_NAME);
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
function headerIndex_(headers) {
  var m = {};
  for (var i = 0; i < headers.length; i++) m[headers[i]] = i + 1;
  return m;
}

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

function cleanNotes_(comments) {
  return String(comments || "").split("|")
    .map(function (s) { return s.trim(); })
    .filter(Boolean).join(" | ");
}

function msToClock_(ms) {
  var s = Math.floor(ms / 1000);
  var m = Math.floor(s / 60);
  var sec = s % 60;
  return m + ":" + ("0" + sec).slice(-2);
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
