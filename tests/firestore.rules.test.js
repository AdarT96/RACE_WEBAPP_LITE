import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  initializeTestEnvironment, assertSucceeds, assertFails
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp, Timestamp
} from 'firebase/firestore';
import { buildIssueReportData } from '../frontend/js/issue-report.js';

const PROJECT_ID = 'demo-race-webapp-lite';
let testEnv;

function userDb(uid) {
  return testEnv.authenticatedContext(uid).firestore();
}

async function seedData() {
  await testEnv.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    const users = {
      admin1: { uid: 'admin1', name: 'מנהל', role: 'admin', team: 1, approved: true },
      operator1: { uid: 'operator1', name: 'מפקצ 1', role: 'operator', team: 1, approved: true },
      operator2: { uid: 'operator2', name: 'מפקצ 2', role: 'operator', team: 2, approved: true },
      evaluator1: { uid: 'evaluator1', name: 'מעריך 1', role: 'evaluator', team: 1, approved: true }
    };
    for (const [uid, data] of Object.entries(users)) {
      await setDoc(doc(db, 'users', uid), data);
    }
    await setDoc(doc(db, 'races', 'race_01_07_1'), {
      team: '01', station: '07', round: 1, status: 'running',
      startedAt: Timestamp.fromMillis(Date.now() - 10_000), startedBy: 'operator1',
      timeLimitSeconds: 2400, participantIds: ['100'], tags: []
    });
  });
}

function racePayload({ withLimit = true } = {}) {
  return {
    team: '01', station: '07', round: withLimit ? 2 : 3, status: 'running',
    startedAt: serverTimestamp(), startedBy: 'operator1', participantIds: ['100'], tags: [],
    ...(withLimit ? { timeLimitSeconds: 2400 } : {})
  };
}

function issuePayload(overrides = {}) {
  const report = buildIssueReportData({
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

test('legacy clients may omit the limit but cannot choose another limit', async () => {
  const operator = userDb('operator1');
  await assertSucceeds(setDoc(doc(operator, 'races', 'race_01_07_3'), racePayload({ withLimit: false })));
  await assertFails(setDoc(doc(operator, 'races', 'race_01_07_4'), {
    ...racePayload(), round: 4, timeLimitSeconds: 3600
  }));
});

test('evaluators can still edit evaluation data but never lifecycle fields', async () => {
  const evaluator = userDb('evaluator1');
  await assertSucceeds(updateDoc(doc(evaluator, 'races', 'race_01_07_1'), {
    tags: [{ participantId: '100', reps: 4 }]
  }));
  await assertFails(updateDoc(doc(evaluator, 'races', 'race_01_07_1'), {
    status: 'stopped', endedAt: serverTimestamp(), endedBy: 'evaluator1'
  }));
});

test('a reporter can create only an allow-listed own-team issue report', async () => {
  const evaluator = userDb('evaluator1');
  await assertSucceeds(setDoc(doc(evaluator, 'issue_reports', 'report-1'), issuePayload()));
  await assertFails(getDoc(doc(evaluator, 'issue_reports', 'report-1')));
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
