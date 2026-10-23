// =====================================================
//  messages-model.js — הודעות פנימיות: מודל טהור
// =====================================================
// ללא Firestore ובלי DOM: תפקידי נמענים, ולידציה, ספירת "לא נקראו",
// מיון ועיצוב. הכללים בשרת (firestore.rules) הם גבול ההרשאה האמיתי;
// הקובץ הזה רק משקף אותם כדי שהממשק לא ישלח מה שיידחה.

import { ROLES, roleLabel } from './roles.js';

export const MESSAGE_SCHEMA_VERSION = 1;
export const MESSAGE_MAX_LENGTH = 1000;
export const MESSAGE_TOAST_LIMIT = 3;

// שלישות היא תפקיד שנוסף במקביל בענף אחר; ייתכן ש-roles.js עדיין לא מכיר אותו.
export const ADJUTANT_ROLE = 'adjutant';

// סדר התצוגה בטופס ובצ׳יפים. חייב להיות זהה לרשימה בחוקי Firestore.
export const MESSAGE_RECIPIENT_ROLES = Object.freeze([
  ROLES.OPERATOR, ROLES.EVALUATOR, ROLES.FORMATION_COMMANDER, ADJUTANT_ROLE, ROLES.ADMIN
]);

const FALLBACK_LABELS = Object.freeze({
  [ROLES.OPERATOR]: 'מפק״צ',
  [ROLES.EVALUATOR]: 'מעריך',
  [ROLES.FORMATION_COMMANDER]: 'מפקד הגיבוש',
  [ADJUTANT_ROLE]: 'שלישות',
  [ROLES.ADMIN]: 'מנהל'
});

export function messageRoleLabel(role) {
  const key = String(role || '');
  const shared = roleLabel(key);
  // roleLabel מחזיר את המזהה עצמו כשאינו מכיר את התפקיד.
  if (shared && shared !== key) return shared;
  return FALLBACK_LABELS[key] || key;
}

// רק מנהל ומפקד הגיבוש שולחים, והם גם רואים את כל הודעות האירוע.
export function canSendMessages(role) {
  return [ROLES.ADMIN, ROLES.FORMATION_COMMANDER].includes(String(role || ''));
}

export const canSeeAllMessages = canSendMessages;

export function isRecipientRole(role) {
  return MESSAGE_RECIPIENT_ROLES.includes(String(role || ''));
}

// מחזיר את הנמענים בסדר הקבוע, בלי כפילויות ובלי תפקידים לא מוכרים.
export function normalizeTargetRoles(roles) {
  const wanted = new Set(Array.isArray(roles) ? roles.map(String) : []);
  return MESSAGE_RECIPIENT_ROLES.filter(role => wanted.has(role));
}

export function validateMessageDraft({ text, targetRoles } = {}) {
  const cleanText = String(text ?? '').trim();
  const roles = normalizeTargetRoles(targetRoles);
  const errors = [];
  if (!cleanText) errors.push('יש לכתוב את תוכן ההודעה.');
  else if (cleanText.length > MESSAGE_MAX_LENGTH) errors.push(`ההודעה ארוכה מדי (עד ${MESSAGE_MAX_LENGTH} תווים).`);
  if (!roles.length) errors.push('יש לבחור לפחות נמען אחד.');
  return { ok: errors.length === 0, errors, text: cleanText, targetRoles: roles };
}

// המסמך שנכתב ל-Firestore. createdAt מוזרק על ידי ה-repository (serverTimestamp).
export function buildMessageData({ text, targetRoles }, sender, createdAt) {
  const draft = validateMessageDraft({ text, targetRoles });
  if (!draft.ok) throw new Error(draft.errors[0]);
  if (!canSendMessages(sender?.role)) throw new Error('אין הרשאה לשלוח הודעות.');
  return {
    text: draft.text,
    targetRoles: draft.targetRoles,
    senderUid: String(sender.uid),
    senderName: String(sender.name || '').slice(0, 200),
    senderRole: String(sender.role),
    createdAt,
    schemaVersion: MESSAGE_SCHEMA_VERSION
  };
}

// זמן באלפיות השנייה מ-Timestamp של Firestore / Date / מספר. null אם חסר.
export function timestampMillis(value) {
  if (value == null) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// createdAt חסר = הודעה שנכתבה כרגע ועוד לא אושרה בשרת; נחשבת "עכשיו".
export function normalizeMessage(id, data = {}, nowMs = Date.now()) {
  const createdAtMs = timestampMillis(data.createdAt);
  return {
    id: String(id),
    text: String(data.text ?? ''),
    targetRoles: normalizeTargetRoles(data.targetRoles),
    senderUid: String(data.senderUid ?? ''),
    senderName: String(data.senderName ?? ''),
    senderRole: String(data.senderRole ?? ''),
    createdAtMs: createdAtMs ?? nowMs,
    pending: createdAtMs == null
  };
}

export function sortMessagesNewestFirst(messages) {
  return [...messages].sort((a, b) => (b.createdAtMs - a.createdAtMs) || b.id.localeCompare(a.id));
}

// הודעה "חדשה" עבור המשתמש: מאוחרת מהקריאה האחרונה, ולא שלו עצמו.
export function isUnreadMessage(message, { uid, lastReadAtMs }) {
  return message.senderUid !== String(uid || '') && message.createdAtMs > (Number(lastReadAtMs) || 0);
}

export function countUnread(messages, { uid, lastReadAtMs }) {
  return messages.filter(message => isUnreadMessage(message, { uid, lastReadAtMs })).length;
}

export function badgeText(count) {
  const number = Math.max(0, Math.floor(Number(count) || 0));
  return number > 99 ? '99+' : String(number);
}

export function unreadSummaryText(count) {
  return count === 1 ? 'יש לך הודעה אחת שלא נקראה' : `יש לך ${count} הודעות שלא נקראו`;
}

// עד שלושה כרטיסים נפרדים; מעבר לכך כרטיס מקופל אחד.
export function planToastCards(queue, limit = MESSAGE_TOAST_LIMIT) {
  if (queue.length <= limit) return { collapsed: false, cards: queue };
  return { collapsed: true, cards: [], count: queue.length };
}

export function collapsedToastText(count) {
  return `${count} הודעות חדשות`;
}

export function previewText(text, maxLength = 110) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? flat.slice(0, maxLength - 1).trimEnd() + '…' : flat;
}

const timeFormatter = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

export function formatMessageTime(ms) {
  if (!Number.isFinite(ms)) return '';
  return timeFormatter.format(new Date(ms));
}

// settings/activeEvent → מזהה האירוע הפעיל, או '' כשאין.
export function activeEventIdFromPointer(pointer) {
  return pointer?.status === 'active' && pointer.eventId ? String(pointer.eventId) : '';
}

// מכונת המצב של הזנת ההודעות. מחליטה מתי להציג סיכום "N הודעות שלא נקראו"
// (פעם אחת, בטעינה) ומתי הודעה שהגיעה ראויה לכרטיס קופץ.
//
// הצילום הראשון יכול להגיע ממטמון המכשיר (ואף להיות ריק); לכן "קו הבסיס"
// נקבע רק אחרי שגם ההודעות וגם מצב הקריאה אושרו מהשרת. מה שהיה לפני כן
// אינו קופץ כהודעה חדשה אלא נכלל בסיכום היחיד.
export function createMessageFeed({ uid }) {
  let messages = [];
  let lastReadAtMs = 0;
  let messagesConfirmed = false;
  let readConfirmed = false;
  let baseline = false;
  const announced = new Set();

  const view = extra => ({
    messages: sortMessagesNewestFirst(messages),
    unreadCount: countUnread(messages, { uid, lastReadAtMs }),
    summaryCount: 0,
    toasts: [],
    ...extra
  });

  function settleBaseline() {
    if (baseline || !messagesConfirmed || !readConfirmed) return 0;
    baseline = true;
    messages.forEach(message => announced.add(message.id));
    return countUnread(messages, { uid, lastReadAtMs });
  }

  return {
    get ready() { return baseline; },
    get lastReadAtMs() { return lastReadAtMs; },

    applyMessages({ messages: all, added = [], fromCache = false }) {
      const known = baseline;
      messages = all;
      if (!fromCache) messagesConfirmed = true;
      const toasts = known
        ? sortMessagesNewestFirst(added.filter(message =>
            !announced.has(message.id) && isUnreadMessage(message, { uid, lastReadAtMs })))
        : [];
      all.forEach(message => announced.add(message.id));
      return view({ summaryCount: settleBaseline(), toasts });
    },

    applyReadState({ lastReadAtMs: next, fromCache = false }) {
      lastReadAtMs = Math.max(lastReadAtMs, Number(next) || 0);
      if (!fromCache) readConfirmed = true;
      return view({ summaryCount: settleBaseline() });
    },

    // המשתמש פתח את המגירה: הכול נקרא מבחינה מקומית עוד לפני אישור השרת.
    // לפי זמני השרת של ההודעות בלבד — לא לפי שעון המכשיר, כדי שהפרש שעונים
    // לא יסתיר הודעות שיגיעו אחר כך.
    markAllReadLocally() {
      lastReadAtMs = Math.max(lastReadAtMs, ...messages.filter(message => !message.pending).map(message => message.createdAtMs));
      return view();
    }
  };
}
