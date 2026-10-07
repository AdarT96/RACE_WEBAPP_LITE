import test from 'node:test';
import assert from 'node:assert/strict';
import { viewedRoundId } from '../frontend/js/round-navigation-model.js';

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
