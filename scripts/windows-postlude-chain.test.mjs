import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {parse}=createRequire(new URL('../package.json',import.meta.url))('yaml');
const source=readFileSync(new URL('./windows-auto-product-cell.mjs',import.meta.url),'utf8');
const workflow=parse(readFileSync(new URL('../.github/workflows/windows-postlude-chain.yml',import.meta.url),'utf8'));
test('same guarded packed closures feed Windows chain and Linux/macOS own-next legs without source builds',()=>{
 assert.deepEqual(workflow.on.push.branches,['measure/windows-postlude-chain']);assert.equal(workflow.jobs.acceptance['runs-on'],'${{ matrix.runner }}');assert.equal(workflow.jobs.pack['runs-on'],'ubuntu-latest');
 assert.equal(workflow.jobs.native.uses,'./.github/workflows/workspace-native.yml');assert.deepEqual(workflow.jobs.acceptance.strategy.matrix.runner,['windows-2022','ubuntu-24.04','macos-15']);
 assert.doesNotMatch(workflow.jobs.acceptance.steps.map(s=>s.run??'').join('\n'),/pnpm|packCandidate|build/);assert.equal(workflow.jobs.acceptance.steps.at(-1).if,'always()');
});
test('public16410 expectedexit3 endstate recorded before fixed own updater A-to-B, service unchanged between hops',()=>{
 assert.match(source,/setupVersion=process.platform==='win32'\?'0.164.10':versionA/);assert.match(source,/assert.equal\(first.exit,3/);assert.match(source,/replacement version or protocol did not match/);
 const start=source.indexOf("'published 0.164.10 to fixed A expected refusal'"),end=source.indexOf("'fixed A to synthetic B manual update'",start);assert(start<end);
 const between=source.slice(start,end);for(const fact of ['daemon status','update check','recovery','generationFence','first-hop task'])assert(between.includes(fact));
 assert.doesNotMatch(between,/daemon','start|daemon','install|daemon','uninstall|clear.*fence/i);
 assert.match(source,/ready.update.restartEvidence.prepared,false/);assert.match(source,/task.enabled,true/);assert.match(source,/task.state,4/);
});
test('paired verified source+target metadata and synthetic B versions remain available',()=>{
 assert.match(source,/parts\[2\]\+=1000/);assert.match(source,/body.versions=\{\.\.\.additional.versions,\.\.\.body.versions\}/);
 assert.match(source,/candidatePairResponse\(overlayA,overlayB,active,req.url\)/);
});
test('environment names are unique ignoring case in every workflow scope',()=>{const visit=x=>{if(!x||typeof x!=='object')return;if(x.env){const k=Object.keys(x.env).map(k=>k.toUpperCase());assert.equal(k.length,new Set(k).size);}for(const v of Object.values(x))visit(v);};visit(workflow);});
test('POSIX legs install fixed A directly and require a real service/manual B with recovery clear',()=>{
 const leg=source.slice(source.indexOf("if(process.platform!=='win32'){"),source.indexOf('  const taskName='));
 assert.match(source,/setupVersion=process.platform==='win32'\?'0.164.10':versionA/);
 assert.match(leg,/fixed A to synthetic B manual update/);assert.match(leg,/s.version===versionB/);assert.match(leg,/json\(recovery\)===null/);assert.match(leg,/clearInterval\(generationTimer\)/);
 assert.doesNotMatch(leg,/expected refusal|restartInstalled|daemon','start/);
});
test('chain driver parses',()=>{const r=spawnSync(process.execPath,['--check',fileURLToPath(new URL('./windows-auto-product-cell.mjs',import.meta.url))],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);});
