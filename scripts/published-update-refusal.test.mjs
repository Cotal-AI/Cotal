import assert from 'node:assert/strict';
import test from 'node:test';
import { publishedStagedRefusal, publishedSchedulerBudget } from './published-update-refusal.mjs';

test('published target check requires exact exit1 escape message and known outcome', () => {
  const update={exit:1,signal:null,timeout:false,stdout:'',stderr:'Install the new version once by hand'};
  assert.equal(publishedStagedRefusal(update),true);
  assert.equal(publishedStagedRefusal({...update,exit:3}),false);
  assert.equal(publishedStagedRefusal({...update,timeout:true}),false);
  assert.equal(publishedStagedRefusal({...update,stderr:'unprotected execution entry'}),false);
});
function observations(deferrals) {
  return [0,1,2].map(index=>{
    const stimulusAt=1000000+index*10000, observedAt=stimulusAt+5000;
    const waiting=!deferrals&&index===2;
    const failures=deferrals?0:Math.min(index+1,2);
    const reason='staged pre-install check refused';
    return {before:{failures:deferrals?0:index},stimulusAt,observedAt,beforeStore:{logicalBytes:0},beforeLogSha256:'previous',logSha256:waiting?'previous':`attempt-${index}`,logMtimeMs:stimulusAt+1000,
      attempt:{failures,result:waiting?'version 0.164.18 failed twice; waiting':reason,...(deferrals?{deferred:reason}:{}),next:stimulusAt+1000+(waiting?86400000:deferrals?60000:3600000)},
      text:'Install the new version once by hand',store:{state:'missing',logicalBytes:0,passed:true}};
  });
}
test('deferrals repeat safely without spending the failure budget or forcing third-observation pause',()=>{
  assert.equal(publishedSchedulerBudget(observations(true)),true);
  const spent=observations(true);spent[2].attempt.failures=1;
  assert.throws(()=>publishedSchedulerBudget(spent),/deferral changed failure budget/);
  const stale=observations(true);stale[2].logMtimeMs=0;
  assert.throws(()=>publishedSchedulerBudget(stale),/not written by this attempt/);
});
test('counted failures increment once and third observation waits without another updater',()=>{
  assert.equal(publishedSchedulerBudget(observations(false)),true);
  const reset=observations(false);reset[2].attempt.failures=0;
  assert.throws(()=>publishedSchedulerBudget(reset),/budget/);
  const rerun=observations(false);rerun[2].logSha256='third';
  assert.throws(()=>publishedSchedulerBudget(rerun),/updater log/);
  const seeded=observations(false);seeded[1].before.failures=0;
  assert.throws(()=>publishedSchedulerBudget(seeded),/changed between/);
});
test('outcome-specific retry time is checked rather than a fabricated common delay',()=>{
  for(const deferred of [true,false]){
    const early=observations(deferred);early[0].attempt.next=early[0].stimulusAt+100;
    assert.throws(()=>publishedSchedulerBudget(early),/next-attempt time/);
    const late=observations(deferred);late[0].attempt.next+=7200000;
    assert.throws(()=>publishedSchedulerBudget(late),/next-attempt time/);
  }
});
test('historical leftover staging stays recorded while fixed refusals require zero growth and safe stores',()=>{
  const dirty=observations(true);dirty[0].store={state:'complete',logicalBytes:66000000,passed:false,violations:[{reason:'unfinished generation staging'}]};
  assert.equal(publishedSchedulerBudget(dirty),true);
  assert.equal(dirty[0].store.violations.length,1);
  assert.throws(()=>publishedSchedulerBudget(dirty,{fixedSource:true}),/unsafe staging/);
  const growth=observations(true);growth[0].store.logicalBytes=1;
  assert.throws(()=>publishedSchedulerBudget(growth,{fixedSource:true}),/grew/);
  assert.equal(publishedSchedulerBudget(observations(true),{fixedSource:true}),true);
});
