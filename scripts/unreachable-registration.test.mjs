import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {planRelease,verifyResults} from './upgrade-matrix-plan.mjs';
import {verifyUnreachableRegistration} from './unreachable-registration-evidence.mjs';

function evidence(){
 const state={local:'update-stopped',gone:'update-gone',localPort:12345,gonePort:12346,localRoot:'/private/local',goneRoot:'/private/gone',commandRoot:'/private/neutral'};
 const registry=JSON.stringify({space:state.gone,mode:'open',origin:'manual',offline:true})+'\n';
 state.before={registry,journalSha256:'a'.repeat(64)};state.after={...state.before};
 const calls=[];
 const call=(label,argv=[],stdout='',exit=0,after=false)=>calls.push({label,argv,stdout,stderr:'',exit,signal:null,timeout:false,npmBefore:null,startedAt:after?'2026-01-01T00:00:03Z':'2026-01-01T00:00:00Z',finishedAt:after?'2026-01-01T00:00:04Z':'2026-01-01T00:00:01Z'});
 for(const label of ['prepare stopped local space','clear selection for install-wide continuity'])call(label);
 call('start real local broker without Manager',['entry','up','--no-manager']);
 call('stop owned local broker before update',[],'Controller stack stopped');
 call('register unreachable broker through public CLI',['entry','space','add',state.gone,'--server',`nats://127.0.0.1:${state.gonePort}`,'--root',state.goneRoot,'--mode','open','--force','--yes']);
 call('selection before unreachable update',[],JSON.stringify({result:{current:null}}));
 call('registry before unreachable update',[],registry);
 call('upgrade under test',['entry','update','--self']);
 Object.assign(calls.at(-1),{startedAt:'2026-01-01T00:00:01Z',finishedAt:'2026-01-01T00:00:03Z'});
 call('registry after unreachable update',[],registry,0,true);
 return {report:{source:'0.165.3',target:'0.165.4',method:'self',layout:'npm',unreachableRegistration:state,calls,cleanupSafety:{passed:true},compositionCleanup:'owned composition stopped before reporting'},cell:{scenario:'unreachable-registration'}};
}
test('both POSIX states are required and a known red cannot waive acceptance',()=>{
 for(const phase of ['candidate','published']){
  const plan=planRelease({eventName:'workflow_dispatch',inputs:{phase,sourceSHA:'a'.repeat(40),targetVersion:'0.165.4'}},{sourceVersion:'0.165.3'});
  const states=plan.cells.filter(cell=>cell.scenario==='unreachable-registration');
  assert.deepEqual(states.map(cell=>cell.platform),['linux','darwin']);
  assert(states.every(cell=>cell.required&&cell.requiredAssertions.includes('offline-registration-retained')&&cell.requiredAssertions.includes('stopped-stack-retained')));
  const results=plan.cells.filter(cell=>cell.required).map(cell=>({id:cell.id,status:'passed',assertions:Object.fromEntries(cell.requiredAssertions.map(name=>[name,true]))}));
  assert.equal(verifyResults(plan.cells,results).acceptance,true);
  results.find(row=>row.id===states[0].id).status='failed';
  const verdict=verifyResults(plan.cells,results);assert.equal(verdict.acceptance,false);assert.equal(verdict.upgradeAcceptance,false);
 }
});
test('public setup receipts bind unchanged offline state and command ordering',()=>{
 const input=evidence();assert.equal(verifyUnreachableRegistration(input).upgradePassed,true);
 for(const change of [
  r=>r.calls.push({...r.calls[0]}),
  r=>r.calls.find(c=>c.label==='stop owned local broker before update').exit=2,
  r=>r.calls.find(c=>c.label==='start real local broker without Manager').argv=[],
  r=>r.calls.find(c=>c.label==='selection before unreachable update').stdout='{"result":{"current":"update-stopped"}}',
  r=>r.unreachableRegistration.after.journalSha256='b'.repeat(64),
  r=>r.unreachableRegistration.gonePort=r.unreachableRegistration.localPort,
  r=>r.calls.find(c=>c.label==='registry after unreachable update').startedAt='2025-01-01T00:00:00Z',
  r=>r.cleanupSafety.passed=false,
 ]){const bad=evidence();change(bad.report);assert.throws(()=>verifyUnreachableRegistration(bad));}
});
test('exact measured public refusal is labelled red, never an upgrade pass',()=>{
 const input=evidence(),update=input.report.calls.find(call=>call.label==='upgrade under test');update.exit=1;
 update.stderr='staged pre-install check refused: ✗ no broker answered at nats://127.0.0.1:12346; "update-gone" is registered here but its mesh is not up - start it where it runs, or `cotal space forget update-gone` to unregister it; no installed packages or connector state were changed\n';
 const verdict=verifyUnreachableRegistration(input);assert.equal(verdict.knownRed,true);assert.equal(verdict.upgradePassed,false);
 update.stderr+='other failure';assert.equal(verifyUnreachableRegistration(input).knownRed,false);
});
test('workflow invokes real composition and source-bound verifier without acceptance waiver',()=>{
 const workflow=readFileSync(new URL('../.github/workflows/automatic-update-platforms.yml',import.meta.url),'utf8');
 for(const text of ['options.prepare = prepareUnreachableRegistration','verifyUnreachableRegistration({ report, cell })','unreachable registration fixture source mismatch','known red ${unreachableEvidence.issue}, not upgrade acceptance'])assert(workflow.includes(text));
 assert(!workflow.includes('knownRefusals.push({ id: cell.id, issue: unreachableEvidence.issue')); 
});
