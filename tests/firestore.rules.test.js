import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  initializeTestEnvironment, assertSucceeds, assertFails
} from '@firebase/rules-unit-testing';
import {
  collection, doc, getDoc, getDocs, query, where,
  addDoc, deleteDoc, setDoc, updateDoc, serverTimestamp, Timestamp, runTransaction, writeBatch
} from 'firebase/firestore';
import {
  buildIssueReportData, ISSUE_REPORT_SCHEMA_VERSION
} from '../frontend/js/issue-report.js';
import { createEventSetupRepository } from './helpers/event-setup-repository.js';
import { createScheduleRepository } from './helpers/schedule-repository.js';
import { createArrivalRepository } from './helpers/arrival-repository.js';
import { createMessagesRepository } from './helpers/messages-repository.js';
import { createEvaluationRepository } from './helpers/evaluation-repository.js';
import { createIntakeRepository, IntakeMoveBlockedError } from './helpers/intake-repository.js';
import { candidateRowsFromMatrix, buildCandidateRosterImport } from '../frontend/js/candidate-roster-import.js';

const PROJECT_ID = 'demo-race-webapp-lite';
let testEnv;

const arrivalState = (race, value) => value || { participantIds:race.participantIds, order:[], slotTimes:{} };
const arrivalReference = (db, uid = 'evaluator1') => doc(db, 'races', 'race_01_07_1', 'evaluatorArrivals', uid);

test('arrival repository is idempotent, captures identity, separates evaluators and preserves place times on historical reorder', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), 'races', 'race_01_07_1'), {
      participantIds:['100','320','8'], status:'stopped'
    });
  });
  const db = userDb('evaluator1'), identity = {uid:'evaluator1'};
  const repo = createArrivalRepository(db, identity, arrivalState);
  identity.uid = 'evaluator2'; // a later auth mutation must not retarget an in-flight writer
  const append = pid => repo.mutate('race_01_07_1', {type:'append', pid});
  await append('100');
  const first = (await getDoc(arrivalReference(db))).data();
  assert.equal(first.revision, 1);
  await append('100');
  assert.equal((await getDoc(arrivalReference(db))).data().revision, 1);
  await append('320'); await append('8');
  const complete = (await getDoc(arrivalReference(db))).data();
  assert.equal(complete.revision, 3);
  assert.ok(complete.completedAt.toMillis() > 0);
  await repo.mutate('race_01_07_1', {type:'reorder', order:['8','320','100'], expectedRevision:3});
  const reordered = (await getDoc(arrivalReference(db))).data();
  assert.deepEqual(reordered.order, ['8','320','100']);
  assert.deepEqual(reordered.slotTimes, complete.slotTimes);
  assert.deepEqual(reordered.completedAt, complete.completedAt);
  await assert.rejects(repo.mutate('race_01_07_1', {type:'reorder', order:['100','320','8'], expectedRevision:3}), /השתנה/);
  await assert.rejects(append('999'), /ברשימת הסבב/);
  const db2 = userDb('evaluator2');
  await createArrivalRepository(db2, {uid:'evaluator2'}, arrivalState).mutate('race_01_07_1', {type:'append',pid:'8'});
  assert.deepEqual((await getDoc(arrivalReference(db2,'evaluator2'))).data().order, ['8']);
  await assertFails(getDoc(arrivalReference(db2)));
  await assertFails(getDoc(arrivalReference(userDb('operator1'))));
});

test('atomic placement inserts and unmarks arrivals in historical rounds with fixed place timestamps', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(),'races','race_01_07_1'), {participantIds:['100','320','8'],status:'stopped'});
  });
  const db=userDb('evaluator1'), repo=createArrivalRepository(db,{uid:'evaluator1'},arrivalState);
  await repo.mutate('race_01_07_1',{type:'append',pid:'100'});
  await repo.mutate('race_01_07_1',{type:'append',pid:'320'});
  const original=(await getDoc(arrivalReference(db))).data();
  await repo.mutate('race_01_07_1',{type:'place',pid:'8',targetIndex:0,expectedRevision:2});
  const complete=(await getDoc(arrivalReference(db))).data();
  assert.deepEqual(complete.order,['8','100','320']);
  assert.equal(complete.revision,3);
  assert.deepEqual(complete.slotTimes['1'],original.slotTimes['1']);
  assert.deepEqual(complete.slotTimes['2'],original.slotTimes['2']);
  assert.ok(complete.completedAt.toMillis()>0);
  await assert.rejects(repo.mutate('race_01_07_1',{type:'place',pid:'100',targetIndex:null,expectedRevision:2}),/השתנה/);
  await repo.mutate('race_01_07_1',{type:'place',pid:'100',targetIndex:null,expectedRevision:3});
  const undone=(await getDoc(arrivalReference(db))).data();
  assert.deepEqual(undone.order,['8','320']);
  assert.deepEqual(undone.slotTimes,original.slotTimes);
  assert.equal('completedAt' in undone,false);
  await repo.mutate('race_01_07_1',{type:'place',pid:'100',targetIndex:1,expectedRevision:4});
  const redone=(await getDoc(arrivalReference(db))).data();
  assert.deepEqual(redone.order,['8','100','320']);
  assert.equal(redone.revision,5);
  assert.ok(redone.completedAt.toMillis()>=complete.completedAt.toMillis());
  await assertFails(createArrivalRepository(userDb('operator1'),{uid:'operator1'},arrivalState)
    .mutate('race_01_07_1',{type:'place',pid:'8',targetIndex:0,expectedRevision:0}));
});

test('concurrent arrival transactions retain both marks and duplicate commands add only one place', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(),'races','race_01_07_1'), {participantIds:['100','320','8']});
  });
  const db = userDb('evaluator1');
  const repo = createArrivalRepository(db,{uid:'evaluator1'},arrivalState);
  await Promise.all(['100','320','100'].map(pid => repo.mutate('race_01_07_1',{type:'append',pid})));
  const data = (await getDoc(arrivalReference(db))).data();
  assert.deepEqual([...data.order].sort(), ['100','320']);
  assert.equal(data.revision, 2);
  assert.equal(Object.keys(data.slotTimes).length, 2);
});

test('arrival revision upgrades legacy documents and rejects stale or unversioned replacements even by admin', async () => {
  const db = userDb('evaluator1'), ref = arrivalReference(db);
  const legacy = {
    evaluatorUid:'evaluator1', participantIds:['100'], order:[], slotTimes:{},
    schemaVersion:1, createdAt:serverTimestamp(), updatedAt:serverTimestamp()
  };
  await assertFails(setDoc(ref,{...legacy,revision:0}));
  await assertFails(setDoc(ref,{...legacy,revision:2}));
  await assertSucceeds(setDoc(ref,legacy));
  await assertSucceeds(updateDoc(ref,{updatedAt:serverTimestamp()}));
  await createArrivalRepository(db,{uid:'evaluator1'},arrivalState).mutate('race_01_07_1',{type:'append',pid:'100'});
  const upgraded = (await getDoc(ref)).data();
  assert.equal(upgraded.revision,1);
  const {revision, ...withoutRevision} = upgraded;
  await assertFails(setDoc(ref,{...withoutRevision,updatedAt:serverTimestamp()}));
  await assertFails(updateDoc(ref,{revision:1,updatedAt:serverTimestamp()}));
  await assertFails(updateDoc(ref,{revision:3,updatedAt:serverTimestamp()}));
  await assertFails(updateDoc(ref,{revision:2.5,updatedAt:serverTimestamp()}));
  const adminRef = arrivalReference(userDb('admin1'));
  await assertFails(setDoc(adminRef,{...withoutRevision,updatedAt:serverTimestamp()}));
  await assertFails(updateDoc(adminRef,{revision:0,updatedAt:serverTimestamp()}));
  await assertSucceeds(updateDoc(ref,{revision:2,updatedAt:serverTimestamp()}));
});

test('source workbook headers import all ten teams without a schedule, with a private diagnostic record', async () => {
  const db=userDb('admin1');
  const repo=createEventSetupRepository(db,{uid:'admin1',role:'admin'},{stationMapFactory:()=>({'01':'sprints'})});
  const id=await repo.createDraft('ייבוא לפני לוז');
  const rows=Array.from({length:140},(_,i)=>[Math.floor(i/14)+1,i+1,'ישראל','ישראלי']);
  const adapted=candidateRowsFromMatrix([['צוות','מספר מועמד','שם פרטי','שם משפחה'],...rows]);
  const imported=buildCandidateRosterImport({rows:adapted.rows,allowIncompleteProfiles:true,source:{type:'excel'}});
  await repo.importCandidates(id,imported.teams,imported.source);
  assert.equal((await getDocs(collection(db,'events',id,'candidates'))).size,140);
  assert.equal((await getDocs(collection(db,'events',id,'teams'))).size,10);
  assert.equal((await getDoc(doc(db,'events',id))).data().candidateCount,140);
  assert.equal((await getDoc(doc(db,'events',id,'candidates','01_1'))).data().fullName,'ישראל ישראלי');
  assert.deepEqual((await getDoc(doc(db,'events',id,'teams','01'))).data().stationMap,{'01':'sprints'});
  const attempts=await getDocs(collection(db,'events',id,'rosterImports'));
  assert.equal(attempts.size,1);
  assert.equal(attempts.docs[0].data().status,'complete');
  assert.equal(attempts.docs[0].data().completedTeams,10);
  assert.ok(!('fullName' in attempts.docs[0].data()));
  await assertFails(getDocs(collection(userDb('evaluator1'),'events',id,'rosterImports')));
  await assertFails(updateDoc(doc(db,'events',id),{status:'active'}));
  await assert.rejects(repo.activate(id,{canActivate:true,counts:{teams:10,candidates:140}},[]),/לו״ז/);
  await repo.importCandidates(id,imported.teams,imported.source);
  assert.equal((await getDocs(collection(db,'events',id,'candidates'))).size,140);
  assert.equal((await getDoc(doc(db,'events',id))).data().rosterRevision,1);
});

test('schedule can publish and restore legacy load metadata without load checks; activation needs publication', async () => {
  const db=userDb('admin1'), user={uid:'admin1',role:'admin'};
  const setup=createEventSetupRepository(db,user), schedules=createScheduleRepository(db,user);
  const id=await setup.createDraft('לו״ז בלי עומס');
  const schedule={teamIds:['01'],commanderNames:{},rows:[{id:'r1',date:'2026-10-06',startMinute:60,kind:'global',label:'פתיחה',assignments:{}}],loadWarnings:[{code:'rolling_load'}],overrideReason:''};
  await schedules.saveDraft({eventId:id,schedule,expectedPublishedRevision:0,expectedDraftRevision:0,ensureTeamStationMaps:{'01':{'01':'sprints'}}});
  assert.equal((await getDoc(doc(db,'events',id,'teams','01'))).exists(),true);
  await assert.rejects(schedules.saveDraft({eventId:id,schedule:{...schedule,teamIds:['01','02']},expectedPublishedRevision:0,expectedDraftRevision:0,ensureTeamStationMaps:{'01':{},'02':{}}}),/הלו״ז השתנה/);
  assert.equal((await getDoc(doc(db,'events',id,'teams','02'))).exists(),false);
  await assertFails(updateDoc(doc(db,'events',id),{status:'active'}));
  await schedules.publishDraft({eventId:id,expectedPublishedRevision:0,expectedDraftRevision:1});
  let master=(await getDoc(doc(db,'events',id,'schedule','master'))).data();
  assert.ok(!('loadWarnings' in master));
  assert.ok(!('loadPolicy' in master));
  assert.ok(!('overrideReason' in master));
  await testEnv.withSecurityRulesDisabled(async context=>{
    await updateDoc(doc(context.firestore(),'events',id,'scheduleRevisions','r-000001'),{loadWarnings:[{code:'rolling_load'}],overrideReason:'ישן'});
  });
  await schedules.restoreRevision({eventId:id,revisionKey:'r-000001',expectedPublishedRevision:1,expectedDraftRevision:2});
  master=(await getDoc(doc(db,'events',id,'schedule','master'))).data();
  assert.equal(master.revision,2);
  assert.ok(!('loadWarnings' in master));
  await assertSucceeds(updateDoc(doc(db,'events',id),{status:'active'}));
});

// Profile correction belongs to intake: admin, formation commander and
// adjutancy. Team staff (operator/evaluator) still cannot change identities.
test('full names are editable by intake roles only and protected by profile revision', async () => {
  const patch={firstName:'ישראל ישראלי',fullName:'ישראל ישראלי',profileRevision:1,profileUpdatedAt:serverTimestamp(),profileUpdatedBy:'admin1'};
  await assertFails(updateDoc(doc(userDb('operator1'),'events','event-1','candidates','01_100'),{...patch,profileUpdatedBy:'operator1'}));
  await assertFails(updateDoc(doc(userDb('evaluator1'),'events','event-1','candidates','01_100'),{...patch,profileUpdatedBy:'evaluator1'}));
  await assertFails(updateDoc(doc(userDb('adjutantPending'),'events','event-1','candidates','01_100'),{...patch,profileUpdatedBy:'adjutantPending'}));
  await assertFails(updateDoc(doc(userDb('formation1'),'events','event-1','candidates','01_100'),{...patch,profileUpdatedBy:'admin1'}));
  await assertSucceeds(updateDoc(doc(userDb('admin1'),'events','event-1','candidates','01_100'),patch));
  await assertSucceeds(updateDoc(doc(userDb('formation1'),'events','event-1','candidates','01_100'),{...patch,profileRevision:2,profileUpdatedBy:'formation1'}));
  await assertSucceeds(updateDoc(doc(userDb('adjutant1'),'events','event-1','candidates','01_100'),{...patch,profileRevision:3,profileUpdatedBy:'adjutant1'}));
  await assertFails(updateDoc(doc(userDb('adjutant1'),'events','event-1','candidates','01_100'),{...patch,profileRevision:3,profileUpdatedBy:'adjutant1'}));
  await assertFails(updateDoc(doc(userDb('adjutant1'),'events','event-1','candidates','01_100'),{status:'withdrawn',profileRevision:4,profileUpdatedAt:serverTimestamp(),profileUpdatedBy:'adjutant1'}));
  // The next revision passes, so the two failures below fail on shape only.
  await assertSucceeds(updateDoc(doc(userDb('admin1'),'events','event-1','candidates','01_100'),{...patch,profileRevision:4}));
  await assertFails(updateDoc(doc(userDb('admin1'),'events','event-1','candidates','01_100'),{...patch,fullName:'x'.repeat(81),profileRevision:5}));
  await assertFails(updateDoc(doc(userDb('admin1'),'events','event-1','candidates','01_100'),{...patch,fullName:'שם אחר',profileRevision:5}));
});

test('manual team creation is atomic and keeps existing candidate lists intact', async () => {
  const db=userDb('admin1');
  const repo=createEventSetupRepository(db,{uid:'admin1',role:'admin'});
  await repo.ensureTeams('event-1',['01','02','03'],()=>({'01':'sprints'}));
  assert.deepEqual((await getDoc(doc(db,'events','event-1','teams','01'))).data().participantIds,['100']);
  assert.deepEqual((await getDoc(doc(db,'events','event-1','teams','03'))).data().stationMap,{'01':'sprints'});
  assert.equal((await getDoc(doc(db,'events','event-1'))).data().teamCount,3);
  await repo.ensureTeams('event-1',['03'],()=>({}));
  assert.equal((await getDoc(doc(db,'events','event-1'))).data().teamCount,3);
});

function userDb(uid) {
  return testEnv.authenticatedContext(uid).firestore();
}

function candidatePayload({ participantId, team, firstName, nationalId }) {
  return {
    participantId, team, firstName, nationalId,
    emergencyContactPhone: '0501234567', doctorClearance: 1, medicClearance: 0,
    status: 'active', reasonCode: '', reasonLabel: '', statusRevision: 0,
    profileRevision: 0, lastTransitionId: '',
    statusChangedAt: Timestamp.now(), statusChangedBy: 'admin1',
    profileUpdatedAt: Timestamp.now(), profileUpdatedBy: 'admin1', schemaVersion: 3
  };
}

async function seedData() {
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    const users = {
      admin1: { uid: 'admin1', name: 'מנהל', role: 'admin', team: 1, approved: true },
      operator1: { uid: 'operator1', name: 'מפקצ 1', role: 'operator', team: 1, approved: true },
      operator2: { uid: 'operator2', name: 'מפקצ 2', role: 'operator', team: 2, approved: true },
      evaluator1: { uid: 'evaluator1', name: 'מעריך 1', role: 'evaluator', team: 1, approved: true },
      evaluator2: { uid: 'evaluator2', name: 'מעריך 2', role: 'evaluator', team: 1, approved: true },
      formation1: { uid: 'formation1', name: 'מפקד הגיבוש', role: 'formation_commander', team: null, approved: true },
      adjutant1: { uid: 'adjutant1', name: 'שלישות 1', role: 'adjutant', team: null, approved: true },
      adjutant2: { uid: 'adjutant2', name: 'שלישות 2', role: 'adjutant', team: null, approved: true },
      adjutantPending: { uid: 'adjutantPending', name: 'שלישות ממתין', role: 'adjutant', team: null, approved: false }
    };
    for (const [uid, data] of Object.entries(users)) {
      await setDoc(doc(db, 'users', uid), data);
    }
    await setDoc(doc(db, 'settings', 'activeEvent'), {
      eventId: 'event-1', status: 'active', schemaVersion: 3
    });
    await setDoc(doc(db, 'events', 'event-1'), {
      name: 'אירוע בדיקה', status: 'active', schemaVersion: 3
    });
    await setDoc(doc(db, 'events', 'event-1', 'teams', '01'), {
      teamNumber: '01', participantIds: ['100'], stationMap: {}, schemaVersion: 3
    });
    await setDoc(doc(db, 'events', 'event-1', 'teams', '02'), {
      teamNumber: '02', participantIds: ['200'], stationMap: {}, schemaVersion: 3
    });
    await setDoc(doc(db, 'events', 'event-1', 'candidates', '01_100'), candidatePayload({
      participantId: '100', team: '01', firstName: 'נועה', nationalId: '000000018'
    }));
    await setDoc(doc(db, 'events', 'event-1', 'candidates', '02_200'), candidatePayload({
      participantId: '200', team: '02', firstName: 'יובל', nationalId: '123456782'
    }));
    await setDoc(doc(db, 'races', 'race_01_07_1'), {
      eventId: 'event-1', team: '01', station: '07', round: 1, status: 'running',
      startedAt: Timestamp.fromMillis(Date.now() - 10_000), startedBy: 'operator1',
      timeLimitSeconds: 2400, participantIds: ['100'], tags: [], evaluationSchemaVersion: 2
    });
    await setDoc(doc(db, 'races', 'legacy-race'), {
      team: '01', station: '07', round: 8, status: 'stopped',
      participantIds: ['100'], tags: []
    });
  });
}

function racePayload({ withLimit = true } = {}) {
  return {
    eventId: 'event-1', team: '01', station: '07', round: withLimit ? 2 : 3, status: 'running',
    startedAt: serverTimestamp(), startedBy: 'operator1', participantIds: ['100'], tags: [],
    ...(withLimit ? { timeLimitSeconds: 2400 } : {})
  };
}

function recommendationPayload() {
  return {
    participantId: '100', team: '01', reasonCode: 'medical', reasonLabel: 'רפואי',
    details: 'נבדק על ידי החובש', status: 'open',
    recommendedBy: 'operator1', recommendedByName: 'מפקצ 1', revision: 1,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    resolvedAt: null, resolvedBy: '', schemaVersion: 1
  };
}

function issuePayload(overrides = {}) {
  const report = buildIssueReportData({
    eventId: 'event-1',
    draft: { category: 'timing', description: 'השעון לא מגיב', steps: '' },
    reporter: { uid: 'evaluator1', name: 'מעריך 1', role: 'evaluator', team: 1 },
    context: {
      team: '01', station: '07', stationType: 'pullup', stationName: 'מתח',
      viewedRaceId: 'race_01_07_1', latestRaceId: 'race_01_07_1', round: 1,
      raceStatus: 'running', effectiveElapsedMs: 10_000, historicalView: false
    },
    environment: { appVersion: 'test', online: true, viewport: '390x844', userAgent: 'test' }
  });
  return { ...report, ...overrides, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
}

function assessmentPayload(uid = 'evaluator1') {
  return {
    evaluatorUid: uid,
    entries: {
      '100': {
        scores: { resilience: 6 }, measurement: 4,
        comments: [{ id: 'note-1', text: 'יציב', authorUid: uid, authorName: 'מעריך', createdAt: 1, updatedAt: 1 }],
        clearedScores: [], measurementCleared: false, hiddenCommentIds: []
      }
    },
    schemaVersion: 2, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  };
}

function privateNotesPayload(uid = 'evaluator1') {
  return {
    authorUid: uid, team: '01', participantId: '100',
    notes: [{ id: 'general-1', text: 'הערה אישית', authorUid: uid, authorName: 'מעריך', createdAt: 1, updatedAt: 1 }],
    schemaVersion: 2, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  };
}

function masterSchedulePayload(uid = 'formation1', revision = 1) {
  return {
    eventId: 'event-1', teamIds: ['01', '02'],
    commanderNames: { '01': 'שחר', '02': 'ברוס' },
    rows: [{
      id: 'row-1', date: '2026-08-24', startMinute: 190, kind: 'rotation', label: '',
      assignments: {
        '01': { stationId: '04', routeNumber: '1' },
        '02': { stationId: '02', routeNumber: '3' }
      }
    }],
    loadPolicy: { windowMinutes: 120, maxWindowLoad: 6, highIntensity: 3, maxConsecutiveHigh: 1 },
    loadWarnings: [], overrideReason: '', revision,
    revisionKey: `r-${String(revision).padStart(6, '0')}`, schemaVersion: 1,
    publicationType: 'publish', restoredFromRevisionKey: '',
    timeZone: 'Asia/Jerusalem', createdAt: serverTimestamp(), createdBy: uid,
    updatedAt: serverTimestamp(), updatedBy: uid
  };
}

function draftSchedulePayload(uid = 'formation1', draftRevision = 1, baseRevision = 0) {
  const master = masterSchedulePayload(uid, Math.max(1, baseRevision));
  return {
    eventId:master.eventId, teamIds:master.teamIds, commanderNames:master.commanderNames,
    rows:master.rows, loadPolicy:master.loadPolicy, loadWarnings:master.loadWarnings,
    overrideReason:master.overrideReason, baseRevision, draftRevision,
    schemaVersion:1, timeZone:'Asia/Jerusalem',
    createdAt:serverTimestamp(), createdBy:uid, updatedAt:serverTimestamp(), updatedBy:uid
  };
}

function teamSchedulePayload(team, uid = 'formation1', revision = 1) {
  const stationId = team === '01' ? '04' : '02';
  return {
    eventId: 'event-1', team, commanderName: team === '01' ? 'שחר' : 'ברוס',
    entries: [{
      id: 'row-1', date: '2026-08-24', startMinute: 190, kind: 'rotation',
      label: '', stationId, routeNumber: team === '01' ? '1' : '3'
    }],
    sourceRevision: revision, schemaVersion: 1, timeZone: 'Asia/Jerusalem',
    updatedAt: serverTimestamp(), updatedBy: uid
  };
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: await readFile(new URL('../firestore.rules', import.meta.url), 'utf8') }
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seedData();
});

after(async () => {
  await testEnv?.cleanup();
});

test('only the own-team commander can create and stop a race', async () => {
  const operator = userDb('operator1');
  await assertSucceeds(setDoc(doc(operator, 'races', 'race_01_07_2'), racePayload()));
  await assertFails(setDoc(doc(operator, 'races', 'race_01_07_identity_leak'), {
    ...racePayload(), round: 5, firstName: 'נועה', nationalId: '000000018'
  }));
  await assertSucceeds(updateDoc(doc(operator, 'races', 'race_01_07_1'), {
    status: 'stopped', endedAt: serverTimestamp(), endedBy: 'operator1', endedReason: 'manual'
  }));

  await assertFails(setDoc(doc(userDb('evaluator1'), 'races', 'race_01_07_4'), {
    ...racePayload(), round: 4, startedBy: 'evaluator1'
  }));
  await assertFails(updateDoc(doc(userDb('operator2'), 'races', 'race_01_07_1'), {
    status: 'stopped', endedAt: serverTimestamp(), endedBy: 'operator2', endedReason: 'manual'
  }));
});

test('active-event staffing is the source of truth for operational role and team', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await updateDoc(doc(db, 'events', 'event-1'), { setupSchemaVersion:1 });
    await updateDoc(doc(db, 'settings', 'activeEvent'), { eventStaffingSchemaVersion:1 });
    await setDoc(doc(db, 'events', 'event-1', 'staff', 'evaluator1'), {
      eventId:'event-1', uid:'evaluator1', displayName:'מפקצית משובצת',
      role:'operator', team:'02', active:true,
      createdAt:Timestamp.now(), createdBy:'admin1', updatedAt:Timestamp.now(), updatedBy:'admin1'
    });
    await setDoc(doc(db, 'events', 'event-1', 'staff', 'operator2'), {
      eventId:'event-1', uid:'operator2', displayName:'מעריך משובץ',
      role:'evaluator', team:'01', active:true,
      createdAt:Timestamp.now(), createdBy:'admin1', updatedAt:Timestamp.now(), updatedBy:'admin1'
    });
  });

  await assertSucceeds(setDoc(doc(userDb('evaluator1'), 'races', 'event-role-race'), {
    eventId:'event-1', team:'02', station:'07', round:2, status:'running',
    startedAt:serverTimestamp(), startedBy:'evaluator1', participantIds:['200'], tags:[],
    timeLimitSeconds:2400, evaluationSchemaVersion:2
  }));
  await assertSucceeds(updateDoc(doc(userDb('evaluator1'), 'races', 'event-role-race'), {
    status:'stopped', endedAt:serverTimestamp(), endedBy:'evaluator1', endedReason:'manual'
  }));
  await assertFails(setDoc(doc(userDb('evaluator1'), 'races', 'stale-global-team-race'), {
    eventId:'event-1', team:'01', station:'07', round:2, status:'running',
    startedAt:serverTimestamp(), startedBy:'evaluator1', participantIds:['100'], tags:[],
    timeLimitSeconds:2400, evaluationSchemaVersion:2
  }));
  await assertFails(setDoc(doc(userDb('operator2'), 'races', 'stale-global-role-race'), {
    eventId:'event-1', team:'01', station:'07', round:2, status:'running',
    startedAt:serverTimestamp(), startedBy:'operator2', participantIds:['100'], tags:[],
    timeLimitSeconds:2400, evaluationSchemaVersion:2
  }));
});

test('a commander can create a deterministic race in a transaction without reading the missing race', async () => {
  const db = userDb('operator1');
  const raceRef = doc(db, 'races', 'race_event-1_01_04_1');
  const eventRef = doc(db, 'events', 'event-1');
  const candidateRef = doc(db, 'events', 'event-1', 'candidates', '01_100');
  await assertSucceeds(runTransaction(db, async transaction => {
    const [eventSnapshot, candidateSnapshot] = await Promise.all([
      transaction.get(eventRef), transaction.get(candidateRef)
    ]);
    assert.equal(eventSnapshot.data().status, 'active');
    assert.equal(candidateSnapshot.data().status, 'active');
    transaction.set(raceRef, {
      eventId:'event-1', team:'01', station:'04', round:1, status:'running',
      startedAt:serverTimestamp(), startedBy:'operator1', participantIds:['100'], tags:[],
      timeLimitSeconds:2400, evaluationSchemaVersion:2
    });
  }));
  await assertFails(setDoc(raceRef, {
    eventId:'event-1', team:'01', station:'04', round:1, status:'running',
    startedAt:serverTimestamp(), startedBy:'operator1', participantIds:['100'], tags:[],
    timeLimitSeconds:2400, evaluationSchemaVersion:2
  }));
});

test('a formation commander can register only as an unapproved global role', async () => {
  const newCommander = userDb('new-formation');
  await assertSucceeds(setDoc(doc(newCommander, 'users', 'new-formation'), {
    uid: 'new-formation', name: 'חדש', email: 'new@example.com',
    role: 'formation_commander', team: null, approved: false,
    createdAt: serverTimestamp()
  }));
  const invalidTeamRole = userDb('invalid-team-role');
  await assertFails(setDoc(doc(invalidTeamRole, 'users', 'invalid-team-role'), {
    uid: 'invalid-team-role', name: 'לא תקין', email: 'bad@example.com',
    role: 'operator', team: null, approved: false, createdAt: serverTimestamp()
  }));
  const selfAdmin = userDb('self-admin');
  await assertFails(setDoc(doc(selfAdmin, 'users', 'self-admin'), {
    uid: 'self-admin', name: 'לא מנהל', email: 'admin@example.com',
    role: 'admin', team: null, approved: false, createdAt: serverTimestamp()
  }));
});

test('legacy clients may omit the limit but cannot choose another limit', async () => {
  const operator = userDb('operator1');
  await assertSucceeds(setDoc(doc(operator, 'races', 'race_01_07_3'), racePayload({ withLimit: false })));
  await assertFails(setDoc(doc(operator, 'races', 'race_01_07_4'), {
    ...racePayload(), round: 4, timeLimitSeconds: 3600
  }));
});

test('evaluators can still edit evaluation data but never lifecycle fields', async () => {
  const evaluator = userDb('evaluator1');
  await assertSucceeds(updateDoc(doc(evaluator, 'races', 'legacy-race'), {
    tags: [{ participantId: '100', reps: 4 }]
  }));
  await assertFails(updateDoc(doc(evaluator, 'races', 'race_01_07_1'), {
    tags: [{ participantId: '100', reps: 4 }]
  }));
  await assertFails(updateDoc(doc(evaluator, 'races', 'race_01_07_1'), {
    status: 'stopped', endedAt: serverTimestamp(), endedBy: 'evaluator1'
  }));
});

test('private assessments are readable and writable only by their evaluator', async () => {
  const ownRef = doc(userDb('evaluator1'), 'races', 'race_01_07_1', 'evaluatorAssessments', 'evaluator1');
  await assertSucceeds(setDoc(ownRef, assessmentPayload()));
  await assertSucceeds(getDoc(ownRef));

  await assertFails(getDoc(doc(userDb('evaluator2'),
    'races', 'race_01_07_1', 'evaluatorAssessments', 'evaluator1')));
  await assertFails(getDoc(doc(userDb('operator1'),
    'races', 'race_01_07_1', 'evaluatorAssessments', 'evaluator1')));
  await assertFails(setDoc(doc(userDb('evaluator1'),
    'races', 'race_01_07_1', 'evaluatorAssessments', 'evaluator2'), assessmentPayload('evaluator2')));
});

test('private general notes are isolated by author, including from the commander', async () => {
  const ownRef = doc(userDb('evaluator1'), 'general_notes', '01_100', 'authors', 'evaluator1');
  await assertSucceeds(setDoc(ownRef, privateNotesPayload()));
  await assertSucceeds(getDoc(ownRef));
  await assertFails(getDoc(doc(userDb('evaluator2'), 'general_notes', '01_100', 'authors', 'evaluator1')));
  await assertFails(getDoc(doc(userDb('operator1'), 'general_notes', '01_100', 'authors', 'evaluator1')));

  const operatorRef = doc(userDb('operator1'), 'general_notes', '01_100', 'authors', 'operator1');
  await assertSucceeds(setDoc(operatorRef, privateNotesPayload('operator1')));
  await assertSucceeds(getDoc(operatorRef));
});

test('the formation commander sees operations across teams but never private evaluations', async () => {
  const commander = userDb('formation1');
  await assertSucceeds(getDoc(doc(commander, 'races', 'race_01_07_1')));
  await assertFails(getDoc(doc(commander, 'races', 'legacy-race')));
  await assertSucceeds(getDocs(query(collection(commander, 'races'),
    where('eventId', '==', 'event-1'), where('evaluationSchemaVersion', '==', 2))));
  await assertFails(getDocs(collection(commander, 'races')));
  await assertSucceeds(getDoc(doc(commander, 'events', 'event-1', 'teams', '02')));
  await assertSucceeds(getDoc(doc(commander, 'events', 'event-1', 'candidates', '02_200')));
  await assertSucceeds(getDocs(collection(commander, 'events', 'event-1', 'candidates')));
  await assertFails(getDoc(doc(commander,
    'races', 'race_01_07_1', 'evaluatorAssessments', 'evaluator1')));
  await assertFails(getDoc(doc(commander,
    'races', 'race_01_07_1', 'evaluatorArrivals', 'evaluator1')));
  await assertFails(getDoc(doc(commander,
    'general_notes', '01_100', 'authors', 'operator1')));
  await assertFails(updateDoc(doc(commander, 'races', 'race_01_07_1'), {
    status: 'stopped', endedAt: serverTimestamp(), endedBy: 'formation1'
  }));
});

test('schedule writes are atomic, versioned and projected by team', async () => {
  const commander = userDb('formation1');
  const masterRef = doc(commander, 'events', 'event-1', 'schedule', 'master');
  const draftRef = doc(commander, 'events', 'event-1', 'schedule', 'draft');
  const revisionRef = doc(commander, 'events', 'event-1', 'scheduleRevisions', 'r-000001');

  // A client cannot bypass the durable audit trail by writing only the master.
  await assertFails(setDoc(masterRef, masterSchedulePayload()));

  await assertSucceeds(runTransaction(commander, async transaction => {
    await transaction.get(masterRef);
    transaction.set(masterRef, masterSchedulePayload());
    transaction.set(draftRef, draftSchedulePayload('formation1', 1, 1));
    transaction.set(doc(commander, 'events', 'event-1', 'teamSchedules', '01'), teamSchedulePayload('01'));
    transaction.set(doc(commander, 'events', 'event-1', 'teamSchedules', '02'), teamSchedulePayload('02'));
    transaction.set(revisionRef, masterSchedulePayload());
  }));

  await assertSucceeds(getDoc(masterRef));
  await assertSucceeds(getDoc(draftRef));
  await assertSucceeds(getDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'teamSchedules', '01')));
  await assertFails(getDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'teamSchedules', '02')));
  await assertFails(getDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'schedule', 'master')));
  await assertSucceeds(getDoc(doc(userDb('formation1'), 'events', 'event-1', 'teamSchedules', '02')));
  await assertFails(updateDoc(doc(userDb('operator1'), 'events', 'event-1', 'teamSchedules', '01'), {
    commanderName: 'ניסיון שינוי'
  }));
  await assertFails(updateDoc(masterRef, {
    ...masterSchedulePayload('formation1', 1), createdAt: Timestamp.now()
  }));
  await assertFails(updateDoc(revisionRef, { overrideReason: 'שינוי היסטוריה' }));
});

test('saving a schedule draft never changes the published team projection', async () => {
  const commander = userDb('formation1');
  const masterRef = doc(commander, 'events', 'event-1', 'schedule', 'master');
  const draftRef = doc(commander, 'events', 'event-1', 'schedule', 'draft');
  await assertSucceeds(runTransaction(commander, async transaction => {
    await transaction.get(masterRef);
    transaction.set(masterRef, masterSchedulePayload());
    transaction.set(draftRef, draftSchedulePayload('formation1', 1, 1));
    transaction.set(doc(commander, 'events', 'event-1', 'teamSchedules', '01'), teamSchedulePayload('01'));
    transaction.set(doc(commander, 'events', 'event-1', 'teamSchedules', '02'), teamSchedulePayload('02'));
    transaction.set(doc(commander, 'events', 'event-1', 'scheduleRevisions', 'r-000001'), masterSchedulePayload());
  }));
  const before = await getDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'teamSchedules', '01'));
  await assertSucceeds(runTransaction(commander, async transaction => {
    const currentDraft = await transaction.get(draftRef);
    transaction.set(draftRef, {
      ...draftSchedulePayload('formation1', 2, 1),
      rows:[{
        id:'row-1', date:'2026-08-24', startMinute:240, kind:'rotation', label:'',
        assignments:{
          '01':{ stationId:'07', routeNumber:'2' },
          '02':{ stationId:'02', routeNumber:'3' }
        }
      }],
      createdAt:currentDraft.data().createdAt
    });
  }));
  const after = await getDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'teamSchedules', '01'));
  assert.equal(before.data().sourceRevision, 1);
  assert.equal(after.data().sourceRevision, before.data().sourceRevision);
  assert.deepEqual(after.data().entries, before.data().entries);
  await assertFails(getDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'schedule', 'draft')));
});

test('draft, publish and restore advance every public projection atomically', async () => {
  const commander = userDb('formation1');
  const masterRef = doc(commander, 'events', 'event-1', 'schedule', 'master');
  const draftRef = doc(commander, 'events', 'event-1', 'schedule', 'draft');
  const teamOneRef = doc(commander, 'events', 'event-1', 'teamSchedules', '01');
  const teamTwoRef = doc(commander, 'events', 'event-1', 'teamSchedules', '02');
  await assertSucceeds(runTransaction(commander, async transaction => {
    await transaction.get(masterRef);
    transaction.set(masterRef, masterSchedulePayload());
    transaction.set(draftRef, draftSchedulePayload('formation1', 1, 1));
    transaction.set(teamOneRef, teamSchedulePayload('01'));
    transaction.set(teamTwoRef, teamSchedulePayload('02'));
    transaction.set(doc(commander, 'events', 'event-1', 'scheduleRevisions', 'r-000001'), masterSchedulePayload());
  }));

  const changedRows = [{
    id:'row-1', date:'2026-08-24', startMinute:240, kind:'rotation', label:'',
    assignments:{
      '01':{ stationId:'07', routeNumber:'2' },
      '02':{ stationId:'02', routeNumber:'3' }
    }
  }];
  await assertSucceeds(runTransaction(commander, async transaction => {
    const currentDraft = await transaction.get(draftRef);
    transaction.set(draftRef, {
      ...draftSchedulePayload('formation1', 2, 1), rows:changedRows,
      createdAt:currentDraft.data().createdAt
    });
  }));

  await assertSucceeds(runTransaction(commander, async transaction => {
    const [currentMaster, currentDraft] = await Promise.all([
      transaction.get(masterRef), transaction.get(draftRef)
    ]);
    const release = {
      ...masterSchedulePayload('formation1', 2), rows:changedRows,
      createdAt:currentMaster.data().createdAt,
      createdBy:currentMaster.data().createdBy
    };
    transaction.set(masterRef, release);
    transaction.set(draftRef, {
      ...draftSchedulePayload('formation1', 3, 2), rows:changedRows,
      createdAt:currentDraft.data().createdAt,
      createdBy:currentDraft.data().createdBy
    });
    transaction.set(teamOneRef, {
      ...teamSchedulePayload('01', 'formation1', 2),
      entries:[{
        id:'row-1', date:'2026-08-24', startMinute:240, kind:'rotation', label:'',
        stationId:'07', routeNumber:'2'
      }]
    });
    transaction.set(teamTwoRef, {
      ...teamSchedulePayload('02', 'formation1', 2),
      entries:[{
        id:'row-1', date:'2026-08-24', startMinute:240, kind:'rotation', label:'',
        stationId:'02', routeNumber:'3'
      }]
    });
    transaction.set(doc(commander, 'events', 'event-1', 'scheduleRevisions', 'r-000002'), {
      ...release, createdAt:serverTimestamp(), createdBy:'formation1'
    });
  }));

  const projection = await assertSucceeds(getDoc(
    doc(userDb('evaluator1'), 'events', 'event-1', 'teamSchedules', '01')
  ));
  assert.equal(projection.data().sourceRevision, 2);
  assert.equal(projection.data().entries[0].stationId, '07');

  await assertSucceeds(runTransaction(commander, async transaction => {
    const [currentMaster, currentDraft] = await Promise.all([
      transaction.get(masterRef), transaction.get(draftRef)
    ]);
    const restored = {
      ...masterSchedulePayload('formation1', 3),
      publicationType:'restore', restoredFromRevisionKey:'r-000001',
      createdAt:currentMaster.data().createdAt,
      createdBy:currentMaster.data().createdBy
    };
    transaction.set(masterRef, restored);
    transaction.set(draftRef, {
      ...draftSchedulePayload('formation1', 4, 3),
      createdAt:currentDraft.data().createdAt,
      createdBy:currentDraft.data().createdBy
    });
    transaction.set(teamOneRef, teamSchedulePayload('01', 'formation1', 3));
    transaction.set(teamTwoRef, teamSchedulePayload('02', 'formation1', 3));
    transaction.set(doc(commander, 'events', 'event-1', 'scheduleRevisions', 'r-000003'), {
      ...restored, createdAt:serverTimestamp(), createdBy:'formation1'
    });
  }));

  const restoredProjection = await assertSucceeds(getDoc(
    doc(userDb('evaluator1'), 'events', 'event-1', 'teamSchedules', '01')
  ));
  const restoredMaster = await assertSucceeds(getDoc(masterRef));
  const originalRevision = await assertSucceeds(getDoc(
    doc(commander, 'events', 'event-1', 'scheduleRevisions', 'r-000001')
  ));
  assert.equal(restoredProjection.data().sourceRevision, 3);
  assert.equal(restoredProjection.data().entries[0].stationId, '04');
  assert.equal(restoredMaster.data().publicationType, 'restore');
  assert.equal(restoredMaster.data().restoredFromRevisionKey, 'r-000001');
  assert.equal(originalRevision.data().revision, 1);
});

test('a restore publication must reference an existing immutable revision', async () => {
  const commander = userDb('formation1');
  const masterRef = doc(commander, 'events', 'event-1', 'schedule', 'master');
  const draftRef = doc(commander, 'events', 'event-1', 'schedule', 'draft');
  await assertSucceeds(runTransaction(commander, async transaction => {
    await transaction.get(masterRef);
    transaction.set(masterRef, masterSchedulePayload());
    transaction.set(draftRef, draftSchedulePayload('formation1', 1, 1));
    transaction.set(doc(commander, 'events', 'event-1', 'teamSchedules', '01'), teamSchedulePayload('01'));
    transaction.set(doc(commander, 'events', 'event-1', 'teamSchedules', '02'), teamSchedulePayload('02'));
    transaction.set(doc(commander, 'events', 'event-1', 'scheduleRevisions', 'r-000001'), masterSchedulePayload());
  }));

  await assertFails(runTransaction(commander, async transaction => {
    const [currentMaster, currentDraft] = await Promise.all([
      transaction.get(masterRef), transaction.get(draftRef)
    ]);
    const forged = {
      ...masterSchedulePayload('formation1', 2),
      publicationType:'restore', restoredFromRevisionKey:'r-999999',
      createdAt:currentMaster.data().createdAt,
      createdBy:currentMaster.data().createdBy
    };
    transaction.set(masterRef, forged);
    transaction.set(draftRef, {
      ...draftSchedulePayload('formation1', 2, 2),
      createdAt:currentDraft.data().createdAt,
      createdBy:currentDraft.data().createdBy
    });
    transaction.set(doc(commander, 'events', 'event-1', 'teamSchedules', '01'), teamSchedulePayload('01', 'formation1', 2));
    transaction.set(doc(commander, 'events', 'event-1', 'teamSchedules', '02'), teamSchedulePayload('02', 'formation1', 2));
    transaction.set(doc(commander, 'events', 'event-1', 'scheduleRevisions', 'r-000002'), {
      ...forged, createdAt:serverTimestamp(), createdBy:'formation1'
    });
  }));
});

test('dropout recommendations are team-scoped and only the formation commander resolves them', async () => {
  const reference = doc(userDb('operator1'), 'events', 'event-1', 'dropoutRecommendations', '01_100');
  await assertSucceeds(setDoc(reference, recommendationPayload()));
  await assertSucceeds(getDoc(doc(userDb('formation1'), 'events', 'event-1', 'dropoutRecommendations', '01_100')));
  await assertFails(getDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'dropoutRecommendations', '01_100')));
  await assertFails(setDoc(doc(userDb('operator2'), 'events', 'event-1', 'dropoutRecommendations', '01_100'), {
    ...recommendationPayload(), recommendedBy: 'operator2', recommendedByName: 'מפקצ 2'
  }));
  await assertFails(updateDoc(doc(userDb('operator1'), 'events', 'event-1', 'candidates', '01_100'), {
      status: 'withdrawn', reasonCode: 'medical', reasonLabel: 'רפואי', statusRevision: 1,
      lastTransitionId: 'not-authorized',
      statusChangedAt: serverTimestamp(), statusChangedBy: 'operator1'
  }));

  const commander = userDb('formation1');
  await assertSucceeds(runTransaction(commander, async transaction => {
    const recommendationRef = doc(commander, 'events', 'event-1', 'dropoutRecommendations', '01_100');
    const stateRef = doc(commander, 'events', 'event-1', 'candidates', '01_100');
    await transaction.get(recommendationRef);
    await transaction.get(stateRef);
    transaction.update(stateRef, {
      status: 'withdrawn', reasonCode: 'medical', reasonLabel: 'רפואי', statusRevision: 1,
      lastTransitionId: 'transition-accepted',
      statusChangedAt: serverTimestamp(), statusChangedBy: 'formation1'
    });
    transaction.set(doc(commander, 'events', 'event-1', 'candidateStatusEvents', 'transition-accepted'), {
      candidateKey: '01_100', participantId: '100', team: '01',
      fromStatus: 'active', toStatus: 'withdrawn', reasonCode: 'medical', reasonLabel: 'רפואי',
      details: 'נבדק על ידי החובש', source: 'recommendation', recommendationId: '01_100',
      changedAt: serverTimestamp(), changedBy: 'formation1', changedByName: 'מפקד הגיבוש', schemaVersion: 1
    });
    transaction.update(recommendationRef, {
      status: 'accepted', revision: 2, updatedAt: serverTimestamp(),
      resolvedAt: serverTimestamp(), resolvedBy: 'formation1'
    });
  }));
});

test('team members can read their candidate status and dropout reason but not other teams', async () => {
  const evaluator = userDb('evaluator1');
  const ownCandidate = await assertSucceeds(getDoc(doc(evaluator, 'events', 'event-1', 'candidates', '01_100')));
  assert.equal(ownCandidate.data().firstName, 'נועה');
  assert.equal(ownCandidate.data().nationalId, '000000018');
  assert.equal(ownCandidate.data().emergencyContactPhone, '0501234567');
  assert.equal(ownCandidate.data().doctorClearance, 1);
  await assertSucceeds(getDocs(query(collection(evaluator, 'events', 'event-1', 'candidates'),
    where('team', '==', '01'))));
  await assertFails(getDocs(collection(evaluator, 'events', 'event-1', 'candidates')));
  await assertFails(getDocs(query(collection(evaluator, 'events', 'event-1', 'candidates'),
    where('team', '==', '02'))));
  await assertSucceeds(getDoc(doc(userDb('operator1'), 'events', 'event-1', 'candidates', '01_100')));
  await assertFails(getDoc(doc(userDb('operator2'), 'events', 'event-1', 'candidates', '01_100')));
});

// Identity correction is an intake ability (admin, formation commander,
// adjutancy); team staff never change it.
test('team staff cannot correct candidate identity and nobody can without a profile revision', async () => {
  const operatorRef = doc(userDb('operator1'), 'events', 'event-1', 'candidates', '01_100');
  await assertFails(updateDoc(operatorRef, {
    firstName: 'נעמה', profileRevision: 1,
    profileUpdatedAt: serverTimestamp(), profileUpdatedBy: 'operator1'
  }));
  await assertFails(updateDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'candidates', '01_100'), {
    firstName: 'נעמה', profileRevision: 1,
    profileUpdatedAt: serverTimestamp(), profileUpdatedBy: 'evaluator1'
  }));
  const adminRef = doc(userDb('admin1'), 'events', 'event-1', 'candidates', '01_100');
  await assertFails(updateDoc(adminRef, {
    firstName: 'נעמה', profileUpdatedAt: serverTimestamp(), profileUpdatedBy: 'admin1'
  }));
  await assertFails(updateDoc(adminRef, {
    emergencyContactPhone: '123', doctorClearance: 9, profileRevision: 1,
    profileUpdatedAt: serverTimestamp(), profileUpdatedBy: 'admin1'
  }));
  await assertSucceeds(updateDoc(adminRef, {
    firstName: 'נעמה', nationalId: '039284765', emergencyContactPhone: '0527654321',
    doctorClearance: 1, medicClearance: 1, profileRevision: 1,
    profileUpdatedAt: serverTimestamp(), profileUpdatedBy: 'admin1'
  }));
});

test('event roster repository imports 400 candidates atomically, retries unchanged, and replaces draft rosters in bounded chunks', async () => {
  const db = userDb('admin1');
  const repository = createEventSetupRepository(db, { uid:'admin1',role:'admin' });
  const eventId = await repository.createDraft('בדיקת ייבוא');
  const teams = Array.from({length:20},(_,i)=>String(i+1).padStart(2,'0'));
  await repository.ensureTeams(eventId, teams);
  const groups = offset => teams.map(team=>({team,candidates:Array.from({length:20},(_,i)=>({participantId:String(i+1+offset)}))}));
  const progress=[];
  await repository.importCandidates(eventId, groups(0), {}, {onProgress:value=>progress.push(value)});
  let event = (await getDoc(doc(db,'events',eventId))).data();
  assert.equal(event.candidateCount,400);
  assert.equal(event.rosterRevision,1);
  assert.deepEqual(progress.map(item=>item.completedTeams),[0,20]);
  await repository.importCandidates(eventId,groups(0));
  assert.equal((await getDoc(doc(db,'events',eventId))).data().rosterRevision,1);
  await repository.importCandidates(eventId,groups(100));
  event = (await getDoc(doc(db,'events',eventId))).data();
  assert.equal(event.rosterRevision,3);
  assert.equal(event.candidateCount,400);
  assert.equal((await getDocs(collection(db,'events',eventId,'candidates'))).size,400);
  assert.equal((await getDoc(doc(db,'events',eventId,'candidates','01_1'))).exists(),false);
});

test('event import updates profiles without changing dropout state or removing absent active candidates', async () => {
  const db=userDb('admin1');
  const repository=createEventSetupRepository(db,{uid:'admin1',role:'admin'});
  await testEnv.withSecurityRulesDisabled(async context=>{
    await updateDoc(doc(context.firestore(),'events','event-1','candidates','01_100'),{
      status:'withdrawn',reasonCode:'medical',reasonLabel:'רפואי',statusRevision:5
    });
  });
  await repository.importCandidates('event-1',[{team:'01',candidates:[{participantId:'101'}]}]);
  await repository.replaceTeamCandidates('event-1','01',[{participantId:'100',firstName:'תיקון'}]);
  const candidate=(await getDoc(doc(db,'events','event-1','candidates','01_100'))).data();
  assert.equal(candidate.status,'withdrawn');
  assert.equal(candidate.statusRevision,5);
  assert.equal(candidate.firstName,'תיקון');
  assert.deepEqual((await getDoc(doc(db,'events','event-1','teams','01'))).data().participantIds,['100','101']);
  assert.equal((await getDoc(doc(db,'events','event-1'))).data().candidateCount,3);
});

test('an admin can build a draft event while operational users cannot read it', async () => {
  const admin = userDb('admin1');
  await assertSucceeds(setDoc(doc(admin, 'events', 'event-draft'), {
    name:'טיוטת בדיקה', status:'draft', teamCount:1, candidateCount:0,
    schemaVersion:3, setupSchemaVersion:1,
    createdAt:serverTimestamp(), createdBy:'admin1', updatedAt:serverTimestamp(), updatedBy:'admin1',
    activatedAt:null, activatedBy:'', closedAt:null, closedBy:''
  }));
  await assertSucceeds(setDoc(doc(admin, 'events', 'event-draft', 'teams', '01'), {
    teamNumber:'01', participantIds:[], stationMap:{}, rosterSource:{ type:'manual' },
    schemaVersion:3, active:true, createdAt:serverTimestamp(), createdBy:'admin1',
    updatedAt:serverTimestamp(), updatedBy:'admin1'
  }));
  await assertSucceeds(setDoc(doc(admin, 'events', 'event-draft', 'candidates', '01_100'), {
    participantId:'100', team:'01', firstName:'0', nationalId:'0', emergencyContactPhone:'0',
    doctorClearance:0, medicClearance:0, status:'active', reasonCode:'', reasonLabel:'',
    statusRevision:0, profileRevision:0, lastTransitionId:'',
    statusChangedAt:serverTimestamp(), statusChangedBy:'admin1',
    profileUpdatedAt:serverTimestamp(), profileUpdatedBy:'admin1', schemaVersion:3
  }));
  await assertSucceeds(deleteDoc(doc(admin, 'events', 'event-draft', 'candidates', '01_100')));
  await assertFails(deleteDoc(doc(admin, 'events', 'event-1', 'candidates', '01_100')));
  await assertSucceeds(setDoc(doc(admin, 'events', 'event-draft', 'schedule', 'draft'), {
    ...draftSchedulePayload('admin1'), eventId:'event-draft'
  }));
  await assertSucceeds(setDoc(doc(admin, 'events', 'event-draft', 'staff', 'evaluator1'), {
    eventId:'event-draft', uid:'evaluator1', displayName:'מעריך 1', role:'evaluator', team:'01',
    active:true, createdAt:serverTimestamp(), createdBy:'admin1',
    updatedAt:serverTimestamp(), updatedBy:'admin1'
  }));
  await assertSucceeds(setDoc(doc(admin, 'events', 'event-draft', 'artifacts', 'team-01'), {
    eventId:'event-draft', kind:'team', targetId:'01', status:'ready', fileId:'file-1',
    url:'https://docs.google.com/spreadsheets/d/file-1', message:'',
    updatedAt:serverTimestamp(), updatedBy:'admin1'
  }));
  await assertFails(getDoc(doc(userDb('evaluator1'), 'events', 'event-draft')));
  await assertFails(getDoc(doc(userDb('operator1'), 'events', 'event-draft', 'teams', '01')));
});

test('new events enforce event-scoped staff membership', async () => {
  const admin = userDb('admin1');
  await assertSucceeds(updateDoc(doc(admin, 'events', 'event-1'), { setupSchemaVersion:1 }));
  await assertSucceeds(updateDoc(doc(admin, 'settings', 'activeEvent'), {
    eventStaffingSchemaVersion:1
  }));
  await assertSucceeds(setDoc(doc(admin, 'events', 'event-1', 'staff', 'evaluator1'), {
    eventId:'event-1', uid:'evaluator1', displayName:'מעריך 1', role:'evaluator', team:'01',
    active:true, createdAt:serverTimestamp(), createdBy:'admin1',
    updatedAt:serverTimestamp(), updatedBy:'admin1'
  }));
  await assertSucceeds(getDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'staff', 'evaluator1')));
  await assertFails(getDoc(doc(userDb('evaluator2'), 'events', 'event-1', 'staff', 'evaluator1')));
  await assertSucceeds(getDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'candidates', '01_100')));
  await assertFails(getDoc(doc(userDb('evaluator2'), 'events', 'event-1', 'candidates', '01_100')));
  await assertSucceeds(updateDoc(doc(admin, 'events', 'event-1', 'staff', 'evaluator1'), {
    active:false, updatedAt:serverTimestamp(), updatedBy:'admin1'
  }));
  await assertSucceeds(getDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'staff', 'evaluator1')));
  await assertFails(getDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'candidates', '01_100')));
});

test('an administrator moves a staffed evaluator to another team mid-event', async () => {
  const admin = userDb('admin1');
  await assertSucceeds(updateDoc(doc(admin, 'events', 'event-1'), { setupSchemaVersion:1 }));
  await assertSucceeds(updateDoc(doc(admin, 'settings', 'activeEvent'), {
    eventStaffingSchemaVersion:1
  }));
  await assertSucceeds(setDoc(doc(admin, 'events', 'event-1', 'staff', 'evaluator1'), {
    eventId:'event-1', uid:'evaluator1', displayName:'מעריך 1', role:'evaluator', team:'01',
    active:true, createdAt:serverTimestamp(), createdBy:'admin1',
    updatedAt:serverTimestamp(), updatedBy:'admin1'
  }));
  // הפאנל כותב את רשומת המשתמש ואת השיבוץ יחד — כמו updateUserAssignment
  const batch = writeBatch(admin);
  batch.update(doc(admin, 'users', 'evaluator1'), { team:2 });
  batch.update(doc(admin, 'events', 'event-1', 'staff', 'evaluator1'), {
    role:'evaluator', team:'02', updatedAt:serverTimestamp(), updatedBy:'admin1'
  });
  await assertSucceeds(batch.commit());
  // ההרשאות עוברות לצוות החדש מיד
  await assertSucceeds(getDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'candidates', '02_200')));
  await assertFails(getDoc(doc(userDb('evaluator1'), 'events', 'event-1', 'candidates', '01_100')));
  // שיבוץ מעריך בלי צוות נדחה גם בשרת, לא רק בממשק
  await assertFails(updateDoc(doc(admin, 'events', 'event-1', 'staff', 'evaluator1'), {
    team:'', updatedAt:serverTimestamp(), updatedBy:'admin1'
  }));
});

test('direct formation status changes append an atomic immutable audit event', async () => {
  await updateDoc(doc(userDb('admin1'),'events','event-1','candidates','02_200'), {
    firstName:'יובל ישראלי', fullName:'יובל ישראלי', profileRevision:1,
    profileUpdatedAt:serverTimestamp(), profileUpdatedBy:'admin1'
  });
  const commander = userDb('formation1');
  const stateRef = doc(commander, 'events', 'event-1', 'candidates', '02_200');
  const recommendationRef = doc(commander, 'events', 'event-1', 'dropoutRecommendations', '02_200');
  const historyRef = doc(commander, 'events', 'event-1', 'candidateStatusEvents', 'transition-direct');
  await assertSucceeds(runTransaction(commander, async transaction => {
    await transaction.get(stateRef);
    await transaction.get(recommendationRef);
    transaction.update(stateRef, {
      status: 'withdrawn', reasonCode: 'voluntary', reasonLabel: 'פרישה', statusRevision: 1,
      lastTransitionId: 'transition-direct',
      statusChangedAt: serverTimestamp(), statusChangedBy: 'formation1'
    });
    transaction.set(historyRef, {
      candidateKey: '02_200', participantId: '200', team: '02',
      fromStatus: 'active', toStatus: 'withdrawn', reasonCode: 'voluntary', reasonLabel: 'פרישה',
      details: '', source: 'direct', recommendationId: '', changedAt: serverTimestamp(),
      changedBy: 'formation1', changedByName: 'מפקד הגיבוש', schemaVersion: 1
    });
  }));
  const teamView = await assertSucceeds(getDoc(doc(userDb('operator2'),
    'events', 'event-1', 'candidates', '02_200')));
  assert.equal(teamView.data().reasonLabel, 'פרישה');
  await assertFails(updateDoc(historyRef, { details: 'שינוי בדיעבד' }));
});

test('a migrated general-note parent rejects legacy member writes before the global marker', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'general_notes', '01_100'), {
      team: '01', participantId: '100', notes: [], privacySchemaVersion: 2
    });
  });

  await assertFails(updateDoc(doc(userDb('evaluator1'), 'general_notes', '01_100'), {
    notes: [{ text: 'legacy write', authorUid: 'evaluator1' }]
  }));
  await assertFails(updateDoc(doc(userDb('operator1'), 'general_notes', '01_100'), {
    notes: [{ text: 'legacy write', authorUid: 'operator1' }]
  }));
});

test('the completion marker disables legacy shared evaluation access and writes', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'settings', 'evaluationPrivacy'), { schemaVersion: 2, status: 'complete' });
    await setDoc(doc(db, 'races', 'legacy-race'), {
      team: '01', station: '07', round: 9, status: 'stopped',
      participantIds: ['100'], tags: [{ participantId: '100', scores: { evaluator1: { resilience: 7 } } }]
    });
    await setDoc(doc(db, 'general_notes', '01_100'), {
      team: '01', participantId: '100', notes: [{ text: 'legacy', authorUid: 'evaluator1' }]
    });
  });

  const evaluator = userDb('evaluator1');
  await assertFails(getDoc(doc(evaluator, 'races', 'legacy-race')));
  await assertSucceeds(getDoc(doc(evaluator, 'races', 'race_01_07_1')));
  await assertFails(updateDoc(doc(evaluator, 'races', 'race_01_07_1'), {
    tags: [{ participantId: '100', scores: { evaluator1: { resilience: 7 } } }]
  }));
  await assertFails(getDoc(doc(evaluator, 'general_notes', '01_100')));

  await assertFails(setDoc(doc(userDb('operator1'), 'races', 'race_01_07_3'), racePayload({ withLimit: false })));
  await assertSucceeds(setDoc(doc(userDb('operator1'), 'races', 'race_01_07_2'), {
    ...racePayload(), evaluationSchemaVersion: 2
  }));
});

test('a reporter can create only an allow-listed own-team issue report', async () => {
  const evaluator = userDb('evaluator1');
  await assertSucceeds(setDoc(doc(evaluator, 'issue_reports', 'report-1'), issuePayload()));
  await assertFails(getDoc(doc(evaluator, 'issue_reports', 'report-1')));
  await assertSucceeds(getDoc(doc(userDb('formation1'), 'issue_reports', 'report-1')));
  await assertSucceeds(getDocs(query(collection(userDb('formation1'), 'issue_reports'),
    where('eventId', '==', 'event-1'),
    where('schemaVersion', '==', ISSUE_REPORT_SCHEMA_VERSION))));
  await assertFails(getDocs(query(collection(userDb('formation1'), 'issue_reports'),
    where('eventId', '==', 'event-1'))));
  await assertFails(updateDoc(doc(evaluator, 'issue_reports', 'report-1'), { status: 'resolved' }));

  await assertFails(setDoc(doc(evaluator, 'issue_reports', 'report-spoofed-team'),
    issuePayload({ reporterTeam: 2 })));
  await assertFails(setDoc(doc(evaluator, 'issue_reports', 'report-sensitive'),
    issuePayload({ participantIds: ['100'] })));
});

test('an administrator can read and triage issue reports', async () => {
  await assertSucceeds(setDoc(doc(userDb('evaluator1'), 'issue_reports', 'report-1'), issuePayload()));
  const admin = userDb('admin1');
  const snapshot = await assertSucceeds(getDoc(doc(admin, 'issue_reports', 'report-1')));
  assert.equal(snapshot.data().status, 'open');
  await assertSucceeds(updateDoc(doc(admin, 'issue_reports', 'report-1'), {
    status: 'in_progress', adminNote: 'בודק', updatedAt: serverTimestamp(),
    handledAt: serverTimestamp(), handledBy: 'admin1'
  }));
});

// ═══════════════════════════════════════════════════════════
//  מחיקת נתוני גיבוש קודם
// ═══════════════════════════════════════════════════════════

// כל תת-האוספים שמחיקת גיבוש חייבת לנקות. הרשימה נבדקת במלואה כדי
// ש-`allow delete: if false` שנשאר מאחור ייפול כאן ולא בשדה, מול מנהל
// שמאמין שמחק גיבוש ובפועל השאיר את רובו.
const PURGEABLE_SUBCOLLECTIONS = [
  ['teams', '01'], ['schedule', 'master'], ['teamSchedules', '01'],
  ['scheduleRevisions', 'rev-1'], ['rosterImports', 'attempt-1'], ['candidates', '01_100'],
  ['dropoutRecommendations', '01_100'], ['candidateStatusEvents', 'transition-1'],
  ['staff', 'evaluator1'], ['artifacts', 'artifact-1'],
  ['unassignedCandidates', '301'], ['candidateNumbers', '301'], ['intake', 'counter']
];

async function seedFormationEvent(eventId, status) {
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'events', eventId), {
      name: 'גיבוש ' + eventId, status, schemaVersion: 3
    });
    for (const [subcollection, id] of PURGEABLE_SUBCOLLECTIONS) {
      await setDoc(doc(db, 'events', eventId, subcollection, id), { seeded: true });
    }
  });
}

test('an administrator can delete every part of a closed formation', async () => {
  await seedFormationEvent('event-old', 'closed');
  const admin = userDb('admin1');
  for (const [subcollection, id] of PURGEABLE_SUBCOLLECTIONS) {
    await assertSucceeds(deleteDoc(doc(admin, 'events', 'event-old', subcollection, id)));
  }
  // מסמך האירוע נמחק אחרון: כל שאר הכללים נשענים על קריאתו.
  await assertSucceeds(deleteDoc(doc(admin, 'events', 'event-old')));
});

test('a draft formation is discardable the same way', async () => {
  await seedFormationEvent('event-draft', 'draft');
  const admin = userDb('admin1');
  await assertSucceeds(deleteDoc(doc(admin, 'events', 'event-draft', 'candidates', '01_100')));
  await assertSucceeds(deleteDoc(doc(admin, 'events', 'event-draft')));
});

test('the running formation can never be deleted, not even by an administrator', async () => {
  const admin = userDb('admin1');
  await assertFails(deleteDoc(doc(admin, 'events', 'event-1')));
  await assertFails(deleteDoc(doc(admin, 'events', 'event-1', 'teams', '01')));
  await assertFails(deleteDoc(doc(admin, 'events', 'event-1', 'candidates', '01_100')));
});

// אירוע שנסגר אך המצביע עדיין עליו הוא בדיוק המצב שבו מנהל עלול למחוק
// את הגיבוש שממנו האפליקציה עדיין קוראת. הסטטוס לבדו אינו מספיק.
test('a closed formation still referenced by the active pointer is protected', async () => {
  await seedFormationEvent('event-old', 'closed');
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'settings', 'activeEvent'), {
      eventId: 'event-old', status: 'closed', schemaVersion: 3
    });
  });
  const admin = userDb('admin1');
  await assertFails(deleteDoc(doc(admin, 'events', 'event-old', 'candidates', '01_100')));
  await assertFails(deleteDoc(doc(admin, 'events', 'event-old')));
});

test('only an administrator may delete a closed formation', async () => {
  await seedFormationEvent('event-old', 'closed');
  for (const uid of ['formation1', 'operator1', 'evaluator1']) {
    await assertFails(deleteDoc(doc(userDb(uid), 'events', 'event-old', 'candidates', '01_100')));
    await assertFails(deleteDoc(doc(userDb(uid), 'events', 'event-old')));
  }
});

test('the privacy archive survives a formation purge', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'privacy_migration_archive', 'archive-1'), {
      eventId: 'event-old', capturedAt: Timestamp.now()
    });
  });
  await assertFails(deleteDoc(doc(userDb('admin1'), 'privacy_migration_archive', 'archive-1')));
});

// ═══════════════════════════════════════════════════════════
//  הערות משויכות לגיבוש
// ═══════════════════════════════════════════════════════════

const eventNoteRef = (db, eventId, noteId, authorUid) =>
  doc(db, 'events', eventId, 'generalNotes', noteId, 'authors', authorUid);

test('notes under a formation stay isolated by author', async () => {
  const own = eventNoteRef(userDb('evaluator1'), 'event-1', '01_100', 'evaluator1');
  await assertSucceeds(setDoc(own, privateNotesPayload()));
  await assertSucceeds(getDoc(own));
  await assertFails(getDoc(eventNoteRef(userDb('evaluator2'), 'event-1', '01_100', 'evaluator1')));
  await assertFails(getDoc(eventNoteRef(userDb('operator1'), 'event-1', '01_100', 'evaluator1')));
  await assertFails(getDoc(eventNoteRef(userDb('formation1'), 'event-1', '01_100', 'evaluator1')));
});

// זו הסיבה לכל השינוי: מספר מועמד חוזר בין גיבושים, ובמבנה הישן שתי
// ההערות היו נכתבות לאותו מסמך ומוצגות לאדם הלא נכון.
test('the same candidate number in another formation is a separate document', async () => {
  await seedFormationEvent('event-old', 'closed');
  await assertSucceeds(setDoc(
    eventNoteRef(userDb('evaluator1'), 'event-1', '01_100', 'evaluator1'), privateNotesPayload()
  ));
  const admin = userDb('admin1');
  const current = await assertSucceeds(getDoc(eventNoteRef(admin, 'event-1', '01_100', 'evaluator1')));
  const previous = await assertSucceeds(getDoc(eventNoteRef(admin, 'event-old', '01_100', 'evaluator1')));
  assert.equal(current.exists(), true);
  assert.equal(previous.exists(), false);
});

test('notes cannot be written into a formation that is not running', async () => {
  await seedFormationEvent('event-old', 'closed');
  await assertFails(setDoc(
    eventNoteRef(userDb('evaluator1'), 'event-old', '01_100', 'evaluator1'), privateNotesPayload()
  ));
});

test('purging a formation takes its notes with it', async () => {
  await seedFormationEvent('event-old', 'closed');
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'events', 'event-old', 'generalNotes', '01_100'), { seeded: true });
    await setDoc(doc(db, 'events', 'event-old', 'generalNotes', '01_100', 'authors', 'evaluator1'),
      { ...privateNotesPayload(), createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
  });
  const admin = userDb('admin1');
  await assertSucceeds(deleteDoc(eventNoteRef(admin, 'event-old', '01_100', 'evaluator1')));
  await assertSucceeds(deleteDoc(doc(admin, 'events', 'event-old', 'generalNotes', '01_100')));
});

test('staff accounts are deletable by an administrator and by nobody else', async () => {
  await assertFails(deleteDoc(doc(userDb('evaluator1'), 'users', 'evaluator2')));
  await assertFails(deleteDoc(doc(userDb('formation1'), 'users', 'evaluator1')));
  await assertFails(deleteDoc(doc(userDb('evaluator1'), 'users', 'evaluator1')));
  await assertSucceeds(deleteDoc(doc(userDb('admin1'), 'users', 'evaluator1')));
});

// הרשימה נקראת לפני שהמחיקה מוחקת אותה; בלי זה אין דרך לדעת אילו חשבונות
// שימשו רק בגיבוש הנמחק.
test('event staff membership is readable before it is deleted', async () => {
  await seedFormationEvent('event-old', 'closed');
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'events', 'event-old', 'staff', 'evaluator2'), {
      eventId: 'event-old', uid: 'evaluator2', displayName: 'מעריך 2', role: 'evaluator',
      team: 1, active: true, createdAt: Timestamp.now(), createdBy: 'admin1',
      updatedAt: Timestamp.now(), updatedBy: 'admin1'
    });
  });
  const admin = userDb('admin1');
  const snapshot = await assertSucceeds(getDocs(collection(admin, 'events', 'event-old', 'staff')));
  assert.equal(snapshot.docs.some(d => d.id === 'evaluator2'), true);
  await assertSucceeds(deleteDoc(doc(admin, 'events', 'event-old', 'staff', 'evaluator2')));
});

// Production runs with event staffing switched on. Each rule check then resolves
// role and team through settings/activeEvent and events/{id}/staff, which is far
// more expensive than the user-record path the older tests exercise. These tests
// cover the field flows under that real configuration (QA, Oct 2026: both hit
// the 1000-expression limit or a null resource and were denied).
async function enableEventStaffing() {
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await updateDoc(doc(db, 'settings', 'activeEvent'), { eventStaffingSchemaVersion: 1 });
    await updateDoc(doc(db, 'events', 'event-1'), { setupSchemaVersion: 1 });
    const staff = [
      ['operator1', 'operator', '01'], ['operator2', 'operator', '02'],
      ['evaluator1', 'evaluator', '01'], ['formation1', 'formation_commander', '']
    ];
    for (const [uid, role, team] of staff) {
      await setDoc(doc(db, 'events', 'event-1', 'staff', uid), {
        eventId: 'event-1', uid, displayName: uid, role, team, active: true,
        createdAt: serverTimestamp(), createdBy: 'admin1', updatedAt: serverTimestamp(), updatedBy: 'admin1'
      });
    }
  });
}

test('with event staffing, a team commander sends, cancels and re-opens a dropout recommendation', async () => {
  await enableEventStaffing();
  const operator = userDb('operator2');
  const reference = doc(operator, 'events', 'event-1', 'dropoutRecommendations', '02_200');
  const payload = { ...recommendationPayload(), participantId: '200', team: '02',
    recommendedBy: 'operator2', recommendedByName: 'מפקצ 2' };
  // The app subscribes to the document before any recommendation exists.
  await assertSucceeds(getDoc(reference));
  await assertFails(getDoc(doc(userDb('operator1'), 'events', 'event-1', 'dropoutRecommendations', '02_200')));
  // recommendDropout reads the document inside the transaction before writing.
  await assertSucceeds(runTransaction(operator, async transaction => {
    await transaction.get(reference);
    transaction.set(reference, payload);
  }));
  await assertSucceeds(runTransaction(operator, async transaction => {
    await transaction.get(reference);
    transaction.update(reference, {
      status: 'cancelled', revision: 2, updatedAt: serverTimestamp(),
      resolvedAt: serverTimestamp(), resolvedBy: 'operator2'
    });
  }));
  await assertSucceeds(runTransaction(operator, async transaction => {
    await transaction.get(reference);
    transaction.set(reference, { ...payload, revision: 3 });
  }));
  const commander = userDb('formation1');
  await assertSucceeds(runTransaction(commander, async transaction => {
    const recommendationRef = doc(commander, 'events', 'event-1', 'dropoutRecommendations', '02_200');
    await transaction.get(recommendationRef);
    transaction.update(recommendationRef, {
      status: 'rejected', revision: 4, updatedAt: serverTimestamp(),
      resolvedAt: serverTimestamp(), resolvedBy: 'formation1'
    });
  }));
});

test('with event staffing, the formation commander accepts a dropout recommendation', async () => {
  await enableEventStaffing();
  await assertSucceeds(setDoc(doc(userDb('operator1'), 'events', 'event-1', 'dropoutRecommendations', '01_100'),
    recommendationPayload()));
  const commander = userDb('formation1');
  await assertSucceeds(runTransaction(commander, async transaction => {
    const recommendationRef = doc(commander, 'events', 'event-1', 'dropoutRecommendations', '01_100');
    const stateRef = doc(commander, 'events', 'event-1', 'candidates', '01_100');
    await transaction.get(recommendationRef);
    await transaction.get(stateRef);
    transaction.update(stateRef, {
      status: 'withdrawn', reasonCode: 'medical', reasonLabel: 'רפואי', statusRevision: 1,
      lastTransitionId: 'transition-staffed',
      statusChangedAt: serverTimestamp(), statusChangedBy: 'formation1'
    });
    transaction.set(doc(commander, 'events', 'event-1', 'candidateStatusEvents', 'transition-staffed'), {
      candidateKey: '01_100', participantId: '100', team: '01',
      fromStatus: 'active', toStatus: 'withdrawn', reasonCode: 'medical', reasonLabel: 'רפואי',
      details: 'נבדק על ידי החובש', source: 'recommendation', recommendationId: '01_100',
      changedAt: serverTimestamp(), changedBy: 'formation1', changedByName: 'מפקד הגיבוש', schemaVersion: 1
    });
    transaction.update(recommendationRef, {
      status: 'accepted', revision: 2, updatedAt: serverTimestamp(),
      resolvedAt: serverTimestamp(), resolvedBy: 'formation1'
    });
  }));
});

test('with event staffing, a field user can submit an own-team issue report', async () => {
  await enableEventStaffing();
  const evaluator = userDb('evaluator1');
  await assertSucceeds(setDoc(doc(evaluator, 'issue_reports', 'report-staffed'), issuePayload()));
  await assertFails(setDoc(doc(evaluator, 'issue_reports', 'report-staffed-spoof'), issuePayload({ reporterTeam: 2 })));
});

test('station staff list their station rounds with the app queries, before and after the privacy marker', async () => {
  const stationRounds = (db, team, withSchema) => getDocs(query(collection(db, 'races'),
    where('eventId', '==', 'event-1'), where('team', '==', team), where('station', '==', '07'),
    ...(withSchema ? [where('evaluationSchemaVersion', '==', 2)] : [])));

  const evaluator = userDb('evaluator1');
  const operator = userDb('operator1');
  await assertSucceeds(stationRounds(evaluator, '01', false));
  await assertSucceeds(stationRounds(evaluator, '01', true));
  await assertSucceeds(stationRounds(operator, '01', true));
  await assertFails(stationRounds(evaluator, '02', true));

  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'settings', 'evaluationPrivacy'), { schemaVersion: 2, status: 'complete' });
  });
  await assertSucceeds(stationRounds(evaluator, '01', true));
  await assertSucceeds(stationRounds(operator, '01', true));
  await assertFails(stationRounds(evaluator, '01', false));
  await assertFails(stationRounds(evaluator, '02', true));
});

// ---- הודעות פנימיות (events/{eventId}/messages, messageReads) ----
const messagesRef = db => collection(db, 'events', 'event-1', 'messages');
function messagePayload(senderUid, senderRole, overrides = {}) {
  return {
    text: 'כולם לאסוף ציוד', targetRoles: ['operator', 'evaluator'],
    senderUid, senderName: 'שולח', senderRole,
    createdAt: serverTimestamp(), schemaVersion: 1, ...overrides
  };
}
const recipientQuery = (db, role) =>
  getDocs(query(messagesRef(db), where('targetRoles', 'array-contains', role)));

async function seedMessage(id = 'm1', targetRoles = ['evaluator']) {
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'events', 'event-1', 'messages', id), {
      text: 'שלום', targetRoles, senderUid: 'admin1', senderName: 'מנהל', senderRole: 'admin',
      createdAt: Timestamp.now(), schemaVersion: 1
    });
  });
}

test('messages: only admin and formation commander send, with their own sender role', async () => {
  await assertSucceeds(addDoc(messagesRef(userDb('admin1')), messagePayload('admin1', 'admin')));
  await assertSucceeds(addDoc(messagesRef(userDb('formation1')), messagePayload('formation1', 'formation_commander')));
  await assertFails(addDoc(messagesRef(userDb('operator1')), messagePayload('operator1', 'admin')));
  await assertFails(addDoc(messagesRef(userDb('evaluator1')), messagePayload('evaluator1', 'formation_commander')));
  await assertFails(addDoc(messagesRef(userDb('formation1')), messagePayload('formation1', 'admin')));
  await assertFails(addDoc(messagesRef(userDb('admin1')), messagePayload('formation1', 'admin')));
  await assertFails(addDoc(messagesRef(testEnv.unauthenticatedContext().firestore()), messagePayload('x', 'admin')));
});

test('messages: shape violations are rejected', async () => {
  const db = userDb('admin1');
  const bad = overrides => assertFails(addDoc(messagesRef(db), messagePayload('admin1', 'admin', overrides)));
  await bad({ text: '' });
  await bad({ text: 'א'.repeat(1001) });
  await bad({ text: 7 });
  await bad({ targetRoles: [] });
  await bad({ targetRoles: 'operator' });
  await bad({ targetRoles: ['operator', 'hacker'] });
  await bad({ targetRoles: ['operator', 'evaluator', 'formation_commander', 'adjutant', 'admin', 'admin'] });
  await bad({ senderName: 'ש'.repeat(201) });
  await bad({ createdAt: Timestamp.fromMillis(Date.now() - 60_000) });
  await bad({ schemaVersion: 2 });
  await bad({ extra: true });
  const { senderName, ...withoutName } = messagePayload('admin1', 'admin');
  await assertFails(addDoc(messagesRef(db), withoutName));
  await assertSucceeds(addDoc(messagesRef(db), messagePayload('admin1', 'admin', {
    text: 'א'.repeat(1000), targetRoles: ['operator', 'evaluator', 'formation_commander', 'adjutant', 'admin']
  })));
});

test('messages: cannot be sent to an event that is not active', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'events', 'event-2'), { name: 'ישן', status: 'closed', schemaVersion: 3 });
  });
  await assertFails(addDoc(collection(userDb('admin1'), 'events', 'event-2', 'messages'), messagePayload('admin1', 'admin')));
});

test('messages: recipients query their own role only; senders read everything', async () => {
  await seedMessage('m-eval', ['evaluator']);
  await seedMessage('m-op', ['operator', 'admin']);
  const evaluator = userDb('evaluator1');
  const own = await assertSucceeds(recipientQuery(evaluator, 'evaluator'));
  assert.deepEqual(own.docs.map(d => d.id), ['m-eval']);
  await assertFails(recipientQuery(evaluator, 'operator'));
  await assertFails(getDocs(messagesRef(evaluator)));
  await assertFails(getDoc(doc(messagesRef(evaluator), 'm-op')));
  await assertSucceeds(getDoc(doc(messagesRef(evaluator), 'm-eval')));
  assert.equal((await assertSucceeds(recipientQuery(userDb('operator1'), 'operator'))).size, 1);
  assert.equal((await assertSucceeds(getDocs(messagesRef(userDb('admin1'))))).size, 2);
  assert.equal((await assertSucceeds(getDocs(messagesRef(userDb('formation1'))))).size, 2);
  await assertFails(getDocs(messagesRef(testEnv.unauthenticatedContext().firestore())));
});

test('messages: an unapproved user and a stale event get nothing', async () => {
  await seedMessage('m-eval', ['evaluator']);
  await testEnv.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), 'users', 'evaluator2'), { approved: false });
  });
  await assertFails(recipientQuery(userDb('evaluator2'), 'evaluator'));
  await assertSucceeds(recipientQuery(userDb('evaluator1'), 'evaluator'));
  await testEnv.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), 'settings', 'activeEvent'), { status: 'closed' });
  });
  await assertFails(recipientQuery(userDb('evaluator1'), 'evaluator'));
});

test('messages: with event staffing the role comes from the staff record', async () => {
  await seedMessage('m-eval', ['evaluator']);
  await seedMessage('m-fc', ['formation_commander']);
  await enableEventStaffing();
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    // התפקיד הגלובלי של המשתמש אינו קובע יותר: operator2 משובץ כמעריך.
    await setDoc(doc(db, 'events', 'event-1', 'staff', 'operator2'), {
      eventId: 'event-1', uid: 'operator2', displayName: 'x', role: 'evaluator', team: '02', active: true,
      createdAt: Timestamp.now(), createdBy: 'admin1', updatedAt: Timestamp.now(), updatedBy: 'admin1'
    });
    await updateDoc(doc(db, 'events', 'event-1', 'staff', 'evaluator1'), { active: false });
  });
  assert.equal((await assertSucceeds(recipientQuery(userDb('operator2'), 'evaluator'))).size, 1);
  await assertFails(recipientQuery(userDb('operator2'), 'operator'));
  await assertFails(recipientQuery(userDb('evaluator1'), 'evaluator')); // שיבוץ לא פעיל
  assert.equal((await assertSucceeds(getDocs(messagesRef(userDb('formation1'))))).size, 2);
  await assertSucceeds(addDoc(messagesRef(userDb('formation1')), messagePayload('formation1', 'formation_commander')));
  await assertFails(addDoc(messagesRef(userDb('operator2')), messagePayload('operator2', 'admin')));
});

test('messages: immutable, deleted only by admin', async () => {
  await seedMessage('m1');
  for (const uid of ['admin1', 'formation1', 'evaluator1']) {
    await assertFails(updateDoc(doc(messagesRef(userDb(uid)), 'm1'), { text: 'שונה' }));
  }
  await assertFails(deleteDoc(doc(messagesRef(userDb('formation1')), 'm1')));
  await assertFails(deleteDoc(doc(messagesRef(userDb('evaluator1')), 'm1')));
  await assertSucceeds(deleteDoc(doc(messagesRef(userDb('admin1')), 'm1')));
});

test('messageReads: owner-only with a strict shape', async () => {
  const ref = (db, uid) => doc(db, 'events', 'event-1', 'messageReads', uid);
  const payload = { lastReadAt: serverTimestamp(), schemaVersion: 1 };
  await assertSucceeds(setDoc(ref(userDb('evaluator1'), 'evaluator1'), payload));
  await assertSucceeds(setDoc(ref(userDb('evaluator1'), 'evaluator1'), payload));
  await assertSucceeds(getDoc(ref(userDb('evaluator1'), 'evaluator1')));
  await assertFails(getDoc(ref(userDb('evaluator2'), 'evaluator1')));
  await assertFails(getDoc(ref(userDb('admin1'), 'evaluator1')));
  await assertFails(setDoc(ref(userDb('evaluator2'), 'evaluator1'), payload));
  await assertFails(setDoc(ref(userDb('evaluator1'), 'evaluator1'), { ...payload, extra: 1 }));
  await assertFails(setDoc(ref(userDb('evaluator1'), 'evaluator1'), { lastReadAt: 'now', schemaVersion: 1 }));
  await assertFails(setDoc(ref(userDb('evaluator1'), 'evaluator1'), { ...payload, schemaVersion: 2 }));
  await testEnv.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), 'users', 'evaluator2'), { approved: false });
  });
  await assertFails(setDoc(ref(userDb('evaluator2'), 'evaluator2'), payload));
});

test('messages repository: send, role-scoped subscription and read marker work against the rules', async () => {
  const sender = createMessagesRepository(userDb('formation1'), { uid: 'formation1', name: 'מפקד', role: 'formation_commander' });
  const evaluatorRepo = createMessagesRepository(userDb('evaluator1'), { uid: 'evaluator1', name: 'מעריך', role: 'evaluator' });
  const operatorRepo = createMessagesRepository(userDb('operator1'), { uid: 'operator1', name: 'מפקצ', role: 'operator' });
  const received = [];
  const stop = evaluatorRepo.subscribe('event-1', snapshot => received.push(snapshot), error => assert.fail(error));
  const operatorSeen = [];
  const stopOperator = operatorRepo.subscribe('event-1', snapshot => operatorSeen.push(snapshot), () => {});
  await sender.send('event-1', { text: 'לכל המעריכים', targetRoles: ['evaluator'] });
  await new Promise(resolve => setTimeout(resolve, 600));
  stop(); stopOperator();
  const added = received.flatMap(snapshot => snapshot.added);
  assert.equal(added.length, 1);
  assert.equal(added[0].text, 'לכל המעריכים');
  assert.equal(added[0].senderRole, 'formation_commander');
  assert.deepEqual(added[0].targetRoles, ['evaluator']);
  assert.equal(operatorSeen.flatMap(snapshot => snapshot.messages).length, 0);
  await assert.rejects(evaluatorRepo.send('event-1', { text: 'x', targetRoles: ['operator'] }), /הרשאה/);
  await evaluatorRepo.markRead('event-1');
  const state = [];
  const stopState = evaluatorRepo.subscribeReadState('event-1', snapshot => state.push(snapshot), () => {});
  await new Promise(resolve => setTimeout(resolve, 400));
  stopState();
  assert.ok(state.at(-1).lastReadAtMs > 0);
});

// ═══════════════════════════════════════════════════════════
//  קליטת מועמדים — שלישות
// ═══════════════════════════════════════════════════════════

const intakeUser = uid => ({ uid, role: { admin1:'admin', formation1:'formation_commander' }[uid] || 'adjutant' });
const intakeRepo = uid => createIntakeRepository(userDb(uid), intakeUser(uid));
const person = (fullName, extra = {}) => ({
  fullName, nationalId: '', emergencyContactPhone: '0521234567', doctorClearance: 1, medicClearance: 0, ...extra
});
const numberEntry = (participantId, team, uid = 'adjutant1', source = 'intake') => ({
  participantId, team, source, claimedAt: serverTimestamp(), claimedBy: uid,
  updatedAt: serverTimestamp(), updatedBy: uid, schemaVersion: 1
});
const unassignedPayload = (participantId, uid = 'adjutant1') => ({
  participantId, firstName: 'כללי', fullName: 'כללי', nationalId: '0', emergencyContactPhone: '0',
  doctorClearance: 0, medicClearance: 0, profileRevision: 0,
  profileUpdatedAt: serverTimestamp(), profileUpdatedBy: uid,
  createdAt: serverTimestamp(), createdBy: uid, schemaVersion: 1
});

async function useStaffingFor(staff) {
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await updateDoc(doc(db, 'settings', 'activeEvent'), { eventStaffingSchemaVersion: 1 });
    for (const [uid, role] of Object.entries(staff)) {
      await setDoc(doc(db, 'events', 'event-1', 'staff', uid), {
        eventId: 'event-1', uid, displayName: uid, role, team: '', active: true,
        createdAt: Timestamp.now(), createdBy: 'admin1', updatedAt: Timestamp.now(), updatedBy: 'admin1'
      });
    }
  });
}

test('adjutancy self-registers without a team and is staffed without a team', async () => {
  const user = (uid, team) => ({ uid, name: 'שלישה', email: `${uid}@example.com`, role: 'adjutant', team, approved: false, createdAt: serverTimestamp() });
  await assertSucceeds(setDoc(doc(userDb('newAdjutant'), 'users', 'newAdjutant'), user('newAdjutant', null)));
  await assertFails(setDoc(doc(userDb('teamAdjutant'), 'users', 'teamAdjutant'), user('teamAdjutant', 3)));
  await assertFails(setDoc(doc(userDb('approvedAdjutant'), 'users', 'approvedAdjutant'), { ...user('approvedAdjutant', null), approved: true }));
  const staff = team => ({
    eventId: 'event-1', uid: 'adjutant1', displayName: 'שלישות', role: 'adjutant', team, active: true,
    createdAt: serverTimestamp(), createdBy: 'admin1', updatedAt: serverTimestamp(), updatedBy: 'admin1'
  });
  await assertFails(setDoc(doc(userDb('admin1'), 'events', 'event-1', 'staff', 'adjutant1'), staff('01')));
  await assertSucceeds(setDoc(doc(userDb('admin1'), 'events', 'event-1', 'staff', 'adjutant1'), staff('')));
  await assertFails(setDoc(doc(userDb('adjutant1'), 'events', 'event-1', 'staff', 'adjutant2'), { ...staff(''), uid: 'adjutant2', updatedBy: 'adjutant1' }));
});

test('intake numbers continue after imported numbers, into a team or as a general candidate', async () => {
  const repo = intakeRepo('adjutant1');
  const first = await repo.createCandidate('event-1', person('דנה כהן', { nationalId: '000000026' }), '01');
  assert.deepEqual(first, { participantId: '201', team: '01' });
  const second = await repo.createCandidate('event-1', person('רון לוי'), '');
  assert.deepEqual(second, { participantId: '202', team: '' });
  const db = userDb('adjutant1');
  const record = (await getDoc(doc(db, 'events', 'event-1', 'candidates', '01_201'))).data();
  assert.equal(record.fullName, 'דנה כהן');
  assert.equal(record.firstName, 'דנה כהן');
  assert.equal(record.nationalId, '000000026');
  assert.equal(record.statusRevision, 0);
  assert.deepEqual((await getDoc(doc(db, 'events', 'event-1', 'teams', '01'))).data().participantIds, ['100', '201']);
  assert.equal((await getDoc(doc(db, 'events', 'event-1', 'unassignedCandidates', '202'))).data().fullName, 'רון לוי');
  assert.equal((await getDoc(doc(db, 'events', 'event-1', 'candidateNumbers', '201'))).data().team, '01');
  assert.equal((await getDoc(doc(db, 'events', 'event-1', 'candidateNumbers', '202'))).data().team, '');
  assert.equal((await getDoc(doc(db, 'events', 'event-1', 'intake', 'counter'))).data().lastNumber, 202);
  // A stale hint never yields a used number: with no counter, 100 exists, so 101 is next.
  await testEnv.withSecurityRulesDisabled(async context => {
    await deleteDoc(doc(context.firestore(), 'events', 'event-1', 'intake', 'counter'));
  });
  const third = await repo.createCandidate('event-1', person('גל'), '02', { knownMax: 99 });
  assert.equal(third.participantId, '101');
  await assert.rejects(repo.createCandidate('event-1', person(''), ''), /שם מלא/);
  await assert.rejects(repo.createCandidate('event-1', person('א', { nationalId: '123' }), ''), /תעודת הזהות/);
  await assert.rejects(repo.createCandidate('event-1', person('א'), '07'), /אינו קיים/);
});

test('ten people entering at once all receive distinct numbers', async () => {
  const uids = ['adjutant1', 'adjutant2', 'formation1', 'admin1', 'adjutant1', 'adjutant2', 'formation1', 'admin1', 'adjutant1', 'adjutant2'];
  const results = await Promise.all(uids.map((uid, index) =>
    intakeRepo(uid).createCandidate('event-1', person(`מועמד ${index}`), index % 3 === 0 ? '' : (index % 2 ? '01' : '02'))));
  const numbers = results.map(result => Number(result.participantId)).sort((a, b) => a - b);
  assert.equal(new Set(numbers).size, 10);
  assert.deepEqual(numbers, Array.from({ length: 10 }, (_, index) => 201 + index));
  const db = userDb('admin1');
  assert.equal((await getDocs(collection(db, 'events', 'event-1', 'candidateNumbers'))).size, 10);
  assert.equal((await getDoc(doc(db, 'events', 'event-1', 'intake', 'counter'))).data().lastNumber, 210);
  for (const team of ['01', '02']) {
    const roster = (await getDoc(doc(db, 'events', 'event-1', 'teams', team))).data().participantIds;
    const records = (await getDocs(query(collection(db, 'events', 'event-1', 'candidates'), where('team', '==', team)))).docs
      .map(item => item.data().participantId);
    assert.deepEqual([...roster].sort(), [...records].sort());
  }
});

test('a number entry is created once; the counter only grows with its own entry', async () => {
  await intakeRepo('adjutant1').createCandidate('event-1', person('ראשון'), '');
  const db = userDb('adjutant2');
  // The same number again: an existing entry cannot be re-created or re-pointed.
  await assertFails(setDoc(doc(db, 'events', 'event-1', 'candidateNumbers', '201'), numberEntry('201', '', 'adjutant2')));
  await assertFails(setDoc(doc(db, 'events', 'event-1', 'unassignedCandidates', '201'), unassignedPayload('201', 'adjutant2')));
  // A fresh number needs its record and the counter in the same transaction.
  await assertFails(setDoc(doc(db, 'events', 'event-1', 'candidateNumbers', '500'), numberEntry('500', '', 'adjutant2')));
  await assertFails(runTransaction(db, async transaction => {
    transaction.set(doc(db, 'events', 'event-1', 'candidateNumbers', '500'), numberEntry('500', '', 'adjutant2'));
    transaction.set(doc(db, 'events', 'event-1', 'unassignedCandidates', '500'), unassignedPayload('500', 'adjutant2'));
  }));
  await assertFails(updateDoc(doc(db, 'events', 'event-1', 'intake', 'counter'), {
    lastNumber: 150, updatedAt: serverTimestamp(), updatedBy: 'adjutant2'
  }));
  await assertSucceeds(runTransaction(db, async transaction => {
    transaction.set(doc(db, 'events', 'event-1', 'intake', 'counter'), { lastNumber: 500, updatedAt: serverTimestamp(), updatedBy: 'adjutant2' });
    transaction.set(doc(db, 'events', 'event-1', 'candidateNumbers', '500'), numberEntry('500', '', 'adjutant2'));
    transaction.set(doc(db, 'events', 'event-1', 'unassignedCandidates', '500'), unassignedPayload('500', 'adjutant2'));
  }));
  await assertFails(deleteDoc(doc(db, 'events', 'event-1', 'candidateNumbers', '500')));
  await assertFails(deleteDoc(doc(db, 'events', 'event-1', 'unassignedCandidates', '500')));
  await assertFails(deleteDoc(doc(userDb('admin1'), 'events', 'event-1', 'candidateNumbers', '500')));
});

test('moves between general and teams are atomic and keep rosters in sync', async () => {
  const repo = intakeRepo('adjutant1'), db = userDb('adjutant1');
  const { participantId } = await repo.createCandidate('event-1', person('נדב'), '');
  const location = async () => ({
    general: (await getDoc(doc(db, 'events', 'event-1', 'unassignedCandidates', participantId))).exists(),
    team1: (await getDoc(doc(db, 'events', 'event-1', 'candidates', `01_${participantId}`))).exists(),
    team2: (await getDoc(doc(db, 'events', 'event-1', 'candidates', `02_${participantId}`))).exists(),
    roster1: (await getDoc(doc(db, 'events', 'event-1', 'teams', '01'))).data().participantIds,
    roster2: (await getDoc(doc(db, 'events', 'event-1', 'teams', '02'))).data().participantIds,
    entry: (await getDoc(doc(db, 'events', 'event-1', 'candidateNumbers', participantId))).data().team
  });
  await repo.moveCandidate('event-1', { participantId, from: '', to: '02' }, { eventStatus: 'active' });
  assert.deepEqual(await location(), { general: false, team1: false, team2: true, roster1: ['100'], roster2: ['200', participantId], entry: '02' });
  assert.equal((await getDoc(doc(db, 'events', 'event-1', 'candidates', `02_${participantId}`))).data().fullName, 'נדב');
  await repo.moveCandidate('event-1', { participantId, from: '02', to: '01' }, { eventStatus: 'active' });
  assert.deepEqual(await location(), { general: false, team1: true, team2: false, roster1: ['100', participantId], roster2: ['200'], entry: '01' });
  await repo.moveCandidate('event-1', { participantId, from: '01', to: '' }, { eventStatus: 'active' });
  assert.deepEqual(await location(), { general: true, team1: false, team2: false, roster1: ['100'], roster2: ['200'], entry: '' });
  // An imported candidate without an entry is registered on its first move.
  await intakeRepo('formation1').moveCandidate('event-1', { participantId: '200', from: '02', to: '' }, { eventStatus: 'active' });
  assert.equal((await getDoc(doc(db, 'events', 'event-1', 'candidateNumbers', '200'))).data().source, 'legacy');
  assert.deepEqual((await getDoc(doc(db, 'events', 'event-1', 'teams', '02'))).data().participantIds, []);
});

test('a candidate with data cannot be moved, by the client check or by the rules', async () => {
  const repo = intakeRepo('adjutant1'), db = userDb('adjutant1');
  // 01_100 took part in race_01_07_1.
  await assert.rejects(repo.moveCandidate('event-1', { participantId: '100', from: '01', to: '02' }, { eventStatus: 'active' }),
    error => error instanceof IntakeMoveBlockedError && /סבב/.test(error.reasons.join(' ')));
  // A status change (statusRevision > 0) blocks the move in the rules too.
  await testEnv.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), 'events', 'event-1', 'candidates', '02_200'), { statusRevision: 1 });
  });
  await assert.rejects(repo.moveCandidate('event-1', { participantId: '200', from: '02', to: '' }, { eventStatus: 'active' }),
    error => error instanceof IntakeMoveBlockedError);
  const rawMove = () => runTransaction(db, async transaction => {
    transaction.set(doc(db, 'events', 'event-1', 'unassignedCandidates', '200'), unassignedPayload('200'));
    transaction.set(doc(db, 'events', 'event-1', 'candidateNumbers', '200'), numberEntry('200', '', 'adjutant1', 'legacy'));
    transaction.delete(doc(db, 'events', 'event-1', 'candidates', '02_200'));
    transaction.update(doc(db, 'events', 'event-1', 'teams', '02'), { participantIds: [], updatedAt: serverTimestamp(), updatedBy: 'adjutant1' });
  });
  await assertFails(rawMove());
  await testEnv.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), 'events', 'event-1', 'candidates', '02_200'), { statusRevision: 0 });
  });
  await assertSucceeds(rawMove());
  // A dropout recommendation also blocks it; the adjutant cannot read it, the rules refuse.
  await testEnv.withSecurityRulesDisabled(async context => {
    const admin = context.firestore();
    await setDoc(doc(admin, 'events', 'event-1', 'candidates', '01_150'), candidatePayload({ participantId: '150', team: '01', firstName: 'שי', nationalId: '0' }));
    await updateDoc(doc(admin, 'events', 'event-1', 'teams', '01'), { participantIds: ['100', '150'] });
    await setDoc(doc(admin, 'events', 'event-1', 'dropoutRecommendations', '01_150'), { ...recommendationPayload(), participantId: '150', createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
  });
  await assert.rejects(repo.moveCandidate('event-1', { participantId: '150', from: '01', to: '' }, { eventStatus: 'active' }),
    error => error.code === 'permission-denied');
  await assert.rejects(intakeRepo('formation1').moveCandidate('event-1', { participantId: '150', from: '01', to: '' }, { eventStatus: 'active' }),
    error => error instanceof IntakeMoveBlockedError && /המלצת נשירה/.test(error.reasons.join(' ')));
  assert.equal((await getDoc(doc(db, 'events', 'event-1', 'candidates', '01_150'))).exists(), true);
});

test('adjutancy changes only roster numbers through registered moves, never team settings', async () => {
  const db = userDb('adjutant1');
  const team = doc(db, 'events', 'event-1', 'teams', '01');
  await assertSucceeds(getDoc(team));
  await assertFails(updateDoc(team, { stationMap: { '01': 'sprints' }, updatedAt: serverTimestamp(), updatedBy: 'adjutant1' }));
  await assertFails(updateDoc(team, { active: false, updatedAt: serverTimestamp(), updatedBy: 'adjutant1' }));
  await assertFails(updateDoc(team, { participantIds: ['100', '999'], updatedAt: serverTimestamp(), updatedBy: 'adjutant1' }));
  await assertFails(updateDoc(team, { participantIds: [], updatedAt: serverTimestamp(), updatedBy: 'adjutant1' }));
  await assertFails(setDoc(doc(db, 'events', 'event-1', 'teams', '05'), { teamNumber: '05', participantIds: [], stationMap: {}, schemaVersion: 3 }));
  await assertFails(deleteDoc(doc(db, 'events', 'event-1', 'candidates', '01_100')));
  await assertFails(updateDoc(doc(db, 'events', 'event-1'), { candidateCount: 3 }));
  await assertFails(setDoc(doc(db, 'events', 'event-1', 'candidates', '01_777'), {
    ...candidatePayload({ participantId: '777', team: '01', firstName: 'x', nationalId: '0' }),
    statusChangedAt: serverTimestamp(), statusChangedBy: 'adjutant1', profileUpdatedAt: serverTimestamp(), profileUpdatedBy: 'adjutant1'
  }));
});

test('adjutancy never reads evaluation data, notes, recommendations, schedules or other staff', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'races', 'race_01_07_1', 'evaluatorAssessments', 'evaluator1'), { ...assessmentPayload(), createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
    await setDoc(doc(db, 'races', 'race_01_07_1', 'evaluatorArrivals', 'evaluator1'), { evaluatorUid: 'evaluator1', participantIds: ['100'], order: ['100'], slotTimes: {}, schemaVersion: 1, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
    await setDoc(doc(db, 'events', 'event-1', 'generalNotes', '01_100', 'authors', 'evaluator1'), { ...privateNotesPayload(), createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
    await setDoc(doc(db, 'events', 'event-1', 'dropoutRecommendations', '01_100'), { ...recommendationPayload(), createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
    await setDoc(doc(db, 'events', 'event-1', 'candidateStatusEvents', 'transition-1'), { candidateKey: '01_100' });
    await setDoc(doc(db, 'events', 'event-1', 'schedule', 'master'), { eventId: 'event-1', rows: [] });
    await setDoc(doc(db, 'events', 'event-1', 'teamSchedules', '01'), { eventId: 'event-1', team: '01' });
    await setDoc(doc(db, 'events', 'event-1', 'staff', 'evaluator1'), { uid: 'evaluator1', role: 'evaluator', team: '01', active: true });
    await setDoc(doc(db, 'issue_reports', 'report-1'), { ...issuePayload(), createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
  });
  const db = userDb('adjutant1');
  await assertFails(getDoc(doc(db, 'races', 'race_01_07_1', 'evaluatorAssessments', 'evaluator1')));
  await assertFails(getDoc(doc(db, 'races', 'race_01_07_1', 'evaluatorArrivals', 'evaluator1')));
  await assertFails(getDoc(doc(db, 'events', 'event-1', 'generalNotes', '01_100', 'authors', 'evaluator1')));
  await assertFails(getDoc(doc(db, 'events', 'event-1', 'dropoutRecommendations', '01_100')));
  await assertFails(getDocs(collection(db, 'events', 'event-1', 'dropoutRecommendations')));
  await assertFails(getDoc(doc(db, 'events', 'event-1', 'candidateStatusEvents', 'transition-1')));
  await assertFails(getDoc(doc(db, 'events', 'event-1', 'schedule', 'master')));
  await assertFails(getDoc(doc(db, 'events', 'event-1', 'teamSchedules', '01')));
  await assertFails(getDoc(doc(db, 'events', 'event-1', 'staff', 'evaluator1')));
  await assertFails(getDoc(doc(db, 'users', 'evaluator1')));
  await assertFails(getDoc(doc(db, 'issue_reports', 'report-1')));
  await assertFails(getDoc(doc(db, 'races', 'legacy-race')));
  await assertFails(getDoc(doc(db, 'general_notes', '01_100')));
  // What intake needs: the event, its teams, all candidates and schema-2 round rosters.
  await assertSucceeds(getDoc(doc(db, 'users', 'adjutant1')));
  await assertSucceeds(getDoc(doc(db, 'events', 'event-1')));
  await assertSucceeds(getDocs(collection(db, 'events', 'event-1', 'teams')));
  await assertSucceeds(getDocs(collection(db, 'events', 'event-1', 'candidates')));
  await assertSucceeds(getDocs(collection(db, 'events', 'event-1', 'unassignedCandidates')));
  await assertSucceeds(getDocs(query(collection(db, 'races'), where('eventId', '==', 'event-1'),
    where('team', '==', '01'), where('evaluationSchemaVersion', '==', 2))));
  await assertFails(getDocs(collection(db, 'races')));
});

test('team staff and unapproved users have no intake access', async () => {
  for (const uid of ['operator1', 'evaluator1', 'adjutantPending']) {
    const db = userDb(uid);
    await assertFails(getDocs(collection(db, 'events', 'event-1', 'unassignedCandidates')));
    await assertFails(getDocs(collection(db, 'events', 'event-1', 'candidateNumbers')));
    await assertFails(getDoc(doc(db, 'events', 'event-1', 'intake', 'counter')));
    await assertFails(runTransaction(db, async transaction => {
      transaction.set(doc(db, 'events', 'event-1', 'intake', 'counter'), { lastNumber: 600, updatedAt: serverTimestamp(), updatedBy: uid });
      transaction.set(doc(db, 'events', 'event-1', 'candidateNumbers', '600'), numberEntry('600', '', uid));
      transaction.set(doc(db, 'events', 'event-1', 'unassignedCandidates', '600'), unassignedPayload('600', uid));
    }));
    await assert.rejects(createIntakeRepository(db, { uid, role: 'adjutant' }).createCandidate('event-1', person('x'), ''));
  }
  assert.throws(() => createIntakeRepository(userDb('operator1'), { uid: 'operator1', role: 'operator' }), /שלישות/);
  await assertFails(getDocs(collection(userDb('adjutantPending'), 'events', 'event-1', 'candidates')));
});

test('with event staffing, only an active intake staff member of the active event may intake', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'events', 'event-draft'), { name: 'טיוטה', status: 'draft', schemaVersion: 3 });
  });
  await useStaffingFor({ adjutant1: 'adjutant', formation1: 'formation_commander' });
  const created = await intakeRepo('adjutant1').createCandidate('event-1', person('משובץ'), '');
  assert.equal(created.participantId, '201');
  await assert.rejects(intakeRepo('adjutant2').createCandidate('event-1', person('לא משובץ'), ''), error => error.code === 'permission-denied');
  await assertFails(getDocs(collection(userDb('adjutant2'), 'events', 'event-1', 'candidates')));
  await assertFails(getDocs(query(collection(userDb('adjutant1'), 'events'), where('status', 'in', ['draft', 'active']))));
  await assertFails(getDocs(collection(userDb('adjutant1'), 'events', 'event-draft', 'teams')));
  await assertSucceeds(getDoc(doc(userDb('adjutant1'), 'events', 'event-1')));
  await assertFails(getDoc(doc(userDb('adjutant1'), 'events', 'event-draft')));
  await intakeRepo('formation1').createCandidate('event-1', person('ממפקד הגיבוש'), '01');
  await testEnv.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), 'events', 'event-1', 'staff', 'adjutant1'), { active: false });
  });
  await assert.rejects(intakeRepo('adjutant1').createCandidate('event-1', person('הוסר'), ''), error => error.code === 'permission-denied');
});

test('without an active event, adjutancy picks a draft event; closed events are closed to intake', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'settings', 'activeEvent'), { eventId: 'event-1', status: 'closed', schemaVersion: 3 });
    await updateDoc(doc(db, 'events', 'event-1'), { status: 'closed' });
    await setDoc(doc(db, 'events', 'event-draft'), { name: 'טיוטה', status: 'draft', schemaVersion: 3, rosterRevision: 0 });
    await setDoc(doc(db, 'events', 'event-draft', 'teams', '03'), { teamNumber: '03', participantIds: [], stationMap: {}, schemaVersion: 3, active: true });
  });
  const repo = intakeRepo('adjutant1');
  const events = await repo.listOpenEvents();
  assert.deepEqual(events.map(event => event.id), ['event-draft']);
  assert.deepEqual(await repo.createCandidate('event-draft', person('בטיוטה'), '03'), { participantId: '1', team: '03' });
  assert.deepEqual(await repo.createCandidate('event-draft', person('כללי בטיוטה'), ''), { participantId: '2', team: '' });
  await repo.moveCandidate('event-draft', { participantId: '1', from: '03', to: '' }, { eventStatus: 'draft' });
  assert.equal((await getDoc(doc(userDb('adjutant1'), 'events', 'event-draft', 'unassignedCandidates', '1'))).exists(), true);
  await assert.rejects(repo.createCandidate('event-1', person('בסגור'), ''));
  await assertFails(getDocs(collection(userDb('adjutant1'), 'events', 'event-1', 'candidates')));
});

test('the Excel import refuses numbers already taken by intake', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'events', 'event-draft'), { name: 'טיוטה', status: 'draft', schemaVersion: 3, teamCount: 0, candidateCount: 0 });
  });
  const intake = intakeRepo('adjutant1');
  const general = await intake.createCandidate('event-draft', person('כללי'), '');
  const admin = createEventSetupRepository(userDb('admin1'), { uid: 'admin1', role: 'admin' });
  await admin.ensureTeams('event-draft', ['01', '02'], () => ({}));
  const placed = await intake.createCandidate('event-draft', person('בצוות'), '02');
  assert.deepEqual([general.participantId, placed.participantId], ['1', '2']);
  await assert.rejects(admin.importCandidates('event-draft', [{ team: '01', candidates: [{ participantId: '1' }] }]), /כללי/);
  await assert.rejects(admin.importCandidates('event-draft', [{ team: '01', candidates: [{ participantId: '2' }] }]), /צוות 2/);
  // Replacing team 2 in a draft must not silently drop the candidate intake placed there.
  await assert.rejects(admin.importCandidates('event-draft', [{ team: '02', candidates: [{ participantId: '9' }] }]), /שלישות/);
  await admin.importCandidates('event-draft', [{ team: '01', candidates: [{ participantId: '3' }] }]);
  // Intake continues after the imported number.
  assert.equal((await intake.createCandidate('event-draft', person('אחרי ייבוא'), '')).participantId, '4');
});

test('adjutancy receives messages addressed to adjutancy only', async () => {
  await seedMessage('to-adjutancy', ['adjutant']);
  await seedMessage('to-evaluators', ['evaluator']);
  const adjutant = userDb('adjutant1');
  const visible = await assertSucceeds(recipientQuery(adjutant, 'adjutant'));
  assert.deepEqual(visible.docs.map(d => d.id), ['to-adjutancy']);
  await assertFails(recipientQuery(adjutant, 'evaluator'));
  await assertFails(getDoc(doc(adjutant, 'events', 'event-1', 'messages', 'to-evaluators')));
  await assertSucceeds(setDoc(doc(adjutant, 'events', 'event-1', 'messageReads', 'adjutant1'),
    { lastReadAt: serverTimestamp(), schemaVersion: 1 }));
  await assertFails(addDoc(collection(adjutant, 'events', 'event-1', 'messages'),
    messagePayload('adjutant1', 'adjutant', { targetRoles: ['operator'] })));
});

test('the evaluation repository writes pass the rules without transactions (first score, per-candidate update, other evaluator denied)', async () => {
  const errors = [];
  const repo = createEvaluationRepository(userDb('evaluator1'), { uid: 'evaluator1' }, { onWriteError: e => errors.push(e) });
  const ref = doc(userDb('evaluator1'), 'races', 'race_01_07_1', 'evaluatorAssessments', 'evaluator1');
  const flush = () => new Promise(resolve => setTimeout(resolve, 700));

  // first score creates the private document
  const first = await repo.mutateParticipant('race_01_07_1', '100', entry => ({ ...entry, scores: { resilience: 5 } }));
  assert.equal(first.entries['100'].scores.resilience, 5);
  await flush();
  assert.equal((await getDoc(ref)).data().entries['100'].scores.resilience, 5);

  // a later change replaces only that candidate's entry (a cleared score does not survive)
  await repo.mutateParticipant('race_01_07_1', '100', entry => ({ ...entry, scores: { activity: 3 } }));
  await repo.mutateParticipant('race_01_07_1', '101', entry => ({ ...entry, scores: { resilience: 7 } }));
  await flush();
  const saved = (await getDoc(ref)).data();
  assert.deepEqual(saved.entries['100'].scores, { activity: 3 });
  assert.equal(saved.entries['101'].scores.resilience, 7);

  // multi-candidate mutate (repetitions) still replaces the whole document
  await repo.mutate('race_01_07_1', entries => ({ ...entries, '100': { ...entries['100'], measurement: 12 } }));
  await flush();
  assert.equal((await getDoc(ref)).data().entries['100'].measurement, 12);
  assert.deepEqual(errors, []);

  // another evaluator's repository cannot write into evaluator1's document path
  const intruderErrors = [];
  const intruder = createEvaluationRepository(userDb('evaluator2'), { uid: 'evaluator1' }, { onWriteError: e => intruderErrors.push(e) });
  await intruder.mutateParticipant('race_01_07_1', '100', entry => ({ ...entry, scores: { resilience: 1 } })).catch(e => intruderErrors.push(e));
  await flush();
  assert.ok(intruderErrors.length >= 1);
});

test('fast start: one write opens a round, the commander may only remove candidates from a running round', async () => {
  const operator = userDb('operator1');
  await testEnv.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), 'races', 'race_01_07_5'), {
      eventId: 'event-1', team: '01', station: '07', round: 5, status: 'running',
      startedAt: Timestamp.now(), startedBy: 'operator1', timeLimitSeconds: 2400,
      participantIds: ['100', '101', '102'], tags: [], evaluationSchemaVersion: 2
    });
  });
  const ref = doc(operator, 'races', 'race_01_07_5');
  await assertSucceeds(updateDoc(ref, { participantIds: ['100', '102'] }));
  await assertFails(updateDoc(ref, { participantIds: ['100', '102', '999'] }));       // adding
  await assertFails(updateDoc(ref, { participantIds: ['100', '777'] }));              // swapping
  await assertFails(updateDoc(doc(userDb('operator2'), 'races', 'race_01_07_5'), { participantIds: ['100'] })); // other team
  await assertFails(updateDoc(doc(userDb('evaluator1'), 'races', 'race_01_07_5'), { participantIds: ['100'] })); // evaluator
  await assertSucceeds(updateDoc(ref, { status: 'stopped', endedAt: serverTimestamp(), endedBy: 'operator1', endedReason: 'manual' }));
  await assertFails(updateDoc(ref, { participantIds: ['100'] }));                     // stopped round
  await assertFails(updateDoc(ref, { status: 'stopped', endedAt: serverTimestamp(), endedBy: 'operator1', endedReason: 'manual' })); // ended twice

  // a new round in one batch (no transaction): create, and a second create of the same id is refused
  const batch = writeBatch(operator);
  batch.set(doc(operator, 'races', 'race_01_07_6'), { ...racePayload(), round: 6, evaluationSchemaVersion: 2 });
  await assertSucceeds(batch.commit());
  await assertFails(setDoc(doc(operator, 'races', 'race_01_07_6'), { ...racePayload(), round: 6, evaluationSchemaVersion: 2 }));
});

test('arrival place times are the tap moments, not the time the server processed the queue', async () => {
  await testEnv.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), 'races', 'race_01_07_1'), { participantIds: ['100', '320', '8'] });
  });
  const db = userDb('evaluator1');
  const repo = createArrivalRepository(db, { uid: 'evaluator1' }, arrivalState);
  const tapped = Date.now() - 60_000;        // taps made a minute before they reached the server
  await repo.mutate('race_01_07_1', { type: 'append', pid: '100', at: tapped });
  await repo.mutate('race_01_07_1', { type: 'append', pid: '320', at: tapped + 4_000 });
  await repo.mutate('race_01_07_1', { type: 'append', pid: '8', at: tapped + 9_500 });
  const saved = (await getDoc(arrivalReference(db))).data();
  assert.deepEqual(saved.order, ['100', '320', '8']);
  assert.deepEqual(['1', '2', '3'].map(place => saved.slotTimes[place].toMillis() - tapped), [0, 4_000, 9_500]);
  assert.equal(saved.revision, 3);
  assert.equal(saved.completedAt.toMillis(), tapped + 9_500);
});

test('the commander may record the tap moments of start and end, as timestamps only', async () => {
  const operator = userDb('operator1');
  const ref = doc(operator, 'races', 'race_01_07_7');
  await assertFails(setDoc(ref, { ...racePayload(), round: 7, evaluationSchemaVersion: 2, startTappedAt: 'now' }));
  await assertSucceeds(setDoc(ref, { ...racePayload(), round: 7, evaluationSchemaVersion: 2, startTappedAt: Timestamp.now() }));
  await assertFails(updateDoc(ref, { status: 'stopped', endedAt: serverTimestamp(), endedBy: 'operator1', endedReason: 'manual', endTappedAt: 5 }));
  await assertSucceeds(updateDoc(ref, { status: 'stopped', endedAt: serverTimestamp(), endedBy: 'operator1', endedReason: 'manual', endTappedAt: Timestamp.now() }));
  await assertFails(updateDoc(ref, { startTappedAt: Timestamp.now() }));   // the start cannot be moved afterwards
});
