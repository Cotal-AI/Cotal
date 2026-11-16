import assert from 'node:assert/strict';
import test from 'node:test';
import { rootOwnedCell, rootOwnedAssertions } from './root-owned-cell.mjs';
import {npmDebugTail} from './npm-debug-tail.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('root proof checks its complete pinned npm before installation and retains silly diagnostics',()=>{
 const source=readFileSync(new URL('./root-owned-cell.mjs',import.meta.url),'utf8');
 assert(source.includes("assert.equal(npmVersion.stdout.trim(),'11.16.0'"));
 assert(source.includes("[npm,'ls','-g','--depth=0']"));
 assert(source.indexOf('verify root global npm tree before installation')<source.indexOf('await install(old)'));
 assert(source.includes("'--loglevel=silly'"));
});
test('npm diagnostic tail bounds output and filters token and registry authentication lines',async()=>{
 const root=mkdtempSync(join(tmpdir(),'npm-log-')),logs=join(root,'cache/_logs');mkdirSync(logs,{recursive:true,mode:0o700});
 writeFileSync(join(logs,'2026-11-16T01_00_00_000Z-debug-0.log'),Array.from({length:300},(_,i)=>`line ${i}`).join('\n')+'\nnpm config //registry.npmjs.org/:_authToken=CANARY\nAuthorization: Bearer CANARY\nregistry password CANARY\nlast safe\n');
 const result=await npmDebugTail(root);assert.equal(result.lines,200);assert(!result.text.includes('CANARY'));assert(result.text.endsWith('last safe\n'));assert(!result.text.includes('line 0\n'));
 const external=join(root,'outside');writeFileSync(external,'FOREIGN');symlinkSync(external,join(logs,'2026-11-17T01_00_00_000Z-debug-0.log'));
 await assert.rejects(()=>npmDebugTail(root));
});
test('root machine proof refuses nonhosted execution before native side effects',async()=>{
 if(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted')return;
 await assert.rejects(()=>rootOwnedCell({}),/Assertion/);
});
test('reported root mode flag cannot replace actual metadata entries',()=>{
 const cell={sourceVersion:'1.2.3',targetVersion:'1.2.1003',requiredAssertions:['readable-generation-metadata']};
 const report={passed:true,calls:[],observations:[{modes:{passed:true,entries:[{path:'/usr/local/lib/.cotal-generations',mode:0o755,uid:0}]}}]};
 assert.equal(rootOwnedAssertions(report,cell).passed,false);
 const entries=report.observations[0].modes.entries;
 entries.push({path:'/usr/local/lib/node_modules/cotal-ai/dist/cotal.js',mode:0o755,uid:0},{path:'/usr/local/lib/.cotal-generations/generation/inventory.json',mode:0o644,uid:0},{path:`/usr/local/lib/.cotal-generations/.active-${'a'.repeat(64)}.json`,mode:0o644,uid:0});
 assert.equal(rootOwnedAssertions(report,cell).passed,true);
 entries.at(-1).mode=0o600;assert.equal(rootOwnedAssertions(report,cell).passed,false);
});
test('fixed normal-account refusal must leave no staging folders or store growth',()=>{
 const cell={requiredAssertions:['refusal-store-unchanged']};
 const report={passed:true,observations:[{store:{passed:true,logicalBytes:100}},{afterNormalRefusal:{passed:true,logicalBytes:100}}]};
 assert.equal(rootOwnedAssertions(report,cell).passed,true);
 report.observations[1].afterNormalRefusal.logicalBytes=101;
 assert.equal(rootOwnedAssertions(report,cell).passed,false);
 report.observations[1].afterNormalRefusal={passed:false,logicalBytes:100};
 assert.equal(rootOwnedAssertions(report,cell).passed,false);
});
