// ============================================================
//  Google Apps Script — RFID Sync
//  טאב לכל תחנה (ת 01..ת NN) + טאב סיכום אחד
// ============================================================

// ---------- Settings ----------
var SHEET_ID       = "1MHJBLY5a7idjjQG783aYYf_lraHXmGmvivIZ1n0pqDE";
var API_SECRET_KEY = "YOUR_SECRET_KEY_HERE";

var TIMESTAMP_FORMAT = "yyyy-MM-dd HH:mm:ss";
var TIMEZONE         = "Asia/Jerusalem";

var STATION_COUNT = 8;           // 01..08
var SUMMARY_TAB   = "סיכום";
var SUMMARY_LEAD_COLS = 2;       // עמודות פתיחה בטאב הסיכום לפני זוגות התחנות: משתתף, צוות

// קבצי שיט אישיים למעריכים
var EVAL_REGISTRY_TAB = "קבצי מעריכים";  // טאב רישום בקובץ הראשי: מעריך -> קובץ
var EVAL_FOLDER_NAME  = "קבצי מעריכים";  // תיקיית Drive לקבצים (נוצרת ליד הקובץ הראשי)
var EVAL_REGISTRY_HEADERS = ["UID", "שם מעריך", "צוות", "File ID", "קישור", "נוצר"];

// מיפוי מזהה תחנה -> שם התחנה (כותרת הטאב בפועל)
var STATION_NAMES = {
  "01": "מילוי שק",
  "02": "ספרינטים",
  "03": "דמקה",
  "04": "אלונקה סוציומטרי",
  "05": "עצבים מברזל",
  "06": "זחילות",
  "07": "תחנה 07",
  "08": "תחנה 08"
};

// כותרות עבור טאב תחנה
// עמודות (1-based): 1 מקום · 2 ID · 3 זמן(ms) · 4 זמן(mm:ss) · 5 סבב ·
//                   6 תאריך · 7 תחנה · 8 מעריך · 9 צוות מעריך · 10 הערות · 11 ציון
var STATION_HEADERS = [
  "מקום", "ID", "זמן (ms)", "זמן (mm:ss)",
  "סבב", "תאריך", "תחנה", "מעריך", "צוות מעריך", "הערות", "ציון"
];
var STATION_COL = {
  PLACE: 1, ID: 2, MS: 3, MMSS: 4, ROUND: 5, DATE: 6,
  STATION: 7, EVAL: 8, EVAL_TEAM: 9, COMMENTS: 10, SCORE: 11
};

// ---------- Router ----------
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);

    var payload = JSON.parse(e.postData.contents || "{}");

    if (API_SECRET_KEY && API_SECRET_KEY !== "YOUR_SECRET_KEY_HERE") {
      if (payload.key !== API_SECRET_KEY) {
        return buildResponse(false, "Unauthorized");
      }
    }

    var ss = SpreadsheetApp.openById(SHEET_ID);

    var type = String(payload.type || "").trim();

    if (type === "general_note") return handleGeneralNote_(ss, payload);
    if (type === "station_score") return handleStationScore_(ss, payload);
    if (type === "ensure_evaluator_sheet") return handleEnsureEvaluatorSheet_(ss, payload);

    // ברירת מחדל — שורת מירוץ (payload.id)
    return handleRaceRow_(ss, payload);

  } catch (err) {
    return buildResponse(false, "Error: " + err.message);
  } finally {
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

function doGet(e) {
  return buildResponse(true, "RFID Sync alive — טאב לתחנה + טאב סיכום");
}

// ---------- Race row handler ----------
function handleRaceRow_(ss, payload) {
  if (!participantId_(payload)) return buildResponse(false, "Missing id");
  var msg = writeRaceRow_(ss, payload);
  mirrorToEvaluatorFile_(ss, payload, function (evalSs) { writeRaceRow_(evalSs, payload); });
  return buildResponse(true, msg);
}

// כותב שורת מירוץ לקובץ נתון (הראשי או קובץ אישי של מעריך)
function writeRaceRow_(ss, payload) {
  var tabName = stationTabName_(payload.station);
  var sheet = getOrCreateSheet_(ss, tabName);
  ensureStationHeaders_(sheet);

  var firstMs = Number(payload.first_ms || 0);
  var id = participantId_(payload);
  var roundNum = Number(payload.round || 0);
  var maxRound = getMaxRoundNumeric_(sheet);

  if (maxRound > 0 && roundNum > 0 && roundNum < maxRound) {
    return "Skipped stale round row";
  }

  var existingRow = findRowByIdRound_(sheet, id, roundNum);
  if (existingRow > 0) {
    updateStationRow_(sheet, existingRow, payload);
    updateSummaryFromRaceRow_(ss, payload);
    return "Updated existing row in " + tabName;
  }

  if (isDuplicateStationRow_(sheet, id, firstMs, roundNum)) {
    return "Skipped duplicate row";
  }

  if (roundNum > maxRound) {
    appendRoundDividerIfNeeded_(sheet, roundNum);
  }

  var totalSec = Math.floor(firstMs / 1000);
  var minutes = Math.floor(totalSec / 60);
  var seconds = totalSec % 60;
  var timeStr = minutes + ":" + ("0" + seconds).slice(-2);

  // סדר העמודות חייב להתאים ל-STATION_HEADERS / STATION_COL
  sheet.appendRow([
    Number(payload.place || 0),
    id,
    firstMs,
    timeStr,
    roundNum,
    Utilities.formatDate(new Date(), TIMEZONE, TIMESTAMP_FORMAT),
    String(payload.station || ""),
    String(payload.evaluator_name || ""),
    String(payload.evaluator_team || ""),
    String(payload.comments || ""),
    "" // ציון — ימולא כשיגיע station_score
  ]);

  updateSummaryFromRaceRow_(ss, payload);
  return "Written 1 row to " + tabName;
}

// ---------- Station score handler ----------
function handleStationScore_(ss, payload) {
  var pid = parseInt(payload.participant_id, 10);
  var score = Number(payload.score || 0);
  if (!pid || !score) return buildResponse(false, "Missing pid/score");
  var msg = writeStationScore_(ss, payload);
  mirrorToEvaluatorFile_(ss, payload, function (evalSs) { writeStationScore_(evalSs, payload); });
  return buildResponse(true, msg);
}

// כותב ציון תחנה לקובץ נתון (הראשי או קובץ אישי של מעריך)
function writeStationScore_(ss, payload) {
  var pid = parseInt(payload.participant_id, 10);
  var score = Number(payload.score || 0);
  var tabName = stationTabName_(payload.station);
  var sheet = getOrCreateSheet_(ss, tabName);
  ensureStationHeaders_(sheet);

  // עדכן את עמודת הציון עבור כל שורה ששייכת למשתתף (התאמה ישירה לפי ה-ID)
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var vals = sheet.getRange(2, STATION_COL.ID, lastRow - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      var rowId = String(vals[i][0] || "").trim();
      if (rowId !== "" && Number(rowId) === pid) {
        sheet.getRange(2 + i, STATION_COL.SCORE).setValue(score);
      }
    }
  }

  updateSummaryScore_(ss, pid, payload.team_id, payload.station, score);
  return "Score " + score + " recorded for pid " + pid + " on " + tabName;
}

// ---------- General note handler ----------
function handleGeneralNote_(ss, payload) {
  var pid = parseInt(payload.participant_id, 10);
  var note = String(payload.note || "");
  if (!pid || !note) return buildResponse(false, "Missing pid/note");
  var msg = writeGeneralNote_(ss, payload);
  mirrorToEvaluatorFile_(ss, payload, function (evalSs) { writeGeneralNote_(evalSs, payload); });
  return buildResponse(true, msg);
}

// כותב הערה כללית לקובץ נתון (הראשי או קובץ אישי של מעריך)
function writeGeneralNote_(ss, payload) {
  var pid = parseInt(payload.participant_id, 10);
  var team = payload.team_id;
  var note = String(payload.note || "");

  var sheet = getOrCreateSheet_(ss, SUMMARY_TAB);
  ensureSummaryHeaders_(sheet);
  var row = findOrCreateSummaryRow_(sheet, pid, team);
  var hdr = buildSummaryHeaders_();
  var notesCol = hdr.length; // עמודת הערות כלליות — האחרונה
  var existing = String(sheet.getRange(row, notesCol).getValue() || "");
  var parts = existing ? existing.split("|").map(function(s){ return s.trim(); }) : [];
  if (parts.indexOf(note) === -1) {
    parts.push(note);
    sheet.getRange(row, notesCol).setValue(parts.join(" | "));
  }
  return "Note recorded for pid " + pid;
}

// ---------- Evaluator sheet files ----------
// יוצר (אם צריך) קובץ Google Sheets אישי למעריך ורושם אותו בטאב הרישום.
// idempotent — קריאה חוזרת עם אותו uid/name מחזירה את הקובץ הקיים.
function handleEnsureEvaluatorSheet_(ss, payload) {
  var uid  = String(payload.uid || "").trim();
  var name = String(payload.name || "").trim();
  if (!uid && !name) return buildResponse(false, "Missing uid/name");

  var entry = findEvaluatorEntry_(ss, uid, name);
  if (entry && entry.fileId) {
    try {
      DriveApp.getFileById(entry.fileId); // הקובץ עדיין קיים?
      return buildDataResponse_(true, "Evaluator sheet exists", { url: entry.url, fileId: entry.fileId });
    } catch (gone) { /* הקובץ נמחק מה-Drive — ניצור חדש */ }
  }

  var title = "שיט מעריך — " + (name || uid);
  var newSs = SpreadsheetApp.create(title);
  try {
    var file = DriveApp.getFileById(newSs.getId());
    var folder = evaluatorFolder_();
    file.moveTo(folder);
  } catch (moveErr) { /* אם ההעברה נכשלה הקובץ נשאר ב-My Drive */ }

  // גיליון פתיחה במקום ה-Sheet1 הריק
  var first = newSs.getSheets()[0];
  first.setName("אודות");
  first.getRange(1, 1).setValue("קובץ שיט אישי — " + (name || uid));
  first.getRange(2, 1).setValue("טאבים לתחנות ולסיכום ייווצרו אוטומטית עם סנכרון הנתונים הראשון.");
  first.getRange(1, 1, 2, 1).setFontWeight("bold");

  var reg = getEvalRegistrySheet_(ss);
  reg.appendRow([
    uid, name, String(payload.team || ""),
    newSs.getId(), newSs.getUrl(),
    Utilities.formatDate(new Date(), TIMEZONE, TIMESTAMP_FORMAT)
  ]);

  return buildDataResponse_(true, "Evaluator sheet created", { url: newSs.getUrl(), fileId: newSs.getId() });
}

// תיקיית Drive לקבצי המעריכים — לצד הקובץ הראשי (או ב-root כברירת מחדל)
function evaluatorFolder_() {
  var parent;
  try {
    var parents = DriveApp.getFileById(SHEET_ID).getParents();
    parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  } catch (e) {
    parent = DriveApp.getRootFolder();
  }
  var it = parent.getFoldersByName(EVAL_FOLDER_NAME);
  return it.hasNext() ? it.next() : parent.createFolder(EVAL_FOLDER_NAME);
}

function getEvalRegistrySheet_(ss) {
  var sheet = getOrCreateSheet_(ss, EVAL_REGISTRY_TAB);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(EVAL_REGISTRY_HEADERS);
    sheet.getRange(1, 1, 1, EVAL_REGISTRY_HEADERS.length)
         .setFontWeight("bold")
         .setBackground("#9333ea")
         .setFontColor("white");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// מחפש מעריך ברישום לפי UID (עדיפות) או שם. השורה האחרונה שנמצאה קובעת.
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
    if (matches) {
      found = { fileId: String(vals[i][3] || ""), url: String(vals[i][4] || "") };
    }
  }
  return found;
}

// מריץ פעולת כתיבה גם על הקובץ האישי של המעריך, אם רשום לו קובץ.
// כשל בשיקוף לא מפיל את הכתיבה לקובץ הראשי.
function mirrorToEvaluatorFile_(ss, payload, fn) {
  try {
    var uid  = String(payload.evaluator_uid || "").trim();
    var name = String(payload.evaluator_name || "").trim();
    if (!uid && !name) return;
    var entry = findEvaluatorEntry_(ss, uid, name);
    if (!entry || !entry.fileId) return;
    fn(SpreadsheetApp.openById(entry.fileId));
  } catch (err) { /* mirror best-effort */ }
}

// ---------- Summary helpers ----------
// עמודות פתיחה: משתתף (1), צוות (2). אחריהן זוגות "מקום/ציון" לכל תחנה.
function buildSummaryHeaders_() {
  var hdr = ["משתתף", "צוות"];
  for (var i = 1; i <= STATION_COUNT; i++) {
    var key = ("0" + i).slice(-2);
    var lbl = STATION_NAMES[key] || ("תחנה " + key);
    hdr.push("מקום " + lbl);
    hdr.push("ציון " + lbl);
  }
  hdr.push("ממוצע מקום");
  hdr.push("ממוצע ציון");
  hdr.push("הערות כלליות");
  return hdr;
}

function ensureSummaryHeaders_(sheet) {
  var hdr = buildSummaryHeaders_();
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(hdr);
    sheet.getRange(1, 1, 1, hdr.length)
         .setFontWeight("bold")
         .setBackground("#34a853")
         .setFontColor("white");
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(2);
    return;
  }
  var existing = sheet.getRange(1, 1, 1, hdr.length).getValues()[0];
  var mismatch = false;
  for (var i = 0; i < hdr.length; i++) {
    if (String(existing[i] || "") !== String(hdr[i])) { mismatch = true; break; }
  }
  if (mismatch) {
    sheet.getRange(1, 1, 1, hdr.length).setValues([hdr]);
  }
}

function findOrCreateSummaryRow_(sheet, pid, team) {
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var vals = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (Number(vals[i][0] || 0) === pid) return 2 + i;
    }
  }
  var hdr = buildSummaryHeaders_();
  var row = [];
  for (var j = 0; j < hdr.length; j++) row.push("");
  row[0] = pid;
  row[1] = team || "";
  sheet.appendRow(row);
  return sheet.getLastRow();
}

function summaryStationIndex_(station) {
  var s = String(station || "").trim();
  var m = s.match(/(\d+)/);
  if (!m) return 0;
  var n = parseInt(m[1], 10);
  if (!n || n < 1 || n > STATION_COUNT) return 0;
  return n;
}

function updateSummaryFromRaceRow_(ss, payload) {
  var pid = participantId_(payload);
  if (!pid) return;
  var team = teamId_(payload) || "";
  var place = Number(payload.place || 0);
  var stIdx = summaryStationIndex_(payload.station);
  if (!stIdx) return;

  var sheet = getOrCreateSheet_(ss, SUMMARY_TAB);
  ensureSummaryHeaders_(sheet);
  var row = findOrCreateSummaryRow_(sheet, pid, team);

  if (place > 0) {
    var placeCol = SUMMARY_LEAD_COLS + (stIdx - 1) * 2 + 1; // col index 1-based
    sheet.getRange(row, placeCol).setValue(place);
    recomputeSummaryAverages_(sheet, row);
  }
}

function updateSummaryScore_(ss, pid, team, station, score) {
  var stIdx = summaryStationIndex_(station);
  if (!stIdx) return;
  var sheet = getOrCreateSheet_(ss, SUMMARY_TAB);
  ensureSummaryHeaders_(sheet);
  var row = findOrCreateSummaryRow_(sheet, pid, team);
  var scoreCol = SUMMARY_LEAD_COLS + (stIdx - 1) * 2 + 2;
  sheet.getRange(row, scoreCol).setValue(score);
  recomputeSummaryAverages_(sheet, row);
}

function recomputeSummaryAverages_(sheet, row) {
  var hdr = buildSummaryHeaders_();
  var vals = sheet.getRange(row, 1, 1, hdr.length).getValues()[0];
  var placeSum = 0, placeCnt = 0, scoreSum = 0, scoreCnt = 0;
  for (var i = 1; i <= STATION_COUNT; i++) {
    var pIdx = SUMMARY_LEAD_COLS + (i - 1) * 2 + 1 - 1; // 0-based array index
    var sIdx = SUMMARY_LEAD_COLS + (i - 1) * 2 + 2 - 1;
    var p = Number(vals[pIdx] || 0);
    var s = Number(vals[sIdx] || 0);
    if (p > 0) { placeSum += p; placeCnt++; }
    if (s > 0) { scoreSum += s; scoreCnt++; }
  }
  var avgPlaceCol = SUMMARY_LEAD_COLS + STATION_COUNT * 2 + 1;
  var avgScoreCol = avgPlaceCol + 1;
  sheet.getRange(row, avgPlaceCol).setValue(placeCnt ? Number((placeSum / placeCnt).toFixed(2)) : "");
  sheet.getRange(row, avgScoreCol).setValue(scoreCnt ? Number((scoreSum / scoreCnt).toFixed(2)) : "");
}

// ---------- Station tab helpers ----------
function ensureStationHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(STATION_HEADERS);
    sheet.getRange(1, 1, 1, STATION_HEADERS.length)
         .setFontWeight("bold")
         .setBackground("#4a86e8")
         .setFontColor("white");
    sheet.setFrozenRows(1);
    return;
  }
  var existing = sheet.getRange(1, 1, 1, STATION_HEADERS.length).getValues()[0];
  var mismatch = false;
  for (var i = 0; i < STATION_HEADERS.length; i++) {
    if (String(existing[i] || "") !== STATION_HEADERS[i]) { mismatch = true; break; }
  }
  if (mismatch) {
    sheet.getRange(1, 1, 1, STATION_HEADERS.length).setValues([STATION_HEADERS]);
  }
}

function findRowByIdRound_(sheet, id, round) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;
  var lookback = 1200;
  var startRow = Math.max(2, lastRow - lookback + 1);
  var rowCount = lastRow - startRow + 1;
  if (rowCount <= 0) return -1;
  // קורא מעמודת ID עד עמודת סבב (כולל)
  var width = STATION_COL.ROUND - STATION_COL.ID + 1;
  var vals = sheet.getRange(startRow, STATION_COL.ID, rowCount, width).getValues();
  var roundIdx = STATION_COL.ROUND - STATION_COL.ID; // 0-based בתוך הטווח
  for (var i = vals.length - 1; i >= 0; i--) {
    var rowId = String(vals[i][0] || "").trim();
    var rowRound = Number(vals[i][roundIdx] || 0);
    if (rowId !== "" && Number(rowId) === Number(id) && rowRound === round) return startRow + i;
  }
  return -1;
}

function updateStationRow_(sheet, rowIndex, payload) {
  var oldVals = sheet.getRange(rowIndex, 1, 1, STATION_HEADERS.length).getValues()[0];
  var oldPlace = Number(oldVals[STATION_COL.PLACE - 1] || 0);
  var oldFirst = Number(oldVals[STATION_COL.MS - 1] || 0);
  var oldScore = oldVals[STATION_COL.SCORE - 1];

  var newPlace = Number(payload.place || 0);
  var newFirst = Number(payload.first_ms || 0);
  var roundNum = Number(payload.round || 0);

  var bestFirst = oldFirst;
  if (bestFirst <= 0 || (newFirst > 0 && newFirst < bestFirst)) bestFirst = newFirst;
  var totalSec = Math.floor(bestFirst / 1000);
  var minutes = Math.floor(totalSec / 60);
  var seconds = totalSec % 60;
  var timeStr = minutes + ":" + ("0" + seconds).slice(-2);

  var place = (newPlace > 0) ? newPlace : oldPlace;
  var id    = participantId_(payload) || String(oldVals[STATION_COL.ID - 1] || "");

  var station       = String(payload.station || oldVals[STATION_COL.STATION - 1] || "");
  var evaluatorName = String(payload.evaluator_name || oldVals[STATION_COL.EVAL - 1] || "");
  var evaluatorTeam = String(payload.evaluator_team || oldVals[STATION_COL.EVAL_TEAM - 1] || "");

  var oldComments = String(oldVals[STATION_COL.COMMENTS - 1] || "");
  var newComments = String(payload.comments || "");
  var merged = oldComments;
  if (newComments) {
    var oldArr = oldComments ? oldComments.split("|").map(function(s){ return s.trim(); }) : [];
    var newArr = newComments.split("|").map(function(s){ return s.trim(); });
    newArr.forEach(function(tag) {
      if (tag && oldArr.indexOf(tag) === -1) oldArr.push(tag);
    });
    merged = oldArr.join("|");
  }

  // סדר העמודות חייב להתאים ל-STATION_HEADERS / STATION_COL
  sheet.getRange(rowIndex, 1, 1, STATION_HEADERS.length).setValues([[
    place,
    id,
    bestFirst,
    timeStr,
    roundNum,
    Utilities.formatDate(new Date(), TIMEZONE, TIMESTAMP_FORMAT),
    station,
    evaluatorName,
    evaluatorTeam,
    merged,
    oldScore
  ]]);
}

function isDuplicateStationRow_(sheet, id, firstMs, round) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;
  var lookback = 400;
  var startRow = Math.max(2, lastRow - lookback + 1);
  var rowCount = lastRow - startRow + 1;
  if (rowCount <= 0) return false;
  var values = sheet.getRange(startRow, 1, rowCount, STATION_COL.ROUND).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var row = values[i];
    var rowId = String(row[STATION_COL.ID - 1] || "").trim();
    var rowFirstMs = Number(row[STATION_COL.MS - 1] || 0);
    var rowRound = Number(row[STATION_COL.ROUND - 1] || 0);
    if (rowId !== "" && Number(rowId) === Number(id) && rowFirstMs === firstMs && rowRound === round) return true;
  }
  return false;
}

function appendRoundDividerIfNeeded_(sheet, round) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var lastRound = sheet.getRange(lastRow, STATION_COL.ROUND).getValue();
  if (String(lastRound) !== String(round)) {
    var divider = ["--- סבב " + round + " ---"];
    for (var c = 1; c < STATION_HEADERS.length; c++) divider.push("");
    sheet.appendRow(divider);
    sheet.getRange(sheet.getLastRow(), 1, 1, STATION_HEADERS.length)
         .setBackground("#d9ead3")
         .setFontWeight("bold");
  }
}

function getMaxRoundNumeric_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;
  var vals = sheet.getRange(2, STATION_COL.ROUND, lastRow - 1, 1).getValues();
  var maxRound = 0;
  for (var i = 0; i < vals.length; i++) {
    var n = Number(vals[i][0] || 0);
    if (n > maxRound) maxRound = n;
  }
  return maxRound;
}

// ---------- Generic helpers ----------
function stationIdKey_(station) {
  var s = String(station || "").trim();
  var m = s.match(/(\d+)/);
  var n = m ? parseInt(m[1], 10) : 0;
  if (!n || n < 1) n = 1;
  return ("0" + n).slice(-2);
}

function stationTabName_(station) {
  var key = stationIdKey_(station);
  return STATION_NAMES[key] || ("תחנה " + key);
}

// מזהה משתתף מתוך ה-payload. מעדיף payload.id; נופל חזרה ל-EPC לתאימות לאחור.
function participantId_(payload) {
  if (payload.id !== undefined && String(payload.id).trim() !== "") {
    var n = parseInt(String(payload.id).replace(/\D+/g, ""), 10);
    return Number.isFinite(n) ? n : 0;
  }
  return pidFromEpc_(payload.epc);
}

// מספר צוות מתוך ה-payload. מעדיף payload.team / evaluator_team; נופל חזרה ל-EPC.
function teamId_(payload) {
  var t = (payload.team !== undefined) ? payload.team : payload.evaluator_team;
  if (t !== undefined && String(t).trim() !== "") {
    var n = parseInt(String(t).replace(/\D+/g, ""), 10);
    if (Number.isFinite(n)) return n;
  }
  return teamFromEpc_(payload.epc);
}

// --- תאימות לאחור: חילוץ מ-EPC סינתטי ישן (TTPPPP) אם עדיין נשלח ---
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
