import {
  collection, doc, getDoc, getDocs, onSnapshot, query, runTransaction, serverTimestamp, where
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  CANDIDATE_STATUSES, RECOMMENDATION_SCHEMA_VERSION, RECOMMENDATION_STATUSES,
  STATUS_EVENT_SCHEMA_VERSION,
  candidateKey, candidateRosterIssues, dropoutReasonLabel, isDropoutReason,
  normalizeCandidateRecord, normalizeCandidateProfile,
  normalizeRecommendation, padTeam
} from './formation-operations-model.js';

export function createFormationOperationsRepository(db, user) {
  const uid = String(user?.uid || '');
  if (!uid) throw new Error('חסר מזהה משתמש');

  const activeEventPointerRef = () => doc(db, 'settings', 'activeEvent');
  const eventRef = eventId => doc(db, 'events', String(eventId));
  const eventTeamRef = (eventId, team) => doc(db, 'events', String(eventId), 'teams', padTeam(team));
  const candidateRef = (eventId, team, participantId) => doc(
    db, 'events', String(eventId), 'candidates', candidateKey(team, participantId)
  );
  const recommendationRef = (eventId, team, participantId) => doc(
    db, 'events', String(eventId), 'dropoutRecommendations', candidateKey(team, participantId)
  );

  async function getActiveEvent() {
    const pointer = await getDoc(activeEventPointerRef());
    if (!pointer.exists() || pointer.data().status !== 'active' || !pointer.data().eventId) return null;
    const snapshot = await getDoc(eventRef(pointer.data().eventId));
    if (!snapshot.exists() || snapshot.data().status !== 'active') return null;
    return { id: snapshot.id, ...snapshot.data() };
  }

  async function getTeam(eventId, team) {
    const snapshot = await getDoc(eventTeamRef(eventId, team));
    return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
  }

  async function getCandidate(eventId, team, participantId) {
    const snapshot = await getDoc(candidateRef(eventId, team, participantId));
    return normalizeCandidateRecord(snapshot.exists() ? snapshot.data() : null, { team, participantId });
  }

  function subscribeCandidate(eventId, team, participantId, onValue, onError) {
    return onSnapshot(candidateRef(eventId, team, participantId), snapshot => {
      onValue(normalizeCandidateRecord(snapshot.exists() ? snapshot.data() : null, { team, participantId }));
    }, onError);
  }

  async function getRecommendation(eventId, team, participantId) {
    const snapshot = await getDoc(recommendationRef(eventId, team, participantId));
    return snapshot.exists() ? normalizeRecommendation(snapshot.data()) : null;
  }

  function subscribeRecommendation(eventId, team, participantId, onValue, onError) {
    return onSnapshot(recommendationRef(eventId, team, participantId), snapshot => {
      onValue(snapshot.exists() ? normalizeRecommendation(snapshot.data()) : null);
    }, onError);
  }

  async function recommendDropout(eventId, team, participantId, reasonCode, details = '') {
    if (!isDropoutReason(reasonCode)) throw new Error('יש לבחור סיבת נשירה');
    const normalizedTeam = padTeam(team);
    const normalizedDetails = String(details || '').trim().slice(0, 1000);
    const reference = recommendationRef(eventId, normalizedTeam, participantId);
    return runTransaction(db, async transaction => {
      const snapshot = await transaction.get(reference);
      const existing = snapshot.exists() ? normalizeRecommendation(snapshot.data()) : null;
      if (existing && existing.status === RECOMMENDATION_STATUSES.OPEN && existing.recommendedBy !== uid) {
        throw new Error('כבר קיימת המלצה פתוחה של מפק״צ אחר');
      }
      const preservesOpenRecommendation = existing?.status === RECOMMENDATION_STATUSES.OPEN;
      const payload = {
        participantId: String(participantId),
        team: normalizedTeam,
        reasonCode: String(reasonCode),
        reasonLabel: dropoutReasonLabel(reasonCode),
        details: normalizedDetails,
        status: RECOMMENDATION_STATUSES.OPEN,
        recommendedBy: uid,
        recommendedByName: String(user?.name || ''),
        revision: (existing?.revision || 0) + 1,
        createdAt: preservesOpenRecommendation ? snapshot.data().createdAt : serverTimestamp(),
        updatedAt: serverTimestamp(),
        resolvedAt: null,
        resolvedBy: '',
        schemaVersion: RECOMMENDATION_SCHEMA_VERSION
      };
      transaction.set(reference, payload);
      return normalizeRecommendation(payload);
    });
  }

  async function cancelRecommendation(eventId, team, participantId) {
    const reference = recommendationRef(eventId, team, participantId);
    return runTransaction(db, async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) return null;
      const current = normalizeRecommendation(snapshot.data());
      if (current.status !== RECOMMENDATION_STATUSES.OPEN) return current;
      if (current.recommendedBy !== uid) throw new Error('רק מי שיצר את ההמלצה יכול לבטל אותה');
      transaction.update(reference, {
        status: RECOMMENDATION_STATUSES.CANCELLED,
        revision: current.revision + 1,
        updatedAt: serverTimestamp(),
        resolvedAt: serverTimestamp(),
        resolvedBy: uid
      });
      return { ...current, status: RECOMMENDATION_STATUSES.CANCELLED };
    });
  }

  function recordCandidateTransition(transaction, {
    eventId, team, participantId, current, status, reasonCode = '', details = '', source = 'direct',
    recommendationId = ''
  }) {
    const stateReference = candidateRef(eventId, team, participantId);
    const historyReference = doc(collection(db, 'events', String(eventId), 'candidateStatusEvents'));
    const normalizedReason = status === CANDIDATE_STATUSES.WITHDRAWN ? String(reasonCode) : '';
    const statePayload = {
      status,
      reasonCode: normalizedReason,
      reasonLabel: normalizedReason ? dropoutReasonLabel(normalizedReason) : '',
      statusRevision: current.statusRevision + 1,
      lastTransitionId: historyReference.id,
      statusChangedAt: serverTimestamp(),
      statusChangedBy: uid
    };
    transaction.update(stateReference, statePayload);
    transaction.set(historyReference, {
      candidateKey: candidateKey(team, participantId),
      participantId: String(participantId),
      team: padTeam(team),
      fromStatus: current.status,
      toStatus: status,
      reasonCode: normalizedReason,
      reasonLabel: normalizedReason ? dropoutReasonLabel(normalizedReason) : '',
      details: String(details || '').trim().slice(0, 1000),
      source,
      recommendationId: String(recommendationId || ''),
      changedAt: serverTimestamp(),
      changedBy: uid,
      changedByName: String(user?.name || ''),
      schemaVersion: STATUS_EVENT_SCHEMA_VERSION
    });
    return normalizeCandidateRecord({ ...current, ...statePayload });
  }

  async function setCandidateStatus(eventId, team, participantId, status, reasonCode = '', details = '') {
    if (![CANDIDATE_STATUSES.ACTIVE, CANDIDATE_STATUSES.WITHDRAWN].includes(status)) {
      throw new Error('מצב מועמד אינו תקין');
    }
    if (status === CANDIDATE_STATUSES.WITHDRAWN && !isDropoutReason(reasonCode)) {
      throw new Error('יש לבחור סיבת נשירה');
    }
    const stateReference = candidateRef(eventId, team, participantId);
    const recommendationReference = recommendationRef(eventId, team, participantId);
    return runTransaction(db, async transaction => {
      const [snapshot, recommendationSnapshot] = await Promise.all([
        transaction.get(stateReference), transaction.get(recommendationReference)
      ]);
      if (!snapshot.exists()) throw new Error('המועמד אינו רשום באירוע');
      const current = normalizeCandidateRecord(snapshot.data());
      const recommendation = recommendationSnapshot.exists()
        ? normalizeRecommendation(recommendationSnapshot.data()) : null;
      if (status === CANDIDATE_STATUSES.WITHDRAWN &&
          recommendation?.status === RECOMMENDATION_STATUSES.OPEN) {
        throw new Error('יש לטפל בהמלצת הנשירה הפתוחה במקום לשנות את המצב ישירות');
      }
      if (current.status === status && (status !== CANDIDATE_STATUSES.WITHDRAWN || current.reasonCode === reasonCode)) {
        return current;
      }
      return recordCandidateTransition(transaction, {
        eventId, team, participantId, current, status, reasonCode, details, source: 'direct'
      });
    });
  }

  async function updateCandidateProfile(eventId, team, participantId, profile) {
    const normalized = normalizeCandidateProfile(profile, { participantId });
    const issues = candidateRosterIssues([normalized]);
    if (issues.length) throw new Error(issues[0]);
    const reference = candidateRef(eventId, team, participantId);
    const duplicates = await getDocs(query(
      collection(db, 'events', String(eventId), 'candidates'),
      where('nationalId', '==', normalized.nationalId)
    ));
    if (duplicates.docs.some(item => item.id !== reference.id)) {
      throw new Error('תעודת הזהות כבר משויכת למועמד אחר באירוע');
    }
    return runTransaction(db, async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists()) throw new Error('המועמד אינו רשום באירוע');
      const current = normalizeCandidateRecord(snapshot.data());
      const unchanged = ['firstName', 'nationalId', 'emergencyContactPhone', 'doctorClearance', 'medicClearance']
        .every(field => current[field] === normalized[field]);
      if (unchanged) return current;
      const payload = {
        firstName: normalized.firstName,
        nationalId: normalized.nationalId,
        emergencyContactPhone: normalized.emergencyContactPhone,
        doctorClearance: normalized.doctorClearance,
        medicClearance: normalized.medicClearance,
        profileRevision: current.profileRevision + 1,
        profileUpdatedAt: serverTimestamp(),
        profileUpdatedBy: uid
      };
      transaction.update(reference, payload);
      return normalizeCandidateRecord({ ...current, ...payload });
    });
  }

  async function resolveRecommendation(eventId, team, participantId, decision) {
    if (!['accept', 'reject'].includes(decision)) throw new Error('החלטה אינה תקינה');
    const recommendationReference = recommendationRef(eventId, team, participantId);
    const stateReference = candidateRef(eventId, team, participantId);
    return runTransaction(db, async transaction => {
      const [recommendationSnapshot, stateSnapshot] = await Promise.all([
        transaction.get(recommendationReference), transaction.get(stateReference)
      ]);
      if (!recommendationSnapshot.exists()) throw new Error('ההמלצה אינה קיימת');
      const recommendation = normalizeRecommendation(recommendationSnapshot.data());
      if (recommendation.status !== RECOMMENDATION_STATUSES.OPEN) {
        throw new Error('ההמלצה כבר טופלה');
      }
      let candidateState = stateSnapshot.exists()
        ? normalizeCandidateRecord(stateSnapshot.data())
        : normalizeCandidateRecord(null, { team, participantId });
      if (decision === 'accept') {
        if (!stateSnapshot.exists()) throw new Error('המועמד אינו רשום באירוע');
        candidateState = await recordCandidateTransition(transaction, {
          eventId, team, participantId, current: candidateState,
          status: CANDIDATE_STATUSES.WITHDRAWN,
          reasonCode: recommendation.reasonCode,
          details: recommendation.details,
          source: 'recommendation',
          recommendationId: candidateKey(team, participantId)
        });
      }
      transaction.update(recommendationReference, {
        status: decision === 'accept'
          ? RECOMMENDATION_STATUSES.ACCEPTED : RECOMMENDATION_STATUSES.REJECTED,
        revision: recommendation.revision + 1,
        updatedAt: serverTimestamp(),
        resolvedAt: serverTimestamp(),
        resolvedBy: uid
      });
      return { recommendation, candidateState };
    });
  }

  return {
    activeEventPointerRef, eventRef, eventTeamRef, candidateRef, recommendationRef,
    getActiveEvent, getTeam, getCandidate, subscribeCandidate,
    getRecommendation, subscribeRecommendation, recommendDropout, cancelRecommendation,
    setCandidateStatus, updateCandidateProfile, resolveRecommendation
  };
}
