import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SESSION_LIMIT_SECONDS,
  sessionLimitMs,
  sessionDeadlineMs,
  isSessionExpired,
  isSessionEffectivelyRunning,
  effectiveSessionElapsedMs,
  measuredElapsedMs,
  canRoleControlSession
} from '../frontend/js/session-policy.js';

const START = 1_700_000_000_000;
const LIMIT_MS = 40 * 60 * 1000;

test('new and legacy races use the 40-minute limit', () => {
  assert.equal(DEFAULT_SESSION_LIMIT_SECONDS, 2400);
  assert.equal(sessionLimitMs({}), LIMIT_MS);
  assert.equal(sessionLimitMs({ timeLimitSeconds: 2400 }), LIMIT_MS);
  assert.equal(sessionLimitMs({ timeLimitSeconds: 3600 }), LIMIT_MS);
  assert.equal(sessionDeadlineMs({ startedAt: START }), START + LIMIT_MS);
});

test('a running race becomes effectively stopped exactly at the deadline', () => {
  const race = { status: 'running', startedAt: START };
  assert.equal(isSessionEffectivelyRunning(race, START + LIMIT_MS - 1), true);
  assert.equal(isSessionExpired(race, START + LIMIT_MS - 1), false);
  assert.equal(isSessionEffectivelyRunning(race, START + LIMIT_MS), false);
  assert.equal(isSessionExpired(race, START + LIMIT_MS), true);
  assert.equal(effectiveSessionElapsedMs(race, START + LIMIT_MS + 50_000), LIMIT_MS);
});

test('stored and live duration are both clamped to the policy limit', () => {
  assert.equal(effectiveSessionElapsedMs({
    status: 'stopped', startedAt: START, endedAt: START + 90_000
  }), 90_000);
  assert.equal(effectiveSessionElapsedMs({
    status: 'stopped', startedAt: START, endedAt: START + LIMIT_MS + 90_000
  }), LIMIT_MS);
});

test('arrival measurements after the limit are untimed instead of becoming zero', () => {
  const race = { startedAt: START };
  assert.equal(measuredElapsedMs(race, START + 15_000), 15_000);
  assert.equal(measuredElapsedMs(race, START + LIMIT_MS), LIMIT_MS);
  assert.equal(measuredElapsedMs(race, START + LIMIT_MS + 1), null);
  assert.equal(measuredElapsedMs(race, START - 1), null);
});

test('only the commander role controls session lifecycle', () => {
  assert.equal(canRoleControlSession('operator'), true);
  assert.equal(canRoleControlSession('evaluator'), false);
  assert.equal(canRoleControlSession('formation_commander'), false);
  assert.equal(canRoleControlSession('admin'), false);
  assert.equal(canRoleControlSession(undefined), false);
});
