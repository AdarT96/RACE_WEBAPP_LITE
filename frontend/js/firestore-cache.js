// =====================================================
//  firestore-cache.js — מטמון מקומי של Firestore בכל הדפים
// =====================================================
// הנתונים שנקראו נשמרים במכשיר (IndexedDB). פתיחה חוזרת של דף מציגה מיד את
// מה שכבר נשמר ומתעדכנת מהשרת ברקע, ושמירה שנעשתה בלי קליטה נשלחת כשהקליטה
// חוזרת — גם אם הדף נסגר ונפתח בינתיים. אם הדפדפן לא מאפשר IndexedDB
// (למשל גלישה פרטית), Firestore עובר לבד לזיכרון רגיל כמו קודם.
//
// כתיבות שבהן מסך ישן מהמטמון עלול להטעות (קליטה, נשירה, לו״ז) עוברות בטרנזקציה
// מול השרת. הערכה וסדר הגעה של מעריך — מסמכים שרק הוא כותב — נכתבים קודם
// במכשיר ונשלחים בתור כשיש קליטה; התחלה/סיום סבב הם שמירה אחת שהשרת אוכף.

import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager,
  waitForPendingWrites, terminate, clearIndexedDbPersistence, getDoc
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import { signOut } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';

const PENDING_WRITES_TIMEOUT_MS = 3000;

export function openFirestore(app) {
  try {
    return initializeFirestore(app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (error) {
    // כבר אותחל באותו דף — מחזירים את המופע הקיים.
    return getFirestore(app);
  }
}

// קריאות הפתיחה של דף (פרופיל, אירוע פעיל, שיבוץ). Firestore מחזיר "unavailable"
// כשהוא עדיין לא התחבר והמסמך לא שמור במכשיר: כ-5 שניות אחרי שהדפדפן נסגר בכוח
// (עד שהנעילה של המטמון המשותף פגה), ויותר מזה בקליטה חלשה. קודם הדף נתקע על
// "טעינה נכשלה" או נשאר ריק; עכשיו ממשיכים לנסות עד דקה, והדף נשאר במצב "טוען"
// ומתאושש לבד כשהחיבור נפתח. כשל מסוג אחר נזרק מיד.
export async function getDocPatiently(reference, { budgetMs = 60000 } = {}) {
  const deadline = Date.now() + budgetMs;
  for (let delay = 1000; ; delay = Math.min(delay * 1.5, 5000)) {
    try {
      return await getDoc(reference);
    } catch (error) {
      if (error?.code !== 'unavailable' || Date.now() + delay > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// יציאה מנקה את המטמון כדי שמשתמש אחר באותו מכשיר לא יראה נתונים שנשמרו.
// שמירות שעדיין לא נשלחו קודמות לניקוי: אם אין קליטה והן לא יצאו תוך כמה
// שניות, המטמון נשאר והן יישלחו בכניסה הבאה של אותו משתמש במכשיר.
export async function signOutAndClearCache(auth, db) {
  const flushed = await Promise.race([
    waitForPendingWrites(db).then(() => true, () => false),
    new Promise(resolve => setTimeout(() => resolve(false), PENDING_WRITES_TIMEOUT_MS))
  ]);
  await signOut(auth);
  if (!flushed) return;
  try {
    await terminate(db);
    await clearIndexedDbPersistence(db);
  } catch (error) {
    // לשונית אחרת של האפליקציה עדיין פתוחה ומחזיקה את המטמון.
    console.warn('[firestore-cache] local cache not cleared:', error?.code || error);
  }
}
