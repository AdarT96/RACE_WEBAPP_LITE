import {
  deleteDoc, doc, getDoc, serverTimestamp, setDoc
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  MAP_ASSET_ID, MAP_COMPRESSION_STEPS, MAP_MAX_DATA_LENGTH, buildMapRecord, mapImageSource,
  scaledSize, validateMapImage
} from './event-map-model.js';

// =====================================================
//  event-map.js — מפת שטח הגיבוש: Firestore, דחיסה ועורך
// =====================================================
// events/{eventId}/assets/map — מסמך אחד עם התמונה (base64), סוגה ומידותיה.

export function eventMapReference(db, eventId) {
  return doc(db, 'events', String(eventId), 'assets', MAP_ASSET_ID);
}

export async function loadEventMap(db, eventId, { read = getDoc } = {}) {
  if (!eventId) return null;
  const snapshot = await read(eventMapReference(db, eventId));
  return snapshot.exists() ? snapshot.data() : null;
}

export async function saveEventMap(db, eventId, user, image) {
  const check = validateMapImage(image);
  if (!check.ok) throw new Error(check.errors.join(' '));
  await setDoc(eventMapReference(db, eventId), { ...buildMapRecord(image, user), updatedAt: serverTimestamp() });
}

export async function deleteEventMap(db, eventId) {
  await deleteDoc(eventMapReference(db, eventId));
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('לא ניתן לקרוא את התמונה. נסה קובץ JPG או PNG.')); };
    image.src = url;
  });
}

// צילום מסך או תמונה מהטלפון יכולים להיות כמה MB — מקטינים ודוחסים ל-JPEG
// עד שהם נכנסים למסמך Firestore (המפה עדיין קריאה בהגדלה).
export async function compressMapImage(file) {
  if (!file || !String(file.type || '').startsWith('image/')) throw new Error('יש לבחור קובץ תמונה.');
  const image = await loadImage(file);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  for (const [maxDimension, quality] of MAP_COMPRESSION_STEPS) {
    const size = scaledSize(image.naturalWidth, image.naturalHeight, maxDimension);
    canvas.width = size.width;
    canvas.height = size.height;
    context.fillStyle = '#ffffff';   // שקיפות ב-PNG הופכת ללבן ולא לשחור ב-JPEG
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(image, 0, 0, size.width, size.height);
    const data = canvas.toDataURL('image/jpeg', quality).split(',')[1] || '';
    if (data.length <= MAP_MAX_DATA_LENGTH) return { data, mimeType: 'image/jpeg', ...size };
  }
  throw new Error('התמונה גדולה מדי. נסה תמונה קטנה יותר.');
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// עורך המפה: תצוגה מקדימה, העלאה/החלפה ומחיקה. getEventId מחזיר את האירוע
// שהעורך מטפל בו כרגע (במסך ההגדרה — האירוע שנבחר; אצל מפקד הגיבוש — הפעיל).
export function mountEventMapEditor({ db, user, container, getEventId, onError = () => {} }) {
  if (!container) return null;
  container.replaceChildren();
  const wrap = element('div', 'event-map-editor');
  const preview = element('div', 'event-map-preview');
  const image = element('img');
  image.alt = 'מפת שטח הגיבוש';
  image.hidden = true;
  const empty = element('div', 'event-map-empty', 'עדיין לא הועלתה מפה.');
  preview.append(image, empty);

  const actions = element('div', 'event-map-actions');
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.hidden = true;
  const upload = element('button', 'btn btn-primary', 'העלה מפה');
  upload.type = 'button';
  const remove = element('button', 'btn btn-ghost', 'מחק מפה');
  remove.type = 'button';
  remove.hidden = true;
  const status = element('div', 'event-map-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  actions.append(upload, remove, input);
  wrap.append(preview, actions, status);
  container.appendChild(wrap);

  let busy = false;
  const setStatus = text => { status.textContent = text || ''; };
  const show = record => {
    const source = mapImageSource(record);
    image.hidden = !source;
    empty.hidden = Boolean(source);
    remove.hidden = !source;
    upload.textContent = source ? 'החלף מפה' : 'העלה מפה';
    if (source) image.src = source; else image.removeAttribute('src');
  };
  const setBusy = value => { busy = value; upload.disabled = value; remove.disabled = value; };

  async function refresh() {
    const eventId = getEventId();
    if (!eventId) { show(null); setStatus(''); return; }
    try { show(await loadEventMap(db, eventId)); setStatus(''); }
    catch (error) { show(null); setStatus('טעינת המפה נכשלה.'); onError(error); }
  }

  upload.addEventListener('click', () => { if (!busy) input.click(); });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    const eventId = getEventId();
    if (!file || !eventId) return;
    setBusy(true);
    setStatus('מכין את התמונה…');
    try {
      const compressed = await compressMapImage(file);
      setStatus('שומר…');
      await saveEventMap(db, eventId, user, compressed);
      show({ ...compressed });
      setStatus('המפה נשמרה. כל בעלי התפקידים יכולים לפתוח אותה מכפתור "מפה" בסרגל העליון.');
    } catch (error) {
      setStatus(error?.code === 'permission-denied' ? 'אין הרשאה לשמור את המפה באירוע הזה.' : (error?.message || 'השמירה נכשלה.'));
      onError(error);
    } finally { setBusy(false); }
  });
  remove.addEventListener('click', async () => {
    const eventId = getEventId();
    if (busy || !eventId || !confirm('למחוק את מפת השטח?')) return;
    setBusy(true);
    try { await deleteEventMap(db, eventId); show(null); setStatus('המפה נמחקה.'); }
    catch (error) { setStatus('המחיקה נכשלה.'); onError(error); }
    finally { setBusy(false); }
  });

  refresh();
  return { refresh };
}
