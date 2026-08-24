import { recommendedStationFromProjection } from './schedule-model.js';

const validStations = values => new Set((Array.isArray(values) ? values : [])
  .map(value => String(value || '')).filter(Boolean));

export function evaluationTargetFromSearch(search = '') {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  return {
    team: String(params.get('team') || ''),
    station: String(params.get('station') || '')
  };
}

export function resolveInitialStation({
  explicitStation = '', runningStation = '', scheduleProjection = null,
  savedStation = '', availableStations = [], now = new Date()
} = {}) {
  const allowed = validStations(availableStations);
  const accept = value => allowed.has(String(value || '')) ? String(value) : '';
  const explicit = accept(explicitStation);
  if (explicit) return { stationId: explicit, source: 'explicit' };
  const running = accept(runningStation);
  if (running) return { stationId: running, source: 'running' };
  const scheduled = recommendedStationFromProjection(scheduleProjection, now);
  const scheduledStation = accept(scheduled?.stationId);
  if (scheduledStation) return { stationId: scheduledStation, source: `schedule_${scheduled.source}` };
  const saved = accept(savedStation);
  if (saved) return { stationId: saved, source: 'saved' };
  const first = availableStations.map(String).find(value => allowed.has(value)) || '';
  return { stationId: first, source: first ? 'first' : 'none' };
}
