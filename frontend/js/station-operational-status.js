import { isSessionEffectivelyRunning } from './session-policy.js';

export const STATION_OPERATIONAL_STATUSES = Object.freeze({
  NOT_STARTED: 'not_started',
  RUNNING: 'running',
  STOPPED: 'stopped'
});

export const STATION_OPERATIONAL_STATUS_LABELS = Object.freeze({
  [STATION_OPERATIONAL_STATUSES.NOT_STARTED]: 'טרם התחילה',
  [STATION_OPERATIONAL_STATUSES.RUNNING]: 'פעילה',
  [STATION_OPERATIONAL_STATUSES.STOPPED]: 'הסתיימה'
});

const normalizeTeam = value => {
  const number = Number.parseInt(String(value ?? '').replace(/\D+/g, ''), 10);
  return Number.isInteger(number) && number > 0 ? String(number).padStart(2, '0') : '';
};

const normalizeStation = value => String(value ?? '').trim();

export function operationalTimestampMs(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function raceActivityMs(race) {
  return operationalTimestampMs(race?.endedAt) ?? operationalTimestampMs(race?.startedAt) ?? 0;
}

function roundNumber(race) {
  return Math.max(0, Math.floor(Number(race?.round) || 0));
}

function newestFirst(left, right) {
  const activityDifference = raceActivityMs(right) - raceActivityMs(left);
  return activityDifference || roundNumber(right) - roundNumber(left) ||
    String(right?.id || '').localeCompare(String(left?.id || ''));
}

function uniqueRoundCount(races) {
  return new Set(races.map(race => {
    const round = roundNumber(race);
    return round ? `round:${round}` : `race:${String(race?.id || '')}`;
  })).size;
}

export function stationOperationalStatusLabel(statusOrSnapshot) {
  const status = typeof statusOrSnapshot === 'string'
    ? statusOrSnapshot : statusOrSnapshot?.status || statusOrSnapshot?.raceStatus;
  return STATION_OPERATIONAL_STATUS_LABELS[status] || '—';
}

export function buildStationOperationalStatus({
  team, stationId, races = [], nowMs = Date.now(),
  isRaceRunning = isSessionEffectivelyRunning
} = {}) {
  const normalizedTeam = normalizeTeam(team);
  const normalizedStation = normalizeStation(stationId);
  const stationRaces = (Array.isArray(races) ? races : []).filter(race =>
    normalizeTeam(race?.team) === normalizedTeam &&
    normalizeStation(race?.station) === normalizedStation
  ).sort(newestFirst);
  const runningRaces = stationRaces.filter(race => isRaceRunning(race, nowMs)).sort(newestFirst);
  const currentRace = runningRaces[0] || stationRaces[0] || null;
  const completedRaces = stationRaces.filter(race => !isRaceRunning(race, nowMs));
  const status = runningRaces.length
    ? STATION_OPERATIONAL_STATUSES.RUNNING
    : stationRaces.length ? STATION_OPERATIONAL_STATUSES.STOPPED
      : STATION_OPERATIONAL_STATUSES.NOT_STARTED;

  return {
    team: normalizedTeam,
    stationId: normalizedStation,
    status,
    raceStatus: status,
    currentRace,
    currentRound: roundNumber(currentRace),
    round: roundNumber(currentRace),
    activeRaceCount: runningRaces.length,
    completedRoundCount: uniqueRoundCount(completedRaces),
    totalRoundCount: uniqueRoundCount(stationRaces),
    hasConcurrentRaces: runningRaces.length > 1,
    lastActivityAt: currentRace ? raceActivityMs(currentRace) : null
  };
}

export function buildTeamOperationalStatus({
  team, races = [], nowMs = Date.now(),
  isRaceRunning = isSessionEffectivelyRunning
} = {}) {
  const normalizedTeam = normalizeTeam(team);
  const teamRaces = (Array.isArray(races) ? races : [])
    .filter(race => normalizeTeam(race?.team) === normalizedTeam)
    .sort(newestFirst);
  const runningRaces = teamRaces.filter(race => isRaceRunning(race, nowMs)).sort(newestFirst);
  const currentRace = runningRaces[0] || teamRaces[0] || null;
  const stationId = normalizeStation(currentRace?.station);
  const stationStatus = stationId ? buildStationOperationalStatus({
    team: normalizedTeam, stationId, races: teamRaces, nowMs, isRaceRunning
  }) : buildStationOperationalStatus({
    team: normalizedTeam, stationId: '', races: [], nowMs, isRaceRunning
  });
  const status = runningRaces.length
    ? STATION_OPERATIONAL_STATUSES.RUNNING
    : currentRace ? STATION_OPERATIONAL_STATUSES.STOPPED
      : STATION_OPERATIONAL_STATUSES.NOT_STARTED;

  return {
    ...stationStatus,
    stationId,
    station: stationId,
    status,
    raceStatus: status,
    currentRace,
    currentRound: roundNumber(currentRace),
    round: roundNumber(currentRace),
    activeRaceCount: runningRaces.length,
    hasConcurrentRaces: runningRaces.length > 1,
    lastActivityAt: currentRace ? raceActivityMs(currentRace) : null,
    stationIdsVisited: [...new Set(teamRaces.map(race => normalizeStation(race?.station)).filter(Boolean))]
  };
}
