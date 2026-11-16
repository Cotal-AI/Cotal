import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, statfsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { candidateRegistry } from './automatic-update-platform-baseline.mjs';
assert.equal(process.platform,'linux');
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
process.umask(0o077);
const candidate=realpathSync(process.env.COTAL_UP_CANDIDATE);
const output=process.env.COTAL_UP_OUTPUT;
assert(output);mkdirSync(output,{recursive:true,mode:0o700});
const hash=b=>createHash('sha256').update(b).digest('hex');
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const manifest=json(join(candidate,'manifest.json')), main=manifest.packages.find(p=>p.name==='cotal-ai');
assert(main&&main.version!=='0.164.18');
for(const p of manifest.packages){assert.equal(p.version,main.version);assert.equal(hash(readFileSync(join(candidate,p.archive))),p.sha256);}
const root=mkdtempSync(join(process.env.RUNNER_TEMP,'plain-npm-up-'));
const report={source:manifest.source,manifestSha256:hash(readFileSync(join(candidate,'manifest.json'))),root,cells:[],result:'running'};
const save=()=>writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
let registry;
async function port(){const s=createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r)});const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function cell(skip){
 const d=join(root,skip?'skip':'normal');mkdirSync(d,{mode:0o700});
 const paths=Object.fromEntries(['home','prefix','project','cotal','config','cache','runtime','tmp'].map(k=>[k,join(d,k)]));for(const p of Object.values(paths))mkdirSync(p,{mode:0o700});mkdirSync(join(paths.project,'.cotal'),{mode:0o700});
 const env={PATH:`${paths.prefix}/bin:${process.env.PATH}`,HOME:paths.home,USERPROFILE:paths.home,LANG:'C.UTF-8',NO_COLOR:'1',DO_NOT_TRACK:'1',COTAL_TELEMETRY:'off',COTAL_HOME:paths.cotal,XDG_CONFIG_HOME:paths.config,XDG_RUNTIME_DIR:paths.runtime,TMPDIR:paths.tmp,npm_config_prefix:paths.prefix,npm_config_cache:paths.cache,npm_config_userconfig:join(paths.home,'.npmrc'),npm_config_globalconfig:join(paths.home,'global.npmrc'),npm_config_registry:'https://registry.npmjs.org',...(skip?{COTAL_SKIP_CONNECTOR_SEED:'1'}:{})};
 writeFileSync(env.npm_config_userconfig,'');writeFileSync(env.npm_config_globalconfig,'');
 const row={skip,paths,calls:[],result:'running'};report.cells.push(row);save();
 async function run(label,file,args,timeoutMs=300000){
  if(file==='npm'||args.includes('seed')){const s=statfsSync(output);assert(s.bavail*s.bsize>=20*1024**3,'Hosted disk floor');}
  const call={label,file,args,startedAt:new Date().toISOString()};row.calls.push(call);save();const started=Date.now();
  await new Promise(resolve=>{const child=spawn(file,args,{cwd:paths.project,env,stdio:['ignore','pipe','pipe']});call.stdout='';call.stderr='';let killer;
   const timer=setTimeout(()=>{call.timeout=true;child.kill('SIGTERM');killer=setTimeout(()=>child.kill('SIGKILL'),5000)},timeoutMs);
   child.stdout.on('data',b=>{call.stdout+=b});child.stderr.on('data',b=>{call.stderr+=b});child.once('error',e=>{call.error=e.message});child.once('close',(exit,signal)=>{clearTimeout(timer);clearTimeout(killer);Object.assign(call,{exit,signal,elapsedMs:Date.now()-started});save();resolve()});});return call;
 }
 const ok=c=>{assert(c.exit===0&&!c.signal&&!c.timeout,`${c.label} failed: ${c.stderr||c.stdout}`);return c};
 const cli=(label,args)=>run(label,join(paths.prefix,'bin/cotal'),args);
 const pkg=join(paths.prefix,'lib/node_modules/cotal-ai/package.json');let attempted=false;
 try{
  row.officialMetadata=JSON.parse(ok(await run('official archive identity','npm',['view','cotal-ai@0.164.18','dist','--json'])).stdout);
  ok(await run('official plain global install','npm',['i','-g','cotal-ai@0.164.18','--no-audit','--no-fund']));assert.equal(json(pkg).version,'0.164.18');
  row.originalBin=realpathSync(join(paths.prefix,'bin/cotal'));
  ok(await cli('official connector prerequisites',['ext','seed']));
  env.npm_config_registry=registry.url;writeFileSync(env.npm_config_userconfig,`registry=${registry.url}\n`);
  const space=skip?'plain-skip':'plain-normal',server=`nats://127.0.0.1:${await port()}`;row.target={space,server};
  ok(await run('plain npm candidate replacement','npm',['i','-g',`cotal-ai@${main.version}`,'--no-audit','--no-fund']));assert.equal(json(pkg).version,main.version);assert.equal(realpathSync(join(paths.prefix,'bin/cotal')),row.originalBin);
  const args=['up','--space',space,'--server',server,'--open','--detach'];attempted=true;
  const first=await cli('FIRST candidate command: up',args);
  if(first.exit!==0){assert(skip,'Normal first up must succeed');assert(!first.timeout&&!first.signal,'Unknown outcome is not refusal');const text=first.stdout+'\n'+first.stderr;assert(text.includes('cotal ext seed --repair'),'Refusal lacks literal repair');row.literalRepair='cotal ext seed --repair';ok(await cli('literal printed repair SAME environment',['ext','seed','--repair']));assert.equal(env.COTAL_SKIP_CONNECTOR_SEED,'1');ok(await cli('up after literal repair SAME environment',args));}else ok(first);
  let answer;for(let n=0;n<20;n++){const r=await cli('public Manager ps',['ps','--space',space,'--json']);if(r.exit===0&&!r.timeout&&!r.signal){const body=JSON.parse(r.stdout).result;if(body?.kind==='seats'&&body.managers?.length===1&&body.managers[0].state==='answered'&&body.managers[0].instanceId){answer=body.managers[0];break}}await delay(500)}
  assert(answer,'Actual Manager must answer through public ps');row.manager=answer;row.result='passed';
 }catch(e){row.result='failed';row.error=e.stack;throw e;}
 finally{
  if(attempted){const down=await cli('public owned stack down',['down','--with-agents','--yes']);row.cleanup={exit:down.exit,signal:down.signal,timeout:down.timeout??false};if(down.exit!==0||down.signal||down.timeout){const broker=await cli('public partial-stack down without agents',['down','--yes']);row.partialCleanup={exit:broker.exit,signal:broker.signal,timeout:broker.timeout??false};if(broker.exit!==0||broker.signal||broker.timeout){report.cleanupFailure=d;row.result='failed-cleanup';}}}
  save();
 }
}
try{
 registry=await candidateRegistry(candidate,'B','https://registry.npmjs.org');report.registry=registry.identity;
 for(const skip of [false,true]){try{await cell(skip)}catch(e){report.failures??=[];report.failures.push(e.stack)}if(report.cleanupFailure)break}
 assert(!report.failures?.length&&!report.cleanupFailure,'Installed first-up proof failed; inspect original report');report.result='passed';
}catch(e){report.result='failed';report.error=e.stack;process.exitCode=1;}
finally{if(registry)report.registryRequests=await registry.close();report.finishedAt=new Date().toISOString();save();writeFileSync(join(output,'SHA256SUMS'),hash(readFileSync(join(output,'report.json')))+'  report.json\n');console.log(JSON.stringify({result:report.result,output}));}
