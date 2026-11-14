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
  const taskName=JSON.parse(report.calls.find(c=>c.label==='install pre-existing published service').stdout).result.unit;
  const observerReady=join(output,'generation-observer-ready.json'),observerStop=join(output,'generation-observer-stop');
  Object.assign(env,{CELL_DAEMON_PID:String(report.publishedService.pid),CELL_DAEMON_TASK:taskName,CELL_OBSERVER_READY:observerReady,CELL_OBSERVER_STOP:observerStop,CELL_OBSERVER_LOG:join(output,'generation-native-observer.jsonl')});
  const observerScript="$ErrorActionPreference='Stop';$p=Get-Process -Id ([int]$env:CELL_DAEMON_PID);$handle=$p.Handle;$birth=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();$scheduler=New-Object -ComObject 'Schedule.Service';$scheduler.Connect();$task=$scheduler.GetFolder('\\').GetTask($env:CELL_DAEMON_TASK);[IO.File]::WriteAllText($env:CELL_OBSERVER_READY,(@{pid=$p.Id;birth=$birth;task=$env:CELL_DAEMON_TASK}|ConvertTo-Json -Compress));$deadline=[DateTime]::UtcNow.AddMinutes(10);try{do{$p.Refresh();$dead=$p.HasExited;$row=@{at=[DateTime]::UtcNow.ToString('o');pid=$p.Id;birth=$birth;exited=$dead;exitCode=$(if($dead){$p.ExitCode}else{$null});task=$env:CELL_DAEMON_TASK;state=[int]$task.State;enabled=[bool]$task.Enabled;instances=[int]$task.GetInstances(0).Count;lastResult=[long]$task.LastTaskResult;lastRun=$task.LastRunTime.ToUniversalTime().ToString('o')};[IO.File]::AppendAllText($env:CELL_OBSERVER_LOG,($row|ConvertTo-Json -Compress)+[Environment]::NewLine);if([IO.File]::Exists($env:CELL_OBSERVER_STOP)){break};Start-Sleep -Seconds 5}while([DateTime]::UtcNow -lt $deadline)}finally{$p.Dispose()}";
  const observer=call('passive exact-task and pinned-old-daemon observer',join(env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(observerScript,'utf16le').toString('base64')],620000);
  // One manual feature hop with an existing service, no auto-on or reinstall afterwards.
  try{await poll('pinned native generation observer ready',()=>existsSync(observerReady),30000,100);ok(await cli('manual first-feature update',['update','--self']));}finally{writeFileSync(observerStop,'stop');const observed=await observer;clearInterval(generationTimer);captureGeneration('manual first-feature hop finished');ok(observed);}
  assert.equal(json(join(pkg,'package.json')).version,versionA);
  const ready=await poll('manual target service ready',async()=>{const s=await status();return s?.state==='ready'&&s.version===versionA?s:undefined;});
  report.cells.push({name:'published-service-manual-update',pass:true,status:ready});
  const extensions=json(join(config,'extensions/extensions.json')).extensions;report.extensions=extensions;save('report.json',report);
  const installedWorkspace=await import(pathToFileURL(workspaceEntry).href);
  const expected=Object.values(installedWorkspace.SEEDED_EXTENSIONS).map(x=>x.pkg).sort();
  const firstParty=extensions.filter(x=>x.pkg.startsWith('@cotal-ai/'));report.expectedExtensions=expected;save('report.json',report);
  assert.deepEqual(firstParty.map(x=>x.pkg).sort(),expected);for(const x of firstParty)assert.equal(x.version,versionA);
  const recovery=join(cotalHome,'update-recovery.json');assert(!existsSync(recovery)||json(recovery)===null,'manual update must clear recovery state');
  report.nativeSmoke=ok(await call('installed retained process and legacy owner smoke',process.execPath,[join(output,'installed-native-smoke.mjs'),workspaceEntry]));
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
