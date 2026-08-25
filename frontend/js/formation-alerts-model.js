import { scheduleEntryAt } from './schedule-model.js';
import { isSessionExpired } from './session-policy.js';

export const FORMATION_ALERT_SEVERITIES = Object.freeze({
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info'
});

const severityOrder = Object.freeze({ critical: 0, warning: 1, info: 2 });
const missingProfileFields = candidate => [
  candidate?.firstName,
  candidate?.nationalId,
  candidate?.emergencyContactPhone
].some(value => !String(value || '').trim() || String(value) === '0');

function uniqueBy(values, keyOf) {
  const seen = new Set();
  return values.filter(value => {
    const key = keyOf(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function buildFormationAlerts({
  dashboard = null,
  races = [],
  publishedSchedule = null,
  issueReports = [],
  now = new Date()
} = {}) {
  const alerts = [];
  const teams = Array.isArray(dashboard?.teams) ? dashboard.teams : [];

  teams.filter(team => team.hasConcurrentRaces).forEach(team => alerts.push({
    id: `concurrent-${team.team}`,
    code: 'concurrent_races',
    severity: FORMATION_ALERT_SEVERITIES.CRITICAL,
    title: `לצוות ${Number(team.team)} יש כמה סבבים פעילים`,
    detail: `${team.activeRaceCount} סבבים מסומנים כפעילים במקביל.`
  }));

  uniqueBy((Array.isArray(races) ? races : []).filter(race => isSessionExpired(race, now.getTime())),
    race => `${race.team}/${race.station}`).forEach(race => alerts.push({
      id: `expired-${race.team}-${race.station}`,
      code: 'expired_session',
      severity: FORMATION_ALERT_SEVERITIES.WARNING,
      title: `סבב של צוות ${Number(race.team)} הגיע לתקרת הזמן`,
      detail: `תחנה ${Number(race.station)} מוצגת תפעולית כהסתיימה, אך טרם נשמרה עצירה סופית.`
    }));

  const currentScheduleRow = scheduleEntryAt(publishedSchedule?.rows, now, publishedSchedule?.timeZone);
  if (currentScheduleRow?.kind === 'rotation') {
    teams.filter(team => !currentScheduleRow.assignments?.[team.team]?.stationId).forEach(team => alerts.push({
      id: `missing-assignment-${currentScheduleRow.id}-${team.team}`,
      code: 'missing_schedule_assignment',
      severity: FORMATION_ALERT_SEVERITIES.WARNING,
      title: `צוות ${Number(team.team)} ללא שיבוץ בלו״ז הנוכחי`,
      detail: 'יש לעדכן ולפרסם את משבצת התחנה בלו״ז.'
    }));
  }

  const incompleteCandidates = uniqueBy(teams.flatMap(team => team.candidates || [])
    .filter(missingProfileFields), candidate => `${candidate.team}/${candidate.participantId}`);
  if (incompleteCandidates.length) alerts.push({
    id: 'incomplete-candidate-profiles',
    code: 'incomplete_candidate_profiles',
    severity: FORMATION_ALERT_SEVERITIES.INFO,
    title: `${incompleteCandidates.length} מועמדים עם פרטים חסרים`,
    detail: 'חסרים שם, תעודת זהות או מספר איש קשר לחירום.'
  });

  const openRecommendations = Array.isArray(dashboard?.openRecommendations)
    ? dashboard.openRecommendations.length : 0;
  if (openRecommendations) alerts.push({
    id: 'open-dropout-recommendations',
    code: 'open_dropout_recommendations',
    severity: FORMATION_ALERT_SEVERITIES.WARNING,
    title: `${openRecommendations} המלצות נשירה ממתינות`,
    detail: 'נדרשת החלטה של מפקד הגיבוש.'
  });

  const openIssues = (Array.isArray(issueReports) ? issueReports : [])
    .filter(report => report?.status !== 'resolved');
  if (openIssues.length) alerts.push({
    id: 'open-issue-reports',
    code: 'open_issue_reports',
    severity: FORMATION_ALERT_SEVERITIES.INFO,
    title: `${openIssues.length} דיווחי תקלה פתוחים`,
    detail: 'הדיווחים זמינים למעקב תפעולי; הטיפול בהם נשאר בידי המנהל.'
  });

  return alerts.sort((left, right) =>
    severityOrder[left.severity] - severityOrder[right.severity] || left.title.localeCompare(right.title, 'he'));
}
