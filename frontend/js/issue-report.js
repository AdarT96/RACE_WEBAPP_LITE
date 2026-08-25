import { DEFAULT_SESSION_LIMIT_SECONDS } from './session-policy.js';

export const ISSUE_REPORT_CATEGORIES = Object.freeze([
  'timing',
  'arrival_order',
  'saving',
  'display',
  'other'
]);

export const ISSUE_REPORT_MAX_DESCRIPTION = 2000;
export const ISSUE_REPORT_MAX_STEPS = 2000;
export const ISSUE_REPORT_SCHEMA_VERSION = 2;

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function cleanContext(value) {
  return cleanText(value, 200);
}

export function buildIssueReportData({ draft, reporter, context, environment, eventId }) {
  const category = String(draft?.category ?? 'other');
  const description = cleanText(draft?.description, ISSUE_REPORT_MAX_DESCRIPTION);
  const steps = cleanText(draft?.steps, ISSUE_REPORT_MAX_STEPS);
  const reporterTeam = Number(reporter?.team);
  const reporterUid = cleanText(reporter?.uid, 128);
  const reporterRole = cleanText(reporter?.role, 32);
  const formationEventId = cleanText(eventId, 128);

  if (!ISSUE_REPORT_CATEGORIES.includes(category)) {
    throw new Error('יש לבחור סוג תקלה תקין');
  }
  if (!description) {
    throw new Error('יש לתאר מה קרה');
  }
  if (!reporterUid || !['operator', 'evaluator', 'admin'].includes(reporterRole)) {
    throw new Error('זהות המדווח אינה זמינה');
  }
  if (!Number.isInteger(reporterTeam) || reporterTeam < 1 || reporterTeam > 15) {
    throw new Error('לא ניתן לשלוח דיווח בלי צוות מזוהה');
  }
  if (!formationEventId) {
    throw new Error('לא ניתן לשלוח דיווח בלי אירוע גיבוש פעיל');
  }

  return {
    eventId: formationEventId,
    reporterUid,
    reporterName: cleanText(reporter?.name, 200),
    reporterRole,
    reporterTeam,
    category,
    description,
    steps,
    status: 'open',
    adminNote: '',
    context: {
      team: cleanContext(context?.team),
      station: cleanContext(context?.station),
      stationType: cleanContext(context?.stationType),
      stationName: cleanContext(context?.stationName),
      viewedRaceId: cleanContext(context?.viewedRaceId),
      latestRaceId: cleanContext(context?.latestRaceId),
      round: Math.max(0, Math.floor(Number(context?.round) || 0)),
      raceStatus: cleanContext(context?.raceStatus),
      effectiveElapsedMs: Math.min(
        DEFAULT_SESSION_LIMIT_SECONDS * 1000,
        Math.max(0, Math.floor(Number(context?.effectiveElapsedMs) || 0))
      ),
      historicalView: Boolean(context?.historicalView)
    },
    environment: {
      appVersion: cleanText(environment?.appVersion, 100),
      online: Boolean(environment?.online),
      viewport: cleanText(environment?.viewport, 50),
      userAgent: cleanText(environment?.userAgent, 500)
    },
    schemaVersion: ISSUE_REPORT_SCHEMA_VERSION
  };
}
