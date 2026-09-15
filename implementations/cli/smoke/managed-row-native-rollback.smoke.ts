import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, readProviderMutationRequest, registry, type AuthProvider, type ManagedRowAttempt } from "@cotal-ai/core";
import { authDir, saveSpaceAuth, userAuthStateDir } from "@cotal-ai/workspace";
import { provisionUserForeground } from "../src/commands/spawn.js";

const OWNER="u_aaaaaaaaaaaaaaaaaaaaaaaaaa",CLI_UID="aaaaaaaaaaaaaaaaaaaaaaaaaa",TARGET_UID="bbbbbbbbbbbbbbbbbbbbbbbbbb";
const caller={owner:OWNER,actor:"cli",uid:CLI_UID};
const root=mkdtempSync(join(process.env.TMPDIR??tmpdir(),"task84-cli-native-rollback-"));
mkdirSync(join(root,".cotal","agents"),{recursive:true});
saveSpaceAuth(authDir(root),await createSpaceAuth("task84"));
const attempts:ManagedRowAttempt[]=[];
let resolvedOwner=OWNER,stageCalls=0;
const provider:Pick<AuthProvider,"kind"|"name"|"agentBearerCommand"|"ownerForLogin"|"stageManagedRowCreate"|"sendManagedRowAttempt">={
 kind:"auth-provider",name:"task84-cli-native",agentBearerCommand:"agent-bearer",ownerForLogin:async()=>resolvedOwner,
 stageManagedRowCreate:async()=>{stageCalls++;return {actorToken:"actor-token",sentinelCreds:"sentinel"};},
 sendManagedRowAttempt:async({attempt})=>{attempts.push(attempt);if(attempt.command==="create-managed-row")throw new Error("injected create/preflight failure");throw new Error("injected rollback refusal");},
};
registry.register(provider as AuthProvider);
const originalExit=process.exit;let surfaced="";
(process as unknown as {exit(code?:number):never}).exit=((code?:number)=>{throw new Error(`process.exit:${code}`);}) as never;
try{
 const custodyDir=join(userAuthStateDir(root,"task84"),"provider-mutations");
 const hasCustody=()=>existsSync(custodyDir)&&readdirSync(custodyDir).some((name)=>name.endsWith(".json"));
 let mismatch="";
 resolvedOwner="u_bbbbbbbbbbbbbbbbbbbbbbbbbb";
 try{await provisionUserForeground({root,space:"task84",server:"nats://127.0.0.1:1",mode:"user"} as never,"worker","worker",{allowSubscribe:[],allowPublish:[],capabilities:["run"],lifecycleUid:TARGET_UID,caller});}catch(error){mismatch=error instanceof Error?error.message:String(error);}
 assert.match(mismatch,/process\.exit:1/);assert.equal(stageCalls,0);assert.equal(attempts.length,0);assert.equal(hasCustody(),false);

 mismatch="";resolvedOwner=OWNER;
 try{await provisionUserForeground({root,space:"task84",server:"nats://127.0.0.1:1",mode:"user"} as never,"worker","worker",{allowSubscribe:[],allowPublish:[],capabilities:["run"],lifecycleUid:TARGET_UID,caller:{...caller,actor:"manager"}});}catch(error){mismatch=error instanceof Error?error.message:String(error);}
 assert.match(mismatch,/process\.exit:1/);assert.equal(stageCalls,0);assert.equal(attempts.length,0);assert.equal(hasCustody(),false);

 // Preserve the native create/refused rollback case separately from the identity preflight controls.
 try{await provisionUserForeground({root,space:"task84",server:"nats://127.0.0.1:1",mode:"user"} as never,"worker","worker",{allowSubscribe:[],allowPublish:[],capabilities:["run"],lifecycleUid:TARGET_UID,caller});}catch(error){surfaced=error instanceof Error?error.message:String(error);}
 assert.equal(attempts.length,2);assert.equal(attempts[0].command,"create-managed-row");assert.equal(attempts[1].command,"revoke-managed-row");
 assert.deepEqual(attempts[0].caller,caller);assert.deepEqual(attempts[1].caller,caller);assert.equal(attempts[0].intent.target.lifecycleUid,TARGET_UID);assert.equal(attempts[1].intent.target.lifecycleUid,TARGET_UID);
 assert.notEqual(attempts[0].intent.requestId,attempts[1].intent.requestId);assert.equal(attempts[0].intent.operationId,`cli-foreground:${TARGET_UID}`);assert.equal(attempts[1].intent.operationId,`cli-rollback:${TARGET_UID}`);
 assert.equal(attempts[0].intent.command==="create-managed-row"?attempts[0].intent.parent:"",`${caller.owner}.${caller.actor}`);
 const pending=readProviderMutationRequest(userAuthStateDir(root,"task84"),attempts[1].intent.requestId);assert.equal(pending?.state,"pending");assert.deepEqual(pending?.caller,caller);
 assert.match(surfaced,/process\.exit:1/);
 console.log("TASK84 CLI IDENTITY PREFLIGHT + NATIVE ROLLBACK 22 passed, 0 failed");
}finally{process.exit=originalExit;registry.unregister("auth-provider",provider.name);rmSync(root,{recursive:true,force:true});}
