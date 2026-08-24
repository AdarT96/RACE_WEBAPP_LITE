export const SCHEDULE_SCHEMA_VERSION = 1;
export const SCHEDULE_TIME_ZONE = 'Asia/Jerusalem';
export const SCHEDULE_MAX_TEAMS = 15;
export const SCHEDULE_MAX_ROWS = 100;

export const SCHEDULE_ROW_KINDS = Object.freeze({
  ROTATION: 'rotation',
  GLOBAL: 'global'
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STATION_PATTERN = /^\d{2}$/;
const ROW_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

const boundedText = (value, max) => String(value ?? '').trim().slice(0, max);
const uniqueStrings = values => [...new Set((Array.isArray(values) ? values : [])
  .map(value => String(value ?? '').trim()).filter(Boolean))];

export function padScheduleTeam(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 && numeric <= SCHEDULE_MAX_TEAMS
    ? String(numeric).padStart(2, '0') : '';
}

export function normalizeIntensity(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 3 ? numeric : 0;
}

export function isValidScheduleDate(value) {
  const text = String(value || '');
  if (!DATE_PATTERN.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function scheduleMinuteKey(date, startMinute) {
  if (!isValidScheduleDate(date)) return Number.NaN;
  const [year, month, day] = date.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 60000) + Number(startMinute);
}

export function formatScheduleTime(startMinute) {
  const minute = Math.max(0, Math.min(1439, Number(startMinute) || 0));
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export function parseScheduleTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    ? hour * 60 + minute : null;
}

export function localScheduleClock(now = new Date(), timeZone = SCHEDULE_TIME_ZONE) {
  const date = now instanceof Date ? now : new Date(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const part = type => parts.find(item => item.type === type)?.value || '';
  const dateKey = `${part('year')}-${part('month')}-${part('day')}`;
  return { date: dateKey, startMinute: Number(part('hour')) * 60 + Number(part('minute')) };
}

function normalizeAssignment(value) {
  const source = value && typeof value === 'object' ? value : {};
  const stationId = boundedText(source.stationId, 2);
  return {
    stationId: STATION_PATTERN.test(stationId) ? stationId : '',
    routeNumber: boundedText(source.routeNumber, 20)
  };
}

function normalizeRow(row, teamIds, index) {
  const source = row && typeof row === 'object' ? row : {};
  const kind = source.kind === SCHEDULE_ROW_KINDS.GLOBAL
    ? SCHEDULE_ROW_KINDS.GLOBAL : SCHEDULE_ROW_KINDS.ROTATION;
  const assignments = {};
  if (kind === SCHEDULE_ROW_KINDS.ROTATION) {
    teamIds.forEach(team => { assignments[team] = normalizeAssignment(source.assignments?.[team]); });
  }
  return {
    id: ROW_ID_PATTERN.test(String(source.id || '')) ? String(source.id) : `row-${index + 1}`,
    date: boundedText(source.date, 10),
    startMinute: Number.isInteger(Number(source.startMinute)) ? Number(source.startMinute) : -1,
    kind,
    label: kind === SCHEDULE_ROW_KINDS.GLOBAL ? boundedText(source.label, 160) : '',
    assignments
  };
}

export function sortScheduleRows(rows) {
  return (Array.isArray(rows) ? rows : []).slice().sort((left, right) => {
    const leftKey = scheduleMinuteKey(left.date, left.startMinute);
    const rightKey = scheduleMinuteKey(right.date, right.startMinute);
    if (Number.isFinite(leftKey) && Number.isFinite(rightKey) && leftKey !== rightKey) return leftKey - rightKey;
    if (left.date !== right.date) return String(left.date).localeCompare(String(right.date));
    if (left.startMinute !== right.startMinute) return Number(left.startMinute) - Number(right.startMinute);
    return String(left.id).localeCompare(String(right.id));
  });
}

export function normalizeSchedule(source, fallbackTeamIds = []) {
  const value = source && typeof source === 'object' ? source : {};
  const teamIds = uniqueStrings(value.teamIds?.length ? value.teamIds : fallbackTeamIds)
    .map(padScheduleTeam).filter(Boolean).sort((a, b) => Number(a) - Number(b));
  const commanderNames = {};
  teamIds.forEach(team => { commanderNames[team] = boundedText(value.commanderNames?.[team], 80); });
  return {
    teamIds,
    commanderNames,
    rows: sortScheduleRows((Array.isArray(value.rows) ? value.rows : [])
      .map((row, index) => normalizeRow(row, teamIds, index))),
    revision: Math.max(0, Number.isInteger(Number(value.revision)) ? Number(value.revision) : 0),
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    timeZone: SCHEDULE_TIME_ZONE
  };
}

export function scheduleIssues(schedule, { stationIdsByTeam = {} } = {}) {
  const rawTeamIds = Array.isArray(schedule?.teamIds) ? schedule.teamIds : [];
  const rawRows = Array.isArray(schedule?.rows) ? schedule.rows : [];
  const normalized = normalizeSchedule(schedule, schedule?.teamIds);
  const issues = [];
  if (!normalized.teamIds.length) issues.push('אין צוותים באירוע.');
  if (rawTeamIds.length > SCHEDULE_MAX_TEAMS) issues.push(`ניתן לשמור עד ${SCHEDULE_MAX_TEAMS} צוותים.`);
  const normalizedRawTeams = rawTeamIds.map(padScheduleTeam);
  if (normalizedRawTeams.some(team => !team)) issues.push('קיים מספר צוות שאינו תקין.');
  if (normalizedRawTeams.filter(Boolean).length !== new Set(normalizedRawTeams.filter(Boolean)).size) {
    issues.push('אותו צוות מופיע יותר מפעם אחת בלו״ז.');
  }
  if (rawRows.length > SCHEDULE_MAX_ROWS) {
    issues.push(`ניתן לשמור עד ${SCHEDULE_MAX_ROWS} שורות בלו״ז.`);
  }
  rawRows.forEach((row, index) => {
    if (!ROW_ID_PATTERN.test(String(row?.id || ''))) {
      issues.push(`שורה ${index + 1}: מזהה השורה אינו תקין.`);
    }
  });
  const rowIds = new Set();
  const rowTimes = new Set();
  normalized.rows.forEach((row, index) => {
    const line = index + 1;
    if (!isValidScheduleDate(row.date)) issues.push(`שורה ${line}: התאריך אינו תקין.`);
    if (!Number.isInteger(row.startMinute) || row.startMinute < 0 || row.startMinute > 1439) {
      issues.push(`שורה ${line}: השעה אינה תקינה.`);
    }
    if (rowIds.has(row.id)) issues.push(`שורה ${line}: מזהה השורה כפול.`);
    rowIds.add(row.id);
    const timeKey = `${row.date}/${row.startMinute}`;
    if (rowTimes.has(timeKey)) issues.push(`שורה ${line}: כבר קיימת שורה באותה שעה.`);
    rowTimes.add(timeKey);
    if (row.kind === SCHEDULE_ROW_KINDS.GLOBAL && !row.label) {
      issues.push(`שורה ${line}: יש להזין שם לפעילות המשותפת.`);
    }
    if (row.kind === SCHEDULE_ROW_KINDS.ROTATION) {
      normalized.teamIds.forEach(team => {
        const stationId = row.assignments[team]?.stationId || '';
        if (!stationId) return;
        const allowed = Array.isArray(stationIdsByTeam[team]) ? stationIdsByTeam[team] : null;
        if (allowed && !allowed.includes(stationId)) {
          issues.push(`שורה ${line}: תחנה ${stationId} אינה קיימת בצוות ${Number(team)}.`);
        }
      });
    }
  });
  return [...new Set(issues)];
}

export function buildTeamScheduleProjection(schedule, teamValue) {
  const normalized = normalizeSchedule(schedule, schedule?.teamIds);
  const team = padScheduleTeam(teamValue);
  if (!team || !normalized.teamIds.includes(team)) throw new Error('הצוות אינו קיים בלו״ז.');
  return {
    team,
    commanderName: normalized.commanderNames[team] || '',
    entries: normalized.rows.map(row => ({
      id: row.id,
      date: row.date,
      startMinute: row.startMinute,
      kind: row.kind,
      label: row.kind === SCHEDULE_ROW_KINDS.GLOBAL ? row.label : '',
      stationId: row.kind === SCHEDULE_ROW_KINDS.ROTATION
        ? row.assignments[team]?.stationId || '' : '',
      routeNumber: row.kind === SCHEDULE_ROW_KINDS.ROTATION
        ? row.assignments[team]?.routeNumber || '' : ''
    })),
    sourceRevision: normalized.revision,
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    timeZone: SCHEDULE_TIME_ZONE
  };
}

export function scheduleEntryAt(entries, now = new Date(), timeZone = SCHEDULE_TIME_ZONE) {
  const rows = sortScheduleRows(entries);
  if (!rows.length) return null;
  const clock = localScheduleClock(now, timeZone);
  const nowKey = scheduleMinuteKey(clock.date, clock.startMinute);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const start = scheduleMinuteKey(rows[index].date, rows[index].startMinute);
    if (!Number.isFinite(start) || start > nowKey) continue;
    const next = rows[index + 1];
    const nextStart = next ? scheduleMinuteKey(next.date, next.startMinute) : Number.POSITIVE_INFINITY;
    const sameLocalDay = rows[index].date === clock.date;
    if (sameLocalDay && nowKey < nextStart) return rows[index];
    return null;
  }
  return null;
}

export function recommendedStationFromProjection(projection, now = new Date()) {
  const entries = sortScheduleRows(projection?.entries);
  if (!entries.length) return null;
  const timeZone = projection?.timeZone || SCHEDULE_TIME_ZONE;
  const clock = localScheduleClock(now, timeZone);
  const nowKey = scheduleMinuteKey(clock.date, clock.startMinute);
  const current = scheduleEntryAt(entries, now, timeZone);
  if (current?.kind === SCHEDULE_ROW_KINDS.ROTATION && current.stationId) {
    return { stationId: current.stationId, entry: current, source: 'current' };
  }
  const next = entries.find(entry => entry.kind === SCHEDULE_ROW_KINDS.ROTATION && entry.stationId &&
    scheduleMinuteKey(entry.date, entry.startMinute) > nowKey);
  if (next) return { stationId: next.stationId, entry: next, source: 'next' };
  const previous = entries.slice().reverse().find(entry => entry.kind === SCHEDULE_ROW_KINDS.ROTATION && entry.stationId &&
    scheduleMinuteKey(entry.date, entry.startMinute) <= nowKey);
  return previous ? { stationId: previous.stationId, entry: previous, source: 'previous' } : null;
}
