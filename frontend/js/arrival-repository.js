import {
  Timestamp, deleteField, doc, getDoc, getDocFromCache, onSnapshot, serverTimestamp, setDoc, updateDoc
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import { arrivalWithOrder, arrivalWithPlacement, arrivalRevision } from './arrival-order-model.js';

// Every arrival writer (including the candidate page) uses this document/version contract.
//
// Writes are local-first. Each command used to run in a server transaction, one
// after the other: on a weak network eleven taps took 26 s to save, a tap's place
// time was the moment the server processed it (seconds after the tap), and
// without reception nothing could be saved. Now a command reads the device's copy
// (which includes this evaluator's queued writes), writes at once, and Firestore's
// persistent queue sends it when there is reception. The place time is the tap
// itself (command.at, the device clock). Commands are serialised here, so two quick
// taps never compute the same revision; the revision rules still reject a write
// built on a copy another device has since changed (reported to onWriteError).
export function createArrivalRepository(db, user, stateForRace, { onWriteError = error => console.error(error) } = {}) {
  const uid = String(user?.uid || '');
  if (!uid) throw new Error('חסר משתמש');
  const ref = raceId => doc(db, 'races', String(raceId), 'evaluatorArrivals', uid);
  let chain = Promise.resolve();

  async function current(reference) {
    try { return await getDocFromCache(reference); } catch (error) { return getDoc(reference); }
  }

  async function apply(raceId, command) {
    const reference = ref(raceId);
    const [raceSnapshot, snapshot] = await Promise.all([current(doc(db, 'races', String(raceId))), current(reference)]);
    if (!raceSnapshot.exists()) throw new Error('הסבב אינו קיים');
    const stored = snapshot.exists() ? snapshot.data() : null;
    const base = { ...stateForRace({ id:raceId, ...raceSnapshot.data() }, stored), revision:arrivalRevision(stored) };
    const markedAt = Timestamp.fromMillis(Number(command.at) || Date.now());
    let next;
    if (command.type === 'append') {
      if (!base.participantIds.includes(command.pid)) throw new Error('המועמד אינו ברשימת הסבב');
      // Retrying an uncertain write must not create another place or timestamp.
      if (base.order.includes(command.pid)) return base;
      next = arrivalWithPlacement(base, command.pid, base.order.length, markedAt);
    } else if (command.type === 'reorder' || command.type === 'place') {
      if (base.revision !== command.expectedRevision) {
        throw new Error('סדר ההגעה השתנה במסך אחר. טען את העדכון לפני שינוי הסדר.');
      }
      next = command.type === 'place'
        ? arrivalWithPlacement(base, command.pid, command.targetIndex, markedAt)
        : arrivalWithOrder(base, command.order);
    } else throw new Error('פעולת סדר הגעה אינה מוכרת');

    const revision = base.revision + 1;
    if (stored) {
      // Only the changing fields: createdAt may still be a pending server time in
      // the device copy, and rewriting it would be rejected as an identity change.
      send(updateDoc(reference, {
        order:next.order, slotTimes:next.slotTimes, revision, updatedAt:serverTimestamp(),
        completedAt:next.completedAt || deleteField()
      }));
    } else {
      const created = {
        evaluatorUid:uid, participantIds:base.participantIds, order:next.order,
        slotTimes:next.slotTimes, schemaVersion:1, revision,
        createdAt:serverTimestamp(), updatedAt:serverTimestamp()
      };
      if (next.completedAt) created.completedAt = next.completedAt;
      send(setDoc(reference, created));
    }
    const payload = {
      evaluatorUid:uid, participantIds:base.participantIds, order:next.order,
      slotTimes:next.slotTimes, schemaVersion:1, revision
    };
    if (next.completedAt) payload.completedAt = next.completedAt;
    return payload;
  }

  // The server's answer arrives later (or after reception returns); a rejection
  // is reported, the screen meanwhile follows the device copy.
  function send(write) {
    write.catch(onWriteError);
  }

  function mutate(raceId, command) {
    const run = chain.then(() => apply(raceId, command));
    chain = run.catch(() => {});
    return run;
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
