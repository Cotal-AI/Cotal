import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
const file=new URL('./windows-auto-product-cell.mjs',import.meta.url);
const source=readFileSync(file,'utf8');
const workflow=parse(readFileSync(new URL('../.github/workflows/windows-auto-update-feature.yml',import.meta.url),'utf8'));
test('temporary workflow admits only measurement branch, reuses native builders and Windows2022 acceptance',()=>{
 assert.deepEqual(workflow.on.push.branches,['measure/auto-update-windows']);
 assert.equal(workflow.on.pull_request,undefined);assert.equal(workflow.on.workflow_dispatch,undefined);
 assert.equal(workflow.jobs.native.uses,'./.github/workflows/workspace-native.yml');assert.equal(workflow.jobs.native.with.darwin,true);
 assert.equal(workflow.jobs.acceptance['runs-on'],'windows-2022');assert.equal(workflow.jobs.acceptance.needs,'native');
 assert.equal(workflow.jobs.acceptance.steps.at(-1).if,'always()');
 const commands=workflow.jobs.acceptance.steps.map(x=>x.run??'').join('\n');
 assert.match(commands,/smoke:win32-update-job/);assert.match(commands,/smoke:auto-update-windows/);assert.doesNotMatch(commands,/mutation|fix-reversion/);
});
test('workflow environment keys are unique ignoring case at every scope',()=>{
 const visit=value=>{if(!value||typeof value!=='object')return;if(value.env){const keys=Object.keys(value.env);assert.equal(new Set(keys.map(k=>k.toUpperCase())).size,keys.length,'GitHub env keys ignore case');}for(const child of Object.values(value))visit(child);};
 visit(workflow);
 assert.equal(workflow.jobs.acceptance.env.pnpm_config_workspace_concurrency,'3');
});
test('driver reuses verified matrix packing and overlay, stock manual firsthop arms existing service without another command',()=>{
 assert.match(source,/candidateRegistry, configureCandidateRegistry, packCandidate/);
 assert.ok(source.indexOf("'install pre-existing published service'")<source.indexOf("'manual first-feature update'"));
 const boundary=source.slice(source.indexOf("'manual first-feature update'"),source.indexOf('report.defaultOn='));
 assert.doesNotMatch(boundary,/auto','on|daemon','install/);
 assert.match(source,/noAutoOnCommand:true/);
 assert.match(source,/reboot:'UNRUN/);
});
test('off switch precedes aged tick and controlled worker/owner intervention uses pinned identities only',()=>{
 assert.ok(source.indexOf("'switch automatic updates off'")<source.indexOf('await delay(70000)'));
 assert.match(source,/worker exact entry not uniquely identified/);
 assert.match(source,/StartTime.ToUniversalTime\(\).ToFileTimeUtc\(\)/);
 assert.match(source,/registry block armed by actual worker/);
 assert.match(source,/worker-kill-owner-alive/);assert.match(source,/owner-kill-sameboot-manual-clear/);
 assert.match(source,/assert.equal\(failed.failures,1\)/);
 assert.doesNotMatch(source,/COTAL_SKIP_CONNECTOR_SEED|Object.defineProperty\(process,'platform'/);
});
test('driver parses without any native execution',()=>{
 const result=spawnSync(process.execPath,['--check',fileURLToPath(file)],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
