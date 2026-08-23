// =====================================================
//  Firebase Configuration — deployed client configuration
//  Firebase web keys are public identifiers; authorization lives in Firestore rules.
// =====================================================

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCRjVAsc0A3apWmwFAHWD3q4riABLKdFRA",
  authDomain:        "race-webapp-lite.firebaseapp.com",
  projectId:         "race-webapp-lite",
  storageBucket:     "race-webapp-lite.firebasestorage.app",
  messagingSenderId: "118416374883",
  appId:             "1:118416374883:web:fb6ae38f231412f5d70c56"
};

// =====================================================
//  App Settings
// =====================================================
const APP_CONFIG = {
  appVersion: "lite-v1.0",

  // Google Apps Script endpoint (same Sheet as the full ESP32 app; irrelevant fields sent empty).
  // פריסת 23.08.2026. הפריסה הקודמת (AKfycbyb…) עדיין קיימת ומריצה קוד ישן —
  // כל עוד הכתובת כאן לא מצביעה על הפריסה הפעילה, הקוד החדש לא מגיע לאפליקציה.
  sheetsApiUrl: "https://script.google.com/macros/s/AKfycbzhSxkcjp3Vxb7HlvMWdEgbPsvAMDWL7KOI6H5TDannOuLA8cx2DK7-GAzQcNSYEk4tWQ/exec",
  sheetsApiKey: "YOUR_SECRET_KEY_HERE",

  // Team count for registration.
  maxTeamNumber: 15,

  // 17 station types are defined in js/station-types.js. Per-team ordering lives in Firestore `teams/{teamNumber}.stationMap`.
  stationCount: 17,
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

  commentTags: ["טכניקה", "מצוינות", "מהירות", "עבודת צוות", "דיוק", "מנהיגות"]
};

window.FIREBASE_CONFIG = FIREBASE_CONFIG;
window.APP_CONFIG = APP_CONFIG;
