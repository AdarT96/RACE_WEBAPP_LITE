import {
  SCHEDULE_ROW_KINDS, normalizeIntensity, normalizeSchedule, scheduleMinuteKey
} from './schedule-model.js';

export const DEFAULT_SCHEDULE_LOAD_POLICY = Object.freeze({
  windowMinutes: 120,
  maxWindowLoad: 6,
  highIntensity: 3,
  maxConsecutiveHigh: 1
});

export const INTENSITY_LABELS = Object.freeze({
  0: 'ללא עומס',
  1: 'עומס נמוך',
  2: 'עומס בינוני',
  3: 'עומס גבוה'
});

export function stationIntensityFor(team, stationId, { teamStationMaps = {}, stationTypes = {} } = {}) {
  const typeId = teamStationMaps?.[team]?.[stationId] || '';
  return normalizeIntensity(stationTypes?.[typeId]?.intensity);
}

export function analyzeScheduleLoad(schedule, context = {}, policy = DEFAULT_SCHEDULE_LOAD_POLICY) {
  const normalized = normalizeSchedule(schedule, schedule?.teamIds);
  const config = {
    windowMinutes: Math.max(30, Number(policy?.windowMinutes) || DEFAULT_SCHEDULE_LOAD_POLICY.windowMinutes),
    maxWindowLoad: Math.max(1, Number(policy?.maxWindowLoad) || DEFAULT_SCHEDULE_LOAD_POLICY.maxWindowLoad),
    highIntensity: normalizeIntensity(policy?.highIntensity) || DEFAULT_SCHEDULE_LOAD_POLICY.highIntensity,
    maxConsecutiveHigh: Math.max(1, Number(policy?.maxConsecutiveHigh) || DEFAULT_SCHEDULE_LOAD_POLICY.maxConsecutiveHigh)
  };
  const warnings = [];
  normalized.teamIds.forEach(team => {
    let consecutiveHigh = 0;
    const recent = [];
    normalized.rows.forEach(row => {
      if (row.kind === SCHEDULE_ROW_KINDS.GLOBAL) {
        consecutiveHigh = 0;
        return;
      }
      const stationId = row.assignments?.[team]?.stationId || '';
      if (!stationId) {
        consecutiveHigh = 0;
        return;
      }
      const intensity = stationIntensityFor(team, stationId, context);
      const startKey = scheduleMinuteKey(row.date, row.startMinute);
      while (recent.length && startKey - recent[0].startKey >= config.windowMinutes) recent.shift();
      recent.push({ startKey, intensity });
      const windowLoad = recent.reduce((total, item) => total + item.intensity, 0);
      consecutiveHigh = intensity >= config.highIntensity ? consecutiveHigh + 1 : 0;
      if (consecutiveHigh > config.maxConsecutiveHigh) {
        warnings.push({
          code: 'consecutive_high', team, rowId: row.id, intensity,
          message: `צוות ${Number(team)} שובץ לשתי תחנות בעומס גבוה ללא הפוגה ביניהן.`
        });
      }
      if (windowLoad > config.maxWindowLoad) {
        warnings.push({
          code: 'rolling_load', team, rowId: row.id, intensity, windowLoad,
          message: `צוות ${Number(team)} מגיע לעומס מצטבר ${windowLoad} בחלון של ${config.windowMinutes} דקות.`
        });
      }
    });
  });
  return warnings.filter((warning, index, all) => all.findIndex(item =>
    item.code === warning.code && item.team === warning.team && item.rowId === warning.rowId) === index);
}
