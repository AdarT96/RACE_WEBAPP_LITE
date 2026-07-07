// =====================================================
//  Firebase Configuration
//  Replace with your actual Firebase project values.
//  Go to: https://console.firebase.google.com
//  → Project Settings → Your apps → SDK setup
// =====================================================

const FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId:             "YOUR_APP_ID",
  databaseURL:       "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com"
};

// =====================================================
//  App Settings — Change these as needed
// =====================================================
const APP_CONFIG = {
  // גרסת לקוח לתצוגה במסך התחברות (לעדכן בכל שינוי משמעותי)
  appVersion: "lite-v0.1",

  // Google Apps Script endpoint (deploy as web app, paste URL here)
  // גרסת LITE משתמשת באותו Sheet וב-Apps Script — שדות שאינם רלוונטיים נשלחים ריקים.
  sheetsApiUrl: "https://script.google.com/macros/s/AKfycbwnpsMA1a2uulK3vV6QdHb0kI5SAtQTY7UH2MPM1SEGaSWkUMTxHgS1AbHZuPTXhykZtg/exec",
  sheetsApiKey: "YOUR_SECRET_KEY_HERE",

  // תיוגי הערות למעריך
  commentTags: ["טכניקה", "מצוינות", "מהירות", "עבודת צוות", "דיוק", "מנהיגות"]
};

// expose explicitly for module scripts (auth.js/app.html)
window.FIREBASE_CONFIG = FIREBASE_CONFIG;
window.APP_CONFIG = APP_CONFIG;