import test from 'node:test';
import assert from 'node:assert/strict';
import { heldBeforePoll, stoppedPoll, requestSummary, recoveryWaitMs, restartRecovery } from './windows-recovery-cell.mjs';
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

test('restart acceptance needs a stopped reply during restart then healthy poll and connected readback without setup input',()=>{
  const stopped=row('result',1500,2,'status',{ok:false,error:{code:'NOT_RUNNING'}});
  const healthy=row('result',2500,3,'status',{ok:true});
  const restart={calledAt:new Date(1200).toISOString(),returnedAt:new Date(2000).toISOString()};
  const observed={atUnixMs:2600,recoveryShown:false,connectedShown:true,connectionTitle:'This computer is connected'};
  assert.equal(restartRecovery([stopped,healthy],1100,restart,observed).passed,true);
  assert.equal(restartRecovery([{...stopped,request:{op:'service-status'}},healthy],1100,restart,observed).passed,true);
  for(const rows of [[healthy],[stopped],[stopped,healthy,row('start',2400,4,'install')],[stopped,healthy,row('start',2400,4,'setup')]]){
    assert.equal(restartRecovery(rows,1100,restart,observed).passed,false);
  }
  assert.equal(restartRecovery([stopped,healthy],1100,{...restart,calledAt:new Date(1600).toISOString()},observed).passed,false);
  assert.equal(restartRecovery([stopped,healthy],1100,restart,{...observed,recoveryShown:true}).passed,false);
  assert.equal(restartRecovery([stopped,healthy],1100,restart,{...observed,connectionTitle:'Ready to connect'}).passed,false);
});

test('actual entry requires connected acceptance, preserves ownership and does not force product timers',async()=>{
  const {readFileSync}=await import('node:fs');
  const src=readFileSync(new URL('./first-run.ts',import.meta.url),'utf8');
  const block=src.slice(src.indexOf('const recoveryAcceptance'),src.indexOf('const proveWindowsRestart'));
  assert.match(block,/prepare-disabled-staged/);
  assert.match(block,/value\.recoveryShown && value\.action === "install"/);
  assert.match(block,/Math\.min\(5000, remaining\)/);
  assert.match(block,/evidence\.inputs\.length === 0 && evidence\.restartRecovery\.passed/);
  assert.match(block,/throw new Error\("Start service did not return/);
  assert.match(block,/evidence\.connectedAtUnixMs <= deadline/);
  assert.match(block,/evidence\.connectedReceivedAtUnixMs <= deadline && evidence\.observationCompletedAtUnixMs <= deadline/);
  assert.match(block,/row\.requestId === evidence\.installStart\.requestId && row\.phase === "result" && row\.ok === true/);
  assert.match(block,/"verify-recovered"/);
  assert.match(src,/recoveryCell, acceptance: true/);
  assert.doesNotMatch(src,/diagnostic-complete|A diagnostic result is not full onboarding/);
  assert.doesNotMatch(block,/window\.(?:setTimeout|setInterval)\s*=|window\.clearTimeout|\.invoke\(/);
});
