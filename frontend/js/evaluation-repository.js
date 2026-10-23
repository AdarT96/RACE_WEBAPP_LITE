import {
  doc, getDoc, getDocFromCache, onSnapshot, setDoc, updateDoc, FieldPath, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  EVALUATION_SCHEMA_VERSION, normalizeAssessment, normalizeAssessmentEntry
} from './evaluation-model.js';

// שמירת הערכה עובדת גם בלי קליטה. קודם כל שינוי עבר בטרנזקציה, וטרנזקציה
// נכשלת מיד כשאין חיבור: המעריך קיבל שגיאה באנגלית והציון אבד. עכשיו הכתיבה
// נכנסת לתור של Firestore, שנשמר במכשיר (גם אחרי רענון) ונשלח כשהקליטה חוזרת.
// המסמך שייך למעריך אחד בלבד, כך שאין מי שמתחרה בו על אותו שדה; שינוי של
// מועמד אחד כותב רק את השדה של אותו מועמד, ולכן שני מכשירים של אותו מעריך
// לא דורסים זה לזה מועמדים אחרים.
export function createEvaluationRepository(db, user, { onWriteError = error => console.error(error) } = {}) {
  const uid = String(user?.uid || '');
  if (!uid) throw new Error('חסר מזהה משתמש');

  const refFor = raceId => doc(db, 'races', String(raceId), 'evaluatorAssessments', uid);

  async function get(raceId) {
    const snapshot = await getDoc(refFor(raceId));
    return snapshot.exists() ? normalizeAssessment(snapshot.data(), uid) : normalizeAssessment(null, uid);
  }

  // onValue(assessment, { pending }) — pending: יש שינויים שעוד לא הגיעו לשרת
  function subscribe(raceId, onValue, onError) {
    return onSnapshot(refFor(raceId), { includeMetadataChanges: true }, snapshot => {
      onValue(snapshot.exists()
        ? normalizeAssessment(snapshot.data(), uid)
        : normalizeAssessment(null, uid), { pending: snapshot.metadata.hasPendingWrites });
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

  // בלי קליטה קוראים מהמטמון שבמכשיר (שכולל גם שינויים שעוד ממתינים לשליחה);
  // עם קליטה — מהשרת, כמו קודם.
  async function current(reference) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      try { return await getDocFromCache(reference); } catch (error) { /* לא במטמון — ננסה את השרת */ }
    }
    return getDoc(reference);
  }

  // הכתיבה מאושרת בשרת רק כשיש קליטה. לא ממתינים לאישור: המסך מתעדכן מיד
  // מהמנוי, ושגיאה מאוחרת (למשל הרשאה) מגיעה ל-onWriteError.
  function send(write) {
    write.catch(onWriteError);
  }

  function fullPayload(snapshot, entries) {
    return {
      evaluatorUid: uid,
      entries,
      schemaVersion: EVALUATION_SCHEMA_VERSION,
      createdAt: snapshot.exists() ? snapshot.data().createdAt : serverTimestamp(),
      updatedAt: serverTimestamp()
    };
  }

  async function mutate(raceId, mutateEntries) {
    const reference = refFor(raceId);
    const snapshot = await current(reference);
    const existing = snapshot.exists()
      ? normalizeAssessment(snapshot.data(), uid)
      : normalizeAssessment(null, uid);
    const entries = Object.fromEntries(Object.entries(existing.entries)
      .map(([participantId, entry]) => [participantId, normalizeAssessmentEntry(entry)]));
    const updated = mutateEntries(entries) || entries;
    const payload = fullPayload(snapshot, updated);
    // Full replacement is intentional: deleted scores/comments must not survive
    // as nested map fields through Firestore's recursive merge semantics.
    send(setDoc(reference, payload));
    return normalizeAssessment(payload, uid);
  }

  async function mutateParticipant(raceId, participantId, mutateEntry) {
    const pid = String(participantId);
    const reference = refFor(raceId);
    const snapshot = await current(reference);
    const existing = snapshot.exists()
      ? normalizeAssessment(snapshot.data(), uid)
      : normalizeAssessment(null, uid);
    const entry = normalizeAssessmentEntry(existing.entries[pid]);
    const updatedEntry = normalizeAssessmentEntry(mutateEntry(entry) || entry);
    const entries = { ...existing.entries, [pid]: updatedEntry };
    if (snapshot.exists()) {
      // החלפת הרשומה של המועמד הזה בלבד (לא מיזוג) — ציון שנמחק לא נשאר בה
      send(updateDoc(reference, new FieldPath('entries', pid), updatedEntry, 'updatedAt', serverTimestamp()));
    } else {
      send(setDoc(reference, fullPayload(snapshot, entries)));
    }
    return normalizeAssessment({ evaluatorUid: uid, entries }, uid);
  }

  return { uid, refFor, get, getMany, subscribe, mutate, mutateParticipant };
}
