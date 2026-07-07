# RFID Race Timer — Web App

A full-stack web application for managing RFID-based race timing competitions.  
Communicates with the existing **ESP32 RFID controller** (`RFID_Web_Modular_23_02_V2`), adds Firebase authentication, role-based views, and Google Sheets export.

---

## Project Structure

```
RFID_Race_WebApp/
├── frontend/
│   ├── index.html          ← Login / Register
│   ├── app.html            ← Operator & Evaluator views
│   ├── admin.html          ← Admin panel
│   ├── css/
│   │   └── main.css        ← Dark theme styles
│   └── js/
│       ├── firebase-config.js  ← 🔧 EDIT THIS FIRST
│       └── auth.js
├── scripts/
│   └── Code.gs             ← Google Apps Script (Sheets driver)
├── .github/
│   └── workflows/
│       └── deploy.yml      ← GitHub Pages CI/CD
└── README.md
```

---

## Quick Start

### 1. Firebase Setup

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → Create project
2. Enable **Authentication** → Sign-in method → **Email/Password**
3. Enable **Firestore Database** → Start in production mode
4. Add Firestore security rules (see below)
5. Go to Project Settings → Your apps → Add web app → Copy config
6. Edit `frontend/js/firebase-config.js` and paste your config

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
        get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role in ['admin','operator'];
    }
  }
}
```

### 2. Create First Admin

1. Register via the web app (any role)
2. In Firebase Console → Firestore → `users` collection → find your document
3. Set `role = "admin"` and `approved = true`
4. You can now log in and manage other users

### 3. Google Sheets Setup

1. Go to [script.google.com](https://script.google.com) → New project
2. Paste contents of `scripts/Code.gs`
3. Set `SHEET_ID` (from your Google Sheets URL) and `API_SECRET_KEY` (any secret string)
4. Deploy → New deployment → Web App → Execute as Me → Anyone
5. Copy the URL → paste into `APP_CONFIG.sheetsApiUrl` in `firebase-config.js`
6. Set `APP_CONFIG.sheetsApiKey` to the same secret string

### 4. Deploy to GitHub Pages

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<YOUR_USERNAME>/<YOUR_REPO>.git
git push -u origin HEAD
```

> חשוב:
> - אם אתה רואה `main does not match any` זה אומר שהסניף המקומי שלך הוא כנראה `master` (או סניף אחר), לא `main`.
> - הפקודה `git push -u origin HEAD` פותרת את זה אוטומטית כי היא דוחפת את הסניף הנוכחי.
> - אם אתה רואה `https://github.com/YOUR_USERNAME/...` זו כתובת דוגמה בלבד — חייבים להחליף לכתובת ה-repo האמיתית שלך.

Go to GitHub repo → Settings → Pages → Source: **GitHub Actions**  
The workflow will auto-deploy on every push to `main`.

In this project the workflow is configured for `master` וגם `main`, כך שדחיפה לכל אחד מהם תפעיל deploy.

---

## Usage

### Operator (connected to ESP32 WiFi AP)

1. Connect your device to the ESP32 WiFi: `RFID_AP` / `12345`
2. Open the web app → Log in as Operator
3. Enter the ESP32 IP (`192.168.4.1`) in the banner if needed
4. Use **▶ START** / **⏹ STOP** buttons to control the race
5. The countdown timer shows remaining scan time
6. Use **🔧 Technician Settings** (collapsible) for TX power and antenna control
7. Click **📊 Sync Sheets** to export current data to Google Sheets

### Evaluator (connected to internet)

1. Log in as Evaluator from any device with internet
2. View the live leaderboard (synced via Firebase from the Operator)
3. Click **+** next to a participant to select them
4. Click a comment tag (Technique, Excellence, etc.) to apply it
5. Click **📈 Chart** to view a bar chart of results

### Admin

1. Log in → redirected to `admin.html` automatically
2. **Approve / Reject** pending user registrations
3. **Change roles** via the dropdown in the All Users list
4. **View race history** stored in Firebase

---

## ESP32 API Reference (existing endpoints, unchanged)

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/status` | JSON: round, scanning, elapsed_ms, tags_count, tx_power_dbm, scan_duration_ms, mode |
| POST | `/start` | Start new round |
| POST | `/stop` | Stop scanning |
| POST | `/clear` | Delete all data |
| GET  | `/csv` | Download race log CSV |
| POST | `/setmode?m=0\|1` | 0=Arrival, 1=Laps |
| POST | `/setduration?sec=N` | Set scan duration |
| POST | `/setpower?dbm=N` | Set TX power (5–32 dBm) |
| GET  | `/ant` | Get antenna states JSON |
| POST | `/ant?i=N&v=0\|1` | Toggle antenna N |
| POST | `/reboot` | Reboot ESP32 |

---

## Tag Parsing

EPC hex string → last 6 hex characters → `XX` (Team ID) + `YYYY` (Participant ID)

Example: EPC `E2003412013002150000001234`  
→ last 6: `001234` → Team: `00`, Participant: `1234`

Adjust `APP_CONFIG.epcExtractStart`, `teamDigits`, `participantDigits` in `firebase-config.js` if your tags use a different format.

---

## Architecture

```
ESP32 (AP mode, 192.168.4.1)
    ↕ HTTP polling (every 500ms)
Operator's Browser
    ↕ Firestore writes (every 2s)
Firebase Firestore
    ↕ onSnapshot real-time
Evaluator's Browser (internet)

ESP32 CSV → Operator → Google Apps Script → Google Sheets