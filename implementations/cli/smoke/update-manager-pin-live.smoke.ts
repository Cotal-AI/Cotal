/** Real user-auth exchange with two actual supervisor processes for the same owner. */
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareUpdateParticipant} from '../../auth/smoke/update-participant.fixture.js';
import {recordedUpdateManagers} from '../src/lib/update-managers.js';
import {readManagerContinuity,reportRunningManagers} from '../src/commands/update.js';
import {countedAssert,emitSentinel} from '@cotal-ai/smoke-kit';
const counted=countedAssert(assert),check:typeof assert=counted.assert;
const root=realpathSync(mkdtempSync(join(tmpdir(),'cotal-update-pin-live-')));
const env:NodeJS.ProcessEnv={...process.env};for(const key of Object.keys(env))if(key.startsWith('COTAL_'))delete env[key];
for(const name of ['home','state','config','runtime','tmp','project','other'])mkdirSync(join(root,name),{mode:0o700});
for(const name of ['project','other'])mkdirSync(join(root,name,'.cotal'),{mode:0o700});
Object.assign(env,{HOME:join(root,'home'),COTAL_HOME:join(root,'state'),XDG_CONFIG_HOME:join(root,'config'),XDG_RUNTIME_DIR:join(root,'runtime'),TMPDIR:join(root,'tmp'),DO_NOT_TRACK:'1',COTAL_TELEMETRY:'off',COTAL_SKIP_CONNECTOR_SEED:'1'});
for(const key of Object.keys(process.env))if(key.startsWith('COTAL_'))delete process.env[key];Object.assign(process.env,env);process.chdir(join(root,'project'));
const entry=join(import.meta.dirname,'../../../bin/dist/cotal.js'),report:Record<string,any>={};
const children:ChildProcess[]=[];let close:(()=>Promise<void>)|undefined;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 close=await prepareUpdateParticipant({env,project:join(root,'project'),cotalHome:env.COTAL_HOME!,report});
 const space=report.participant.space;
 const logs:string[]=[];
 for(const [index,name]of ['project','other'].entries()){
  const child=spawn(process.execPath,[entry,'supervise','--space',space,'--name',name],{cwd:join(root,name),env,stdio:['ignore','pipe','pipe']});children.push(child);logs[index]='';child.stdout!.on('data',bytes=>{logs[index]+=bytes;});child.stderr!.on('data',bytes=>{logs[index]+=bytes;});
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
