// =====================================================
//  auth.js — loaded as type="module" after firebase-config.js
//  FIREBASE_CONFIG and APP_CONFIG are globals from firebase-config.js
// =====================================================

import { initializeApp }              from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword,
         signInWithEmailAndPassword, signOut,
         onAuthStateChanged }          from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { doc, setDoc,
         getDoc, serverTimestamp }     from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";
import { ROLES, destinationForRole, isKnownRole, roleNeedsTeam } from './roles.js';
import { SCHEDULE_MAX_TEAMS } from './schedule-model.js';
import { resolveActiveUserContext } from './active-user-context.js';
import { openFirestore } from './firestore-cache.js';

const fbApp  = initializeApp(window.FIREBASE_CONFIG);
const auth   = getAuth(fbApp);
const db     = openFirestore(fbApp);

// ── Helpers ──────────────────────────────────────────
const $  = id => document.getElementById(id);
const val = id => ($( id)?.value?.trim() ?? '');

function showMsg(id, msg, type = 'danger') {
  const el = $(id);
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  el.style.display = '';
}

function setLoading(btnId, loading) {
  const btn = $(btnId);
  if (!btn) return;
  if (loading) { btn.dataset.label = btn.dataset.label || btn.textContent; }
  btn.disabled   = loading;
  btn.innerHTML  = loading ? '<span class="spinner"></span> אנא המתן…' : btn.dataset.label;
}

function firebaseErrMsg(code) {
  return ({
    'auth/email-already-in-use': 'אימייל זה כבר רשום במערכת.',
    'auth/invalid-email':        'כתובת אימייל לא תקינה.',
    'auth/weak-password':        'סיסמה חלשה מדי (מינימום 8 תווים).',
    'auth/user-not-found':       'לא נמצא חשבון עם אימייל זה.',
    'auth/wrong-password':       'סיסמה שגויה.',
    'auth/invalid-credential':   'אימייל או סיסמה שגויים.',
    'auth/too-many-requests':    'יותר מדי ניסיונות. נסה שוב מאוחר יותר.',
    'auth/network-request-failed': 'שגיאת רשת. בדוק את החיבור.',
  })[code] || `שגיאה (${code})`;
}

// פעולה שמתעכבת (קליטה חלשה) לא נשארת ספינר שקט: אחרי כמה שניות מסבירים מה קורה.
const SLOW_NOTICE_MS = 8000;
function slowNotice(msgId, text) {
  const timer = setTimeout(() => showMsg(msgId, text, 'warning'), SLOW_NOTICE_MS);
  return () => clearTimeout(timer);
}

// הרשמה שנקטעה אחרי יצירת החשבון ולפני שמירת הפרופיל השאירה חשבון בלי פרופיל:
// "אימייל זה כבר רשום" בהרשמה ו"רשומה לא נמצאה" בכניסה, בלי דרך החוצה. אותו
// אימייל וסיסמה משלימים עכשיו את ההרשמה; חשבון שיש לו פרופיל נשאר "כבר רשום".
async function createOrResumeAccount(email, pass) {
  try {
    return await createUserWithEmailAndPassword(auth, email, pass);
  } catch (err) {
    if (err.code !== 'auth/email-already-in-use') throw err;
    let cred;
    try { cred = await signInWithEmailAndPassword(auth, email, pass); } catch (_) { throw err; }
    const existing = await getDoc(doc(db, 'users', cred.user.uid));
    if (existing.exists()) { await signOut(auth); throw err; }
    return cred;
  }
}

// ── Registration ──────────────────────────────────────
async function registerUser() {
  const name  = val('reg-name');
  const email = val('reg-email');
  const pass  = val('reg-pass');
  const pass2 = val('reg-pass2');
  const role  = val('reg-role');
  const team  = val('reg-team');

  if (!name || !email || !pass || !role || (roleNeedsTeam(role) && !team))
    return showMsg('reg-msg', 'יש למלא את כל השדות.');
  if (!isKnownRole(role) || role === ROLES.ADMIN)
    return showMsg('reg-msg', 'התפקיד שנבחר אינו תקין.');
  if (pass.length < 8)
    return showMsg('reg-msg', 'הסיסמה חייבת להכיל לפחות 8 תווים.');
  if (pass !== pass2)
    return showMsg('reg-msg', 'הסיסמאות אינן תואמות.');
  
  const teamNum = roleNeedsTeam(role) ? parseInt(team) : null;
  if (roleNeedsTeam(role) && (isNaN(teamNum) || teamNum < 1 || teamNum > SCHEDULE_MAX_TEAMS))
    return showMsg('reg-msg', `מספר צוות חייב להיות בין 1 ל-${SCHEDULE_MAX_TEAMS}.`);

  setLoading('reg-btn', true);
  const stopSlowNotice = slowNotice('reg-msg', 'השמירה מתעכבת — כנראה קליטה חלשה. נא לא לסגור את הדף.');
  try {
    const cred = await createOrResumeAccount(email, pass);
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid:       cred.user.uid,
      name,
      email,
      role,
      team:      teamNum,
      approved:  false,
      createdAt: serverTimestamp()
    });
    $('reg-form').style.display = 'none';
    showMsg('reg-msg', '✅ החשבון נוצר! ממתין לאישור מנהל.', 'success');
    await signOut(auth);
  } catch(err) {
    showMsg('reg-msg', firebaseErrMsg(err.code));
  } finally {
    stopSlowNotice();
    setLoading('reg-btn', false);
  }
}

// ── Login ─────────────────────────────────────────────
async function loginUser() {
  const email = val('login-email');
  const pass  = val('login-pass');
  if (!email || !pass) return showMsg('login-msg', 'יש להזין אימייל וסיסמה.');

  setLoading('login-btn', true);
  const stopSlowNotice = slowNotice('login-msg', 'הכניסה מתעכבת — כנראה קליטה חלשה. נא להמתין.');
  try {
    const cred = await signInWithEmailAndPassword(auth, email, pass);
    const snap = await getDoc(doc(db, 'users', cred.user.uid));

    if (!snap.exists()) {
      await signOut(auth);
      return showMsg('login-msg', 'ההרשמה לא הושלמה. עברו ללשונית "הרשמה" ומלאו שוב את הפרטים עם אותו אימייל וסיסמה.');
    }

    const data = snap.data();
    if (!data.approved && data.role !== 'admin') {
      await signOut(auth);
      return showMsg('login-msg', '⏳ החשבון ממתין לאישור מנהל.', 'warning');
    }

    const context = await resolveActiveUserContext(db, cred.user.uid, data);
    if (context.eventAccess === false) {
      await signOut(auth);
      return showMsg('login-msg', 'החשבון מאושר, אך אינו משובץ בסגל האירוע הפעיל. פנה למנהל.', 'warning');
    }
    window.location.href = destinationForRole(context.role);
  } catch(err) {
    showMsg('login-msg', firebaseErrMsg(err.code));
  } finally {
    stopSlowNotice();
    setLoading('login-btn', false);
  }
}

// ── Tab Init ──────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.style.display = 'none');
    btn.classList.add('active');
    const pane = document.getElementById(target);
    if (pane) pane.style.display = '';
  });
});

// Expose to inline onclick handlers
window.registerUser = registerUser;
window.loginUser    = loginUser;
