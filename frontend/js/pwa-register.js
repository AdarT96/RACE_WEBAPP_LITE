// רישום ה-service worker. סקריפט קלאסי; הנתיב יחסי לקובץ הזה, כך שעובד תחת
// /RACE_WEBAPP_LITE/frontend/ וגם ב-localhost.
(function () {
  if (!('serviceWorker' in navigator)) return;
  var base = document.currentScript ? document.currentScript.src : location.href;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register(new URL('../sw.js', base).href).then(function (registration) {
      registration.update().catch(function () {});
    }).catch(function () { /* אין תמיכה (למשל http לא מאובטח) — האפליקציה ממשיכה כרגיל */ });
  });
})();
