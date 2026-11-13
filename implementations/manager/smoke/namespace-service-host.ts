import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_OWNER, readGoalResult, registry, type Runtime, type Connector, type EpCaller } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import { readStaticSlot } from "../src/static-lifecycle.js";
import { NamespacePtyRuntime } from "../dist/runtime/namespace-pty.js";
import { SystemdNamespaceCustody, parseSystemdJson, type NativeServicePin } from "../dist/runtime/systemd-custody.js";

const cfg=JSON.parse(readFileSync(process.env.NATIVE_CONFIG!,"utf8"));
const counter=join(cfg.root,"generation.json");
cfg.index=existsSync(counter)?JSON.parse(readFileSync(counter,"utf8"))+1:1;
assert.ok(cfg.index<=2);writeFileSync(counter,JSON.stringify(cfg.index),{mode:0o600});
const peer=createConnection("\0"+cfg.control), lines=createInterface({input:peer});
await once(peer,"connect");
const configured=once(lines,"line");
peer.write(JSON.stringify({phase:"hello",index:cfg.index,nonce:cfg.nonce})+"\n");
const [line]=await configured;const configure=JSON.parse(line);assert.equal(configure.op,"configure");
const pin=configure.pin as NativeServicePin;
assert.deepEqual(parseSystemdJson('{"values":[9007199254740993,18446744073709551615]}'),{values:["9007199254740993","18446744073709551615"]});
await assert.rejects(SystemdNamespaceCustody.open({...pin,sha256:"0".repeat(64)}),/source no longer matches/);
const storage=await SystemdNamespaceCustody.open(pin);
if(cfg.mode==="late"){
 const retain=storage.retain.bind(storage);
 storage.retain=async(...args:Parameters<typeof retain>)=>{await retain(...args);await new Promise(r=>setTimeout(r,6500));};
}
const report=(value:unknown)=>peer.write(JSON.stringify(value)+"\n");
report({phase:"pin-controls",index:cfg.index,checks:3});
const stub=join(dirname(fileURLToPath(import.meta.url)),"fixtures/namespace-service-agent.mjs");
let launches=0;
const connector:Connector={kind:"connector",name:"namespace-cold-stub",requires:["node"],buildLaunch:o=>({command:process.execPath,args:[stub],env:{PATH:"/usr/bin:/bin",COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_CREDS:String(o.creds),COTAL_ID:String(o.id),COTAL_NAME:o.name,COTAL_LIFECYCLE_UID:String(o.lifecycleUid),COTAL_ACCEPTED_TOKEN:String(o.acceptedToken),COTAL_SERVICE_TURN_PROOF:join(cfg.workspace,"turn-proof.json"),COTAL_NAMESPACE_OBSERVER:cfg.observer,COTAL_NAMESPACE_NONCE:cfg.nonce,COTAL_NAMESPACE_GENERATION:`${cfg.index}.${++launches}`,COTAL_NAMESPACE_CRASH:join(cfg.workspace,"crash"),COTAL_NAMESPACE_EFFECT:join(cfg.workspace,`effect-${cfg.index}`)}})};
registry.register(connector);
const runtime=new NamespacePtyRuntime(cfg.custody,{bwrap:"/usr/bin/bwrap",unshare:"/usr/bin/unshare"},storage);
const spawn=runtime.spawn.bind(runtime);
// Test-only admission of one inert native connector; the candidate remains unregistered/off.
Object.assign(runtime,{supportsWorkClosure:true,spawn(...args:Parameters<typeof spawn>){if(args[1].command!==process.execPath||args[1].args[0]!==stub)throw Error("cold fixture rejects other connectors");return spawn(...args);}});
const manager=new Manager({space:cfg.space,servers:cfg.servers,runtime:"pty",workspaceRoot:cfg.workspace,consolePort:0});
(manager as unknown as {runtime:Runtime}).runtime=runtime;
const state=()=>{const m=manager as unknown as {managerInstanceId:string;agents:Map<string,{id:string;lifecycleUid:string;handle:{reference?:unknown}}> ;retiring:Map<string,{lastError?:string}>};return {instanceId:m.managerInstanceId,agents:[...m.agents].map(([name,a])=>({name,id:a.id,lifecycleUid:a.lifecycleUid,reference:a.handle.reference})),retiring:[...m.retiring].map(([name,a])=>({name,lastError:a.lastError})),launches};};
try{await manager.start();report({phase:"ready",...state()});}catch(e){report({phase:"start-error",error:String(e),...state()});}
lines.on("line",async(text:string)=>{
 const message:unknown=JSON.parse(text);
 const m=message as {op:string;actor?:string;uid?:string;goalId?:string;caller?:EpCaller;wait?:boolean};
 try{
  if(m.op==="goal-result"){
   const ctx=(manager as unknown as {goalWriter:{ctx:Parameters<typeof readGoalResult>[0]}}).goalWriter.ctx;
   const end=Date.now()+25000;
   let result;
   for(;;){result=await readGoalResult(ctx,{endpoint:"manager",caller:m.caller!,goalId:m.goalId!});if(result||!m.wait)break;if(Date.now()>end)throw Error("native readiness result deadline");await new Promise(r=>setTimeout(r,100));}
   report({phase:"goal-result",goalId:m.goalId,result});
  }else if(m.op==="inspect"){
   const read=(manager as unknown as {withLifecycleExecutor<T>(pin:unknown,work:(t:Parameters<typeof readStaticSlot>[0])=>Promise<T>):Promise<T>}).withLifecycleExecutor.bind(manager);
   const current=state().agents.find(a=>a.name==="seat");
   const slot=await read({owner:DEV_OWNER,actor:m.actor??current?.id,lifecycleUid:m.uid??current?.lifecycleUid,alias:"seat"},t=>readStaticSlot(t,DEV_OWNER,"seat")) as Awaited<ReturnType<typeof readStaticSlot>>;
   report({phase:"inspection",...state(),slot:slot?.row});
  }else if(m.op==="drop-custody"){
   const agent=state().agents.find(a=>a.name==="seat");
   const ref=agent?.reference as {id?:string}|undefined;
   assert.ok(ref?.id&&/^[a-f0-9]{32}$/.test(ref.id));
   const record=JSON.parse(readFileSync(join(cfg.custody,ref.id,"record.json"),"utf8"));
   assert.equal(record.closed,false);assert.equal(record.storage.name,"cotal-ns-"+ref.id);
   await storage.release(record.storage,record.identity);
   report({phase:"storage-dropped",reference:ref.id});
  }else if(m.op==="stop"){
   await manager.stop({withAgents:true});report({phase:"stopped",...state()});peer.end();process.exit(0);
  }
 }catch(e){report({phase:"operation-error",op:m.op,error:String(e),...state()});if(m.op==="stop"){peer.end();process.exit(1);}}
});
