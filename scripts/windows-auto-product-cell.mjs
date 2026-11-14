// Temporary native acceptance composition. Reuses the matrix packer and verified registry overlay.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, delimiter, dirname } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { candidateRegistry, configureCandidateRegistry, packCandidate } from './automatic-update-platform-baseline.mjs';
const output=resolve(process.env.WINDOWS_AUTO_EVIDENCE??(process.argv[2]?.startsWith('--')?process.argv[3]:process.argv[2])??join(process.env.RUNNER_TEMP??'.','windows-auto-evidence'));
mkdirSync(output,{recursive:true});
const save=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n');
const json=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
export async function run(){
 if(process.argv[2]==='--verify-packed'){
  const A=await candidateRegistry(join(output,'candidate-A'),'B','https://registry.npmjs.org');
  const B=await candidateRegistry(join(output,'candidate-B'),'B','https://registry.npmjs.org');
  try{assert.equal((await(await fetch(A.url+'/cotal-ai/latest')).json()).version,json(join(output,'versions.json')).A);assert.equal((await(await fetch(B.url+'/cotal-ai/latest')).json()).version,json(join(output,'versions.json')).B);console.log('downloaded packed closures/registry bundle verified');}finally{await A.close();await B.close();}
  return;
 }
 if(process.argv[2]==='--pack'){
  assert.equal(process.platform,'linux');
  const repo=resolve(import.meta.dirname,'..');
  const response=await fetch('https://registry.npmjs.org/cotal-ai/latest');assert(response.ok);const latest=(await response.json()).version;
  const parts=latest.split('.').map(Number);parts[2]++;const A=parts.join('.');parts[2]++;const B=parts.join('.');
  await packCandidate(join(output,'candidate-A'),A,repo);await packCandidate(join(output,'candidate-B'),B,repo);
  save('versions.json',{published:latest,A,B,source:json(join(output,'candidate-A/manifest.json')).source});
  return;
 }
 assert.equal(process.platform,'win32');assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
 const repo=resolve(import.meta.dirname,'..'),home=homedir(),project=join(output,'project'),prefix=join(output,'prefix');
 mkdirSync(join(project,'.cotal'),{recursive:true});
 const env={...process.env,DO_NOT_TRACK:'1',COTAL_TELEMETRY:'off',npm_config_prefix:prefix,npm_config_cache:join(output,'npm-cache'),PNPM_CONFIG_WORKSPACE_CONCURRENCY:'3'};
 for(const key of Object.keys(env))if(key.startsWith('COTAL_')&&!['COTAL_TELEMETRY'].includes(key))delete env[key];
 const inheritedPath=Object.entries(env).find(([key])=>key.toLowerCase()==='path')?.[1];assert(inheritedPath,'Windows PATH is unreadable');
 for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
 env.PATH=[prefix,dirname(process.execPath),inheritedPath].join(delimiter);
 const npmCli=join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');assert(existsSync(npmCli),'npm CLI missing; no shell fallback');
 const npm=process.execPath,npmArgs=args=>[npmCli,...args];
 const pkg=join(prefix,'node_modules/cotal-ai'),entry=join(pkg,'dist/cotal.js'),cotalHome=join(env.LOCALAPPDATA,'Cotal'),config=join(env.APPDATA,'Cotal');
 const report={source:'published→manual feature bootstrap→automatic candidate transition',calls:[],cells:[],reboot:'UNRUN: hosted runner cannot restart',environment:{home,cotalHome,config,project,prefix,normalNativeHomes:true}};
 save('report.json',report);
 async function call(label,file,args,limit=180000){
  const startedAt=new Date().toISOString();const result=await new Promise(resolveCall=>{const p=spawn(file,args,{cwd:project,env,stdio:['ignore','pipe','pipe'],windowsHide:true});let stdout='',stderr='';const timer=setTimeout(()=>p.kill(),limit);p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('error',e=>{clearTimeout(timer);resolveCall({exit:null,error:e.message,stdout,stderr});});p.once('close',(exit,signal)=>{clearTimeout(timer);resolveCall({exit,signal,stdout,stderr});});});
  report.calls.push({label,file,args,startedAt,finishedAt:new Date().toISOString(),...result});save('report.json',report);return result;
 }
 const cli=(label,args)=>call(label,process.execPath,[entry,...args],args[0]==='update'&&!args.includes('--auto')?300000:180000);
 const ok=r=>{assert.equal(r.exit,0,JSON.stringify(r));return r;};
 const ps=(label,script,extra={})=>{Object.assign(env,extra);return call(label,join(env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);};
 const poll=async(label,fn,limit=180000,interval=1000)=>{const deadline=Date.now()+limit;while(Date.now()<deadline){const value=await fn();if(value)return value;await delay(interval);}throw new Error('Timed out '+label);};
 const status=async()=>{const r=await cli('native daemon status',['daemon','status','--json']);return r.exit===0?JSON.parse(r.stdout).result:undefined;};
 const generationSnapshots=[];
 const captureGeneration=label=>{
  const snapshot={label,at:new Date().toISOString(),files:{}};
  for(const [name,path]of [['daemon.log',join(cotalHome,'daemon/daemon.log')],['update-recovery.json',join(cotalHome,'update-recovery.json')],['update-attempt.json',join(cotalHome,'update-attempt.json')],['installed-package.json',join(pkg,'package.json')]]){
   try{const text=readFileSync(path,'utf8');if(name==='daemon.log')snapshot.files[name]=text.slice(-65536).replace(/eyJ[A-Za-z0-9_.-]*/g,'<redacted>');else{const value=JSON.parse(text);snapshot.files[name]=name==='update-recovery.json'?{phase:value.phase,previous:value.previous,target:value.target,installed:value.installed,preparedRestart:value.preparedRestart,reason:value.reason,owner:value.owner?{pid:value.owner.pid,start:value.owner.start}:undefined}:name==='installed-package.json'?{name:value.name,version:value.version}:value;}}catch(error){snapshot.files[name]={error:error.code??error.message};}
  }
  generationSnapshots.push(snapshot);save('generation-snapshots.json',generationSnapshots);
 };
 const age=()=>{for(const [name,fields]of [['update-check.json',['checkedAt','attemptedAt','firstSeenAt']],['update-attempt.json',['next']]]){const path=join(cotalHome,name),before=json(path),after={...before};for(const field of fields)after[field]=Date.now()-26*3600000;save('clock-'+name,{before,after});writeFileSync(path,JSON.stringify(after));}};
 let overlayA,overlayB,restore,proxy,hold=false,installed=false;const held=[];
 try{
  const packed=json(join(output,'versions.json'));const latest=packed.published;report.published=latest;
  const versionA=packed.A,versionB=packed.B;
  report.versions={A:versionA,B:versionB,source:packed.source};
  overlayA=await candidateRegistry(join(output,'candidate-A'),'B','https://registry.npmjs.org');overlayB=await candidateRegistry(join(output,'candidate-B'),'B','https://registry.npmjs.org');
  let active=overlayA;
  proxy=createServer(async(req,res)=>{try{if(hold&&decodeURIComponent(req.url).startsWith('/cotal-ai')&&existsSync(join(cotalHome,'update-windows.json'))&&json(join(cotalHome,'update-windows.json')).owner){held.push({req,res});return;}const r=await fetch(active.url+req.url,{signal:AbortSignal.timeout(60000)});res.writeHead(r.status,{'content-type':r.headers.get('content-type')??'application/json'});res.end(Buffer.from(await r.arrayBuffer()));}catch(e){res.writeHead(502).end(String(e));}});
  await new Promise(resolveListen=>proxy.listen(0,'127.0.0.1',resolveListen));const registry='http://127.0.0.1:'+proxy.address().port;
  env.npm_config_registry=registry;restore=configureCandidateRegistry(home,registry);
  report.registry={...overlayA.identity,actualFront:registry};save('report.json',report);
  ok(await call('install published through npm',npm,npmArgs(['install','-g','--prefix',prefix,'cotal-ai@'+latest,'--no-audit','--no-fund'])));
  ok(await cli('seed published connectors',['ext','seed']));
  const workspaceEntry=join(pkg,'node_modules/@cotal-ai/workspace/dist/index.js');
  ok(await cli('published native daemon plan',['daemon','install','--dry-run','--json']));
  ok(await cli('install pre-existing published service',['daemon','install','--json']));installed=true;
  report.publishedService=await poll('published service ready',async()=>{const s=await status();return s?.state==='ready'&&s.version===latest?s:undefined;});
  // Passive file reads retain the actual refusal before timeout or service cleanup can erase it.
  captureGeneration('published service ready');
  const generationTimer=setInterval(()=>captureGeneration('manual first-feature hop pending'),10000);
  // One manual feature hop with an existing service, no auto-on or reinstall afterwards.
  try{ok(await cli('manual first-feature update',['update','--self']));}finally{clearInterval(generationTimer);captureGeneration('manual first-feature hop finished');}
  assert.equal(json(join(pkg,'package.json')).version,versionA);
  const nativeRead=ok(await call('installed packed native boot/accounting/drain smoke',process.execPath,[join(output,'installed-native-smoke.mjs'),workspaceEntry]));report.nativeSmoke=nativeRead;
  const before=await poll('default armed native service',async()=>{const s=await status();return s?.state==='ready'&&s.version===versionA&&s.update?.automatic===true?s:undefined;});
  report.defaultOn={noAutoOnCommand:true,status:before};
  await poll('normal scheduler cache',()=>existsSync(join(cotalHome,'update-check.json')));
  // OFF before tick sees B but never creates task/worker or changes installation.
  active=overlayB;ok(await cli('switch automatic updates off',['update','--auto','off']));age();
  const inventory={package:sha(join(pkg,'package.json')),entry:sha(entry)};await delay(70000);
  assert.deepEqual({package:sha(join(pkg,'package.json')),entry:sha(entry)},inventory);assert(!existsSync(join(cotalHome,'update-windows.json')));
  const off=await status();assert.equal(off.update.automatic,false);report.cells.push({name:'off-before-tick',pass:true,status:off});save('report.json',report);
  ok(await cli('switch automatic updates on',['update','--auto','on']));
  // Kill a real updater worker after helper admission, holding registry only to prevent replacement.
  hold=true;age();
  await poll('registry block armed by actual worker',()=>held.length>0,120000,50);
  const receipt=await poll('real scheduled helper owner',()=>{const f=join(cotalHome,'update-windows.json');if(!existsSync(f))return;try{const r=json(f);return r.owner&&!r.drained?r:undefined;}catch{}},120000,100);
  const killScript="$ErrorActionPreference='Stop'; $r=Get-Content -Raw -LiteralPath $env:CELL_RECEIPT|ConvertFrom-Json; $p=Get-Process -Id $r.owner.pid; $h=$p.Handle;if($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $r.owner.start){throw 'owner birth mismatch'};$kids=@(Get-CimInstance Win32_Process -Filter ('ParentProcessId = '+$p.Id)|Where-Object {$_.Name -eq 'node.exe'});if($kids.Count -ne 1 -or $kids[0].ExecutablePath -ine $env:CELL_NODE -or -not $kids[0].CommandLine.Contains($env:CELL_ENTRY) -or $kids[0].CommandLine -notmatch 'update\\s+--self$'){throw 'worker exact entry not uniquely identified'};$w=Get-Process -Id $kids[0].ProcessId;$wh=$w.Handle;$birth=$w.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();$w.Kill();if(-not $w.WaitForExit(10000)){throw 'worker did not exit'};ConvertTo-Json -Compress @{owner=$p.Id;ownerAlive=(-not $p.HasExited);worker=$w.Id;workerBirth=$birth};$w.Dispose();$p.Dispose()";
  const workerKill=ok(await ps('kill exact worker with helper alive',killScript,{CELL_RECEIPT:join(cotalHome,'update-windows.json'),CELL_ENTRY:entry,CELL_NODE:process.execPath}));
  assert.equal(JSON.parse(workerKill.stdout).ownerAlive,true);
  hold=false;for(const x of held.splice(0)){x.res.writeHead(503).end('fixture released after worker interruption');}
  const drained=await poll('owner native drain outcome',()=>{try{const r=json(join(cotalHome,'update-windows.json'));return r.drained?r:undefined;}catch{}},60000,100);
  const failed=json(join(cotalHome,'update-attempt.json'));assert.equal(failed.failures,1);report.cells.push({name:'worker-kill-owner-alive',pass:true,receipt,workerKill:JSON.parse(workerKill.stdout),drained,attempt:failed});save('report.json',report);
  // Only eligibility clocks are aged; normal timer owns the retry and package replacement.
  age();
  const transitioned=await poll('actual Scheduler candidate transition',async()=>{if(!existsSync(join(pkg,'package.json')))return;try{if(json(join(pkg,'package.json')).version!==versionB)return;const s=await status();return s?.state==='ready'&&s.version===versionB?s:undefined;}catch{}},600000,3000);
  const after=json(join(cotalHome,'update-attempt.json'));assert.equal(after.failures,0);
  const extensions=json(join(config,'extensions/extensions.json')).extensions;assert.equal(extensions.filter(x=>x.pkg.startsWith('@cotal-ai/')).length,8);for(const x of extensions.filter(x=>x.pkg.startsWith('@cotal-ai/')))assert.equal(x.version,versionB);
  report.cells.push({name:'transition-and-retry-once',pass:true,status:transitioned,attempt:after,extensions});save('report.json',report);
  await poll('owned task cleanup after transition',()=>!existsSync(join(cotalHome,'update-windows.json')),90000);
  // Owner-kill uses next packed generationA as source after stock manual npm install, then B scheduler.
  active=overlayA;
  // The public updater will not downgrade latest: use stock npm install explicit version for reset.
  ok(await cli('stop native service for fixture reset',['daemon','uninstall','--yes','--json']));installed=false;
  ok(await call('stock npm reset to first feature generation',npm,npmArgs(['install','-g','--prefix',prefix,'cotal-ai@'+versionA,'--no-audit','--no-fund'])));
  ok(await cli('manual reset reconciliation',['update']));ok(await cli('native service reinstallation',['daemon','install','--json']));installed=true;
  await poll('rearmed reset service',async()=>{const s=await status();return s?.update?.automatic===true?s:undefined;});active=overlayB;hold=true;age();
  await poll('second registry block armed by actual worker',()=>held.length>0,120000,50);
  const ownerReceipt=await poll('second real scheduled helper',()=>{try{const r=json(join(cotalHome,'update-windows.json'));return r.owner&&!r.drained?r:undefined;}catch{}},120000,100);
  const ownerKill=ok(await ps('kill exact helper owner',"$ErrorActionPreference='Stop';$r=Get-Content -Raw -LiteralPath $env:CELL_RECEIPT|ConvertFrom-Json;$p=Get-Process -Id $r.owner.pid;$h=$p.Handle;if($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $r.owner.start){throw 'owner birth mismatch'};$p.Kill();if(-not $p.WaitForExit(10000)){throw 'owner not dead'};ConvertTo-Json -Compress @{owner=$p.Id;birth=$r.owner.start;bootId=$r.owner.bootId};$p.Dispose()",{CELL_RECEIPT:join(cotalHome,'update-windows.json'),CELL_ENTRY:entry,CELL_NODE:process.execPath}));
  hold=false;for(const x of held.splice(0)){x.res.writeHead(503).end('fixture released after owner interruption');}
  const paused=await poll('sameboot visible automatic pause',async()=>{const s=await status();return s?.update?.automatic===false&&/last automatic update was interrupted/.test(s.update.lastResult)?s:undefined;},120000);
  assert.equal(json(join(pkg,'package.json')).version,versionA);
  ok(await cli('one manual update clears sameboot pause',['update']));
  const cleared=await poll('automatic schedule resumed after manual success',async()=>{const s=await status();return s?.update?.automatic===true?s:undefined;},120000);
  report.cells.push({name:'owner-kill-sameboot-manual-clear',pass:true,ownerReceipt,ownerKill:JSON.parse(ownerKill.stdout),paused,cleared});
  ok(await cli('public status after acceptance',['status']));report.pass=true;
 }catch(error){report.pass=false;report.error=String(error.stack??error);captureGeneration('failure before native service cleanup');throw error;}
 finally{
  hold=false;for(const x of held.splice(0)){x.res.writeHead(503).end('fixture teardown');}
  if(installed){const result=await cli('cleanup exact owned native service',['daemon','uninstall','--yes','--json']);report.cleanup=result;if(result.exit!==0)report.pass=false;}
  restore?.();await overlayA?.close();await overlayB?.close();if(proxy){proxy.closeAllConnections();await new Promise(resolveClose=>proxy.close(resolveClose));}save('report.json',report);
 }
 return report;
}
if(process.argv[1]===import.meta.filename)await run();
