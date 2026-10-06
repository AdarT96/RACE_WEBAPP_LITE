import { normalizeIntensity } from './schedule-model.js';

// Descriptive only. Scheduling decisions belong to formation management.
export const INTENSITY_LABELS = Object.freeze({
  0:'ללא עומס', 1:'עומס נמוך', 2:'עומס בינוני', 3:'עומס גבוה'
});

export function stationIntensityFor(team, stationId, { teamStationMaps = {}, stationTypes = {} } = {}) {
  return normalizeIntensity(stationTypes?.[teamStationMaps?.[team]?.[stationId]]?.intensity);
}
