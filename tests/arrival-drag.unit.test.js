import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../frontend/app.html', import.meta.url), 'utf8');
const functions = app.slice(app.indexOf('  function onArrivalDragMove('), app.indexOf('  window.moveArrivalParticipant ='));

class Surface {
  handlers = new Map();
  addEventListener(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.handlers.get(type)?.delete(handler); }
  emit(type, event) { [...(this.handlers.get(type) || [])].forEach(fn => fn(event)); }
  get listenerCount() { return [...this.handlers.values()].reduce((n, list) => n + list.size, 0); }
}

function harness({captureFails = false} = {}) {
  const document = new Surface(), window = new Surface(), list = new Surface();
  list.dataset = {raceId:'r1', revision:'7'};
  const writes = [], captures = [], initial = ['8','100','320'];
  let rows, captured = null, context;
  const event = (extra = {}) => ({
    pointerId:1, button:0, isPrimary:true, clientX:40, clientY:200,
    preventDefault(){}, stopPropagation(){}, ...extra
  });
  function loseCapture() {
    if (!captured) return;
    const target = captured; captured = null;
    target.emit('lostpointercapture', event({target}));
  }
  function captureOn(surface) {
    surface.setPointerCapture = () => {
      captures.push(surface);
      if (captureFails) throw new Error('capture unavailable');
      captured = surface;
    };
    surface.releasePointerCapture = () => { if (captured === surface) loseCapture(); };
  }
  rows = initial.map(id => {
    const classes = new Set(), handle = new Surface();
    const row = {
      dataset:{pid:id}, parentElement:list, handle,
      classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c)},
      closest:()=>row,
      getBoundingClientRect:()=>({top:150 + rows.indexOf(row)*80,height:80}),
      get nextSibling(){return rows[rows.indexOf(row)+1] || null;}
    };
    handle.closest = () => row; captureOn(handle);
    return row;
  });
  captureOn(list);
  list.insertBefore = (row, next) => {
    // Browser DOM movement removes/reinserts descendants and can release their
    // pointer capture. This reproduces the old moving-handle lifecycle bug.
    if (captured === row.handle) loseCapture();
    if (row === next) return;
    rows.splice(rows.indexOf(row),1);
    rows.splice(next ? rows.indexOf(next) : rows.length,0,row);
  };
  let target = rows[0];
  document.elementFromPoint = () => target;
  window.innerHeight = 844; window.scrollBy = () => {};
  context = vm.createContext({
    document,window,currentRace:{id:'r1'},arrivalDragState:null,arrivalOrderSaving:false,
    canEvaluate:()=>true,currentArrivalState:()=>({canReorder:true}),
    arrivalRows:()=>rows,arrivalOrderFromList:()=>rows.map(row=>row.dataset.pid),
    refreshArrivalPreview:()=>{},
    persistArrivalOrder:(list,order,revision,raceId)=>writes.push({order,revision,raceId}),
    renderRace:()=>rows.sort((a,b)=>initial.indexOf(a.dataset.pid)-initial.indexOf(b.dataset.pid))
  });
  vm.runInContext(functions,context);
  function send(type, extra = {}) {
    const e = event(extra);
    // Captured events bubble to document; after capture is lost the moving
    // handle no longer receives pointerup from elsewhere on the page.
    captured?.emit(type,e);
    document.emit(type,e);
  }
  return {
    context,list,document,window,writes,captures,rows:()=>rows,
    start(id='8',extra={}){context.window.startArrivalDrag(event({currentTarget:rows.find(r=>r.dataset.pid===id).handle,...extra}));},
    moveTo(id,after=true){target=rows.find(r=>r.dataset.pid===id);send('pointermove',{clientY:target.getBoundingClientRect().top+(after?65:10)});},
    send,loseCapture
  };
}

test('drag captures stable list, survives row movement and saves once at release', () => {
  const h=harness(); h.start();
  assert.equal(h.captures[0],h.list);
  h.moveTo('320'); h.send('pointerup'); h.send('pointerup');
  assert.deepEqual(h.writes,[{order:['100','320','8'],revision:7,raceId:'r1'}]);
  assert.equal(h.context.arrivalDragState,null);
  assert.equal(h.document.listenerCount+h.window.listenerCount+h.list.listenerCount,0);
  h.start('8');h.moveTo('100',false);h.send('pointerup');
  assert.deepEqual(h.writes[1].order,['8','100','320']);
});

for(const cancel of ['lostpointercapture','pointercancel','blur','hidden','escape']) {
  test(`drag cancellation (${cancel}) restores order and allows the next drag`, () => {
    const h=harness();h.start();h.moveTo('320');
    if(cancel==='lostpointercapture')h.loseCapture();
    else if(cancel==='pointercancel')h.send('pointercancel');
    else if(cancel==='blur')h.window.emit('blur',{});
    else if(cancel==='hidden'){h.document.hidden=true;h.document.emit('visibilitychange',{});}
    else h.send('keydown',{key:'Escape'});
    assert.equal(h.context.arrivalDragState,null);
    assert.deepEqual(h.writes,[]);
    assert.deepEqual(h.rows().map(r=>r.dataset.pid),['8','100','320']);
    assert.equal(h.document.listenerCount+h.window.listenerCount+h.list.listenerCount,0);
    h.start();assert.ok(h.context.arrivalDragState);h.send('pointerup');
  });
}

test('document listeners finish dragging even when browser capture is unavailable', () => {
  const h=harness({captureFails:true});h.start();h.moveTo('320');h.send('pointerup');
  assert.equal(h.writes.length,1);assert.equal(h.context.arrivalDragState,null);
});

test('implicit touch capture transferring from the handle must not cancel the list drag', () => {
  const h=harness();h.start();
  h.list.emit('lostpointercapture',{pointerId:1,target:h.rows()[0].handle});
  assert.ok(h.context.arrivalDragState);
  h.moveTo('320');h.send('pointerup');assert.equal(h.writes.length,1);
});

test('a click or tiny pointer movement on a handle does not reorder or save', () => {
  const h=harness();h.start();h.send('pointermove',{clientX:42,clientY:201});h.send('pointerup');
  assert.equal(h.context.arrivalDragState,null);
  assert.equal(h.writes.length,0);
  assert.deepEqual(h.rows().map(r=>r.dataset.pid),['8','100','320']);
});

test('other pointers and context changes cannot commit a drag into a different round', () => {
  const h=harness();h.start('8',{button:2});assert.equal(h.context.arrivalDragState,null);
  h.start('8',{isPrimary:false});assert.equal(h.context.arrivalDragState,null);
  h.start();h.moveTo('320');h.send('pointerup',{pointerId:2});assert.ok(h.context.arrivalDragState);
  h.context.currentRace={id:'r2'};h.context.clearArrivalDrag();h.send('pointerup');
  assert.deepEqual(h.writes,[]);assert.equal(h.context.arrivalDragState,null);
});
