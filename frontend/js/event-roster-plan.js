import { candidateKey, candidateRosterIssues, normalizeCandidateProfile } from './formation-operations-model.js';
import { normalizeEventTeamId } from './event-setup-model.js';
import { normalizeRosterSource } from './candidate-roster-import.js';

export const ROSTER_WRITE_LIMIT = 450;
export const PROFILE_FIELDS = Object.freeze([
  'firstName', 'nationalId', 'emergencyContactPhone', 'doctorClearance', 'medicClearance'
]);

// Pure planning shared by Excel import and manual team editing. No writes until
// every team and the resulting event roster have been validated.
export function planEventRoster({ status, teams, existing, groups, source = {} }) {
  if (!['draft', 'active'].includes(status)) throw new Error('לא ניתן לערוך מועמדים באירוע במצב הנוכחי.');
  if (!Array.isArray(groups) || !groups.length) throw new Error('לא נמצאו מועמדים לייבוא.');
  const teamById = new Map(teams.map(team => [team.id, team]));
  const next = new Map(existing.map(candidate => [candidate.id, candidate]));
  const seen = new Set();
  const rosterSource = normalizeRosterSource({ sourceId:'event-setup', ...source });
  const plans = groups.map(group => {
    const team = normalizeEventTeamId(group.team);
    const previousTeam = teamById.get(team);
    if (!team || !previousTeam || previousTeam.active === false) throw new Error(`צוות ${group.team} אינו זמין באירוע. יש להגדיר אותו תחילה.`);
    if (seen.has(team)) throw new Error('אותו צוות מופיע יותר מפעם אחת בייבוא.');
    seen.add(team);
    if (!Array.isArray(group.candidates)) throw new Error('רשימת המועמדים אינה תקינה.');
    const candidates = group.candidates.map(normalizeCandidateProfile);
    const issues = candidateRosterIssues(candidates, { requireIdentity:false });
    if (issues.length) throw new Error(`צוות ${Number(team)}: ${issues[0]}`);
    // Missing profiles are allowed, but malformed nonzero values must fail
    // before any chunk reaches Firestore's record validation.
    for (const candidate of candidates) {
      if (candidate.nationalId !== '0' && !/^\d{9}$/.test(candidate.nationalId)) {
        throw new Error(`מועמד ${candidate.participantId}: תעודת זהות חייבת להכיל 9 ספרות או 0 אם חסרה.`);
      }
      if (candidate.emergencyContactPhone !== '0' && !/^\d{9,15}$/.test(candidate.emergencyContactPhone)) {
        throw new Error(`מועמד ${candidate.participantId}: מספר טלפון חירום אינו תקין.`);
      }
    }
    const previous = existing.filter(candidate => candidate.team === team);
    const previousById = new Map(previous.map(candidate => [candidate.id, candidate]));
    const keys = new Set(candidates.map(candidate => candidateKey(team, candidate.participantId)));
    const deletes = status === 'draft' ? previous.filter(candidate => !keys.has(candidate.id)) : [];
    const changes = [];
    for (const candidate of deletes) {
      changes.push({ kind:'delete', id:candidate.id, previous:candidate });
      next.delete(candidate.id);
    }
    for (const candidate of candidates) {
      const id = candidateKey(team, candidate.participantId);
      const old = previousById.get(id);
      if (!old || PROFILE_FIELDS.some(field => old[field] !== candidate[field])) {
        changes.push({ kind:old ? 'update' : 'create', id, candidate, previous:old });
      }
      next.set(id, { ...old, ...candidate, id, team });
    }
    const participantIds = [...new Set([
      ...(status === 'active' ? previous.map(candidate => candidate.participantId) : []),
      ...candidates.map(candidate => candidate.participantId)
    ])].sort((a, b) => Number(a) - Number(b));
    if (participantIds.length > 20) throw new Error(`צוות ${Number(team)}: ניתן לשייך עד 20 מועמדים לצוות.`);
    const teamChanged = JSON.stringify(participantIds) !== JSON.stringify(previousTeam.participantIds || []) ||
      JSON.stringify(rosterSource) !== JSON.stringify(normalizeRosterSource(previousTeam.rosterSource));
    return {
      team, previousTeam, participantIds, rosterSource, teamChanged, changes,
      importedCount:candidates.length,
      delta:changes.filter(change => change.kind === 'create').length - deletes.length,
      writeCount:changes.length + (teamChanged ? 1 : 0)
    };
  });
  const nationalIds = new Map();
  for (const candidate of next.values()) {
    const nationalId = candidate.nationalId;
    if (!nationalId || nationalId === '0') continue;
    if (nationalIds.has(nationalId)) throw new Error('תעודת זהות משויכת ליותר ממועמד אחד באירוע.');
    nationalIds.set(nationalId, candidate.id);
  }
  // A team is never split: its candidate documents and roster commit together.
  const chunks = [];
  let chunk = [], writes = 1; // event count and roster revision
  for (const plan of plans.filter(plan => plan.writeCount > 0)) {
    if (plan.writeCount + 1 > ROSTER_WRITE_LIMIT) throw new Error('הצוות גדול מדי לשמירה אחת.');
    if (writes + plan.writeCount > ROSTER_WRITE_LIMIT) {
      chunks.push(chunk); chunk = []; writes = 1;
    }
    chunk.push(plan); writes += plan.writeCount;
  }
  if (chunk.length) chunks.push(chunk);
  return { plans, chunks, candidateCount:next.size, importedCount:plans.reduce((n, plan) => n + plan.importedCount, 0) };
}
