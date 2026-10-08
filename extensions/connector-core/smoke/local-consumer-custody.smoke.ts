import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { CotalEndpoint, createSpaceAuth, mintCreds, newIdentity, mintLifecycleUid, provisionAgentDurables, serverConfig, setupSpaceStreams, isReachable, acquireLock, localConsumerClaimPath, dmStream, dmDurable } from "@cotal-ai/core";
import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { SMOKE_BROKER_TOKEN, awaitBrokerReady, teardownOnSignal, freePort, emitSentinel } from "@cotal-ai/smoke-kit";
import { MeshAgent } from "../src/agent.js";
import { startControlServer } from "../src/control.js";
import type { AgentConfig } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const space = `custody-${randomUUID().slice(0,8)}`, port = await freePort(), servers = `nats://127.0.0.1:${port}`;
const auth = await createSpaceAuth(space);
writeFileSync(join(dir,"broker.conf"), serverConfig(auth,[auth],{host:"127.0.0.1",port,storeDir:join(dir,"js"),transport:{kind:"plaintext"}}));
const broker = spawn("nats-server",["-c",join(dir,"broker.conf")],{stdio:"ignore"});
const releaseBroker = teardownOnSignal(broker,dir);
const children: ChildProcess[] = []; const messages: Record<string, unknown>[] = []; let orphan: number | undefined;
let provisioner: CotalEndpoint | undefined, observer: CotalEndpoint | undefined, writer: CotalEndpoint | undefined;
let control: ReturnType<typeof startControlServer> | undefined, contender: ReturnType<typeof startControlServer> | undefined;
let passed = 0, failed = 0;
function check(name: string, ok: boolean) { assert.ok(ok,name); console.log(`✓ ${name}`); passed++; }
const delay = (ms:number) => new Promise(r=>setTimeout(r,ms));
async function until(f:()=>boolean) { for(let i=0;i<200;i++){if(f())return;await delay(25);}throw Error("bounded fixture wait expired"); }
async function stop(p:ChildProcess){if(p.exitCode!==null||p.signalCode!==null)return;p.kill("SIGTERM");await Promise.race([once(p,"exit"),delay(2000)]);if(p.exitCode===null&&p.signalCode===null){p.kill("SIGKILL");await once(p,"exit");}}
function worker(mode:string, file:string){const p=fork(new URL("./_local-custody-worker.ts",import.meta.url),[mode,file],{stdio:["ignore","ignore","ignore","ipc"]});p.on("message",(m:Record<string,unknown>)=>{messages.push({...m,pid:p.pid});if(typeof m.childPid==="number")orphan=m.childPid;});children.push(p);return p;}
try {
 await awaitBrokerReady(()=>isReachable(servers),{servers,attempts:50,delayMs:100});
 await setupSpaceStreams({space,servers,creds:await mintCreds(auth,newIdentity(),"provisioner")});
 let nc!: NatsConnection;
 provisioner=new CotalEndpoint({space,servers,onConnection:c=>{nc=c;},creds:await mintCreds(auth,newIdentity(),"provisioner"),consume:false,registerPresence:false,watchPresence:false,card:{name:"provisioner",kind:"endpoint"}});await provisioner.start();
 const identity=newIdentity(),uid=mintLifecycleUid(), actor=identity.id;
 const creds=await mintCreds(auth,identity,"agent",{lifecycleUid:uid});
 await provisionAgentDurables(provisioner,{owner:"local",actor,lifecycleUid:uid},{subscribe:[],allowSubscribe:[],durableMembership:false});
 const jsm=await jetstreamManager(nc);
 await jsm.consumers.update(dmStream(space),dmDurable("local",actor,uid),{ack_wait:100_000_000});
 const config:AgentConfig={space,servers,id:actor,creds,lifecycleUid:uid,name:"custody",subscribe:[],allowSubscribe:[],allowPublish:[],tls:false,kind:"agent"};
 const file=join(dir,"worker.json"),ready=join(dir,"ready");writeFileSync(file,JSON.stringify({config,ready}));
 const parent=worker("parent",file);await until(()=>existsSync(ready)&&orphan!==undefined);
 parent.kill("SIGKILL");await once(parent,"exit");
 const duplicate=worker("consumer",file);await until(()=>duplicate.exitCode!==null||messages.some(m=>m.ready===true&&m.pid===duplicate.pid));
 check("parent death does not free consuming child custody",duplicate.exitCode===1&&messages.some(m=>String(m.refused).includes("local inbox already")));
 observer=new CotalEndpoint({space,servers,creds,lifecycleUid:uid,consume:false,registerPresence:false,watchPresence:false,card:{id:actor,name:"helper",kind:"endpoint"}});await observer.start();check("nonconsuming helper remains usable",true);
 writer=new CotalEndpoint({space,servers,creds:await mintCreds(auth,newIdentity(),"agent",{lifecycleUid:mintLifecycleUid()}),consume:false,registerPresence:false,watchPresence:false,card:{name:"writer",kind:"endpoint"}});await writer.start();
 process.kill(orphan!,"SIGKILL");await until(()=>{try{return readFileSync(`/proc/${orphan}/stat`,"utf8").includes(") Z");}catch{return true;}});
 const pending=await writer.unicast(`local.${actor}`,"custody preserved backlog");
 const replacement=worker("consumer",file);await until(()=>messages.some(m=>m.ready===true&&m.pid===replacement.pid));
 check("dead consuming process permits recovery",replacement.exitCode===null);
 await until(()=>messages.some(m=>m.received===pending.id));check("crash recovery preserves and receives backlog ID",true);
 replacement.send({reconnect:true});await until(()=>messages.some(m=>m.reconnected===true));check("same consumer reconnect retains custody",true);
 const claimPath=localConsumerClaimPath(servers,space,"local",actor,uid);
 check("canonical custody ignores server order and credential text",claimPath===localConsumerClaimPath(`${servers},${servers}`,space,"local",actor,uid));
 const unknown=join(dir,"unknown.lock");writeFileSync(unknown,JSON.stringify({pid:process.pid,nonce:"unknown",ts:Date.now()}));
 assert.throws(()=>acquireLock(unknown,{waitMs:0}));check("live owner without start token is never reclaimed",true);
 const stale=join(dir,"stale.lock"),first=acquireLock(stale);rmSync(stale);const second=acquireLock(stale);first.release();check("stale release cannot remove successor claim",existsSync(stale));second.release();
 const dummy=new MeshAgent({...config,lifecycleUid:mintLifecycleUid()});const socket=join(dir,"control.sock");control=startControlServer(dummy,{path:socket,token:"first"},async()=>({}));await once(control,"listening");const before=readFileSync(claimPath,"utf8");
 contender=startControlServer(dummy,{path:socket,token:"second"},async()=>({}));let bindError: NodeJS.ErrnoException | undefined;contender.on("error",e=>{bindError=e;});await until(()=>bindError!==undefined||contender!.listening);check("second control listener cannot replace live owner",bindError?.code==="EADDRINUSE"&&control.listening&&readFileSync(claimPath,"utf8")===before);
 await stop(replacement);check("clean consumer stop releases its claim",!existsSync(claimPath));
} catch(error){failed++;console.error(error);}
finally {
 if(orphan)try{process.kill(orphan,"SIGKILL");}catch{}
 for(const p of children)await stop(p);
 if(control?.listening)await new Promise<void>(r=>control!.close(()=>r()));
 if(contender?.listening)await new Promise<void>(r=>contender!.close(()=>r()));
 await observer?.stop();await writer?.stop();await provisioner?.stop();await stop(broker);releaseBroker();
 rmSync(dir,{recursive:true,force:true});emitSentinel({passed,failed});
}
process.exitCode=failed?1:0;
