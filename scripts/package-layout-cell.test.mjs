import assert from 'node:assert/strict';
import test from 'node:test';
import {packageLayoutCell,pnpmGlobalPackage} from './package-layout-cell.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
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
