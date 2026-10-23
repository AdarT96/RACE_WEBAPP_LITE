// מדיניות המטמון של ה-service worker. סקריפט קלאסי (importScripts) כדי לעבוד
// בכל הדפדפנים; נבדק ביחידות דרך vm. אין כאן תלות בדפדפן.
(function (root) {
  var SDK_URLS = [
    'https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js',
    'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js',
    'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js'
  ];
  var CACHE_PREFIX = 'gibush-shell-';
  var CACHE_VERSION = 'v1';
  var CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

  // קבצי המעטפת שמוטמעים מראש בהתקנה. בדיקת יחידה מוודאת שהרשימה מכסה את כל
  // הדפים, ה-CSS וה-JS שבתיקיית frontend (נתיבים יחסית למיקום sw.js).
  var SHELL_FILES = [
    'index.html', 'app.html', 'admin.html', 'commander.html', 'schedule.html',
    'event-setup.html', 'intake.html',
    'css/main.css', 'css/event-setup.css', 'css/schedule.css',
    'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
    'js/pwa-register.js'
  ];
  var SHELL_MODULES = [
    'active-user-context', 'app-navigation-model', 'arrival-controller', 'arrival-order-model',
    'arrival-repository', 'auth', 'candidate-roster-import', 'candidate-roster-repository',
    'commander-dashboard', 'evaluation-model', 'evaluation-repository', 'event-roster-plan',
    'event-setup-model', 'event-setup-page', 'event-setup-repository', 'firebase-config',
    'firestore-cache', 'formation-alerts-model', 'formation-operations-model',
    'formation-operations-repository', 'intake-model', 'intake-page', 'intake-repository',
    'issue-report', 'load-priority', 'message-center', 'messages-model', 'messages-repository',
    'private-notes-repository', 'roles', 'round-navigation-model', 'schedule-excel-adapter',
    'schedule-model', 'schedule-page', 'schedule-publication-model', 'schedule-repository',
    'session-policy', 'staff-assignment', 'station-intensity', 'station-operational-dialog',
    'station-operational-status', 'station-types'
  ].map(function (name) { return 'js/' + name + '.js'; });

  // החלטה לכל בקשה: 'same-origin' | 'sdk' | 'skip'. skip = ה-SW לא נוגע בבקשה
  // (Firestore, Auth, Apps Script וכל מה שאינו GET).
  function classify(url, method, selfOrigin) {
    if (method && method !== 'GET') return 'skip';
    var parsed;
    try { parsed = new URL(url); } catch (e) { return 'skip'; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'skip';
    if (SDK_URLS.indexOf(parsed.origin + parsed.pathname) !== -1) return 'sdk';
    if (parsed.origin === selfOrigin) return 'same-origin';
    return 'skip';
  }

  root.SwPolicy = {
    SDK_URLS: SDK_URLS, CACHE_PREFIX: CACHE_PREFIX, CACHE_NAME: CACHE_NAME,
    SHELL_FILES: SHELL_FILES.concat(SHELL_MODULES), classify: classify
  };
})(typeof self !== 'undefined' ? self : globalThis);
