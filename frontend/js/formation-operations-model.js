export const FORMATION_EVENT_SCHEMA_VERSION = 3;
export const TEAM_ROSTER_SCHEMA_VERSION = 3;
export const CANDIDATE_SCHEMA_VERSION = 3;
export const RECOMMENDATION_SCHEMA_VERSION = 1;
export const STATUS_EVENT_SCHEMA_VERSION = 1;

export const CANDIDATE_STATUSES = Object.freeze({
  ACTIVE: 'active',
  WITHDRAWN: 'withdrawn'
});

export const CLEARANCE_STATUSES = Object.freeze({
  PENDING: 0,
  FIT: 1,
  UNFIT: 2
});

export const CLEARANCE_LABELS = Object.freeze({
  [CLEARANCE_STATUSES.PENDING]: 'טרם נבדק',
  [CLEARANCE_STATUSES.FIT]: 'כשיר',
  [CLEARANCE_STATUSES.UNFIT]: 'לא כשיר'
});

export const CANDIDATE_PROFILE_DEFAULTS = Object.freeze({
  participantId: '0',
  firstName: '0',
  nationalId: '0',
  emergencyContactPhone: '0',
  doctorClearance: CLEARANCE_STATUSES.PENDING,
  medicClearance: CLEARANCE_STATUSES.PENDING
});

export const DROPOUT_REASONS = Object.freeze({
  voluntary: 'פרישה',
  medical: 'רפואי',
  dismissal: 'הדחה'
});

export const RECOMMENDATION_STATUSES = Object.freeze({
  OPEN: 'open',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled'
});

export function padTeam(value) {
  const number = Number.parseInt(String(value ?? '').replace(/\D+/g, ''), 10);
  return Number.isInteger(number) && number > 0 ? String(number).padStart(2, '0') : '';
}

export function normalizeParticipantId(value) {
  return String(value ?? '').trim();
}

export function normalizeFirstName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

export function normalizeNationalId(value) {
  return String(value ?? '').replace(/\D+/g, '');
}

export function normalizeEmergencyContactPhone(value) {
  return String(value ?? '').replace(/\D+/g, '');
}

export function isValidEmergencyContactPhone(value) {
  return /^\d{9,15}$/.test(normalizeEmergencyContactPhone(value));
}

export function normalizeClearanceStatus(value) {
  const status = Number(value);
  return Object.values(CLEARANCE_STATUSES).includes(status)
    ? status : CLEARANCE_STATUSES.PENDING;
}

export function clearanceStatusLabel(value) {
  return CLEARANCE_LABELS[normalizeClearanceStatus(value)];
}

export function isValidIsraeliNationalId(value) {
  const nationalId = normalizeNationalId(value);
  if (!/^\d{9}$/.test(nationalId)) return false;
  const sum = [...nationalId].reduce((total, digit, index) => {
    let product = Number(digit) * (index % 2 === 0 ? 1 : 2);
    if (product > 9) product -= 9;
    return total + product;
  }, 0);
  return sum % 10 === 0;
}

export function candidateKey(team, participantId) {
  const normalizedTeam = padTeam(team);
  const normalizedParticipant = normalizeParticipantId(participantId);
  if (!normalizedTeam || !normalizedParticipant) throw new Error('חסר צוות או מספר מועמד');
  return `${normalizedTeam}_${normalizedParticipant}`;
}

export function normalizeParticipantIds(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).reduce((result, value) => {
    const id = normalizeParticipantId(value);
    if (id && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
    return result;
  }, []);
}

export function normalizeCandidateProfile(value, fallback = {}) {
  const profile = value && typeof value === 'object' ? value : {};
  return {
    participantId: normalizeParticipantId(profile.participantId ?? fallback.participantId) || CANDIDATE_PROFILE_DEFAULTS.participantId,
    firstName: normalizeFirstName(profile.firstName ?? fallback.firstName) || CANDIDATE_PROFILE_DEFAULTS.firstName,
    nationalId: normalizeNationalId(profile.nationalId ?? fallback.nationalId) || CANDIDATE_PROFILE_DEFAULTS.nationalId,
    emergencyContactPhone: normalizeEmergencyContactPhone(
      profile.emergencyContactPhone ?? fallback.emergencyContactPhone
    ) || CANDIDATE_PROFILE_DEFAULTS.emergencyContactPhone,
    doctorClearance: normalizeClearanceStatus(profile.doctorClearance ?? fallback.doctorClearance),
    medicClearance: normalizeClearanceStatus(profile.medicClearance ?? fallback.medicClearance)
  };
}

export function normalizeCandidateRoster(teamData) {
  const data = teamData && typeof teamData === 'object' ? teamData : {};
  const rawCandidates = Array.isArray(data.candidates) ? data.candidates : [];
  const byParticipant = new Map();
  rawCandidates.forEach(value => {
    const profile = normalizeCandidateProfile(value);
    if (profile.participantId && !byParticipant.has(profile.participantId)) {
      byParticipant.set(profile.participantId, profile);
    }
  });

  normalizeParticipantIds(data.participants || data.participantIds).forEach(participantId => {
    if (!byParticipant.has(participantId)) {
      byParticipant.set(participantId, normalizeCandidateProfile(null, { participantId }));
    }
  });

  return [...byParticipant.values()];
}

export function candidateRosterIssues(values, { requireIdentity = true, maxCandidates = 20 } = {}) {
  const candidates = (Array.isArray(values) ? values : []).map(normalizeCandidateProfile);
  const issues = [];
  const participantIds = new Set();
  const nationalIds = new Set();

  if (candidates.length > maxCandidates) issues.push(`מותר לשייך עד ${maxCandidates} מועמדים לצוות`);
  candidates.forEach((candidate, index) => {
    const row = index + 1;
    if (!candidate.participantId || candidate.participantId === CANDIDATE_PROFILE_DEFAULTS.participantId) issues.push(`בשורה ${row} חסר מספר מועמד`);
    else if (!/^\d+$/.test(candidate.participantId)) issues.push(`מספר המועמד בשורה ${row} חייב להכיל ספרות בלבד`);
    else if (candidate.participantId.length > 100) issues.push(`מספר המועמד בשורה ${row} ארוך מדי`);
    else if (participantIds.has(candidate.participantId)) issues.push(`מספר המועמד ${candidate.participantId} מופיע יותר מפעם אחת`);
    else participantIds.add(candidate.participantId);

    if (!requireIdentity) return;
    if (!candidate.firstName || candidate.firstName === CANDIDATE_PROFILE_DEFAULTS.firstName) issues.push(`למועמד ${candidate.participantId || `בשורה ${row}`} חסר שם פרטי`);
    if (!isValidIsraeliNationalId(candidate.nationalId)) {
      issues.push(`תעודת הזהות של מועמד ${candidate.participantId || `בשורה ${row}`} אינה תקינה`);
    } else if (nationalIds.has(candidate.nationalId)) {
      issues.push(`תעודת הזהות ${candidate.nationalId} מופיעה יותר מפעם אחת בצוות`);
    } else nationalIds.add(candidate.nationalId);
    if (!isValidEmergencyContactPhone(candidate.emergencyContactPhone)) {
      issues.push(`מספר איש הקשר לחירום של מועמד ${candidate.participantId || `בשורה ${row}`} אינו תקין`);
    }
  });
  return [...new Set(issues)];
}

export function isDropoutReason(value) {
  return Object.prototype.hasOwnProperty.call(DROPOUT_REASONS, String(value || ''));
}

export function dropoutReasonLabel(value) {
  return DROPOUT_REASONS[String(value || '')] || '';
}

export function normalizeCandidateRecord(value, fallback = {}) {
  const record = value && typeof value === 'object' ? value : {};
  const profile = normalizeCandidateProfile(record, fallback);
  const status = Object.values(CANDIDATE_STATUSES).includes(record.status)
    ? record.status : CANDIDATE_STATUSES.ACTIVE;
  const reasonCode = status === CANDIDATE_STATUSES.WITHDRAWN && isDropoutReason(record.reasonCode)
    ? String(record.reasonCode) : '';
  return {
    ...profile,
    team: padTeam(record.team || fallback.team),
    status,
    reasonCode,
    reasonLabel: reasonCode ? dropoutReasonLabel(reasonCode) : '',
    statusRevision: Math.max(0, Math.floor(Number(record.statusRevision ?? record.revision) || 0)),
    profileRevision: Math.max(0, Math.floor(Number(record.profileRevision) || 0)),
    lastTransitionId: String(record.lastTransitionId || ''),
    statusChangedAt: record.statusChangedAt ?? null,
    statusChangedBy: String(record.statusChangedBy || ''),
    profileUpdatedAt: record.profileUpdatedAt ?? null,
    profileUpdatedBy: String(record.profileUpdatedBy || '')
  };
}

export function normalizeRecommendation(value) {
  const recommendation = value && typeof value === 'object' ? value : {};
  const status = Object.values(RECOMMENDATION_STATUSES).includes(recommendation.status)
    ? recommendation.status : RECOMMENDATION_STATUSES.OPEN;
  return {
    participantId: normalizeParticipantId(recommendation.participantId),
    team: padTeam(recommendation.team),
    reasonCode: isDropoutReason(recommendation.reasonCode) ? String(recommendation.reasonCode) : '',
    details: String(recommendation.details || '').trim().slice(0, 1000),
    status,
    recommendedBy: String(recommendation.recommendedBy || ''),
    recommendedByName: String(recommendation.recommendedByName || ''),
    revision: Math.max(0, Math.floor(Number(recommendation.revision) || 0)),
    createdAt: recommendation.createdAt ?? null,
    updatedAt: recommendation.updatedAt ?? null,
    resolvedAt: recommendation.resolvedAt ?? null,
    resolvedBy: String(recommendation.resolvedBy || '')
  };
}

export function activeParticipantIds(teamData, candidates = []) {
  const team = padTeam(teamData?.teamNumber || teamData?.id);
  const records = new Map((Array.isArray(candidates) ? candidates : [])
    .map(value => normalizeCandidateRecord(value))
    .filter(value => value.team === team)
    .map(value => [value.participantId, value]));
  const participantIds = normalizeParticipantIds(teamData?.participantIds || teamData?.participants ||
    normalizeCandidateRoster(teamData).map(candidate => candidate.participantId));
  return participantIds.filter(participantId =>
    records.get(participantId)?.status !== CANDIDATE_STATUSES.WITHDRAWN);
}

function timestampMs(value) {
  if (typeof value?.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function raceActivityMs(race) {
  return timestampMs(race?.endedAt) ?? timestampMs(race?.startedAt) ?? 0;
}

function stationSnapshotForTeam(team, races, nowMs, isRaceRunning) {
  const teamRaces = races.filter(race => padTeam(race.team) === team);
  const sorted = teamRaces.slice().sort((a, b) => raceActivityMs(b) - raceActivityMs(a));
  const running = sorted.filter(race => isRaceRunning(race, nowMs));
  const current = running[0] || sorted[0] || null;
  return {
    activeRaceCount: running.length,
    currentRace: current,
    station: String(current?.station || ''),
    round: Math.max(0, Math.floor(Number(current?.round) || 0)),
    raceStatus: running.length ? 'running' : current ? 'stopped' : 'not_started',
    lastActivityAt: current ? raceActivityMs(current) : null,
    hasConcurrentRaces: running.length > 1,
    stationIdsVisited: [...new Set(teamRaces.map(race => String(race.station || '')).filter(Boolean))]
  };
}

export function buildFormationDashboardSnapshot({
  event = null,
  teams = [],
  candidates = [],
  recommendations = [],
  races = [],
  nowMs = Date.now(),
  isRaceRunning = race => race?.status === 'running'
} = {}) {
  const normalizedCandidates = (Array.isArray(candidates) ? candidates : [])
    .map(value => normalizeCandidateRecord(value));
  const candidateByKey = new Map(normalizedCandidates
    .filter(candidate => candidate.team && candidate.participantId)
    .map(candidate => [candidateKey(candidate.team, candidate.participantId), candidate]));
  const normalizedRecommendations = (Array.isArray(recommendations) ? recommendations : [])
    .map(normalizeRecommendation);
  const openRecommendationKeys = new Set(normalizedRecommendations
    .filter(item => item.status === RECOMMENDATION_STATUSES.OPEN)
    .map(item => candidateKey(item.team, item.participantId)));

  const teamRows = (Array.isArray(teams) ? teams : []).map(source => {
    const team = padTeam(source.teamNumber || source.id);
    const participantIds = normalizeParticipantIds(source.participantIds || source.participants);
    const teamCandidates = participantIds.map(participantId => {
      const record = candidateByKey.get(candidateKey(team, participantId)) ||
        normalizeCandidateRecord(null, { team, participantId });
      return {
        ...record,
        hasOpenRecommendation: openRecommendationKeys.has(candidateKey(team, participantId))
      };
    });
    const active = teamCandidates.filter(candidate => candidate.status === CANDIDATE_STATUSES.ACTIVE).length;
    const withdrawn = teamCandidates.filter(candidate => candidate.status === CANDIDATE_STATUSES.WITHDRAWN).length;
    const station = stationSnapshotForTeam(team, races, nowMs, isRaceRunning);
    return {
      team,
      total: participantIds.length,
      active,
      withdrawn,
      candidates: teamCandidates,
      stationMap: source.stationMap && typeof source.stationMap === 'object' ? source.stationMap : {},
      ...station
    };
  }).sort((a, b) => Number(a.team) - Number(b.team));

  const reasonCounts = Object.fromEntries(Object.keys(DROPOUT_REASONS).map(reason => [reason, 0]));
  normalizedCandidates.forEach(candidate => {
    if (candidate.status === CANDIDATE_STATUSES.WITHDRAWN && reasonCounts[candidate.reasonCode] != null) {
      reasonCounts[candidate.reasonCode] += 1;
    }
  });

  return {
    event,
    totals: teamRows.reduce((totals, team) => ({
      candidates: totals.candidates + team.total,
      active: totals.active + team.active,
      withdrawn: totals.withdrawn + team.withdrawn,
      teamsRunning: totals.teamsRunning + (team.raceStatus === 'running' ? 1 : 0)
    }), { candidates: 0, active: 0, withdrawn: 0, teamsRunning: 0 }),
    reasonCounts,
    teams: teamRows,
    candidates: normalizedCandidates,
    openRecommendations: normalizedRecommendations
      .filter(item => item.status === RECOMMENDATION_STATUSES.OPEN)
      .map(item => ({
        ...item,
        candidate: candidateByKey.get(candidateKey(item.team, item.participantId)) ||
          normalizeCandidateRecord(null, { team: item.team, participantId: item.participantId })
      }))
      .sort((a, b) => (timestampMs(a.createdAt) || 0) - (timestampMs(b.createdAt) || 0)),
    anomalies: teamRows.flatMap(team => team.hasConcurrentRaces
      ? [`לצוות ${Number(team.team)} יש יותר מסבב פעיל אחד`] : [])
  };
}
