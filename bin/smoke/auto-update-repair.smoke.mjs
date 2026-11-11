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
for (const scenario of ['retry','rollback','paused','preflight']) {
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
 let origin;
 const server=createServer((req,res)=>{
  if(req.url?.endsWith('.tgz')) { const version=req.url.slice(1,-4);if(scenario==='preflight'&&version==='99.0.0')return res.writeHead(503).end();return res.end(archives[version]); }
  const versions=Object.fromEntries(Object.entries(archives).map(([version,bytes])=>[version,{name:'cotal-ai',version,bin:{cotal:'dist/cotal.js'},dist:{tarball:`${origin}/${version}.tgz`,integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')}}]));
  res.end(JSON.stringify({name:'cotal-ai','dist-tags':{latest:'99.0.0'},versions}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+server.address().port;
 try {
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))),HOME:home,XDG_CONFIG_HOME:join(root,'config'),COTAL_HOME:home,npm_config_prefix:prefix,npm_config_cache:join(root,'cache'),npm_config_registry:origin,npm_config_update_notifier:'false',npm_config_audit:'false',npm_config_fund:'false',COTAL_SKIP_CONNECTOR_SEED:'1'};
  const child=spawn(process.execPath,[join(repo,'bin/dist/cotal.js'),'update','--self'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r)});
  assert.equal(code,scenario==='retry'?0:1,output);
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
