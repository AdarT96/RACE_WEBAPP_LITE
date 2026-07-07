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
  appVersion: "v2026.03.31-01",

  // Default ESP32 IP (can be changed in the UI)
  defaultEsp32Ip: "192.168.4.1",

  // ESP32 polling interval in milliseconds
  pollIntervalMs: 500,

  // How many ms between syncing to Firebase
  firebaseSyncIntervalMs: 2000,

  // Tag EPC parsing: which characters to use for Team/Participant extraction
  // For a hex EPC like "E2003412013002150000001234"
  // We extract the last 6 hex chars → "001234" → team="00", participant="1234"
  epcExtractStart: -6,   // negative = from end
  teamDigits:      2,
  participantDigits: 4,

  // Google Apps Script endpoint (deploy as web app, paste URL here)
  sheetsApiUrl: "https://script.google.com/macros/s/AKfycbwnpsMA1a2uulK3vV6QdHb0kI5SAtQTY7UH2MPM1SEGaSWkUMTxHgS1AbHZuPTXhykZtg/exec",
  sheetsApiKey: "YOUR_SECRET_KEY_HERE",
  sheetsDeviceName: "ESP_01",

  // תיוגי הערות למעריך
  commentTags: ["טכניקה", "מצוינות", "מהירות", "עבודת צוות", "דיוק", "מנהיגות"]
};

// expose explicitly for module scripts (auth.js/app.html)
window.FIREBASE_CONFIG = FIREBASE_CONFIG;
window.APP_CONFIG = APP_CONFIG;