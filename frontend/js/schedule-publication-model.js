import { normalizeSchedule } from './schedule-model.js';

export const SCHEDULE_DRAFT_SCHEMA_VERSION = 1;

export const SCHEDULE_PUBLICATION_TYPES = Object.freeze({
  PUBLISH: 'publish',
  RESTORE: 'restore'
});

const REVISION_KEY_PATTERN = /^r-[0-9]{6,12}$/;

const boundedText = (value, maxLength) => String(value ?? '').trim().slice(0, maxLength);
const nonNegativeInteger = value => Math.max(0, Math.floor(Number(value) || 0));

export function normalizeScheduleWarnings(values) {
  return (Array.isArray(values) ? values : []).slice(0, 100).map(warning => ({
    code: boundedText(warning?.code, 50),
    team: boundedText(warning?.team, 2),
    rowId: boundedText(warning?.rowId, 80),
    message: boundedText(warning?.message, 300)
  }));
}

export function normalizeScheduleDraft(source, fallbackTeamIds = [], publishedRevision = 0) {
  const value = source && typeof source === 'object' ? source : {};
  return {
    ...normalizeSchedule(value, fallbackTeamIds),
    loadWarnings: normalizeScheduleWarnings(value.loadWarnings),
    overrideReason: boundedText(value.overrideReason, 500),
    baseRevision: nonNegativeInteger(value.baseRevision ?? publishedRevision),
    draftRevision: nonNegativeInteger(value.draftRevision),
    schemaVersion: SCHEDULE_DRAFT_SCHEMA_VERSION
  };
}

export function scheduleDraftConflictsWithPublished(draft, publishedRevision) {
  return nonNegativeInteger(draft?.baseRevision) !== nonNegativeInteger(publishedRevision);
}

export function buildScheduleRelease(source, {
  publishedRevision = 0,
  publicationType = SCHEDULE_PUBLICATION_TYPES.PUBLISH,
  restoredFromRevisionKey = ''
} = {}) {
  const schedule = normalizeSchedule(source, source?.teamIds);
  const revision = nonNegativeInteger(publishedRevision) + 1;
  const revisionKey = `r-${String(revision).padStart(6, '0')}`;
  const type = publicationType === SCHEDULE_PUBLICATION_TYPES.RESTORE
    ? SCHEDULE_PUBLICATION_TYPES.RESTORE : SCHEDULE_PUBLICATION_TYPES.PUBLISH;
  const restoredFrom = type === SCHEDULE_PUBLICATION_TYPES.RESTORE &&
    REVISION_KEY_PATTERN.test(String(restoredFromRevisionKey || ''))
    ? String(restoredFromRevisionKey) : '';
  if (type === SCHEDULE_PUBLICATION_TYPES.RESTORE && !restoredFrom) {
    throw new Error('חסרה גרסת המקור לשחזור הלו״ז.');
  }
  return {
    ...schedule,
    loadWarnings: normalizeScheduleWarnings(source?.loadWarnings),
    overrideReason: boundedText(source?.overrideReason, 500),
    revision,
    revisionKey,
    publicationType: type,
    restoredFromRevisionKey: restoredFrom
  };
}

export function schedulePublicationLabel(value) {
  if (value?.publicationType === SCHEDULE_PUBLICATION_TYPES.RESTORE) {
    const source = String(value.restoredFromRevisionKey || '').replace(/^r-0*/, '') || '—';
    return `שחזור מגרסה ${source}`;
  }
  return 'פרסום';
}
