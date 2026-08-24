import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDIDATE_STATUSES, buildFormationDashboardSnapshot, activeParticipantIds,
  candidateKey, candidateRosterIssues, isValidIsraeliNationalId,
  isValidEmergencyContactPhone, normalizeCandidateProfile, normalizeCandidateRecord, normalizeCandidateRoster,
  normalizeEmergencyContactPhone, normalizeNationalId
} from '../frontend/js/formation-operations-model.js';

const teams = [
  { id: '01', teamNumber: '01', participantIds: ['100', '101'], stationMap: { '01': 'sprints' } },
  { id: '02', teamNumber: '02', participantIds: ['200'], stationMap: { '01': 'discussion' } }
];

test('candidate keys keep identical participant numbers isolated by team', () => {
  assert.equal(candidateKey(1, '100'), '01_100');
  assert.equal(candidateKey(2, '100'), '02_100');
});

test('every missing candidate profile field receives a type-safe zero default', () => {
  assert.deepEqual(normalizeCandidateProfile({}), {
    participantId: '0', firstName: '0', nationalId: '0', emergencyContactPhone: '0',
    doctorClearance: 0, medicClearance: 0
  });
});

test('missing candidate state is active and never treated as withdrawn', () => {
  assert.deepEqual(normalizeCandidateRecord(null, { team: '01', participantId: '100' }), {
    participantId: '100', firstName: '0', nationalId: '0', emergencyContactPhone: '0',
    doctorClearance: 0, medicClearance: 0, team: '01', status: 'active',
    reasonCode: '', reasonLabel: '', statusRevision: 0, profileRevision: 0,
    lastTransitionId: '', statusChangedAt: null, statusChangedBy: '',
    profileUpdatedAt: null, profileUpdatedBy: ''
  });
});

test('candidate identity remains string based and validates Israeli national IDs', () => {
  assert.equal(normalizeNationalId('000-000-018'), '000000018');
  assert.equal(isValidIsraeliNationalId('000000018'), true);
  assert.equal(isValidIsraeliNationalId('123456789'), false);
  assert.equal(normalizeEmergencyContactPhone('050-123-4567'), '0501234567');
  assert.equal(isValidEmergencyContactPhone('0501234567'), true);
  assert.equal(isValidEmergencyContactPhone('123'), false);
});

test('legacy team numbers become incomplete profiles that must be completed before an event', () => {
  assert.deepEqual(normalizeCandidateRoster({ participants: ['100', '101'] }), [
    { participantId: '100', firstName: '0', nationalId: '0', emergencyContactPhone: '0', doctorClearance: 0, medicClearance: 0 },
    { participantId: '101', firstName: '0', nationalId: '0', emergencyContactPhone: '0', doctorClearance: 0, medicClearance: 0 }
  ]);
  assert.equal(candidateRosterIssues(normalizeCandidateRoster({ participants: ['100'] })).length, 3);
});

test('candidate roster validation rejects duplicate participant and national IDs', () => {
  const issues = candidateRosterIssues([
    { participantId: '100', firstName: 'נועה', nationalId: '000000018', emergencyContactPhone: '0501234567' },
    { participantId: '100', firstName: 'דנה', nationalId: '000000018', emergencyContactPhone: '0527654321' }
  ]);
  assert.ok(issues.some(issue => issue.includes('מספר המועמד 100')));
  assert.ok(issues.some(issue => issue.includes('תעודת הזהות 000000018')));
});

test('candidate roster validation rejects participant identifiers outside the persisted schema', () => {
  const issues = candidateRosterIssues([{
    participantId: '1'.repeat(101), firstName: 'נועה', nationalId: '000000018', emergencyContactPhone: '0501234567'
  }]);
  assert.ok(issues.some(issue => issue.includes('ארוך מדי')));
});

test('active roster removes withdrawn candidates and keeps active candidates', () => {
  const active = activeParticipantIds(teams[0], [
    { team: '01', participantId: '100', status: CANDIDATE_STATUSES.WITHDRAWN, reasonCode: 'medical' },
    { team: '01', participantId: '101', status: CANDIDATE_STATUSES.ACTIVE }
  ]);
  assert.deepEqual(active, ['101']);
  assert.ok(active.every(participantId => typeof participantId === 'string'));
});

test('dashboard counts candidates, exposes team rosters and keeps identity attached to the candidate', () => {
  const snapshot = buildFormationDashboardSnapshot({
    event: { id: 'event-1', name: 'גיבוש בדיקה' },
    teams,
    candidates: [
      { team: '01', participantId: '100', firstName: 'נועה', nationalId: '000000018', emergencyContactPhone: '0501234567', doctorClearance: 1, medicClearance: 0, status: 'withdrawn', reasonCode: 'medical' },
      { team: '01', participantId: '101', firstName: 'דנה', nationalId: '123456782', status: 'active' },
      { team: '02', participantId: '200', firstName: 'יובל', nationalId: '039284765', status: 'withdrawn', reasonCode: 'voluntary' }
    ]
  });
  assert.deepEqual(snapshot.totals, {
    candidates: 3, active: 1, withdrawn: 2, teamsRunning: 0
  });
  assert.deepEqual(snapshot.reasonCounts, { voluntary: 1, medical: 1, dismissal: 0 });
  assert.equal(snapshot.teams[0].candidates[0].firstName, 'נועה');
  assert.equal(snapshot.teams[0].candidates[0].nationalId, '000000018');
  assert.equal(snapshot.teams[0].candidates[0].emergencyContactPhone, '0501234567');
  assert.equal(snapshot.teams[0].candidates[0].doctorClearance, 1);
});

test('dashboard derives the current station from live and latest races', () => {
  const snapshot = buildFormationDashboardSnapshot({
    teams,
    races: [
      { id: 'old', team: '01', station: '01', round: 1, status: 'stopped', startedAt: 100, endedAt: 200 },
      { id: 'live', team: '01', station: '02', round: 2, status: 'running', startedAt: 300 },
      { id: 'team2', team: '02', station: '03', round: 1, status: 'stopped', startedAt: 400, endedAt: 500 }
    ],
    nowMs: 600,
    isRaceRunning: race => race.status === 'running'
  });
  assert.equal(snapshot.teams[0].station, '02');
  assert.equal(snapshot.teams[0].raceStatus, 'running');
  assert.equal(snapshot.teams[1].station, '03');
  assert.equal(snapshot.teams[1].raceStatus, 'stopped');
});

test('dashboard reports concurrent active races instead of silently choosing one', () => {
  const snapshot = buildFormationDashboardSnapshot({
    teams: [teams[0]],
    races: [
      { id: 'a', team: '01', station: '01', status: 'running', startedAt: 100 },
      { id: 'b', team: '01', station: '02', status: 'running', startedAt: 200 }
    ],
    isRaceRunning: race => race.status === 'running'
  });
  assert.equal(snapshot.teams[0].activeRaceCount, 2);
  assert.equal(snapshot.anomalies.length, 1);
});

test('only open recommendations appear in the action queue', () => {
  const snapshot = buildFormationDashboardSnapshot({
    teams,
    candidates: [{ team: '01', participantId: '100', firstName: 'נועה', nationalId: '000000018' }],
    recommendations: [
      { team: '01', participantId: '100', reasonCode: 'medical', status: 'open', createdAt: 2 },
      { team: '02', participantId: '200', reasonCode: 'dismissal', status: 'rejected', createdAt: 1 }
    ]
  });
  assert.deepEqual(snapshot.openRecommendations.map(item => item.participantId), ['100']);
  assert.equal(snapshot.openRecommendations[0].candidate.firstName, 'נועה');
});
