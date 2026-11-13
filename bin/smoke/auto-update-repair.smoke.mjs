import strictAssert from 'node:assert/strict';
import { countedAssert, emitSentinel } from './sentinel.mjs';
const { assert, cells } = countedAssert(strictAssert);
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const previous = JSON.parse(readFileSync(join(repo,'bin/package.json'),'utf8')).version;
const reproducing = process.argv.includes('--repro-notarget');
for (const scenario of reproducing ? ['notarget-manual', 'notarget-auto'] : ['retry','rollback','paused','preflight']) {
 const root=mkdtempSync(join(tmpdir(),'autoupd-repair-'));
 const home=join(root,'home'), prefix=join(root,'prefix');
 for(const dir of [home,prefix,join(root,'config/cotal'),join(root,'.cotal'),join(root,'payload/package/dist')]) mkdirSync(dir,{recursive:true,mode:0o700});
 const archives={};
 for(const version of ['99.0.0',previous]) {
  writeFileSync(join(root,'payload/package/package.json'),JSON.stringify({name:'cotal-ai',version,bin:{cotal:'dist/cotal.js'}}));
  const code=version===previous ? (scenario==='paused'?'process.exit(43)':'console.log("previous reconciled")') : scenario==='retry' ? `const fs=require('node:fs');const p=${JSON.stringify(join(root,'once'))};if(!fs.existsSync(p)){fs.writeFileSync(p,'1');process.exit(42)}console.log('retry reconciled')` : 'process.exit(42)';
  writeFileSync(join(root,'payload/package/dist/cotal.js'),'#!/usr/bin/env node\n'+code+'\n',{mode:0o755});
  assert.equal(spawnSync('tar',['-czf',join(root,version+'.tgz'),'-C',join(root,'payload'),'package']).status,0);
  archives[version]=readFileSync(join(root,version+'.tgz'));
 }
 let origin, missing = false;
 const server=createServer((req,res)=>{
  if(req.url?.endsWith('.tgz')) { const version=req.url.slice(1,-4);if(scenario==='preflight'&&version==='99.0.0')return res.writeHead(503).end();if(scenario.startsWith('notarget')&&version===previous)missing=true;return res.end(archives[version]); }
  const versions=Object.fromEntries(Object.entries(archives).map(([version,bytes])=>[version,{name:'cotal-ai',version,bin:{cotal:'dist/cotal.js'},dist:{tarball:`${origin}/${version}.tgz`,integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')}}]));
  if (missing) delete versions['99.0.0'];
  res.end(JSON.stringify({name:'cotal-ai','dist-tags':{latest:'99.0.0'},versions}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 try {
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),HOME:home,XDG_CONFIG_HOME:join(root,'config'),COTAL_HOME:home,npm_config_prefix:prefix,npm_config_cache:join(root,'cache'),npm_config_registry:origin,npm_config_update_notifier:'false',npm_config_audit:'false',npm_config_fund:'false',COTAL_SKIP_CONNECTOR_SEED:'1'};
  if (scenario === 'notarget-auto') {
   Object.assign(process.env, env);
   process.chdir(root);
   writeFileSync(join(home,'update-attempt.json'),JSON.stringify({version:'99.0.0',failures:0,result:'due',next:0}));
   writeFileSync(join(home,'update-check.json'),JSON.stringify({v:1,latest:'99.0.0',attemptedAt:Date.now(),checkedAt:Date.now(),firstSeenAt:Date.now()-3601000}));
   const { automaticUpdates } = await import('../dist/daemon/auto-update.js');
   const updater=automaticUpdates({version:previous,eligible:()=>true,prepare:async()=>{},abort:async()=>{},report:line=>console.log('SCHEDULER REPORT:',line)});
   try {
    const deadline=Date.now()+90000;
    while(Date.now()<deadline) {
     await new Promise(resolve=>setTimeout(resolve,250));
     const state=JSON.parse(readFileSync(join(home,'update-attempt.json'),'utf8'));
     if(!updater.updating() && state.result.startsWith('update failed;')) {
      console.log('SCHEDULER STATE:',JSON.stringify(state));
      console.log('SCHEDULER LOG:\n'+readFileSync(join(home,'update-attempt.log'),'utf8'));
      assert.equal(state.failures,1);
      assert.match(state.result,/update failed; restored and reconciled/);
      break;
     }
    }
    assert.match(updater.status().lastResult,/update failed; restored and reconciled/);
   } finally { await updater.close(); }
   continue;
  }
  const child=spawn(process.execPath,[join(repo,'bin/dist/cotal.js'),'update','--self'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r)});
  if(scenario==='notarget-manual') {
   console.log('MANUAL EXIT:',code,'\n'+output);
   assert.equal(code,1,output);
   assert.match(output,/npm error code ETARGET/);
   assert.match(output,/No matching version found for cotal-ai@99\.0\.0/);
   assert.match(output,/Update failed;.*was restored and reconciled/);
   const probe=spawn('npm',['install','-g','cotal-ai@99.0.0','--json','--prefer-online'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
   let json='',errors='';probe.stdout.on('data',b=>json+=b);probe.stderr.on('data',b=>errors+=b);
   const probeCode=await new Promise((resolve,reject)=>{probe.once('error',reject);probe.once('close',resolve)});
   console.log('STRUCTURED NPM EXIT:',probeCode,'STDOUT:',json,'STDERR:',errors);
   assert.equal(JSON.parse(json).error.code,'ETARGET');
   continue;
  }
  assert.equal(code,scenario==='retry'?0:scenario==='preflight'?1:42,output);
  if(scenario==='preflight') assert.equal(existsSync(join(prefix,'lib/node_modules/cotal-ai')),false,output);
  else {
   const installed=JSON.parse(readFileSync(join(prefix,'lib/node_modules/cotal-ai/package.json'),'utf8')).version;
   assert.equal(installed,scenario==='retry'?'99.0.0':previous,output);
   const recovery=JSON.parse(readFileSync(join(home,'update-recovery.json'),'utf8'));
   if(scenario==='paused'){assert.equal(recovery.phase,'paused');assert.match(output,/Automatic updates are paused/)}else assert.equal(recovery,null);
  }
 } finally { await new Promise(r=>server.close(r)); }
}
emitSentinel({ passed: cells(), failed: 0 });
