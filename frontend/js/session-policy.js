// Session lifecycle policy shared by the app, admin view, and automated tests.
// Keep this module free of DOM/Firebase dependencies so every time calculation
// has one deterministic implementation.

import { canControlSession } from './roles.js';

export const DEFAULT_SESSION_LIMIT_SECONDS = 40 * 60;

export function timestampToMs(value) {
  if (value == null) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  return null;
}

// The commander's device records the tap itself (startTappedAt / endTappedAt).
// The server stamps startedAt/endedAt when the save arrives — 0.2–2 s after the
// tap on a mobile network — so the tap is the real moment. It is used only when
// plausible: not after the server time and at most TAP_LEAD_MAX_MS before it. A
// device with a wrong clock therefore falls back to the server time. While the
// server time is still pending (just saved), the tap is used.
export const TAP_LEAD_MAX_MS = 4000;

function tapOrServerMs(tap, server) {
  const tapMs = timestampToMs(tap);
  const serverMs = timestampToMs(server);
  if (serverMs == null) return tapMs;
  if (tapMs != null && tapMs <= serverMs && serverMs - tapMs <= TAP_LEAD_MAX_MS) return tapMs;
  return serverMs;
}

export function sessionStartMs(race) {
  return tapOrServerMs(race?.startTappedAt, race?.startedAt);
}

export function sessionStoredEndMs(race) {
  return tapOrServerMs(race?.endTappedAt, race?.endedAt);
}

export function sessionLimitMs(race) {
  const configured = Number(race?.timeLimitSeconds);
  const seconds = configured === DEFAULT_SESSION_LIMIT_SECONDS
    ? configured
    : DEFAULT_SESSION_LIMIT_SECONDS;
  return seconds * 1000;
}

export function sessionDeadlineMs(race) {
  const startedAt = sessionStartMs(race);
  return startedAt == null ? null : startedAt + sessionLimitMs(race);
}

export function isSessionExpired(race, nowMs = Date.now()) {
  if (!race || race.status !== 'running') return false;
  const deadline = sessionDeadlineMs(race);
  return deadline != null && Number(nowMs) >= deadline;
}

export function isSessionEffectivelyRunning(race, nowMs = Date.now()) {
  return Boolean(race?.status === 'running' && !isSessionExpired(race, nowMs));
}

export function effectiveSessionEndMs(race, nowMs = Date.now()) {
  const startedAt = sessionStartMs(race);
  if (startedAt == null) return null;
  const deadline = startedAt + sessionLimitMs(race);
  const storedEnd = sessionStoredEndMs(race);
  const candidate = race?.status === 'running'
    ? Number(nowMs)
    : (storedEnd ?? Number(nowMs));
  return Math.max(startedAt, Math.min(candidate, deadline));
}

export function effectiveSessionElapsedMs(race, nowMs = Date.now()) {
  const startedAt = sessionStartMs(race);
  const endedAt = effectiveSessionEndMs(race, nowMs);
  return startedAt == null || endedAt == null ? null : endedAt - startedAt;
}

export function measuredElapsedMs(race, measuredAt) {
  const startedAt = sessionStartMs(race);
  const measured = timestampToMs(measuredAt);
  if (startedAt == null || measured == null) return null;
  const elapsed = measured - startedAt;
  return elapsed >= 0 && elapsed <= sessionLimitMs(race) ? elapsed : null;
}

export const canRoleControlSession = canControlSession;
