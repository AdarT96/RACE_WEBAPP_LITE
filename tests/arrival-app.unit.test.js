import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { arrivalEntriesInOrder } from '../frontend/js/arrival-order-model.js';

// Execute the actual view functions, not a second implementation of their logic.
const app = await readFile(new URL('../frontend/app.html', import.meta.url), 'utf8');
const extract = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const escHtml = String;

test('every arrival row has a handle and empty/full lists retain both drop targets', () => {
  const nodes={};
  const context=vm.createContext({
    document:{getElementById:id=>nodes[id] ||= {style:{},dataset:{},setAttribute(){}}},
    arrivalEntriesInOrder,escHtml,canEvaluate:()=>true,arrivalOrderSaving:false,
    currentRace:{id:'r1'},evaluatorArrivalLoading:false,
    currentAssessmentEntry:()=>({comments:[]}),
    currentArrivalState:()=>({canReorder:true,pendingIds:[],confirmed:{revision:1,order:[]}})
  });
  vm.runInContext(extract('  function renderArrivalOrderList(', '  function renderArrivalGrid('),context);
  for(const order of [[],['8'],['8','100']]) {
    context.renderArrivalOrderList(['8','100'],{order},{id:'r1'});
    const html=nodes['finished-list'].innerHTML;
    assert.equal((html.match(/class="arrival-drag-handle"/g)||[]).length,2);
    assert.match(html,/class="arrival-drop-start"/);
    assert.match(html,/class="arrival-divider"/);
    assert.doesNotMatch(html,/class="arrival-drag-handle" disabled/);
  }
});

test('candidate-page-only listener failure exposes a retry action', () => {
  const panel = {};
  const context = vm.createContext({
    document:{getElementById:()=>panel}, escHtml, currentRaceId:'station-round',
    candidateRoute:()=>true,candidateState:{arrivalsByRace:new Map([['candidate-round',{}]])},
    arrivalControllers:new Map([['candidate-round',{
      race:{id:'candidate-round',team:'01',station:'01',round:2},
      controller:{state:()=>({pendingCount:0,error:new Error('connection failed')})}
    }]])
  });
  vm.runInContext(extract('  function renderArrivalSaveStatus()', "  document.getElementById('arrival-save-status').addEventListener"),context);
  context.renderArrivalSaveStatus();
  assert.equal(panel.hidden,false);
  assert.match(panel.innerHTML,/data-arrival-retry="candidate-round"/);
});

test('a delayed tap from a previous round cannot mark the newly selected round', () => {
  const marks=[];
  const context=vm.createContext({
    window:{}, canEvaluate:()=>true,supportsRoundTabs:()=>true,
    currentStationType:()=>({measure:'place'}),currentRaceId:'r2',currentRace:{id:'r2'},
    arrivalDragState:null,arrivalOrderSaving:false,
    arrivalControllerFor:race=>({append:pid=>{marks.push([race.id,pid]);return true;}})
  });
  vm.runInContext(extract('  window.markFinished =', '  function arrivalRows('),context);
  context.window.markFinished('100','r1');
  assert.deepEqual(marks,[]);
  context.window.markFinished('100','r2');
  assert.deepEqual(marks,[['r2','100']]);
});

test('arrival grid retains the same button nodes/cells across pending, confirmed and failed saves', () => {
  let builds = 0, nodes = [];
  const grid = {
    dataset:{},
    set innerHTML(html) {
      builds++;
      nodes = [...html.matchAll(/data-pid="([^"]+)"/g)].map(([,id]) => ({
        dataset:{pid:id}, disabled:false, attributes:{}, classes:new Set(),
        classList:{toggle(name,on){on ? this.owner.classes.add(name) : this.owner.classes.delete(name);}},
        setAttribute(name,value){this.attributes[name]=value;},
        removeAttribute(name){delete this.attributes[name];}
      }));
      nodes.forEach(node => {node.classList.owner=node;});
    },
    querySelectorAll(){return nodes;}
  };
  const context = vm.createContext({escHtml});
  vm.runInContext(extract('  function renderArrivalGrid(', '  function renderRace()'), context);
  const render = (marked,enabled=true,race='r1') => context.renderArrivalGrid(grid,
    ['8','100','320'].map(id=>({id})),new Set(marked),race,enabled);
  render([]);
  const original = [...nodes];
  render(['100']);
  render(['100','320']);
  render(['100','320'],false); // blocked/retry feedback must not rearrange targets
  assert.equal(builds,1);
  original.forEach((node,index)=>assert.equal(nodes[index],node));
  assert.equal(nodes[1].classes.has('is-marked'),true);
  assert.equal(nodes[1].attributes['aria-hidden'],'true');
  assert.equal(nodes[0].disabled,true);
  render(['100','320']);
  assert.equal(nodes[0].disabled,false);
  render([],true,'r2');
  assert.equal(builds,2);
  assert.ok(nodes.every(node=>!node.classes.has('is-marked') && !node.disabled));
});

test('arrival rerenders do not rebuild or scroll tabs; new rounds render without forcing selection', () => {
  let builds=0, scrolls=0, html='';
  const tabs = {
    set innerHTML(value){html=value;builds++;},
    querySelector(){return {scrollIntoView(){scrolls++;}};}
  };
  const nodes={'round-tabs':tabs};
  const context=vm.createContext({
    document:{getElementById:id=>nodes[id] ||= {style:{}}},
    requestAnimationFrame:fn=>fn(), escHtml,
    supportsRoundTabs:()=>true, canEvaluate:()=>true,isOperator:()=>false,
    isSessionEffectivelyRunning:()=>false,isSessionExpired:()=>false,
    effectiveSessionElapsedMs:()=>null,formatMMSS:()=>'',
    roundNavigationSignature:'',roundNavigationSelectedId:null,
    currentRaceId:'r1',racesForContext:[{id:'r1',round:1}]
  });
  vm.runInContext(extract('  function renderRoundNavigation()', '  // ═════════ Rendering'),context);
  context.renderRoundNavigation();
  context.renderRoundNavigation();
  assert.equal(builds,1); assert.equal(scrolls,1);
  context.racesForContext.push({id:'r2',round:2});
  context.renderRoundNavigation();
  assert.equal(builds,2); assert.equal(scrolls,1);
  assert.match(html,/data-race-id="r2"/);
  assert.equal(context.currentRaceId,'r1');
  context.currentRaceId='r2';context.renderRoundNavigation();
  assert.equal(scrolls,2);
});

test('newer-round banner remains available after that round stops', () => {
  const nodes={};
  const context=vm.createContext({
    document:{getElementById:id=>nodes[id] ||= {style:{}}},
    setText:(id,value)=>nodes[id]=value,
    canEvaluate:()=>true,supportsRoundTabs:()=>true,isSessionEffectivelyRunning:()=>false,
    currentRaceId:'r1',currentRace:{id:'r1',round:1},latestRace:{id:'r2',round:2}
  });
  vm.runInContext(extract('  function renderLiveRoundBanner(', '  function queueExpiredSessionFinalization('),context);
  context.renderLiveRoundBanner();
  assert.equal(nodes['live-round-banner'].style.display,'');
  assert.match(nodes['live-round-label'],/סבב 2.*הסתיים/);
  context.currentRaceId='r2';context.renderLiveRoundBanner();
  assert.equal(nodes['live-round-banner'].style.display,'none');
});
