import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIssueReportData } from '../frontend/js/issue-report.js';

function validInput() {
  return {
    draft: { category: 'timing', description: 'השעון נעצר', steps: 'לחצתי על התחלה' },
    reporter: { uid: 'user-1', name: 'מעריך א', role: 'evaluator', team: 3 },
    context: {
      team: '03', station: '07', stationType: 'pullup', stationName: 'מתח',
      viewedRaceId: 'race_03_07_2', latestRaceId: 'race_03_07_2', round: 2,
      raceStatus: 'running', effectiveElapsedMs: 12_345, historicalView: false
    },
    environment: { appVersion: 'lite-v1.0', online: true, viewport: '390x844', userAgent: 'test' }
  };
}

test('builds an allow-listed report without evaluation or participant data', () => {
  const report = buildIssueReportData(validInput());
  assert.deepEqual(Object.keys(report).sort(), [
    'adminNote', 'category', 'context', 'description', 'environment', 'reporterName',
    'reporterRole', 'reporterTeam', 'reporterUid', 'schemaVersion', 'status', 'steps'
  ].sort());
  assert.equal(report.status, 'open');
  assert.equal(report.reporterTeam, 3);
  assert.equal(report.context.stationType, 'pullup');
  assert.equal('participantIds' in report.context, false);
  assert.equal('tags' in report, false);
  assert.equal('notes' in report, false);
});

test('requires a description and trusted reporter identity', () => {
  const noDescription = validInput();
  noDescription.draft.description = '   ';
  assert.throws(() => buildIssueReportData(noDescription), /לתאר/);

  const wrongRole = validInput();
  wrongRole.reporter.role = 'guest';
  assert.throws(() => buildIssueReportData(wrongRole), /זהות/);

  const noTeam = validInput();
  noTeam.reporter.team = '';
  assert.throws(() => buildIssueReportData(noTeam), /צוות/);
});

test('normalizes numeric context and caps diagnostic text lengths', () => {
  const input = validInput();
  input.context.round = 2.9;
  input.context.effectiveElapsedMs = 9_999_999;
  input.environment.userAgent = 'x'.repeat(600);
  const report = buildIssueReportData(input);
  assert.equal(report.context.round, 2);
  assert.equal(report.context.effectiveElapsedMs, 2_400_000);
  assert.equal(report.environment.userAgent.length, 500);
});
