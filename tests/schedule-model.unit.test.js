import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULE_ROW_KINDS, buildTeamScheduleProjection, normalizeSchedule,
  recommendedStationFromProjection, scheduleEntryAt, scheduleIssues
} from '../frontend/js/schedule-model.js';
import { analyzeScheduleLoad } from '../frontend/js/schedule-load-policy.js';
import { evaluationTargetFromSearch, resolveInitialStation } from '../frontend/js/app-navigation-model.js';

function masterSchedule() {
  return normalizeSchedule({
    teamIds: ['01', '02'], commanderNames: { '01': 'שחר', '02': 'ברוס' },
    rows: [
      { id: 'prep', date: '2026-08-24', startMinute: 180, kind: 'global', label: 'חימום' },
      { id: 'first', date: '2026-08-24', startMinute: 190, kind: 'rotation', assignments: {
        '01': { stationId: '04', routeNumber: '1' }, '02': { stationId: '02', routeNumber: '3' }
      } },
      { id: 'second', date: '2026-08-24', startMinute: 240, kind: 'rotation', assignments: {
        '01': { stationId: '02', routeNumber: '2' }, '02': { stationId: '04', routeNumber: '1' }
      } }
    ]
  });
}

test('one master schedule creates a least-privilege projection per team', () => {
  const projection = buildTeamScheduleProjection(masterSchedule(), '01');
  assert.equal(projection.commanderName, 'שחר');
  assert.deepEqual(projection.entries[1], {
    id: 'first', date: '2026-08-24', startMinute: 190, kind: SCHEDULE_ROW_KINDS.ROTATION,
    label: '', stationId: '04', routeNumber: '1'
  });
  assert.equal(JSON.stringify(projection).includes('ברוס'), false);
  assert.equal(JSON.stringify(projection).includes('"02":"'), false);
});

test('schedule validation rejects duplicate times and malformed global rows', () => {
  const schedule = masterSchedule();
  schedule.rows.push({
    id: 'duplicate', date: '2026-08-24', startMinute: 240,
    kind: 'global', label: '', assignments: {}
  });
  const issues = scheduleIssues(schedule, { stationIdsByTeam: { '01': ['01', '02', '04'], '02': ['02', '04'] } });
  assert.ok(issues.some(issue => issue.includes('אותה שעה')));
  assert.ok(issues.some(issue => issue.includes('פעילות המשותפת')));
});

test('schedule validation reports an oversized schedule instead of silently truncating it', () => {
  const schedule = masterSchedule();
  schedule.rows = Array.from({ length: 101 }, (_, index) => ({
    id: `row-${index}`, date: '2026-08-24', startMinute: index,
    kind: 'global', label: `פעילות ${index}`, assignments: {}
  }));
  assert.equal(normalizeSchedule(schedule).rows.length, 101);
  assert.ok(scheduleIssues(schedule).some(issue => issue.includes('100 שורות')));
});

test('schedule validation rejects invalid or duplicate team identities', () => {
  const invalid = masterSchedule();
  invalid.teamIds = ['01', '1', '16'];
  const issues = scheduleIssues(invalid);
  assert.ok(issues.some(issue => issue.includes('יותר מפעם אחת')));
  assert.ok(issues.some(issue => issue.includes('מספר צוות שאינו תקין')));
});

test('current and recommended entries respect the Israel-local schedule', () => {
  const projection = buildTeamScheduleProjection(masterSchedule(), '01');
  const duringFirst = new Date('2026-08-24T00:20:00.000Z'); // 03:20 in Israel summer time
  assert.equal(scheduleEntryAt(projection.entries, duringFirst)?.id, 'first');
  assert.deepEqual(recommendedStationFromProjection(projection, duringFirst), {
    stationId: '04', entry: projection.entries[1], source: 'current'
  });
  const duringBreak = new Date('2026-08-23T23:05:00.000Z'); // 02:05, before the first row
  assert.equal(recommendedStationFromProjection(projection, duringBreak)?.stationId, '04');
  assert.equal(recommendedStationFromProjection(projection, duringBreak)?.source, 'next');
});

test('load analysis uses station intensity without storing it in schedule cells', () => {
  const warnings = analyzeScheduleLoad(masterSchedule(), {
    teamStationMaps: {
      '01': { '04': 'sprints', '02': 'crawls' },
      '02': { '02': 'discussion', '04': 'magen' }
    },
    stationTypes: {
      sprints: { intensity: 3 }, crawls: { intensity: 3 },
      discussion: { intensity: 0 }, magen: { intensity: 3 }
    }
  });
  assert.ok(warnings.some(warning => warning.team === '01' && warning.code === 'consecutive_high'));
  assert.equal(warnings.some(warning => warning.team === '02'), false);
});

test('explicit navigation wins, then a running station, schedule, saved choice and fallback', () => {
  const projection = buildTeamScheduleProjection(masterSchedule(), '01');
  const now = new Date('2026-08-24T00:20:00.000Z');
  const base = { scheduleProjection: projection, availableStations: ['01', '02', '04'], now };
  assert.deepEqual(resolveInitialStation({ ...base, explicitStation: '02', runningStation: '04' }),
    { stationId: '02', source: 'explicit' });
  assert.deepEqual(resolveInitialStation({ ...base, runningStation: '02' }),
    { stationId: '02', source: 'running' });
  assert.deepEqual(resolveInitialStation(base), { stationId: '04', source: 'schedule_current' });
  assert.deepEqual(resolveInitialStation({ availableStations: ['01'], savedStation: '01' }),
    { stationId: '01', source: 'saved' });
  assert.deepEqual(evaluationTargetFromSearch('?team=02&station=04'), { team: '02', station: '04' });
});
