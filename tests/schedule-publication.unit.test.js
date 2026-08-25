import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULE_PUBLICATION_TYPES, buildScheduleRelease, normalizeScheduleDraft,
  scheduleDraftConflictsWithPublished, schedulePublicationLabel
} from '../frontend/js/schedule-publication-model.js';

const schedule = {
  teamIds:['01'], commanderNames:{ '01':'נועה' },
  rows:[{ id:'row-1', date:'2026-08-24', startMinute:180, kind:'rotation', assignments:{
    '01':{ stationId:'04', routeNumber:'2' }
  }}]
};

test('a saved draft remains separate from the published revision it is based on', () => {
  const draft = normalizeScheduleDraft({ ...schedule, baseRevision:4, draftRevision:7 }, [], 4);
  assert.equal(draft.baseRevision, 4);
  assert.equal(draft.draftRevision, 7);
  assert.equal(scheduleDraftConflictsWithPublished(draft, 4), false);
  assert.equal(scheduleDraftConflictsWithPublished(draft, 5), true);
});

test('publishing always creates the next immutable revision', () => {
  const release = buildScheduleRelease(schedule, { publishedRevision:4 });
  assert.equal(release.revision, 5);
  assert.equal(release.revisionKey, 'r-000005');
  assert.equal(release.publicationType, SCHEDULE_PUBLICATION_TYPES.PUBLISH);
  assert.equal(release.restoredFromRevisionKey, '');
});

test('restoring history creates a new revision and never rewrites the source revision', () => {
  const release = buildScheduleRelease(schedule, {
    publishedRevision:8,
    publicationType:SCHEDULE_PUBLICATION_TYPES.RESTORE,
    restoredFromRevisionKey:'r-000003'
  });
  assert.equal(release.revision, 9);
  assert.equal(release.revisionKey, 'r-000009');
  assert.equal(release.restoredFromRevisionKey, 'r-000003');
  assert.equal(schedulePublicationLabel(release), 'שחזור מגרסה 3');
});

test('a restore cannot be created without a valid immutable source key', () => {
  assert.throws(() => buildScheduleRelease(schedule, {
    publicationType:SCHEDULE_PUBLICATION_TYPES.RESTORE,
    restoredFromRevisionKey:'draft'
  }), /גרסת המקור/);
});
