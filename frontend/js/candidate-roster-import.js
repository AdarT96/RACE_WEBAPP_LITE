import {
  CLEARANCE_STATUSES, candidateRosterIssues, normalizeCandidateProfile, padTeam
} from './formation-operations-model.js';

export const ROSTER_SOURCE_TYPES = Object.freeze({
  MANUAL: 'manual',
  EXCEL: 'excel'
});

export const CANDIDATE_IMPORT_FIELDS = Object.freeze([
  'team', 'participantId', 'firstName', 'nationalId', 'emergencyContactPhone',
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
    const rowNumber = index + 2; // row 1 is normally the workbook header
    const team = padTeam(rawRow?.team);
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
  firstName:['שם פרטי', 'שם', 'first name'],
  nationalId:['תעודת זהות', 'תז', 'national id'],
  emergencyContactPhone:['טלפון איש קשר חירום', 'איש קשר חירום', 'emergency phone'],
  doctorClearance:['כשירות רופא', 'רופא', 'doctor clearance'],
  medicClearance:['כשירות חובש', 'חובש', 'medic clearance']
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
  return digits && digits.length <= 9 ? digits.padStart(9, '0') : digits || '0';
}

function phoneFromCell(value) {
  const digits = String(value ?? '').replace(/\D+/g, '');
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
  const candidates = rows.slice(1).filter(row => row.some(value => String(value ?? '').trim())).map(row => ({
    team:columns.team >= 0 ? row[columns.team] : '',
    participantId:columns.participantId >= 0 ? row[columns.participantId] : '',
    firstName:columns.firstName >= 0 ? row[columns.firstName] : '0',
    nationalId:columns.nationalId >= 0 ? nationalIdFromCell(row[columns.nationalId]) : '0',
    emergencyContactPhone:columns.emergencyContactPhone >= 0 ? phoneFromCell(row[columns.emergencyContactPhone]) : '0',
    doctorClearance:columns.doctorClearance >= 0 ? clearanceFromCell(row[columns.doctorClearance]) : 0,
    medicClearance:columns.medicClearance >= 0 ? clearanceFromCell(row[columns.medicClearance]) : 0
  }));
  return { rows:candidates, errors };
}
