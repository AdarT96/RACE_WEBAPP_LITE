import {
  collection, doc, getDoc, getDocs, onSnapshot, runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import { EVALUATION_SCHEMA_VERSION, normalizeNotes } from './evaluation-model.js';

export function privateNotesDocumentId(team, participantId) {
  return `${String(team).padStart(2, '0')}_${String(participantId)}`;
}

export function createPrivateNotesRepository(db, user) {
  const uid = String(user?.uid || '');
  if (!uid) throw new Error('חסר מזהה משתמש');

  const refFor = (team, participantId, authorUid = uid) => doc(
    db, 'general_notes', privateNotesDocumentId(team, participantId), 'authors', String(authorUid)
  );

  function subscribe(team, participantId, onValue, onError) {
    return onSnapshot(refFor(team, participantId), snapshot => {
      onValue(snapshot.exists() ? normalizeNotes(snapshot.data().notes) : []);
    }, onError);
  }

  async function get(team, participantId, authorUid = uid) {
    const snapshot = await getDoc(refFor(team, participantId, authorUid));
    return snapshot.exists() ? normalizeNotes(snapshot.data().notes) : [];
  }

  async function mutate(team, participantId, mutateNotes, authorUid = uid) {
    const reference = refFor(team, participantId, authorUid);
    return runTransaction(db, async transaction => {
      const snapshot = await transaction.get(reference);
      const notes = normalizeNotes(snapshot.exists() ? snapshot.data().notes : []);
      const updated = normalizeNotes(mutateNotes(notes.slice()) || notes);
      const payload = {
        authorUid: String(authorUid), team: String(team).padStart(2, '0'),
        participantId: String(participantId), notes: updated,
        schemaVersion: EVALUATION_SCHEMA_VERSION,
        createdAt: snapshot.exists() ? snapshot.data().createdAt : serverTimestamp(),
        updatedAt: serverTimestamp()
      };
      transaction.set(reference, payload);
      return updated;
    });
  }

  async function getAllAuthors(team, participantId) {
    const snapshot = await getDocs(collection(
      db, 'general_notes', privateNotesDocumentId(team, participantId), 'authors'
    ));
    return snapshot.docs.flatMap(author => normalizeNotes(author.data().notes));
  }

  return { uid, refFor, get, subscribe, mutate, getAllAuthors };
}
