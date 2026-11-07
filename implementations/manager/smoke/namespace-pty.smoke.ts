import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capturePeerProcess, type LinuxProcessHandle } from "@cotal-ai/seat";
import { NamespacePtyRuntime } from "../dist/runtime/namespace-pty.js";
import type { AgentHandle, Runtime } from "@cotal-ai/core";

let checks=0;
const c=(name:string, value:unknown)=>{assert.ok(value,name);checks++;console.log(`  ✓ ${name}`);};
const until=async(f:()=>boolean,name:string)=>{const end=Date.now()+8000;while(!f()){if(Date.now()>end)throw new Error(name);await new Promise(r=>setTimeout(r,10));}};
const bounded=async<T>(p:Promise<T>):Promise<T>=>{let t:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,reject)=>{t=setTimeout(()=>reject(new Error("namespace test deadline")),10000);})]);}finally{clearTimeout(t);}};
const root=mkdtempSync(join(tmpdir(),"nspty-"));
console.log(JSON.stringify({receipt:"fixture-root",root}));
try{
 for(const mode of ["finished","terminal","stop","main-crash","missing-exec"]){
  const cell=join(root,mode);mkdirSync(cell,{mode:0o700});const app=join(cell,"app");mkdirSync(app,{mode:0o700});
  const runtime=new NamespacePtyRuntime(join(cell,"ctl"),{bwrap:"/usr/bin/bwrap",unshare:"/usr/bin/unshare"});
  c(mode+": automatic policy remains disabled",(runtime as Runtime).supportsWorkClosure!==true);
  const ref=runtime.reserve();
  copyFileSync(fileURLToPath(new URL("./fixtures/namespace-actor.mjs",import.meta.url)),join(app,"actor.mjs"));
  const peers=new Map<string,LinuxProcessHandle>();let peerError:Error|undefined;const server=createServer(socket=>{let text="";socket.on("error",e=>{peerError=e;});socket.on("data",chunk=>{text+=chunk;if(!text.endsWith("\n"))return;socket.removeAllListeners("data");try{const role=text.trim();assert.ok(["main","tool"].includes(role));assert.ok(!peers.has(role));const peer=capturePeerProcess(socket);peers.set(role,peer);console.log(JSON.stringify({receipt:"actor",mode,role,identity:peer.identity}));socket.end("+");}catch(e){peerError=e as Error;socket.destroy();}});});
  server.listen(join(app,"actors.sock"));await once(server,"listening");
  let handle:AgentHandle|undefined;let text="";
  try{
   handle=runtime.spawn(mode,{command:mode==="missing-exec"?"/no-such-namespace-command":process.execPath,args:[join(app,"actor.mjs"),"main",app],env:{PATH:"/usr/bin:/bin",HOME:app}},app,ref);
   handle.attach().onData(b=>text+=b.toString());
   c(mode+": reserved reference preserved",handle.reference?.id===ref.id);
   if(mode!=="missing-exec"){
    await until(()=>peers.size===2&&text.includes("READY")||!!peerError,"actors never ready: "+text);if(peerError)throw peerError;
    const record=JSON.parse(readFileSync(join(cell,"ctl",ref.id,"record.json"),"utf8"));
    c(mode+": live journal precedes application",record.closed===false&&record.identity.namespace===peers.get("main")!.identity.namespace);
    c(mode+": detached tool is inside same namespace",peers.get("tool")!.identity.namespace===record.identity.namespace);
    if(mode==="finished")writeFileSync(join(app,"finish"),"finish");
    else if(mode==="terminal"){
     handle.attach().resize(91,23);await handle.write!("control\n");await until(()=>text.includes("ACK=control")&&text.includes("SIZE=91x23"),"terminal controls: "+text);handle.interrupt();
    }else if(mode==="stop")handle.stop({graceful:false});
    else {
     // Crash the application through its independently captured kernel handle.
     // Descendant closure is still graded by the separately captured namespace and actor handles.
     peers.get("main")!.signal("SIGKILL");
    }
   }
   await bounded(handle.waitForExit!());await bounded(handle.waitForWorkExit!());
   c(mode+": namespace exit observed and journaled",JSON.parse(readFileSync(join(cell,"ctl",ref.id,"record.json"),"utf8")).closed===true);
   for(const [role,peer]of peers)c(mode+": "+role+" exited",peer.hasExited());
   await runtime.reapWork(ref);c(mode+": completed durable closure is reusable",true);
   if(mode==="finished")c("finished effects preserved",existsSync(join(app,"main.effect"))&&existsSync(join(app,"tool.effect")));
   else c(mode+": no unfinished effect",!existsSync(join(app,"main.effect"))&&!existsSync(join(app,"tool.effect")));
   if(mode==="terminal")c("Ctrl-C reached application",text.includes("INT"));
  }catch(error){console.error(JSON.stringify({mode,output:text,error:String(error)}));throw error;}
  finally{
   if(handle){handle.stop({graceful:false});await bounded(handle.waitForExit!());try{await bounded(handle.waitForWorkExit!());}catch{}}
   for(const peer of peers.values()){if(!peer.hasExited())peer.signal("SIGKILL");await bounded(peer.waitForExit());peer.close();}
   await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
 }
 const invalidRoot=join(root,"invalid-record");
 const invalidRuntime=new NamespacePtyRuntime(invalidRoot,{bwrap:"/usr/bin/bwrap",unshare:"/usr/bin/unshare"});
 const invalidRef=invalidRuntime.reserve();
 writeFileSync(join(invalidRoot,invalidRef.id,"record.json"),JSON.stringify({version:1,closed:true,identity:{}}),{mode:0o600});
 await assert.rejects(invalidRuntime.reapWork(invalidRef),/invalid namespace closure record/);
 c("malformed closed identity refuses before accepting proof",true);
 c("namespace suite emitted every declared check",checks===43);
 console.log(`NAMESPACE PTY (${checks} checks)`);
}finally{if(process.env.COTAL_SMOKE_RETAIN!=="1")rmSync(root,{recursive:true,force:true});}
