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
var STATION_HEADERS = [
  "מקום", "EPC", "זמן (ms)", "זמן (mm:ss)", "אנטנה", "RSSI",
  "סבב", "תאריך", "תחנה", "מעריך", "צוות מעריך", "הערות", "ציון"
];

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

    // ברירת מחדל — שורת מירוץ (payload.epc)
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
  if (!payload.epc) return buildResponse(false, "Missing epc");

  var tabName = stationTabName_(payload.station);
  var sheet = getOrCreateSheet_(ss, tabName);
  ensureStationHeaders_(sheet);

  var firstMs = Number(payload.first_ms || 0);
  var epc = String(payload.epc || "");
  var roundNum = Number(payload.round || 0);
  var maxRound = getMaxRoundNumeric_(sheet);

  if (maxRound > 0 && roundNum > 0 && roundNum < maxRound) {
    return buildResponse(true, "Skipped stale round row");
  }

  var existingRow = findRowByEpcRound_(sheet, epc, roundNum);
  if (existingRow > 0) {
    updateStationRow_(sheet, existingRow, payload);
    updateSummaryFromRaceRow_(ss, payload);
    return buildResponse(true, "Updated existing row in " + tabName);
  }

  if (isDuplicateStationRow_(sheet, epc, firstMs, roundNum)) {
    return buildResponse(true, "Skipped duplicate row");
  }

  if (roundNum > maxRound) {
    appendRoundDividerIfNeeded_(sheet, roundNum);
  }

  var totalSec = Math.floor(firstMs / 1000);
  var minutes = Math.floor(totalSec / 60);
  var seconds = totalSec % 60;
  var timeStr = minutes + ":" + ("0" + seconds).slice(-2);

  sheet.appendRow([
    Number(payload.place || 0),
    epc,
    firstMs,
    timeStr,
    Number(payload.antenna || 0),
    Number(payload.rssi || 0),
    roundNum,
    Utilities.formatDate(new Date(), TIMEZONE, TIMESTAMP_FORMAT),
    String(payload.station || ""),
    String(payload.evaluator_name || ""),
    String(payload.evaluator_team || ""),
    String(payload.comments || ""),
    "" // ציון — ימולא כשיגיע station_score
  ]);

  updateSummaryFromRaceRow_(ss, payload);
  return buildResponse(true, "Written 1 row to " + tabName);
}

// ---------- Station score handler ----------
function handleStationScore_(ss, payload) {
  var pid = parseInt(payload.participant_id, 10);
  var score = Number(payload.score || 0);
  if (!pid || !score) return buildResponse(false, "Missing pid/score");

  var tabName = stationTabName_(payload.station);
  var sheet = getOrCreateSheet_(ss, tabName);
  ensureStationHeaders_(sheet);

  // עדכן ציון בעמודה 13 עבור כל שורה ששייכת למשתתף (לפי 4 ספרות אחרונות של EPC)
  var pidSuffix = ("000" + pid).slice(-4);
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var vals = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
    for (var i = 0; i < vals.length; i++) {
      var rowEpc = String(vals[i][0] || "");
      if (rowEpc.length >= 4 && rowEpc.slice(-4) === pidSuffix) {
        sheet.getRange(2 + i, 13).setValue(score);
      }
    }
  }

  updateSummaryScore_(ss, pid, payload.team_id, payload.station, score);
  return buildResponse(true, "Score " + score + " recorded for pid " + pid + " on " + tabName);
}

// ---------- General note handler ----------
function handleGeneralNote_(ss, payload) {
  var pid = parseInt(payload.participant_id, 10);
  var team = payload.team_id;
  var note = String(payload.note || "");
  if (!pid || !note) return buildResponse(false, "Missing pid/note");

  var sheet = getOrCreateSheet_(ss, SUMMARY_TAB);
  ensureSummaryHeaders_(sheet);
  var row = findOrCreateSummaryRow_(sheet, pid, team, "");
  var hdr = buildSummaryHeaders_();
  var notesCol = hdr.length; // עמודת הערות כלליות — האחרונה
  var existing = String(sheet.getRange(row, notesCol).getValue() || "");
  var parts = existing ? existing.split("|").map(function(s){ return s.trim(); }) : [];
  if (parts.indexOf(note) === -1) {
    parts.push(note);
    sheet.getRange(row, notesCol).setValue(parts.join(" | "));
  }
  return buildResponse(true, "Note recorded for pid " + pid);
}

// ---------- Summary helpers ----------
function buildSummaryHeaders_() {
  var hdr = ["משתתף", "צוות", "EPC"];
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

function findOrCreateSummaryRow_(sheet, pid, team, epc) {
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
  row[2] = epc || "";
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
  var epc = String(payload.epc || "");
  var pid = pidFromEpc_(epc);
  if (!pid) return;
  var team = teamFromEpc_(epc) || "";
  var place = Number(payload.place || 0);
  var stIdx = summaryStationIndex_(payload.station);
  if (!stIdx) return;

  var sheet = getOrCreateSheet_(ss, SUMMARY_TAB);
  ensureSummaryHeaders_(sheet);
  var row = findOrCreateSummaryRow_(sheet, pid, team, epc);

  // עדכן EPC אם היה ריק
  var curEpc = String(sheet.getRange(row, 3).getValue() || "");
  if (!curEpc && epc) sheet.getRange(row, 3).setValue(epc);

  if (place > 0) {
    var placeCol = 3 + (stIdx - 1) * 2 + 1; // col index 1-based
    sheet.getRange(row, placeCol).setValue(place);
    recomputeSummaryAverages_(sheet, row);
  }
}

function updateSummaryScore_(ss, pid, team, station, score) {
  var stIdx = summaryStationIndex_(station);
  if (!stIdx) return;
  var sheet = getOrCreateSheet_(ss, SUMMARY_TAB);
  ensureSummaryHeaders_(sheet);
  var row = findOrCreateSummaryRow_(sheet, pid, team, "");
  var scoreCol = 3 + (stIdx - 1) * 2 + 2;
  sheet.getRange(row, scoreCol).setValue(score);
  recomputeSummaryAverages_(sheet, row);
}

function recomputeSummaryAverages_(sheet, row) {
  var hdr = buildSummaryHeaders_();
  var vals = sheet.getRange(row, 1, 1, hdr.length).getValues()[0];
  var placeSum = 0, placeCnt = 0, scoreSum = 0, scoreCnt = 0;
  for (var i = 1; i <= STATION_COUNT; i++) {
    var pIdx = 3 + (i - 1) * 2 + 1 - 1; // 0-based array index
    var sIdx = 3 + (i - 1) * 2 + 2 - 1;
    var p = Number(vals[pIdx] || 0);
    var s = Number(vals[sIdx] || 0);
    if (p > 0) { placeSum += p; placeCnt++; }
    if (s > 0) { scoreSum += s; scoreCnt++; }
  }
  var avgPlaceCol = 3 + STATION_COUNT * 2 + 1;
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

function findRowByEpcRound_(sheet, epc, round) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;
  var lookback = 1200;
  var startRow = Math.max(2, lastRow - lookback + 1);
  var rowCount = lastRow - startRow + 1;
  if (rowCount <= 0) return -1;
  var vals = sheet.getRange(startRow, 2, rowCount, 6).getValues(); // EPC..סבב
  for (var i = vals.length - 1; i >= 0; i--) {
    var rowEpc = String(vals[i][0] || "");
    var rowRound = Number(vals[i][5] || 0);
    if (rowEpc === epc && rowRound === round) return startRow + i;
  }
  return -1;
}

function updateStationRow_(sheet, rowIndex, payload) {
  var oldVals = sheet.getRange(rowIndex, 1, 1, 13).getValues()[0];
  var oldPlace = Number(oldVals[0] || 0);
  var oldFirst = Number(oldVals[2] || 0);
  var oldAnt   = Number(oldVals[4] || 0);
  var oldRssi  = Number(oldVals[5] || 0);
  var oldScore = oldVals[12];

  var newPlace = Number(payload.place || 0);
  var newFirst = Number(payload.first_ms || 0);
  var newAnt   = Number(payload.antenna || 0);
  var newRssi  = Number(payload.rssi || 0);
  var roundNum = Number(payload.round || 0);

  var bestFirst = oldFirst;
  if (bestFirst <= 0 || (newFirst > 0 && newFirst < bestFirst)) bestFirst = newFirst;
  var totalSec = Math.floor(bestFirst / 1000);
  var minutes = Math.floor(totalSec / 60);
  var seconds = totalSec % 60;
  var timeStr = minutes + ":" + ("0" + seconds).slice(-2);

  var place   = (newPlace > 0) ? newPlace : oldPlace;
  var antenna = (newAnt !== 0) ? newAnt : oldAnt;
  var rssi    = (newRssi !== 0) ? newRssi : oldRssi;

  var station       = String(payload.station || oldVals[8] || "");
  var evaluatorName = String(payload.evaluator_name || oldVals[9] || "");
  var evaluatorTeam = String(payload.evaluator_team || oldVals[10] || "");

  var oldComments = String(oldVals[11] || "");
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

  sheet.getRange(rowIndex, 1, 1, 13).setValues([[
    place,
    String(payload.epc || oldVals[1] || ""),
    bestFirst,
    timeStr,
    antenna,
    rssi,
    roundNum,
    Utilities.formatDate(new Date(), TIMEZONE, TIMESTAMP_FORMAT),
    station,
    evaluatorName,
    evaluatorTeam,
    merged,
    oldScore
  ]]);
}

function isDuplicateStationRow_(sheet, epc, firstMs, round) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false;
  var lookback = 400;
  var startRow = Math.max(2, lastRow - lookback + 1);
  var rowCount = lastRow - startRow + 1;
  if (rowCount <= 0) return false;
  var values = sheet.getRange(startRow, 1, rowCount, 8).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var row = values[i];
    var rowEpc = String(row[1] || "");
    var rowFirstMs = Number(row[2] || 0);
    var rowRound = Number(row[6] || 0);
    if (rowEpc === epc && rowFirstMs === firstMs && rowRound === round) return true;
  }
  return false;
}

function appendRoundDividerIfNeeded_(sheet, round) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var lastRound = sheet.getRange(lastRow, 7).getValue();
  if (String(lastRound) !== String(round)) {
    sheet.appendRow(["--- סבב " + round + " ---", "", "", "", "", "", "", ""]);
    sheet.getRange(sheet.getLastRow(), 1, 1, 8)
         .setBackground("#d9ead3")
         .setFontWeight("bold");
  }
}

function getMaxRoundNumeric_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;
  var vals = sheet.getRange(2, 7, lastRow - 1, 1).getValues();
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
