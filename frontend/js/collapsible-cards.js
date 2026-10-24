// =====================================================
//  collapsible-cards.js — כרטיסים שהמשתמש מכווץ ופותח בעצמו
// =====================================================
// כל אחד בוחר מה לראות ומפנה מקום במסך. המצב נשמר במכשיר, לכל דף ולכל כרטיס
// בנפרד, ונשאר גם אחרי רענון.
//
//   <section data-collapsible="teams">
//     <h2 data-collapsible-head>מצב הצוותים</h2>   ← נשאר גלוי (ברירת מחדל: הילד הראשון)
//     <div data-collapsible-keep>…</div>           ← נשאר גלוי גם כשהכרטיס מכווץ
//     …                                             ← מוסתר כשהכרטיס מכווץ
//   </section>
//
// data-collapsed-default="1" — מכווץ כל עוד המשתמש לא בחר אחרת.

const STORAGE_PREFIX = 'lite:card:';

function storageKey(id) {
  const page = location.pathname.split('/').pop() || 'index.html';
  return `${STORAGE_PREFIX}${page}:${id}`;
}

// בלי בחירה שמורה — ברירת המחדל של הכרטיס (data-collapsed-default="1" = מכווץ)
function readCollapsed(id, fallback = false) {
  try {
    const saved = localStorage.getItem(storageKey(id));
    return saved == null ? fallback : saved === '1';
  } catch (error) { return fallback; }
}

function writeCollapsed(id, collapsed) {
  try { localStorage.setItem(storageKey(id), collapsed ? '1' : '0'); } catch (error) { /* מצב פרטי — לא נשמר */ }
}

// אפשר לקרוא שוב אחרי שנוסף תוכן; כרטיס שכבר הוכן מדולג.
export function initCollapsibleCards(root = document) {
  root.querySelectorAll('[data-collapsible]').forEach(card => {
    if (card.dataset.collapsibleReady) return;
    const id = card.dataset.collapsible;
    const head = card.querySelector(':scope > [data-collapsible-head]') || card.firstElementChild;
    if (!id || !head) return;
    card.dataset.collapsibleReady = '1';
    head.setAttribute('data-collapsible-head', '');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'card-collapse-btn';
    const title = (head.querySelector('h1, h2, h3')?.textContent || '').trim();
    const apply = collapsed => {
      card.classList.toggle('is-collapsed', collapsed);
      button.setAttribute('aria-expanded', String(!collapsed));
      const label = collapsed ? 'הצג' : 'כווץ';
      button.setAttribute('aria-label', title ? `${label}: ${title}` : label);
      button.title = collapsed ? 'הצג את הכרטיס' : 'כווץ את הכרטיס';
    };
    apply(readCollapsed(id, card.dataset.collapsedDefault === '1'));
    button.addEventListener('click', event => {
      event.stopPropagation();
      const collapsed = !card.classList.contains('is-collapsed');
      apply(collapsed);
      writeCollapsed(id, collapsed);
    });
    card.appendChild(button);
  });
}
