import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eventSetupReadiness, eventTeamIds, normalizeEventStaff, normalizeEventTeamId
} from '../frontend/js/event-setup-model.js';

const schedule = {
  teamIds: ['01', '02'],
  rows: [{ id:'row-1', date:'2026-09-12', startMinute:180, kind:'global', label:'פתיחה', assignments:{} }]
};

test('candidates without a schedule are counted but activation requires a schedule', () => {
  const state=eventSetupReadiness({event:{name:'אירוע'},teams:[{id:'01'}],candidates:[{team:'01',participantId:'1'}]});
  assert.equal(state.counts.candidates,1);
  assert.equal(state.canActivate,false);
  assert.ok(state.blockers.some(s=>s.includes('לו״ז')));
  assert.ok(!state.blockers.some(s=>s.includes('מועמד')));
});

test('a team omitted from a nonempty schedule only warns and does not disappear', () => {
  const state=eventSetupReadiness({event:{name:'אירוע'},schedule,teams:[{id:'03'}],candidates:[{team:'03',participantId:'1'}]});
  assert.equal(state.canActivate,true);
  assert.equal(state.counts.candidates,1);
  assert.ok(state.warnings.some(s=>s.includes('אינו משובץ')));
});

test('formation commanders never inherit a team', () => {
  assert.equal(normalizeEventStaff({uid:'a',role:'formation_commander',team:'05'}).team,'');
});

test('event teams are independent of schedule columns', () => {
  assert.deepEqual(eventTeamIds({ schedule, teams:[{ id:'03' }] }), ['03']);
});

test('incomplete profiles and staffing are warnings, not activation blockers', () => {
  const readiness = eventSetupReadiness({
    event:{ name:'גיבוש ספטמבר', status:'draft' }, schedule, teams:[{id:'01'},{id:'02'}],
    candidates:[{ team:'01', participantId:'100' }],
    staff:[{ uid:'operator-1', role:'operator', team:'01' }]
  });
  assert.equal(readiness.canActivate, true);
  assert.equal(readiness.blockers.length, 0);
  assert.ok(readiness.warnings.some(item => item.includes('שם מלא')));
  assert.ok(readiness.warnings.some(item => item.includes('צוות 2')));
  assert.ok(readiness.warnings.some(item => item.includes('ההמלצה היא לפחות 2')));
});

test('missing name, schedule, invalid participant key and duplicate national id block activation', () => {
  const noSchedule = eventSetupReadiness({ event:{ name:'' } });
  assert.equal(noSchedule.canActivate, false);
  assert.ok(noSchedule.blockers.length >= 3);

  const duplicate = eventSetupReadiness({
    event:{ name:'אירוע' }, schedule:{ ...schedule, teamIds:['01'] }, teams:[{id:'01'}],
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
  assert.equal(normalizeEventTeamId(20), '20');
  assert.equal(normalizeEventTeamId(21), '');
});

test('candidates of a removed team are parked: they neither block activation nor count', () => {
  const schedule = { teamIds:['01'], rows:[{ id:'r1', date:'2026-10-10', startMinute:600, kind:'rotation', assignments:{ '01':{ stationId:'01' } } }] };
  const state = eventSetupReadiness({
    event:{ name:'אירוע' }, schedule,
    teams:[{ id:'01' }, { id:'20', active:false }],
    candidates:[{ team:'01', participantId:'101' }, { team:'20', participantId:'2001' }]
  });
  assert.equal(state.blockers.some(item => item.includes('2001')), false);
  assert.equal(state.counts.teams, 1);
  assert.equal(state.counts.candidates, 1);
});

test('a candidate whose team was never in the event still blocks activation', () => {
  const state = eventSetupReadiness({
    event:{ name:'אירוע' }, teams:[{ id:'01' }], candidates:[{ team:'07', participantId:'701' }]
  });
  assert.equal(state.blockers.some(item => item.includes('701')), true);
});

test('a candidate number may start with zero', () => {
  const state = eventSetupReadiness({
    event:{ name:'אירוע' }, teams:[{ id:'01' }], candidates:[{ team:'01', participantId:'001' }]
  });
  assert.equal(state.blockers.some(item => item.includes('ללא מספר מועמד תקין')), false);
});
