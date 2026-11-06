import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_OWNER, readGoalResult, registry, type Runtime, type Connector, type EpCaller } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import { readStaticSlot } from "../src/static-lifecycle.js";
import { NamespacePtyRuntime } from "../dist/runtime/namespace-pty.js";

const cfg=JSON.parse(readFileSync(process.env.COLD_CONFIG!,"utf8"));
const peer=createConnection("\0"+cfg.observer);
await new Promise<void>((resolve,reject)=>{peer.once("error",reject);peer.once("connect",()=>peer.write(JSON.stringify({role:"host",generation:String(cfg.index),nonce:cfg.nonce})+"\n"));peer.once("data",()=>{peer.destroy();resolve();});});
const stub=join(dirname(fileURLToPath(import.meta.url)),"fixtures/namespace-cold-agent.mjs");
let launches=0;
const connector:Connector={kind:"connector",name:"namespace-cold-stub",requires:["node"],buildLaunch:o=>({command:process.execPath,args:[stub],env:{PATH:"/usr/bin:/bin",COTAL_SPACE:o.space,COTAL_SERVERS:String(o.servers),COTAL_CREDS:String(o.creds),COTAL_ID:String(o.id),COTAL_NAME:o.name,COTAL_LIFECYCLE_UID:String(o.lifecycleUid),COTAL_NAMESPACE_OBSERVER:cfg.observer,COTAL_NAMESPACE_NONCE:cfg.nonce,COTAL_NAMESPACE_GENERATION:`${cfg.index}.${++launches}`,COTAL_NAMESPACE_CRASH:join(cfg.workspace,"crash"),COTAL_NAMESPACE_EFFECT:join(cfg.workspace,`effect-${cfg.index}`)}})};
registry.register(connector);
const runtime=new NamespacePtyRuntime(cfg.custody,{bwrap:"/usr/bin/bwrap",unshare:"/usr/bin/unshare"});
const spawn=runtime.spawn.bind(runtime);
// Test-only admission of one inert native connector; the candidate remains unregistered/off.
Object.assign(runtime,{supportsWorkClosure:true,spawn(...args:Parameters<typeof spawn>){if(args[1].command!==process.execPath||args[1].args[0]!==stub)throw Error("cold fixture rejects other connectors");return spawn(...args);}});
const manager=new Manager({space:cfg.space,servers:cfg.servers,runtime:"pty",workspaceRoot:cfg.workspace,consolePort:0});
(manager as unknown as {runtime:Runtime}).runtime=runtime;
const state=()=>{const m=manager as unknown as {managerInstanceId:string;agents:Map<string,{id:string;lifecycleUid:string;handle:{reference?:unknown}}> ;retiring:Map<string,{lastError?:string}>};return {instanceId:m.managerInstanceId,agents:[...m.agents].map(([name,a])=>({name,id:a.id,lifecycleUid:a.lifecycleUid,reference:a.handle.reference})),retiring:[...m.retiring].map(([name,a])=>({name,lastError:a.lastError})),launches};};
try{await manager.start();process.send?.({phase:"ready",...state()});}catch(e){process.send?.({phase:"start-error",error:String(e),...state()});}
process.on("message",async(message:unknown)=>{
 const m=message as {op:string;actor?:string;uid?:string;goalId?:string;caller?:EpCaller;wait?:boolean};
 try{
  if(m.op==="goal-result"){
   const ctx=(manager as unknown as {goalWriter:{ctx:Parameters<typeof readGoalResult>[0]}}).goalWriter.ctx;
   const end=Date.now()+25000;
   let result;
   for(;;){result=await readGoalResult(ctx,{endpoint:"manager",caller:m.caller!,goalId:m.goalId!});if(result||!m.wait)break;if(Date.now()>end)throw Error("native readiness result deadline");await new Promise(r=>setTimeout(r,100));}
   process.send?.({phase:"goal-result",goalId:m.goalId,result});
  }else if(m.op==="inspect"){
   const read=(manager as unknown as {withLifecycleExecutor<T>(pin:unknown,work:(t:Parameters<typeof readStaticSlot>[0])=>Promise<T>):Promise<T>}).withLifecycleExecutor.bind(manager);
   const current=state().agents.find(a=>a.name==="seat");
   const slot=await read({owner:DEV_OWNER,actor:m.actor??current?.id,lifecycleUid:m.uid??current?.lifecycleUid,alias:"seat"},t=>readStaticSlot(t,DEV_OWNER,"seat")) as Awaited<ReturnType<typeof readStaticSlot>>;
   process.send?.({phase:"inspection",...state(),slot:slot?.row});
  }else if(m.op==="stop"){
   await manager.stop({withAgents:true});process.send?.({phase:"stopped",...state()});process.disconnect?.();process.exit(0);
  }
 }catch(e){process.send?.({phase:"operation-error",op:m.op,error:String(e),...state()});if(m.op==="stop"){process.disconnect?.();process.exit(1);}}
});
