# מדריך מפתח — RACE_WEBAPP_LITE (מערכת תזמון והערכה לגיבוש)

מסמך התחלה למפתח חדש. גרסת **LITE** — בלי ESP32/RFID, הכל דרך הדפדפן.

## קישורים חיים
- כניסה: https://adart96.github.io/RACE_WEBAPP_LITE/
- אפליקציה (מפק״צ/מעריך): `/app.html` · פאנל מנהל: `/admin.html`
- מוגש דרך **GitHub Pages מענף `master`** (path `/`). דחיפה ל-`master` = דיפלוי אוטומטי (~1–2 דק').

## סטאק
- **Frontend**: HTML/CSS/JS סטטי (ללא build). מודולי ES ב-`<script type="module">`.
- **Auth + DB**: Firebase (Authentication אימייל/סיסמה + Firestore). פרויקט `race-webapp-lite`.
- **סנכרון ל-Sheets**: Google Apps Script (`scripts/Code.gs`) פרוס כ-Web App; כותב ל-Google Sheets + Drive.

## מבנה הריפו
```
frontend/
  index.html            כניסה/הרשמה
  app.html              מפק״צ + מעריך (הליבה)
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
- `races/{race_team_station_round}` — סבב: `team, station, round, status, startedAt, startedBy, endedAt?, endedBy?`, צילום הרשימה `participantIds`, ו-`tags: []` לציונים/הערות/מדידות שאינן סדר הגעה.
  כל tag: `{ participantId, reps?, comments: [{text,authorName,authorUid,at}], scores: { <uid>: { <paramName>: 1..7 } } }`.
- `races/{raceId}/evaluatorArrivals/{evaluatorUid}` — סדר הגעה אישי למעריך: `participantIds`,‏ `order`,‏ `slotTimes`,‏ `completedAt?`,‏ `createdAt`,‏ `updatedAt`,‏ `schemaVersion`.
  `order` מחבר משתתף למקום; `slotTimes[place]` מחבר זמן לחריץ המקום. לכן סידור מחדש משנה רק את `order`, והזמן נשאר עם המקום.
  `place`/`finishedAt` ישנים בתוך `tags` נשמרים לקריאה וליצירת נקודת התחלה אישית בסבבים מהגרסה הישנה, אך קוד חדש אינו כותב אליהם.
- `general_notes/{team_participant}` — הערות כלליות למשתתף.

## סוגי תחנות והמדידה
17 סוגים, לכל אחד `measure`: `place` (סדר הגעה), `reps` (מדידה כמותית), או `none` (ציונים+הערות בלבד), ו-1–2 `params` (כל פרמטר → ציון 1–7).
- לתחנה עם `measure: "reps"` אפשר להגדיר `measureInput`: הערך `tap` (ברירת מחדל) מציג כפתורי ספירה; `manual` מציג רק שדה להזנת התוצאה הסופית. `ironNerves` (עצבים מברזל) מוגדר `manual`.
- ברירת המחדל ב-`js/station-types.js`. המנהל עורך ב-`settings/stationTypes` (פאנל → "עריכת סוגי תחנות").
- ה-app ממזג כל סוג שנשמר ב-Firestore עם ברירת המחדל. לכן הגדרה חדשה כמו `measureInput` נכנסת גם אם ב-Firestore קיים עותק ישן של התחנה. ה-sync שולח `params/measure/measure_label` ב-payload כך ש-**עריכות שמות פרמטרים/מדידה זורמות ל-Sheet בלי לגעת ב-Code.gs**. `STATION_TYPES` ב-Code.gs הוא fallback בלבד.

## זרימת סבבים והרשאות
- התפקיד הפנימי `operator` מוצג כ-**מפק״צ**. רק הוא (או מנהל) יוצר סבב ועוצר אותו.
- מעריכים מקבלים את כל הסבבים בזמן אמת משאילת `races` ואינם יכולים לשנות שדות חיים/זמן.
- טאבים נגללים של סבבים מוצגים **רק** כאשר סוג התחנה הוא `sprints` או `stretcher` (ספרינטים/אלונקה).
- המפק״צ תמיד נשאר בסבב האחרון. מעריך רשאי לעבור בין הטאבים; ציונים, הערות, סימון סדר הגעה ושינוי הסדר זמינים גם אחרי עצירה ובסבב היסטורי. ספירה בלחיצה נשארת זמינה רק בסבב הפעיל; מדידה ידנית זמינה גם בסיום התחנה.
- בספרינטים ובאלונקה לכל מעריך יש סדר הגעה נפרד. שני מעריכים אינם קוראים או כותבים את אותו מסמך סדר, וחוקי Firestore מאפשרים למעריך לכתוב רק למסמך שה-ID שלו הוא ה-UID שלו.
- גריד סימון ההגעה בנוי תמיד מצילום המשתתפים המלא בסדר קבוע. אחרי סימון הכפתור נעלם חזותית, אך התא שלו נשאר שמור וריק ולכן יתר המספרים אינם זזים; בסבב חדש כולם מופיעים מחדש.
- זמן סימון נכתב כ-`serverTimestamp` לפי המקום. עד 30 דקות מ-`startedAt` הוא מוצג ונשלח; לאחר מכן המקום נשמר, אך הזמן מוצג כ"ללא זמן" ונשלח כתא ריק, לא `0`.
- שינויי `tags` ושינויי סדר אישי מתבצעים בטרנזקציות. שינוי סדר משתמש בחתימת `participantId/place/slotTime` כדי למנוע דריסה בין שני מכשירים של אותו מעריך. שינוי של המעריך השני אינו יוצר התנגשות כי הוא נשמר במסמך אחר.
- סבב חדש שומר צילום `participantIds`, ולכן עריכה מאוחרת של הצוות אינה משנה את ההיסטוריה. בסבב ישן ללא צילום משתמשים ברשימת הצוות ובנתוני ה-`tags` הישנים; הכתיבה הראשונה יוצרת עותק אישי בלי למחוק את המקור.
- `firestore.rules` הוא מקור האמת להרשאות. חובה לפרסם אותו בקונסול ביחד עם הפרונטאנד.

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
4. **Firestore Rules** — לפרסם את `firestore.rules` ידנית ב-Firebase Console → Firestore Database → Rules → Publish.

## עבודה במקביל
- ענף לכל שינוי; מיזוג ל-`master` דרך PR או תיאום. **לא דוחפים ישירות ל-master בלי בדיקה** — הוא האתר החי.
- לא לשכוח: `firebase-config.js` משותף — שינוי כתובת Apps Script משפיע על כולם.
- אחרי שינוי ב-`Code.gs` — לפרוס מחדש, אחרת הסנכרון לא מתעדכן.

## בדיקה מהירה (מקצה לקצה)
מנהל: הגדר צוות (משתתפים + סדר תחנות) → מפק״צ: ▶ התחל → שני מעריכים: סמנו סדרים שונים באותו סבב וודאו שכל אחד ממשיך לראות רק את הסדר שלו; סמנו גם ציונים/הערות במקביל → ודאו שבמובייל גריד הפעולה מתאים את עצמו למסך לאורך (עד 9 משתתפים = 3 עמודות; 10–20 משתתפים = 4 עמודות; 20 משתתפים = 4×5), ושאחרי כל לחיצה הכפתור נעלם אך יתר המספרים נשארים בדיוק באותה שורה ועמודה → פתחו סבב חדש וודאו שכל הכפתורים הופיעו שוב → מפק״צ: ⏹ עצור →
בספרינטים/אלונקה השלימו משתתף נוסף אחרי העצירה, גררו מסיים למקום אחר וודאו שהמשתתפים זזו אך זמני המקומות נשארו קבועים → עברו לסבב היסטורי ושנו בו שוב את הסדר → בעצבים מברזל ודאו שאין כפתורי ספירה, בחרו משתתף ושמרו מספר ברגים גם אחרי עצירה → **סנכרן ל-Sheets** מכל מעריך ובדקו שבקובץ הצוות נשמר מקום שונה לכל מעריך.

רקע מלא על פיצ'ר ההערכה: ראו [PLAN-evaluation-metrics.md](PLAN-evaluation-metrics.md).
