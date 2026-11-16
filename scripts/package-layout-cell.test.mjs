import assert from 'node:assert/strict';
import test from 'node:test';
import {packageLayoutCell,pnpmGlobalPackage} from './package-layout-cell.mjs';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('pnpm 11 resolves its active isolated group, never globalRoot/package approximation',()=>{
 const root=mkdtempSync(join(tmpdir(),'pnpm-groups-')),group=join(root,'hash-target'),pkg=join(group,'node_modules/cotal-ai');
 mkdirSync(pkg,{recursive:true});writeFileSync(join(pkg,'package.json'),JSON.stringify({name:'cotal-ai',version:'0.164.18'}));
 assert.throws(()=>pnpmGlobalPackage(root),/one active/);
 symlinkSync('./hash-target',join(root,'hash'));
 assert.equal(pnpmGlobalPackage(root).path,realpathSync(pkg));
 symlinkSync('./hash-target',join(root,'ambiguous'));
 assert.throws(()=>pnpmGlobalPackage(root),/one active/);
});
test('actual package-manager layout cell refuses local execution before any install',async()=>{
 if(process.env.GITHUB_ACTIONS==='true'&&process.env.RUNNER_ENVIRONMENT==='github-hosted')return;
 await assert.rejects(()=>packageLayoutCell({layout:'pnpm'}),/Assertion/);
 await assert.rejects(()=>packageLayoutCell({layout:'nvm'}),/Assertion/);
});
