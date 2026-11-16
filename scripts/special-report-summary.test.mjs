import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {summarize} from './automatic-update-platform-baseline.mjs';

test('special-only root and package reports render, remain strict and summarize idempotently',()=>{
 const root=mkdtempSync(join(tmpdir(),'special-summary-')),source='a'.repeat(40);
 const cells=[
  {id:'linux-npm-root-owned-candidate-next',rootOwned:true,sourceSHA:source,sourceVersion:'0.164.18',targetVersion:'0.164.1018',requiredAssertions:['root-update-success']},
  {id:'linux-pnpm-candidate-next-pnpm-layout',layoutProbe:'pnpm',sourceSHA:source,sourceVersion:'0.164.18',targetVersion:'0.164.1018',requiredAssertions:['layout-source-version']},
 ];
 const save=(cell,exit=0)=>{
  const dir=join(root,cell.id);mkdirSync(dir,{recursive:true,mode:0o700});
  writeFileSync(join(dir,'coordinate.json'),JSON.stringify(cell));
  const leaf=cell.rootOwned?'root-owned':'package-layout';
  const calls=[{label:cell.rootOwned?'root candidate public updater to next':'installed source public version',root:true,exit,signal:null,timeout:false,stdout:'cotal-ai 0.164.18\n',stderr:''}];
  const bytes=JSON.stringify({source,passed:exit===0,calls,assertions:[]});
  writeFileSync(join(dir,leaf+'.json'),bytes);
  writeFileSync(join(dir,leaf+'.sha256'),`${createHash('sha256').update(bytes).digest('hex')}  ${leaf}.json\n`);
  return join(dir,leaf+'.json');
 };
 try{
  const report=save(cells[0]);save(cells[1]);
  assert.deepEqual(summarize(root).counts,{passed:2});
  assert.deepEqual(summarize(root).counts,{passed:2},'saved summary must not become another report');
  save(cells[0],1);
  const failed=summarize(root);assert.equal(failed.unexpectedFailures,1);assert.equal(failed.counts.failed,1);
  writeFileSync(report,'{}');assert.throws(()=>summarize(root),/source differs|digest differs/);
 }finally{rmSync(root,{recursive:true});}
});
