import { doc, onSnapshot, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import { arrivalWithOrder, arrivalRevision } from './arrival-order-model.js';

// Every arrival writer (including the candidate page) uses this document/version contract.
export function createArrivalRepository(db, user, stateForRace) {
  const uid = String(user?.uid || '');
  if (!uid) throw new Error('חסר משתמש');
  const ref = raceId => doc(db, 'races', String(raceId), 'evaluatorArrivals', uid);

  async function mutate(raceId, command) {
    const reference = ref(raceId);
    const raceReference = doc(db, 'races', String(raceId));
    return runTransaction(db, async transaction => {
      const raceSnapshot = await transaction.get(raceReference);
      const snapshot = await transaction.get(reference);
      if (!raceSnapshot.exists()) throw new Error('הסבב אינו קיים');
      const stored = snapshot.exists() ? snapshot.data() : null;
      const base = { ...stateForRace({ id:raceId, ...raceSnapshot.data() }, stored), revision:arrivalRevision(stored) };
      let next;
      if (command.type === 'append') {
        if (!base.participantIds.includes(command.pid)) throw new Error('המועמד אינו ברשימת הסבב');
        // Retrying an uncertain write must not create another place or timestamp.
        if (base.order.includes(command.pid)) return base;
        const order = [...base.order, command.pid];
        next = { ...base, order, slotTimes:{ ...base.slotTimes, [String(order.length)]:serverTimestamp() } };
        if (order.length === base.participantIds.length) next.completedAt = base.completedAt || serverTimestamp();
      } else if (command.type === 'reorder') {
        if (base.revision !== command.expectedRevision) {
          throw new Error('סדר ההגעה השתנה במסך אחר. טען את העדכון לפני שינוי הסדר.');
        }
        next = arrivalWithOrder(base, command.order);
      } else throw new Error('פעולת סדר הגעה אינה מוכרת');
      const payload = {
        evaluatorUid:uid, participantIds:base.participantIds, order:next.order,
        slotTimes:next.slotTimes, schemaVersion:1, revision:base.revision + 1,
        createdAt:stored?.createdAt || serverTimestamp(), updatedAt:serverTimestamp()
      };
      if (next.completedAt) payload.completedAt = next.completedAt;
      transaction.set(reference, payload);
      return payload;
    });
  }

  return {
    uid, mutate,
    subscribe(raceId, onValue, onError) {
      return onSnapshot(ref(raceId), { includeMetadataChanges:true }, snapshot => {
        // Pending local writes are represented by the controller's queue, not confirmed data.
        if (snapshot.metadata.hasPendingWrites || snapshot.metadata.fromCache) return;
        onValue(snapshot.exists() ? snapshot.data() : null);
      }, onError);
    }
  };
}
