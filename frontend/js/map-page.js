import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';
import { doc } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import { ROLES, destinationForRole, roleLabel } from './roles.js';
import { resolveActiveUserContext } from './active-user-context.js';
import { openFirestore, signOutAndClearCache, getDocPatiently } from './firestore-cache.js';
import { activeEventIdFromPointer } from './messages-model.js';
import { loadEventMap } from './event-map.js';
import { mapImageSource } from './event-map-model.js';

// =====================================================
//  map-page.js — צפייה במפת שטח הגיבוש של האירוע הפעיל
// =====================================================
// פתוח לכל בעלי התפקידים. הקריאה דרך getDocPatiently: בלי קליטה מוצגת המפה
// ממטמון Firestore שבמכשיר, אם נפתחה בו כבר.

const firebaseApp = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(firebaseApp);
const db = openFirestore(firebaseApp);
const $ = id => document.getElementById(id);

function showEmpty(text) {
  $('map-image').hidden = true;
  $('map-zoom').hidden = true;
  $('map-empty').textContent = text;
  $('map-empty').hidden = false;
  $('map-meta').textContent = '';
}

$('map-zoom').addEventListener('click', () => {
  const full = $('map-frame').classList.toggle('full');
  $('map-zoom').textContent = full ? 'התאם למסך' : 'גודל מלא';
});

// חזרה למסך שממנו הגיעו; כניסה ישירה (קישור/מסך הבית) — למסך של התפקיד
function wireBackLink(role) {
  const back = $('map-back');
  back.href = destinationForRole(role);
  const cameFromApp = document.referrer && new URL(document.referrer).origin === location.origin &&
    !/\/(index|map)\.html/.test(new URL(document.referrer).pathname);
  if (cameFromApp) back.addEventListener('click', event => { event.preventDefault(); history.back(); });
}

onAuthStateChanged(auth, async user => {
  if (!user) { location.href = 'index.html'; return; }
  try {
    const pointerRead = getDocPatiently(doc(db, 'settings', 'activeEvent'));
    pointerRead.catch(() => {});
    const snapshot = await getDocPatiently(doc(db, 'users', user.uid));
    const rawProfile = snapshot.exists() ? snapshot.data() : null;
    const profile = rawProfile ? await resolveActiveUserContext(db, user.uid, rawProfile, { pointerRead }) : null;
    if (!profile || (!profile.approved && profile.role !== ROLES.ADMIN)) {
      await signOutAndClearCache(auth, db); location.href = 'index.html'; return;
    }
    $('map-user').textContent = `${profile.name || ''} · ${roleLabel(profile.role)}`;
    wireBackLink(profile.role);
    if (profile.eventAccess === false) { showEmpty('המשתמש אינו משובץ בסגל האירוע הפעיל. פנה למנהל.'); return; }

    const pointer = await pointerRead.then(item => (item.exists() ? item.data() : null), () => null);
    const eventId = activeEventIdFromPointer(pointer);
    if (!eventId) { showEmpty('אין כרגע גיבוש פעיל.'); return; }
    const record = await loadEventMap(db, eventId, { read: getDocPatiently });
    const source = mapImageSource(record);
    if (!source) {
      showEmpty('עדיין לא הועלתה מפה לגיבוש. מנהל או מפקד הגיבוש יכולים להעלות אותה.');
      return;
    }
    $('map-image').src = source;
    $('map-image').hidden = false;
    $('map-empty').hidden = true;
    $('map-zoom').hidden = false;
    const updated = record.updatedAt?.toDate?.();
    $('map-meta').textContent = [
      record.updatedByName ? `הועלתה על ידי ${record.updatedByName}` : '',
      updated ? updated.toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : ''
    ].filter(Boolean).join(' · ');
  } catch (error) {
    showEmpty(error?.code === 'permission-denied'
      ? 'אין הרשאה לצפות במפה של הגיבוש הזה.'
      : 'טעינת המפה נכשלה: ' + (error?.message || error));
  }
});
