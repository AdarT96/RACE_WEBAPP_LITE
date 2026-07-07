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
- **`races/{raceId}`** — נותר מהגרסה המלאה. יוחלף / יורחב בשלב הבא לתמיכה בסשן ידני של המעריך.

## היסטוריה

- **v0.1-lite** — clone נקי מ-`v1-full-esp32` + הסרת ESP32/RFID.
- **v0.2-lite** (הנוכחי) — פאנל מנהל: משתתפים לכל צוות + עריכת שמות תחנות פר-צוות (`teams/{teamNumber}`).
- שלב הבא: UI של המעריך — חלון גדול לסימון סיום משתתפים, ניהול סשנים.
