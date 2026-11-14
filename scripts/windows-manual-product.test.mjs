import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {parse}=createRequire(new URL('../package.json',import.meta.url))('yaml');
const source=readFileSync(new URL('./windows-auto-product-cell.mjs',import.meta.url),'utf8');
const workflow=parse(readFileSync(new URL('../.github/workflows/windows-manual-update.yml',import.meta.url),'utf8'));
test('manual proof uses same native builders and strict Ubuntu packing then build-free Windows installation',()=>{
 assert.deepEqual(workflow.on.push.branches,['measure/windows-manual-update']);
 assert.equal(workflow.jobs.native.uses,'./.github/workflows/workspace-native.yml');
 assert.equal(workflow.jobs.acceptance['runs-on'],'windows-2022');
 assert.equal(workflow.jobs.pack['runs-on'],'ubuntu-latest');
 const commands=workflow.jobs.acceptance.steps.map(s=>s.run??'').join('\n');
 assert.doesNotMatch(commands,/pnpm|build|packCandidate/);
 assert.equal(workflow.jobs.acceptance.steps.at(-1).if,'always()');
 assert.ok(!workflow.jobs.acceptance.steps.some(s=>s.uses?.startsWith('actions/checkout')));
});
test('published service precedes one manualhop, no feature scheduler acceptance or guard bypass',()=>{
 assert.ok(source.indexOf("'install pre-existing published service'")<source.indexOf("'manual first-feature update'"));
 assert.match(source,/published-service-manual-update/);assert.match(source,/manual update must clear recovery state/);
 assert.doesNotMatch(source,/off-before-tick|worker-kill-owner-alive|switch automatic updates on|owner-kill-sameboot/);
 assert.match(source,/pin.*native generation observer ready/);
 assert.match(source,/GetTask\(\$env:CELL_DAEMON_TASK\)/);assert.match(source,/\$handle=\$p.Handle/);
});
test('all env scopes are case-unique, Windows PATH canonical and npm exact node-adjacent entry',()=>{
 const visit=x=>{if(!x||typeof x!=='object')return;if(x.env){const keys=Object.keys(x.env).map(k=>k.toUpperCase());assert.equal(new Set(keys).size,keys.length);}for(const v of Object.values(x))visit(v);};visit(workflow);
 assert.match(source,/key.toLowerCase\(\)==='path'/);assert.match(source,/node_modules\/npm\/bin\/npm-cli.js/);
});
test('extension census comes from installed runtime declarations and is archived before assertions',()=>{
 assert.match(source,/installedWorkspace\.SEEDED_EXTENSIONS/);
 assert.match(source,/assert.deepEqual\(firstParty.map/);
 assert.doesNotMatch(source,/\.length,8\)/);
 assert.ok(source.indexOf('report.extensions=extensions')<source.indexOf('assert.deepEqual(firstParty'));
});
test('standalone manual proof source parses',()=>{
 const r=spawnSync(process.execPath,['--check',fileURLToPath(new URL('./windows-auto-product-cell.mjs',import.meta.url))],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});
