import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES, canControlSession, canEvaluate, canManageFormation,
  canManageSchedule, canRecommendDropout, canViewSchedule, destinationForRole, roleNeedsTeam
} from '../frontend/js/roles.js';

test('formation commander is global and routes only to the operational dashboard', () => {
  assert.equal(roleNeedsTeam(ROLES.FORMATION_COMMANDER), false);
  assert.equal(destinationForRole(ROLES.FORMATION_COMMANDER), 'commander.html');
  assert.equal(canManageFormation(ROLES.FORMATION_COMMANDER), true);
  assert.equal(canControlSession(ROLES.FORMATION_COMMANDER), false);
  assert.equal(canEvaluate(ROLES.FORMATION_COMMANDER), false);
  assert.equal(canRecommendDropout(ROLES.FORMATION_COMMANDER), false);
  assert.equal(canManageSchedule(ROLES.FORMATION_COMMANDER), true);
  assert.equal(canViewSchedule(ROLES.FORMATION_COMMANDER), true);
});

test('team commander and evaluator keep separate capabilities', () => {
  assert.equal(roleNeedsTeam(ROLES.OPERATOR), true);
  assert.equal(roleNeedsTeam(ROLES.EVALUATOR), true);
  assert.equal(canControlSession(ROLES.OPERATOR), true);
  assert.equal(canRecommendDropout(ROLES.OPERATOR), true);
  assert.equal(canEvaluate(ROLES.EVALUATOR), true);
  assert.equal(canManageFormation(ROLES.OPERATOR), false);
  assert.equal(canManageSchedule(ROLES.OPERATOR), false);
  assert.equal(canViewSchedule(ROLES.OPERATOR), true);
  assert.equal(canViewSchedule(ROLES.EVALUATOR), true);
});
