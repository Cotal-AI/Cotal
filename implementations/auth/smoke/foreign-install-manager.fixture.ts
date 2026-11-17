/** A real same-user supervisor from a second installation in the selected hosted space. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {assertRecordIdentity,identityRecord} from '@cotal-ai/workspace';
import {prepareUpdateParticipant} from './update-participant.fixture.js';

type Context = Parameters<typeof prepareUpdateParticipant>[0] & {
 root: string;
 pkg: string;
 output: string;
 id: string;
 call: (label: string,file: string,argv: string[],timeout?: number)=>Promise<{exit:number|null;stdout:string;stderr:string}>;
 check: (name:string,passed:boolean,observed?:unknown)=>void;
};

export async function prepareForeignInstallManager(context: Context):Promise<()=>Promise<void>> {
 const {env,project,root,report,call,check}=context;
 const closeParticipant=await prepareUpdateParticipant(context);
 const prefix=join(root,'other-install'),entry=join(prefix,'lib/node_modules/cotal-ai/dist/cotal.js');
 let child:ReturnType<typeof spawn>|undefined;
 let ownedIdentity:ReturnType<typeof identityRecord>|undefined;
 let logs='';
 const close=async()=>{
  try {
   if(child&&child.exitCode===null&&child.signalCode===null){
    if (ownedIdentity && 'token' in ownedIdentity) assert.equal(assertRecordIdentity(ownedIdentity).kind, 'match', 'only the owned foreign Manager may be stopped');
    const closed=once(child,'close');child.kill('SIGTERM');
    const timer = setTimeout(() => {
     if (ownedIdentity && 'token' in ownedIdentity && assertRecordIdentity(ownedIdentity).kind === 'match') child?.kill('SIGKILL');
    }, 10000);
    try{await closed;}finally{clearTimeout(timer);}
   }
  }finally{await closeParticipant();}
 };
 try{
  assert(['linux','darwin'].includes(process.platform),'foreign-install cell requires POSIX process identity');
  const old=JSON.parse(readFileSync(join(context.pkg,'package.json'),'utf8'));
  assert.equal(old.version,'0.162.0');assert.equal(realpathSync(context.pkg),context.pkg,'source must be the untouched legacy global package, not a selected staged generation');
  mkdirSync(prefix,{mode:0o700});
  const installed=await call('install second public CLI','npm',['install','-g','--prefix',prefix,'cotal-ai@0.162.0','--before=2026-11-16T19:38:00.000Z','--no-audit','--no-fund']);
  assert.equal(installed.exit,0,installed.stderr);
  assert.notEqual(realpathSync(entry),realpathSync(join(context.pkg,'dist/cotal.js')));
  const participant=report.participant as {space:string};
  const managerEnv={...env,npm_config_prefix:prefix};
  child=spawn(process.execPath,[entry,'supervise','--space',participant.space,'--name','foreign-install'],{cwd:project,env:managerEnv,stdio:['ignore','pipe','pipe']});
  child.stdout!.on('data',bytes=>{logs+=bytes;});child.stderr!.on('data',bytes=>{logs+=bytes;});
  let instanceId:string|undefined;
  for(let i=0;i<180;i++){
   assert(child.exitCode===null&&child.signalCode===null,logs);
   const state=join(project,'.cotal');
   const record=readdirSync(state).find(name=>name.startsWith('remote-manager.')&&name.endsWith('.json'));
   if(record&&logs.includes('service endpoint activated')&&readdirSync(state).some(name=>/^manager\..+\.pid\.identity$/.test(name))){instanceId=JSON.parse(readFileSync(join(state,record),'utf8')).instanceId;break;}
   await delay(250);
  }
  assert(instanceId&&child.pid,'foreign installed supervisor must register its real process and instance');
  const identity=identityRecord(child.pid);assert('token' in identity,'native process creation identity required');
  ownedIdentity=identity;
  const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
  const remoteRecord=join(project,'.cotal',readdirSync(join(project,'.cotal')).find(name=>name.startsWith('remote-manager.')&&name.endsWith('.json'))!);
  const remote=JSON.parse(readFileSync(remoteRecord,'utf8'));
  const inventory=()=>({entrySha256:hash(entry),packageSha256:hash(join(prefix,'lib/node_modules/cotal-ai/package.json')),remoteRecordSha256:hash(remoteRecord)});
  const originalInventory=inventory();
  const observe=async(label:string)=>{
   assert.equal(assertRecordIdentity(identity).kind,'match');
   const reply=await call(label,process.execPath,[entry,'ps','--on',instanceId!,'--space',participant.space,'--json']);
   assert.equal(reply.exit,0,reply.stdout+reply.stderr);
   const body=JSON.parse(reply.stdout);assert.equal(body.outcome,'ok');
   assert.deepEqual(inventory(),originalInventory,'foreign package, entry and Manager identity record unchanged');
   return {identity,instanceId,lifecycleUid:remote.managerLifecycleUid??remote.lifecycleUid,entry,uid:process.getuid?.(),version:'0.162.0',inventory:inventory(),status:reply,observedAt:new Date().toISOString()};
  };
  const archive=(stage:string,value:unknown)=>{
   const bytes=Buffer.from(JSON.stringify(value)),artifact=`${context.id}-foreign-install-${stage}.txt`;
   writeFileSync(join(context.output,artifact),bytes,{flag:'wx',mode:0o600});
   return {artifact,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  };
  const before=await observe('foreign installation Manager before update');
  report.foreignInstallManager={before,beforeArtifact:archive('before',before)};
  check('foreign Manager uses a second installation on this user and host',true,before);
  return async()=>{
   try{
    const after=await observe('foreign installation Manager after update');
    assert.deepEqual(after.identity,before.identity);assert.equal(after.instanceId,before.instanceId);
    (report.foreignInstallManager as Record<string,unknown>).after=after;
    (report.foreignInstallManager as Record<string,unknown>).afterArtifact=archive('after',after);
    check('foreign installation Manager remains answering with unchanged native identity',true,after);
   }finally{await close();}
  };
 }catch(error){await close();throw error;}
}
