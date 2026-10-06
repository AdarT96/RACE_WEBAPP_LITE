import test from 'node:test';
import assert from 'node:assert/strict';
import { createForegroundGate, markLoad } from '../frontend/js/load-priority.js';

test('background work waits until the requested view is shown', () => {
  const gate = createForegroundGate();
  const ran = [];
  gate.background(() => ran.push('races'));
  gate.background(() => ran.push('history'));
  assert.deepEqual(ran, []);
  assert.equal(gate.released, false);

  gate.release();
  assert.deepEqual(ran, ['races', 'history']);
  assert.equal(gate.released, true);
});

test('after release, background work runs immediately and only once', () => {
  const gate = createForegroundGate();
  let count = 0;
  gate.background(() => { count += 1; });
  gate.release();
  gate.release();
  assert.equal(count, 1);

  gate.background(() => { count += 1; });
  assert.equal(count, 2);
});

test('a failing background task does not stop the others', async () => {
  const gate = createForegroundGate();
  const ran = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    gate.background(() => { throw new Error('sync failure'); });
    gate.background(() => Promise.reject(new Error('async failure')));
    gate.background(() => ran.push('after'));
    gate.release();
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(ran, ['after']);
});

test('timing marks are inert without ?debug=timing', () => {
  assert.doesNotThrow(() => markLoad('outside a browser'));
});
