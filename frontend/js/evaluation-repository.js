import {
  doc, getDoc, onSnapshot, runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  EVALUATION_SCHEMA_VERSION, normalizeAssessment, normalizeAssessmentEntry
} from './evaluation-model.js';

export function createEvaluationRepository(db, user) {
  const uid = String(user?.uid || '');
  if (!uid) throw new Error('חסר מזהה משתמש');

  const refFor = raceId => doc(db, 'races', String(raceId), 'evaluatorAssessments', uid);

  async function get(raceId) {
    const snapshot = await getDoc(refFor(raceId));
    return snapshot.exists() ? normalizeAssessment(snapshot.data(), uid) : normalizeAssessment(null, uid);
  }

  function subscribe(raceId, onValue, onError) {
    return onSnapshot(refFor(raceId), snapshot => {
      onValue(snapshot.exists()
        ? normalizeAssessment(snapshot.data(), uid)
        : normalizeAssessment(null, uid));
    }, onError);
  }

  async function getMany(races) {
    const list = Array.isArray(races) ? races : [];
    const snapshots = await Promise.all(list.map(race => getDoc(refFor(race.id))));
    return new Map(snapshots.map((snapshot, index) => [
      String(list[index].id),
      snapshot.exists() ? normalizeAssessment(snapshot.data(), uid) : normalizeAssessment(null, uid)
    ]));
  }

  async function mutate(raceId, mutateEntries) {
    const reference = refFor(raceId);
    return runTransaction(db, async transaction => {
      const snapshot = await transaction.get(reference);
      const existing = snapshot.exists()
        ? normalizeAssessment(snapshot.data(), uid)
        : normalizeAssessment(null, uid);
      const entries = Object.fromEntries(Object.entries(existing.entries)
        .map(([participantId, entry]) => [participantId, normalizeAssessmentEntry(entry)]));
      const updated = mutateEntries(entries) || entries;
      const payload = {
        evaluatorUid: uid,
        entries: updated,
        schemaVersion: EVALUATION_SCHEMA_VERSION,
        createdAt: snapshot.exists() ? snapshot.data().createdAt : serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      // Full replacement is intentional: deleted scores/comments must not survive
      // as nested map fields through Firestore's recursive merge semantics.
      transaction.set(reference, payload);
      return normalizeAssessment(payload, uid);
    });
  }

  async function mutateParticipant(raceId, participantId, mutateEntry) {
    const pid = String(participantId);
    return mutate(raceId, entries => {
      const entry = normalizeAssessmentEntry(entries[pid]);
      const updated = mutateEntry(entry) || entry;
      entries[pid] = normalizeAssessmentEntry(updated);
      return entries;
    });
  }

  return { uid, refFor, get, getMany, subscribe, mutate, mutateParticipant };
}
