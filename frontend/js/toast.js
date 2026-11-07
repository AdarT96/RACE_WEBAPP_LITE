// =====================================================
//  toast.js — הודעה קופצת אחת בכל רגע
//  הודעה חדשה מחליפה את הקודמת, כך ששתי הודעות סותרות ("הסבב עדיין לא נשמר"
//  ומיד אחריה "סבב 2 הסתיים", או שגיאה לצד "נשמר") לא מוצגות יחד.
// =====================================================

const DURATION_MS = { error: 5000 };
const DEFAULT_DURATION_MS = 3800;

export function toastDuration(type) {
  return DURATION_MS[type] ?? DEFAULT_DURATION_MS;
}

export function showToast(message, type = 'info', container = document.getElementById('toast-container')) {
  if (!container) return null;
  const text = String(message ?? '');
  const current = container.firstElementChild;
  // אותה הודעה שוב (למשל לחיצה כפולה) רק מאריכה את זמן ההצגה.
  if (current && current.textContent === text && current.classList.contains(type)) {
    clearTimeout(current.expiry);
    current.expiry = setTimeout(() => current.remove(), toastDuration(type));
    return current;
  }
  [...container.children].forEach(item => clearTimeout(item.expiry));
  container.replaceChildren();
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.setAttribute('role', type === 'error' ? 'alert' : 'status');
  element.textContent = text;
  container.appendChild(element);
  element.expiry = setTimeout(() => element.remove(), toastDuration(type));
  return element;
}
