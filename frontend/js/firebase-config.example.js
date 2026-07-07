// =====================================================
//  Firebase Configuration — TEMPLATE
//
//  1. Copy this file to `firebase-config.js` (same directory).
//  2. Fill in the values from Firebase Console:
//     https://console.firebase.google.com → Project Settings
//     → Your apps → Web app → SDK setup and configuration
//  3. `firebase-config.js` is gitignored — never commit real credentials.
// =====================================================

const FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

// =====================================================
//  App Settings — Change these as needed
// =====================================================
const APP_CONFIG = {
  // גרסת לקוח לתצוגה במסך התחברות (לעדכן בכל שינוי משמעותי)
  appVersion: "lite-v0.2",

  // Google Apps Script endpoint (deploy as web app, paste URL here)
  // גרסת LITE משתמשת באותו Sheet וב-Apps Script — שדות שאינם רלוונטיים נשלחים ריקים.
  sheetsApiUrl: "https://script.google.com/macros/s/AKfycbwnpsMA1a2uulK3vV6QdHb0kI5SAtQTY7UH2MPM1SEGaSWkUMTxHgS1AbHZuPTXhykZtg/exec",
  sheetsApiKey: "YOUR_SECRET_KEY_HERE",

  // מספר הצוותים במערכת (המשתמש בוחר צוות ברישום)
  maxTeamNumber: 15,

  // תחנות המערכת — חייב להתאים ל-STATION_COUNT ו-STATION_NAMES ב-scripts/Code.gs.
  // הערכים כאן הם ברירת מחדל בלבד — המנהל יכול לדרוס אותם לכל צוות בפאנל המנהל.
  stationCount: 8,
  defaultStationNames: {
    "01": "מילוי שק",
    "02": "ספרינטים",
    "03": "דמקה",
    "04": "אלונקה סוציומטרי",
    "05": "עצבים מברזל",
    "06": "זחילות",
    "07": "תחנה 07",
    "08": "תחנה 08"
  },

  // תיוגי הערות למעריך
  commentTags: ["טכניקה", "מצוינות", "מהירות", "עבודת צוות", "דיוק", "מנהיגות"]
};

// expose explicitly for module scripts (auth.js/app.html)
window.FIREBASE_CONFIG = FIREBASE_CONFIG;
window.APP_CONFIG = APP_CONFIG;
