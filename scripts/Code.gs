// ============================================================
//  Google Apps Script — סנכרון גיבוש (גרסת LITE)
//  קובץ צוות (טאב לכל תחנה) · קובץ מעריך אישי (טאב לכל מועמד).
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
// קובץ המעריך — טאב לכל מועמד, שורה לכל (תחנה × סבב × מעריך).
var PARTICIPANT_HEADERS = ["תחנה", "סבב", "מקום", "מספר", "פרמטר א׳", "ציון א׳", "פרמטר ב׳", "ציון ב׳", "מעריך", "הערות"];
var GENERAL_STATION_LABEL = "(הערה כללית)";

// קובץ הצוות — טאב לכל תחנה, כמו בקובץ "תוצאות": כל הצוות בתחנה אחת,
// ממוין לפי סבב ואז מקום, כך שסדר ההגעה נקרא ישירות מלמעלה למטה.
var STATION_HEADERS = ["סבב", "מקום", "מועמד", "זמן", "מדידה", "פרמטר א׳", "ציון א׳", "פרמטר ב׳", "ציון ב׳", "מעריך", "הערות"];
var GENERAL_NOTES_TAB     = "הערות כלליות";
var GENERAL_NOTES_HEADERS = ["מועמד", "מעריך", "הערה"];

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

    var ss = openSpreadsheet_(SHEET_ID,
      "הקובץ הראשי (SHEET_ID) לא נגיש — נמחק, הועבר לסל, או שאין לסקריפט הרשאה אליו. " +
      "בדוק את SHEET_ID ב-Code.gs ואת הרשאות הפריסה");
    var type = String(payload.type || "").trim();

    if (type === "general_note")           return handleGeneralNote_(ss, payload);
    if (type === "ensure_evaluator_sheet") return handleEnsureEvaluatorSheet_(ss, payload);
    if (type === "ensure_team_sheet")      return handleEnsureTeamSheet_(ss, payload);
    if (type === "audit_files")            return handleAuditFiles_(ss, payload);
    if (type === "sync_batch")             return handleSyncBatch_(ss, payload);
    if (type === "reset_registries")       return handleResetRegistries_(ss, payload);
    return handleRaceRow_(ss, payload);

  } catch (err) {
    return buildResponse(false, "Error: " + err.message);
  } finally {
    // חשוב: לשטוף כתיבות (כולל רישום קובץ צוות/מעריך חדש) לפני שחרור הנעילה,
    // כדי שהבקשה המקבילה הבאה תראה את הרישום ולא תיצור קובץ כפול.
    try { SpreadsheetApp.flush(); } catch (ignored) {}
    try { lock.releaseLock(); } catch (ignored) {}
  }
}

// פתיחת כתובת ה-exec בדפדפן מחזירה את הגרסה הפרוסה בפועל.
// בלי זה אין דרך להבדיל בין "הקוד נשמר בעורך" לבין "הקוד נפרס" —
// שמירה לבדה אינה מעלה לאוויר, וזה בדיוק המקום שבו טעינו.
// לעדכן את CODE_VERSION בכל שינוי מהותי ב-Code.gs.
var CODE_VERSION = "2026-08-23-f";

// FEATURES מפורט כאן ונבדק מול הראוטר בבדיקה למטה, כדי ש-doGet לא יוכל
// להצהיר על יכולת שאינה קיימת בפריסה. הצהרה לא מדויקת גרועה מכלום:
// היא גורמת לבדיקת הפריסה לעבור בזמן שהיא בעצם נכשלת.
var FEATURES = ["ensure_team_sheet", "audit_files", "reset_registries", "sync_batch"];

function doGet(e) {
  return buildDataResponse_(true, "Gibush sync alive", {
    version: CODE_VERSION,
    features: FEATURES,
    driveAccess: driveProbe_()
  });
}

// ════════════════════════════════════════════════════════════
//  להריץ מהעורך פעם אחת: Run ▶ authorizeDrive
// ════════════════════════════════════════════════════════════
// הרצת doGet או פונקציה אחרת לא תבקש הרשאת Drive, כי הן לא נוגעות
// ב-DriveApp — האישור נדרש רק כשקריאה אמיתית מתבצעת. הפונקציה הזו
// קיימת בשביל לגרום למסך ההרשאות להופיע.
//
// אחרי האישור חובה לפרוס מחדש (Deploy → Manage deployments → ✏️ →
// New version): אפליקציית ה-web רצה עם ההרשאות שהיו בזמן הפריסה.
function authorizeDrive() {
  var root = DriveApp.getRootFolder().getName();
  var main = DriveApp.getFileById(SHEET_ID).getName();
  Logger.log("Drive OK — root: %s | main sheet: %s", root, main);
  return "Drive OK — " + main;
}

// בודקת אם לסקריפט באמת יש הרשאת Drive פעילה. זו החשודה המרכזית
// בכפילויות: כשהיא חסרה, כל בדיקת קיום קובץ נכשלת.
function driveProbe_() {
  try {
    DriveApp.getRootFolder().getName();
    return "ok";
  } catch (err) {
    return "FAILED: " + err.message;
  }
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
  if (!team) return buildResponse(false, "Missing team");

  // נתיב חם — כתיבה בלבד. קובץ חסר הוא שגיאה, לא טריגר ליצירה.
  var teamSs = findTeamFile_(ss, team);
  if (!teamSs) return buildResponse(false, missingTeamFileMsg_(team));
  writeStationRow_(teamSs, payload, def);   // קובץ צוות — טאב לפי תחנה

  var warning = mirrorToEvaluatorFile_(ss, payload, function (evalSs) {
    writeParticipantRow_(evalSs, payload, def);  // קובץ מעריך — טאב לפי מועמד
  });

  return buildDataResponse_(true, "OK: " + def.name + " / מועמד " + pid, { warning: warning });
}

// ---------- קובץ צוות: טאב לכל תחנה ----------
// מבנה מקביל לקובץ "תוצאות": כל הצוות בטאב אחד לכל תחנה, ממוין לפי
// סבב ואז מקום. אותם נתונים כמו בקובץ המעריך, מקובצים אחרת.
function writeStationRow_(ss, payload, def) {
  var pid = participantId_(payload);
  if (!pid) return;

  var sheet = getOrCreateSheet_(ss, String(def.name));
  ensureHeaders_(sheet, STATION_HEADERS, "#0f766e");

  var round    = Number(payload.round || 0);
  var evalName = String(payload.evaluator_name || "");
  var vals     = buildStationRow_(payload, def, round, evalName, pid);

  var rowIndex = findStationRow_(sheet, pid, round, evalName);
  if (rowIndex > 0) sheet.getRange(rowIndex, 1, 1, STATION_HEADERS.length).setValues([vals]);
  else sheet.appendRow(vals);

  sortStationTab_(sheet);
}

// עמודות: סבב·מקום·מועמד·זמן·מדידה·פרמטר א׳·ציון א׳·פרמטר ב׳·ציון ב׳·מעריך·הערות
function buildStationRow_(payload, def, round, evalName, pid) {
  var vals = [];
  for (var i = 0; i < STATION_HEADERS.length; i++) vals.push("");

  vals[0] = round;
  if (def.measure === "place" && payload.place !== undefined &&
      payload.place !== "" && payload.place !== null) {
    vals[1] = Number(payload.place) || "";
  }
  vals[2] = pid;
  vals[3] = msToClock_(payload.first_ms);
  if (def.measure === "reps" && payload.reps !== undefined &&
      payload.reps !== "" && payload.reps !== null) {
    vals[4] = Number(payload.reps);
  }

  var scores = payload.scores || {};
  var params = def.params || [];
  if (params[0]) { vals[5] = params[0]; vals[6] = scoreVal_(scores[params[0]]); }
  if (params[1]) { vals[7] = params[1]; vals[8] = scoreVal_(scores[params[1]]); }

  vals[9]  = evalName;
  vals[10] = notesToCell_(payload.comments);
  return vals;
}

// זהות שורה בטאב תחנה: מועמד + סבב + מעריך (בטאב מועמד המפתח הוא תחנה+סבב+מעריך)
function findStationRow_(sheet, pid, round, evalName) {
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var vals = sheet.getRange(2, 1, last - 1, STATION_HEADERS.length).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (Number(vals[i][0]) === Number(round) &&
        String(vals[i][2]) === String(pid) &&
        String(vals[i][9] || "") === String(evalName)) {
      return 2 + i;
    }
  }
  return -1;
}

// סבב עולה, ובתוכו מקום עולה — כך סדר ההגעה נקרא מלמעלה למטה.
function sortStationTab_(sheet) {
  var last = sheet.getLastRow();
  if (last < 3) return; // אין מה למיין
  sheet.getRange(2, 1, last - 1, STATION_HEADERS.length)
       .sort([{ column: 1, ascending: true }, { column: 2, ascending: true }]);
}

function msToClock_(ms) {
  var n = Number(ms || 0);
  if (!n) return "";
  var total = Math.floor(n / 1000);
  return Math.floor(total / 60) + ":" + ("0" + (total % 60)).slice(-2);
}

function missingTeamFileMsg_(team) {
  return "אין קובץ לצוות " + team + " — צור אותו בפאנל המנהל (\"קבצי צוותים\") לפני הסנכרון";
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

// בקובץ הצוות אין טאב מועמד, והערה כללית אינה שייכת לאף תחנה —
// ולכן היא מקבלת טאב משלה. בקובץ המעריך היא נשארת בטאב המועמד.
function writeTeamGeneralNoteRow_(ss, payload) {
  var pid  = parseInt(payload.participant_id, 10);
  var note = String(payload.note || "");
  if (!pid || !note) return;
  var evalName = String(payload.evaluator_name || "");

  var sheet = getOrCreateSheet_(ss, GENERAL_NOTES_TAB);
  ensureHeaders_(sheet, GENERAL_NOTES_HEADERS, "#9333ea");

  // dedup: אותה הערה מאותו מעריך לאותו מועמד לא נוספת פעמיים
  var last = sheet.getLastRow();
  if (last >= 2) {
    var vals = sheet.getRange(2, 1, last - 1, GENERAL_NOTES_HEADERS.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][0]) === String(pid) &&
          String(vals[i][1] || "") === evalName &&
          String(vals[i][2] || "") === note) return;
    }
  }
  sheet.appendRow([pid, evalName, note]);
}

// ---------- General note handler ----------
function handleGeneralNote_(ss, payload) {
  var pid  = parseInt(payload.participant_id, 10);
  var note = String(payload.note || "");
  if (!pid || !note) return buildResponse(false, "Missing pid/note");

  var team = parseInt(String(payload.team_id || "").replace(/\D+/g, ""), 10);
  if (!team) return buildResponse(false, "Missing team");

  var teamSs = findTeamFile_(ss, team);
  if (!teamSs) return buildResponse(false, missingTeamFileMsg_(team));
  writeTeamGeneralNoteRow_(teamSs, payload);  // טאב ייעודי — הערה כללית אינה שייכת לתחנה

  var warning = mirrorToEvaluatorFile_(ss, payload, function (evalSs) {
    writeGeneralNoteRow_(evalSs, payload);
  });

  return buildDataResponse_(true, "Note recorded for pid " + pid, { warning: warning });
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
// חיפוש בלבד — ללא יצירה וללא DriveApp. זהו הנתיב שרץ בכל שורת סנכרון.
// אם הקובץ הרשום נמחק או שאין אליו גישה, openById נכשל ברעש — וזה רצוי:
// הגרסה הקודמת בלעה את הכשל וייצרה קובץ חדש בכל בקשה.
function findTeamFile_(ss, team) {
  var entry = findTeamEntry_(ss, team);
  if (!entry || !entry.fileId) return null;
  return openSpreadsheet_(entry.fileId,
    "קובץ הצוות " + team + " רשום אבל לא נגיש (נמחק או הועבר לסל). " +
    "פאנל מנהל → קבצי Google Sheets → \"צור קבצי צוותים\" ייצור קובץ חדש במקומו");
}

// יצירה — נקראת אך ורק מ-handleEnsureTeamSheet_ (פעולה יזומה מהפאנל),
// לעולם לא מנתיב הסנכרון.
function createTeamFile_(ss, team) {
  var newSs = SpreadsheetApp.create("צוות " + team + " — גיבוש");
  try { DriveApp.getFileById(newSs.getId()).moveTo(teamFolder_()); } catch (moveErr) {}

  var first = newSs.getSheets()[0];
  first.setName("אודות");
  first.getRange(1, 1).setValue("קובץ צוות " + team + " — טאב לכל תחנה");
  first.getRange(2, 1).setValue("טאב לכל תחנה, ממוין לפי סבב ואז מקום. הערות כלליות בטאב \"" + GENERAL_NOTES_TAB + "\".");
  first.getRange(1, 1, 2, 1).setFontWeight("bold");

  var reg = getTeamRegistrySheet_(ss);
  reg.appendRow([String(team), newSs.getId(), newSs.getUrl(),
                 Utilities.formatDate(new Date(), TIMEZONE, TIMESTAMP_FORMAT)]);
  return newSs;
}

// הקצאה יזומה מהפאנל. idempotent: אם כבר יש קובץ חי — מחזיר אותו.
function handleEnsureTeamSheet_(ss, payload) {
  var team = parseInt(String(payload.team || "").replace(/\D+/g, ""), 10);
  if (!team) return buildResponse(false, "Missing team");

  var entry = findTeamEntry_(ss, team);
  if (entry && entry.fileId && fileState_(entry.fileId) === "alive") {
    return buildDataResponse_(true, "Team sheet exists", { url: entry.url, fileId: entry.fileId });
  }

  var newSs = createTeamFile_(ss, team);
  return buildDataResponse_(true, "Team sheet created", { url: newSs.getUrl(), fileId: newSs.getId() });
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
  if (entry && entry.fileId && fileState_(entry.fileId) === "alive") {
    return buildDataResponse_(true, "Evaluator sheet exists", { url: entry.url, fileId: entry.fileId });
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

// מחזירה "" בהצלחה, או תיאור תקלה קריא. שורת הצוות כבר נכתבה בשלב זה,
// ולכן כשל כאן אינו מפיל את הבקשה — אבל הוא כן מדווח חזרה ל-app.
// הגרסה הקודמת בלעה כל שגיאה בשקט, וזו הסיבה שקבצי המעריכים נשארו ריקים.
function mirrorToEvaluatorFile_(ss, payload, fn) {
  var uid  = String(payload.evaluator_uid || "").trim();
  var name = String(payload.evaluator_name || "").trim();
  if (!uid && !name) return "השורה נשלחה בלי זיהוי מעריך";

  var entry = findEvaluatorEntry_(ss, uid, name);
  if (!entry || !entry.fileId) {
    return "אין קובץ רשום למעריך " + (name || uid) + " — צור אותו בפאנל המנהל";
  }
  var evalSs;
  try {
    evalSs = openSpreadsheet_(entry.fileId,
      "קובץ המעריך " + (name || uid) + " רשום אבל לא נגיש (נמחק או הועבר לסל). " +
      "פאנל מנהל → כפתור \"צור מחדש\" ליד שם המעריך");
  } catch (err) {
    return err.message;
  }
  try {
    fn(evalSs);
    return "";
  } catch (err2) {
    return "כתיבה לקובץ המעריך " + (name || uid) + " נכשלה: " + err2.message;
  }
}

// פותח גיליון עם הודעת שגיאה שאומרת מה לעשות, במקום חריגה גולמית באנגלית.
// חשוב במיוחד עכשיו: מאז שהיצירה יצאה מהנתיב החם, קובץ חסר כבר לא "מתקן"
// את עצמו בשקט — ולכן ההודעה היא כל מה שמכוון את המשתמש.
function openSpreadsheet_(id, hint) {
  try {
    return SpreadsheetApp.openById(id);
  } catch (err) {
    throw new Error(hint + " [" + err.message + "]");
  }
}

// "alive" | "trashed" | "missing" — ורק אלה. שגיאת הרשאה/מכסה/תקלה זמנית
// נזרקת הלאה במקום להתחזות ל"לא קיים": ההתחזות הזו היא שגרמה ליצירת
// קובץ צוות חדש בכל בקשת סנכרון. נקראת רק בהקצאה יזומה, לא בנתיב החם.
function fileState_(id) {
  try {
    return DriveApp.getFileById(id).isTrashed() ? "trashed" : "alive";
  } catch (err) {
    var msg = String((err && err.message) || err);
    if (/not found|no item with the given id|נמצא/i.test(msg)) return "missing";
    throw err;
  }
}

// ============================================================
//  סנכרון אצווה — כל השורות בבקשה אחת
// ============================================================
// הנתיב הישן שלח בקשת HTTP לכל שורה, וכל אחת תפסה את נעילת הסקריפט,
// פתחה את הקבצים וקראה את הטאב מחדש. באצווה כל זה קורה פעם אחת:
// פתיחה אחת לקובץ, קריאה אחת לטאב, setValues אחד, מיון אחד.
//
// שימוש: POST { type: "sync_batch", rows: [ <אותן שורות כמו בנתיב הישן> ] }
function handleSyncBatch_(ss, payload) {
  var rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (!rows.length) return buildResponse(false, "Empty batch");

  var warnings = [];
  var written  = 0;

  var byTeam = {};
  for (var i = 0; i < rows.length; i++) {
    var team = batchRowTeam_(rows[i]);
    if (!team) { warnings.push("שורה ללא צוות — דולגה"); continue; }
    (byTeam[team] = byTeam[team] || []).push(rows[i]);
  }

  for (var teamKey in byTeam) {
    var teamSs;
    try {
      teamSs = findTeamFile_(ss, teamKey);
    } catch (err) {
      warnings.push(err.message);
      continue;
    }
    if (!teamSs) { warnings.push(missingTeamFileMsg_(teamKey)); continue; }
    written += writeTeamBatch_(teamSs, byTeam[teamKey], warnings);
  }

  mirrorEvaluatorBatches_(ss, rows, warnings);

  return buildDataResponse_(true, "Batch written", {
    rows: rows.length, written: written, warnings: warnings
  });
}

function batchRowTeam_(row) {
  if (String(row.type || "") === "general_note") {
    return parseInt(String(row.team_id || "").replace(/\D+/g, ""), 10) || 0;
  }
  return teamId_(row);
}

// ---------- אצווה: קובץ צוות ----------
function writeTeamBatch_(teamSs, rows, warnings) {
  var byTab = {}, notes = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (String(row.type || "") === "general_note") { notes.push(row); continue; }

    var t = resolveType_(row);
    if (!t) { warnings.push("תחנה לא מזוהה — שורה דולגה"); continue; }
    var pid = participantId_(row);
    if (!pid) { warnings.push("שורה ללא מספר מועמד — דולגה"); continue; }

    var def = effectiveDef_(row, t.def);
    var tab = String(def.name);
    (byTab[tab] = byTab[tab] || []).push(
      buildStationRow_(row, def, Number(row.round || 0), String(row.evaluator_name || ""), pid));
  }

  var count = 0;
  for (var tabName in byTab) {
    var sheet = getOrCreateSheet_(teamSs, tabName);
    ensureHeaders_(sheet, STATION_HEADERS, "#0f766e");
    count += mergeRows_(sheet, STATION_HEADERS, stationRowKey_, byTab[tabName]);
    sortStationTab_(sheet);   // פעם אחת לטאב, לא אחרי כל שורה
  }

  if (notes.length) count += writeTeamNotesBatch_(teamSs, notes);
  return count;
}

function writeTeamNotesBatch_(teamSs, notes) {
  var vals = [];
  for (var i = 0; i < notes.length; i++) {
    var pid  = parseInt(notes[i].participant_id, 10);
    var note = String(notes[i].note || "");
    if (!pid || !note) continue;
    vals.push([pid, String(notes[i].evaluator_name || ""), note]);
  }
  if (!vals.length) return 0;

  var sheet = getOrCreateSheet_(teamSs, GENERAL_NOTES_TAB);
  ensureHeaders_(sheet, GENERAL_NOTES_HEADERS, "#9333ea");
  return mergeRows_(sheet, GENERAL_NOTES_HEADERS, noteRowKey_, vals);
}

// ---------- אצווה: קבצי מעריכים ----------
function mirrorEvaluatorBatches_(ss, rows, warnings) {
  var byEval = {};
  for (var i = 0; i < rows.length; i++) {
    var key = String(rows[i].evaluator_uid || "").trim() ||
              String(rows[i].evaluator_name || "").trim();
    if (!key) continue;
    (byEval[key] = byEval[key] || []).push(rows[i]);
  }

  for (var evalKey in byEval) {
    var group = byEval[evalKey];
    var name  = String(group[0].evaluator_name || "").trim();
    var uid   = String(group[0].evaluator_uid || "").trim();

    var entry = findEvaluatorEntry_(ss, uid, name);
    if (!entry || !entry.fileId) {
      warnings.push("אין קובץ רשום למעריך " + (name || evalKey) + " — צור אותו בפאנל המנהל");
      continue;
    }
    try {
      writeEvaluatorBatch_(openSpreadsheet_(entry.fileId,
        "קובץ המעריך " + (name || evalKey) + " רשום אבל לא נגיש"), group);
    } catch (err) {
      warnings.push(err.message);
    }
  }
}

function writeEvaluatorBatch_(evalSs, rows) {
  var byPid = {};

  for (var i = 0; i < rows.length; i++) {
    var row    = rows[i];
    var isNote = String(row.type || "") === "general_note";
    var pid    = isNote ? parseInt(row.participant_id, 10) : participantId_(row);
    if (!pid) continue;

    var vals;
    if (isNote) {
      var note = String(row.note || "");
      if (!note) continue;
      vals = [];
      for (var z = 0; z < PARTICIPANT_HEADERS.length; z++) vals.push("");
      vals[0] = GENERAL_STATION_LABEL;
      vals[8] = String(row.evaluator_name || "");
      vals[9] = note;
    } else {
      var t = resolveType_(row);
      if (!t) continue;
      var def = effectiveDef_(row, t.def);
      vals = buildParticipantRow_(row, def, Number(row.round || 0), String(row.evaluator_name || ""));
    }
    (byPid[pid] = byPid[pid] || []).push(vals);
  }

  for (var p in byPid) {
    var sheet = getOrCreateSheet_(evalSs, String(p));
    ensureHeaders_(sheet, PARTICIPANT_HEADERS, "#4a86e8");
    mergeRows_(sheet, PARTICIPANT_HEADERS, participantRowKey_, byPid[p]);
  }
}

// ---------- מיזוג אצווה לתוך טאב ----------
// קורא את הטאב פעם אחת, ממזג בזיכרון לפי מפתח, וכותב פעם אחת.
// מוסיף או מחליף בלבד — לעולם אינו מקצר את הטבלה, כדי ששורות שאינן
// באצווה (סבב אחר, מעריך אחר, סנכרון קודם) לא יימחקו בטעות.
function mergeRows_(sheet, headers, keyOf, newRows) {
  if (!newRows.length) return 0;

  var last = sheet.getLastRow();
  var existing = (last >= 2)
    ? sheet.getRange(2, 1, last - 1, headers.length).getValues()
    : [];

  var index = {};
  for (var i = 0; i < existing.length; i++) index[keyOf(existing[i])] = i;

  for (var j = 0; j < newRows.length; j++) {
    var key = keyOf(newRows[j]);
    if (index[key] !== undefined) existing[index[key]] = newRows[j];
    else { existing.push(newRows[j]); index[key] = existing.length - 1; }
  }

  sheet.getRange(2, 1, existing.length, headers.length).setValues(existing);
  return newRows.length;
}

// המפתחות זהים לאלה שהנתיב הישן חיפש לפיהם, כדי שסנכרון חוזר ידרוס
// את אותה שורה בדיוק ולא ייצור כפילות.
function stationRowKey_(row) {           // סבב | מועמד | מעריך
  return [row[0], row[2], row[9]].join(" ");
}

function participantRowKey_(row) {       // תחנה | סבב | מעריך
  if (String(row[0]) === GENERAL_STATION_LABEL) {
    return ["GN", row[8], row[9]].join(" ");  // הערה כללית: מעריך | טקסט
  }
  return [row[0], row[1], row[8]].join(" ");
}

function noteRowKey_(row) {              // מועמד | מעריך | הערה
  return [row[0], row[1], row[2]].join(" ");
}

// ---------- ביקורת קבצים (קריאה בלבד) ----------
// מדווח מה באמת קיים: כמה רשומות יש לכל צוות/מעריך, מה מצב כל קובץ,
// וכמה נתונים יש בו. לא יוצר, לא מוחק, לא משנה — רק מדווח.
// שימוש: POST { type: "audit_files" }
// פתיחת כל קובץ רשום חוצה את מגבלת 6 הדקות ברגע שהרישום גדל (80 קבצים
// הספיקו), והבקשה חוזרת ריקה — כלי האבחון הפך למכשול. לכן פתיחת הקבצים
// מתרחשת רק כשמבקשים קבוצה מסוימת; בלי מסנן מוחזר סיכום הרישום בלבד.
//
//   { type:"audit_files" }                    → מהיר, בלי פתיחת קבצים
//   { type:"audit_files", team:"99" }         → בדיקה מלאה לצוות אחד
//   { type:"audit_files", evaluator:"שם" }    → בדיקה מלאה למעריך אחד
function handleAuditFiles_(ss, payload) {
  var teamKey = String((payload && payload.team) || "").trim();
  var evalKey = String((payload && payload.evaluator) || "").trim();

  return buildDataResponse_(true, "Audit complete", {
    inspected:  !!(teamKey || evalKey),
    teams:      auditRegistry_(ss, TEAM_REGISTRY_TAB, 4, 1, 0, teamKey),
    evaluators: auditRegistry_(ss, EVAL_REGISTRY_TAB, 6, 3, 1, evalKey)
  });
}

// keyCol/fileCol הם אינדקסים מבוססי-0 בתוך שורת הרישום.
// filterKey ריק = לא פותחים קבצים, רק סופרים רשומות.
function auditRegistry_(ss, tabName, width, fileCol, keyCol, filterKey) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet || sheet.getLastRow() < 2) return [];

  var vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  var byKey = {};
  var order = [];

  for (var i = 0; i < vals.length; i++) {
    var key    = String(vals[i][keyCol] || "").trim();
    var fileId = String(vals[i][fileCol] || "").trim();
    if (!key && !fileId) continue;
    if (filterKey && key !== filterKey) continue;
    if (!byKey[key]) { byKey[key] = { key: key, rows: [] }; order.push(key); }
    byKey[key].rows.push({ registryRow: i + 2, fileId: fileId, state: "", tabs: 0, dataRows: 0 });
  }

  for (var k = 0; k < order.length; k++) {
    var group = byKey[order[k]];
    if (filterKey) {
      for (var r = 0; r < group.rows.length; r++) inspectFile_(group.rows[r]);
      group.withData = group.rows.filter(function (x) { return x.dataRows > 0; }).length;
    }
    group.duplicateRows = group.rows.length;
  }

  return order.map(function (key) { return byKey[key]; });
}

function inspectFile_(row) {
  if (!row.fileId) { row.state = "no-id"; return; }
  try {
    row.state = fileState_(row.fileId);
  } catch (err) {
    row.state = "error: " + err.message;
    return;
  }
  // גם קובץ בסל המחזור נמדד: הוא עדיין נפתח לפי ID, ו"בסל" אינו ראיה
  // לכך שהוא ריק. בלי המדידה הזו ניקוי עלול למחוק נתונים שלא ראינו.
  if (row.state !== "alive" && row.state !== "trashed") return;
  try {
    var sheets = SpreadsheetApp.openById(row.fileId).getSheets();
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getName() === "אודות") continue;
      row.tabs++;
      row.dataRows += Math.max(0, sheets[i].getLastRow() - 1);
    }
  } catch (err2) {
    row.state = "open-failed: " + err2.message;
  }
}

// ---------- איפוס הרישום ----------
// מנקה את טבלאות הרישום כדי שהקצאה מחדש תתחיל מדף חלק.
// אינו נוגע בקבצים עצמם — רק מנתק את ההפניות אליהם ומחזיר את
// רשימת המזהים כדי שאפשר יהיה למחוק אותם ידנית מ-Drive.
//
// בטוח כי הגיליונות הם תוצר נגזר: כל שורה נבנית מ-Firestore בזמן
// הסנכרון, ולכן סנכרון אחד אחרי ההקצאה מחזיר את כל התוכן.
// שימוש: POST { type: "reset_registries", confirm: "RESET" }
function handleResetRegistries_(ss, payload) {
  if (String(payload.confirm || "") !== "RESET") {
    return buildResponse(false,
      'הפעולה מוחקת את טבלאות הרישום — נדרש confirm:"RESET" כדי לאשר');
  }
  return buildDataResponse_(true, "Registries cleared", {
    teams:      clearRegistry_(ss, TEAM_REGISTRY_TAB, 4, 1),
    evaluators: clearRegistry_(ss, EVAL_REGISTRY_TAB, 6, 3)
  });
}

function clearRegistry_(ss, tabName, width, fileCol) {
  var sheet = ss.getSheetByName(tabName);
  if (!sheet || sheet.getLastRow() < 2) return { removed: 0, fileIds: [] };

  var count = sheet.getLastRow() - 1;
  var vals  = sheet.getRange(2, 1, count, width).getValues();
  var ids   = [];
  for (var i = 0; i < vals.length; i++) {
    var id = String(vals[i][fileCol] || "").trim();
    if (id) ids.push(id);
  }
  sheet.deleteRows(2, count); // הכותרות נשארות
  return { removed: count, fileIds: ids };
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
