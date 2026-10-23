import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGE_MAX_LENGTH, MESSAGE_RECIPIENT_ROLES, activeEventIdFromPointer, badgeText, buildMessageData,
  canSendMessages, collapsedToastText, countUnread, createMessageFeed, formatMessageTime,
  messageRoleLabel, normalizeMessage, normalizeTargetRoles, planToastCards, previewText,
  sortMessagesNewestFirst, unreadSummaryText, validateMessageDraft
} from '../frontend/js/messages-model.js';

const at = ms => ({ toMillis: () => ms });
const message = (id, createdAtMs, overrides = {}) => normalizeMessage(id, {
  text: `הודעה ${id}`, targetRoles: ['evaluator'], senderUid: 'admin1', senderName: 'מנהל',
  senderRole: 'admin', createdAt: at(createdAtMs), ...overrides
});

test('recipient roles and labels, with a local fallback for the adjutancy role', () => {
  assert.deepEqual(MESSAGE_RECIPIENT_ROLES, ['operator', 'evaluator', 'formation_commander', 'adjutant', 'admin']);
  assert.equal(messageRoleLabel('operator'), 'מפק״צ');
  assert.equal(messageRoleLabel('formation_commander'), 'מפקד הגיבוש');
  assert.equal(messageRoleLabel('adjutant'), 'שלישות');
  assert.equal(messageRoleLabel('admin'), 'מנהל');
  assert.equal(messageRoleLabel('mystery'), 'mystery');
});

test('only admin and formation commander may send', () => {
  assert.equal(canSendMessages('admin'), true);
  assert.equal(canSendMessages('formation_commander'), true);
  for (const role of ['operator', 'evaluator', 'adjutant', '', undefined]) assert.equal(canSendMessages(role), false);
});

test('draft validation: text required, trimmed, capped; at least one known role', () => {
  assert.equal(validateMessageDraft({ text: '   ', targetRoles: ['admin'] }).ok, false);
  assert.equal(validateMessageDraft({ text: 'שלום', targetRoles: [] }).ok, false);
  assert.equal(validateMessageDraft({ text: 'שלום', targetRoles: ['hacker'] }).ok, false);
  assert.equal(validateMessageDraft({ text: 'א'.repeat(MESSAGE_MAX_LENGTH + 1), targetRoles: ['admin'] }).ok, false);
  const valid = validateMessageDraft({ text: '  שלום  ', targetRoles: ['evaluator', 'operator', 'operator', 'x'] });
  assert.equal(valid.ok, true);
  assert.equal(valid.text, 'שלום');
  assert.deepEqual(valid.targetRoles, ['operator', 'evaluator']);
  assert.deepEqual(normalizeTargetRoles('operator'), []);
});

test('message data has exactly the keys the Firestore rules accept', () => {
  const data = buildMessageData({ text: 'שלום', targetRoles: ['operator'] },
    { uid: 'u1', name: 'דנה', role: 'formation_commander' }, 'STAMP');
  assert.deepEqual(Object.keys(data).sort(),
    ['createdAt', 'schemaVersion', 'senderName', 'senderRole', 'senderUid', 'targetRoles', 'text']);
  assert.equal(data.createdAt, 'STAMP');
  assert.equal(data.schemaVersion, 1);
  assert.throws(() => buildMessageData({ text: 'x', targetRoles: ['operator'] }, { uid: 'u', role: 'evaluator' }, 1), /הרשאה/);
  assert.throws(() => buildMessageData({ text: '', targetRoles: ['operator'] }, { uid: 'u', role: 'admin' }, 1));
});

test('normalizing keeps pending messages as "now" and sorts newest first', () => {
  const pending = normalizeMessage('p', { text: 'x', targetRoles: ['admin'], createdAt: null }, 5000);
  assert.equal(pending.pending, true);
  assert.equal(pending.createdAtMs, 5000);
  const sorted = sortMessagesNewestFirst([message('a', 100), message('b', 300), pending, message('c', 200)]);
  assert.deepEqual(sorted.map(item => item.id), ['p', 'b', 'c', 'a']);
});

test('unread count: later than lastReadAt, never the user\'s own messages', () => {
  const list = [message('a', 100), message('b', 200), message('c', 300, { senderUid: 'me' })];
  assert.equal(countUnread(list, { uid: 'me', lastReadAtMs: 0 }), 2);
  assert.equal(countUnread(list, { uid: 'me', lastReadAtMs: 100 }), 1);
  assert.equal(countUnread(list, { uid: 'me', lastReadAtMs: 200 }), 0);
});

test('badge, summary and collapse texts', () => {
  assert.equal(badgeText(0), '0');
  assert.equal(badgeText(7), '7');
  assert.equal(badgeText(250), '99+');
  assert.equal(unreadSummaryText(1), 'יש לך הודעה אחת שלא נקראה');
  assert.equal(unreadSummaryText(4), 'יש לך 4 הודעות שלא נקראו');
  assert.equal(collapsedToastText(5), '5 הודעות חדשות');
});

test('up to three toast cards are stacked; more collapse into one', () => {
  const three = [1, 2, 3].map(n => message(String(n), n));
  assert.deepEqual(planToastCards(three), { collapsed: false, cards: three });
  const four = [...three, message('4', 4)];
  assert.deepEqual(planToastCards(four), { collapsed: true, cards: [], count: 4 });
});

test('preview flattens whitespace and truncates', () => {
  assert.equal(previewText('שלום\n\n  עולם'), 'שלום עולם');
  const long = previewText('א'.repeat(300), 50);
  assert.equal(long.length, 50);
  assert.ok(long.endsWith('…'));
});

test('time is formatted in Israel time, not the device zone', () => {
  // 2026-01-15 10:30 UTC = 12:30 בישראל (חורף, UTC+2)
  const winter = formatMessageTime(Date.UTC(2026, 0, 15, 10, 30));
  assert.match(winter, /15\D+01\D+2026/);
  assert.match(winter, /12:30/);
  // 2026-07-15 10:30 UTC = 13:30 בישראל (קיץ, UTC+3)
  assert.match(formatMessageTime(Date.UTC(2026, 6, 15, 10, 30)), /13:30/);
  assert.equal(formatMessageTime(NaN), '');
});

test('active event id comes only from an active pointer', () => {
  assert.equal(activeEventIdFromPointer({ status: 'active', eventId: 'e1' }), 'e1');
  assert.equal(activeEventIdFromPointer({ status: 'closed', eventId: 'e1' }), '');
  assert.equal(activeEventIdFromPointer(null), '');
});

// ───── הזנת ההודעות: סיכום בטעינה, כרטיסים רק להודעות חדשות ─────
const server = (messages, added = []) => ({ messages, added, fromCache: false });
const cache = (messages, added = []) => ({ messages, added, fromCache: true });

test('feed: on load a single summary is produced and old messages never pop one by one', () => {
  const feed = createMessageFeed({ uid: 'me' });
  const old = [message('a', 100), message('b', 200), message('c', 300)];
  const first = feed.applyMessages(server(old, old));
  assert.equal(first.summaryCount, 0); // מצב הקריאה עוד לא אושר
  assert.deepEqual(first.toasts, []);
  const ready = feed.applyReadState({ lastReadAtMs: 150, fromCache: false });
  assert.equal(ready.summaryCount, 2);
  assert.equal(ready.unreadCount, 2);
  assert.deepEqual(ready.toasts, []);
  assert.equal(feed.applyReadState({ lastReadAtMs: 150, fromCache: false }).summaryCount, 0); // פעם אחת
});

test('feed: nothing unread at load means no summary', () => {
  const feed = createMessageFeed({ uid: 'me' });
  feed.applyReadState({ lastReadAtMs: 1000, fromCache: false });
  const result = feed.applyMessages(server([message('a', 100)], [message('a', 100)]));
  assert.equal(result.summaryCount, 0);
  assert.equal(result.unreadCount, 0);
});

test('feed: a cached first snapshot (even empty) does not turn history into toasts', () => {
  const feed = createMessageFeed({ uid: 'me' });
  feed.applyReadState({ lastReadAtMs: 0, fromCache: true });
  assert.deepEqual(feed.applyMessages(cache([])).toasts, []);
  const history = [message('a', 100), message('b', 200)];
  const confirmed = feed.applyMessages(server(history, history)); // השרת מביא את כל ההיסטוריה כ-added
  assert.deepEqual(confirmed.toasts, []);
  assert.equal(feed.applyReadState({ lastReadAtMs: 0, fromCache: false }).summaryCount, 2);
});

test('feed: later arrivals pop once; own, already-read and repeated messages do not', () => {
  const feed = createMessageFeed({ uid: 'me' });
  const history = [message('a', 100)];
  feed.applyReadState({ lastReadAtMs: 150, fromCache: false });
  feed.applyMessages(server(history, history));
  const fresh = message('b', 400);
  const own = message('c', 500, { senderUid: 'me' });
  const stale = message('d', 120); // מוקדם מהקריאה האחרונה
  const result = feed.applyMessages(server([...history, fresh, own, stale], [fresh, own, stale]));
  assert.deepEqual(result.toasts.map(item => item.id), ['b']);
  assert.equal(result.unreadCount, 1);
  const again = feed.applyMessages(server([...history, fresh, own, stale], [fresh]));
  assert.deepEqual(again.toasts, []);
});

test('feed: opening the drawer marks everything read locally, and later messages are unread again', () => {
  const feed = createMessageFeed({ uid: 'me' });
  const history = [message('a', 100), message('b', 200)];
  feed.applyReadState({ lastReadAtMs: 0, fromCache: false });
  feed.applyMessages(server(history, history));
  assert.equal(feed.markAllReadLocally().unreadCount, 0);
  const next = message('c', 250);
  const result = feed.applyMessages(server([...history, next], [next]));
  assert.equal(result.unreadCount, 1);
  assert.deepEqual(result.toasts.map(item => item.id), ['c']);
});

test('feed: read state never moves backwards', () => {
  const feed = createMessageFeed({ uid: 'me' });
  feed.applyReadState({ lastReadAtMs: 500, fromCache: false });
  feed.applyReadState({ lastReadAtMs: 0, fromCache: false });
  assert.equal(feed.lastReadAtMs, 500);
});
