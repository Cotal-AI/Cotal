import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, managedRowRequesterGrantRows, managedRowWireId, readProviderMutationRequest, registry, stableProviderMutationRequestId, type AuthProvider, type ManagedRowAttempt, type ManagedRowIntent, type SecretStore } from "@cotal-ai/core";
import { userAuthStateDir } from "@cotal-ai/workspace";
import { openManagedRowBrokerExecutor } from "../../auth/src/managed-row.js";
import { Manager } from "../src/manager.js";

type Row={value:Uint8Array,revision:number,operation:"PUT"};
const OWNER="u_aaaaaaaaaaaaaaaaaaaaaaaaaa",OLD_UID="bbbbbbbbbbbbbbbbbbbbbbbbbb",NEW_UID="cccccccccccccccccccccccccc",MANAGER_UID="dddddddddddddddddddddddddd",INSTANCE="eeeeeeeeeeeeeeeeeeeeeeeeee",SPACE="task84";
const caller={owner:"local",actor:"MANAGERSERVE",uid:MANAGER_UID},authority={kind:"local-manager" as const,instanceId:INSTANCE,processEpoch:7};
const admission={kind:"endpoint-goal" as const,goalId:"goal_post_create",originalCaller:{owner:OWNER,actor:"cli",uid:"aaaaaaaaaaaaaaaaaaaaaaaaaa"},fingerprint:"sha256:"+"a".repeat(64),acceptingInstanceId:INSTANCE,acceptedEpoch:7};
const root=mkdtempSync(join(process.env.TMPDIR??tmpdir(),"task84-manager-post-create-"));
let rev=0;const rows=new Map<string,Row>();
const kv={get:async(key:string)=>rows.get(key)??null,create:async(key:string,value:Uint8Array)=>{if(rows.has(key))throw new Error("key exists");rows.set(key,{value,revision:++rev,operation:"PUT"});return rev;},update:async(key:string,value:Uint8Array,pin:number)=>{const cur=rows.get(key);if(!cur||cur.revision!==pin)throw new Error("wrong last sequence");rows.set(key,{value,revision:++rev,operation:"PUT"});return rev;}};
const effects:ManagedRowIntent[]=[];const attempts:ManagedRowAttempt[]=[];
const executor=openManagedRowBrokerExecutor(kv as never,async()=>{},async({intent})=>{effects.push(intent);});
let uncertainRollback=true;
const provider:Pick<AuthProvider,"kind"|"name"|"agentBearerCommand"|"stageManagedRowCreate"|"sendManagedRowAttempt">={kind:"auth-provider",name:"task84-manager-post-create",agentBearerCommand:"agent-bearer",stageManagedRowCreate:async()=>({actorToken:"fixed-manager-token",sentinelCreds:"fixed-manager-sentinel"}),sendManagedRowAttempt:async({attempt})=>{attempts.push(attempt);const wireId=managedRowWireId(attempt.intent);const bytes=await executor.execute({wireId,intent:attempt.intent,finalAdmission:async()=>{},assertPreEffectOpen:()=>{}});if(attempt.command==="revoke-managed-row"&&uncertainRollback){uncertainRollback=false;throw new Error("injected manager uncertain after committed rollback");}return bytes;}};
registry.register(provider as AuthProvider);
const secrets:SecretStore={get:async()=>undefined,put:async()=>{},delete:async()=>{}};
const manager=new Manager({space:SPACE,runtime:"pty",workspaceRoot:root,secretStore:secrets}) as any;
manager.auth=await createSpaceAuth(SPACE);manager.managedRowRequesterContext=async()=>({caller,authority});manager.withProvisioner=async()=>{throw new Error("injected later manager durable provisioning failure");};manager.deprovision=async()=>{};
const opts=(uid:string)=>({specOwner:OWNER,allowSubscribe:["general"],allowPublish:["general"],role:"worker",capabilities:["run"],label:"worker",lifecycleUid:uid,admission});
const target=()=>JSON.parse(new TextDecoder().decode(rows.get(`managedrowtarget.${OWNER}.worker`)!.value)) as {state:string;lifecycleUid:string};
try{
 const first=await manager.provisionUserAgent("worker",opts(OLD_UID));
 const rollbackId=stableProviderMutationRequestId({kind:"revoke",owner:OWNER,actor:"worker",lifecycleUid:OLD_UID,operationId:`manager-rollback:${OLD_UID}`});
 const firstCustody=readProviderMutationRequest(userAuthStateDir(root,SPACE),rollbackId)!;assert.equal(firstCustody.state,"pending");
 assert.deepEqual(effects.map(x=>x.command),["create-managed-row","revoke-managed-row"]);
 assert.equal(target().state,"tombstone");assert.equal(target().lifecycleUid,OLD_UID);
 const second=await manager.provisionUserAgent("worker",opts(OLD_UID));
 const secondCustody=readProviderMutationRequest(userAuthStateDir(root,SPACE),rollbackId)!;assert.equal(secondCustody.state,"host-committed");assert.deepEqual(Object.keys(firstCustody).sort(),["actor","admission","caller","kind","lifecycleUid","operationId","owner","requestId","state","ver"].sort());assert.deepEqual(Object.keys(secondCustody).sort(),Object.keys(firstCustody).sort());for(const custody of [firstCustody,secondCustody]){const stored=JSON.stringify(custody);for(const forbidden of ["nonce","attemptRandom","replySubject","reply subject","subscription"])assert.equal(stored.includes(forbidden),false);}
 const oldCreates=attempts.filter(a=>a.command==="create-managed-row"&&a.intent.target.lifecycleUid===OLD_UID),oldRevokes=attempts.filter(a=>a.command==="revoke-managed-row"&&a.intent.target.lifecycleUid===OLD_UID);
 assert.equal(oldCreates.length,2);assert.notEqual(oldCreates[0].nonce,oldCreates[1].nonce);assert.equal(managedRowWireId(oldCreates[0].intent),managedRowWireId(oldCreates[1].intent));assert.equal(oldRevokes.length,2);assert.notEqual(oldRevokes[0].nonce,oldRevokes[1].nonce);assert.equal(managedRowWireId(oldRevokes[0].intent),managedRowWireId(oldRevokes[1].intent));
 for(const pair of [oldCreates,oldRevokes]){const grants=pair.map(a=>managedRowRequesterGrantRows(SPACE,{command:a.command,caller:a.caller,nonce:a.nonce,...(a.command==="revoke-managed-row"?{targetOwner:a.intent.target.owner}:{})}));assert.equal(grants[0].subscribe.length,1);assert.equal(grants[1].subscribe.length,1);assert.notEqual(grants[0].subscribe[0],grants[1].subscribe[0]);}
 assert.equal(effects.length,2,"exact manager retry re-effected committed operations");
 const beforeHostRefusal=effects.length;const foreign={...oldCreates[0].intent,requestId:"manager_foreign_owner",operationId:`manager-spawn:${NEW_UID}`,target:{...oldCreates[0].intent.target,owner:"u_bbbbbbbbbbbbbbbbbbbbbbbbbb",lifecycleUid:NEW_UID}};await assert.rejects(()=>executor.execute({wireId:managedRowWireId(foreign),intent:foreign,finalAdmission:async()=>{throw new Error("injected host-admission refusal before effect");},assertPreEffectOpen:()=>{throw new Error("host refusal must not reach the pre-effect latch");}}),/injected host-admission refusal before effect/);assert.equal(effects.length,beforeHostRefusal);
 const successor={ver:1 as const,command:"create-managed-row" as const,requestId:"manager_successor_request",operationId:`manager-spawn:${NEW_UID}`,space:SPACE,target:{owner:OWNER,actor:"worker",lifecycleUid:NEW_UID},tokenHash:createHash("sha256").update("successor").digest("hex"),scope:["run"],allowSubscribe:["general"],allowPublish:["general"],role:"worker",label:"worker"};
 await executor.execute({wireId:managedRowWireId(successor),intent:successor,finalAdmission:async()=>{},assertPreEffectOpen:()=>{}});
 assert.equal(target().state,"live");assert.equal(target().lifecycleUid,NEW_UID);
 const stale=attempts.findLast(a=>a.command==="revoke-managed-row"&&a.intent.target.lifecycleUid===OLD_UID)!;
 const staleWireId=managedRowWireId(stale.intent);
 const replay=await executor.execute({wireId:staleWireId,intent:stale.intent,finalAdmission:async()=>{throw new Error("committed stale manager retry must not re-admit");},assertPreEffectOpen:()=>{throw new Error("committed stale manager retry must not enter the pre-effect latch");}});
 assert.equal(JSON.parse(new TextDecoder().decode(replay)).data.state,"tombstone");
 assert.equal(target().state,"live");assert.equal(target().lifecycleUid,NEW_UID);
 assert.match(first.error??"",/managed-row rollback remains pending for retry \(injected manager uncertain after committed rollback\)/);
 assert.doesNotMatch(second.error??"",/rollback remains pending/);
 console.log("TASK84 MANAGER POST-CREATE ROLLBACK 18 passed, 0 failed");
}finally{registry.unregister("auth-provider",provider.name);await executor.close();rmSync(root,{recursive:true,force:true});}
