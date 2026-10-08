import test from 'node:test';
import assert from 'node:assert/strict';
import { arrivalWithPlacement } from '../frontend/js/arrival-order-model.js';

const initial = () => ({participantIds:['8','100','320'],order:['100','320'],slotTimes:{1:10,2:20}});

test('inserting unmarked participant at any position keeps existing place times', () => {
  for (let index=0;index<=2;index++) {
    const base=initial(), next=arrivalWithPlacement(base,'8',index,30);
    assert.equal(next.order[index],'8');
    assert.deepEqual(next.slotTimes,{1:10,2:20,3:30});
    assert.equal(next.completedAt,30);
    assert.deepEqual(base,initial());
  }
});

test('unmark removes only the last time slot, clears completion and supports later re-add', () => {
  const complete=arrivalWithPlacement(initial(),'8',0,30);
  const undone=arrivalWithPlacement(complete,'100',null,40);
  assert.deepEqual(undone.order,['8','320']);
  assert.deepEqual(undone.slotTimes,{1:10,2:20});
  assert.equal('completedAt' in undone,false);
  const redone=arrivalWithPlacement(undone,'100',1,50);
  assert.deepEqual(redone.slotTimes,{1:10,2:20,3:50});
  assert.equal(redone.completedAt,50);
});

test('moving arrived participant keeps all place times and completion unchanged', () => {
  const complete=arrivalWithPlacement(initial(),'8',0,30);
  const next=arrivalWithPlacement(complete,'8',2,40);
  assert.deepEqual(next.order,['100','320','8']);
  assert.deepEqual(next.slotTimes,complete.slotTimes);
  assert.equal(next.completedAt,30);
});

test('empty rank list accepts first arrival and last arrival can be unmarked', () => {
  const base={participantIds:['8'],order:[],slotTimes:{}};
  const marked=arrivalWithPlacement(base,'8',0,10);
  assert.deepEqual(arrivalWithPlacement(marked,'8',null,20),base);
});

test('placement rejects unknown candidates and invalid indices', () => {
  assert.throws(()=>arrivalWithPlacement(initial(),'999',0,30));
  for(const index of [-1,3,0.5,NaN,undefined,'1']) {
    assert.throws(()=>arrivalWithPlacement(initial(),'8',index,30));
  }
  assert.deepEqual(arrivalWithPlacement(initial(),'8',null,30),initial());
});
