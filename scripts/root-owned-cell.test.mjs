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
 assert(source.includes("umask 0022; exec"));
 assert(source.includes("'--umask=022'"));
 assert(source.includes("ROOT_NPM_PROCESS"));
 assert(source.includes("receipt.umask!==0o22"));
 assert(source.includes("observation.manifest.mode,0o644"));
 assert(source.includes("observation.bootstrap.mode,0o755"));
 assert(source.includes("ancestors.push({path:at,uid:s.uid"));
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
test('administrator acceptance requires npm process mask, complete protected ancestry and file modes',()=>{
 const prefix='/usr/lib/cotal-root-node';
 const cell={sourceVersion:'0.164.18',requiredAssertions:['root-owned-install']};
 const installed={uid:0,version:cell.sourceVersion,manifest:{mode:0o644},bootstrap:{mode:0o755},ancestors:[prefix+'/lib/node_modules/cotal-ai',prefix+'/lib/node_modules',prefix+'/lib',prefix,'/usr/lib','/usr','/'].map(path=>({path,real:path,uid:0,gid:0,mode:0o755,directory:true,symlink:false}))};
 const original={passed:true,observations:[{npmProcess:{uid:0,umask:0o22},version:cell.sourceVersion},{ownership:{uid:0,path:prefix+'/bin/node'}},{installed}]};
 assert.equal(rootOwnedAssertions(original,cell).passed,true);
 for(const change of [
  report=>{report.observations[0].npmProcess.umask=0;},
  report=>{report.observations.shift();},
  report=>{report.observations[2].installed.ancestors[0].mode=0o777;},
  report=>{report.observations[2].installed.ancestors[4].gid=1001;},
  report=>{report.observations[2].installed.manifest.mode=0o666;},
  report=>{report.observations[2].installed.bootstrap.mode=0o777;},
 ]){
  const report=structuredClone(original);change(report);
  assert.equal(rootOwnedAssertions(report,cell).passed,false);
 }
});
