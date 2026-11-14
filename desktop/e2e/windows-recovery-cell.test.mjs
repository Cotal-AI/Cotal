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

const restart={outcome:'passed',calledAt:new Date(1200).toISOString(),returnedAt:new Date(2000).toISOString(),
  before:{lifetime:{pid:10,start:'100'}},after:{lifetime:{pid:20,start:'200'}}};
const observed={atUnixMs:2600,recoveryShown:false,connectedShown:true,connectionTitle:'This computer is connected',notice:''};
const healthy=[row('start',2200,3),row('result',2500,3,'status',{ok:true})];
const bridges=[{at:new Date(2450).toISOString(),phase:'bridge-result',pid:30,parentPid:40,ok:true,daemonPid:20}];
const peers=[{at:new Date(2400).toISOString(),phase:'pipe-connected',pid:30,peer:{pid:20,birth:'200'}}];
const accepts=(rows=healthy,r=restart,ui=observed,b=bridges,p=peers,appPid=40)=>restartRecovery(rows,1100,r,ui,b,p,appPid);

test('restart accepts a missed stopped view only with a successful app bridge to the new PID and birth',()=>{
  const proof=accepts();
  assert.equal(proof.passed,true);
  assert.equal(proof.stopped,undefined);
  assert.equal(proof.bridgePeer.peer.pid,20);
  const stopped=row('result',1500,2,'status',{ok:false,error:{code:'NOT_RUNNING'}});
  assert.equal(accepts([stopped,...healthy]).passed,true);
  assert.equal(accepts([{...stopped,request:{op:'service-status'}},...healthy]).passed,true);
});

test('restart refuses CLI-only, stale, wrong-generation or uncorrelated bridge evidence',()=>{
  for(const b of [[],[{...bridges[0],parentPid:41}],[{...bridges[0],ok:false}],[{...bridges[0],daemonPid:10}],
    [{...bridges[0],at:new Date(2100).toISOString()}],[...bridges,...bridges]]) assert.equal(accepts(healthy,restart,observed,b).passed,false);
  for(const p of [[],[{...peers[0],pid:31}],[{...peers[0],peer:{pid:20,birth:'100'}}],
    [{...peers[0],peer:{pid:10,birth:'200'}}],[{...peers[0],at:new Date(2460).toISOString()}]]) assert.equal(accepts(healthy,restart,observed,bridges,p).passed,false);
  for(const lifetime of [{pid:10,start:'200'},{pid:20,start:'100'},{pid:20,start:undefined}]){
    assert.equal(accepts(healthy,{...restart,after:{lifetime}}).passed,false);
  }
  assert.equal(accepts(healthy,{...restart,outcome:'failed'}).passed,false);
  assert.equal(accepts(healthy,restart,observed,bridges,peers,null).passed,false);
  assert.equal(accepts([healthy[1]]).passed,false);
  assert.equal(accepts([healthy[0],{...healthy[1],ok:false}]).passed,false);
  assert.equal(accepts(healthy,{...restart,returnedAt:new Date(2300).toISOString()}).passed,false);
});

test('restart still requires no input and a clean final connected view after the app reply',()=>{
  for(const op of ['install','setup','login']) assert.equal(accepts([...healthy,row('start',2400,4,op)]).passed,false);
  for(const ui of [{...observed,recoveryShown:true},{...observed,connectedShown:false},
    {...observed,connectionTitle:'Ready to connect'},{...observed,notice:'failed'},{...observed,atUnixMs:2499}]) assert.equal(accepts(healthy,restart,ui).passed,false);
});

test('actual entry requires connected acceptance, preserves ownership and does not force product timers',async()=>{
  const {readFileSync}=await import('node:fs');
  const src=readFileSync(new URL('./first-run.ts',import.meta.url),'utf8');
  const block=src.slice(src.indexOf('const recoveryAcceptance'),src.indexOf('const proveWindowsRestart'));
  assert.match(block,/prepare-disabled-staged/);
  assert.match(block,/stoppedView = \{ status: "not seen" \}/);
  assert.match(block,/status: "seen", atUnixMs: value\.atUnixMs/);
  assert.doesNotMatch(block,/until\("app poll sees the restarting service stopped"|until\("native window displays the background-check error"/);
  assert.match(block,/restartRecovery\(rows\(\), evidence\.restartStartedAtUnixMs, evidence\.preparation, value,/);
  assert.match(block,/traceRows\(join\(output, "windows-bridge-progress\.jsonl"\)\), traceRows\(join\(output, "windows-peer-identity\.jsonl"\)\), windowsAppPid/);
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
