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

function harness({captureFails = false, pending = [], initial = ['8','100','320']} = {}) {
  const document = new Surface(), window = new Surface(), list = new Surface();
  list.dataset = {raceId:'r1', revision:'7'};
  const writes = [], placements = [], captures = [], ghosts = [];
  let rows, elements, captured = null, context;
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
  rows = [...initial, ...pending].map(id => {
    const classes = new Set([initial.includes(id) ? 'arrived' : 'pending']), handle = new Surface();
    const row = {
      dataset:{pid:id}, parentElement:list, handle,
      classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),
        toggle:(c,on)=>on?classes.add(c):classes.delete(c)},
      closest:()=>row,
      getBoundingClientRect:()=>({left:10,width:350,top:150 + elements.indexOf(row)*80,height:80}),
      cloneNode:()=>({style:{},classList:{add(){},remove(){}},setAttribute(){},remove(){this.removed=true;}}),
      get nextSibling(){return elements[elements.indexOf(row)+1] || null;}
    };
    handle.closest = () => row; captureOn(handle);
    return row;
  });
  const zone = name => {
    const node = {parentElement:list,classList:{contains:c=>c===name},
      getBoundingClientRect:()=>({top:150+elements.indexOf(node)*80,height:40}),
      get nextSibling(){return elements[elements.indexOf(node)+1] || null;}};
    node.closest=()=>node;return node;
  };
  const start=zone('arrival-drop-start'), boundary=zone('arrival-divider');
  const restore=()=>{
    rows.forEach(row=>{row.classList.toggle('arrived',initial.includes(row.dataset.pid));row.classList.toggle('pending',!initial.includes(row.dataset.pid));});
    elements=[start,...rows.filter(row=>initial.includes(row.dataset.pid)),boundary,...rows.filter(row=>pending.includes(row.dataset.pid))];
  };
  restore();
  list.querySelector=()=>boundary;
  document.body={appendChild:ghost=>ghosts.push(ghost)};
  captureOn(list);
  list.insertBefore = (row, next) => {
    // Browser DOM movement removes/reinserts descendants and can release their
    // pointer capture. This reproduces the old moving-handle lifecycle bug.
    if (captured === row.handle) loseCapture();
    if (row === next) return;
    elements.splice(elements.indexOf(row),1);
    elements.splice(next ? elements.indexOf(next) : elements.length,0,row);
  };
  let target = rows[0];
  document.elementFromPoint = () => target;
  window.innerHeight = 844; window.scrollBy = () => {};
  context = vm.createContext({
    document,window,currentRace:{id:'r1'},arrivalDragState:null,arrivalOrderSaving:false,
    canEvaluate:()=>true,currentArrivalState:()=>({canReorder:true}),
    arrivalRows:()=>elements.filter(row=>row.classList.contains('arrived')),
    arrivalOrderFromList:()=>elements.filter(row=>row.classList.contains('arrived')).map(row=>row.dataset.pid),
    refreshArrivalPreview:()=>{},
    persistArrivalOrder:(list,order,revision,raceId,placement)=>{writes.push({order,revision,raceId});placements.push(placement);},
    renderRace:restore
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
    context,list,document,window,writes,placements,captures,ghosts,rows:()=>elements.filter(row=>row.dataset),
    start(id='8',extra={}){context.window.startArrivalDrag(event({currentTarget:rows.find(r=>r.dataset.pid===id).handle,...extra}));},
    moveTo(id,after=true){target=rows.find(r=>r.dataset.pid===id);send('pointermove',{clientY:target.getBoundingClientRect().top+(after?65:10)});},
    moveToZone(name){target=name==='pending'?boundary:start;send('pointermove',{clientY:target.getBoundingClientRect().top+10});},
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

test('unmarked row drags into a chosen rank with a visible ghost and one atomic placement', () => {
  const h=harness({pending:['7']});h.start('7');h.moveTo('100',false);
  assert.equal(h.ghosts.length,1);
  assert.match(h.ghosts[0].style.transform,/translate3d/);
  assert.equal(h.rows().find(r=>r.dataset.pid==='7').classList.contains('dragging'),true);
  h.send('pointerup');
  assert.deepEqual(h.writes[0].order,['8','7','100','320']);
  assert.equal(h.placements[0].pid,'7');assert.equal(h.placements[0].targetIndex,1);
  assert.equal(h.ghosts[0].removed,true);
});

test('ranked row can return to gray even when everybody has arrived', () => {
  const h=harness();h.start('100');h.moveToZone('pending');h.send('pointerup');
  assert.deepEqual(h.writes[0].order,['8','320']);
  assert.equal(h.placements[0].pid,'100');assert.equal(h.placements[0].targetIndex,null);
});

test('first participant can be dragged from gray into an empty ranking', () => {
  const h=harness({initial:[],pending:['7']});h.start('7');h.moveToZone('start');h.send('pointerup');
  assert.deepEqual(h.writes[0].order,['7']);
  assert.equal(h.placements[0].targetIndex,0);
});

test('gray-to-gray movement does not mark arrival and cancellation removes its ghost', () => {
  const h=harness({pending:['7','9']});h.start('7');h.moveTo('9');h.send('pointerup');
  assert.equal(h.writes.length,0);assert.equal(h.ghosts[0].removed,true);
  h.start('7');h.moveTo('100');h.send('pointercancel');
  assert.equal(h.writes.length,0);assert.equal(h.ghosts[1].removed,true);
  assert.equal(h.rows().find(r=>r.dataset.pid==='7').classList.contains('pending'),true);
});
