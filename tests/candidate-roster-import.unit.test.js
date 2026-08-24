import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDIDATE_IMPORT_FIELDS, buildCandidateRosterImport
} from '../frontend/js/candidate-roster-import.js';

const validRows = [
  {
    team: 1, participantId: 100, firstName: 'נועה', nationalId: '000-000-018',
    emergencyContactPhone: '050-123-4567', doctorClearance: 1, medicClearance: 0
  },
  {
    team: '02', participantId: '200', firstName: 'יובל', nationalId: '123456782',
    emergencyContactPhone: '0527654321', doctorClearance: 2, medicClearance: 1
  }
];

test('the import contract stays source-neutral and groups canonical candidates by team', () => {
  const result = buildCandidateRosterImport({
    rows: validRows,
    source: { type: 'excel', sourceId: 'workbook-2026-08', fileName: 'מועמדים.xlsx' }
  });
  assert.deepEqual(CANDIDATE_IMPORT_FIELDS, [
    'team', 'participantId', 'firstName', 'nationalId', 'emergencyContactPhone',
    'doctorClearance', 'medicClearance'
  ]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.source.type, 'excel');
  assert.equal(result.teams[0].team, '01');
  assert.equal(result.teams[0].candidates[0].emergencyContactPhone, '0501234567');
  assert.equal(result.teams[1].candidates[0].doctorClearance, 2);
});

test('the import contract rejects malformed rows and global duplicate national IDs', () => {
  const result = buildCandidateRosterImport({ rows: [
    validRows[0],
    { ...validRows[1], nationalId: '000000018' },
    { ...validRows[1], team: '' }
  ] });
  assert.ok(result.errors.some(error => error.includes('כבר הופיעה')));
  assert.ok(result.errors.some(error => error.includes('מספר צוות')));
});
