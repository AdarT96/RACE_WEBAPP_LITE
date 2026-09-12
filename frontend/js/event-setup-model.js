import {
  CANDIDATE_PROFILE_DEFAULTS, CLEARANCE_STATUSES, isValidEmergencyContactPhone,
  isValidIsraeliNationalId, normalizeCandidateProfile, padTeam
} from './formation-operations-model.js';
import { ROLES } from './roles.js';

export const EVENT_SETUP_SCHEMA_VERSION = 1;

export const EVENT_STATUSES = Object.freeze({
  DRAFT: 'draft',
  ACTIVE: 'active',
  CLOSED: 'closed'
});

export const ARTIFACT_STATUSES = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  FAILED: 'failed'
});

const boundedText = (value, maximum) => String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, maximum);
export function normalizeEventTeamId(value) {
  const team = padTeam(value);
  return team && Number(team) <= 15 ? team : '';
}
const uniqueTeams = values => [...new Set((Array.isArray(values) ? values : [])
  .map(value => normalizeEventTeamId(value?.teamNumber ?? value?.team ?? value?.id ?? value)).filter(Boolean))]
  .sort((left, right) => Number(left) - Number(right));

export function normalizeEventDraft(value = {}) {
  const status = Object.values(EVENT_STATUSES).includes(value.status)
    ? value.status : EVENT_STATUSES.DRAFT;
  return {
    id: boundedText(value.id, 120),
    name: boundedText(value.name, 120),
    status,
    teamCount: Math.max(0, Math.floor(Number(value.teamCount) || 0)),
    candidateCount: Math.max(0, Math.floor(Number(value.candidateCount) || 0)),
    setupSchemaVersion: EVENT_SETUP_SCHEMA_VERSION
  };
}

export function normalizeEventStaff(value = {}) {
  const role = [ROLES.OPERATOR, ROLES.EVALUATOR, ROLES.FORMATION_COMMANDER].includes(value.role)
    ? value.role : '';
  return {
    uid: boundedText(value.uid ?? value.id, 128),
    displayName: boundedText(value.displayName ?? value.name, 100),
    role,
    team: role === ROLES.OPERATOR || role === ROLES.EVALUATOR ? normalizeEventTeamId(value.team) : '',
    active: value.active !== false
  };
}

export function eventTeamIds({ schedule = null, teams = [] } = {}) {
  const scheduleTeams = uniqueTeams(schedule?.teamIds || []);
  return scheduleTeams.length ? scheduleTeams : uniqueTeams(teams);
}

export function eventSetupReadiness({
  event = {}, schedule = null, teams = [], candidates = [], staff = [], artifacts = [],
  scheduleErrors = []
} = {}) {
  const normalizedEvent = normalizeEventDraft(event);
  const teamIds = eventTeamIds({ schedule, teams });
  const blockers = [];
  const warnings = [];

  if (!normalizedEvent.name) blockers.push('יש להזין שם לאירוע.');
  if (!teamIds.length) blockers.push('יש להגדיר לפחות צוות אחד בלו״ז.');
  if (!Array.isArray(schedule?.rows) || !schedule.rows.length) blockers.push('יש להגדיר לפחות שורה אחת בלו״ז.');
  (Array.isArray(scheduleErrors) ? scheduleErrors : []).forEach(error => blockers.push(String(error)));

  const teamSet = new Set(teamIds);
  const participantOwners = new Map();
  const nationalIdOwners = new Map();
  const candidateCounts = Object.fromEntries(teamIds.map(team => [team, 0]));

  (Array.isArray(candidates) ? candidates : []).forEach((source, index) => {
    const team = normalizeEventTeamId(source?.team);
    const candidate = normalizeCandidateProfile(source);
    const label = candidate.participantId !== CANDIDATE_PROFILE_DEFAULTS.participantId
      ? `מועמד ${candidate.participantId}` : `מועמד בשורה ${index + 1}`;
    if (!team || !teamSet.has(team)) {
      blockers.push(`${label} משויך לצוות שאינו קיים בלו״ז.`);
      return;
    }
    if (!candidate.participantId || candidate.participantId === CANDIDATE_PROFILE_DEFAULTS.participantId ||
        !/^\d+$/.test(candidate.participantId)) {
      blockers.push(`בצוות ${Number(team)} קיים מועמד ללא מספר מועמד תקין.`);
      return;
    }
    candidateCounts[team] += 1;
    const participantKey = `${team}/${candidate.participantId}`;
    if (participantOwners.has(participantKey)) {
      blockers.push(`מספר המועמד ${candidate.participantId} מופיע יותר מפעם אחת בצוות ${Number(team)}.`);
    } else participantOwners.set(participantKey, true);

    if (!candidate.firstName || candidate.firstName === CANDIDATE_PROFILE_DEFAULTS.firstName) {
      warnings.push(`${label}: חסר שם פרטי.`);
    }
    if (candidate.nationalId === CANDIDATE_PROFILE_DEFAULTS.nationalId) {
      warnings.push(`${label}: חסרה תעודת זהות.`);
    } else if (!isValidIsraeliNationalId(candidate.nationalId)) {
      warnings.push(`${label}: תעודת הזהות אינה תקינה.`);
    } else if (nationalIdOwners.has(candidate.nationalId)) {
      blockers.push(`תעודת הזהות ${candidate.nationalId} משויכת ליותר ממועמד אחד.`);
    } else nationalIdOwners.set(candidate.nationalId, participantKey);
    if (candidate.emergencyContactPhone === CANDIDATE_PROFILE_DEFAULTS.emergencyContactPhone) {
      warnings.push(`${label}: חסר טלפון איש קשר לחירום.`);
    } else if (!isValidEmergencyContactPhone(candidate.emergencyContactPhone)) {
      warnings.push(`${label}: טלפון איש הקשר לחירום אינו תקין.`);
    }
    if (candidate.doctorClearance === CLEARANCE_STATUSES.PENDING) warnings.push(`${label}: כשירות רופא טרם עודכנה.`);
    if (candidate.medicClearance === CLEARANCE_STATUSES.PENDING) warnings.push(`${label}: כשירות חובש טרם עודכנה.`);
  });

  teamIds.forEach(team => {
    if (!candidateCounts[team]) warnings.push(`לצוות ${Number(team)} עדיין לא הוגדרו מועמדים.`);
  });

  const activeStaff = (Array.isArray(staff) ? staff : []).map(normalizeEventStaff)
    .filter(member => member.active && member.uid);
  teamIds.forEach(team => {
    const operators = activeStaff.filter(member => member.team === team && member.role === ROLES.OPERATOR).length;
    const evaluators = activeStaff.filter(member => member.team === team && member.role === ROLES.EVALUATOR).length;
    if (operators < 1) warnings.push(`לצוות ${Number(team)} לא שובץ מפק״צ.`);
    if (evaluators < 2) warnings.push(`לצוות ${Number(team)} שובצו ${evaluators} מעריכים; ההמלצה היא לפחות 2.`);
  });

  const readyArtifactKeys = new Set((Array.isArray(artifacts) ? artifacts : [])
    .filter(item => item?.status === ARTIFACT_STATUSES.READY).map(item => String(item.id || item.key || '')));
  teamIds.forEach(team => {
    if (!readyArtifactKeys.has(`team-${team}`)) warnings.push(`קובץ Drive לצוות ${Number(team)} עדיין לא מוכן.`);
  });
  activeStaff.filter(member => member.role === ROLES.EVALUATOR).forEach(member => {
    if (!readyArtifactKeys.has(`evaluator-${member.uid}`)) {
      warnings.push(`קובץ Drive למעריך ${member.displayName || member.uid} עדיין לא מוכן.`);
    }
  });

  return {
    canActivate: blockers.length === 0,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
    counts: {
      teams: teamIds.length,
      candidates: Object.values(candidateCounts).reduce((total, count) => total + count, 0),
      staff: activeStaff.length
    },
    teamIds
  };
}
