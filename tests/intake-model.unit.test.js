import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIntakeRoster, candidateDataReasons, filterIntakeRoster, firstNumberToTry, intakeErrorMessage,
  intakeTeamLabel, maxParticipantNumber, moveBlockedMessage, nationalIdOwner, prepareIntakeProfile,
  rosterWith, rosterWithout
} from '../frontend/js/intake-model.js';

test('manual intake normalizes fields exactly like the Excel import', () => {
  const { profile, errors } = prepareIntakeProfile({
    fullName: '  דנה   כהן ', nationalId: '26', emergencyContactPhone: '052-123-4567',
    doctorClearance: '1', medicClearance: ''
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(profile, {
    firstName: 'דנה כהן', fullName: 'דנה כהן', nationalId: '000000026',
    emergencyContactPhone: '0521234567', doctorClearance: 1, medicClearance: 0
  });
  const missing = prepareIntakeProfile({ fullName: 'רון', nationalId: '', emergencyContactPhone: '' });
  assert.deepEqual(missing.errors, []);
  assert.equal(missing.profile.nationalId, '0');
  assert.equal(missing.profile.emergencyContactPhone, '0');
});

test('manual intake refuses missing names, invalid ids, phones and clearances', () => {
  assert.match(prepareIntakeProfile({ fullName: ' ' }).errors.join(), /שם מלא/);
  assert.match(prepareIntakeProfile({ fullName: '0' }).errors.join(), /שם מלא/);
  assert.match(prepareIntakeProfile({ fullName: 'א'.repeat(81) }).errors.join(), /80/);
  assert.match(prepareIntakeProfile({ fullName: 'א', nationalId: '123456789' }).errors.join(), /תעודת הזהות/);
  assert.match(prepareIntakeProfile({ fullName: 'א', nationalId: '12a' }).errors.join(), /ספרות בלבד/);
  assert.match(prepareIntakeProfile({ fullName: 'א', emergencyContactPhone: '1234' }).errors.join(), /9 עד 15/);
  assert.match(prepareIntakeProfile({ fullName: 'א', doctorClearance: 5 }).errors.join(), /רופא/);
  assert.match(prepareIntakeProfile({ fullName: 'א', medicClearance: 'x' }).errors.join(), /חובש/);
});

test('the intake roster joins team candidates and general candidates without evaluation data', () => {
  const rows = buildIntakeRoster({
    teams: [{ id: '01' }, { id: '02', active: false }],
    candidates: [
      { id: '01_12', participantId: '12', team: '01', fullName: 'בת', nationalId: '039284906', status: 'active', statusRevision: 0, profileRevision: 2 },
      { id: '02_3', participantId: '3', team: '02', firstName: 'ישן', status: 'withdrawn', reasonCode: 'medical', statusRevision: 1 }
    ],
    unassigned: [{ id: '100', participantId: '100', fullName: 'כללי', profileRevision: 1 }]
  });
  assert.deepEqual(rows.map(row => [row.participantId, row.team, row.key]), [
    ['3', '02', '02:3'], ['12', '01', '01:12'], ['100', '', 'general:100']
  ]);
  assert.equal(rows[0].teamActive, false);
  assert.equal(rows[2].profileRevision, 1);
  for (const row of rows) {
    for (const key of ['scores', 'notes', 'order', 'comments', 'details', 'recommendedBy']) assert.ok(!(key in row));
  }
  assert.deepEqual(filterIntakeRoster(rows, { team: 'unassigned' }).map(row => row.participantId), ['100']);
  assert.deepEqual(filterIntakeRoster(rows, { team: '01' }).map(row => row.participantId), ['12']);
  assert.deepEqual(filterIntakeRoster(rows, { query: 'בת' }).map(row => row.participantId), ['12']);
  assert.deepEqual(filterIntakeRoster(rows, { query: '039284906' }).map(row => row.participantId), ['12']);
  assert.deepEqual(filterIntakeRoster(rows, { query: '1' }).map(row => row.participantId), ['12', '100']);
  assert.equal(nationalIdOwner(rows, '039284906')?.participantId, '12');
  assert.equal(nationalIdOwner(rows, '039284906', '01:12'), null);
  assert.equal(nationalIdOwner(rows, '0'), null);
});

test('numbering starts after the counter and every existing number', () => {
  assert.equal(maxParticipantNumber([{ participantId: '12' }, { id: '7' }], [{ participantId: 'abc' }]), 12);
  assert.equal(maxParticipantNumber([]), 0);
  assert.equal(firstNumberToTry(0, 140), 141);
  assert.equal(firstNumberToTry(150, 140), 151);
  assert.equal(firstNumberToTry(undefined, null), 1);
});

test('rosters stay numerically sorted and unique', () => {
  assert.deepEqual(rosterWith(['9', '100', '20'], '21'), ['9', '20', '21', '100']);
  assert.deepEqual(rosterWith(['9'], '9'), ['9']);
  assert.deepEqual(rosterWithout(['9', '21', '100'], '21'), ['9', '100']);
});

test('a candidate has data after a round in the current team, a status change or a recommendation', () => {
  const candidate = { team: '01', participantId: '12', status: 'active', statusRevision: 0 };
  assert.deepEqual(candidateDataReasons({ candidate }), []);
  assert.deepEqual(candidateDataReasons({ candidate, races: [{ team: '02', participantIds: ['12'] }, { team: '01', participantIds: ['13'] }] }), []);
  assert.match(candidateDataReasons({ candidate, races: [{ team: '01', participantIds: ['12'] }] }).join(), /סבב/);
  assert.match(candidateDataReasons({ candidate: { ...candidate, statusRevision: 2 } }).join(), /מצב/);
  assert.match(candidateDataReasons({ candidate: { ...candidate, status: 'withdrawn', reasonCode: 'medical', statusRevision: 1 } }).join(), /מצב/);
  assert.match(candidateDataReasons({ candidate, hasRecommendation: true }).join(), /המלצת נשירה/);
  assert.deepEqual(candidateDataReasons({ candidate: { team: '', participantId: '5' }, hasRecommendation: true }), []);
  assert.match(moveBlockedMessage(['השתתף בסבב בצוות']), /לא ניתן להעביר[\s\S]*השתתף בסבב/);
});

test('labels and server errors are explained in Hebrew', () => {
  assert.equal(intakeTeamLabel(''), 'כללי (ללא צוות)');
  assert.equal(intakeTeamLabel('03'), 'צוות 3');
  assert.match(intakeErrorMessage({ code: 'permission-denied' }), /סירב/);
  assert.match(intakeErrorMessage({ code: 'unavailable' }), /חיבור/);
  assert.equal(intakeErrorMessage(new Error('הודעה')), 'הודעה');
});
