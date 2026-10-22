// =====================================================
//  intake-repository.js — כתיבה וקריאה של קליטת מועמדים
// =====================================================
// מקור הכתיבה היחיד של מסך הקליטה. כל כתיבה היא טרנזקציה שקוראת מהשרת
// (גם כשהמסך מוצג ממטמון המכשיר):
//   • מועמד חדש: מספר אוטומטי — הבא אחרי max(המונה, המספר הגבוה באירוע),
//     בדיקה בתוך הטרנזקציה שהמספר אינו קיים ברישום, בכלליים או באף צוות,
//     ואז רישום המספר + המונה + המועמד (+ רשימת הצוות) יחד.
//   • תיקון פרטים: לפי profileRevision שנצפה, כדי לא לדרוס עריכה מקבילה.
//   • העברה: כללי↔צוות וצוות↔צוות, אטומית, רק כשאין למועמד נתונים.
// חוקי Firestore אוכפים את אותו רישום מספרים, כך שגם לקוח שגוי לא יקבל
// מספר כפול דרך הקליטה.

import {
  collection, doc, getDoc, getDocFromServer, getDocs, getDocsFromServer, onSnapshot,
  query, runTransaction, serverTimestamp, where
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  CANDIDATE_SCHEMA_VERSION, CANDIDATE_STATUSES, candidateKey, normalizeCandidateProfile,
  normalizeCandidateRecord, normalizeParticipantId, padTeam
} from './formation-operations-model.js';
import {
  INTAKE_EVENT_STATUSES, MAX_TEAM_CANDIDATES, NUMBER_PROBE_LIMIT, NUMBER_REGISTRY_SCHEMA_VERSION,
  UNASSIGNED_RECORD_SCHEMA_VERSION, candidateDataReasons, firstNumberToTry, intakeTeamLabel,
  maxParticipantNumber, normalizeIntakeTeam, prepareIntakeProfile, profileFields, rosterWith, rosterWithout
} from './intake-model.js';
import { ROLES, canManageIntake } from './roles.js';

const RACE_SCHEMA_VERSION = 2;
// כל קליטה כותבת את אותו מונה, ולכן עד 10 קולטים במקביל מתחרים עליו. כל
// התנגשות מנסה שוב מההתחלה (קריאה מחדש מהשרת); ברירת המחדל של 5 קצרה מדי.
const CREATE_MAX_ATTEMPTS = 15;
const CREATE_MAX_ROUNDS = 15;
const isPermissionDenied = error => String(error?.code || '').endsWith('permission-denied');
const pause = () => new Promise(resolve => setTimeout(resolve, 40 + Math.floor(Math.random() * 160)));

export class IntakeMoveBlockedError extends Error {
  constructor(reasons) {
    super('למועמד כבר יש נתונים.');
    this.name = 'IntakeMoveBlockedError';
    this.reasons = [...reasons];
  }
}

// אות פנימי: ייבוא רשימות הושלם בין הקריאה המקדימה לטרנזקציה. קוראים שוב.
class RosterChangedSignal extends Error {}

const rowsOf = snapshot => snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
const isOpenStatus = status => INTAKE_EVENT_STATUSES.includes(String(status || ''));

export function createIntakeRepository(db, user) {
  if (!db || !user?.uid || !canManageIntake(user.role)) {
    throw new Error('קליטת מועמדים זמינה לשלישות, למפקד הגיבוש ולמנהל בלבד.');
  }
  const uid = String(user.uid);
  const canReadRecommendations = [ROLES.ADMIN, ROLES.FORMATION_COMMANDER].includes(user.role);

  const eventRef = eventId => doc(db, 'events', String(eventId));
  const teamRef = (eventId, team) => doc(db, 'events', String(eventId), 'teams', padTeam(team));
  const candidateRef = (eventId, team, participantId) =>
    doc(db, 'events', String(eventId), 'candidates', candidateKey(team, participantId));
  const unassignedRef = (eventId, participantId) =>
    doc(db, 'events', String(eventId), 'unassignedCandidates', normalizeParticipantId(participantId));
  const numberRef = (eventId, participantId) =>
    doc(db, 'events', String(eventId), 'candidateNumbers', normalizeParticipantId(participantId));
  const counterRef = eventId => doc(db, 'events', String(eventId), 'intake', 'counter');
  const recordRef = (eventId, team, participantId) => (normalizeIntakeTeam(team)
    ? candidateRef(eventId, team, participantId) : unassignedRef(eventId, participantId));

  function assertOpen(snapshot) {
    if (!snapshot.exists()) throw new Error('האירוע אינו קיים.');
    if (!isOpenStatus(snapshot.data().status)) throw new Error('האירוע אינו פתוח לקליטה (רק טיוטה או אירוע פעיל).');
  }

  function assertTeamAccepts(snapshot, team, participantId) {
    if (!snapshot?.exists() || snapshot.data().active === false) {
      throw new Error(`${intakeTeamLabel(team)} אינו קיים באירוע.`);
    }
    const ids = (snapshot.data().participantIds || []).map(normalizeParticipantId);
    if (participantId && ids.includes(participantId)) throw new Error(`מספר ${participantId} כבר רשום ב${intakeTeamLabel(team)}.`);
    if (ids.length >= MAX_TEAM_CANDIDATES) {
      throw new Error(`ב${intakeTeamLabel(team)} כבר ${MAX_TEAM_CANDIDATES} מועמדים. בחר צוות אחר או "כללי".`);
    }
  }

  function candidateDocument(team, participantId, profile, stamp) {
    return {
      participantId, team: padTeam(team), ...profileFields(profile),
      status: CANDIDATE_STATUSES.ACTIVE, reasonCode: '', reasonLabel: '', statusRevision: 0,
      profileRevision: 0, lastTransitionId: '', statusChangedAt: stamp, statusChangedBy: uid,
      profileUpdatedAt: stamp, profileUpdatedBy: uid, schemaVersion: CANDIDATE_SCHEMA_VERSION
    };
  }

  function unassignedDocument(participantId, profile, stamp) {
    return {
      participantId, ...profileFields(profile),
      profileRevision: 0, profileUpdatedAt: stamp, profileUpdatedBy: uid,
      createdAt: stamp, createdBy: uid, schemaVersion: UNASSIGNED_RECORD_SCHEMA_VERSION
    };
  }

  async function counterMovedFrom(eventId, observed) {
    try {
      const snapshot = await getDocFromServer(counterRef(eventId));
      return (snapshot.exists() ? Number(snapshot.data().lastNumber) || 0 : 0) !== observed;
    } catch (_) {
      return false;
    }
  }

  // שינוי מקביל שנשמר ראשון גורם לשרת לדחות את הכתיבה שלנו כהרשאה. כאן
  // מבחינים בין זה לבין דחייה אמיתית, כדי להציג הודעה ברורה.
  async function explainConcurrentDenial(reference, expectedRevision, operation) {
    try {
      return await operation();
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      const latest = await getDocFromServer(reference).catch(() => null);
      if (latest && !latest.exists()) throw new Error('המועמד הועבר או נמחק במכשיר אחר. רענן ונסה שוב.');
      if (latest?.exists() && expectedRevision != null &&
          Number(latest.data().profileRevision || 0) !== Number(expectedRevision)) {
        throw new Error('פרטי המועמד עודכנו במכשיר אחר. בדוק את הפרטים המעודכנים ונסה שוב.');
      }
      throw error;
    }
  }

  // המספר הגבוה ביותר באירוע לפי השרת (מועמדים משובצים וכלליים) — כולל
  // מספרים מייבוא ה־Excel, שאין להם רישום במונה.
  async function scanMaxNumber(eventId) {
    const [candidates, unassigned] = await Promise.all([
      getDocsFromServer(collection(db, 'events', String(eventId), 'candidates')),
      getDocsFromServer(collection(db, 'events', String(eventId), 'unassignedCandidates'))
    ]);
    return maxParticipantNumber(rowsOf(candidates), rowsOf(unassigned));
  }

  // סיבות שבגללן אין להעביר מועמד מצוותו (ריק = מותר). קורא מהשרת בלבד.
  // סבבים קיימים רק באירוע פעיל. המלצות נשירה אינן גלויות לשלישות; עבורה
  // החוקים בשרת הם שחוסמים מחיקה של מועמד שיש עליו המלצה.
  async function dataReasons(eventId, candidate, { eventStatus = '' } = {}) {
    const team = normalizeIntakeTeam(candidate?.team);
    if (!team) return [];
    const participantId = normalizeParticipantId(candidate.participantId);
    const [races, recommendation, record] = await Promise.all([
      eventStatus === 'active'
        ? getDocsFromServer(query(collection(db, 'races'), where('eventId', '==', String(eventId)),
          where('team', '==', team), where('evaluationSchemaVersion', '==', RACE_SCHEMA_VERSION))).then(rowsOf)
        : Promise.resolve([]),
      canReadRecommendations
        ? getDocFromServer(doc(db, 'events', String(eventId), 'dropoutRecommendations', candidateKey(team, participantId)))
          .then(snapshot => snapshot.exists())
        : Promise.resolve(false),
      getDocFromServer(candidateRef(eventId, team, participantId))
        .then(snapshot => (snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null))
    ]);
    return candidateDataReasons({ candidate: record || candidate, races, hasRecommendation: recommendation });
  }

  return {
    // אירועים פתוחים לקליטה (טיוטה או פעיל). השלישות רשאית לרשום אותם רק כשאין
    // אירוע פעיל עם שיבוץ סגל; אז המסך פונה ישירות לאירוע הפעיל.
    async listOpenEvents() {
      const snapshot = await getDocs(query(collection(db, 'events'), where('status', 'in', INTAKE_EVENT_STATUSES)));
      return rowsOf(snapshot).sort((left, right) =>
        (left.status === 'active' ? 0 : 1) - (right.status === 'active' ? 0 : 1) ||
        String(left.name || left.id).localeCompare(String(right.name || right.id), 'he'));
    },

    async getEvent(eventId) {
      const snapshot = await getDoc(eventRef(eventId));
      return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
    },

    // מנויים לצוותים, למשובצים ולכלליים. fromCache מאפשר לדעת אם התצוגה
    // כבר מסונכרנת עם השרת (למשל לצורך רמז המספר הגבוה).
    subscribeRoster(eventId, { onTeams, onCandidates, onUnassigned, onError }) {
      const options = { includeMetadataChanges: true };
      const listen = (name, callback) => onSnapshot(collection(db, 'events', String(eventId), name), options,
        snapshot => callback?.(rowsOf(snapshot), { fromCache: snapshot.metadata.fromCache }),
        error => onError?.(error, name));
      const unsubscribers = [
        listen('teams', onTeams),
        listen('candidates', onCandidates),
        listen('unassignedCandidates', onUnassigned)
      ];
      return () => unsubscribers.forEach(unsubscribe => unsubscribe());
    },

    // יוצר מועמד ומקצה לו מספר אוטומטי. team ריק = כללי (ללא צוות).
    // knownMax: המספר הגבוה ממנויים מסונכרנים (אופציונלי). בלעדיו נסרק השרת.
    // הרמז קובע רק מאיפה להתחיל; הייחודיות נבדקת תמיד בתוך הטרנזקציה.
    async createCandidate(eventId, input, team, { knownMax = null } = {}) {
      const { profile, errors } = prepareIntakeProfile(input);
      if (errors.length) throw new Error(errors[0]);
      const target = normalizeIntakeTeam(team);
      let hint = Number.isFinite(Number(knownMax)) && knownMax !== null ? Number(knownMax) : null;
      let rosterChanges = 0;
      for (let round = 0; round < CREATE_MAX_ROUNDS; round += 1) {
        // קודם גרסת הרשימות ורק אחריה רשימת הצוותים: ייבוא שיסתיים ביניהן
        // ייראה כאן, וייבוא מאוחר יותר ישנה את rosterRevision וייתפס בטרנזקציה.
        const eventSnapshot = await getDocFromServer(eventRef(eventId));
        assertOpen(eventSnapshot);
        const rosterRevision = Number(eventSnapshot.data().rosterRevision || 0);
        const teamsSnapshot = await getDocsFromServer(collection(db, 'events', String(eventId), 'teams'));
        const teamIds = teamsSnapshot.docs.map(item => padTeam(item.id)).filter(Boolean);
        if (target && !teamIds.includes(target)) throw new Error(`${intakeTeamLabel(target)} אינו קיים באירוע.`);
        if (hint === null) hint = await scanMaxNumber(eventId);
        let observedCounter = null;
        try {
          return await runTransaction(db, async transaction => {
            const [currentEvent, counter, teamSnapshot] = await Promise.all([
              transaction.get(eventRef(eventId)),
              transaction.get(counterRef(eventId)),
              target ? transaction.get(teamRef(eventId, target)) : Promise.resolve(null)
            ]);
            assertOpen(currentEvent);
            if (Number(currentEvent.data().rosterRevision || 0) !== rosterRevision) throw new RosterChangedSignal();
            if (target) assertTeamAccepts(teamSnapshot, target);
            observedCounter = counter.exists() ? Number(counter.data().lastNumber) || 0 : 0;
            let number = firstNumberToTry(observedCounter, hint);
            let participantId = '';
            for (let probe = 0; probe < NUMBER_PROBE_LIMIT && !participantId; probe += 1, number += 1) {
              const id = String(number);
              const taken = await Promise.all([
                transaction.get(numberRef(eventId, id)),
                transaction.get(unassignedRef(eventId, id)),
                ...teamIds.map(teamId => transaction.get(candidateRef(eventId, teamId, id)))
              ]);
              if (taken.every(snapshot => !snapshot.exists())) participantId = id;
            }
            if (!participantId) throw new Error('לא נמצא מספר פנוי. רענן את הדף ונסה שוב.');
            const stamp = serverTimestamp();
            transaction.set(counterRef(eventId), { lastNumber: Number(participantId), updatedAt: stamp, updatedBy: uid });
            transaction.set(numberRef(eventId, participantId), {
              participantId, team: target, source: 'intake', claimedAt: stamp, claimedBy: uid,
              updatedAt: stamp, updatedBy: uid, schemaVersion: NUMBER_REGISTRY_SCHEMA_VERSION
            });
            if (target) {
              transaction.set(candidateRef(eventId, target, participantId), candidateDocument(target, participantId, profile, stamp));
              transaction.update(teamRef(eventId, target), {
                participantIds: rosterWith(teamSnapshot.data().participantIds, participantId),
                updatedAt: stamp, updatedBy: uid
              });
            } else {
              transaction.set(unassignedRef(eventId, participantId), unassignedDocument(participantId, profile, stamp));
            }
            return { participantId, team: target };
          }, { maxAttempts: CREATE_MAX_ATTEMPTS });
        } catch (error) {
          if (error instanceof RosterChangedSignal) {
            rosterChanges += 1;
            if (rosterChanges >= 3) throw new Error('רשימת המועמדים מתעדכנת כרגע (ייבוא במקביל). נסה שוב בעוד רגע.');
            hint = null;
            continue;
          }
          // קליטה מקבילה שנשמרה ראשונה הופכת את הכתיבה שלנו ללא תקפה, והשרת
          // דוחה אותה כהרשאה ולא כהתנגשות. אם המונה זז — זו התנגשות: מנסים שוב
          // מההתחלה עם מספר חדש. אחרת זו דחייה אמיתית ומחזירים אותה.
          if (isPermissionDenied(error) && observedCounter !== null && await counterMovedFrom(eventId, observedCounter)) {
            await pause();
            continue;
          }
          throw error;
        }
      }
      throw new Error('יותר מדי קליטות במקביל — המועמד לא נשמר. נסה שוב.');
    },

    // תיקון פרטים אישיים. expectedRevision הוא profileRevision שהוצג למשתמש.
    async updateProfile(eventId, { team, participantId, profileRevision }, input) {
      const { profile, errors } = prepareIntakeProfile(input);
      if (errors.length) throw new Error(errors[0]);
      const reference = recordRef(eventId, team, participantId);
      await explainConcurrentDenial(reference, profileRevision, () => runTransaction(db, async transaction => {
        const [eventSnapshot, snapshot] = await Promise.all([transaction.get(eventRef(eventId)), transaction.get(reference)]);
        assertOpen(eventSnapshot);
        if (!snapshot.exists()) throw new Error('המועמד הועבר או נמחק במכשיר אחר. רענן ונסה שוב.');
        const current = Math.max(0, Math.floor(Number(snapshot.data().profileRevision) || 0));
        if (profileRevision != null && current !== Number(profileRevision)) {
          throw new Error('פרטי המועמד עודכנו במכשיר אחר. בדוק את הפרטים המעודכנים ונסה שוב.');
        }
        transaction.update(reference, {
          ...profileFields(profile), profileRevision: current + 1,
          profileUpdatedAt: serverTimestamp(), profileUpdatedBy: uid
        });
      }));
    },

    dataReasons,

    // העברה אטומית: רשומה חדשה ביעד, מחיקת המקור, עדכון רשימות הצוותים
    // ועדכון רישום המספר — באותה טרנזקציה. מותרת רק כשאין למועמד נתונים.
    async moveCandidate(eventId, { participantId, from, to }, { eventStatus = '' } = {}) {
      const id = normalizeParticipantId(participantId);
      const source = normalizeIntakeTeam(from);
      const target = normalizeIntakeTeam(to);
      if (!/^\d+$/.test(id) || id === '0') throw new Error('מספר מועמד אינו תקין.');
      if (source === target) throw new Error(`המועמד כבר נמצא ב${intakeTeamLabel(target)}.`);
      if (source) {
        const reasons = await dataReasons(eventId, { team: source, participantId: id }, { eventStatus });
        if (reasons.length) throw new IntakeMoveBlockedError(reasons);
      }
      await explainConcurrentDenial(recordRef(eventId, source, id), null, () => runTransaction(db, async transaction => {
        const [eventSnapshot, sourceSnapshot, targetSnapshot, numberSnapshot, sourceTeam, targetTeam] = await Promise.all([
          transaction.get(eventRef(eventId)),
          transaction.get(recordRef(eventId, source, id)),
          transaction.get(recordRef(eventId, target, id)),
          transaction.get(numberRef(eventId, id)),
          source ? transaction.get(teamRef(eventId, source)) : Promise.resolve(null),
          target ? transaction.get(teamRef(eventId, target)) : Promise.resolve(null)
        ]);
        assertOpen(eventSnapshot);
        if (!sourceSnapshot.exists()) throw new Error('המועמד כבר הועבר או נמחק במכשיר אחר. רענן ונסה שוב.');
        if (targetSnapshot.exists()) throw new Error(`מספר ${id} כבר קיים ב${intakeTeamLabel(target)}.`);
        if (source) {
          const reasons = candidateDataReasons({ candidate: { id: sourceSnapshot.id, ...sourceSnapshot.data() } });
          if (reasons.length) throw new IntakeMoveBlockedError(reasons);
        }
        if (numberSnapshot.exists() && normalizeIntakeTeam(numberSnapshot.data().team) !== source) {
          throw new Error('רישום המספר אינו תואם למיקום המועמד. רענן ונסה שוב.');
        }
        if (target) assertTeamAccepts(targetTeam, target, id);
        const profile = normalizeCandidateProfile(sourceSnapshot.data(), { participantId: id });
        const stamp = serverTimestamp();
        transaction.set(recordRef(eventId, target, id), target
          ? candidateDocument(target, id, profile, stamp) : unassignedDocument(id, profile, stamp));
        transaction.delete(recordRef(eventId, source, id));
        const sourceIds = (sourceTeam?.data()?.participantIds || []).map(normalizeParticipantId);
        if (source && sourceTeam?.exists() && sourceIds.includes(id)) {
          transaction.update(teamRef(eventId, source), {
            participantIds: rosterWithout(sourceIds, id), updatedAt: stamp, updatedBy: uid
          });
        }
        if (target) {
          transaction.update(teamRef(eventId, target), {
            participantIds: rosterWith(targetTeam.data().participantIds, id), updatedAt: stamp, updatedBy: uid
          });
        }
        if (numberSnapshot.exists()) {
          transaction.update(numberRef(eventId, id), { team: target, updatedAt: stamp, updatedBy: uid });
        } else {
          // מספר מייבוא Excel שעדיין לא נרשם: נרשם עכשיו, במיקום החדש.
          transaction.set(numberRef(eventId, id), {
            participantId: id, team: target, source: 'legacy', claimedAt: stamp, claimedBy: uid,
            updatedAt: stamp, updatedBy: uid, schemaVersion: NUMBER_REGISTRY_SCHEMA_VERSION
          });
        }
      }));
      return { participantId: id, from: source, to: target };
    }
  };
}
