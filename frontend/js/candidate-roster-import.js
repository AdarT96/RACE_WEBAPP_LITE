import {
  CLEARANCE_STATUSES, candidateRosterIssues, normalizeCandidateProfile, isValidIsraeliNationalId
} from './formation-operations-model.js';
import { padScheduleTeam } from './schedule-model.js';

export const ROSTER_SOURCE_TYPES = Object.freeze({
  MANUAL: 'manual',
  EXCEL: 'excel'
});

export const CANDIDATE_IMPORT_FIELDS = Object.freeze([
  'team', 'participantId', 'firstName', 'fullName', 'nationalId', 'emergencyContactPhone',
  'doctorClearance', 'medicClearance'
]);

export function normalizeRosterSource(value = {}) {
  const type = Object.values(ROSTER_SOURCE_TYPES).includes(value.type)
    ? value.type : ROSTER_SOURCE_TYPES.MANUAL;
  return {
    type,
    sourceId: String(value.sourceId || '').trim().slice(0, 200),
    fileName: String(value.fileName || '').trim().slice(0, 240)
  };
}

// This is the stable boundary for every future file/API adapter. An Excel parser
// only needs to turn workbook rows into these canonical fields; persistence and
// business validation remain independent of the source format.
export function buildCandidateRosterImport({ rows = [], source = {}, allowIncompleteProfiles = false } = {}) {
  const grouped = new Map();
  const errors = [];
  const nationalIdOwners = new Map();

  (Array.isArray(rows) ? rows : []).forEach((rawRow, index) => {
    const rowNumber = Number.isInteger(rawRow?.sourceRowNumber) ? rawRow.sourceRowNumber : index + 2;
    const team = padScheduleTeam(rawRow?.team);
    if (!team) {
      errors.push(`שורה ${rowNumber}: מספר צוות חסר או לא תקין`);
      return;
    }
    for (const [field, label] of [['doctorClearance', 'כשירות רופא'], ['medicClearance', 'כשירות חובש']]) {
      const rawValue = rawRow?.[field];
      const value = rawValue == null || String(rawValue).trim() === ''
        ? CLEARANCE_STATUSES.PENDING : Number(rawValue);
      if (!Object.values(CLEARANCE_STATUSES).includes(value)) {
        errors.push(`שורה ${rowNumber}: ${label} אינה במצב מוכר`);
        return;
      }
    }
    const candidate = normalizeCandidateProfile(rawRow);
    if (Array.isArray(rawRow.providedFields)) candidate.providedFields = [...rawRow.providedFields];
    const issues = candidateRosterIssues([candidate], { requireIdentity:!allowIncompleteProfiles });
    issues.forEach(issue => errors.push(`שורה ${rowNumber}: ${issue}`));
    if (issues.length) return;

    const hasUsableNationalId = candidate.nationalId !== '0' && candidate.nationalId.length > 0;
    const existingNationalId = hasUsableNationalId ? nationalIdOwners.get(candidate.nationalId) : null;
    if (existingNationalId) {
      errors.push(`שורה ${rowNumber}: תעודת הזהות ${candidate.nationalId} כבר הופיעה בשורה ${existingNationalId}`);
      return;
    }
    if (hasUsableNationalId) nationalIdOwners.set(candidate.nationalId, rowNumber);
    if (!grouped.has(team)) grouped.set(team, []);
    grouped.get(team).push(candidate);
  });

  for (const [team, candidates] of grouped) {
    candidateRosterIssues(candidates, { requireIdentity:!allowIncompleteProfiles })
      .forEach(issue => errors.push(`צוות ${Number(team)}: ${issue}`));
  }

  return {
    source: normalizeRosterSource(source),
    teams: [...grouped.entries()]
      .map(([team, candidates]) => ({ team, candidates }))
      .sort((a, b) => Number(a.team) - Number(b.team)),
    errors: [...new Set(errors)]
  };
}

const cleanHeader = value => String(value ?? '').trim().toLowerCase().replace(/["״׳']/g, '').replace(/\s+/g, ' ');
const IMPORT_HEADER_ALIASES = Object.freeze({
  team:['צוות', 'מספר צוות', 'team'],
  participantId:['מספר מועמד', 'מועמד', 'participant id', 'candidate number'],
  fullName:['שם מלא', 'שם', 'full name'],
  firstName:['שם פרטי', 'first name'],
  lastName:['שם משפחה', 'last name', 'surname'],
  nationalId:['תעודת זהות', 'מספר זהות', 'מספר תעודת זהות', 'תז', 'national id'],
  emergencyContactPhone:['טלפון איש קשר חירום', 'טלפון איש קשר', 'איש קשר חירום', 'emergency phone'],
  doctorClearance:['כשירות רופא', 'כשיר רופא', 'רופא', 'doctor clearance'],
  medicClearance:['כשירות חובש', 'כשיר חובש', 'חובש', 'medic clearance']
});

export const IMPORT_FIELD_LABELS = Object.freeze({
  team:'צוות', participantId:'מספר מועמד', fullName:'שם מלא', firstName:'שם פרטי', lastName:'שם משפחה',
  nationalId:'תעודת זהות', emergencyContactPhone:'טלפון חירום', doctorClearance:'כשירות רופא', medicClearance:'כשירות חובש'
});

function clearanceFromCell(value) {
  const text = cleanHeader(value);
  if (!text || ['0', 'טרם נבדק', 'ממתין', 'pending'].includes(text)) return CLEARANCE_STATUSES.PENDING;
  if (['1', 'כשיר', 'fit', 'כן'].includes(text)) return CLEARANCE_STATUSES.FIT;
  if (['2', 'לא כשיר', 'unfit', 'לא'].includes(text)) return CLEARANCE_STATUSES.UNFIT;
  return value;
}

function nationalIdFromCell(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  if (!digits || /^0+$/.test(digits)) return '0';
  return digits && digits.length <= 9 ? digits.padStart(9, '0') : digits || '0';
}

function phoneFromCell(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
  if (!digits || /^0+$/.test(digits)) return '0';
  return typeof value === 'number' && digits.length === 9 ? `0${digits}` : digits || '0';
}

export function candidateRowsFromMatrix(matrix = []) {
  const rows = Array.isArray(matrix) ? matrix.filter(Array.isArray) : [];
  const headers = rows[0] || [];
  const columns = Object.fromEntries(Object.entries(IMPORT_HEADER_ALIASES).map(([field, aliases]) => [
    field, headers.findIndex(header => aliases.map(cleanHeader).includes(cleanHeader(header)))
  ]));
  const errors = [];
  if (columns.team < 0) errors.push('חסרה עמודת "צוות".');
  if (columns.participantId < 0) errors.push('חסרה עמודת "מספר מועמד".');
  const warnings = [];
  for (const [field, aliases] of Object.entries(IMPORT_HEADER_ALIASES)) {
    if (headers.filter(header => aliases.map(cleanHeader).includes(cleanHeader(header))).length > 1) {
      errors.push(`יש יותר מעמודה אחת עבור ${IMPORT_FIELD_LABELS[field]}. יש להשאיר עמודה אחת.`);
    }
  }
  const mapping = Object.fromEntries(Object.entries(columns).map(([field, index]) => [field, index < 0 ? null : String(headers[index])]));
  const candidates = rows.slice(1).map((row, index) => ({row, rowNumber:index + 2}))
    .filter(({row}) => row.some(value => String(value ?? '').trim())).map(({row, rowNumber}) => {
    const has = field => columns[field] >= 0 && String(row[columns[field]] ?? '').trim() !== '';
    const fullName = has('fullName') ? String(row[columns.fullName]).trim() :
      ['firstName', 'lastName'].filter(has).map(field => String(row[columns[field]]).trim()).join(' ');
    const providedFields = ['nationalId', 'emergencyContactPhone', 'doctorClearance', 'medicClearance'].filter(has);
    if (fullName) providedFields.push('firstName', 'fullName');
    if (fullName.length > 80) errors.push(`שורה ${rowNumber}: השם ארוך מ־80 תווים.`);
    for (const field of ['nationalId', 'emergencyContactPhone']) {
      if (has(field) && !/^[\d\s()+.-]+$/.test(String(row[columns[field]]))) errors.push(`שורה ${rowNumber}: ${IMPORT_FIELD_LABELS[field]} מכיל תווים לא תקינים.`);
    }
    const candidate = {
    team:columns.team >= 0 ? row[columns.team] : '',
    participantId:columns.participantId >= 0 ? row[columns.participantId] : '',
    firstName:fullName || '0', fullName:fullName || '0', providedFields, sourceRowNumber:rowNumber,
    nationalId:columns.nationalId >= 0 ? nationalIdFromCell(row[columns.nationalId]) : '0',
    emergencyContactPhone:columns.emergencyContactPhone >= 0 ? phoneFromCell(row[columns.emergencyContactPhone]) : '0',
    doctorClearance:columns.doctorClearance >= 0 ? clearanceFromCell(row[columns.doctorClearance]) : 0,
    medicClearance:columns.medicClearance >= 0 ? clearanceFromCell(row[columns.medicClearance]) : 0
    };
    if (has('nationalId') && candidate.nationalId !== '0' && !isValidIsraeliNationalId(candidate.nationalId)) errors.push(`שורה ${rowNumber}: תעודת הזהות אינה תקינה.`);
    if (has('emergencyContactPhone') && candidate.emergencyContactPhone !== '0' && !/^\d{9,15}$/.test(candidate.emergencyContactPhone)) errors.push(`שורה ${rowNumber}: טלפון החירום אינו תקין.`);
    for (const field of ['doctorClearance', 'medicClearance']) {
      if (has(field) && !Object.values(CLEARANCE_STATUSES).includes(candidate[field])) errors.push(`שורה ${rowNumber}: ${IMPORT_FIELD_LABELS[field]} אינו ערך מוכר.`);
    }
    return candidate;
  });
  for (const field of ['fullName', 'nationalId', 'emergencyContactPhone', 'doctorClearance', 'medicClearance']) {
    const missing = candidates.filter(candidate => !candidate.providedFields.includes(field)).length;
    if (missing) warnings.push(`${IMPORT_FIELD_LABELS[field]} לא סופק ב־${missing} שורות. מידע קיים יישמר; מועמד חדש יקבל ערך חסר.`);
  }
  if (!candidates.length) errors.push('לא נמצאו מועמדים בקובץ.');
  return { rows:candidates, errors, warnings, mapping };
}
