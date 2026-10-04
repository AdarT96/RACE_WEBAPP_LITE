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

// הכותרות והערכים כאן הועתקו מקובץ אמיתי שנמסר לייבוא. הבדיקה קיימת כדי
// שניסוח מקובל בשטח לא יישבר בשקט: כותרת שלא מזוהה מפילה עמודה שלמה,
// והייבוא ממשיך כאילו השדה היה ריק.
const REAL_WORLD_HEADERS = [
  'מספר זהות', 'שם משפחה', 'שם פרטי', 'מספר חולצה', 'מספר צוות',
  'כשיר רופא', 'כשיר חובש ', 'איש קשר', 'טלפון איש קשר'
];

test('a real roster file maps onto the canonical fields', () => {
  const { rows, errors } = candidateRowsFromMatrix([
    REAL_WORLD_HEADERS,
    ['435688940', 'אברהם', 'יונתן', 1, 1, 'לא', 'לא', 'דליה חזן', '054-9958810'],
    ['449243328', 'חדד', 'אפרת', 2, 2, 'כן', '', 'הדס פרידמן', '055-8275345']
  ]);

  assert.deepEqual(errors, []);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].nationalId, '435688940');
  assert.equal(rows[0].participantId, 1);
  assert.equal(rows[0].team, 1);
  assert.equal(rows[0].firstName, 'יונתן');
  assert.equal(rows[0].emergencyContactPhone, '0549958810');
  assert.equal(rows[0].doctorClearance, 2);   // לא → לא כשיר
  assert.equal(rows[1].doctorClearance, 1);   // כן → כשיר
  assert.equal(rows[1].medicClearance, 0);    // ריק → טרם נבדק
});

test('a missing team or candidate column is reported instead of silently emptied', () => {
  const withoutTeam = candidateRowsFromMatrix([
    ['מספר זהות', 'שם פרטי', 'מספר חולצה'], ['435688940', 'יונתן', 1]
  ]);
  assert.equal(withoutTeam.errors.length, 1);
  assert.match(withoutTeam.errors[0], /צוות/);

  const withoutParticipant = candidateRowsFromMatrix([
    ['מספר זהות', 'שם פרטי', 'מספר צוות'], ['435688940', 'יונתן', 1]
  ]);
  assert.equal(withoutParticipant.errors.length, 1);
  assert.match(withoutParticipant.errors[0], /מועמד/);
});
