import {
  collection, doc, getDoc, getDocs, runTransaction, serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  CANDIDATE_SCHEMA_VERSION, FORMATION_EVENT_SCHEMA_VERSION, TEAM_ROSTER_SCHEMA_VERSION,
  candidateKey, normalizeCandidateProfile, padTeam
} from './formation-operations-model.js';
import {
  EVENT_SETUP_SCHEMA_VERSION, EVENT_STATUSES, normalizeEventStaff, normalizeEventTeamId
} from './event-setup-model.js';
import { EVENT_STAFFING_SCHEMA_VERSION, ROLES } from './roles.js';

const BATCH_LIMIT = 450;

async function commitOperations(db, operations) {
  for (let start = 0; start < operations.length; start += BATCH_LIMIT) {
    const batch = writeBatch(db);
    operations.slice(start, start + BATCH_LIMIT).forEach(operation => operation(batch));
    await batch.commit();
  }
}

const snapshotRows = snapshot => snapshot.docs.map(item => ({ id:item.id, ...item.data() }));

export function createEventSetupRepository(db, adminUser) {
  if (!db || !adminUser?.uid || adminUser.role !== 'admin') {
    throw new Error('הגדרת אירוע זמינה למנהל בלבד.');
  }
  const uid = adminUser.uid;
  const eventRef = eventId => doc(db, 'events', String(eventId));
  const teamRef = (eventId, team) => doc(db, 'events', String(eventId), 'teams', String(team));
  const candidateRef = (eventId, team, participantId) =>
    doc(db, 'events', String(eventId), 'candidates', candidateKey(team, participantId));
  const staffRef = (eventId, staffUid) => doc(db, 'events', String(eventId), 'staff', String(staffUid));

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
      if (teamIds.length > 15) throw new Error('ניתן להגדיר עד 15 צוותים.');
      const eventSnapshot = await getDoc(eventRef(eventId));
      if (!eventSnapshot.exists() || ![EVENT_STATUSES.DRAFT, EVENT_STATUSES.ACTIVE].includes(eventSnapshot.data().status)) {
        throw new Error('לא ניתן לערוך צוותים באירוע במצב הנוכחי.');
      }
      const existing = await getDocs(collection(db, 'events', String(eventId), 'teams'));
      const existingIds = new Set(existing.docs.map(item => item.id));
      const completeTeamIds = [...new Set([...existingIds, ...teamIds])]
        .filter(normalizeEventTeamId).sort((left, right) => Number(left) - Number(right));
      if (completeTeamIds.length > 15) throw new Error('ניתן להגדיר עד 15 צוותים.');
      const operations = completeTeamIds.filter(team => !existingIds.has(team)).map(team => batch => batch.set(teamRef(eventId, team), {
        teamNumber:team,
        participantIds:[],
        stationMap:typeof stationMapFactory === 'function' ? stationMapFactory(team) : {},
        rosterSource:{ type:'manual', sourceId:'event-setup', fileName:'' },
        schemaVersion:TEAM_ROSTER_SCHEMA_VERSION,
        active:true,
        createdAt:serverTimestamp(),
        createdBy:uid,
        updatedAt:serverTimestamp(),
        updatedBy:uid
      }));
      operations.push(batch => batch.update(eventRef(eventId), {
        teamCount:completeTeamIds.length, updatedAt:serverTimestamp(), updatedBy:uid
      }));
      await commitOperations(db, operations);
      return completeTeamIds;
    },

    async replaceTeamCandidates(eventId, teamValue, candidateValues, source = {}) {
      const team = normalizeEventTeamId(teamValue);
      if (!team) throw new Error('מספר הצוות אינו תקין.');
      const eventSnapshot = await getDoc(eventRef(eventId));
      if (!eventSnapshot.exists() || ![EVENT_STATUSES.DRAFT, EVENT_STATUSES.ACTIVE].includes(eventSnapshot.data().status)) {
        throw new Error('לא ניתן לערוך מועמדים באירוע במצב הנוכחי.');
      }
      const candidates = (Array.isArray(candidateValues) ? candidateValues : []).map(normalizeCandidateProfile);
      const participantIds = candidates.map(candidate => candidate.participantId);
      if (participantIds.some(value => !value || value === '0' || !/^\d+$/.test(value))) {
        throw new Error('לכל מועמד נדרש מספר מועמד מספרי.');
      }
      if (new Set(participantIds).size !== participantIds.length) throw new Error('מספר מועמד מופיע יותר מפעם אחת.');
      const existing = await getDocs(collection(db, 'events', String(eventId), 'candidates'));
      const existingTeam = existing.docs.filter(item => padTeam(item.data().team) === team);
      const existingByKey = new Map(existingTeam.map(item => [item.id, item]));
      const nextKeys = new Set(participantIds.map(participantId => candidateKey(team, participantId)));
      const persistedParticipantIds = eventSnapshot.data().status === EVENT_STATUSES.ACTIVE
        ? [...new Set([...existingTeam.map(item => String(item.data().participantId)), ...participantIds])]
            .sort((left, right) => Number(left) - Number(right))
        : participantIds;
      if (persistedParticipantIds.length > 20) throw new Error('ניתן לשייך עד 20 מועמדים לצוות.');
      const operations = candidates.map(candidate => batch => {
        const reference = candidateRef(eventId, team, candidate.participantId);
        const previous = existingByKey.get(candidateKey(team, candidate.participantId));
        const profile = {
          firstName:candidate.firstName,
          nationalId:candidate.nationalId,
          emergencyContactPhone:candidate.emergencyContactPhone,
          doctorClearance:candidate.doctorClearance,
          medicClearance:candidate.medicClearance,
          profileRevision:Math.max(0, Number(previous?.data()?.profileRevision || 0)) + (previous ? 1 : 0),
          profileUpdatedAt:serverTimestamp(), profileUpdatedBy:uid
        };
        if (previous) batch.update(reference, profile);
        else batch.set(reference, {
          participantId:candidate.participantId, team, ...profile,
          status:'active', reasonCode:'', reasonLabel:'', statusRevision:0,
          lastTransitionId:'', statusChangedAt:serverTimestamp(), statusChangedBy:uid,
          schemaVersion:CANDIDATE_SCHEMA_VERSION
        });
      });
      if (eventSnapshot.data().status === EVENT_STATUSES.DRAFT) {
        existingTeam.filter(item => !nextKeys.has(item.id)).forEach(item => {
          operations.push(batch => batch.delete(item.ref));
        });
      }
      operations.push(batch => batch.set(teamRef(eventId, team), {
        participantIds:persistedParticipantIds,
        rosterSource:{
          type:String(source.type || 'manual').slice(0, 30),
          sourceId:String(source.sourceId || 'event-setup').slice(0, 200),
          fileName:String(source.fileName || '').slice(0, 240)
        },
        updatedAt:serverTimestamp(), updatedBy:uid
      }, { merge:true }));
      await commitOperations(db, operations);

      const allCandidates = await getDocs(collection(db, 'events', String(eventId), 'candidates'));
      await writeBatch(db).update(eventRef(eventId), {
        candidateCount:allCandidates.size, updatedAt:serverTimestamp(), updatedBy:uid
      }).commit();
      return candidates.length;
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
        if (!masterSnapshot.exists()) throw new Error('יש לפרסם את גרסת הלו״ז הראשונה לפני הפעלת האירוע.');
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
