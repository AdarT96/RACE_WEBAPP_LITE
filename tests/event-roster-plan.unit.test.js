import test from 'node:test';
import assert from 'node:assert/strict';
import { planEventRoster, ROSTER_WRITE_LIMIT } from '../frontend/js/event-roster-plan.js';
import { normalizeCandidateProfile } from '../frontend/js/formation-operations-model.js';
import { candidateRowsFromMatrix, buildCandidateRosterImport } from '../frontend/js/candidate-roster-import.js';

const candidate = (team, id, extra = {}) => ({
  ...normalizeCandidateProfile({ participantId:String(id) }),
  id:`${team}_${id}`, team, profileRevision:2, ...extra
});
const team = id => ({ id, participantIds:[], active:true });
const input = { status:'draft', teams:[team('01'), team('02')], existing:[],
  groups:[{ team:'01', candidates:[{ participantId:'100' }] }] };

test('candidates may create teams without a schedule', () => {
  const plan = planEventRoster({...input,teams:[]});
  assert.equal(plan.teamCount,1);
  assert.equal(plan.plans[0].previousTeam,undefined);
  assert.equal(plan.candidateCount,1);
});

test('missing columns and blank cells preserve stored profile values on reimport', () => {
  const adapted=candidateRowsFromMatrix([['צוות','מספר מועמד','שם מלא','מספר זהות'],[1,100,'שם חדש','']]);
  const groups=buildCandidateRosterImport({rows:adapted.rows,allowIncompleteProfiles:true}).teams;
  const existing=[candidate('01','100',{...normalizeCandidateProfile({participantId:'100',fullName:'שם קודם',nationalId:'000000018',emergencyContactPhone:'0501234567',doctorClearance:1,medicClearance:2}),status:'withdrawn'})];
  const plan=planEventRoster({...input,status:'active',existing,groups});
  const saved=plan.plans[0].changes[0].candidate;
  assert.equal(saved.fullName,'שם חדש');
  assert.equal(saved.nationalId,'000000018');
  assert.equal(saved.emergencyContactPhone,'0501234567');
  assert.equal(saved.doctorClearance,1);
  assert.equal(saved.medicClearance,2);
  assert.equal(existing[0].status,'withdrawn');
});

test('event plan validates all teams before any storage work', () => {
  for (const groups of [[], [{team:'21',candidates:[]}], [{team:'01',candidates:[{participantId:'0'}]}],
    [{team:'01',candidates:[]},{team:'01',candidates:[]}]]) {
    assert.throws(() => planEventRoster({ ...input, groups }));
  }
  assert.throws(() => planEventRoster({ ...input, status:'closed' }));
});

test('draft replacement deletes only omitted candidates of selected teams', () => {
  const plan = planEventRoster({ ...input, existing:[candidate('01','99'),candidate('02','200')] });
  assert.deepEqual(plan.plans[0].changes.map(change => change.kind), ['delete','create']);
  assert.equal(plan.candidateCount, 2);
  assert.equal(plan.plans.length, 1);
});

test('active roster preserves omitted candidates and writes only profile fields for existing candidates', () => {
  const old = candidate('01','100',{status:'withdrawn',reasonCode:'medical',statusRevision:4});
  const plan = planEventRoster({ ...input, status:'active', existing:[old,candidate('01','99')],
    groups:[{team:'01',candidates:[{participantId:'100',firstName:'תיקון'}]}] });
  assert.deepEqual(plan.plans[0].participantIds,['99','100']);
  assert.equal(plan.plans[0].changes.length,1);
  assert.equal(plan.plans[0].changes[0].kind,'update');
  assert.equal(old.statusRevision,4);
  assert.equal(plan.candidateCount,2);
});

test('duplicates are checked against candidates outside the imported teams', () => {
  assert.throws(() => planEventRoster({ ...input, existing:[candidate('02','200',{nationalId:'039284906'})],
    groups:[{team:'01',candidates:[{participantId:'100',nationalId:'039284906'}]}] }), /תעודת זהות/);
});

test('identical retries have no writes and do not increment profile revisions', () => {
  const plan = planEventRoster({ ...input,
    teams:[{ ...team('01'),participantIds:['100'],rosterSource:{type:'manual',sourceId:'event-setup',fileName:''} }],
    existing:[candidate('01','100')] });
  assert.deepEqual(plan.chunks,[]);
});

test('20 teams and 400 new candidates fit in one atomic group', () => {
  const teams=Array.from({length:20},(_,i)=>team(String(i+1).padStart(2,'0')));
  const groups=teams.map(({id})=>({team:id,candidates:Array.from({length:20},(_,i)=>({participantId:String(i+1)}))}));
  const plan=planEventRoster({...input,teams,groups});
  assert.equal(plan.chunks.length,1);
  assert.equal(plan.candidateCount,400);
  assert.equal(plan.chunks[0].reduce((sum,t)=>sum+t.writeCount,1),421);
  const replacement=planEventRoster({...input,teams,groups,existing:teams.flatMap(t=>
    Array.from({length:20},(_,i)=>candidate(t.id,String(i+101))))});
  assert.equal(replacement.chunks.length,2);
  for(const chunk of replacement.chunks) assert.ok(chunk.reduce((sum,t)=>sum+t.writeCount,1)<=ROSTER_WRITE_LIMIT);
  assert.equal(replacement.chunks.flat().length,20);
});

test('an active team cannot exceed 20 after preserving omitted candidates', () => {
  assert.throws(()=>planEventRoster({...input,status:'active',
    existing:Array.from({length:20},(_,i)=>candidate('01',String(i+1)))}),/20/);
});
