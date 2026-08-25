import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATION_OPERATIONAL_STATUSES, buildStationOperationalStatus,
  buildTeamOperationalStatus, stationOperationalStatusLabel
} from '../frontend/js/station-operational-status.js';

const MINUTE = 60 * 1000;

test('an untouched station has one unambiguous not-started state', () => {
  const status = buildStationOperationalStatus({ team:'01', stationId:'04', races:[] });
  assert.equal(status.status, STATION_OPERATIONAL_STATUSES.NOT_STARTED);
  assert.equal(status.currentRound, 0);
  assert.equal(status.completedRoundCount, 0);
  assert.equal(status.totalRoundCount, 0);
  assert.equal(stationOperationalStatusLabel(status), 'טרם התחילה');
});

test('station details expose round lifecycle without evaluation data', () => {
  const status = buildStationOperationalStatus({
    team:'01', stationId:'04', nowMs:100 * MINUTE,
    races: [
      { id:'r1', team:'01', station:'04', round:1, status:'stopped', startedAt:10 * MINUTE, endedAt:20 * MINUTE },
      { id:'r2', team:'01', station:'04', round:2, status:'stopped', startedAt:30 * MINUTE, endedAt:40 * MINUTE },
      { id:'r3', team:'01', station:'04', round:3, status:'running', startedAt:90 * MINUTE },
      { id:'other-team', team:'02', station:'04', round:8, status:'running', startedAt:95 * MINUTE },
      { id:'other-station', team:'01', station:'05', round:9, status:'running', startedAt:96 * MINUTE }
    ]
  });
  assert.equal(status.status, STATION_OPERATIONAL_STATUSES.RUNNING);
  assert.equal(status.currentRound, 3);
  assert.equal(status.completedRoundCount, 2);
  assert.equal(status.totalRoundCount, 3);
  assert.equal(status.activeRaceCount, 1);
  assert.equal(Object.hasOwn(status, 'scores'), false);
  assert.equal(Object.hasOwn(status, 'evaluations'), false);
});

test('a race left running past forty minutes is operationally completed', () => {
  const status = buildStationOperationalStatus({
    team:'01', stationId:'04', nowMs:51 * MINUTE,
    races: [{
      id:'expired', team:'01', station:'04', round:1, status:'running',
      startedAt:10 * MINUTE, timeLimitSeconds:40 * 60
    }]
  });
  assert.equal(status.status, STATION_OPERATIONAL_STATUSES.STOPPED);
  assert.equal(status.currentRound, 1);
  assert.equal(status.completedRoundCount, 1);
  assert.equal(status.activeRaceCount, 0);
});

test('concurrent station rounds are surfaced instead of silently collapsed', () => {
  const status = buildStationOperationalStatus({
    team:'01', stationId:'04', nowMs:20 * MINUTE,
    races: [
      { id:'a', team:'01', station:'04', round:1, status:'running', startedAt:10 * MINUTE },
      { id:'b', team:'01', station:'04', round:2, status:'running', startedAt:15 * MINUTE }
    ]
  });
  assert.equal(status.currentRound, 2);
  assert.equal(status.activeRaceCount, 2);
  assert.equal(status.hasConcurrentRaces, true);
});

test('team and station views use the same operational calculation', () => {
  const races = [
    { id:'old', team:'01', station:'03', round:1, status:'stopped', startedAt:1 * MINUTE, endedAt:2 * MINUTE },
    { id:'current', team:'01', station:'04', round:4, status:'running', startedAt:10 * MINUTE }
  ];
  const team = buildTeamOperationalStatus({ team:'01', races, nowMs:20 * MINUTE });
  const station = buildStationOperationalStatus({ team:'01', stationId:'04', races, nowMs:20 * MINUTE });
  assert.equal(team.station, '04');
  assert.equal(team.status, station.status);
  assert.equal(team.currentRound, station.currentRound);
  assert.equal(team.totalRoundCount, station.totalRoundCount);
});
