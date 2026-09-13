import {
  SCHEDULE_ROW_KINDS, normalizeSchedule, padScheduleTeam, parseScheduleTime
} from './schedule-model.js';

export const SCHEDULE_IMPORT_SCHEMA_VERSION = 1;

const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const normalizedHeader = value => clean(value).toLowerCase().replace(/["״׳']/g, '');
const TEAM_HEADER = /^(?:צוות|team)\s*(\d{1,2})$/i;

const HEADER_ALIASES = Object.freeze({
  date:['תאריך', 'date'],
  time:['שעה', 'time'],
  kind:['סוג', 'type', 'kind'],
  label:['פעילות', 'תיאור', 'activity', 'label']
});

function columnFor(headers, aliases) {
  const normalizedAliases = aliases.map(normalizedHeader);
  return headers.findIndex(header => normalizedAliases.includes(normalizedHeader(header)));
}

function dateFromCell(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  const text = clean(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  return match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : text;
}

function minuteFromCell(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getHours() * 60 + value.getMinutes();
  if (typeof value === 'number' && value >= 0 && value < 1) return Math.round(value * 24 * 60);
  return parseScheduleTime(clean(value));
}

function rowKind(value, label) {
  const text = normalizedHeader(value);
  if (['משותף', 'כללי', 'global'].includes(text)) return SCHEDULE_ROW_KINDS.GLOBAL;
  if (['תחנות', 'תחנה', 'rotation'].includes(text)) return SCHEDULE_ROW_KINDS.ROTATION;
  return label ? SCHEDULE_ROW_KINDS.GLOBAL : SCHEDULE_ROW_KINDS.ROTATION;
}

function stationLookup(catalog = []) {
  const result = new Map();
  (Array.isArray(catalog) ? catalog : []).forEach(station => {
    const stationId = clean(station?.id).padStart(2, '0');
    [stationId, station?.name, ...(Array.isArray(station?.aliases) ? station.aliases : [])]
      .map(normalizedHeader).filter(Boolean).forEach(key => result.set(key, stationId));
  });
  return result;
}

function parseAssignment(value, lookup) {
  const text = clean(value);
  if (!text || text === '-' || text === '—') return { stationId:'', routeNumber:'' };
  const parts = text.split('|').map(clean);
  const stationId = lookup.get(normalizedHeader(parts[0])) || '';
  return { stationId, routeNumber:parts.slice(1).join(' | ').slice(0, 20) };
}

export function buildScheduleImport({ matrix = [], stationCatalogByTeam = {}, commanderNames = {} } = {}) {
  const rows = Array.isArray(matrix) ? matrix.filter(Array.isArray) : [];
  const headers = rows[0] || [];
  const errors = [];
  const dateColumn = columnFor(headers, HEADER_ALIASES.date);
  const timeColumn = columnFor(headers, HEADER_ALIASES.time);
  const kindColumn = columnFor(headers, HEADER_ALIASES.kind);
  const labelColumn = columnFor(headers, HEADER_ALIASES.label);
  if (dateColumn < 0) errors.push('חסרה עמודת "תאריך".');
  if (timeColumn < 0) errors.push('חסרה עמודת "שעה".');
  const teamColumns = headers.map((header, index) => {
    const match = clean(header).match(TEAM_HEADER);
    return match ? { index, team:padScheduleTeam(match[1]) } : null;
  }).filter(item => item?.team);
  if (!teamColumns.length) errors.push('לא נמצאו עמודות צוותים (למשל: "צוות 1").');
  if (new Set(teamColumns.map(item => item.team)).size !== teamColumns.length) {
    errors.push('אותו צוות מופיע ביותר מעמודה אחת.');
  }

  const scheduleRows = [];
  rows.slice(1).forEach((source, offset) => {
    if (!source.some(value => clean(value))) return;
    const line = offset + 2;
    const date = dateFromCell(source[dateColumn]);
    const startMinute = minuteFromCell(source[timeColumn]);
    const label = labelColumn >= 0 ? clean(source[labelColumn]) : '';
    const kind = rowKind(kindColumn >= 0 ? source[kindColumn] : '', label);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errors.push(`שורה ${line}: התאריך אינו תקין.`);
    if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute > 1439) errors.push(`שורה ${line}: השעה אינה תקינה.`);
    const assignments = {};
    if (kind === SCHEDULE_ROW_KINDS.GLOBAL) {
      if (!label) errors.push(`שורה ${line}: חסר שם לפעילות המשותפת.`);
    } else {
      teamColumns.forEach(({ index, team }) => {
        const raw = clean(source[index]);
        const assignment = parseAssignment(raw, stationLookup(stationCatalogByTeam[team]));
        if (raw && !assignment.stationId) errors.push(`שורה ${line}, צוות ${Number(team)}: התחנה "${raw.split('|')[0].trim()}" אינה מוכרת.`);
        assignments[team] = assignment;
      });
    }
    scheduleRows.push({
      id:`import-${String(line).padStart(3, '0')}`,
      date, startMinute:Number.isInteger(startMinute) ? startMinute : -1,
      kind, label:kind === SCHEDULE_ROW_KINDS.GLOBAL ? label : '', assignments
    });
  });

  const teamIds = teamColumns.map(item => item.team);
  const names = Object.fromEntries(teamIds.map(team => [team, clean(commanderNames[team]).slice(0, 80)]));
  return {
    schedule:normalizeSchedule({ teamIds, commanderNames:names, rows:scheduleRows }, teamIds),
    errors:[...new Set(errors)],
    schemaVersion:SCHEDULE_IMPORT_SCHEMA_VERSION
  };
}

export function scheduleImportTemplateCsv(teamValues = [1]) {
  const teamIds = [...new Set(teamValues.map(padScheduleTeam).filter(Boolean))];
  const header = ['תאריך', 'שעה', 'סוג', 'פעילות', ...teamIds.map(team => `צוות ${Number(team)}`)];
  const exampleDate = new Date().toISOString().slice(0, 10);
  const rows = [
    header,
    [exampleDate, '03:00', 'משותף', 'חימום', ...teamIds.map(() => '')],
    [exampleDate, '03:10', 'תחנות', '', ...teamIds.map(() => 'ספרינטים | 1')]
  ];
  return `\uFEFF${rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n')}`;
}
