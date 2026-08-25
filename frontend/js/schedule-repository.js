import {
  collection, doc, getDoc, limit, onSnapshot, orderBy, query,
  runTransaction, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  SCHEDULE_SCHEMA_VERSION, SCHEDULE_TIME_ZONE, buildTeamScheduleProjection,
  normalizeSchedule, scheduleIssues
} from './schedule-model.js';
import { DEFAULT_SCHEDULE_LOAD_POLICY } from './schedule-load-policy.js';
import {
  SCHEDULE_DRAFT_SCHEMA_VERSION, SCHEDULE_PUBLICATION_TYPES,
  buildScheduleRelease, normalizeScheduleDraft,
  normalizeScheduleWarnings
} from './schedule-publication-model.js';

export class ScheduleConflictError extends Error {
  constructor(message = 'הלו״ז השתנה במכשיר אחר. טען את הגרסה העדכנית לפני פעולה נוספת.') {
    super(message);
    this.name = 'ScheduleConflictError';
  }
}

const revisionNumber = value => Math.max(0, Math.floor(Number(value) || 0));

function scheduleContent(source, fallbackTeamIds = []) {
  const normalized = normalizeSchedule(source, fallbackTeamIds);
  const warnings = normalizeScheduleWarnings(source?.loadWarnings);
  const overrideReason = warnings.length ? String(source?.overrideReason || '').trim().slice(0, 500) : '';
  if (warnings.length && !overrideReason) {
    throw new Error('יש לתעד סיבה מפורשת ללו״ז עם אזהרות עומס.');
  }
  return { normalized, warnings, overrideReason };
}

export function createScheduleRepository(db, user) {
  if (!db || !user?.uid) throw new Error('חסרים פרטי חיבור לשמירת הלו״ז.');

  const eventRef = eventId => doc(db, 'events', String(eventId));
  const masterRef = eventId => doc(db, 'events', String(eventId), 'schedule', 'master');
  const draftRef = eventId => doc(db, 'events', String(eventId), 'schedule', 'draft');
  const teamRef = (eventId, team) => doc(db, 'events', String(eventId), 'teamSchedules', String(team));
  const revisionRef = (eventId, revisionKey) =>
    doc(db, 'events', String(eventId), 'scheduleRevisions', String(revisionKey));

  function assertActiveEvent(snapshot) {
    if (!snapshot.exists() || snapshot.data().status !== 'active') {
      throw new Error('האירוע אינו פעיל ולכן הלו״ז נעול לעריכה.');
    }
  }

  function assertWorkspaceRevisions({ masterSnapshot, draftSnapshot, expectedPublishedRevision, expectedDraftRevision }) {
    const published = masterSnapshot.exists() ? revisionNumber(masterSnapshot.data().revision) : 0;
    const draft = draftSnapshot.exists() ? revisionNumber(draftSnapshot.data().draftRevision) : 0;
    if (published !== revisionNumber(expectedPublishedRevision) || draft !== revisionNumber(expectedDraftRevision)) {
      throw new ScheduleConflictError();
    }
    return { published, draft };
  }

  function publishedPayload(eventId, release, content, masterSnapshot) {
    return {
      eventId:String(eventId),
      teamIds:release.teamIds,
      commanderNames:release.commanderNames,
      rows:release.rows,
      loadPolicy:{ ...DEFAULT_SCHEDULE_LOAD_POLICY },
      loadWarnings:content.warnings,
      overrideReason:content.overrideReason,
      revision:release.revision,
      revisionKey:release.revisionKey,
      publicationType:release.publicationType,
      restoredFromRevisionKey:release.restoredFromRevisionKey,
      schemaVersion:SCHEDULE_SCHEMA_VERSION,
      timeZone:SCHEDULE_TIME_ZONE,
      createdAt:masterSnapshot.exists() ? masterSnapshot.data().createdAt : serverTimestamp(),
      createdBy:masterSnapshot.exists() ? String(masterSnapshot.data().createdBy || user.uid) : user.uid,
      updatedAt:serverTimestamp(),
      updatedBy:user.uid
    };
  }

  function draftPayload(eventId, content, {
    baseRevision, draftRevision, draftSnapshot
  }) {
    return {
      eventId:String(eventId),
      teamIds:content.normalized.teamIds,
      commanderNames:content.normalized.commanderNames,
      rows:content.normalized.rows,
      loadPolicy:{ ...DEFAULT_SCHEDULE_LOAD_POLICY },
      loadWarnings:content.warnings,
      overrideReason:content.overrideReason,
      baseRevision:revisionNumber(baseRevision),
      draftRevision:revisionNumber(draftRevision),
      schemaVersion:SCHEDULE_DRAFT_SCHEMA_VERSION,
      timeZone:SCHEDULE_TIME_ZONE,
      createdAt:draftSnapshot.exists() ? draftSnapshot.data().createdAt : serverTimestamp(),
      createdBy:draftSnapshot.exists() ? String(draftSnapshot.data().createdBy || user.uid) : user.uid,
      updatedAt:serverTimestamp(),
      updatedBy:user.uid
    };
  }

  function writePublication(transaction, {
    eventId, source, content, masterSnapshot, draftSnapshot,
    publishedRevision, draftRevision, publicationType, restoredFromRevisionKey = ''
  }) {
    const release = buildScheduleRelease(source, {
      publishedRevision, publicationType, restoredFromRevisionKey
    });
    const masterPayload = publishedPayload(eventId, release, content, masterSnapshot);
    transaction.set(masterRef(eventId), masterPayload);
    release.teamIds.forEach(team => {
      const projection = buildTeamScheduleProjection(release, team);
      transaction.set(teamRef(eventId, team), {
        eventId:String(eventId), ...projection,
        updatedAt:serverTimestamp(), updatedBy:user.uid
      });
    });
    transaction.set(revisionRef(eventId, release.revisionKey), {
      ...masterPayload,
      createdAt:serverTimestamp(), createdBy:user.uid,
      updatedAt:serverTimestamp(), updatedBy:user.uid
    });
    transaction.set(draftRef(eventId), draftPayload(eventId, content, {
      baseRevision:release.revision,
      draftRevision:draftRevision + 1,
      draftSnapshot
    }));
    return release.revision;
  }

  return {
    subscribeMaster(eventId, onValue, onError) {
      return onSnapshot(masterRef(eventId), snapshot => {
        onValue(snapshot.exists() ? { id:snapshot.id, ...snapshot.data() } : null);
      }, onError);
    },

    subscribeWorkspace(eventId, onValue, onError) {
      const state = { published:null, draft:null };
      const ready = { published:false, draft:false };
      const emit = () => {
        if (ready.published && ready.draft) onValue({ ...state });
      };
      const unsubscribePublished = onSnapshot(masterRef(eventId), snapshot => {
        state.published = snapshot.exists() ? { id:snapshot.id, ...snapshot.data() } : null;
        ready.published = true;
        emit();
      }, onError);
      const unsubscribeDraft = onSnapshot(draftRef(eventId), snapshot => {
        state.draft = snapshot.exists() ? { id:snapshot.id, ...snapshot.data() } : null;
        ready.draft = true;
        emit();
      }, onError);
      return () => {
        unsubscribePublished();
        unsubscribeDraft();
      };
    },

    subscribeRevisions(eventId, onValue, onError, maximum = 50) {
      return onSnapshot(query(
        collection(db, 'events', String(eventId), 'scheduleRevisions'),
        orderBy('revision', 'desc'), limit(Math.max(1, Math.min(50, Number(maximum) || 20)))
      ), snapshot => onValue(snapshot.docs.map(item => ({ id:item.id, ...item.data() }))), onError);
    },

    subscribeTeam(eventId, team, onValue, onError) {
      return onSnapshot(teamRef(eventId, team), snapshot => {
        onValue(snapshot.exists() ? { id:snapshot.id, ...snapshot.data() } : null);
      }, onError);
    },

    async getTeam(eventId, team) {
      const snapshot = await getDoc(teamRef(eventId, team));
      return snapshot.exists() ? { id:snapshot.id, ...snapshot.data() } : null;
    },

    async saveDraft({
      eventId, schedule, expectedPublishedRevision, expectedDraftRevision,
      warnings = [], overrideReason = '', stationIdsByTeam = {}
    }) {
      const issues = scheduleIssues(schedule, { stationIdsByTeam });
      if (issues.length) throw new Error(issues[0]);
      const content = scheduleContent({ ...schedule, loadWarnings:warnings, overrideReason }, schedule?.teamIds);
      return runTransaction(db, async transaction => {
        const [eventSnapshot, masterSnapshot, draftSnapshot] = await Promise.all([
          transaction.get(eventRef(eventId)), transaction.get(masterRef(eventId)), transaction.get(draftRef(eventId))
        ]);
        assertActiveEvent(eventSnapshot);
        const revisions = assertWorkspaceRevisions({
          masterSnapshot, draftSnapshot, expectedPublishedRevision, expectedDraftRevision
        });
        const nextDraftRevision = revisions.draft + 1;
        transaction.set(draftRef(eventId), draftPayload(eventId, content, {
          baseRevision:revisions.published,
          draftRevision:nextDraftRevision,
          draftSnapshot
        }));
        return { draftRevision:nextDraftRevision, baseRevision:revisions.published };
      });
    },

    async publishDraft({
      eventId, expectedPublishedRevision, expectedDraftRevision, stationIdsByTeam = {}
    }) {
      return runTransaction(db, async transaction => {
        const [eventSnapshot, masterSnapshot, draftSnapshot] = await Promise.all([
          transaction.get(eventRef(eventId)), transaction.get(masterRef(eventId)), transaction.get(draftRef(eventId))
        ]);
        assertActiveEvent(eventSnapshot);
        const revisions = assertWorkspaceRevisions({
          masterSnapshot, draftSnapshot, expectedPublishedRevision, expectedDraftRevision
        });
        if (!draftSnapshot.exists()) throw new Error('יש לשמור טיוטה לפני פרסום הלו״ז.');
        const draft = normalizeScheduleDraft(draftSnapshot.data(), [], revisions.published);
        if (draft.baseRevision !== revisions.published) throw new ScheduleConflictError();
        const issues = scheduleIssues(draft, { stationIdsByTeam });
        if (issues.length) throw new Error(issues[0]);
        const content = scheduleContent(draft, draft.teamIds);
        return writePublication(transaction, {
          eventId, source:draft, content, masterSnapshot, draftSnapshot,
          publishedRevision:revisions.published, draftRevision:revisions.draft,
          publicationType:SCHEDULE_PUBLICATION_TYPES.PUBLISH
        });
      });
    },

    async restoreRevision({
      eventId, revisionKey, expectedPublishedRevision, expectedDraftRevision, stationIdsByTeam = {}
    }) {
      return runTransaction(db, async transaction => {
        const sourceReference = revisionRef(eventId, revisionKey);
        const [eventSnapshot, masterSnapshot, draftSnapshot, sourceSnapshot] = await Promise.all([
          transaction.get(eventRef(eventId)), transaction.get(masterRef(eventId)),
          transaction.get(draftRef(eventId)), transaction.get(sourceReference)
        ]);
        assertActiveEvent(eventSnapshot);
        const revisions = assertWorkspaceRevisions({
          masterSnapshot, draftSnapshot, expectedPublishedRevision, expectedDraftRevision
        });
        if (!sourceSnapshot.exists()) throw new Error('גרסת הלו״ז שנבחרה אינה קיימת.');
        const source = normalizeScheduleDraft(sourceSnapshot.data(), [], revisions.published);
        const issues = scheduleIssues(source, { stationIdsByTeam });
        if (issues.length) throw new Error(issues[0]);
        const content = scheduleContent(source, source.teamIds);
        return writePublication(transaction, {
          eventId, source, content, masterSnapshot, draftSnapshot,
          publishedRevision:revisions.published, draftRevision:revisions.draft,
          publicationType:SCHEDULE_PUBLICATION_TYPES.RESTORE,
          restoredFromRevisionKey:String(revisionKey)
        });
      });
    }
  };
}
