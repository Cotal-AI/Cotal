import test from 'node:test';
import assert from 'node:assert/strict';
import { heldBeforePoll, stoppedPoll, requestSummary, recoveryWaitMs } from './windows-recovery-cell.mjs';
const row=(phase, atUnixMs, requestId=1, op='status', extra={})=>({phase,atUnixMs,requestId,request:{op},...extra});
const baseline=row('result',1000,1,'status',{ok:true});
const ui={action:'connect',buttonText:'Check again',recoveryShown:true,disabled:false};

test('before-poll counts only fresh healthy baseline and no request crossing native disable to click',()=>{
  const initial=[row('start',900),baseline];
  assert.equal(heldBeforePoll(initial,baseline,1100,2000,ui).held,true);
  for(const added of[[row('start',1500,2)],[row('result',1600,2,'status',{ok:false})],[row('start',1050,2,'service-status')]]){
    assert.equal(heldBeforePoll([...initial,...added],baseline,1100,2000,ui).held,false);
  }
  assert.equal(heldBeforePoll(initial,baseline,4000,4500,ui).held,false);
  assert.equal(heldBeforePoll(initial,baseline,1100,2000,{...ui,action:'refresh'}).held,false);
});

test('after-poll requires actual timestamped native stopped reply, not elapsed time or arbitrary error',()=>{
  const stopped=row('result',1500,2,'status',{ok:false,error:{code:'NOT_RUNNING'}});
  assert.equal(stoppedPoll([baseline,stopped],1200),stopped);
  assert.equal(stoppedPoll([baseline,stopped],1600),undefined);
  assert.equal(stoppedPoll([row('result',1500,2,'status',{ok:false,error:{code:'OTHER'}})],1200),undefined);
});

test('public summary excludes complete requests and error details and keeps actual terminal outcome',()=>{
  assert.deepEqual(requestSummary([row('timeout',1800,4,'setup',{elapsedMs:1500,error:{code:'X',message:'private'}})],1000),[
    {atUnixMs:1800,requestId:4,phase:'timeout',op:'setup',ok:undefined,errorCode:'X',elapsedMs:1500},
  ]);
  assert.equal(recoveryWaitMs,180_000);
});

test('actual entry keeps diagnostic result separate from native acceptance and product timers untouched',async()=>{
  const {readFileSync}=await import('node:fs');
  const src=readFileSync(new URL('./first-run.ts',import.meta.url),'utf8');
  const block=src.slice(src.indexOf('const recoveryDiagnostic'),src.indexOf('const proveWindowsRestart'));
  assert.match(block,/prepare-disabled-staged/);
  assert.match(block,/value\.recoveryShown && value\.action === "refresh"/);
  assert.match(block,/Math\.min\(5000, remaining\)/);
  assert.match(block,/outcome = "race-not-held"/);
  assert.match(src,/return; \/\/ A diagnostic result is not full onboarding or account acceptance/);
  assert.doesNotMatch(block,/window\.(?:setTimeout|setInterval)\s*=|window\.clearTimeout|\.invoke\(/);
});
