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
 assert.equal(workflow.jobs.acceptance['runs-on'],'windows-2022');assert.equal(workflow.jobs.acceptance.needs,'pack');
 assert.equal(workflow.jobs.pack['runs-on'],'ubuntu-latest');assert.equal(workflow.jobs.pack.needs,'native');
 const windowsCommands=workflow.jobs.acceptance.steps.map(x=>x.run??'').join('\n');
 assert.doesNotMatch(windowsCommands,/pnpm|packCandidate|assemble|source comparison|build/);
 assert.ok(!workflow.jobs.acceptance.steps.some(x=>x.uses?.startsWith('actions/checkout@')));
 assert.equal(workflow.jobs.acceptance.steps.at(-1).if,'always()');
 for(const step of workflow.jobs.pack.steps.filter(s=>s.uses?.startsWith('actions/download-artifact@')))assert.ok(step.with.path.startsWith('${{ runner.temp }}'),'artifact inputs stay outside clean pack source');
 const commands=workflow.jobs.pack.steps.map(x=>x.run??'').join('\n');
 assert.match(commands,/--pack/);assert.match(commands,/workspace-assemble-natives/);assert.doesNotMatch(commands,/mutation|fix-reversion/);
 assert.match(source,/installed packed native boot\/accounting\/drain smoke/);
});
test('workflow environment keys are unique ignoring case at every scope',()=>{
 const visit=value=>{if(!value||typeof value!=='object')return;if(value.env){const keys=Object.keys(value.env);assert.equal(new Set(keys.map(k=>k.toUpperCase())).size,keys.length,'GitHub env keys ignore case');}for(const child of Object.values(value))visit(child);};
 visit(workflow);
 assert.equal(workflow.jobs.pack.env.pnpm_config_workspace_concurrency,'3');
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
test('published seat provenance uses pinned verified release tag, not optional npm gitHead',()=>{
 const input=readFileSync(new URL('./windows-auto-native-inputs.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(input,/metadata\.gitHead/);
 assert.match(input,/b9f7c9b61b27965829f3a8840de1ed74f01cc2af/);
 assert.match(input,/public seat release tag moved/);
 assert.match(input,/unchanged seat native input/);
 assert.match(input,/assert.deepEqual\(published,committed/);
 assert.match(input,/HEAD:packages\/seat/);
 assert.match(input,/explicit CRLF normalization/);
 assert.match(input,/metadata\.dist\.integrity/);
});
test('Windows npm invocation uses the existing matrix node-adjacent CLI recipe, never cmd PATH guessing',()=>{
 assert.match(source,/node_modules\/npm\/bin\/npm-cli\.js/);
 assert.match(source,/const npm=process.execPath/);
 assert.match(source,/key.toLowerCase\(\)==='path'/);
 assert.doesNotMatch(source,/cmd\.exe/);
});
test('driver parses without any native execution',()=>{
 const result=spawnSync(process.execPath,['--check',fileURLToPath(file)],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
