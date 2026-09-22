import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../frontend/js/event-setup-page.js', import.meta.url), 'utf8');
const busyFunction = source.slice(source.indexOf('function setBusy('), source.indexOf('\nfunction defaultStationMap'));
const actions = ['save-details', 'save-teams', 'import-schedule', 'save-candidates', 'import-candidates', 'save-staff'];

// Run the production handlers with isolated storage, never with a live Firebase project.
function setup(action, fail) {
  let handler;
  let calls = 0;
  const messages = [];
  const operation = async () => {
    calls += 1;
    if (fail) throw new Error('storage unavailable');
  };
  const button = { textContent:'שמירה', dataset:{}, disabled:false };
  const element = { value:'01', files:[{ name:'test.xlsx' }], addEventListener:(_, callback) => { handler = callback; } };
  const context = {
    document:{ getElementById:() => element, querySelectorAll:() => [] },
    repository:{ saveDetails:operation, replaceTeamCandidates:operation, replaceStaff:operation },
    currentEventId:'test-event',
    refreshBundle:async () => {},
    showToast:(...args) => messages.push(args),
    teamIdsFromInput:() => ['01'], saveTeamTopology:operation,
    selectedStaffFromDom:() => [], workbookMatrix:operation,
    candidateRowsFromMatrix:() => ({ rows:[], errors:[] })
  };
  const start = source.indexOf(`document.getElementById('${action}-button').addEventListener`);
  assert.notEqual(start, -1);
  const end = source.indexOf('\n});', start) + '\n});'.length;
  runInNewContext(`${busyFunction}\n${source.slice(start, end)}`, context);
  return { button, messages, calls:() => calls, async click() {
    const event = { currentTarget:button };
    const pending = handler(event);
    // Browsers clear currentTarget when synchronous event dispatch ends.
    event.currentTarget = null;
    assert.equal(button.disabled, true);
    await pending;
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'שמירה');
  } };
}

for (const action of actions) {
  test(`${action}: a failed async operation restores the button and permits retry`, async () => {
    const ui = setup(action, true);
    await ui.click();
    await ui.click();
    assert.equal(ui.calls(), 2);
    assert.equal(ui.messages.length, 2);
    assert.ok(ui.messages.every(([message, type]) => message === 'storage unavailable' && type === 'error'));
  });
}

for (const action of actions.filter(action => !action.startsWith('import-'))) {
  test(`${action}: successful async saving restores the button`, async () => {
    const ui = setup(action, false);
    await ui.click();
    assert.equal(ui.calls(), 1);
    assert.equal(ui.messages[0][1], 'success');
  });
}

for (const conflict of [false, true]) {
  test(`activation publishes the current draft before activating; conflict=${conflict}`, async () => {
    let handler;
    const calls = [];
    const button = { textContent:'הפעל', dataset:{}, disabled:false };
    const start = source.indexOf("document.getElementById('activate-event-button').addEventListener");
    const end = source.indexOf('\n});', start) + '\n});'.length;
    runInNewContext(`${busyFunction}\n${source.slice(start, end)}`, {
      document:{ getElementById:() => ({ addEventListener:(_, callback) => { handler = callback; } }) },
      currentEventId:'test-event',
      bundle:{ publishedSchedule:{ revision:3 }, schedule:{ draftRevision:7 } },
      readiness:() => ({ canActivate:true, warnings:[] }),
      teamIds:() => ['01'], stationMapForTeam:() => ({ '01':'sprints' }),
      activeStaff:() => [],
      scheduleRepository:{ publishDraft:async options => {
        calls.push('publish');
        assert.equal(options.expectedPublishedRevision, 3);
        assert.equal(options.expectedDraftRevision, 7);
        if (conflict) throw new Error('schedule changed');
      } },
      repository:{ activate:async () => { calls.push('activate'); } },
      refreshBundle:async () => {}, showToast:() => {}
    });
    const event = { currentTarget:button };
    const pending = handler(event);
    event.currentTarget = null;
    await pending;
    assert.deepEqual(calls, conflict ? ['publish'] : ['publish', 'activate']);
    assert.equal(button.disabled, false);
  });
}
