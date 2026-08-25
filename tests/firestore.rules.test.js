import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  initializeTestEnvironment, assertSucceeds, assertFails
} from '@firebase/rules-unit-testing';
import {
  collection, doc, getDoc, getDocs, query, where,
  setDoc, updateDoc, serverTimestamp, Timestamp, runTransaction
} from 'firebase/firestore';
import {
  buildIssueReportData, ISSUE_REPORT_SCHEMA_VERSION
} from '../frontend/js/issue-report.js';

const PROJECT_ID = 'demo-race-webapp-lite';
let testEnv;

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
      formation1: { uid: 'formation1', name: 'מפקד הגיבוש', role: 'formation_commander', team: null, approved: true }
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

test('only an admin can correct candidate identity and cannot do so without a profile revision', async () => {
  const commanderRef = doc(userDb('formation1'), 'events', 'event-1', 'candidates', '01_100');
  await assertFails(updateDoc(commanderRef, {
    firstName: 'נעמה', profileRevision: 1,
    profileUpdatedAt: serverTimestamp(), profileUpdatedBy: 'formation1'
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

test('direct formation status changes append an atomic immutable audit event', async () => {
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
