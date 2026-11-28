/** Cold owner death against the actual candidate; records refusal or recovery without predicting it. */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { dirname,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import { createSpaceAuth,mintCreds,mintLifecycleUid,newIdentity,standaloneConnectOpts,setupSpaceStreams,epCall,readGoalResult,type EpCaller } from "@cotal-ai/core";
import { authDir,saveSpaceAuth,workspaceSecretStore } from "@cotal-ai/workspace";
import { capturePeerProcess,processStartToken,type LinuxProcessHandle } from "@cotal-ai/seat";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";
import { MANAGER_ENDPOINT,MANAGER_CONTRACTS } from "../src/manager-service-contract.js";

const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,"../../..");
const mode=process.env.COTAL_COLD_MODE??"startup";assert.ok(["startup","steady"].includes(mode));
const root=mkdtempSync('/var/tmp/nscold-'),workspace=mkdtempSync(join(repo,'.namespace-cold-'));
for(const p of ['home','tmp','ctl'])mkdirSync(join(root,p),{mode:0o700});
mkdirSync(join(workspace,'.cotal','agents'),{recursive:true});
const beforeTmp=process.env.TMPDIR;process.env.TMPDIR=join(root,'tmp');
writeFileSync(join(workspace,'.cotal','agents','seat.md'),'---\nname: seat\n---\n');
const nonce=randomUUID(),observerName='cotal-nscold-'+randomUUID();
const peers=new Map<string,LinuxProcessHandle>(),hosts:Array<{child:ChildProcess;messages:any[];index:number}>=[];
let observerError:unknown;
const observer=createServer(socket=>{let buffer='';socket.on('error',e=>observerError=e);socket.on('data',chunk=>{buffer+=chunk;if(!buffer.endsWith('\n'))return;socket.removeAllListeners('data');try{const v=JSON.parse(buffer);assert.equal(v.nonce,nonce);assert.ok(['host','main','tool'].includes(v.role));const key=v.generation+':'+v.role;assert.ok(!peers.has(key));const handle=capturePeerProcess(socket);peers.set(key,handle);console.log(JSON.stringify({receipt:'peer',key,identity:handle.identity}));socket.end('+');}catch(e){observerError=e;socket.destroy();}});});
observer.listen('\0'+observerName);await once(observer,'listening');
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(f:()=>boolean,label:string,ms=180000){const end=Date.now()+ms;while(!f()){if(observerError)throw observerError;if(Date.now()>end)throw Error(label);await wait(50);}}
let checks=0;const check=(name:string,value:unknown)=>{assert.ok(value,name);checks++;console.log('  ✓ '+name);};
console.log(JSON.stringify({receipt:'roots',mode,root,workspace,owner:{pid:process.pid,birth:processStartToken(process.pid)}}));
const space='cold-'+randomUUID().slice(0,8),auth=await createSpaceAuth(space);
saveSpaceAuth(authDir(workspace),auth);
const broker=await bootBroker(auth);console.log(JSON.stringify({receipt:'broker',pid:broker.pid,birth:processStartToken(broker.pid),servers:broker.servers}));
let delivery:Awaited<ReturnType<typeof bootDeliveryDaemon>>|undefined,nc:Awaited<ReturnType<typeof connect>>|undefined;
let result:Record<string,unknown>={mode};
async function startHost(index:number){
 const home=join(root,'home',String(index));mkdirSync(home,{mode:0o700});
 const path=join(root,'host-'+index+'.json');writeFileSync(path,JSON.stringify({workspace,custody:join(root,'ctl'),space,servers:broker.servers,observer:observerName,nonce,index}),{mode:0o600});
 const child=fork(join(here,'namespace-cold-host.ts'),[],{cwd:repo,env:{PATH:'/usr/bin:/bin',HOME:home,COTAL_HOME:home,TMPDIR:join(root,'tmp'),COLD_CONFIG:path},stdio:['ignore','pipe','pipe','ipc']});
 const row={child,messages:[]as any[],index};hosts.push(row);child.on('message',v=>{row.messages.push(v);writeFileSync(join(root,'host-'+index+'-messages.json'),JSON.stringify(row.messages,null,2),{mode:0o600});});
 child.stdout?.on('data',b=>writeFileSync(join(root,'host-'+index+'.out'),b,{flag:'a',mode:0o600}));child.stderr?.on('data',b=>writeFileSync(join(root,'host-'+index+'.err'),b,{flag:'a',mode:0o600}));
 await until(()=>row.messages.some(v=>['ready','start-error'].includes(v.phase))||child.exitCode!==null||child.signalCode!==null,'host startup deadline');
 const terminal=row.messages.find(v=>['ready','start-error'].includes(v.phase));assert.ok(terminal,'host exited without startup report');return {row,terminal};
}
try{
 await setupSpaceStreams({servers:broker.servers,space,creds:await mintCreds(auth,newIdentity(),'provisioner')});
 delivery=await bootDeliveryDaemon({space,servers:broker.servers,auth,reloadStoreIdentity:workspaceSecretStore(workspace).identity});
 const runnerId=newIdentity(),caller:EpCaller={owner:'local',actor:runnerId.id,uid:mintLifecycleUid()};
 nc=await connect({servers:broker.servers,...standaloneConnectOpts({creds:await mintCreds(auth,runnerId,'control-caller-admin',{lifecycleUid:caller.uid}),tls:false}),maxReconnectAttempts:0});
 const call=(command:string,args:Record<string,unknown>,id:string,target?:{actor:string;lifecycleUid:string})=>epCall(nc!,space,{mode:'one'},{endpoint:MANAGER_ENDPOINT,command,contract:MANAGER_CONTRACTS[command],caller,id,args,...(target?{target:{mode:'owner'as const,owner:'local',...target}}:{})},{deadlineMs:20000,currentEpoch:async()=>0});
 const first=await startHost(1);check('initial actual manager started',first.terminal.phase==='ready');
 async function goalResult(host:typeof first,goalId:string,waitForResult:boolean){const before=host.row.messages.length;host.row.child.send({op:'goal-result',caller,goalId,wait:waitForResult});await until(()=>host.row.messages.slice(before).some(v=>v.phase==='goal-result'||v.phase==='operation-error'),'native goal result response',30000);const reply=host.row.messages.slice(before).find(v=>v.phase==='goal-result'||v.phase==='operation-error');assert.equal(reply.phase,'goal-result',JSON.stringify(reply));return reply.result;}

 const spawned=await call('spawn',{name:'seat',agent:'namespace-cold-stub',cwd:repo,events:false,supervise:{restarts:1,windowMs:120000}},'cold-spawn'.padEnd(43,'s'));check('actual manager admitted inert supervised fixture',(spawned.reply as any).ok===true);
 await until(()=>peers.has('1.1:main')&&peers.has('1.1:tool'),'predecessor actor handles',20000);
 let readiness;
 if(mode==='steady'){readiness=await goalResult(first,'cold-spawn'.padEnd(43,'s'),true);check('native spawn readiness succeeded durably before owner crash',readiness?.state==='succeeded');}

 first.row.child.send({op:'inspect'});
 await until(()=>first.row.messages.some(v=>v.phase==='inspection'),'initial native inspection',10000);
 const initial=first.row.messages.find(v=>v.phase==='inspection');const agent=initial.agents.find((a:any)=>a.name==='seat');assert.ok(agent?.reference);
 check('native slot recorded exact launch custody',initial.slot.runtime?.id===agent.reference.id);
 const turn=await call('turn',{payload:'cold-owner-payload',deadlineMs:120000},'cold-turn'.padEnd(43,'t'),{actor:agent.id,lifecycleUid:agent.lifecycleUid});check('actual manager accepted the pending turn',(turn.reply as any).ok===true);
 const recordPath=join(root,'ctl',agent.reference.id,'record.json');const before=JSON.parse(readFileSync(recordPath,'utf8'));check('pre-crash namespace record is live',before.closed===false);
 writeFileSync(join(workspace,'crash'),'crash\n');const exit=once(first.row.child,'exit');peers.get('1:host')!.signal('SIGKILL');await exit;
 check('the original manager process exited',peers.get('1:host')!.hasExited());
 await Promise.all(['1.1:main','1.1:tool'].map(k=>peers.get(k)!.waitForExit({signal:AbortSignal.timeout(10000)})));
 const after=JSON.parse(readFileSync(recordPath,'utf8'));result={mode,initial,readiness,recordBefore:before,recordAfterOwnerDeath:after};
 check('predecessor main and detached tool closed after owner death',peers.get('1.1:main')!.hasExited()&&peers.get('1.1:tool')!.hasExited());
 const second=await startHost(2);result.successor=second.terminal;
 check('successor uses the same logical manager identity',second.terminal.instanceId===first.terminal.instanceId);
 second.row.child.send({op:'inspect',actor:agent.id,uid:agent.lifecycleUid});
 await until(()=>second.row.messages.some(v=>v.phase==='inspection'||v.phase==='operation-error'),'cold inspection',15000);
 result.successorInspection=second.row.messages.find(v=>v.phase==='inspection'||v.phase==='operation-error');
 if(second.terminal.phase==='ready')result.pendingTerminalResult=(await goalResult(second,'cold-turn'.padEnd(43,'t'),false))??null;
 await wait(1000);result.predecessorEffect=existsSync(join(workspace,'effect-1'));result.newActorKeys=[...peers.keys()].filter(k=>k.startsWith('2.'));result.checks=checks;
 writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({receipt:'cold-result',result}));
 check('old detached tool made no delayed effect',!result.predecessorEffect);
 console.log(`COLD NAMESPACE OBSERVATION (${checks} controls; outcome in result.json)`);
}catch(e){result.error=String(e);writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2),{mode:0o600});throw e;}
finally{
 for(const h of hosts){if(h.child.exitCode===null&&h.child.signalCode===null){if(h.child.connected)h.child.send({op:'stop'});await Promise.race([once(h.child,'exit'),wait(6000)]);if(h.child.exitCode===null&&h.child.signalCode===null){const peer=peers.get(h.index+':host');if(peer&&!peer.hasExited())peer.signal('SIGKILL');else h.child.kill('SIGKILL');await once(h.child,'exit');}}}
 for(const peer of peers.values()){if(!peer.hasExited())peer.signal('SIGKILL');await peer.waitForExit({signal:AbortSignal.timeout(5000)});peer.close();}
 await nc?.drain();await delivery?.stop();await broker.stop();await new Promise<void>(r=>observer.close(()=>r()));if(beforeTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=beforeTmp;
}
