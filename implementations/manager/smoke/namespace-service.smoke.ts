/** Actual Manager crash through the optional pinned native service custody path. */
import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import { createSpaceAuth, mintCreds, mintLifecycleUid, newIdentity, standaloneConnectOpts, setupSpaceStreams, epCall, type EpCaller } from "@cotal-ai/core";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { capturePeerProcess, processStartToken, type LinuxProcessHandle } from "@cotal-ai/seat";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS } from "../src/manager-service-contract.js";
const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,"../../..");
const mode=process.env.COTAL_SERVICE_CASE??"recover";assert.ok(["recover","late","missing"].includes(mode));
const root=mkdtempSync('/var/tmp/nssvc-'),workspace=mkdtempSync(join(repo,'.namespace-service-'));
for(const p of ['home','tmp','ctl'])mkdirSync(join(root,p),{mode:0o700});
mkdirSync(join(workspace,'.cotal','agents'),{recursive:true});writeFileSync(join(workspace,'.cotal','agents','seat.md'),'---\nname: seat\n---\n');
const previousTmp=process.env.TMPDIR;process.env.TMPDIR=join(root,'tmp');
const unit='cotal-ns-'+randomUUID().replaceAll('-','')+'.service',nonce=randomUUID(),observerName='cotal-svc-observe-'+randomUUID(),controlName='cotal-svc-control-'+randomUUID();
const peers=new Map<string,LinuxProcessHandle>(),hosts=new Map<number,{socket:Socket;messages:any[]}>();let fault:unknown,pin:unknown;
const run=promisify(execFile),busenv={PATH:'/usr/bin:/bin',XDG_RUNTIME_DIR:`/run/user/${process.getuid!()}`,DBUS_SESSION_BUS_ADDRESS:`unix:path=/run/user/${process.getuid!()}/bus`};
const recordPeer=(key:string,socket:Socket)=>{assert.ok(!peers.has(key));const handle=capturePeerProcess(socket);peers.set(key,handle);console.log(JSON.stringify({receipt:'peer',key,identity:handle.identity}));};
const observer=createServer(socket=>{let text='';socket.on('error',e=>fault=e);socket.on('data',b=>{text+=b;if(!text.endsWith('\n'))return;socket.removeAllListeners('data');try{const v=JSON.parse(text);assert.equal(v.nonce,nonce);assert.ok(['main','tool'].includes(v.role));if(v.generation.startsWith('2.')&&v.role==='main')check('old main and tool exited before successor observation',peers.get('1.1:main')?.hasExited()&&peers.get('1.1:tool')?.hasExited());recordPeer(v.generation+':'+v.role,socket);socket.end('+');}catch(e){fault=e;socket.destroy();}});});
const control=createServer(socket=>{let text='';let row:{socket:Socket;messages:any[]}|undefined;let index:number;
 socket.on('error',e=>fault=e);socket.on('data',b=>{text+=b;for(;;){const at=text.indexOf('\n');if(at<0)break;const line=text.slice(0,at);text=text.slice(at+1);try{const v=JSON.parse(line);if(!row){assert.equal(v.phase,'hello');assert.equal(v.nonce,nonce);index=v.index;assert.ok(index===1||index===2);assert.ok(!hosts.has(index));recordPeer(index+':host',socket);row={socket,messages:[]};hosts.set(index,row);
 void (async()=>{const {stdout}=await run('/usr/bin/systemctl',['--user','show',unit,'--property=FragmentPath','--value'],{env:busenv,timeout:5000});const path=stdout.trim(),bytes=readFileSync(path);const found={unit,path,sha256:createHash('sha256').update(bytes).digest('hex')};if(pin)assert.deepEqual(found,pin);else{pin=found;writeFileSync(join(root,'unit-source'),bytes,{mode:0o600});writeFileSync(join(root,'pin.json'),JSON.stringify(pin),{mode:0o600});}socket.write(JSON.stringify({op:'configure',pin})+'\n');})().catch(e=>fault=e);
 }else{row.messages.push(v);writeFileSync(join(root,'host-'+index+'-messages.json'),JSON.stringify(row.messages,null,2),{mode:0o600});}}catch(e){fault=e;socket.destroy();}}});});
observer.listen('\0'+observerName);control.listen('\0'+controlName);await Promise.all([once(observer,'listening'),once(control,'listening')]);
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));async function until(test:()=>boolean,label:string,ms=90000){const end=Date.now()+ms;while(!test()){if(fault)throw fault;if(Date.now()>end)throw Error(label);await wait(50);}}
let checks=0;const check=(name:string,value:unknown)=>{assert.ok(value,name);checks++;console.log('  ✓ '+name);};
console.log(JSON.stringify({receipt:'roots',root,workspace,unit,mode,owner:{pid:process.pid,birth:processStartToken(process.pid)}}));
const space='svc-'+randomUUID().slice(0,8),auth=await createSpaceAuth(space);saveSpaceAuth(authDir(workspace),auth);const broker=await bootBroker(auth);
console.log(JSON.stringify({receipt:'broker',pid:broker.pid,birth:processStartToken(broker.pid),servers:broker.servers}));
let delivery:Awaited<ReturnType<typeof bootDeliveryDaemon>>|undefined,nc:Awaited<ReturnType<typeof connect>>|undefined,unitRunner:ChildProcess|undefined;
let result:Record<string,any>={mode};
async function host(index:number){await until(()=>hosts.get(index)?.messages.some(v=>['ready','start-error'].includes(v.phase))??false,'native host startup');const row=hosts.get(index)!;return {row,terminal:row.messages.find(v=>['ready','start-error'].includes(v.phase))};}
async function request(index:number,message:unknown,phase:string){const row=hosts.get(index)!;const start=row.messages.length;row.socket.write(JSON.stringify(message)+'\n');await until(()=>row.messages.slice(start).some(v=>v.phase===phase||v.phase==='operation-error'),'native control response',35000);const reply=row.messages.slice(start).find(v=>v.phase===phase||v.phase==='operation-error');assert.equal(reply.phase,phase,JSON.stringify(reply));return reply;}
try{
 await setupSpaceStreams({servers:broker.servers,space,creds:await mintCreds(auth,newIdentity(),'provisioner')});delivery=await bootDeliveryDaemon({space,servers:broker.servers,auth,reloadStoreIdentity:workspaceSecretStore(workspace).identity});
 const identity=newIdentity(),caller:EpCaller={owner:'local',actor:identity.id,uid:mintLifecycleUid()};nc=await connect({servers:broker.servers,...standaloneConnectOpts({creds:await mintCreds(auth,identity,'control-caller-admin',{lifecycleUid:caller.uid}),tls:false}),maxReconnectAttempts:0});
 const call=(command:string,args:Record<string,unknown>,id:string,target?:{actor:string;lifecycleUid:string})=>epCall(nc!,space,{mode:'one'},{endpoint:MANAGER_ENDPOINT,command,contract:MANAGER_CONTRACTS[command],caller,id,args,...(target?{target:{mode:'owner'as const,owner:'local',...target}}:{})},{deadlineMs:20000,currentEpoch:async()=>0});
 const cfg=join(root,'config.json');writeFileSync(cfg,JSON.stringify({root,workspace,custody:join(root,'ctl'),space,servers:broker.servers,observer:observerName,control:controlName,nonce,mode}),{mode:0o600});
 const launch=join(root,'launch.sh');writeFileSync(launch,'#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME="$1" COTAL_HOME="$1" TMPDIR="$2" NATIVE_CONFIG="$3" NOTIFY_SOCKET="${NOTIFY_SOCKET-}" LISTEN_PID="${LISTEN_PID-0}" LISTEN_FDS="${LISTEN_FDS-0}" LISTEN_FDNAMES="${LISTEN_FDNAMES-}" /usr/bin/node --import "$4" "$5"\n',{mode:0o600});
 unitRunner=spawn('/usr/bin/systemd-run',['--user','--wait','--pipe','--collect','--unit',unit,'--property=Type=exec','--property=NotifyAccess=main',`--property=Restart=${mode!=='late'?'on-failure':'no'}`,'--property=RestartSec=200ms','--property=StartLimitBurst=2','--property=StartLimitIntervalSec=180s','--property=RuntimeMaxSec=150s','--property=TimeoutStopSec=5s','--property=FileDescriptorStoreMax=8','--property=FileDescriptorStorePreserve=restart',`--property=WorkingDirectory=${repo}`,'/bin/sh',launch,join(root,'home'),join(root,'tmp'),cfg,join(repo,'node_modules/tsx/dist/loader.mjs'),join(here,'namespace-service-host.ts')],{env:busenv,stdio:['ignore','pipe','pipe']});
 console.log(JSON.stringify({receipt:'unit-runner',pid:unitRunner.pid,birth:processStartToken(unitRunner.pid!)}));unitRunner.stdout!.on('data',b=>writeFileSync(join(root,'unit.out'),b,{flag:'a',mode:0o600}));unitRunner.stderr!.on('data',b=>writeFileSync(join(root,'unit.err'),b,{flag:'a',mode:0o600}));
 const first=await host(1);check('actual service Manager starts',first.terminal.phase==='ready');
 const spawned=await call('spawn',{name:'seat',agent:'namespace-cold-stub',cwd:repo,events:false,supervise:{restarts:1,windowMs:120000}},'service-spawn'.padEnd(43,'s'));check('native spawn accepted',(spawned.reply as any).ok===true);
 const readiness=(await request(1,{op:'goal-result',caller,goalId:'service-spawn'.padEnd(43,'s'),wait:true},'goal-result')).result;result.readiness=readiness;
 if(mode==='late'){
  await until(()=>readdirSync(join(root,'ctl')).some(id=>existsSync(join(root,'ctl',id,'record.json'))),'late journal');
  const id=readdirSync(join(root,'ctl')).find(id=>existsSync(join(root,'ctl',id,'record.json')))!;const record=join(root,'ctl',id,'record.json');await until(()=>JSON.parse(readFileSync(record,'utf8')).closed===true,'late storage cleanup',20000);
  result.record=JSON.parse(readFileSync(record,'utf8'));check('late acknowledgment does not execute connector',![...peers.keys()].some(k=>k.endsWith(':main')||k.endsWith(':tool')));check('late namespace closure journaled',result.record.closed===true);check('native readiness did not succeed',readiness?.state!=='succeeded');
 }else{
  check('native readiness succeeded',readiness?.state==='succeeded');await until(()=>peers.has('1.1:main')&&peers.has('1.1:tool'),'old actor handles');
  const initial=await request(1,{op:'inspect'},'inspection'),agent=initial.agents.find((v:any)=>v.name==='seat');assert.ok(agent?.reference);result.initial=initial;
  const path=join(root,'ctl',agent.reference.id,'record.json');result.recordBefore=JSON.parse(readFileSync(path,'utf8'));check('native slot binds retained version2 receipt',result.recordBefore.version===2&&initial.slot.runtime.id===agent.reference.id&&result.recordBefore.storage.name==='cotal-ns-'+agent.reference.id);
  const turn=await call('turn',{payload:'service-cold-payload',deadlineMs:120000},'service-turn'.padEnd(43,'t'),{actor:agent.id,lifecycleUid:agent.lifecycleUid});check('actual pending turn accepted',(turn.reply as any).ok===true);
  if(mode==='missing'){await request(1,{op:'drop-custody'},'storage-dropped');check('store loss occurs while original actor is live',!peers.get('1.1:main')!.hasExited());}
  writeFileSync(join(workspace,'crash'),'crash\n');peers.get('1:host')!.signal('SIGKILL');await peers.get('1:host')!.waitForExit({signal:AbortSignal.timeout(10000)});
  await Promise.all(['1.1:main','1.1:tool'].map(k=>peers.get(k)!.waitForExit({signal:AbortSignal.timeout(15000)})));check('predecessor main and tool closed',peers.get('1.1:main')!.hasExited()&&peers.get('1.1:tool')!.hasExited());
  const second=await host(2);result.successor=second.terminal;check('same logical Manager identity restored',second.terminal.instanceId===first.terminal.instanceId);
  result.successorInspection=await request(2,{op:'inspect',actor:agent.id,uid:agent.lifecycleUid},'inspection');result.recordAfter=JSON.parse(readFileSync(path,'utf8'));
  if(mode==='missing'){
   check('missing retained handle refuses replacement',result.successorInspection.agents.length===0&&result.successorInspection.launches===0&&result.successorInspection.slot?.phase==='terminalizing');
   check('missing handle does not invent closure',result.recordAfter.closed===false);
   result.pendingTerminalResult=(await request(2,{op:'goal-result',caller,goalId:'service-turn'.padEnd(43,'t'),wait:false},'goal-result')).result??null;
  }else{
  await until(()=>existsSync(join(workspace,'turn-proof.json')),'replacement actor native turn completion',25000);
  result.turnProof=JSON.parse(readFileSync(join(workspace,'turn-proof.json'),'utf8'));
  check('replacement actor kept full identity and pulled exact payload',result.turnProof.actor===agent.id&&result.turnProof.uid===agent.lifecycleUid&&result.turnProof.payload==='service-cold-payload');
  check('turn proof belongs to actual replacement namespace',result.turnProof.namespace===peers.get('2.1:main')?.identity.namespace);
  result.pendingTerminalResult=(await request(2,{op:'goal-result',caller,goalId:'service-turn'.padEnd(43,'t'),wait:true},'goal-result')).result??null;
  check('native goal result confirms replacement yield',result.pendingTerminalResult?.state==='succeeded'&&result.turnProof.yieldState==='succeeded');
  check('retained predecessor closure durably proved',result.recordAfter.closed===true);
  }
  await wait(1000);result.predecessorEffect=existsSync(join(workspace,'effect-1'));check('old tool made no delayed effect',!result.predecessorEffect);
 }
 result.checks=checks;writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({receipt:'result',result}));console.log(`SERVICE NAMESPACE (${mode}: ${checks} controls)`);
}catch(e){result.error=String(e);writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2),{mode:0o600});throw e;}
finally{
 for(const [index,row] of hosts){const h=peers.get(index+':host');if(h&&!h.hasExited()&&!row.socket.destroyed){try{await request(index,{op:'stop'},'stopped');}catch{}}}
 await run('/usr/bin/systemctl',['--user','stop',unit],{env:busenv,timeout:10000}).catch(()=>undefined);
 for(const h of peers.values()){if(!h.hasExited())h.signal('SIGKILL');await h.waitForExit({signal:AbortSignal.timeout(5000)});h.close();}
 for(const row of hosts.values())row.socket.destroy();
 if(unitRunner&&unitRunner.exitCode===null&&unitRunner.signalCode===null)await Promise.race([once(unitRunner,'exit'),wait(5000)]);
 await nc?.drain();await delivery?.stop();await broker.stop();await Promise.all([new Promise<void>(r=>observer.close(()=>r())),new Promise<void>(r=>control.close(()=>r()))]);if(previousTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previousTmp;
}
