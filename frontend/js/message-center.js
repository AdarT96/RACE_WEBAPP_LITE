import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import { createMessagesRepository } from './messages-repository.js';
import {
  MESSAGE_MAX_LENGTH, MESSAGE_RECIPIENT_ROLES, activeEventIdFromPointer, badgeText, canSendMessages,
  collapsedToastText, createMessageFeed, formatMessageTime, messageRoleLabel, planToastCards,
  previewText, unreadSummaryText, validateMessageDraft
} from './messages-model.js';

// =====================================================
//  message-center.js — פעמון, מגירת היסטוריה וכרטיסי התראה
// =====================================================
// נקודת כניסה אחת לכל דף: mountMessageCenter({ db, user, role, anchor, ... }).
// המסך שהמשתמש פתח מוצג קודם: בניית הפעמון זולה ואינה קוראת כלום, והמאזינים
// ל-Firestore מתחילים רק דרך gate.background() אחרי שהתצוגה הראשית הוצגה.
// כתיבה (שליחת הודעה, סימון כנקרא) אינה נדחית.
//
// הכרטיסים הקופצים אינם חוסמים: המכל קבוע, בלי אירועי מצביע, ורק הכרטיס
// עצמו מקבל לחיצות. הם חיים 12 שניות, ולחיצה על כרטיס פותחת את ההיסטוריה.

// ההתראה יושבת מתחת לסרגל העליון; קצרה, כדי שלא תסתיר את המסך זמן רב.
const TOAST_LIFETIME_MS = 7000;
const SUMMARY_SEEN_PREFIX = 'lite:mc-summary:';
const MARK_READ_THROTTLE_MS = 2000;
const SENT_NOTICE_MS = 4000;

const BELL_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function friendlySendError(error) {
  if (error?.code === 'permission-denied') return 'אין הרשאה לשלוח הודעה (ייתכן שהאירוע אינו פעיל).';
  return error?.message || 'השליחה נכשלה.';
}

export function mountMessageCenter({
  db, user, role, anchor, eventId = undefined, resolveEventId = null, gate = null
}) {
  if (!db || !user?.uid || !anchor) return null;

  const repository = createMessagesRepository(db, { uid: user.uid, name: user.name || '', role });
  const canSend = canSendMessages(role);

  const state = {
    eventId: eventId === undefined ? undefined : String(eventId || ''),
    feed: createMessageFeed({ uid: user.uid }),
    started: false,
    disposed: false,
    open: false,
    messages: [],
    unreadCount: 0,
    loaded: false,
    failed: false,
    highlightAfterMs: 0,
    unsubscribers: [],
    toastItems: [],
    toastTimer: null,
    lastMarkAt: 0,
    sending: false,
    noticeTimer: null
  };

  // ───── DOM ─────
  const bell = element('button', 'mc-bell');
  bell.type = 'button';
  bell.innerHTML = BELL_ICON;
  bell.setAttribute('aria-haspopup', 'dialog');
  const badge = element('span', 'mc-badge');
  badge.hidden = true;
  bell.appendChild(badge);

  const toasts = element('div', 'mc-toasts');
  toasts.setAttribute('role', 'status');
  toasts.setAttribute('aria-live', 'polite');

  const backdrop = element('div', 'mc-backdrop');
  const drawer = element('aside', 'mc-drawer');
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-modal', 'true');
  drawer.setAttribute('aria-label', 'הודעות');
  drawer.setAttribute('aria-hidden', 'true');

  const drawerHead = element('div', 'mc-drawer-head');
  drawerHead.appendChild(element('h2', 'mc-drawer-title', 'הודעות'));
  const closeButton = element('button', 'mc-icon-button', '✕');
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'סגירה');
  drawerHead.appendChild(closeButton);
  drawer.appendChild(drawerHead);

  const drawerBody = element('div', 'mc-drawer-body');
  drawer.appendChild(drawerBody);

  let compose = null;
  if (canSend) {
    compose = buildCompose();
    drawerBody.appendChild(compose.form);
  }
  const listNode = element('div', 'mc-list');
  drawerBody.appendChild(listNode);

  function buildCompose() {
    const form = element('form', 'mc-compose');
    form.noValidate = true;
    const label = element('label', 'mc-compose-label', 'הודעה חדשה');
    const textarea = element('textarea', 'mc-textarea');
    textarea.rows = 3;
    textarea.maxLength = MESSAGE_MAX_LENGTH;
    textarea.placeholder = 'כתבו את ההודעה…';
    textarea.id = 'mc-compose-text';
    label.htmlFor = textarea.id;
    const counter = element('div', 'mc-counter', `0/${MESSAGE_MAX_LENGTH}`);
    const roles = element('fieldset', 'mc-roles');
    roles.appendChild(element('legend', 'mc-roles-legend', 'נמענים'));
    const checkboxes = new Map();
    MESSAGE_RECIPIENT_ROLES.forEach(recipient => {
      const chip = element('label', 'mc-role-choice');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = recipient;
      chip.append(box, element('span', null, messageRoleLabel(recipient)));
      roles.appendChild(chip);
      checkboxes.set(recipient, box);
    });
    const send = element('button', 'btn btn-primary mc-send', 'שליחה');
    send.type = 'submit';
    const status = element('div', 'mc-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const disabledNote = element('div', 'mc-disabled-note', 'אין אירוע פעיל — לא ניתן לשלוח הודעות.');
    disabledNote.hidden = true;
    form.append(label, textarea, counter, roles, send, status, disabledNote);
    textarea.addEventListener('input', () => {
      counter.textContent = `${textarea.value.length}/${MESSAGE_MAX_LENGTH}`;
      if (status.dataset.kind === 'error') setStatus('');
    });
    form.addEventListener('submit', event => { event.preventDefault(); submitCompose(); });
    return { form, textarea, counter, checkboxes, send, status, disabledNote };
  }

  function setStatus(message, kind = '') {
    if (!compose) return;
    compose.status.textContent = message;
    compose.status.dataset.kind = kind;
    clearTimeout(state.noticeTimer);
    if (kind === 'ok') state.noticeTimer = setTimeout(() => setStatus(''), SENT_NOTICE_MS);
  }

  function refreshComposeAvailability() {
    if (!compose) return;
    const noEvent = state.eventId === '';
    compose.disabledNote.hidden = !noEvent;
    compose.send.disabled = noEvent || state.sending;
    compose.textarea.disabled = noEvent;
    compose.checkboxes.forEach(box => { box.disabled = noEvent; });
  }

  async function submitCompose() {
    if (state.sending || state.eventId === '') return;
    const draft = validateMessageDraft({
      text: compose.textarea.value,
      targetRoles: [...compose.checkboxes].filter(([, box]) => box.checked).map(([role_]) => role_)
    });
    if (!draft.ok) { setStatus(draft.errors[0], 'error'); return; }
    state.sending = true;
    compose.send.textContent = 'שולח…';
    refreshComposeAvailability();
    setStatus('');
    try {
      const targetEvent = await ensureEventId();
      await repository.send(targetEvent, draft);
      compose.textarea.value = '';
      compose.counter.textContent = `0/${MESSAGE_MAX_LENGTH}`;
      setStatus('ההודעה נשלחה.', 'ok');
    } catch (error) {
      setStatus(friendlySendError(error), 'error');
    } finally {
      state.sending = false;
      compose.send.textContent = 'שליחה';
      refreshComposeAvailability();
    }
  }

  // ───── אירוע פעיל ─────
  let eventResolution = null;
  function ensureEventId() {
    if (state.eventId !== undefined) return Promise.resolve(state.eventId);
    if (!eventResolution) {
      const resolver = resolveEventId || (async () => {
        const pointer = await getDoc(doc(db, 'settings', 'activeEvent'));
        return activeEventIdFromPointer(pointer.exists() ? pointer.data() : null);
      });
      eventResolution = Promise.resolve().then(resolver).then(
        id => { if (state.eventId === undefined) state.eventId = String(id || ''); return state.eventId; },
        error => { eventResolution = null; throw error; }
      );
    }
    return eventResolution;
  }

  function teardownListeners() {
    state.unsubscribers.splice(0).forEach(unsubscribe => { try { unsubscribe(); } catch (error) { /* כבר נוקה */ } });
    state.feed = createMessageFeed({ uid: user.uid });
    state.messages = [];
    state.unreadCount = 0;
    state.loaded = false;
    state.failed = false;
    clearToasts();
  }

  function startListening() {
    if (state.disposed || !state.started || !state.eventId) { render(); return; }
    const currentEvent = state.eventId;
    const feedAtStart = state.feed;
    const fail = error => {
      if (state.feed !== feedAtStart) return;
      console.warn('[messages]', error?.code || error);
      state.failed = true;
      render();
    };
    state.unsubscribers.push(
      repository.subscribeReadState(currentEvent, snapshot => {
        if (state.feed !== feedAtStart) return;
        handleFeedResult(feedAtStart.applyReadState(snapshot));
      }, fail),
      repository.subscribe(currentEvent, snapshot => {
        if (state.feed !== feedAtStart) return;
        state.loaded = true;
        state.failed = false;
        handleFeedResult(feedAtStart.applyMessages(snapshot));
      }, fail)
    );
    render();
  }

  function handleFeedResult(result) {
    state.messages = result.messages;
    state.unreadCount = result.unreadCount;
    if (state.open) {
      // המגירה פתוחה: מה שמגיע נקרא מיד ואינו קופץ.
      markReadNow();
    } else {
      if (result.summaryCount > 0 && summaryIsNew(result.summaryCount)) pushSummary(result.summaryCount);
      if (result.toasts.length) pushToasts(result.toasts);
    }
    render();
  }

  function markReadNow({ force = false } = {}) {
    const now = Date.now();
    state.unreadCount = state.feed.markAllReadLocally().unreadCount;
    if ((!force && now - state.lastMarkAt < MARK_READ_THROTTLE_MS) || !state.eventId) return;
    state.lastMarkAt = now;
    repository.markRead(state.eventId).catch(error => console.warn('[messages] markRead', error?.code || error));
  }

  // ───── כרטיסים קופצים ─────
  function vibrate() {
    try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(120); } catch (error) { /* לא נתמך */ }
  }

  // "יש לך N הודעות שלא נקראו" עולה בכל פתיחת דף. מציגים אותו פעם אחת בכל
  // שימוש (לשונית), ושוב רק אם נוספו הודעות שלא נקראו מאז.
  function summaryIsNew(count) {
    const key = `${SUMMARY_SEEN_PREFIX}${user.uid}:${state.eventId || ''}`;
    try {
      if (Number(sessionStorage.getItem(key) || 0) >= count) return false;
      sessionStorage.setItem(key, String(count));
    } catch (error) { /* בלי אחסון — מציגים */ }
    return true;
  }

  function pushSummary(count) {
    state.toastItems = state.toastItems.filter(item => item.kind !== 'summary');
    state.toastItems.unshift({
      kind: 'summary', text: unreadSummaryText(count), expiresAt: Date.now() + TOAST_LIFETIME_MS
    });
    vibrate();
    renderToasts();
    scheduleToastExpiry();
  }

  function pushToasts(messages) {
    const expiresAt = Date.now() + TOAST_LIFETIME_MS;
    messages.forEach(message => state.toastItems.push({ kind: 'message', message, expiresAt }));
    vibrate();
    renderToasts();
    scheduleToastExpiry();
  }

  function clearToasts() {
    state.toastItems = [];
    clearTimeout(state.toastTimer);
    renderToasts();
  }

  function scheduleToastExpiry() {
    clearTimeout(state.toastTimer);
    if (!state.toastItems.length) return;
    const next = Math.min(...state.toastItems.map(item => item.expiresAt));
    state.toastTimer = setTimeout(() => {
      const now = Date.now();
      state.toastItems = state.toastItems.filter(item => item.expiresAt > now);
      renderToasts();
      scheduleToastExpiry();
    }, Math.max(200, next - Date.now()));
  }

  function toastCard(headline, body, onDismiss) {
    const card = element('div', 'mc-toast');
    const content = element('div', 'mc-toast-content');
    content.appendChild(element('div', 'mc-toast-title', headline));
    if (body) content.appendChild(element('div', 'mc-toast-body', body));
    content.tabIndex = 0;
    content.setAttribute('role', 'button');
    content.addEventListener('click', openDrawer);
    content.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDrawer(); }
    });
    const dismiss = element('button', 'mc-icon-button', '✕');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', 'סגירת ההתראה');
    dismiss.addEventListener('click', event => { event.stopPropagation(); onDismiss(); });
    card.append(content, dismiss);
    return card;
  }

  function renderToasts() {
    toasts.textContent = '';
    // מתחת לסרגל העליון של הדף. בטלפון הוא נשבר לכמה שורות, וגובה קבוע ב-CSS
    // הניח את ההתראה על "התנתק" ו"פאנל מנהל".
    const navbar = anchor?.closest?.('.navbar') || document.querySelector('.navbar');
    if (navbar) toasts.style.top = `${Math.max(8, Math.round(navbar.getBoundingClientRect().bottom) + 8)}px`;
    const summary = state.toastItems.find(item => item.kind === 'summary');
    const messageItems = state.toastItems.filter(item => item.kind === 'message');
    if (summary) {
      toasts.appendChild(toastCard(summary.text, '', () => {
        state.toastItems = state.toastItems.filter(item => item !== summary);
        renderToasts();
      }));
    }
    const plan = planToastCards(messageItems);
    if (plan.collapsed) {
      toasts.appendChild(toastCard(collapsedToastText(plan.count), '', () => {
        state.toastItems = state.toastItems.filter(item => item.kind !== 'message');
        renderToasts();
      }));
    } else {
      plan.cards.forEach(item => {
        const { message } = item;
        const sender = message.senderName ? `${message.senderName} · ${messageRoleLabel(message.senderRole)}` : messageRoleLabel(message.senderRole);
        toasts.appendChild(toastCard(sender, previewText(message.text), () => {
          state.toastItems = state.toastItems.filter(candidate => candidate !== item);
          renderToasts();
        }));
      });
    }
  }

  // ───── מגירה ─────
  function renderList() {
    listNode.textContent = '';
    if (state.eventId === '') {
      listNode.appendChild(element('p', 'mc-empty', 'אין אירוע פעיל. הודעות יופיעו כאן כשיתחיל אירוע.'));
      return;
    }
    if (state.failed && !state.messages.length) {
      listNode.appendChild(element('p', 'mc-empty', 'לא ניתן לטעון הודעות כרגע.'));
      return;
    }
    if (!state.loaded && !state.messages.length) {
      listNode.appendChild(element('p', 'mc-empty', 'טוען הודעות…'));
      return;
    }
    if (!state.messages.length) {
      listNode.appendChild(element('p', 'mc-empty', 'אין הודעות עדיין.'));
      return;
    }
    state.messages.forEach(message => {
      const isNew = message.senderUid !== user.uid && message.createdAtMs > state.highlightAfterMs;
      const card = element('article', 'mc-message' + (isNew ? ' mc-new' : ''));
      const head = element('div', 'mc-message-head');
      const sender = message.senderName
        ? `${message.senderName} · ${messageRoleLabel(message.senderRole)}` : messageRoleLabel(message.senderRole);
      head.appendChild(element('strong', 'mc-sender', sender));
      head.appendChild(element('time', 'mc-time', formatMessageTime(message.createdAtMs)));
      card.appendChild(head);
      card.appendChild(element('p', 'mc-text', message.text));
      const chips = element('div', 'mc-chips');
      message.targetRoles.forEach(target => chips.appendChild(element('span', 'mc-chip', messageRoleLabel(target))));
      card.appendChild(chips);
      listNode.appendChild(card);
    });
  }

  function render() {
    if (state.disposed) return;
    const count = state.unreadCount;
    badge.hidden = count <= 0;
    badge.textContent = badgeText(count);
    bell.setAttribute('aria-label', count > 0 ? `הודעות, ${count} שלא נקראו` : 'הודעות');
    refreshComposeAvailability();
    renderList();
  }

  function openDrawer() {
    if (state.disposed || state.open) return;
    state.open = true;
    state.highlightAfterMs = state.feed.lastReadAtMs;
    clearToasts();
    drawer.classList.add('mc-open');
    backdrop.classList.add('mc-open');
    drawer.setAttribute('aria-hidden', 'false');
    bell.setAttribute('aria-expanded', 'true');
    markReadNow();
    render();
    closeButton.focus({ preventScroll: true });
  }

  function closeDrawer() {
    if (!state.open) return;
    state.open = false;
    markReadNow({ force: true });
    render();
    drawer.classList.remove('mc-open');
    backdrop.classList.remove('mc-open');
    drawer.setAttribute('aria-hidden', 'true');
    bell.setAttribute('aria-expanded', 'false');
    bell.focus({ preventScroll: true });
  }

  const onKeydown = event => { if (event.key === 'Escape') closeDrawer(); };
  bell.addEventListener('click', () => (state.open ? closeDrawer() : openDrawer()));
  closeButton.addEventListener('click', closeDrawer);
  backdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', onKeydown);
  bell.setAttribute('aria-expanded', 'false');

  anchor.prepend(bell);
  document.body.append(toasts, backdrop, drawer);
  render();

  // ───── התחלה אחרי התצוגה הראשית ─────
  async function start() {
    if (state.disposed || state.started) return;
    state.started = true;
    try {
      await ensureEventId();
    } catch (error) {
      console.warn('[messages] active event', error?.code || error);
      state.eventId = undefined;
      state.started = false;
      state.failed = true;
      render();
      return;
    }
    startListening();
  }
  if (gate) gate.background(start); else start();

  return {
    // הדף יודע שהאירוע הפעיל התחלף (או נודע לו לראשונה).
    setEventId(next) {
      const id = String(next || '');
      if (state.disposed || state.eventId === id) return;
      teardownListeners();
      state.eventId = id;
      if (state.started) startListening(); else render();
    },
    open: openDrawer,
    close: closeDrawer,
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      teardownListeners();
      clearTimeout(state.noticeTimer);
      document.removeEventListener('keydown', onKeydown);
      bell.remove(); toasts.remove(); backdrop.remove(); drawer.remove();
    }
  };
}
