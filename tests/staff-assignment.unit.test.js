import test from 'node:test';
import assert from 'node:assert/strict';
import { staffAssignmentChange, staffPatchForUserChange } from '../frontend/js/staff-assignment.js';

const evaluatorStaff = { role: 'evaluator', team: '03', active: true };

test('a team change in the admin panel moves the event staffing too', () => {
  assert.deepEqual(staffPatchForUserChange(evaluatorStaff, { team: 5 }), { role: 'evaluator', team: '05' });
});

test('users outside the active event staffing are left to the user record', () => {
  assert.equal(staffPatchForUserChange(null, { team: 5 }), null);
  assert.equal(staffPatchForUserChange({ ...evaluatorStaff, active: false }, { team: 5 }), null);
});

test('a staffed operator or evaluator cannot be left without a team', () => {
  assert.throws(() => staffPatchForUserChange(evaluatorStaff, { team: null }), /חייב צוות/);
  assert.throws(() => staffPatchForUserChange(evaluatorStaff, { team: 21 }), /חייב צוות/);
});

test('role changes keep the staffed team, or borrow the user record team', () => {
  assert.deepEqual(staffPatchForUserChange(evaluatorStaff, { role: 'operator' }), { role: 'operator', team: '03' });
  assert.deepEqual(staffPatchForUserChange(evaluatorStaff, { role: 'formation_commander' }),
    { role: 'formation_commander', team: '' });
  const commander = { role: 'formation_commander', team: '', active: true };
  assert.deepEqual(staffPatchForUserChange(commander, { role: 'evaluator' }, 4), { role: 'evaluator', team: '04' });
  assert.throws(() => staffPatchForUserChange(commander, { role: 'evaluator' }, null), /חייב צוות/);
});

test('promoting to admin leaves the staffing alone, since admins bypass it', () => {
  assert.equal(staffPatchForUserChange(evaluatorStaff, { role: 'admin' }), null);
});

test('an open app notices a moved team, a changed role or a removal', () => {
  const current = { role: 'evaluator', team: 3 };
  assert.equal(staffAssignmentChange(current, evaluatorStaff), null);
  assert.equal(staffAssignmentChange(current, { ...evaluatorStaff, team: '05' }).kind, 'team');
  assert.match(staffAssignmentChange(current, { ...evaluatorStaff, team: '05' }).message, /לצוות 5/);
  assert.equal(staffAssignmentChange(current, { ...evaluatorStaff, role: 'operator' }).kind, 'role');
  assert.equal(staffAssignmentChange(current, { ...evaluatorStaff, active: false }).kind, 'removed');
  assert.equal(staffAssignmentChange(current, null).kind, 'removed');
});

test('a formation commander has no team to compare', () => {
  const commander = { role: 'formation_commander', team: null };
  assert.equal(staffAssignmentChange(commander, { role: 'formation_commander', team: '', active: true }), null);
});
