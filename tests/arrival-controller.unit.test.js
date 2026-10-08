import test from 'node:test';
import assert from 'node:assert/strict';
import { createArrivalController } from '../frontend/js/arrival-controller.js';

const initial = () => ({ participantIds:['100', '320', '8'], order:[], slotTimes:{}, revision:0 });
const value = (revision, order, slotTimes = {}) => ({ ...initial(), revision, order, slotTimes });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const subscriptions = [], writes = [], changes = [];
  const repository = {
    subscribe(raceId, next, error) {
      const subscription = { raceId, next, error, closed:false };
      subscriptions.push(subscription);
      return () => { subscription.closed = true; };
    },
    mutate(raceId, command) {
      const pending = deferred();
      writes.push({ raceId, command:{ ...command }, ...pending });
      return pending.promise;
    }
  };
  const controller = createArrivalController({
    raceId:'round-A', repository, initial:initial(), onChange:state => changes.push(state)
  });
  controller.activate();
  const snapshot = state => subscriptions.at(-1).next(state);
  snapshot(initial());
  return { controller, subscriptions, writes, changes, snapshot };
}

test('arrival acknowledgment hides participant before listener catches up', async () => {
  const h = harness();
  assert.equal(h.controller.append('100'), true);
  assert.deepEqual(h.controller.state().arrival.order, ['100']);
  assert.deepEqual(h.controller.state().pendingIds, ['100']);
  h.writes[0].resolve(value(1, ['100']));
  await tick();
  assert.deepEqual(h.controller.state().confirmed.order, ['100']);
  assert.equal(h.controller.state().pendingCount, 0);
  h.snapshot(initial());
  assert.deepEqual(h.controller.state().arrival.order, ['100']);
  h.controller.dispose();
});

test('equal revision snapshot enriches timestamps without late acknowledgment rollback', async () => {
  const h = harness();
  h.controller.append('100');
  h.snapshot(value(1, ['100'], { '1':1234 }));
  h.writes[0].resolve(value(1, ['100'], { '1':{ sentinel:true } }));
  await tick();
  assert.equal(h.controller.state().confirmed.slotTimes['1'], 1234);
  h.controller.append('320');
  h.writes[1].resolve(value(2, ['100', '320'], { '1':1234, '2':{ sentinel:true } }));
  await tick();
  h.snapshot(value(2, ['100', '320'], { '1':1234, '2':5678 }));
  assert.equal(h.controller.state().confirmed.slotTimes['2'], 5678);
  h.controller.dispose();
});

test('higher revision remote reorder wins over delayed local acknowledgment', async () => {
  const h = harness();
  h.snapshot(value(1, ['100']));
  h.controller.append('320');
  h.snapshot(value(3, ['320', '100']));
  h.writes[0].resolve(value(2, ['100', '320']));
  await tick();
  assert.equal(h.controller.state().confirmed.revision, 3);
  assert.deepEqual(h.controller.state().arrival.order, ['320', '100']);
  h.controller.dispose();
});

test('rapid distinct arrivals run FIFO and duplicate taps enqueue only once', async () => {
  const h = harness();
  h.controller.append('100');
  h.controller.append('100');
  h.controller.append('320');
  h.controller.append('8');
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.controller.state().arrival.order, ['100', '320', '8']);
  assert.equal(h.controller.state().pendingCount, 3);
  h.writes[0].resolve(value(1, ['100']));
  await tick();
  assert.equal(h.writes[1].command.pid, '320');
  h.writes[1].resolve(value(2, ['100', '320']));
  await tick();
  assert.equal(h.writes[2].command.pid, '8');
  h.writes[2].resolve(value(3, ['100', '320', '8']));
  await tick();
  assert.equal(h.controller.state().pendingCount, 0);
  h.controller.append('8');
  assert.equal(h.writes.length, 3);
  assert.ok(h.writes.every(write => write.raceId === 'round-A'));
  h.controller.dispose();
});

test('failed append pauses following commands until explicit retry and fresh snapshot', async () => {
  const h = harness();
  h.controller.append('100');
  h.controller.append('320');
  const failure = new Error('network unavailable');
  h.writes[0].reject(failure);
  await tick();
  assert.equal(h.writes.length, 1);
  assert.equal(h.controller.state().error, failure);
  assert.equal(h.controller.append('8'), false);
  assert.deepEqual(h.controller.state().pendingIds, ['100', '320']);
  h.controller.retry();
  assert.equal(h.controller.state().ready, false);
  assert.equal(h.writes.length, 1);
  // The first write might already have committed; repository retry is idempotent.
  h.snapshot(value(1, ['100']));
  assert.equal(h.writes[1].command.pid, '100');
  h.writes[1].resolve(value(1, ['100']));
  await tick();
  assert.equal(h.writes[2].command.pid, '320');
  h.writes[2].resolve(value(2, ['100', '320']));
  await tick();
  assert.deepEqual(h.controller.state().confirmed.order, ['100', '320']);
  h.controller.dispose();
});

test('deactivation keeps queued writes tied to original round until queue drains', async () => {
  const h = harness();
  h.controller.append('100');
  h.controller.append('320');
  h.controller.deactivate();
  assert.equal(h.subscriptions[0].closed, false);
  h.writes[0].resolve(value(1, ['100']));
  await tick();
  assert.equal(h.writes[1].raceId, 'round-A');
  h.writes[1].resolve(value(2, ['100', '320']));
  await tick();
  assert.equal(h.subscriptions[0].closed, true);
  h.controller.dispose();
});

test('stale callbacks from previous subscription cannot affect reactivated controller', () => {
  const h = harness();
  const stale = h.subscriptions[0];
  h.controller.deactivate();
  h.controller.activate();
  h.snapshot(value(2, ['100']));
  stale.next(value(99, ['8']));
  stale.error(new Error('obsolete error'));
  assert.deepEqual(h.controller.state().confirmed.order, ['100']);
  assert.equal(h.controller.state().error, null);
  h.controller.dispose();
});

test('listener failure blocks actions and retry replaces failed subscription', () => {
  const h = harness();
  const failure = new Error('permission-denied');
  h.subscriptions[0].error(failure);
  assert.equal(h.controller.state().error, failure);
  assert.equal(h.controller.append('100'), false);
  assert.equal(h.subscriptions[0].closed, true);
  h.controller.retry();
  assert.equal(h.subscriptions.length, 2);
  h.snapshot(value(1, ['100']));
  assert.equal(h.controller.state().error, null);
  assert.equal(h.controller.state().canMark, true);
  h.controller.dispose();
});

test('reorder is blocked during pending arrivals and carries expected revision when allowed', async () => {
  const h = harness();
  h.snapshot(value(1, ['100']));
  h.controller.append('320');
  await assert.rejects(h.controller.reorder(['100'], 1));
  h.writes[0].resolve(value(2, ['100', '320']));
  await tick();
  const reordered = h.controller.reorder(['320', '100'], 2);
  assert.equal(h.controller.append('8'), false);
  assert.deepEqual(h.writes[1].command.order, ['320', '100']);
  assert.equal(h.writes[1].command.expectedRevision, 2);
  h.writes[1].resolve(value(3, ['320', '100']));
  await reordered;
  assert.deepEqual(h.controller.state().arrival.order, ['320', '100']);
  h.controller.dispose();
});

test('reorder conflict rejects old permutation and reconnects without replaying it', async () => {
  const h = harness();
  h.snapshot(value(2, ['100', '320']));
  const reordered = h.controller.reorder(['320', '100'], 2);
  const rejected = assert.rejects(reordered, /conflict/);
  h.writes[0].reject(new Error('conflict'));
  await rejected;
  h.snapshot(value(3, ['100', '320', '8']));
  await tick();
  assert.equal(h.writes.length, 1);
  assert.equal(h.controller.state().pendingCount, 0);
  assert.deepEqual(h.controller.state().arrival.order, ['100', '320', '8']);
  h.controller.dispose();
});

test('dispose halts queued writes and ignores late success and snapshot callbacks', async () => {
  const h = harness();
  h.controller.append('100');
  h.controller.append('320');
  h.controller.dispose();
  const changeCount = h.changes.length;
  h.writes[0].resolve(value(1, ['100']));
  h.subscriptions[0].next(value(3, ['100', '320', '8']));
  await tick();
  assert.equal(h.writes.length, 1);
  assert.equal(h.changes.length, changeCount);
  assert.equal(h.subscriptions[0].closed, true);
});

test('legacy unversioned snapshot is accepted as initial revision zero', () => {
  const h = harness();
  const legacy = value(0, ['100']);
  delete legacy.revision;
  h.snapshot(legacy);
  assert.equal(h.controller.state().confirmed.revision, 0);
  assert.deepEqual(h.controller.state().confirmed.order, ['100']);
  h.controller.dispose();
});

test('disposed controller refuses new work rather than accepting into a dead queue', async () => {
  const h = harness();
  h.controller.dispose();
  assert.equal(h.controller.state().canMark, false);
  assert.equal(h.controller.state().canReorder, false);
  assert.equal(h.controller.append('100'), false);
  await assert.rejects(h.controller.reorder([], 0));
  assert.equal(h.controller.state().pendingCount, 0);
  assert.equal(h.writes.length, 0);
});

test('inactive candidate controller waits for fresh snapshot after reorder conflict', async () => {
  const h = harness();
  h.controller.seed(value(2, ['100', '320']));
  h.controller.deactivate();
  const reordered = h.controller.reorder(['320', '100'], 2);
  const rejected = assert.rejects(reordered, /conflict/);
  h.writes[0].reject(new Error('conflict'));
  await rejected;
  const recovery = h.subscriptions.at(-1);
  assert.equal(recovery.closed, false);
  assert.equal(h.controller.state().ready, false);
  assert.equal(h.controller.state().canReorder, false);
  recovery.next(value(3, ['100', '320', '8']));
  assert.deepEqual(h.controller.state().confirmed.order, ['100', '320', '8']);
  assert.equal(h.controller.state().ready, true);
  assert.equal(recovery.closed, true);
  assert.equal(h.writes.length, 1);
  h.controller.dispose();
});

test('placement is an exclusive versioned command and refreshes after a conflict without replay', async () => {
  const h=harness();h.snapshot(value(2,['100','320']));
  const placement=h.controller.place('8',0,2);
  const rejected=assert.rejects(placement,/conflict/);
  assert.equal(h.controller.state().canMark,false);
  assert.equal(h.controller.append('8'),false);
  await assert.rejects(h.controller.reorder(['320','100'],2));
  assert.equal(h.writes[0].command.type,'place');
  assert.equal(h.writes[0].command.expectedRevision,2);
  h.writes[0].reject(new Error('conflict'));await rejected;
  h.snapshot(value(3,['8','100','320']));await tick();
  assert.equal(h.writes.length,1);
  const undo=h.controller.place('8',null,3);
  h.writes[1].resolve(value(4,['100','320']));await undo;
  assert.deepEqual(h.controller.state().arrival.order,['100','320']);
  assert.equal(h.controller.state().canMark,true);
  h.snapshot(value(3,['8','100','320']));
  assert.deepEqual(h.controller.state().arrival.order,['100','320']);
  h.controller.dispose();
});
