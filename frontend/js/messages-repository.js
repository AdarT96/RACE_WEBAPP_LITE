import {
  addDoc, collection, doc, onSnapshot, query, serverTimestamp, setDoc, where
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  MESSAGE_SCHEMA_VERSION, buildMessageData, canSeeAllMessages, normalizeMessage, timestampMillis
} from './messages-model.js';

// =====================================================
//  messages-repository.js — גישה ל-Firestore של ההודעות
// =====================================================
// events/{eventId}/messages — אי־שינוי אחרי יצירה.
// events/{eventId}/messageReads/{uid} — זמן הקריאה האחרון של המשתמש.
//
// נמען שואל `array-contains` על התפקיד שלו, בלי orderBy: כך אין צורך באינדקס
// מורכב, והמיון נעשה בלקוח. מנהל ומפקד הגיבוש שואלים את כל האוסף.

export function createMessagesRepository(db, user) {
  const messagesCollection = eventId => collection(db, 'events', String(eventId), 'messages');
  const readStateReference = eventId => doc(db, 'events', String(eventId), 'messageReads', String(user.uid));

  return {
    // כתיבה אינה נדחית ואינה ממתינה לשום טעינת רקע.
    async send(eventId, draft) {
      if (!eventId) throw new Error('אין אירוע פעיל — לא ניתן לשלוח הודעה.');
      const data = buildMessageData(draft, user, serverTimestamp());
      const reference = await addDoc(messagesCollection(eventId), data);
      return reference.id;
    },

    // onChange({ messages, added, fromCache }) — messages: כל המסמכים (לא ממוינים),
    // added: רק מסמכים שנוספו בצילום הזה. fromCache מאפשר ללקוח להבדיל בין
    // מה שהיה במכשיר לבין מה שהשרת אישר.
    subscribe(eventId, onChange, onError) {
      const source = canSeeAllMessages(user.role)
        ? messagesCollection(eventId)
        : query(messagesCollection(eventId), where('targetRoles', 'array-contains', String(user.role)));
      return onSnapshot(source, { includeMetadataChanges: true }, snapshot => {
        const read = item => normalizeMessage(item.id, item.data({ serverTimestamps: 'estimate' }));
        onChange({
          messages: snapshot.docs.map(read),
          added: snapshot.docChanges().filter(change => change.type === 'added').map(change => read(change.doc)),
          fromCache: snapshot.metadata.fromCache
        });
      }, onError);
    },

    // onChange({ lastReadAtMs, fromCache }) — 0 כשהמשתמש מעולם לא פתח את ההודעות.
    subscribeReadState(eventId, onChange, onError) {
      return onSnapshot(readStateReference(eventId), { includeMetadataChanges: true }, snapshot => {
        const data = snapshot.exists() ? snapshot.data({ serverTimestamps: 'none' }) : null;
        onChange({
          lastReadAtMs: timestampMillis(data?.lastReadAt) ?? 0,
          fromCache: snapshot.metadata.fromCache
        });
      }, onError);
    },

    async markRead(eventId) {
      if (!eventId) return;
      await setDoc(readStateReference(eventId), {
        lastReadAt: serverTimestamp(), schemaVersion: MESSAGE_SCHEMA_VERSION
      });
    }
  };
}
