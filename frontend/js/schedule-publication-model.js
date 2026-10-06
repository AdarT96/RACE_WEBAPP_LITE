import { normalizeSchedule } from './schedule-model.js';

export const SCHEDULE_DRAFT_SCHEMA_VERSION = 1;

export const SCHEDULE_PUBLICATION_TYPES = Object.freeze({
  PUBLISH: 'publish',
  RESTORE: 'restore'
});

const REVISION_KEY_PATTERN = /^r-[0-9]{6,12}$/;

const nonNegativeInteger = value => Math.max(0, Math.floor(Number(value) || 0));

export function normalizeScheduleDraft(source, fallbackTeamIds = [], publishedRevision = 0) {
  const value = source && typeof source === 'object' ? source : {};
  return {
    ...normalizeSchedule(value, fallbackTeamIds),
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
