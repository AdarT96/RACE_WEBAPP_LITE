// =====================================================
//  intake-model.js — מודל טהור לקליטת מועמדים (שלישות)
// =====================================================
// ולידציה ונרמול של פרטי מועמד שהוזנו ידנית, רשימת המועמדים המאוחדת
// (משובצים + כלליים), חיפוש, וכלל "יש למועמד נתונים" שחוסם העברה בין
// צוותים. אין כאן Firestore: הכתיבה ב־intake-repository.js.
//
// הנרמול זהה לייבוא ה־Excel: אותן פונקציות של formation-operations-model.js
// ושל candidate-roster-import.js, כדי שלא יהיו שני כללים לאותו שדה.

import {
  CANDIDATE_PROFILE_DEFAULTS, CANDIDATE_STATUSES, CLEARANCE_STATUSES, candidateSearchScore,
  isValidEmergencyContactPhone, isValidIsraeliNationalId, normalizeCandidateProfile,
  normalizeCandidateRecord, normalizeParticipantId, padTeam
} from './formation-operations-model.js';
import { nationalIdFromCell, phoneFromCell } from './candidate-roster-import.js';

export const UNASSIGNED_TEAM = '';
export const UNASSIGNED_RECORD_SCHEMA_VERSION = 1;
export const NUMBER_REGISTRY_SCHEMA_VERSION = 1;
export const MAX_TEAM_CANDIDATES = 20;
// כמה מספרים רצופים טרנזקציה אחת בודקת לפני שהיא מוותרת (מספרים שכבר
// קיימים מייבוא נדלגים). בפועל המספר הראשון פנוי כמעט תמיד.
export const NUMBER_PROBE_LIMIT = 25;
export const INTAKE_EVENT_STATUSES = Object.freeze(['draft', 'active']);

export function normalizeIntakeTeam(value) {
  return padTeam(value) || UNASSIGNED_TEAM;
}

export function intakeTeamLabel(team) {
  const normalized = normalizeIntakeTeam(team);
  return normalized ? `צוות ${Number(normalized)}` : 'כללי (ללא צוות)';
}

export function intakeRowKey(team, participantId) {
  return `${normalizeIntakeTeam(team) || 'general'}:${normalizeParticipantId(participantId)}`;
}

const clearanceValue = value => (value == null || String(value).trim() === '' ? CLEARANCE_STATUSES.PENDING : Number(value));

// מקבל את ערכי הטופס כפי שהוקלדו ומחזיר פרופיל קנוני ורשימת שגיאות בעברית.
// שדה ריק בתעודת זהות או בטלפון נשמר כ־"0" (חסר), כמו בייבוא.
export function prepareIntakeProfile(input = {}) {
  const errors = [];
  const nameText = String(input.fullName ?? '').trim().replace(/\s+/g, ' ');
  if (!nameText || nameText === CANDIDATE_PROFILE_DEFAULTS.fullName) errors.push('יש להזין שם מלא.');
  else if (nameText.length > 80) errors.push('השם ארוך מ־80 תווים.');

  const rawId = String(input.nationalId ?? '').trim();
  const rawPhone = String(input.emergencyContactPhone ?? '').trim();
  if (rawId && !/^[\d\s()+.-]+$/.test(rawId)) errors.push('תעודת הזהות יכולה להכיל ספרות בלבד.');
  if (rawPhone && !/^[\d\s()+.-]+$/.test(rawPhone)) errors.push('טלפון החירום יכול להכיל ספרות בלבד.');

  const doctorClearance = clearanceValue(input.doctorClearance);
  const medicClearance = clearanceValue(input.medicClearance);
  if (!Object.values(CLEARANCE_STATUSES).includes(doctorClearance)) errors.push('כשירות רופא אינה ערך מוכר.');
  if (!Object.values(CLEARANCE_STATUSES).includes(medicClearance)) errors.push('כשירות חובש אינה ערך מוכר.');

  const profile = normalizeCandidateProfile({
    fullName: nameText,
    nationalId: rawId ? nationalIdFromCell(rawId) : CANDIDATE_PROFILE_DEFAULTS.nationalId,
    emergencyContactPhone: rawPhone ? phoneFromCell(rawPhone) : CANDIDATE_PROFILE_DEFAULTS.emergencyContactPhone,
    doctorClearance, medicClearance
  });
  if (profile.nationalId !== CANDIDATE_PROFILE_DEFAULTS.nationalId && !isValidIsraeliNationalId(profile.nationalId)) {
    errors.push('תעודת הזהות אינה תקינה. יש להזין 9 ספרות (כולל ספרת ביקורת), או להשאיר ריק אם חסרה.');
  }
  if (profile.emergencyContactPhone !== CANDIDATE_PROFILE_DEFAULTS.emergencyContactPhone &&
      !isValidEmergencyContactPhone(profile.emergencyContactPhone)) {
    errors.push('טלפון החירום חייב להכיל 9 עד 15 ספרות, או להישאר ריק אם חסר.');
  }
  const { participantId, ...fields } = profile;
  return { profile: fields, errors: [...new Set(errors)] };
}

// הפרופיל שנשמר במסמך: firstName הוא הקרנת תאימות של fullName בלבד.
export function profileFields(value = {}) {
  const profile = normalizeCandidateProfile(value);
  return {
    firstName: profile.fullName,
    fullName: profile.fullName,
    nationalId: profile.nationalId,
    emergencyContactPhone: profile.emergencyContactPhone,
    doctorClearance: profile.doctorClearance,
    medicClearance: profile.medicClearance
  };
}

// רשימה אחת לכל המועמדים באירוע: משובצים לפי מסמכי candidates, וכלליים לפי
// unassignedCandidates. מכילה פרטים אישיים ומספרי גרסה בלבד — אין בה ציונים,
// הערות, סדרי הגעה או המלצות נשירה.
export function buildIntakeRoster({ teams = [], candidates = [], unassigned = [] } = {}) {
  const teamState = new Map((Array.isArray(teams) ? teams : []).map(team => [
    padTeam(team.teamNumber || team.id), team.active !== false
  ]));
  const assigned = (Array.isArray(candidates) ? candidates : []).map(value => {
    const record = normalizeCandidateRecord(value);
    return {
      ...record,
      key: intakeRowKey(record.team, record.participantId),
      teamActive: teamState.get(record.team) !== false
    };
  }).filter(row => row.team && row.participantId && row.participantId !== CANDIDATE_PROFILE_DEFAULTS.participantId);
  const general = (Array.isArray(unassigned) ? unassigned : []).map(value => {
    const profile = normalizeCandidateProfile(value, { participantId: value?.id });
    return {
      ...profile,
      team: UNASSIGNED_TEAM,
      status: CANDIDATE_STATUSES.ACTIVE,
      statusRevision: 0,
      profileRevision: Math.max(0, Math.floor(Number(value?.profileRevision) || 0)),
      key: intakeRowKey(UNASSIGNED_TEAM, profile.participantId),
      teamActive: true
    };
  }).filter(row => row.participantId && row.participantId !== CANDIDATE_PROFILE_DEFAULTS.participantId);
  return [...assigned, ...general].sort(compareRows);
}

function compareRows(left, right) {
  return String(left.participantId).localeCompare(String(right.participantId), 'he', { numeric: true }) ||
    String(left.team).localeCompare(String(right.team));
}

// filter: 'all' | 'unassigned' | מספר צוות. החיפוש משתמש באותו דירוג של
// החיפוש בדשבורד מפקד הגיבוש (מספר, שם, תעודת זהות).
export function filterIntakeRoster(rows, { query = '', team = 'all' } = {}) {
  const scoped = (Array.isArray(rows) ? rows : []).filter(row => {
    if (team === 'all' || team == null || team === '') return true;
    if (team === 'unassigned') return row.team === UNASSIGNED_TEAM;
    return row.team === padTeam(team);
  });
  const text = String(query || '').trim().toLocaleLowerCase('he');
  if (!text) return scoped;
  const digits = text.replace(/\D+/g, '');
  return scoped.map(row => ({ row, score: candidateSearchScore(row, text, digits) }))
    .filter(result => Number.isFinite(result.score))
    .sort((left, right) => left.score - right.score || compareRows(left.row, right.row))
    .map(result => result.row);
}

// מועמד אחר באירוע עם אותה תעודת זהות (משובץ או כללי), או null.
export function nationalIdOwner(rows, nationalId, exceptKey = '') {
  const value = String(nationalId || '');
  if (!value || value === CANDIDATE_PROFILE_DEFAULTS.nationalId) return null;
  return (Array.isArray(rows) ? rows : [])
    .find(row => row.key !== exceptKey && row.nationalId === value) || null;
}

export function maxParticipantNumber(...lists) {
  return lists.flat().reduce((max, value) => {
    const id = normalizeParticipantId(value?.participantId ?? value?.id ?? value);
    return /^\d+$/.test(id) ? Math.max(max, Number(id)) : max;
  }, 0);
}

export function firstNumberToTry(counterLastNumber, knownMax) {
  const counter = Math.max(0, Math.floor(Number(counterLastNumber) || 0));
  const known = Math.max(0, Math.floor(Number(knownMax) || 0));
  return Math.max(counter, known) + 1;
}

export function rosterWith(values, participantId) {
  const id = normalizeParticipantId(participantId);
  return [...new Set([...(Array.isArray(values) ? values : []).map(normalizeParticipantId).filter(Boolean), id])]
    .sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
}

export function rosterWithout(values, participantId) {
  const id = normalizeParticipantId(participantId);
  return (Array.isArray(values) ? values : []).map(normalizeParticipantId).filter(value => value && value !== id);
}

// "יש למועמד נתונים": השתתף בסבב של הצוות הנוכחי שלו, מצבו שונה (נשירה/החזרה,
// statusRevision > 0), או שקיימת עליו המלצת נשירה. מועמד כללי אינו משתתף
// בסבבים ולכן אין לו נתונים. מחזיר רשימת סיבות בעברית; ריקה = מותר להעביר.
export function candidateDataReasons({ candidate, races = [], hasRecommendation = false } = {}) {
  const team = normalizeIntakeTeam(candidate?.team);
  if (!candidate || !team) return [];
  const participantId = normalizeParticipantId(candidate.participantId);
  const reasons = [];
  const rounds = (Array.isArray(races) ? races : []).filter(race =>
    padTeam(race?.team) === team &&
    (Array.isArray(race?.participantIds) ? race.participantIds : []).map(normalizeParticipantId).includes(participantId));
  if (rounds.length) reasons.push(rounds.length === 1 ? 'השתתף בסבב בצוות' : `השתתף ב־${rounds.length} סבבים בצוות`);
  const record = normalizeCandidateRecord(candidate);
  if (record.statusRevision > 0 || record.status !== CANDIDATE_STATUSES.ACTIVE) reasons.push('מצב המועמד שונה (נשירה או החזרה)');
  if (hasRecommendation) reasons.push('קיימת עליו המלצת נשירה');
  return reasons;
}

export function moveBlockedMessage(reasons = []) {
  const list = (Array.isArray(reasons) ? reasons : []).filter(Boolean);
  return `לא ניתן להעביר את המועמד כי כבר יש לו נתונים${list.length ? ` (${list.join('; ')})` : ''}. ` +
    'העברה של מועמד עם נתונים תתאפשר למנהל בגרסה הבאה.';
}

// הודעת שגיאה ברורה לשגיאות Firestore נפוצות. כתיבה שנכשלה לא נשמרה.
export function intakeErrorMessage(error) {
  const code = String(error?.code || '');
  if (code === 'permission-denied' || code === 'firestore/permission-denied') {
    return 'השרת סירב לשמירה: אין הרשאה, האירוע אינו פתוח לקליטה, או שלמועמד כבר יש נתונים (למשל המלצת נשירה). רענן ונסה שוב.';
  }
  if (['unavailable', 'deadline-exceeded', 'failed-precondition'].includes(code.replace('firestore/', ''))) {
    return 'אין חיבור יציב לשרת. השמירה לא בוצעה — נסה שוב כשיש קליטה.';
  }
  if (code === 'aborted') return 'שינוי מקביל במכשיר אחר. נסה שוב.';
  return error?.message || 'הפעולה נכשלה.';
}
