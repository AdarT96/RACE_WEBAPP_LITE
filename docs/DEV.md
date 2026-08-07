# מדריך מפתח — RACE_WEBAPP_LITE (מערכת תזמון והערכה לגיבוש)

מסמך התחלה למפתח חדש. גרסת **LITE** — בלי ESP32/RFID, הכל דרך הדפדפן.

## קישורים חיים
- כניסה: https://adart96.github.io/RACE_WEBAPP_LITE/
- אפליקציה (מגבש/מעריך): `/app.html` · פאנל מנהל: `/admin.html`
- מוגש דרך **GitHub Pages מענף `master`** (path `/`). דחיפה ל-`master` = דיפלוי אוטומטי (~1–2 דק').

## סטאק
- **Frontend**: HTML/CSS/JS סטטי (ללא build). מודולי ES ב-`<script type="module">`.
- **Auth + DB**: Firebase (Authentication אימייל/סיסמה + Firestore). פרויקט `race-webapp-lite`.
- **סנכרון ל-Sheets**: Google Apps Script (`scripts/Code.gs`) פרוס כ-Web App; כותב ל-Google Sheets + Drive.

## מבנה הריפו
```
frontend/
  index.html            כניסה/הרשמה
  app.html              מגבש + מעריך (הליבה)
  admin.html            פאנל מנהל
  css/main.css
  js/
    firebase-config.js  🔧 מפתחות Firebase + sheetsApiUrl + sheetsApiKey (מנוהל בגיט)
    station-types.js    ברירת מחדל של 17 סוגי התחנות (פרמטרים/מדידה/הערות מהירות)
    auth.js
scripts/
  Code.gs               Google Apps Script — הסנכרון ל-Sheets
docs/
  DEV.md                המסמך הזה
  PLAN-evaluation-metrics.md   תכנון פיצ'ר ההערכה (רקע מלא)
```

## מודל הנתונים (Firestore)
- `users/{uid}` — `name, email, role` (`admin|operator|evaluator`), `approved`, `team`, `sheetUrl`/`sheetFileId` (קובץ המעריך).
- `teams/{teamNumber}` — `participants: []`, `stationMap: { "01": typeId, ... }` (סדר התחנות של הצוות; ברירת מחדל = הסדר ב-station-types).
- `settings/commentTags` — תיוגי הערות כלליות.
- `settings/stationTypes` — `{ types: {...} }` — עריכות המנהל לסוגי התחנות (דורס את ברירת המחדל שב-station-types.js).
- `races/{race_team_station_round}` — סבב: `team, station, round, status, startedAt`, ו-`tags: []`.
  כל tag: `{ participantId, place?, reps?, finishedAt?, comments: [{text,authorName,authorUid,at}], scores: { <uid>: { <paramName>: 1..7 } } }`.
- `general_notes/{team_participant}` — הערות כלליות למשתתף.

## סוגי תחנות והמדידה
17 סוגים, לכל אחד `measure`: `place` (סדר הגעה), `reps` (ספירת חזרות/ברגים/שלב), או `none` (ציונים+הערות בלבד), ו-1–2 `params` (כל פרמטר → ציון 1–7).
- ברירת המחדל ב-`js/station-types.js`. המנהל עורך ב-`settings/stationTypes` (פאנל → "עריכת סוגי תחנות").
- ה-app טוען מ-Firestore מעל ברירת המחדל. ה-sync שולח `params/measure/measure_label` ב-payload כך ש-**עריכות שמות פרמטרים/מדידה זורמות ל-Sheet בלי לגעת ב-Code.gs**. `STATION_TYPES` ב-Code.gs הוא fallback בלבד.

## מבנה הפלט ב-Google Sheets
- **קובץ נפרד לכל צוות** (נוצר אוטומטית), ובתוכו **טאב לכל מועמד**: שורה לכל (תחנה × סבב × מעריך) — כל ההערכות, בלי ממוצע.
- **קובץ אישי לכל מעריך** — אותו מבנה, רק ההערכות שלו (שיקוף).
- הקובץ הראשי (`SHEET_ID`) מחזיק רק **רישומים**: "קבצי צוותים", "קבצי מעריכים".
- הכל בתיקיית Drive אחת לאירוע: `גיבוש <חודש> <שנה>` (או `EVENT_FOLDER_NAME` ידני ב-Code.gs).

## דיפלוי
1. **Frontend** — merge/push ל-`master` → GitHub Pages מתעדכן. תמיד `Ctrl+Shift+R` בבדיקה (קאש).
2. **Code.gs** — עורכים ב-[script.google.com](https://script.google.com) → מדביקים את `scripts/Code.gs` →
   **Deploy → Manage deployments → ✏️ → New version → Deploy** (שומר על אותה כתובת).
   - שינוי ב-Code.gs **לא** חי עד פריסה מחדש.
   - אם נוצרת פריסה חדשה עם **כתובת חדשה** — לעדכן `sheetsApiUrl` ב-`firebase-config.js` ולמזג ל-master.
   - פעם ראשונה: לאשר הרשאת **Google Drive** (יצירת קבצים/תיקיות).
3. **Firebase** — קונפיג ב-`firebase-config.js`. מפתחות ה-client ציבוריים (אבטחה דרך Firestore rules + Authorized domains).

## עבודה במקביל
- ענף לכל שינוי; מיזוג ל-`master` דרך PR או תיאום. **לא דוחפים ישירות ל-master בלי בדיקה** — הוא האתר החי.
- לא לשכוח: `firebase-config.js` משותף — שינוי כתובת Apps Script משפיע על כולם.
- אחרי שינוי ב-`Code.gs` — לפרוס מחדש, אחרת הסנכרון לא מתעדכן.

## בדיקה מהירה (מקצה לקצה)
מנהל: הגדר צוות (משתתפים + סדר תחנות) → מעריך: ▶ התחל, בתחנת מקום סמן סדר הגעה / בתחנת חזרות הקש לספירה, תן ציונים 1–7 והערות → **סנכרן ל-Sheets** → בדוק בתיקיית `גיבוש …` בקובץ הצוות שנוצר טאב למועמד.

רקע מלא על פיצ'ר ההערכה: ראו [PLAN-evaluation-metrics.md](PLAN-evaluation-metrics.md).
