# RACE_WEBAPP_LITE

גרסת **LITE** של [`RFID_Race_WebApp`](https://github.com/AdarT96/RFID_Race_WebApp) —
בלי ESP32/RFID, עם זרימה ידנית של המעריך.

- הפורק נעשה מתוך התג [`v1-full-esp32`](https://github.com/AdarT96/RFID_Race_WebApp/releases/tag/v1-full-esp32) של הפרויקט המקורי.
- מסונכרן לאותו Google Sheet של הפרויקט המקורי — שדות שאינם רלוונטיים (EPC, RSSI, אנטנה, הקפות RFID) נשלחים ריקים.

---

## מבנה הפרויקט

```
RACE_WEBAPP_LITE/
├── frontend/
│   ├── index.html          ← מסך כניסה / הרשמה
│   ├── app.html            ← תצוגות מגבש + מעריך
│   ├── admin.html          ← פאנל מנהל
│   ├── css/
│   │   └── main.css
│   └── js/
│       ├── firebase-config.js  ← 🔧 יש לערוך תחילה
│       └── auth.js
└── scripts/
    └── Code.gs             ← Google Apps Script (משותף עם הגרסה המלאה)
```

---

## הבדלים מהגרסה המלאה

| נושא | הגרסה המלאה | LITE |
|------|-------------|------|
| חומרה | בקר ESP32 + קורא RFID | ללא — הכל דרך הדפדפן |
| מקור נתוני משתתפים | סריקת תגי RFID | המנהל מזין ידנית לכל צוות |
| התחלת תחנה | לחיצה על ▶ בבקר | לחיצה על ▶ באפליקציה |
| סימון סיום משתתף | תג RFID נקלט אוטומטית | המעריך לוחץ על מספר המשתתף בחלון |
| הגדרות טכניאן (עוצמת שידור, אנטנות) | קיים | הוסר |
| שמות תחנות | קבועים ב-Code.gs | ניתן לעריכה בפאנל המנהל, לכל צוות בנפרד |
| Google Sheet | אותו Sheet | אותו Sheet — שדות ESP32 נשלחים ריקים |
| מצב סימולטור (demo.html) | קיים | הוסר — האפליקציה עצמה קלה מספיק לבדיקה |
| Firmware (`firmware/`) | קיים | הוסר |

---

## Quick Start

### 1. הגדרת Firebase

1. פתח [console.firebase.google.com](https://console.firebase.google.com) → צור פרויקט
2. הפעל **Authentication** → Sign-in method → **Email/Password**
3. הפעל **Firestore Database** → Start in production mode
4. הוסף Firestore security rules (למטה)
5. Project Settings → Your apps → Add web app → העתק את הconfig
6. ערוך את `frontend/js/firebase-config.js` והכנס את הconfig שלך

**Firestore Security Rules:**
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
      allow read, write: if request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }
    match /races/{raceId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role in ['admin','operator','evaluator'];
    }
    match /teams/{teamNumber} {
      allow read: if request.auth != null;
      allow write: if request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }
    match /settings/{key} {
      allow read: if request.auth != null;
      allow write: if request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }
    // ההערות שמורות תחת doc-id בפורמט "{team}_{participantId}", למשל "01_1234".
    // מנהל — קריאה+כתיבה בכל מקום. מגבש/מעריך — רק בתוך הצוות שהוא משוייך אליו
    // ("01_..." יאושר רק למי שאצלו users/{uid}.team == 1).
    match /general_notes/{noteId} {
      allow read, write: if request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
      allow read, write: if request.auth != null &&
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role in ['operator','evaluator'] &&
        int(noteId.split('_')[0]) == get(/databases/$(database)/documents/users/$(request.auth.uid)).data.team;
    }
  }
}
```

### 2. יצירת אדמין ראשון

1. הירשם דרך האפליקציה (עם כל תפקיד)
2. ב-Firebase Console → Firestore → `users` collection → מצא את המסמך שלך
3. עדכן `role = "admin"` ו-`approved = true`
4. עכשיו אפשר להיכנס ולנהל משתמשים אחרים

### 3. Google Sheets

LITE משתמש באותו Apps Script של הגרסה המלאה. אם עדיין לא הוקם:

1. פתח [script.google.com](https://script.google.com) → New project
2. הדבק את תוכן `scripts/Code.gs`
3. הגדר `SHEET_ID` ו-`API_SECRET_KEY`
4. Deploy → New deployment → Web App → Execute as Me → Anyone
5. העתק את הכתובת → הדבק ב-`APP_CONFIG.sheetsApiUrl` בתוך `firebase-config.js`
6. הגדר `APP_CONFIG.sheetsApiKey` לאותה סיסמה סודית

---

## תפקידים

### מגבש (Operator)
מפעיל את התחנה שלו: לוחץ **▶ התחל** לפתיחת סבב חדש, **⏹ עצור** לסיום.
_(הזרימה הידנית תיבנה בשלב הבא של הפיתוח.)_

### מעריך (Evaluator)
רואה חלון גדול עם מספרי המשתתפים של הצוות הפעיל. לחיצה על משתתף = סימון סיום, והוא נעלם מהחלון עד הסשן הבא. יכול להוסיף תיוגים והערות למשתתפים.
_(זרימה זו תיבנה בשלב הבא של הפיתוח.)_

### מנהל (Admin)
- אישור/דחייה של משתמשים חדשים
- שינוי תפקידים
- צפייה בהיסטוריית מירוצים
- **בגרסת LITE:** ניהול משתתפים לכל צוות + עריכת שמות התחנות לכל צוות
_(הפאנל LITE יורחב בשלב הבא של הפיתוח.)_

---

## Deploy

הגרסה נדחפת כרגע ידנית. `.github/workflows/deploy.yml` (GitHub Pages CI/CD) הוסר בעת יצירת ה-repo — יוחזר כשייקבע יעד ה-hosting.

---

## מבנה נתונים ב-Firestore

- **`users/{uid}`** — משתמשים, כמו בגרסה המלאה (`role`, `team`, `approved`).
- **`teams/{teamNumber}`** — מנוהל על ידי המנהל בפאנל. כולל:
  - `participants` — מערך של מספרי משתתפים (מחרוזות, למשל `["1234","5678"]`)
  - `stationNames` — מילון של דריסות שמות תחנה לצוות (`{"01":"מילוי שק","03":"שם מותאם"}`). אם מזהה תחנה לא נמצא, משתמשים ב-`APP_CONFIG.defaultStationNames` שמתאים ל-`Code.gs`.
- **`races/{raceId}`** — כל סבב (session) הוא מסמך משלו. `raceId = race_{team}_{station}_{round}` (למשל `race_01_03_2`). מבנה:
  - `team`, `station`, `round` — מזהים
  - `status` — `"running"` / `"stopped"`
  - `startedAt`, `endedAt`, `startedBy` — טיימסטמפים ו-UID
  - `tags` — מערך של משתתפים שסיימו לפי סדר: `{ participantId, place, finishedAt (ms), comments: [] }`

## היסטוריה

- **v0.1-lite** — clone נקי מ-`v1-full-esp32` + הסרת ESP32/RFID.
- **v0.2-lite** — פאנל מנהל: משתתפים לכל צוות + עריכת שמות תחנות פר-צוות (`teams/{teamNumber}`).
- **v0.3-lite** — זרימת מירוץ ידנית: בורר צוות+תחנה, כפתור **▶ התחל תחנה**, grid של משתתפים גדול וידידותי למגע, סימון סיום בלחיצה, רשימה של מי סיים לפי סדר, הערות ותיוגים לכל משתתף, ריבוי סבבים (sessions) פר צוות+תחנה, סנכרון real-time בין מכשירים דרך `onSnapshot`, טיימר מאיות.
- **v0.4-lite** — סנכרון ידני ל-Google Sheets לאותו endpoint של הגרסה המלאה: הכפתור **📊 סנכרן תחנה ל-Sheets** אוסף את כל הסבבים של הצוות+תחנה הנוכחיים, בונה EPC סינתטי בפורמט `TTPPPP` (2 ספרות צוות + 4 ספרות משתתף) שמאפשר ל-`pidFromEpc_`/`teamFromEpc_` ב-Code.gs לחלץ מזהים כרגיל, ושולח שורה אחת לכל משתתף שסיים. `Code.gs` מבצע dedup לפי (epc, round) — לחיצה חוזרת בטוחה.
- **v0.5-lite** (הנוכחי) — הערות + גרף השוואה:
  - **תיוגים ניתנים לעריכה** — הועברו מ-`APP_CONFIG.commentTags` ל-Firestore `settings/commentTags` (מסמך יחיד עם `tags: [...]`). המנהל עורך בפאנל תחת "💬 תיוגים מהירים למעריכים"; שני הצדדים (מודל הערות תחנה + הערות כלליות) מתעדכנים ב-real-time דרך `onSnapshot`.
  - **הערות כלליות למשתתף** — `general_notes/{team}_{participantId}` = `{ team, participantId, notes: [{ text, authorName, authorUid, at }] }`. סקציה בlite-app.html: בחירת צוות (dropdown למנהל, קבוע לאחרים) + משתתף → הוספה בלחיצה על תיוג מהיר או כתיבה חופשית + מחיקה + סנכרון ל-`SUMMARY_TAB` דרך `handleGeneralNote_` ב-Code.gs.
    - **תצוגה מוגבלת:** מגבש/מעריך רואה רק הערות שהוא עצמו כתב (`authorUid == currentUser.uid`); מנהל רואה הכל. הפילטר client-side.
    - **כתיבה מוגבלת:** חוקי Firestore מונעים ממגבש/מעריך לכתוב תחת doc-id של צוות שאינו שלהם — בלי קשר למה שקרה ב-UI.
  - **גרף השוואה** — כפתור "📈 גרף השוואה" ב-race panel פותח modal עם multi-select של משתתפים ו-line chart של המקום שהגיעו לכל סבב באותה תחנה (`spanGaps:false` — סבב שלא סיימו בו = פער בקו). ציר Y הפוך כדי שמקום 1 יופיע למעלה.

**הערה על מפתח Sheets:** אם `API_SECRET_KEY` ב-Code.gs עדיין בערך ברירת המחדל `YOUR_SECRET_KEY_HERE`, השרת מקבל בקשות ללא בדיקת מפתח. אחרת יש להעתיק אותו ערך בדיוק ל-`APP_CONFIG.sheetsApiKey` ב-`firebase-config.js`.

- שלב הבא: פאנל למגבש (סקירת כל התחנות של הצוות, סטטוס real-time של כל סבב פעיל, ניהול תחנות מרוכז).
