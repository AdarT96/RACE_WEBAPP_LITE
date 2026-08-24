import {
  collection, deleteField, doc, getDocs, serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-firestore.js';
import {
  TEAM_ROSTER_SCHEMA_VERSION, candidateRosterIssues, isValidIsraeliNationalId,
  normalizeCandidateRoster, padTeam
} from './formation-operations-model.js';
import { normalizeRosterSource } from './candidate-roster-import.js';

export async function applyCandidateRosterImport(db, adminUser, importResult) {
  const uid = String(adminUser?.uid || '');
  if (!uid || adminUser?.role !== 'admin') throw new Error('ייבוא רשימות זמין למנהל בלבד');
  if (importResult?.errors?.length) throw new Error(importResult.errors[0]);
  const teams = Array.isArray(importResult?.teams) ? importResult.teams : [];
  if (!teams.length) throw new Error('לא נמצאו צוותים לייבוא');

  const source = normalizeRosterSource(importResult.source);
  const importedByTeam = new Map(teams.map(team => [padTeam(team.team), team.candidates]));
  const existingSnapshot = await getDocs(collection(db, 'teams'));
  const existingNationalIds = new Map();
  existingSnapshot.forEach(teamDocument => {
    const team = padTeam(teamDocument.id);
    if (importedByTeam.has(team)) return;
    normalizeCandidateRoster(teamDocument.data()).forEach(candidate => {
      if (isValidIsraeliNationalId(candidate.nationalId)) {
        existingNationalIds.set(candidate.nationalId, { team, participantId: candidate.participantId });
      }
    });
  });
  teams.forEach(team => team.candidates.forEach(candidate => {
    const owner = existingNationalIds.get(candidate.nationalId);
    if (owner) {
      throw new Error(`תעודת הזהות ${candidate.nationalId} כבר משויכת למועמד ${owner.participantId} בצוות ${Number(owner.team)}`);
    }
  }));

  const batch = writeBatch(db);
  teams.forEach(team => {
    const issues = candidateRosterIssues(team.candidates);
    if (issues.length) throw new Error(`צוות ${Number(team.team)}: ${issues[0]}`);
    batch.set(doc(db, 'teams', team.team), {
      teamNumber: team.team,
      candidates: team.candidates,
      participants: deleteField(),
      rosterSchemaVersion: TEAM_ROSTER_SCHEMA_VERSION,
      rosterSource: {
        ...source,
        importedAt: serverTimestamp(),
        importedBy: uid
      },
      updatedAt: serverTimestamp(),
      updatedBy: uid
    }, { merge: true });
  });
  await batch.commit();
  return { teamCount: teams.length, source };
}
