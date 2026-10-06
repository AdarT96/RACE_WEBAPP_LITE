import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { planEventRoster, PROFILE_FIELDS } from '../frontend/js/event-roster-plan.js';
import { normalizeEventTeamId, EVENT_STATUSES, newEventTeamData } from '../frontend/js/event-setup-model.js';
import { normalizeCandidateProfile } from '../frontend/js/formation-operations-model.js';

const source = readFileSync(new URL('../frontend/js/event-setup-repository.js',import.meta.url),'utf8')
  .replace(/import\s+[\s\S]*?from\s+'[^']+';/g,'').replace(/export /g,'');
function fixture({ size=10, replacement=false, beforeTransaction=()=>{} }={}) {
  const db={}, store=new Map([['events/demo',{status:'draft',candidateCount:replacement?size*20:0}]]);
  const groups=Array.from({length:size},(_,i)=>({team:String(i+1).padStart(2,'0'),
    candidates:Array.from({length:20},(_,j)=>({participantId:String(j+1)}))}));
  for(const group of groups){
    store.set(`events/demo/teams/${group.team}`,{participantIds:replacement?Array.from({length:20},(_,i)=>String(i+101)):[]});
    if(replacement)for(let i=101;i<=120;i++)store.set(`events/demo/candidates/${group.team}_${i}`,{
      ...normalizeCandidateProfile({participantId:String(i)}),team:group.team,profileRevision:0
    });
  }
  const counts={collections:0,transactions:0,commits:0,writes:0};
  const snapshot=path=>({id:path.split('/').at(-1),exists:()=>store.has(path),data:()=>structuredClone(store.get(path))});
  const context={planEventRoster,PROFILE_FIELDS,normalizeEventTeamId,EVENT_STATUSES,newEventTeamData,
    CANDIDATE_SCHEMA_VERSION:3,MAX_EVENT_TEAMS:20,
    doc:(_, ...parts)=>parts.join('/'),collection:(_, ...parts)=>parts.join('/'),serverTimestamp:()=>123,
    getDoc:async path=>snapshot(path),
    getDocs:async path=>{counts.collections++;const docs=[...store.keys()].filter(key=>key.startsWith(path+'/')&&key.split('/').length===path.split('/').length+1).map(snapshot);return{docs,size:docs.length};},
    runTransaction:async (_,callback)=>{
      counts.transactions++;beforeTransaction(counts.transactions,store);
      const writes=[];
      const result=await callback({get:async path=>snapshot(path),
        set:(path,data)=>writes.push(()=>store.set(path,data)),
        update:(path,data)=>writes.push(()=>store.set(path,{...store.get(path),...data})),
        delete:path=>writes.push(()=>store.delete(path))});
      writes.forEach(write=>write());counts.commits++;counts.writes+=writes.length;return result;
    }
  };
  const repository=runInNewContext(source+'\ncreateEventSetupRepository(db,{uid:"admin",role:"admin"})',{...context,db});
  return{repository,counts,store,groups};
}

test('ten-team import scans each collection once and commits once; retry does not write',async()=>{
  const f=fixture();
  await f.repository.importCandidates('demo',f.groups);
  assert.equal(f.counts.collections,2);
  assert.equal(f.counts.commits,1);
  assert.equal(f.counts.writes,211);
  assert.equal(f.store.get('events/demo').candidateCount,200);
  await f.repository.importCandidates('demo',f.groups);
  assert.equal(f.counts.commits,1);
});

test('parallel imports are rejected before any writes',async()=>{
  const f=fixture({beforeTransaction:(_,store)=>{store.get('events/demo').rosterRevision=1;}});
  await assert.rejects(f.repository.importCandidates('demo',f.groups),error=>{
    assert.equal(error.completedTeams.length,0);
    assert.equal(error.pendingTeams.length,10);return true;
  });
  assert.equal(f.counts.commits,0);
});

test('late failure reports committed teams and keeps counts consistent; retry completes without redoing them',async()=>{
  let fail=true;
  const f=fixture({size:20,replacement:true,beforeTransaction:index=>{if(fail&&index===2)throw new Error('offline');}});
  await assert.rejects(f.repository.importCandidates('demo',f.groups),error=>{
    assert.equal(error.completedTeams.length,10);
    assert.equal(error.pendingTeams.length,10);return true;
  });
  assert.equal(f.store.get('events/demo').candidateCount,400);
  assert.equal(f.store.get('events/demo').rosterRevision,1);
  fail=false;
  await f.repository.importCandidates('demo',f.groups);
  assert.equal(f.counts.commits,2);
  assert.equal(f.store.get('events/demo').candidateCount,400);
  assert.equal(f.store.get('events/demo').rosterRevision,2);
});

test('invalid final team prevents writes to earlier teams',async()=>{
  const f=fixture();f.groups.at(-1).candidates.push({participantId:'21'});
  await assert.rejects(f.repository.importCandidates('demo',f.groups));
  assert.equal(f.counts.transactions,0);
});
