// =====================================================
//  auth.js — loaded as type="module" after firebase-config.js
//  FIREBASE_CONFIG and APP_CONFIG are globals from firebase-config.js
// =====================================================

import { initializeApp }              from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword,
         signInWithEmailAndPassword, signOut,
         onAuthStateChanged }          from "https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js";
import { getFirestore, doc, setDoc,
         getDoc, serverTimestamp }     from "https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js";

const fbApp  = initializeApp(window.FIREBASE_CONFIG);
const auth   = getAuth(fbApp);
const db     = getFirestore(fbApp);

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

// ── Registration ──────────────────────────────────────
async function registerUser() {
  const name  = val('reg-name');
  const email = val('reg-email');
  const pass  = val('reg-pass');
  const pass2 = val('reg-pass2');
  const role  = val('reg-role');
  const team  = val('reg-team');

  if (!name || !email || !pass || !role || !team)
    return showMsg('reg-msg', 'יש למלא את כל השדות.');
  if (pass.length < 8)
    return showMsg('reg-msg', 'הסיסמה חייבת להכיל לפחות 8 תווים.');
  if (pass !== pass2)
    return showMsg('reg-msg', 'הסיסמאות אינן תואמות.');
  
  const teamNum = parseInt(team);
  if (isNaN(teamNum) || teamNum < 1 || teamNum > 15)
    return showMsg('reg-msg', 'מספר צוות חייב להיות בין 1 ל-15.');

  setLoading('reg-btn', true);
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
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
    setLoading('reg-btn', false);
  }
}

// ── Login ─────────────────────────────────────────────
async function loginUser() {
  const email = val('login-email');
  const pass  = val('login-pass');
  if (!email || !pass) return showMsg('login-msg', 'יש להזין אימייל וסיסמה.');

  setLoading('login-btn', true);
  try {
    const cred = await signInWithEmailAndPassword(auth, email, pass);
    const snap = await getDoc(doc(db, 'users', cred.user.uid));

    if (!snap.exists()) {
      await signOut(auth);
      return showMsg('login-msg', 'רשומת משתמש לא נמצאה. פנה למנהל.');
    }

    const data = snap.data();
    if (!data.approved && data.role !== 'admin') {
      await signOut(auth);
      return showMsg('login-msg', '⏳ החשבון ממתין לאישור מנהל.', 'warning');
    }

    // Route based on role
    if (data.role === 'admin') {
      window.location.href = 'admin.html';
    } else {
      window.location.href = 'app.html';
    }
  } catch(err) {
    showMsg('login-msg', firebaseErrMsg(err.code));
  } finally {
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