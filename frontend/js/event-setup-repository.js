import {
  collection, doc, getDoc, getDocs, runTransaction, serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  CANDIDATE_SCHEMA_VERSION, FORMATION_EVENT_SCHEMA_VERSION
} from './formation-operations-model.js';
import {
  EVENT_SETUP_SCHEMA_VERSION, EVENT_STATUSES, normalizeEventStaff, normalizeEventTeamId, newEventTeamData
} from './event-setup-model.js';
import { EVENT_STAFFING_SCHEMA_VERSION, ROLES } from './roles.js';
import { planEventRoster, PROFILE_FIELDS } from './event-roster-plan.js';
// מקור אמת יחיד למספר הצוותים. המספר היה כתוב כאן בנפרד, וזה בדיוק סוג
// הכפילות שמשאירה מגבלה ישנה אחרי שהעלו אותה במקום אחר.
import { SCHEDULE_MAX_TEAMS as MAX_EVENT_TEAMS } from './schedule-model.js';
import { scheduleIssues } from './schedule-model.js';

const BATCH_LIMIT = 450;

async function commitOperations(db, operations) {
  for (let start = 0; start < operations.length; start += BATCH_LIMIT) {
    const batch = writeBatch(db);
    operations.slice(start, start + BATCH_LIMIT).forEach(operation => operation(batch));
    await batch.commit();
  }
}

const snapshotRows = snapshot => snapshot.docs.map(item => ({ id:item.id, ...item.data() }));

export class RosterImportError extends Error {
  constructor(cause, completedTeams, pendingTeams) {
    const saved = completedTeams.length ? `נשמרו צוותים: ${completedTeams.map(Number).join(', ')}. ` : '';
    super(`${saved}הייבוא לא הושלם. רענן את הנתונים ובדוק לפני ניסיון חוזר. ${cause.message || ''}`);
    this.name = 'RosterImportError';
    this.cause = cause;
    this.completedTeams = [...completedTeams];
    this.pendingTeams = [...pendingTeams];
  }
}

export function createEventSetupRepository(db, adminUser, { stationMapFactory = () => ({}) } = {}) {
  if (!db || !adminUser?.uid || adminUser.role !== 'admin') {
    throw new Error('הגדרת אירוע זמינה למנהל בלבד.');
  }
  const uid = adminUser.uid;
  const eventRef = eventId => doc(db, 'events', String(eventId));
  const teamRef = (eventId, team) => doc(db, 'events', String(eventId), 'teams', String(team));
  const staffRef = (eventId, staffUid) => doc(db, 'events', String(eventId), 'staff', String(staffUid));

  async function importCandidates(eventId, groups, source = {}, { onProgress = () => {} } = {}) {
    // Capture the revision before the collection reads. Another import during
    // these reads is detected by the transaction, not silently overwritten.
    const initialEvent = await getDoc(eventRef(eventId));
    if (!initialEvent.exists()) throw new Error('האירוע אינו קיים.');
    const [teamSnapshot, candidateSnapshot] = await Promise.all([
      getDocs(collection(db, 'events', String(eventId), 'teams')),
      getDocs(collection(db, 'events', String(eventId), 'candidates'))
    ]);
    const event = initialEvent.data();
    const plan = planEventRoster({ status:event.status, teams:snapshotRows(teamSnapshot),
      existing:snapshotRows(candidateSnapshot), groups, source });
    let revision = Number(event.rosterRevision || 0);
    let candidateCount = candidateSnapshot.size;
    let teamCount = teamSnapshot.size;
    let expectedTeamCount = Number(event.teamCount || 0);
    const completedTeams = plan.plans.filter(team => !team.writeCount).map(team => team.team);
    // No names, identity numbers, phones, filenames or free-form exception text.
    const auditRef = source.type === 'excel' ? doc(collection(db, 'events', String(eventId), 'rosterImports')) : null;
    const auditPayload = (status, errorCode = '') => ({
      status, errorCode, totalTeams:plan.plans.length, completedTeams:completedTeams.length,
      importedCount:plan.importedCount, updatedAt:serverTimestamp(), updatedBy:uid, schemaVersion:1
    });
    if (auditRef) await writeBatch(db).set(auditRef, auditPayload('started')).commit();
    // Reporting must never turn a committed write into an apparent failure.
    const report = () => { try { onProgress({ completedTeams:completedTeams.length, totalTeams:plan.plans.length }); } catch (_) {} };
    report();
    for (const chunk of plan.chunks) {
      const nextCount = candidateCount + chunk.reduce((sum, team) => sum + team.delta, 0);
      try {
        await runTransaction(db, async transaction => {
          const [currentEvent, ...currentTeams] = await Promise.all([
            transaction.get(eventRef(eventId)),
            ...chunk.map(team => transaction.get(teamRef(eventId, team.team)))
          ]);
          if (!currentEvent.exists() || currentEvent.data().status !== event.status ||
              Number(currentEvent.data().teamCount || 0) !== expectedTeamCount ||
              Number(currentEvent.data().rosterRevision || 0) !== revision) {
            throw new Error('האירוע או רשימת המועמדים השתנו במכשיר אחר.');
          }
          chunk.forEach((team, index) => {
            if (!team.previousTeam) {
              if (currentTeams[index].exists()) throw new Error('רשימת הצוותים השתנתה. רענן ונסה שוב.');
              return;
            }
            const { id, ...expected } = team.previousTeam;
            if (!currentTeams[index].exists() || JSON.stringify(currentTeams[index].data()) !== JSON.stringify(expected)) {
              throw new Error(`נתוני צוות ${Number(team.team)} השתנו במכשיר אחר.`);
            }
          });
          // Updates are protected by profileRevision in Firestore rules. Draft
          // deletions additionally read the document to avoid deleting an edit.
          const deletions = chunk.flatMap(team => team.changes.filter(change => change.kind === 'delete'));
          const deletedSnapshots = await Promise.all(deletions.map(change =>
            transaction.get(doc(db, 'events', String(eventId), 'candidates', change.id))));
          deletions.forEach((change, index) => {
            if (!deletedSnapshots[index].exists() || deletedSnapshots[index].data().profileRevision !== change.previous.profileRevision) {
              throw new Error('פרטי מועמד השתנו במכשיר אחר.');
            }
          });
          for (const team of chunk) {
            for (const change of team.changes) {
              const reference = doc(db, 'events', String(eventId), 'candidates', change.id);
              if (change.kind === 'delete') { transaction.delete(reference); continue; }
              const profile = Object.fromEntries(PROFILE_FIELDS.map(field => [field, change.candidate[field]]));
              Object.assign(profile, {
                profileRevision:change.previous ? Number(change.previous.profileRevision || 0) + 1 : 0,
                profileUpdatedAt:serverTimestamp(), profileUpdatedBy:uid
              });
              if (change.kind === 'update') transaction.update(reference, profile);
              else transaction.set(reference, {
                participantId:change.candidate.participantId, team:team.team, ...profile,
                status:'active', reasonCode:'', reasonLabel:'', statusRevision:0,
                lastTransitionId:'', statusChangedAt:serverTimestamp(), statusChangedBy:uid,
                schemaVersion:CANDIDATE_SCHEMA_VERSION
              });
            }
            if (!team.previousTeam) transaction.set(teamRef(eventId, team.team), {
              ...newEventTeamData(team.team, stationMapFactory(team.team), uid, serverTimestamp()),
              participantIds:team.participantIds, rosterSource:team.rosterSource
            });
            else if (team.teamChanged) transaction.update(teamRef(eventId, team.team), {
              participantIds:team.participantIds, rosterSource:team.rosterSource,
              updatedAt:serverTimestamp(), updatedBy:uid
            });
          }
          transaction.update(eventRef(eventId), {
            candidateCount:nextCount, rosterRevision:revision + 1,
            teamCount:teamCount + chunk.filter(team => !team.previousTeam).length,
            updatedAt:serverTimestamp(), updatedBy:uid
          });
          if (auditRef) transaction.set(auditRef, {
            ...auditPayload(completedTeams.length + chunk.length === plan.plans.length ? 'complete' : 'partial'),
            completedTeams:completedTeams.length + chunk.length
          });
        });
      } catch (error) {
        if (auditRef) {
          const codes = ['permission-denied', 'unavailable', 'deadline-exceeded', 'aborted', 'resource-exhausted'];
          const code = codes.includes(error.code) ? error.code : 'validation-or-conflict';
          try { await writeBatch(db).set(auditRef, auditPayload('failed', code)).commit(); } catch (_) {
            // A connection failure can also prevent diagnostic persistence.
          }
        }
        throw new RosterImportError(error, completedTeams,
          plan.plans.filter(team => !completedTeams.includes(team.team)).map(team => team.team));
      }
      candidateCount = nextCount;
      teamCount += chunk.filter(team => !team.previousTeam).length;
      expectedTeamCount = teamCount;
      revision += 1;
      completedTeams.push(...chunk.map(team => team.team));
      report();
    }
    if (auditRef && !plan.chunks.length) await writeBatch(db).set(auditRef, auditPayload('complete')).commit();
    return { teams:plan.plans.length, importedCount:plan.importedCount, candidateCount:plan.candidateCount };
  }

  return {
    async listEvents() {
      const snapshot = await getDocs(collection(db, 'events'));
      return snapshotRows(snapshot)
        .filter(event => [EVENT_STATUSES.DRAFT, EVENT_STATUSES.ACTIVE].includes(event.status))
        .sort((left, right) => String(right.id).localeCompare(String(left.id)));
    },

    async createDraft(name) {
      const normalizedName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      if (!normalizedName) throw new Error('יש להזין שם לאירוע.');
      const reference = doc(collection(db, 'events'));
      await writeBatch(db)
        .set(reference, {
          name:normalizedName,
          status:EVENT_STATUSES.DRAFT,
          teamCount:0,
          candidateCount:0,
          schemaVersion:FORMATION_EVENT_SCHEMA_VERSION,
          setupSchemaVersion:EVENT_SETUP_SCHEMA_VERSION,
          createdAt:serverTimestamp(),
          createdBy:uid,
          updatedAt:serverTimestamp(),
          updatedBy:uid,
          activatedAt:null,
          activatedBy:'',
          closedAt:null,
          closedBy:''
        })
        .commit();
      return reference.id;
    },

    async load(eventId) {
      const [eventSnapshot, teamsSnapshot, candidatesSnapshot, staffSnapshot, artifactsSnapshot,
        masterSnapshot, draftSnapshot] = await Promise.all([
        getDoc(eventRef(eventId)),
        getDocs(collection(db, 'events', String(eventId), 'teams')),
        getDocs(collection(db, 'events', String(eventId), 'candidates')),
        getDocs(collection(db, 'events', String(eventId), 'staff')),
        getDocs(collection(db, 'events', String(eventId), 'artifacts')),
        getDoc(doc(db, 'events', String(eventId), 'schedule', 'master')),
        getDoc(doc(db, 'events', String(eventId), 'schedule', 'draft'))
      ]);
      if (!eventSnapshot.exists()) throw new Error('האירוע אינו קיים.');
      return {
        event:{ id:eventSnapshot.id, ...eventSnapshot.data() },
        teams:snapshotRows(teamsSnapshot),
        candidates:snapshotRows(candidatesSnapshot),
        staff:snapshotRows(staffSnapshot),
        artifacts:snapshotRows(artifactsSnapshot),
        schedule:draftSnapshot.exists()
          ? { id:draftSnapshot.id, ...draftSnapshot.data() }
          : masterSnapshot.exists() ? { id:masterSnapshot.id, ...masterSnapshot.data() } : null,
        publishedSchedule:masterSnapshot.exists() ? { id:masterSnapshot.id, ...masterSnapshot.data() } : null
      };
    },

    async saveDetails(eventId, name) {
      const normalizedName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
      if (!normalizedName) throw new Error('יש להזין שם לאירוע.');
      const snapshot = await getDoc(eventRef(eventId));
      if (!snapshot.exists() || ![EVENT_STATUSES.DRAFT, EVENT_STATUSES.ACTIVE].includes(snapshot.data().status)) {
        throw new Error('לא ניתן לערוך את האירוע במצב הנוכחי.');
      }
      await writeBatch(db).update(eventRef(eventId), {
        name:normalizedName, updatedAt:serverTimestamp(), updatedBy:uid
      }).commit();
    },

    async ensureTeams(eventId, teamValues, stationMapFactory) {
      const teamIds = [...new Set((Array.isArray(teamValues) ? teamValues : []).map(normalizeEventTeamId).filter(Boolean))]
        .sort((left, right) => Number(left) - Number(right));
      if (!teamIds.length) throw new Error('יש להגדיר לפחות צוות אחד.');
      if (teamIds.length > MAX_EVENT_TEAMS) throw new Error(`ניתן להגדיר עד ${MAX_EVENT_TEAMS} צוותים.`);
      const eventSnapshot = await getDoc(eventRef(eventId));
      if (!eventSnapshot.exists() || ![EVENT_STATUSES.DRAFT, EVENT_STATUSES.ACTIVE].includes(eventSnapshot.data().status)) {
        throw new Error('לא ניתן לערוך צוותים באירוע במצב הנוכחי.');
      }
      const existing = await getDocs(collection(db, 'events', String(eventId), 'teams'));
      const existingIds = new Set(existing.docs.map(item => item.id));
      const completeTeamIds = [...new Set([...existingIds, ...teamIds])]
        .filter(normalizeEventTeamId).sort((left, right) => Number(left) - Number(right));
      if (completeTeamIds.length > MAX_EVENT_TEAMS) throw new Error(`ניתן להגדיר עד ${MAX_EVENT_TEAMS} צוותים.`);
      await runTransaction(db, async transaction => {
        const current = await transaction.get(eventRef(eventId));
        const before = eventSnapshot.data();
        if (!current.exists() || current.data().status !== before.status ||
            Number(current.data().teamCount || 0) !== Number(before.teamCount || 0) ||
            Number(current.data().rosterRevision || 0) !== Number(before.rosterRevision || 0)) {
          throw new Error('רשימת הצוותים השתנתה בזמן העריכה. יש לרענן ולנסות שוב.');
        }
        const missingIds = completeTeamIds.filter(team => !existingIds.has(team));
        const missingSnapshots = await Promise.all(missingIds.map(team => transaction.get(teamRef(eventId, team))));
        if (missingSnapshots.some(snapshot => snapshot.exists())) {
          throw new Error('צוות נוסף במקביל. יש לרענן ולנסות שוב.');
        }
        missingIds.forEach(team => transaction.set(teamRef(eventId, team),
          newEventTeamData(team, typeof stationMapFactory === 'function' ? stationMapFactory(team) : {}, uid, serverTimestamp())
        ));
        transaction.update(eventRef(eventId), {
          teamCount:completeTeamIds.length, updatedAt:serverTimestamp(), updatedBy:uid
        });
      });
      return completeTeamIds;
    },

    importCandidates,

    async replaceTeamCandidates(eventId, team, candidates, source = {}) {
      const result = await importCandidates(eventId, [{ team, candidates }], source);
      return result.importedCount;
    },

    async replaceStaff(eventId, staffValues) {
      const members = (Array.isArray(staffValues) ? staffValues : []).map(normalizeEventStaff)
        .filter(member => member.uid && member.role);
      const duplicate = members.find((member, index) => members.findIndex(item => item.uid === member.uid) !== index);
      if (duplicate) throw new Error('אותו איש צוות שובץ יותר מפעם אחת.');
      const [existing, eventSnapshot] = await Promise.all([
        getDocs(collection(db, 'events', String(eventId), 'staff')),
        getDoc(eventRef(eventId))
      ]);
      if (!eventSnapshot.exists() || ![EVENT_STATUSES.DRAFT, EVENT_STATUSES.ACTIVE].includes(eventSnapshot.data().status)) {
        throw new Error('לא ניתן לערוך סגל באירוע במצב הנוכחי.');
      }
      const existingById = new Map(existing.docs.map(item => [item.id, item.data()]));
      const nextIds = new Set(members.map(member => member.uid));
      const operations = members.map(member => batch => {
        const previous = existingById.get(member.uid);
        batch.set(staffRef(eventId, member.uid), {
          ...member,
          eventId:String(eventId),
          updatedAt:serverTimestamp(), updatedBy:uid,
          ...(previous ? {} : { createdAt:serverTimestamp(), createdBy:uid })
        }, { merge:true });
      });
      existing.docs.filter(item => !nextIds.has(item.id) && item.data().active !== false).forEach(item => {
        operations.push(batch => batch.update(item.ref, {
          active:false, updatedAt:serverTimestamp(), updatedBy:uid
        }));
      });
      if (eventSnapshot.data().status === EVENT_STATUSES.ACTIVE) {
        members.forEach(member => operations.push(batch => batch.update(doc(db, 'users', member.uid), {
          role:member.role,
          team:member.role === ROLES.FORMATION_COMMANDER ? null : Number(member.team),
          updatedAt:serverTimestamp()
        })));
      }
      await commitOperations(db, operations);
      return members;
    },

    async saveArtifact(eventId, artifactId, value) {
      const id = String(artifactId || '').trim();
      if (!/^(team-\d{2}|evaluator-[A-Za-z0-9_-]{1,128})$/.test(id)) {
        throw new Error('מזהה קובץ האירוע אינו תקין.');
      }
      await writeBatch(db).set(doc(db, 'events', String(eventId), 'artifacts', id), {
        eventId:String(eventId),
        kind:id.startsWith('team-') ? 'team' : 'evaluator',
        targetId:id.startsWith('team-') ? id.slice(5) : id.slice(10),
        status:String(value?.status || 'failed'),
        fileId:String(value?.fileId || '').slice(0, 240),
        url:String(value?.url || '').slice(0, 1000),
        message:String(value?.message || '').slice(0, 500),
        updatedAt:serverTimestamp(), updatedBy:uid
      }, { merge:true }).commit();
    },

    async activate(eventId, readiness, staffValues = []) {
      if (!readiness?.canActivate) throw new Error(readiness?.blockers?.[0] || 'האירוע עדיין אינו מוכן להפעלה.');
      const members = (Array.isArray(staffValues) ? staffValues : []).map(normalizeEventStaff)
        .filter(member => member.active && member.uid && member.role);
      return runTransaction(db, async transaction => {
        const eventReference = eventRef(eventId);
        const pointerReference = doc(db, 'settings', 'activeEvent');
        const masterReference = doc(db, 'events', String(eventId), 'schedule', 'master');
        const [eventSnapshot, pointerSnapshot, masterSnapshot] = await Promise.all([
          transaction.get(eventReference), transaction.get(pointerReference), transaction.get(masterReference)
        ]);
        if (!eventSnapshot.exists() || eventSnapshot.data().status !== EVENT_STATUSES.DRAFT) {
          throw new Error('רק אירוע טיוטה ניתן להפעלה.');
        }
        if (!masterSnapshot.exists() || !masterSnapshot.data().rows?.length || scheduleIssues(masterSnapshot.data()).length) {
          throw new Error('יש לפרסם לו״ז תקין ולא ריק לפני הפעלת האירוע.');
        }
        if (pointerSnapshot.exists() && pointerSnapshot.data().status === EVENT_STATUSES.ACTIVE &&
            pointerSnapshot.data().eventId && pointerSnapshot.data().eventId !== String(eventId)) {
          const current = await transaction.get(eventRef(pointerSnapshot.data().eventId));
          if (current.exists() && current.data().status === EVENT_STATUSES.ACTIVE) {
            throw new Error('כבר קיים אירוע פעיל. יש לסגור אותו לפני הפעלת אירוע חדש.');
          }
        }
        members.forEach(member => transaction.update(doc(db, 'users', member.uid), {
          role:member.role,
          team:member.role === 'formation_commander' ? null : Number(member.team),
          updatedAt:serverTimestamp()
        }));
        transaction.update(eventReference, {
          status:EVENT_STATUSES.ACTIVE,
          teamCount:readiness.counts.teams,
          candidateCount:readiness.counts.candidates,
          activatedAt:serverTimestamp(), activatedBy:uid,
          updatedAt:serverTimestamp(), updatedBy:uid
        });
        transaction.set(pointerReference, {
          eventId:String(eventId), status:EVENT_STATUSES.ACTIVE,
          schemaVersion:FORMATION_EVENT_SCHEMA_VERSION,
          eventStaffingSchemaVersion:EVENT_STAFFING_SCHEMA_VERSION,
          updatedAt:serverTimestamp(), updatedBy:uid
        });
        return String(eventId);
      });
    }
  };
}
