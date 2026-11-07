import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessmentEntryFor, buildCandidateSummary, buildLegacyAssessmentBuckets, mergeAssessmentEntries,
  normalizeRepTimes, normalizeScores, stationAssessmentEntry, stationAssessmentRace, stationNoteRaceId, traitIdFor
} from '../frontend/js/evaluation-model.js';

const evaluatorUid = 'evaluator-1';

function race(id, station, round, tags = []) {
  return {
    id, team: '01', station, round, status: 'stopped',
    participantIds: ['100'], tags
  };
}

function assessment(scores = {}, extra = {}) {
  return {
    evaluatorUid,
    entries: { '100': { scores, comments: [], measurement: null, ...extra } },
    schemaVersion: 2
  };
}

function stationTypeForRace(item) {
  return item.station === '01'
    ? { id: 'sprints', name: 'ספרינטים', measure: 'place', params: [{ id: 'resilience', name: 'חוסן וכושר הסתגלות' }] }
    : { id: 'discussion', name: 'דיון', measure: 'none', params: [{ id: 'resilience', name: 'חוסן וכושר הסתגלות' }] };
}

test('trait storage uses stable ids while accepting legacy Hebrew keys', () => {
  assert.equal(traitIdFor('חוסן וכושר הסתגלות'), 'resilience');
  assert.deepEqual(normalizeScores({ 'חוסן וכושר הסתגלות': 6, activity: 5 }), {
    resilience: 6, activity: 5
  });
});

test('candidate averages weight each station equally instead of overweighting rounds', () => {
  const races = [
    race('a1', '01', 1), race('a2', '01', 2), race('a3', '01', 3),
    race('b1', '02', 1)
  ];
  const assessmentsByRace = new Map([
    ['a1', assessment({ resilience: 7 })],
    ['a2', assessment({ resilience: 7 })],
    ['a3', assessment({ resilience: 7 })],
    ['b1', assessment({ resilience: 1 })]
  ]);
  const summary = buildCandidateSummary({
    participantId: '100', races, assessmentsByRace, evaluatorUid, stationTypeForRace
  });

  assert.equal(summary.stations[0].traitAverages.resilience, 7);
  assert.equal(summary.stations[1].traitAverages.resilience, 1);
  assert.equal(summary.traitAverages.resilience.value, 4);
  assert.equal(summary.traitAverages.resilience.stationCount, 2);
});

test('missing scores are omitted and never treated as zero', () => {
  const races = [race('a1', '01', 1), race('b1', '02', 1)];
  const summary = buildCandidateSummary({
    participantId: '100', races,
    assessmentsByRace: new Map([
      ['a1', assessment({ resilience: 6 })], ['b1', assessment({})]
    ]),
    evaluatorUid, stationTypeForRace
  });
  assert.equal(summary.traitAverages.resilience.value, 6);
  assert.equal(summary.traitAverages.resilience.stationCount, 1);
});

test('arrival summaries include places but never expose recorded slot times', () => {
  const races = [race('a1', '01', 1)];
  const arrivalsByRace = new Map([['a1', {
    order: ['200', '100'], slotTimes: { '1': 1000, '2': 2500 }
  }]]);
  const summary = buildCandidateSummary({
    participantId: '100', races, arrivalsByRace, evaluatorUid, stationTypeForRace
  });
  assert.equal(summary.stations[0].rounds[0].place, 2);
  assert.equal('slotTimes' in summary.stations[0].rounds[0], false);
  assert.equal('time' in summary.stations[0].rounds[0], false);
});

test('private edits override or deliberately clear legacy values during rollout', () => {
  const legacy = {
    scores: { resilience: 7 }, measurement: 10,
    comments: [{ id: 'legacy-note', text: 'ישן', authorUid: evaluatorUid }]
  };
  const current = {
    scores: {}, clearedScores: ['resilience'], measurement: null, measurementCleared: true,
    comments: [], hiddenCommentIds: ['legacy-note']
  };
  const merged = mergeAssessmentEntries(legacy, current);
  assert.deepEqual(merged.scores, {});
  assert.equal(merged.measurement, null);
  assert.deepEqual(merged.comments, []);
});

test('legacy own data is read without exposing another evaluator score', () => {
  const item = race('a1', '01', 1, [{
    participantId: '100',
    scores: { [evaluatorUid]: { 'חוסן וכושר הסתגלות': 5 }, other: { 'חוסן וכושר הסתגלות': 7 } },
    comments: [
      { text: 'שלי', authorUid: evaluatorUid, at: 1 },
      { text: 'לא שלי', authorUid: 'other', at: 2 }
    ]
  }]);
  const entry = assessmentEntryFor({ assessment: null, race: item, participantId: '100', evaluatorUid });
  assert.deepEqual(entry.scores, { resilience: 5 });
  assert.deepEqual(entry.comments.map(note => note.text), ['שלי']);
});

test('migration separates legacy subjective data and copies shared measurements safely', () => {
  const source = race('legacy', '02', 1, [{
    participantId: '100', reps: 8,
    scores: {
      first: { 'חוסן וכושר הסתגלות': 6 },
      second: { 'חוסן וכושר הסתגלות': 3 }
    },
    comments: [
      { text: 'א', authorUid: 'first', at: 1 },
      { text: 'ב', authorUid: 'second', at: 2 }
    ]
  }]);
  const buckets = buildLegacyAssessmentBuckets(source, ['first', 'second']);
  assert.deepEqual(buckets.get('first')['100'].scores, { resilience: 6 });
  assert.deepEqual(buckets.get('second')['100'].scores, { resilience: 3 });
  assert.deepEqual(buckets.get('first')['100'].comments.map(note => note.text), ['א']);
  assert.deepEqual(buckets.get('second')['100'].comments.map(note => note.text), ['ב']);
  assert.equal(buckets.get('first')['100'].measurement, 8);
  assert.equal(buckets.get('second')['100'].measurement, 8);
});

test('migration keeps a stable trait id even when its display name was edited', () => {
  const source = race('legacy-renamed', '02', 1, [{
    participantId: '100', scores: { first: { 'עמידות בתנאי לחץ': 6 } }
  }]);
  const buckets = buildLegacyAssessmentBuckets(source, ['first'], {
    'עמידות בתנאי לחץ': 'resilience'
  });
  assert.deepEqual(buckets.get('first')['100'].scores, { resilience: 6 });
});

test('station evaluation lives on the first round and carries into later rounds', () => {
  const races = [race('a3', '01', 3), race('a1', '01', 1), race('a2', '01', 2)];
  assert.equal(stationAssessmentRace(races).id, 'a1');
  const assessmentsByRace = new Map([
    ['a1', assessment({ resilience: 6 }, {
      comments: [{ id: 'n1', text: 'מוביל', authorUid: evaluatorUid }], measurement: 4
    })],
    ['a2', assessment({}, { measurement: 9 })]
  ]);
  const inRound2 = stationAssessmentEntry({
    races, assessmentsByRace, race: races[2], participantId: '100', evaluatorUid
  });
  assert.equal(inRound2.scores.resilience, 6);
  assert.deepEqual(inRound2.comments.map(note => note.id), ['n1']);
  assert.equal(inRound2.measurement, 9, 'measurement stays per round');
  const inRound3 = stationAssessmentEntry({
    races, assessmentsByRace, race: races[0], participantId: '100', evaluatorUid
  });
  assert.equal(inRound3.scores.resilience, 6);
  assert.equal(inRound3.measurement, null);
});

test('scores saved per round before the change read as station values; the first round decides', () => {
  const races = [race('a1', '01', 1), race('a2', '01', 2)];
  const old = new Map([
    ['a1', assessment({ resilience: 3 })],
    ['a2', assessment({ resilience: 5 }, { comments: [{ id: 'late', text: 'ישן', authorUid: evaluatorUid }] })]
  ]);
  const entry = stationAssessmentEntry({ races, assessmentsByRace: old, participantId: '100', evaluatorUid });
  assert.equal(entry.scores.resilience, 3, 'an explicit first-round score wins');
  assert.deepEqual(entry.comments.map(note => note.id), ['late']);

  const cleared = new Map([
    ['a1', assessment({}, { clearedScores: ['resilience'], hiddenCommentIds: ['late'] })],
    ['a2', old.get('a2')]
  ]);
  const after = stationAssessmentEntry({ races, assessmentsByRace: cleared, participantId: '100', evaluatorUid });
  assert.equal(after.scores.resilience, undefined);
  assert.deepEqual(after.comments, []);
  assert.equal(stationNoteRaceId({ races, assessmentsByRace: old, participantId: '100', noteId: 'late' }), 'a2');
  assert.equal(stationNoteRaceId({ races, assessmentsByRace: old, participantId: '100', noteId: 'new' }), 'a1');
});

test('candidate summary shows one station score and per-round results', () => {
  const races = [race('a1', '01', 1), race('a2', '01', 2), race('b1', '02', 1)];
  const assessmentsByRace = new Map([
    ['a1', assessment({ resilience: 7 })],
    ['b1', assessment({ resilience: 3 })]
  ]);
  const arrivalsByRace = new Map([['a1', { order: ['100'] }], ['a2', { order: ['200', '100'] }]]);
  const summary = buildCandidateSummary({
    participantId: '100', races, assessmentsByRace, arrivalsByRace, evaluatorUid, stationTypeForRace
  });
  const sprints = summary.stations[0];
  assert.equal(sprints.assessmentRaceId, 'a1');
  assert.equal(sprints.scores.resilience, 7);
  assert.deepEqual(sprints.rounds.map(round => [round.round, round.place]), [[1, 1], [2, 2]]);
  assert.equal(summary.traitAverages.resilience.value, 5);
});

test('counter tap times stay with their own round', () => {
  assert.deepEqual(normalizeRepTimes([5, '7', null, -1, 'x']), [5, 7]);
  const races = [race('a1', '02', 1), race('a2', '02', 2)];
  const assessmentsByRace = new Map([
    ['a1', assessment({ resilience: 4 }, { measurement: 2, repTimes: [1000, 2000] })],
    ['a2', assessment({}, { measurement: 1, repTimes: [9000] })]
  ]);
  const inRound2 = stationAssessmentEntry({ races, assessmentsByRace, race: races[1], participantId: '100', evaluatorUid });
  assert.deepEqual(inRound2.repTimes, [9000]);
  assert.equal(inRound2.scores.resilience, 4);
  assert.deepEqual(stationAssessmentEntry({ races, assessmentsByRace, participantId: '100', evaluatorUid }).repTimes, []);
});
