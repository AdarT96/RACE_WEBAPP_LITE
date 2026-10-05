// =====================================================
//  load-priority.js — מה שהמשתמש ביקש נטען ראשון
// =====================================================
// עבודת רקע (מנויים משלימים, טעינות שהמסך הנוכחי לא צריך) ממתינה עד
// שהתצוגה הראשית הוצגה, כדי לא להתחרות איתה על החיבור ל-Firestore.
// כתיבות לעולם אינן עוברות כאן — שמירה יוצאת מיד, בלי להמתין לשום דבר.

const timingEnabled = (() => {
  try { return new URLSearchParams(location.search).get('debug') === 'timing'; }
  catch (error) { return false; }
})();
const timingEntries = [];

// מדידת זמני טעינה. פעילה רק עם ?debug=timing בכתובת; הזמנים נמדדים
// מתחילת הניווט לדף, כך שהם כוללים גם את הורדת הקבצים עצמם.
export function markLoad(label) {
  if (!timingEnabled) return;
  const ms = Math.round(performance.now());
  const previous = timingEntries[timingEntries.length - 1];
  timingEntries.push({ label: String(label), ms, delta: previous ? ms - previous.ms : ms });
  console.info(`[timing] ${label}: ${ms}ms`);
  renderTiming();
}

function renderTiming() {
  if (!document.body) return;
  let panel = document.getElementById('load-timing-panel');
  if (!panel) {
    panel = document.createElement('pre');
    panel.id = 'load-timing-panel';
    panel.dir = 'ltr';
    panel.style.cssText = 'position:fixed; left:8px; bottom:8px; z-index:5000; margin:0; ' +
      'max-width:calc(100vw - 16px); max-height:45vh; overflow:auto; padding:8px 10px; ' +
      'border-radius:8px; background:rgba(0,0,0,.82); color:#e5e7eb; ' +
      'font:11px/1.45 ui-monospace,Consolas,monospace; pointer-events:auto;';
    panel.title = 'לחיצה מסתירה';
    panel.addEventListener('click', () => { panel.hidden = true; });
    document.body.appendChild(panel);
  }
  panel.textContent = timingEntries
    .map(entry => `${String(entry.ms).padStart(6)}ms  +${String(entry.delta).padStart(5)}  ${entry.label}`)
    .join('\n');
}

function runSafely(task) {
  try {
    const result = task();
    if (result && typeof result.catch === 'function') {
      result.catch(error => console.warn('[background]', error));
    }
  } catch (error) {
    console.warn('[background]', error);
  }
}

// שער אחד לכל דף: background() מתזמן עבודת רקע, release() נקרא כשהתצוגה
// הראשית הוצגה. לאחר השחרור background() מריץ מיד.
export function createForegroundGate() {
  let released = false;
  const pending = [];
  return {
    get released() { return released; },
    background(task) {
      if (released) runSafely(task);
      else pending.push(task);
    },
    release() {
      if (released) return;
      released = true;
      markLoad('background work starts');
      pending.splice(0).forEach(runSafely);
    }
  };
}
