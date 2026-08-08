// =====================================================
//  Firebase Configuration — LOCAL (gitignored)
//  Copied from firebase-config.example.js with real Firebase project values.
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
  appVersion: "lite-v0.8",

  // Google Apps Script endpoint (same Sheet as the full ESP32 app; irrelevant fields sent empty).
  sheetsApiUrl: "https://script.google.com/macros/s/AKfycbybWGa13xWEoDp4S7NBkLdxPQT2llPmM74jkfREJ8dUJrSa-QOmYKrO8t9oPmPLtQ5TDg/exec",
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
