import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as scheduleModel from '../frontend/js/schedule-model.js';
import { canManageSchedule, roleLabel } from '../frontend/js/roles.js';
import { setCardCollapsed } from '../frontend/js/collapsible-cards.js';

const source = readFileSync(new URL('../frontend/js/schedule-page.js', import.meta.url), 'utf8');
function extract(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing view function: ${start}`);
  return source.slice(from, to);
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));

test('opening expands the target day once; later snapshots never move the user', () => {
  const actions = [], frames = [], day = {};
  const context = vm.createContext({
    ...scheduleModel, openingPositionApplied:false, pageInteracted:false, pageBlocked:false,
    CSS:{ escape:String }, canManageSchedule, currentUser:{role:'evaluator'},
    requestAnimationFrame:fn => frames.push(fn),
    setCardCollapsed:(card, collapsed) => actions.push(['expand', card === day, collapsed]),
    document:{querySelector:() => ({ closest:() => day, scrollIntoView:() => actions.push(['scroll']) })}
  });
  vm.runInContext(extract('function positionScheduleOnOpen(', 'function stationOptions('), context);
  context.positionScheduleOnOpen([], 'Asia/Jerusalem');
  assert.equal(frames.length, 0);
  const entries = [{id:'a', date:'2026-01-01', startMinute:60}];
  context.positionScheduleOnOpen(entries, 'Asia/Jerusalem');
  frames.shift()();
  assert.deepEqual(actions, [['expand',true,false],['scroll']]);
  context.positionScheduleOnOpen(entries, 'Asia/Jerusalem');
  assert.equal(frames.length, 0);
});

test('a user interaction or a failure before the animation frame cancels automatic scrolling', () => {
  for (const flag of ['pageInteracted', 'pageBlocked']) {
    let frame;
    const context = vm.createContext({
      ...scheduleModel, openingPositionApplied:false, pageInteracted:false, pageBlocked:false,
      requestAnimationFrame:fn => { frame = fn; },
      document:{querySelector:() => assert.fail('must not scroll after user takes control or loading fails')}
    });
    vm.runInContext(extract('function positionScheduleOnOpen(', 'function stationOptions('), context);
    context.positionScheduleOnOpen([{id:'a', date:'2026-01-01', startMinute:60}]);
    context[flag] = true;
    frame();
  }
});

test('manager opening expands the matrix day, rather than using team-card state', () => {
  const actions = [];
  const context = vm.createContext({
    ...scheduleModel, openingPositionApplied:false, pageInteracted:false, pageBlocked:false,
    CSS:{escape:String}, canManageSchedule, currentUser:{role:'formation_commander'},
    requestAnimationFrame:fn => fn(),
    setMatrixDayCollapsed:(date, value) => actions.push([date,value]),
    document:{querySelector:() => ({scrollIntoView:() => actions.push('scrolled')})}
  });
  vm.runInContext(extract('function positionScheduleOnOpen(', 'function stationOptions('), context);
  context.positionScheduleOnOpen([{id:'a',date:'2026-01-01',startMinute:60}]);
  assert.deepEqual(actions, [['2026-01-01',false], 'scrolled']);
});

function initContext(role = 'evaluator') {
  const types = deferred(), teams = deferred(), calls = [], nodes = {};
  const context = vm.createContext({
    ...scheduleModel, canManageSchedule, roleLabel,
    db:{}, currentUser:{uid:'u',role,team:'01'}, activeEvent:null, eventTeams:{}, repository:null,
    scheduleMetadataReady:false, pageBlocked:false, latestWorkspace:{published:{revision:1}},
    stationTypesRead:types.promise, eventTeamsRead:teams.promise,
    messageCenter:null, foreground:{}, mountMessageCenter:() => ({dispose(){}}),
    updateBackLink(){}, markLoad(){}, activeEventIdFromPointer:() => 'e',
    loadEvent:async () => ({id:'e',status:'active',name:'test'}),
    createScheduleRepository:() => ({}), subscribeToSchedule:() => calls.push('subscribe'),
    refreshTeamStationDetails:() => calls.push('enrich'), updateTeamClock:() => calls.push('clock'),
    receiveWorkspace:() => calls.push('workspace'), showBlocking:() => calls.push('blocked'),
    window:{toggleNewRowLabel(){}},
    document:{querySelector:() => ({}), getElementById:id => nodes[id] ||= {hidden:true}}
  });
  vm.runInContext(extract('async function initializePage(', 'window.logout ='), context);
  return { context, calls, nodes, types, teams };
}

test('the schedule subscribes before slow station types or team metadata; enrichment does not rerender the list', async () => {
  const { context, calls, types, teams } = initContext();
  const initialized = context.initializePage(Promise.resolve({exists:() => false}));
  await settle();
  assert.deepEqual(calls, ['subscribe']);
  assert.equal(context.scheduleMetadataReady, false);
  teams.resolve({value:{'01':{stationMap:{'01':'sprints'}}}});
  await settle();
  assert.deepEqual(calls, ['subscribe']);
  types.resolve(true);
  await initialized;
  assert.deepEqual(calls, ['subscribe','enrich','clock']);
  assert.equal(context.scheduleMetadataReady, true);
});

test('metadata failure keeps the read-only team schedule but never unlocks manager editing', async () => {
  for (const role of ['evaluator', 'formation_commander']) {
    const { context, calls, nodes, types, teams } = initContext(role);
    const initialized = context.initializePage(Promise.resolve());
    types.resolve(true); teams.resolve({error:new Error('offline')});
    await initialized;
    assert.equal(context.scheduleMetadataReady, false);
    assert.deepEqual(calls, role === 'evaluator' ? ['subscribe'] : ['subscribe','blocked']);
    if (role === 'evaluator') assert.equal(nodes['schedule-details-warning'].hidden, false);
  }
});

test('a late metadata response cannot reopen a page whose schedule failed', async () => {
  const { context, calls, types, teams } = initContext('admin');
  const initialized = context.initializePage(Promise.resolve());
  await settle();
  context.pageBlocked = true;
  types.resolve(true); teams.resolve({value:{'01':{}}});
  await initialized;
  assert.deepEqual(calls, ['subscribe']);
});

test('clock updates preserve list nodes and avoid replacing an unchanged summary', () => {
  let writes = 0;
  const card = {dataset:{}, set innerHTML(value) { writes++; }};
  const badge = {}, row = {dataset:{scheduleRow:'next'},querySelector:() => badge};
  const context = vm.createContext({
    ...scheduleModel, teamProjection:{team:'01',entries:[
      {id:'now',date:'2026-11-04',startMinute:600,kind:'global',label:'מנוחה'},
      {id:'next',date:'2026-11-04',startMinute:660,kind:'global',label:'סיום'}
    ]}, currentUser:{team:'01'}, pad2:String, escapeHtml:String,
    applyCurrentRowHighlight(){},
    document:{getElementById:id => {
      assert.equal(id, 'team-current-card'); return card;
    }, querySelectorAll:() => [row]}
  });
  vm.runInContext(extract('function updateTeamClock(', 'function receiveWorkspace('), context);
  context.updateTeamClock(new Date('2026-11-04T10:10:00+02:00'));
  context.updateTeamClock(new Date('2026-11-04T10:10:30+02:00'));
  assert.equal(writes, 1);
  assert.equal(badge.hidden, false);
  context.updateTeamClock(new Date('2026-11-04T11:00:00+02:00'));
  assert.equal(badge.hidden, true);
});

test('programmatic card expansion updates accessibility without writing a preference', () => {
  const attributes = {}, classes = new Set(['is-collapsed']);
  const button = {dataset:{cardTitle:'יום שני'},setAttribute:(key,value) => {attributes[key] = value;}};
  const card = {querySelector:() => button, classList:{toggle:(name,on) => on ? classes.add(name) : classes.delete(name)}};
  setCardCollapsed(card, false);
  assert.equal(classes.has('is-collapsed'), false);
  assert.equal(attributes['aria-expanded'], 'true');
  assert.equal(attributes['aria-label'], 'כווץ: יום שני');
});

test('the direct schedule link stays outside the menu and uses the existing guarded link navigation', () => {
  const app = readFileSync(new URL('../frontend/app.html', import.meta.url), 'utf8');
  const nav = app.slice(app.indexOf('<nav class="navbar">'), app.indexOf('<div class="app-menu-wrap"'));
  assert.match(nav, /<a href="schedule.html"[^>]*>🗓️ לו״ז<\/a>/);
  assert.match(app, /if \(hasPendingArrivals\(\)\) \{\s*event.preventDefault\(\);/);
});

test('the schedule shortcut flushes debounced counts, blocks failed saves, and does not delay ordinary navigation', async () => {
  const app = readFileSync(new URL('../frontend/app.html', import.meta.url), 'utf8');
  const handler = app.slice(app.indexOf('  let scheduleNavigationPending = false;'), app.indexOf('  function detachEvaluatorArrivalSubscription('));
  for (const scenario of ['none','saved','failed','arrivals','round','new-tab']) {
    let click, saved = 0, prevented = 0;
    const window = {location:{href:'http://localhost/app.html'}};
    const context = vm.createContext({
      window, location:new URL(window.location.href), URL,
      repsSavePromise:null, pendingRepsByRace:scenario === 'none' ? {} : {r:{'1':1}},
      hasPendingArrivals:() => scenario === 'arrivals', showToast(){},
      // התחלה/עצירת סבב שעוד לא הגיעה לשרת חוסמת יציאה כמו סדר הגעה
      hasPendingRaceWrites:() => scenario === 'round',
      commitPendingReps:async () => { saved++; return scenario !== 'failed'; },
      document:{addEventListener:(type, fn) => { click = fn; }}
    });
    vm.runInContext(handler, context);
    await click({
      target:{closest:() => ({href:'http://localhost/schedule.html'})},
      ctrlKey:scenario === 'new-tab', preventDefault:() => { prevented++; }
    });
    assert.equal(saved, ['saved','failed'].includes(scenario) ? 1 : 0, scenario);
    assert.equal(prevented, ['saved','failed','arrivals','round'].includes(scenario) ? 1 : 0, scenario);
    assert.equal(window.location.href, scenario === 'saved' ? 'http://localhost/schedule.html' : 'http://localhost/app.html', scenario);
  }
});
