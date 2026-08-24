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
export function buildCandidateRosterImport({ rows = [], source = {} } = {}) {
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
    const issues = candidateRosterIssues([candidate]);
    issues.forEach(issue => errors.push(`שורה ${rowNumber}: ${issue}`));
    if (issues.length) return;

    const existingNationalId = nationalIdOwners.get(candidate.nationalId);
    if (existingNationalId) {
      errors.push(`שורה ${rowNumber}: תעודת הזהות ${candidate.nationalId} כבר הופיעה בשורה ${existingNationalId}`);
      return;
    }
    nationalIdOwners.set(candidate.nationalId, rowNumber);
    if (!grouped.has(team)) grouped.set(team, []);
    grouped.get(team).push(candidate);
  });

  for (const [team, candidates] of grouped) {
    candidateRosterIssues(candidates).forEach(issue => errors.push(`צוות ${Number(team)}: ${issue}`));
  }

  return {
    source: normalizeRosterSource(source),
    teams: [...grouped.entries()]
      .map(([team, candidates]) => ({ team, candidates }))
      .sort((a, b) => Number(a.team) - Number(b.team)),
    errors: [...new Set(errors)]
  };
}
