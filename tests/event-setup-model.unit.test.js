import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eventSetupReadiness, eventTeamIds, normalizeEventStaff, normalizeEventTeamId
} from '../frontend/js/event-setup-model.js';

const schedule = {
  teamIds: ['01', '02'],
  rows: [{ id:'row-1', date:'2026-09-12', startMinute:180, kind:'global', label:'פתיחה', assignments:{} }]
};

test('schedule is the authoritative source of event teams', () => {
  assert.deepEqual(eventTeamIds({ schedule, teams:[{ id:'03' }] }), ['01', '02']);
});

test('incomplete profiles and staffing are warnings, not activation blockers', () => {
  const readiness = eventSetupReadiness({
    event:{ name:'גיבוש ספטמבר', status:'draft' }, schedule,
    candidates:[{ team:'01', participantId:'100' }],
    staff:[{ uid:'operator-1', role:'operator', team:'01' }]
  });
  assert.equal(readiness.canActivate, true);
  assert.equal(readiness.blockers.length, 0);
  assert.ok(readiness.warnings.some(item => item.includes('שם פרטי')));
  assert.ok(readiness.warnings.some(item => item.includes('צוות 2')));
  assert.ok(readiness.warnings.some(item => item.includes('ההמלצה היא לפחות 2')));
});

test('missing name, schedule, invalid participant key and duplicate national id block activation', () => {
  const noSchedule = eventSetupReadiness({ event:{ name:'' } });
  assert.equal(noSchedule.canActivate, false);
  assert.ok(noSchedule.blockers.length >= 3);

  const duplicate = eventSetupReadiness({
    event:{ name:'אירוע' }, schedule:{ ...schedule, teamIds:['01'] },
    candidates:[
      { team:'01', participantId:'100', nationalId:'039284906' },
      { team:'01', participantId:'101', nationalId:'039284906' }
    ]
  });
  assert.equal(duplicate.canActivate, false);
  assert.ok(duplicate.blockers.some(item => item.includes('יותר ממועמד אחד')));
});

test('staff normalization keeps only operational event assignments', () => {
  assert.deepEqual(normalizeEventStaff({ id:'u1', name:'אורי', role:'evaluator', team:3 }), {
    uid:'u1', displayName:'אורי', role:'evaluator', team:'03', active:true
  });
  assert.equal(normalizeEventStaff({ uid:'u2', role:'admin', team:1 }).role, '');
  assert.equal(normalizeEventTeamId(16), '');
});
