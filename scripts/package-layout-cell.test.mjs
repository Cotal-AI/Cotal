import assert from 'node:assert/strict';
import test from 'node:test';
import {packageLayoutCell,pnpmGlobalPackage} from './package-layout-cell.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,linkSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectInstalledUpdateRoute} from './daemon-cell-diagnostics.mjs';
test('pnpm after-path and shim receipts are saved before route observation',()=>{
 const source=readFileSync(new URL('./package-layout-cell.mjs',import.meta.url),'utf8');
 const receipt=source.indexOf('report.installationAfter=');
 const observer=source.indexOf('report.route=inspectInstalledUpdateRoute');
 assert(receipt>0&&receipt<observer);
 assert(source.slice(receipt,observer).includes("writeFileSync(join(output,'package-layout.json')"));
 assert(source.includes('report.pnpmGroupAfter=pnpmGlobalPackage(JSON.parse(report.packageManagerAfter))'));
});
test('pnpm isolated group package hardlinks retain a private observation receipt',()=>{
 const root=mkdtempSync(join(tmpdir(),'pnpm-route-')),group=join(root,'hash-target'),pkg=join(group,'node_modules/cotal-ai');
 mkdirSync(pkg,{recursive:true,mode:0o700});
 const manifest=join(pkg,'package.json');
 writeFileSync(manifest,JSON.stringify({name:'cotal-ai',version:'0.164.18'}),{mode:0o600});
 linkSync(manifest,join(root,'store-manifest'));
 const selected=pnpmGlobalPackage([{path:group,dependencies:{'cotal-ai':{version:'0.164.18',path:pkg}}}]);
 const route=inspectInstalledUpdateRoute(selected.path,'linux',{privateFixtureRoot:root});
 assert.equal(route.selectedCliVersion,'0.164.18');
 assert.equal(route.packageReads[0].nlink,2);
 assert.equal(route.packageReads[0].privateFixtureRoot,root);
});
test('pnpm 11 resolves its active isolated group, never globalRoot/package approximation',()=>{
 const root=mkdtempSync(join(tmpdir(),'pnpm-groups-')),group=join(root,'hash-target'),pkg=join(group,'node_modules/cotal-ai');
 mkdirSync(pkg,{recursive:true});writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'cotal-ai',version:'0.164.18'}));
 assert.throws(()=>pnpmGlobalPackage([]),/one active/);
 const listing=[{path:group,dependencies:{'cotal-ai':{version:'0.164.18',path:pkg}}}];
 assert.equal(pnpmGlobalPackage(listing).path,realpathSync(pkg));
 assert.throws(()=>pnpmGlobalPackage([...listing,...listing]),/one active/);
 assert.throws(()=>pnpmGlobalPackage([{dependencies:{'cotal-ai':{version:'0.164.18'}}}]),/identify installed/);
});
test('actual package-manager layout cell refuses local execution before any install',async()=>{
 if(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted')return;
 await assert.rejects(()=>packageLayoutCell({layout:'pnpm'}),/Assertion/);
 await assert.rejects(()=>packageLayoutCell({layout:'nvm'}),/Assertion/);
});
