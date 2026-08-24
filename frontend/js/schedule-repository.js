import {
  doc, getDoc, onSnapshot, runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  SCHEDULE_SCHEMA_VERSION, SCHEDULE_TIME_ZONE, buildTeamScheduleProjection,
  normalizeSchedule, scheduleIssues
} from './schedule-model.js';
import { DEFAULT_SCHEDULE_LOAD_POLICY } from './schedule-load-policy.js';

export class ScheduleConflictError extends Error {
  constructor(message = 'הלו״ז השתנה במכשיר אחר. טען את הגרסה העדכנית לפני שמירה נוספת.') {
    super(message);
    this.name = 'ScheduleConflictError';
  }
}

const safeWarnings = warnings => (Array.isArray(warnings) ? warnings : []).slice(0, 100).map(warning => ({
  code: String(warning?.code || '').slice(0, 50),
  team: String(warning?.team || '').slice(0, 2),
  rowId: String(warning?.rowId || '').slice(0, 80),
  message: String(warning?.message || '').slice(0, 300)
}));

export function createScheduleRepository(db, user) {
  if (!db || !user?.uid) throw new Error('חסרים פרטי חיבור לשמירת הלו״ז.');

  const masterRef = eventId => doc(db, 'events', String(eventId), 'schedule', 'master');
  const teamRef = (eventId, team) => doc(db, 'events', String(eventId), 'teamSchedules', String(team));

  return {
    subscribeMaster(eventId, onValue, onError) {
      return onSnapshot(masterRef(eventId), snapshot => {
        onValue(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null);
      }, onError);
    },

    subscribeTeam(eventId, team, onValue, onError) {
      return onSnapshot(teamRef(eventId, team), snapshot => {
        onValue(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null);
      }, onError);
    },

    async getTeam(eventId, team) {
      const snapshot = await getDoc(teamRef(eventId, team));
      return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
    },

    async saveMaster({
      eventId, schedule, expectedRevision, warnings = [], overrideReason = '',
      stationIdsByTeam = {}
    }) {
      const issues = scheduleIssues(schedule, { stationIdsByTeam });
      if (issues.length) throw new Error(issues[0]);
      const normalized = normalizeSchedule(schedule, schedule?.teamIds);
      const persistedWarnings = safeWarnings(warnings);
      const reason = persistedWarnings.length
        ? String(overrideReason || '').trim().slice(0, 500) : '';
      if (persistedWarnings.length && !reason) {
        throw new Error('יש לתעד סיבה מפורשת לשמירת לו״ז עם אזהרות עומס.');
      }
      const expected = Math.max(0, Number(expectedRevision) || 0);
      return runTransaction(db, async transaction => {
        const eventReference = doc(db, 'events', String(eventId));
        const masterReference = masterRef(eventId);
        const [eventSnapshot, masterSnapshot] = await Promise.all([
          transaction.get(eventReference), transaction.get(masterReference)
        ]);
        if (!eventSnapshot.exists() || eventSnapshot.data().status !== 'active') {
          throw new Error('האירוע אינו פעיל ולכן הלו״ז נעול לעריכה.');
        }
        const storedRevision = masterSnapshot.exists() ? Number(masterSnapshot.data().revision || 0) : 0;
        if (storedRevision !== expected) throw new ScheduleConflictError();
        const revision = storedRevision + 1;
        const revisionKey = `r-${String(revision).padStart(6, '0')}`;
        const nextSchedule = { ...normalized, revision };
        const basePayload = {
          eventId: String(eventId), teamIds: nextSchedule.teamIds,
          commanderNames: nextSchedule.commanderNames, rows: nextSchedule.rows,
          loadPolicy: { ...DEFAULT_SCHEDULE_LOAD_POLICY },
          loadWarnings: persistedWarnings, overrideReason: reason,
          revision, revisionKey, schemaVersion: SCHEDULE_SCHEMA_VERSION, timeZone: SCHEDULE_TIME_ZONE,
          createdAt: masterSnapshot.exists() ? masterSnapshot.data().createdAt : serverTimestamp(),
          createdBy: masterSnapshot.exists() ? String(masterSnapshot.data().createdBy || user.uid) : user.uid,
          updatedAt: serverTimestamp(), updatedBy: user.uid
        };
        transaction.set(masterReference, basePayload);
        nextSchedule.teamIds.forEach(team => {
          const projection = buildTeamScheduleProjection(nextSchedule, team);
          transaction.set(teamRef(eventId, team), {
            eventId: String(eventId), ...projection,
            updatedAt: serverTimestamp(), updatedBy: user.uid
          });
        });
        transaction.set(doc(db, 'events', String(eventId), 'scheduleRevisions', revisionKey), {
          ...basePayload, createdAt: serverTimestamp(), createdBy: user.uid,
          updatedAt: serverTimestamp(), updatedBy: user.uid
        });
        return revision;
      });
    }
  };
}
