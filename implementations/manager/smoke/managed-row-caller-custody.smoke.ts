import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, registry, type AuthProvider, type Connector, type SecretStore } from "@cotal-ai/core";
import { userAuthStateDir } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";

const root=mkdtempSync(join(process.env.TMPDIR??tmpdir(),"task84-manager-host-refusal-"));
const agentsDir=join(root,".cotal","agents");
mkdirSync(agentsDir,{recursive:true});
writeFileSync(join(agentsDir,"fixture.md"),"---\nname: managed_actor\n---\n");

let provisionCalls=0,stageCalls=0,sendCalls=0,secretPuts=0,buildCalls=0;
const provider:Pick<AuthProvider,"kind"|"name"|"agentBearerCommand"|"grantAgent"|"revokeAgent"|"stageManagedRowCreate"|"sendManagedRowAttempt">={
 kind:"auth-provider",name:"task84-manager-host-refusal",agentBearerCommand:"agent-bearer",
 grantAgent:async()=>{throw new Error("direct grant fallback used");},revokeAgent:async()=>{throw new Error("direct revoke fallback used");},
 stageManagedRowCreate:async()=>{stageCalls++;return {actorToken:"actor-token",sentinelCreds:"sentinel"};},
 sendManagedRowAttempt:async()=>{sendCalls++;return Buffer.from("{}");},
};
const connector:Connector={kind:"connector",name:"task84-host-refusal",buildLaunch:()=>{buildCalls++;return {command:"true",args:[],env:{}};}};
registry.register(provider as AuthProvider);
registry.register(connector);
try{
 const secrets:SecretStore={get:async()=>undefined,put:async()=>{secretPuts++;},delete:async()=>{}};
 const manager=new Manager({space:"task84",runtime:"pty",workspaceRoot:root,secretStore:secrets}) as any;
 manager.userMode=true;
 manager.auth=await createSpaceAuth("task84");
 const provisionUserAgent=manager.provisionUserAgent.bind(manager);
 manager.provisionUserAgent=async(...args:unknown[])=>{provisionCalls++;return provisionUserAgent(...args);};
 const reply=await manager.startAgent({name:"fixture",agent:connector.name});
 assert.equal(reply.ok,false);
 assert.match(reply.error??"",/user-mode host launch is unsupported until durable launch\/name custody exists/);
 assert.equal(provisionCalls,0);
 assert.equal(stageCalls,0);
 assert.equal(sendCalls,0);
 assert.equal(secretPuts,0);
 assert.equal(buildCalls,0);
 const custodyDir=join(userAuthStateDir(root,"task84"),"provider-mutations");
 assert.equal(existsSync(custodyDir)&&readdirSync(custodyDir).some((name)=>name.endsWith(".json")),false);
 assert.equal((manager.reserved as Set<string>).size,0);
 assert.equal((manager.agents as Map<string,unknown>).size,0);
 console.log("TASK84 MANAGER HOST-LAUNCH FAIL-CLOSED 11 passed, 0 failed");
}finally{
 registry.unregister("connector",connector.name);
 registry.unregister("auth-provider",provider.name);
 rmSync(root,{recursive:true,force:true});
}
