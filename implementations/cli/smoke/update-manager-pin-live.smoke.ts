/** Real user-auth exchange with two actual supervisor processes for the same owner. */
import assert from 'node:assert/strict';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareUpdateParticipant} from '../../auth/smoke/update-participant.fixture.js';
import {recordedUpdateManagers} from '../src/lib/update-managers.js';
import {readManagerContinuity,reportRunningManagers} from '../src/commands/update.js';
import {recordMesh,loadMeshes} from '@cotal-ai/workspace';
import {SMOKE_BROKER_TOKEN,countedAssert,emitSentinel,killAndAwaitExit,teardownOnSignal} from '@cotal-ai/smoke-kit';
const counted=countedAssert(assert),check:typeof assert=counted.assert;
const root=realpathSync(mkdtempSync(join(tmpdir(),'cotal-update-pin-live-')));
const env:NodeJS.ProcessEnv={...process.env};for(const key of Object.keys(env))if(key.startsWith('COTAL_'))delete env[key];
for(const name of ['home','state','config','runtime','tmp','project','other'])mkdirSync(join(root,name),{mode:0o700});
for(const name of ['project','other'])mkdirSync(join(root,name,'.cotal'),{mode:0o700});
Object.assign(env,{HOME:join(root,'home'),COTAL_HOME:join(root,'state'),XDG_CONFIG_HOME:join(root,'config'),XDG_RUNTIME_DIR:join(root,'runtime'),TMPDIR:join(root,'tmp'),DO_NOT_TRACK:'1',COTAL_TELEMETRY:'off',COTAL_SKIP_CONNECTOR_SEED:'1'});
for(const key of Object.keys(process.env))if(key.startsWith('COTAL_'))delete process.env[key];Object.assign(process.env,env);process.env.COTAL_HOME=join(root,'state');process.chdir(join(root,'project'));
const entry=join(import.meta.dirname,'../../../bin/dist/cotal.js'),report:Record<string,any>={};
const children:ChildProcess[]=[];let close:(()=>Promise<void>)|undefined;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 const deadRoot=join(root,'tmp','dead');mkdirSync(join(deadRoot,'.cotal','agents'),{recursive:true});
 const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
 const port=(listener.address() as {port:number}).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));
 const deadServer=`nats://127.0.0.1:${port}`;
 const store=mkdtempSync(join(root,'tmp',SMOKE_BROKER_TOKEN));
 const broker=spawn('nats-server',['-js','-p',String(port),'-sd',store],{env,stdio:'ignore'});children.push(broker);
 const releaseBroker=teardownOnSignal(broker,store);
 await pause(500);
 const added=spawnSync(process.execPath,[entry,'space','add','gone','--server',deadServer,'--root',deadRoot,'--mode','open','--force'],{env,encoding:'utf8'});
 check.equal(added.status,0,added.stdout+added.stderr);
 await killAndAwaitExit(broker);releaseBroker();children.splice(children.indexOf(broker),1);
 const retained=()=>reportRunningManagers({},flags=>readManagerContinuity(flags,{readOnly:true,retainGraph:true,installedEntry:entry}),flags=>recordedUpdateManagers(flags,entry));
 process.chdir('/');
 for(const server of [deadServer,'nats://unreachable.invalid:4222']){
  recordMesh({space:'gone',server,root:deadRoot,mode:'open',origin:'manual',ts:new Date().toISOString()});
  const before=JSON.stringify(loadMeshes());
  check.equal(await retained(),'none','staged update ignores dead registration');
  check.equal(await reportRunningManagers({}),'none','default update ignores dead registration');
  check.equal(JSON.stringify(loadMeshes()),before,'liveness sweep keeps registry unchanged');
  process.chdir(deadRoot);
  check.equal(await retained(),'none','staged update from registered root ignores dead registration');
  check.equal(await reportRunningManagers({}),'none','default update from registered root ignores dead registration');
  process.chdir('/');
 }
 recordMesh({space:'gone-two',server:deadServer,root:deadRoot,mode:'open',origin:'manual',ts:new Date().toISOString()});
 check.equal(await retained(),'none','two dead registrations do not refuse staged update');
 check.equal(await reportRunningManagers({}),'none','two dead registrations do not refuse default update');
 process.chdir(join(root,'project'));
 close=await prepareUpdateParticipant({env,project:join(root,'project'),cotalHome:env.COTAL_HOME!,report});
 const space=report.participant.space;
 const logs:string[]=[];
 for(const [index,name]of ['project','other'].entries()){
  const child=spawn(process.execPath,[entry,'supervise','--space',space,'--name',name],{cwd:join(root,name),env,stdio:['ignore','pipe','pipe']});children.push(child);logs[index]='';child.stdout!.on('data',bytes=>{logs[index]+=bytes;});child.stderr!.on('data',bytes=>{logs[index]+=bytes;});
  // Stagger the starts until concurrent Manager registration is fixed (#10803).
  if(index===0)await new Promise<void>((resolve,reject)=>{
   const activated=()=>{if(logs[index].includes('service endpoint activated')){cleanup();resolve();}};
   const closed=()=>fail('First Manager exited before activation');
   const timer=setTimeout(()=>fail('Timed out waiting for first Manager activation'),45000);
   function cleanup(){clearTimeout(timer);child.stderr!.off('data',activated);child.off('close',closed);}
   function fail(message:string){cleanup();reject(new Error(`${message}\n${logs[index]}`));}
   child.stderr!.on('data',activated);child.once('close',closed);
  });
 }
 const ids:string[]=[];
 for(let attempt=0;attempt<180;attempt++){
  ids.length=0;
  for(const name of ['project','other']){const dir=join(root,name,'.cotal');const f=readdirSync(dir).find(name=>name.startsWith('remote-manager.')&&name.endsWith('.json'));if(f&&existsSync(join(dir,f)))ids.push(JSON.parse(readFileSync(join(dir,f),'utf8')).instanceId);}
  if(ids.length===2&&logs.every(text=>text.includes('service endpoint activated'))&&readdirSync(join(root,'project','.cotal')).some(name=>/^manager\..+\.pid\.identity$/.test(name)))break;
  assert(children.every(child=>child.exitCode===null),logs.join('\n'));await pause(250);
 }
 check.equal(ids.length,2,'two actual remote Manager identities exist');check.notEqual(ids[0],ids[1]);
 const candidates=recordedUpdateManagers({space},entry);
 check.equal(candidates.length,1,'portable records select only the registered local root, no process-table dependency');
 check.equal(candidates[0].instanceId,ids[0],'pin is the mesh Manager instance, not an unrelated process or service UUID');
 check.equal(candidates[0].pid,children[0].pid,'native pinned process is the actual local supervisor');
 check.equal(await readManagerContinuity({space},{installedEntry:entry,readOnly:true,retainGraph:true}),'none','direct continuity pins before the real multi-Manager exchange');
 const seen:string[]=[];
 check.equal(await reportRunningManagers({space},async flags=>{seen.push(String(flags.on));return readManagerContinuity(flags,{installedEntry:entry,readOnly:true,retainGraph:true});},()=>recordedUpdateManagers({space},entry)),'none','portable census and real continuity compose without an unpinned exchange');
 check.deepEqual(seen,[ids[0]],'only the recorded local instance was read');
 const liveReads:string[]=[];
 check.equal(await reportRunningManagers({},async flags=>{liveReads.push(String(flags.on));return readManagerContinuity(flags,{installedEntry:entry,readOnly:true,retainGraph:true});},flags=>recordedUpdateManagers(flags,entry)),'none','dead registrations do not prevent reading live local custody');
 check.deepEqual(liveReads,[ids[0]],'install-wide update still reads the actual local Manager beside dead registrations');
 const sessions=join(env.COTAL_HOME!,'idp-sessions.json'),savedSessions=sessions+'.held';
 renameSync(sessions,savedSessions);
 try{
  await check.rejects(readManagerContinuity({space,on:ids[0]},{installedEntry:entry,readOnly:true,retainGraph:true}),error=>(error as {cause?:{code?:string}}).cause?.code==='signed-out','real control resolve confirms own-home missing session');
  check.equal(await reportRunningManagers({space},flags=>readManagerContinuity(flags,{installedEntry:entry,readOnly:true,retainGraph:true}),()=>recordedUpdateManagers({space},entry),{retainGraph:true}),'none','retained own-home signed-out update leaves Manager running');
  check.equal(recordedUpdateManagers({space},entry)[0]?.instanceId,ids[0],'same native Manager identity survives signed-out read');
  check.equal(children[0].exitCode,null,'signed-out read does not stop Manager');
 }finally{renameSync(savedSessions,sessions);}
 const otherInstall=join(root,'tmp','other-install');mkdirSync(join(otherInstall,'dist'),{recursive:true,mode:0o700});
 writeFileSync(join(otherInstall,'package.json'),JSON.stringify({name:'cotal-ai',bin:{cotal:'dist/cotal.js'}}));writeFileSync(join(otherInstall,'dist','cotal.js'),'');
 const otherEntry=join(otherInstall,'dist','cotal.js');
 check.equal(recordedUpdateManagers({space},otherEntry).length,0,'a recorded Manager that loaded another installation is no custody of the one being updated');
 check.equal(await readManagerContinuity({space},{installedEntry:otherEntry,readOnly:true}),'none','updating one installation is not held by a Manager that runs from another');
 const directory=join(root,'project','.cotal');
 const pidfile=readdirSync(directory).find(name=>/^manager\..+\.pid$/.test(name));
 check.ok(pidfile,'actual supervisor writes its local process record');
 const path=join(directory,pidfile!),held=path+'.test-held';renameSync(path,held);
 try{
  check.equal(recordedUpdateManagers({space},entry).length,0,'missing local process record does not invent a Manager pin');
  check.equal(await readManagerContinuity({space},{installedEntry:entry,readOnly:true,retainGraph:true}),'none','the real several-live exchange refusal continues only the updater when no local pin exists');
  await check.rejects(readManagerContinuity({space,on:'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'},{installedEntry:entry,readOnly:true,retainGraph:true}),'an explicit unavailable Manager pin is never ignored');
 }finally{renameSync(held,path);}

}finally{
 for(const child of children)if(child.exitCode===null&&child.signalCode===null){const done=once(child,'close');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),10000);try{await done;}finally{clearTimeout(timer);}}
 await close?.();console.log(`Retained private update-pin fixture: ${root}`);
}
emitSentinel({passed:counted.cells(),failed:0});
