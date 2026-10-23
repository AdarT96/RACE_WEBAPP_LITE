// Service worker: מעטפת האפליקציה זמינה גם בלי קליטה.
// אסטרטגיה: רשת קודם לכל דבר באותו מקור (HTML/JS/CSS/תמונות) ולכן גרסה חדשה
// מגיעה למשתמש בטעינה הבאה כשיש רשת; המטמון משמש רק כשהרשת נכשלת.
// ה-SDK של Firebase (gstatic): גם רשת קודם, מטמון רק בכישלון.
// Firestore/Auth/Apps Script אינם עוברים כאן בכלל (classify מחזיר skip).
// חדש בדיפלוי: להעלות את CACHE_VERSION ב-sw-policy.js מנקה מטמונים ישנים.
importScripts('sw-policy.js');

const { CACHE_NAME, CACHE_PREFIX, SHELL_FILES, SDK_URLS, classify } = self.SwPolicy;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // כל קובץ בנפרד: קובץ שנכשל לא מבטל את ההתקנה.
    await Promise.all([
      ...SHELL_FILES.map(file => cache.add(new Request(file, { cache: 'reload' })).catch(() => {})),
      ...SDK_URLS.map(url => cache.add(new Request(url, { mode: 'cors', cache: 'reload' })).catch(() => {}))
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok && (response.type === 'basic' || response.type === 'cors')) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: true }); // ?v= הוא רק מניעת מטמון
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const kind = classify(request.url, request.method, self.location.origin);
  if (kind === 'skip') return;
  event.respondWith(networkFirst(request));
});
