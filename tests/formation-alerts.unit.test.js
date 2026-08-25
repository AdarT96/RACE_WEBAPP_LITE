import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFormationAlerts } from '../frontend/js/formation-alerts-model.js';

const now = new Date('2026-08-24T00:20:00.000Z');

test('the alert center combines operational faults without evaluation data', () => {
  const alerts = buildFormationAlerts({
    now,
    dashboard: {
      teams:[{
        team:'01', activeRaceCount:2, hasConcurrentRaces:true,
        candidates:[{ team:'01', participantId:'100', firstName:'0', nationalId:'0', emergencyContactPhone:'0' }]
      }, { team:'02', activeRaceCount:0, hasConcurrentRaces:false, candidates:[] }],
      openRecommendations:[{ team:'01', participantId:'100' }]
    },
    races:[{
      id:'expired', team:'01', station:'04', status:'running', round:1,
      startedAt:now.getTime() - 41 * 60 * 1000, timeLimitSeconds:2400
    }],
    publishedSchedule:{
      timeZone:'Asia/Jerusalem',
      rows:[{ id:'current', date:'2026-08-24', startMinute:190, kind:'rotation', assignments:{
        '01':{ stationId:'04', routeNumber:'1' }, '02':{ stationId:'', routeNumber:'' }
      }}]
    },
    issueReports:[{ id:'issue-1', status:'open' }]
  });
  assert.deepEqual(alerts.map(alert => alert.code).sort(), [
    'concurrent_races', 'expired_session', 'missing_schedule_assignment',
    'open_dropout_recommendations', 'incomplete_candidate_profiles', 'open_issue_reports'
  ].sort());
  assert.equal(alerts[0].severity, 'critical');
  assert.equal(JSON.stringify(alerts).includes('score'), false);
  assert.equal(JSON.stringify(alerts).includes('evaluation'), false);
});

test('resolved issues and complete profiles do not create noise', () => {
  const alerts = buildFormationAlerts({
    now,
    dashboard:{ teams:[{ team:'01', candidates:[{
      team:'01', participantId:'100', firstName:'נועה', nationalId:'000000018', emergencyContactPhone:'0501234567'
    }] }], openRecommendations:[] },
    issueReports:[{ status:'resolved' }]
  });
  assert.deepEqual(alerts, []);
});
