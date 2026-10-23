import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES, canControlSession, canEvaluate, canManageFormation,
  canManageSchedule, canRecommendDropout, canViewSchedule, destinationForRole, profileForActiveEvent,
  roleNeedsTeam, roleLabel, isKnownRole, canManageIntake, EVENT_STAFF_ROLES
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

test('event staffing overrides the global role and rejects missing assignments', () => {
  const profile = { role:ROLES.EVALUATOR, team:1, approved:true };
  const pointer = { status:'active', eventId:'event-2', eventStaffingSchemaVersion:1 };
  assert.deepEqual(profileForActiveEvent(profile, pointer, {
    active:true, role:ROLES.OPERATOR, team:'03'
  }), {
    ...profile, role:ROLES.OPERATOR, team:3, activeEventId:'event-2', eventAccess:true
  });
  assert.equal(profileForActiveEvent(profile, pointer, null).eventAccess, false);
  assert.equal(profileForActiveEvent(profile, {
    status:'active', eventId:'legacy-event'
  }, null).eventAccess, true);
});

test('event staffing accepts every supported event team', () => {
  const profile = { role:ROLES.EVALUATOR, team:1, approved:true };
  const pointer = { status:'active', eventId:'event-2', eventStaffingSchemaVersion:1 };
  assert.deepEqual(profileForActiveEvent(profile, pointer, {
    active:true, role:ROLES.OPERATOR, team:'20'
  }), {
    ...profile, role:ROLES.OPERATOR, team:20, activeEventId:'event-2', eventAccess:true
  });
});

// למנהל אין תפקיד משלו במסך התחנה: הוא מקבל את יכולות המעריך וגם את
// הפעלת הסבב, כדי שיוכל לכסות על מפק״צ נעדר בלי לשנות לעצמו תפקיד.
// הכלים החוצה-צוותיים נשארים של מפקד הגיבוש.
test('an administrator can both evaluate and run a station round', () => {
  assert.equal(canControlSession(ROLES.ADMIN), true);
  assert.equal(canEvaluate(ROLES.ADMIN), true);
  assert.equal(roleNeedsTeam(ROLES.ADMIN), false);
  assert.equal(canRecommendDropout(ROLES.ADMIN), false);
});

test('adjutancy is a global intake role without evaluation or schedule access', () => {
  assert.equal(ROLES.ADJUTANT, 'adjutant');
  assert.equal(roleLabel(ROLES.ADJUTANT), 'שלישות');
  assert.equal(isKnownRole(ROLES.ADJUTANT), true);
  assert.equal(roleNeedsTeam(ROLES.ADJUTANT), false);
  assert.equal(destinationForRole(ROLES.ADJUTANT), 'intake.html');
  assert.equal(canManageIntake(ROLES.ADJUTANT), true);
  assert.equal(canManageIntake(ROLES.FORMATION_COMMANDER), true);
  assert.equal(canManageIntake(ROLES.ADMIN), true);
  assert.equal(canManageIntake(ROLES.OPERATOR), false);
  assert.equal(canManageIntake(ROLES.EVALUATOR), false);
  assert.equal(canEvaluate(ROLES.ADJUTANT), false);
  assert.equal(canControlSession(ROLES.ADJUTANT), false);
  assert.equal(canRecommendDropout(ROLES.ADJUTANT), false);
  assert.equal(canManageFormation(ROLES.ADJUTANT), false);
  assert.equal(canViewSchedule(ROLES.ADJUTANT), false);
  assert.equal(canManageSchedule(ROLES.ADJUTANT), false);
  assert.ok(EVENT_STAFF_ROLES.includes(ROLES.ADJUTANT));
});

test('an adjutant staffed in the active event resolves without a team', () => {
  const profile = { role:ROLES.ADJUTANT, team:null, approved:true };
  const pointer = { status:'active', eventId:'event-2', eventStaffingSchemaVersion:1 };
  assert.deepEqual(profileForActiveEvent(profile, pointer, { active:true, role:ROLES.ADJUTANT, team:'' }), {
    ...profile, role:ROLES.ADJUTANT, team:null, activeEventId:'event-2', eventAccess:true
  });
  assert.equal(profileForActiveEvent(profile, pointer, { active:false, role:ROLES.ADJUTANT, team:'' }).eventAccess, false);
});
