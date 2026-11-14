// Temporary native acceptance composition. Reuses the matrix packer and verified registry overlay.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, delimiter, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { candidateRegistry, configureCandidateRegistry, packCandidate } from './automatic-update-platform-baseline.mjs';
const output=resolve(process.env.WINDOWS_AUTO_EVIDENCE??(process.argv[2]?.startsWith('--')?process.argv[3]:process.argv[2])??join(process.env.RUNNER_TEMP??'.','windows-auto-evidence'));
mkdirSync(output,{recursive:true});
const save=(name,value)=>writeFileSync(join(output,name),JSON.stringify(value,null,2)+'\n');
const json=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
export async function candidatePairResponse(A,B,active,path){
 const pathname=decodeURIComponent(new URL(path,'http://localhost').pathname);
 const target=pathname.endsWith('/'+A.identity.version)?A:pathname.endsWith('/'+B.identity.version)?B:active;
 const response=await fetch(target.url+path,{signal:AbortSignal.timeout(60000)});
 const contentType=response.headers.get('content-type')??'application/json';
 if(!contentType.includes('json'))return {status:response.status,contentType,bytes:Buffer.from(await response.arrayBuffer())};
 const text=await response.text();let body;try{body=JSON.parse(text);}catch{return {status:response.status,contentType,bytes:Buffer.from(text)};}
 if(body?.versions){
  const other=target===A?B:A;
  const extra=await fetch(other.url+path,{signal:AbortSignal.timeout(60000)});assert(extra.ok,'both candidate closures must be readable');
  const additional=await extra.json();assert(additional.versions,'candidate package metadata must include versions');
  body.versions={...additional.versions,...body.versions};
 }
 return {status:response.status,contentType,bytes:Buffer.from(JSON.stringify(body))};
}
export async function run(){
 if(process.argv[2]==='--verify-packed'){
  const A=await candidateRegistry(join(output,'candidate-A'),'B','https://registry.npmjs.org');
  const B=await candidateRegistry(join(output,'candidate-B'),'B','https://registry.npmjs.org');
  try{const versions=json(join(output,'versions.json'));assert.equal((await(await fetch(A.url+'/cotal-ai/latest')).json()).version,versions.A);assert.equal((await(await fetch(B.url+'/cotal-ai/latest')).json()).version,versions.B);for(const active of [A,B]){const metadata=JSON.parse((await candidatePairResponse(A,B,active,'/cotal-ai')).bytes);assert(metadata.versions[versions.A]);assert(metadata.versions[versions.B]);assert.equal(metadata['dist-tags'].latest,active.identity.version);for(const version of [versions.A,versions.B]){const selected=JSON.parse((await candidatePairResponse(A,B,active,'/cotal-ai/'+version)).bytes);assert.equal(selected.version,version);assert(selected.dist.integrity);assert.equal((await fetch(selected.dist.tarball)).status,200);}}console.log('downloaded packed closures/registry pair bundle verified');}finally{await A.close();await B.close();}
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
  for(const [name,path]of [['daemon.log',join(cotalHome,'daemon/daemon.log')],['update-attempt.log',join(cotalHome,'update-attempt.log')],['update-windows.json',join(cotalHome,'update-windows.json')],['update-recovery.json',join(cotalHome,'update-recovery.json')],['update-attempt.json',join(cotalHome,'update-attempt.json')],['installed-package.json',join(pkg,'package.json')]]){
   try{const text=readFileSync(path,'utf8');if(name.endsWith('.log'))snapshot.files[name]=text.slice(-65536).replace(/eyJ[A-Za-z0-9_.-]*/g,'<redacted>');else{const value=JSON.parse(text);snapshot.files[name]=name==='update-windows.json'?{name:value.name,owner:value.owner,drained:value.drained,done:value.done,revoked:value.revoked,bootId:value.bootId}:name==='update-recovery.json'?(value===null?null:{phase:value.phase,previous:value.previous,target:value.target,installed:value.installed,preparedRestart:value.preparedRestart,reason:value.reason,owner:value.owner?{pid:value.owner.pid,start:value.owner.start}:undefined}):name==='installed-package.json'?{name:value.name,version:value.version}:value;}}catch(error){snapshot.files[name]={error:error.code??error.message};}
  }
  generationSnapshots.push(snapshot);save('generation-snapshots.json',generationSnapshots);
 };
 const age=()=>{for(const [name,fields]of [['update-check.json',['checkedAt','attemptedAt','firstSeenAt']],['update-attempt.json',['next']]]){const path=join(cotalHome,name),before=json(path),after={...before};for(const field of fields)after[field]=Date.now()-26*3600000;save('clock-'+name,{before,after});writeFileSync(path,JSON.stringify(after));}};
 let automaticEvidenceTimer;
 let overlayA,overlayB,restore,proxy,hold=false,installed=false;const held=[];
 try{
  const packed=json(join(output,'versions.json'));const latest=packed.published;report.published=latest;
  const versionA=packed.A,versionB=packed.B;
  report.versions={A:versionA,B:versionB,source:packed.source};
  overlayA=await candidateRegistry(join(output,'candidate-A'),'B','https://registry.npmjs.org');overlayB=await candidateRegistry(join(output,'candidate-B'),'B','https://registry.npmjs.org');
  let active=overlayA;
  proxy=createServer(async(req,res)=>{try{if(hold&&decodeURIComponent(req.url).startsWith('/cotal-ai')&&existsSync(join(cotalHome,'update-windows.json'))&&json(join(cotalHome,'update-windows.json')).owner){held.push({req,res});return;}const r=await candidatePairResponse(overlayA,overlayB,active,req.url);res.writeHead(r.status,{'content-type':r.contentType});res.end(r.bytes);}catch(e){res.writeHead(502).end(String(e));}});
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
  const taskName=JSON.parse(report.calls.find(c=>c.label==='install pre-existing published service').stdout).result.unit;
  const observerReady=join(output,'generation-observer-ready.json'),observerStop=join(output,'generation-observer-stop');
  Object.assign(env,{CELL_DAEMON_PID:String(report.publishedService.pid),CELL_DAEMON_TASK:taskName,CELL_OBSERVER_READY:observerReady,CELL_OBSERVER_STOP:observerStop,CELL_OBSERVER_LOG:join(output,'generation-native-observer.jsonl')});
  const observerScript="$ErrorActionPreference='Stop';$p=Get-Process -Id ([int]$env:CELL_DAEMON_PID);$handle=$p.Handle;$birth=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();$scheduler=New-Object -ComObject 'Schedule.Service';$scheduler.Connect();$task=$scheduler.GetFolder('\\').GetTask($env:CELL_DAEMON_TASK);[IO.File]::WriteAllText($env:CELL_OBSERVER_READY,(@{pid=$p.Id;birth=$birth;task=$env:CELL_DAEMON_TASK}|ConvertTo-Json -Compress));$deadline=[DateTime]::UtcNow.AddMinutes(10);try{do{$p.Refresh();$dead=$p.HasExited;$row=@{at=[DateTime]::UtcNow.ToString('o');pid=$p.Id;birth=$birth;exited=$dead;exitCode=$(if($dead){$p.ExitCode}else{$null});task=$env:CELL_DAEMON_TASK;state=[int]$task.State;enabled=[bool]$task.Enabled;instances=[int]$task.GetInstances(0).Count;lastResult=[long]$task.LastTaskResult;lastRun=$task.LastRunTime.ToUniversalTime().ToString('o')};[IO.File]::AppendAllText($env:CELL_OBSERVER_LOG,($row|ConvertTo-Json -Compress)+[Environment]::NewLine);if([IO.File]::Exists($env:CELL_OBSERVER_STOP)){break};Start-Sleep -Seconds 5}while([DateTime]::UtcNow -lt $deadline)}finally{$p.Dispose()}";
  const observer=call('passive exact-task and pinned-old-daemon observer',join(env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(observerScript,'utf16le').toString('base64')],620000);
  // One manual feature hop with an existing service, no auto-on or reinstall afterwards.
  try{await poll('pinned native generation observer ready',()=>existsSync(observerReady),30000,100);ok(await cli('manual first-feature update',['update','--self']));}finally{writeFileSync(observerStop,'stop');const observed=await observer;clearInterval(generationTimer);captureGeneration('manual first-feature hop finished');ok(observed);}
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
  automaticEvidenceTimer=setInterval(()=>captureGeneration('automatic admission observation'),1000);
  hold=true;age();
  await poll('registry block armed by actual worker',()=>held.length>0,120000,50);
  const receipt=await poll('real scheduled helper owner',()=>{const f=join(cotalHome,'update-windows.json');if(!existsSync(f))return;try{const r=json(f);return r.owner&&!r.drained?r:undefined;}catch{}},120000,100);
  const killScript="$ErrorActionPreference='Stop'; $r=Get-Content -Raw -LiteralPath $env:CELL_RECEIPT|ConvertFrom-Json; $p=Get-Process -Id $r.owner.pid; $h=$p.Handle;if($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $r.owner.start){throw 'owner birth mismatch'};$kids=@(Get-CimInstance Win32_Process -Filter ('ParentProcessId = '+$p.Id)|Where-Object {$_.Name -eq 'node.exe'});if($kids.Count -ne 1 -or $kids[0].ExecutablePath -ine $env:CELL_NODE -or -not $kids[0].CommandLine.Contains($env:CELL_ENTRY) -or $kids[0].CommandLine -notmatch 'update\\s+--self$'){throw 'worker exact entry not uniquely identified'};$w=Get-Process -Id $kids[0].ProcessId;$wh=$w.Handle;$birth=$w.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();$w.Kill();if(-not $w.WaitForExit(10000)){throw 'worker did not exit'};ConvertTo-Json -Compress @{owner=$p.Id;ownerAlive=(-not $p.HasExited);worker=$w.Id;workerBirth=$birth};$w.Dispose();$p.Dispose()";
  const workerKill=ok(await ps('kill exact worker with helper alive',killScript,{CELL_RECEIPT:join(cotalHome,'update-windows.json'),CELL_ENTRY:entry,CELL_NODE:process.execPath}));
  assert.equal(JSON.parse(workerKill.stdout).ownerAlive,true);
  hold=false;for(const x of held.splice(0)){x.res.writeHead(503).end('fixture released after worker interruption');}
  const drained=await poll('owner native drain outcome',()=>{try{const r=json(join(cotalHome,'update-windows.json'));return r.drained?r:undefined;}catch{}},60000,100);
  const failed=json(join(cotalHome,'update-attempt.json'));assert.equal(failed.failures,1);report.cells.push({name:'worker-kill-owner-alive',pass:true,receipt,workerKill:JSON.parse(workerKill.stdout),drained,attempt:failed});save('report.json',report);
  // Only eligibility clocks are aged after normal cleanup commits its retry schedule.
  await poll('owned interrupted task retired before retry aging',()=>!existsSync(join(cotalHome,'update-windows.json')),90000);
  age();
  const transitioned=await poll('actual Scheduler candidate transition',async()=>{if(!existsSync(join(pkg,'package.json')))return;try{if(json(join(pkg,'package.json')).version!==versionB)return;const s=await status();return s?.state==='ready'&&s.version===versionB?s:undefined;}catch{}},600000,3000);
  const after=json(join(cotalHome,'update-attempt.json'));assert.equal(after.failures,0);
  const extensions=json(join(config,'extensions/extensions.json')).extensions;report.extensions=extensions;save('report.json',report);
  const installedWorkspace=await import(pathToFileURL(workspaceEntry).href);
  const expectedExtensions=Object.values(installedWorkspace.SEEDED_EXTENSIONS).map(x=>x.pkg).sort();
  const firstParty=extensions.filter(x=>x.pkg.startsWith('@cotal-ai/'));assert.deepEqual(firstParty.map(x=>x.pkg).sort(),expectedExtensions);for(const x of firstParty)assert.equal(x.version,versionB);
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
 }catch(error){report.pass=false;report.error=String(error.stack??error);captureGeneration('failure before native service cleanup');
  try{const r=json(join(cotalHome,'update-windows.json'));report.helperTask=await ps('inspect exact failed helper task',"$ErrorActionPreference='Stop';$s=New-Object -ComObject Schedule.Service;$s.Connect();$t=$s.GetFolder('\\').GetTask($env:CELL_HELPER_TASK);ConvertTo-Json -Compress @{name=$t.Name;state=[int]$t.State;lastResult=[long]$t.LastTaskResult;instances=[int]$t.GetInstances(0).Count;lastRun=$t.LastRunTime.ToUniversalTime().ToString('o')}",{CELL_HELPER_TASK:r.name});}catch(observation){report.helperTaskObservationError=String(observation);}
  throw error;}
 finally{
  clearInterval(automaticEvidenceTimer);
  hold=false;for(const x of held.splice(0)){x.res.writeHead(503).end('fixture teardown');}
  if(installed){const result=await cli('cleanup exact owned native service',['daemon','uninstall','--yes','--json']);report.cleanup=result;if(result.exit!==0)report.pass=false;}
  restore?.();await overlayA?.close();await overlayB?.close();if(proxy){proxy.closeAllConnections();await new Promise(resolveClose=>proxy.close(resolveClose));}save('report.json',report);
 }
 return report;
}
if(process.argv[1]===import.meta.filename)await run();
