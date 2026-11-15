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
test('third unchanged-budget observation must pause, not silently reset or run updater', () => {
 const observations=[1,2,2].map((failures,index)=>({stimulusAt:100,attempt:{next:200,failures,result:index===2?'version 0.164.18 failed twice; waiting for a newer version or manual update':'staged pre-install check refused'},text:'Install the new version once by hand',store:{passed:true},logSha256:index===0?'first':'second'}));
 assert.equal(publishedSchedulerBudget(observations),true);
 const reset=structuredClone(observations);reset[2].attempt.failures=0;assert.throws(()=>publishedSchedulerBudget(reset),/budget/);
 const rerun=structuredClone(observations);rerun[2].logSha256='third';assert.throws(()=>publishedSchedulerBudget(rerun),/updater log/);
 const dirty=structuredClone(observations);dirty[0].store.passed=false;assert.throws(()=>publishedSchedulerBudget(dirty),/staging/);
});
