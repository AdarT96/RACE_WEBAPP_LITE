import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldFollowNewRound, viewedRoundId } from '../frontend/js/round-navigation-model.js';

const rounds = (...ids) => ids.map(id => ({ id }));

test('round navigation chooses latest only for initial selection or removed round', () => {
  assert.equal(viewedRoundId([], null), null);
  assert.equal(viewedRoundId(rounds('one', 'two'), null), 'two');
  assert.equal(viewedRoundId(rounds('one', 'two'), 'removed'), 'two');
});

test('evaluator stays on previously latest round when new round arrives', () => {
  assert.equal(viewedRoundId(rounds('one', 'two'), 'one'), 'one');
  assert.equal(viewedRoundId(rounds('one', 'two', 'three'), 'two'), 'two');
});

test('evaluator selection remains unchanged after stop, reconnect and further rounds', () => {
  const stopped = [ { id:'one', status:'stopped' }, { id:'two', status:'stopped' } ];
  assert.equal(viewedRoundId(stopped, 'one'), 'one');
  assert.equal(viewedRoundId([...stopped, { id:'three', status:'running' }], 'one'), 'one');
  assert.equal(viewedRoundId(stopped, 'two'), 'two');
});

test('operator can explicitly follow latest while evaluator can select history', () => {
  assert.equal(viewedRoundId(rounds('one', 'two', 'three'), 'one', true), 'three');
  assert.equal(viewedRoundId(rounds('one', 'two', 'three'), 'one', false), 'one');
});

test('a newly started round pulls the evaluator along unless they are mid-drag', () => {
  const running = { id: 'two', status: 'running' };
  assert.equal(shouldFollowNewRound({ previousLatestId: 'one', latestRace: running }), true);
  assert.equal(shouldFollowNewRound({ previousLatestId: 'one', latestRace: running, busy: true }), false);
  assert.equal(shouldFollowNewRound({ previousLatestId: 'two', latestRace: running }), false, 'same round, no jump');
  assert.equal(shouldFollowNewRound({ previousLatestId: null, latestRace: running }), false, 'first load is handled separately');
  assert.equal(shouldFollowNewRound({ previousLatestId: 'one', latestRace: { id: 'two', status: 'stopped' } }), false);
});
