import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANDIDATE_IMPORT_FIELDS, buildCandidateRosterImport, candidateRowsFromMatrix
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

test('actual source headers map every field and concatenate first and last name', () => {
  const result = candidateRowsFromMatrix([
    ['מספר זהות','שם משפחה','שם פרטי','מספר מועמד','מספר צוות','כשיר רופא','כשיר חובש ','איש קשר','טלפון איש קשר'],
    ['000000018','ישראלי','ישראל',100,1,'כן','לא','איש קשר','0501234567']
  ]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.rows[0].fullName, 'ישראל ישראלי');
  assert.equal(result.rows[0].nationalId, '000000018');
  assert.equal(result.rows[0].doctorClearance, 1);
  assert.equal(result.rows[0].medicClearance, 2);
  assert.equal(result.rows[0].emergencyContactPhone, '0501234567');
});

test('ambiguous headers and invalid values are rejected before writes', () => {
  const result = candidateRowsFromMatrix([
    ['צוות','מספר מועמד','תז','מספר זהות','כשיר רופא','טלפון איש קשר'],
    [1,100,'123456789','000000018','אולי','abc']
  ]);
  assert.ok(result.errors.some(s => s.includes('יותר מעמודה')));
  assert.ok(result.errors.some(s => s.includes('שורה 2')));
  assert.ok(result.errors.some(s => s.includes('כשירות רופא')));
});

test('blank cells are omitted, explicit zero remains an intentional value, full name wins', () => {
  const result = candidateRowsFromMatrix([
    ['צוות','מספר מועמד','שם מלא','שם פרטי','שם משפחה','מספר זהות','טלפון איש קשר'],
    [1,100,'שם מלא','לא','לחבר',0,'']
  ]);
  assert.equal(result.rows[0].fullName, 'שם מלא');
  assert.equal(result.rows[0].nationalId, '0');
  assert.ok(result.rows[0].providedFields.includes('nationalId'));
  assert.ok(!result.rows[0].providedFields.includes('emergencyContactPhone'));
  assert.ok(result.warnings.length);
});

test('the import contract stays source-neutral and groups canonical candidates by team', () => {
  const result = buildCandidateRosterImport({
    rows: validRows,
    source: { type: 'excel', sourceId: 'workbook-2026-08', fileName: 'מועמדים.xlsx' }
  });
  assert.deepEqual(CANDIDATE_IMPORT_FIELDS, [
    'team', 'participantId', 'firstName', 'fullName', 'nationalId', 'emergencyContactPhone',
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

test('Excel matrix adapter supports warning-only missing profile fields', () => {
  const adapted = candidateRowsFromMatrix([
    ['צוות', 'מספר מועמד', 'שם פרטי'],
    [1, 100, 'נועה'],
    [1, 101, '']
  ]);
  assert.deepEqual(adapted.errors, []);
  const result = buildCandidateRosterImport({ rows:adapted.rows, allowIncompleteProfiles:true });
  assert.deepEqual(result.errors, []);
  assert.equal(result.teams[0].candidates[1].firstName, '0');
});

test('Excel adapter preserves leading-zero identity and maps Hebrew clearance labels', () => {
  const adapted = candidateRowsFromMatrix([
    ['צוות', 'מספר מועמד', 'תעודת זהות', 'טלפון איש קשר חירום', 'כשירות רופא', 'כשירות חובש'],
    [1, 100, 18, 501234567, 'כשיר', 'לא כשיר']
  ]);
  assert.equal(adapted.rows[0].nationalId, '000000018');
  assert.equal(adapted.rows[0].emergencyContactPhone, '0501234567');
  assert.equal(adapted.rows[0].doctorClearance, 1);
  assert.equal(adapted.rows[0].medicClearance, 2);
});
