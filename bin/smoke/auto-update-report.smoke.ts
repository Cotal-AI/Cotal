import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serveDaemon } from "../daemon/server.js";
import { daemonPaths } from "../daemon/endpoint.js";
const root=mkdtempSync(join(tmpdir(),"autoupd-report-"));const home=join(root,"home"),runtime=join(root,"run");mkdirSync(home);mkdirSync(runtime,{mode:0o700});mkdirSync(join(root,".cotal"));
const env:NodeJS.ProcessEnv={...process.env,HOME:home,COTAL_HOME:home,XDG_CONFIG_HOME:join(root,"config"),XDG_RUNTIME_DIR:runtime,npm_config_prefix:join(root,"prefix"),npm_config_cache:join(root,"cache"),COTAL_SKIP_CONNECTOR_SEED:"1",COTAL_NO_UPDATE_CHECK:"1"};
const paths=daemonPaths(env,home);
const update={current:"1.0.0",latest:"2.0.0",lastCheck:new Date().toISOString(),lastResult:"waiting for idle Managers",nextAttempt:new Date(Date.now()+60000).toISOString(),automatic:true,failures:1};
const daemon=await serveDaemon({paths,version:"1.0.0",sessionDir:home,updateStatus:()=>update});
async function cli(args:string[]){const child=spawn(process.execPath,[fileURLToPath(new URL("../dist/cotal.js",import.meta.url)),"daemon","status",...args],{cwd:root,env,stdio:["ignore","pipe","pipe"]});let out="",err="";child.stdout.on("data",c=>out+=c);child.stderr.on("data",c=>err+=c);const code=await new Promise(r=>child.once("exit",r));assert.equal(code,0,err+out);return out;}
try{
 const json=JSON.parse(await cli(["--json"]));assert.deepEqual(json.result.update,{...update,restartEvidence:{prepared:false,managers:[]}});
 const human=await cli(["--plain"]);for(const text of ["Updates","Latest seen","2.0.0","waiting for idle Managers","Automatic updates"])assert.ok(human.includes(text),human);
 emitSentinel({ passed: counted.cells(), failed: 0 });
}finally{await daemon.close();}
