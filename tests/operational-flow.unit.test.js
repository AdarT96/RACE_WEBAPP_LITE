import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arrivalEntriesInOrder, arrivalOrderSignature, arrivalWithOrder, moveParticipantInOrder
} from '../frontend/js/arrival-order-model.js';
import { measuredElapsedMs } from '../frontend/js/session-policy.js';
import { activeParticipantIds } from '../frontend/js/formation-operations-model.js';

test('two evaluators keep independent arrival orders and reorder only candidate-to-place mapping', () => {
  const evaluatorA = {
    evaluatorUid:'a', order:['100', '320', '8'],
    slotTimes:{ '1':1_000, '2':2_000, '3':3_000 }
  };
  const evaluatorB = {
    evaluatorUid:'b', order:['320', '8', '100'],
    slotTimes:{ '1':1_200, '2':2_200, '3':3_200 }
  };
  const moved = moveParticipantInOrder(evaluatorA.order, '8', 0);
  const correctedA = arrivalWithOrder(evaluatorA, moved);
  assert.deepEqual(correctedA.order, ['8', '100', '320']);
  assert.deepEqual(correctedA.slotTimes, evaluatorA.slotTimes);
  assert.deepEqual(evaluatorB.order, ['320', '8', '100']);
  assert.deepEqual(arrivalEntriesInOrder(correctedA), [
    { participantId:'8', place:1, finishedAt:1_000 },
    { participantId:'100', place:2, finishedAt:2_000 },
    { participantId:'320', place:3, finishedAt:3_000 }
  ]);
  assert.notEqual(arrivalOrderSignature(correctedA), arrivalOrderSignature(evaluatorA));
  assert.deepEqual(moveParticipantInOrder(correctedA.order, '8', Number.NaN), correctedA.order);
  assert.throws(() => arrivalWithOrder(correctedA, ['8', '8', '320']), /אינה תואמת/);
});

test('an evaluator can record a post-stop arrival but research time remains empty after the limit', () => {
  const race = { status:'stopped', startedAt:0, endedAt:2_400_000, timeLimitSeconds:2_400 };
  assert.equal(measuredElapsedMs(race, 2_399_999), 2_399_999);
  assert.equal(measuredElapsedMs(race, 2_400_001), null);
});

test('withdrawing a candidate affects the next roster without rewriting the frozen round roster', () => {
  const team = { id:'01', participantIds:['100', '101'] };
  const frozenRound = ['100', '101'];
  const nextRound = activeParticipantIds(team, [
    { team:'01', participantId:'100', status:'withdrawn', reasonCode:'medical' },
    { team:'01', participantId:'101', status:'active' }
  ]);
  assert.deepEqual(frozenRound, ['100', '101']);
  assert.deepEqual(nextRound, ['101']);
});
