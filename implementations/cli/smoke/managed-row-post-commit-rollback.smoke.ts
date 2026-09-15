import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, canonicalJson, commitProviderMutationRequest, createManagedRowAttempt, createSpaceAuth, managedRowRequesterGrantRows, managedRowWireId, readProviderMutationRequest, registry, stableProviderMutationRequestId, type AuthProvider, type ManagedRowAttempt, type ManagedRowIntent } from "@cotal-ai/core";
import { authDir, saveSpaceAuth, userAuthStateDir } from "@cotal-ai/workspace";
import { openManagedRowBrokerExecutor } from "../../auth/src/managed-row.js";
import { provisionUserForeground } from "../src/commands/spawn.js";

type Row={value:Uint8Array,revision:number,operation:"PUT"};
const OWNER="u_aaaaaaaaaaaaaaaaaaaaaaaaaa",CLI_UID="aaaaaaaaaaaaaaaaaaaaaaaaaa",OLD_UID="bbbbbbbbbbbbbbbbbbbbbbbbbb",NEW_UID="cccccccccccccccccccccccccc",SPACE="task84";
const caller={owner:OWNER,actor:"cli",uid:CLI_UID};
const root=mkdtempSync(join(process.env.TMPDIR??tmpdir(),"task84-cli-post-create-"));
mkdirSync(join(root,".cotal","agents"),{recursive:true});
saveSpaceAuth(authDir(root),await createSpaceAuth(SPACE));
let rev=0;const rows=new Map<string,Row>();
const kv={get:async(key:string)=>rows.get(key)??null,create:async(key:string,value:Uint8Array)=>{if(rows.has(key))throw new Error("key exists");rows.set(key,{value,revision:++rev,operation:"PUT"});return rev;},update:async(key:string,value:Uint8Array,pin:number)=>{const cur=rows.get(key);if(!cur||cur.revision!==pin)throw new Error("wrong last sequence");rows.set(key,{value,revision:++rev,operation:"PUT"});return rev;}};
const effects:ManagedRowIntent[]=[];
const executor=openManagedRowBrokerExecutor(kv as never,async()=>{},async({intent})=>{effects.push(intent);});
let uncertainRollback=true;
const attempts:ManagedRowAttempt[]=[];
const provider:Pick<AuthProvider,"kind"|"name"|"agentBearerCommand"|"ownerForLogin"|"stageManagedRowCreate"|"sendManagedRowAttempt">={
  kind:"auth-provider",name:"task84-cli-post-create",agentBearerCommand:"agent-bearer",ownerForLogin:async()=>OWNER,
  stageManagedRowCreate:async()=>({actorToken:"fixed-actor-token",sentinelCreds:"fixed-sentinel"}),
  sendManagedRowAttempt:async({attempt})=>{attempts.push(attempt);const wireId=managedRowWireId(attempt.intent);const bytes=await executor.execute({wireId,intent:attempt.intent,finalAdmission:async()=>{},assertPreEffectOpen:()=>{}});if(attempt.command==="revoke-managed-row"&&uncertainRollback){uncertainRollback=false;throw new Error("injected uncertain after committed rollback");}return bytes;},
};
registry.register(provider as AuthProvider);
const originalStart=CotalEndpoint.prototype.start,originalExit=process.exit;
const originalError=console.error;const errors:string[]=[];
console.error=(...args:unknown[])=>{errors.push(args.map(String).join(" "));};
CotalEndpoint.prototype.start=async function(){throw new Error("injected later durable provisioning failure");};
(process as unknown as {exit(code?:number):never}).exit=((code?:number)=>{throw new Error(`process.exit:${code}`);}) as never;
const invoke=async(uid:string)=>{const before=errors.length;try{await provisionUserForeground({root,space:SPACE,server:"nats://127.0.0.1:1",mode:"user"} as never,"worker","worker",{allowSubscribe:["general"],allowPublish:["general"],capabilities:["run"],role:"worker",lifecycleUid:uid,caller});}catch{}return errors.slice(before).join("\n");};
const target=()=>JSON.parse(new TextDecoder().decode(rows.get(`managedrowtarget.${OWNER}.worker`)!.value)) as {state:string;lifecycleUid:string};
try{
  const first=await invoke(OLD_UID);
  const oldRollbackId=stableProviderMutationRequestId({kind:"revoke",owner:OWNER,actor:"worker",lifecycleUid:OLD_UID,operationId:`cli-rollback:${OLD_UID}`});
  assert.match(first,/managed-row rollback remains pending for retry \(injected uncertain after committed rollback\)/);
  const firstCustody=readProviderMutationRequest(userAuthStateDir(root,SPACE),oldRollbackId)!;assert.equal(firstCustody.state,"pending");
  assert.deepEqual(effects.map(x=>x.command),["create-managed-row","revoke-managed-row"]);
  assert.equal(target().state,"tombstone");assert.equal(target().lifecycleUid,OLD_UID);
  const second=await invoke(OLD_UID);
  assert.doesNotMatch(second,/rollback remains pending/);
  const secondCustody=readProviderMutationRequest(userAuthStateDir(root,SPACE),oldRollbackId)!;assert.equal(secondCustody.state,"host-committed");assert.deepEqual(Object.keys(firstCustody).sort(),["actor","admission","caller","kind","lifecycleUid","operationId","owner","requestId","state","ver"].sort());assert.deepEqual(Object.keys(secondCustody).sort(),Object.keys(firstCustody).sort());
  for(const custody of [firstCustody,secondCustody]){const stored=JSON.stringify(custody);for(const forbidden of ["nonce","attemptRandom","replySubject","reply subject","subscription"])assert.equal(stored.includes(forbidden),false,`custody retained attempt coordinate ${forbidden}`);}
  const oldCreates=attempts.filter(a=>a.command==="create-managed-row"&&a.intent.target.lifecycleUid===OLD_UID),oldRevokes=attempts.filter(a=>a.command==="revoke-managed-row"&&a.intent.target.lifecycleUid===OLD_UID);
  assert.equal(oldCreates.length,2);assert.notEqual(oldCreates[0].nonce,oldCreates[1].nonce);assert.equal(managedRowWireId(oldCreates[0].intent),managedRowWireId(oldCreates[1].intent));assert.equal(oldRevokes.length,2);assert.notEqual(oldRevokes[0].nonce,oldRevokes[1].nonce);assert.equal(managedRowWireId(oldRevokes[0].intent),managedRowWireId(oldRevokes[1].intent));
  for(const pair of [oldCreates,oldRevokes]){const grants=pair.map(a=>managedRowRequesterGrantRows(SPACE,{command:a.command,caller:a.caller,nonce:a.nonce,...(a.command==="revoke-managed-row"?{targetOwner:a.intent.target.owner}:{})}));assert.equal(grants[0].subscribe.length,1);assert.equal(grants[1].subscribe.length,1);assert.notEqual(grants[0].subscribe[0],grants[1].subscribe[0]);assert.equal(grants[0].subscribe[0].endsWith(`.${pair[0].nonce}`),true);assert.equal(grants[1].subscribe[0].endsWith(`.${pair[1].nonce}`),true);}
  assert.equal(effects.length,2,"exact retry re-effected a committed create or revoke");
  const successorIntent={ver:1 as const,command:"create-managed-row" as const,requestId:"successor_create_request",operationId:`cli-foreground:${NEW_UID}`,space:SPACE,target:{owner:OWNER,actor:"worker",lifecycleUid:NEW_UID},tokenHash:createHash("sha256").update("successor-token").digest("hex"),scope:["run"],allowSubscribe:["general"],allowPublish:["general"],role:"worker",parent:`${OWNER}.cli`,label:"worker"};
  const targetKey=`managedrowtarget.${OWNER}.worker`, committedTombstone={...rows.get(targetKey)!};
  const revokeOpKey=`managedrowop.${oldRollbackId}`, committedRevokeOp={...rows.get(revokeOpKey)!};
  const pendingRevoke=JSON.parse(new TextDecoder().decode(committedRevokeOp.value));pendingRevoke.state="pending";delete pendingRevoke.resultDigest;rows.set(revokeOpKey,{...committedRevokeOp,value:new TextEncoder().encode(canonicalJson(pendingRevoke))});
  await assert.rejects(()=>executor.execute({wireId:managedRowWireId(successorIntent),intent:successorIntent,finalAdmission:async()=>{},assertPreEffectOpen:()=>{}}),/committed revoke operation/);
  assert.equal(effects.length,2,"pending tombstone refusal effected the successor");
  rows.set(revokeOpKey,committedRevokeOp);
  const malformed=JSON.parse(new TextDecoder().decode(committedTombstone.value));malformed.extra=true;rows.set(targetKey,{...committedTombstone,value:new TextEncoder().encode(canonicalJson(malformed))});
  await assert.rejects(()=>executor.execute({wireId:managedRowWireId(successorIntent),intent:successorIntent,finalAdmission:async()=>{},assertPreEffectOpen:()=>{}}),/malformed retained tombstone/);
  assert.equal(effects.length,2,"malformed tombstone refusal effected the successor");
  const foreign=JSON.parse(new TextDecoder().decode(committedTombstone.value));foreign.owner="u_bbbbbbbbbbbbbbbbbbbbbbbbbb";rows.set(targetKey,{...committedTombstone,value:new TextEncoder().encode(canonicalJson(foreign))});
  await assert.rejects(()=>executor.execute({wireId:managedRowWireId(successorIntent),intent:successorIntent,finalAdmission:async()=>{},assertPreEffectOpen:()=>{}}),/does not match its target key/);
  assert.equal(effects.length,2,"foreign tombstone refusal effected the successor");
  rows.set(targetKey,committedTombstone);
  const successorAttempt=createManagedRowAttempt(caller,successorIntent,Buffer.alloc(16,8));
  await executor.execute({wireId:managedRowWireId(successorIntent),intent:successorIntent,finalAdmission:async()=>{},assertPreEffectOpen:()=>{}});
  assert.equal(target().state,"live");assert.equal(target().lifecycleUid,NEW_UID);
  const stale=attempts.findLast(a=>a.command==="revoke-managed-row"&&a.intent.target.lifecycleUid===OLD_UID)!;
  const staleWireId=managedRowWireId(stale.intent);
  const staleBytes=await executor.execute({wireId:staleWireId,intent:stale.intent,finalAdmission:async()=>{throw new Error("committed stale retry must not re-admit");},assertPreEffectOpen:()=>{throw new Error("committed stale retry must not enter the pre-effect latch");}});
  assert.equal(JSON.parse(new TextDecoder().decode(staleBytes)).data.state,"tombstone");
  assert.equal(target().state,"live","stale cleanup deleted successor");assert.equal(target().lifecycleUid,NEW_UID,"stale cleanup deleted successor");
  console.log("TASK84 CLI POST-CREATE ROLLBACK 21 passed, 0 failed");
}finally{console.error=originalError;process.exit=originalExit;CotalEndpoint.prototype.start=originalStart;registry.unregister("auth-provider",provider.name);await executor.close();rmSync(root,{recursive:true,force:true});}
