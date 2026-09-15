import assert from "node:assert/strict";
import { admitManagerManagedRow, type ManagerEndpointAdmissionCustody, type ManagerManagedRowAdmissionReaders } from "../src/manager-managed-row-admission.js";
import { DEV_OWNER, createManagedRowAttempt, verifyManagedRowAttemptNonce, type CreateManagedRowIntent, type EpCaller, type EndpointGateRow, type GoalBindFact, type GoalIndexEntry, type GoalSpecValue, type GoalStatusValue } from "@cotal-ai/core";

const original:EpCaller={owner:"u_aaaaaaaaaaaaaaaaaaaaaaaaaa",actor:"cli",uid:"aaaaaaaaaaaaaaaaaaaaaaaaaa"};
const requester:EpCaller={owner:DEV_OWNER,actor:"SERVENKEY",uid:"bbbbbbbbbbbbbbbbbbbbbbbbbb"};
const target={owner:original.owner,actor:"worker",lifecycleUid:"cccccccccccccccccccccccccc"};
const intent:CreateManagedRowIntent={ver:1,command:"create-managed-row",requestId:"request_admission",operationId:"manager-spawn:cccccccccccccccccccccccccc",space:"task84",target,tokenHash:"a".repeat(64),scope:["run"],allowSubscribe:["general"],allowPublish:["general"],role:"worker",parent:`${original.owner}.${original.actor}`,label:"worker"};
const currency={kind:"local-manager" as const,instanceId:"dddddddddddddddddddddddddd",processEpoch:7,serveActor:requester.actor};
const custody:ManagerEndpointAdmissionCustody={kind:"endpoint-goal",originalCaller:original,goalId:"goal_admission",acceptingInstanceId:currency.instanceId,fingerprint:"sha256:"+"b".repeat(64),acceptedEpoch:7,operationId:intent.operationId,target};
const gate:EndpointGateRow={state:"open",generation:1,processEpoch:7,registrationRevision:4,nameAuthorityRevision:3,principal:`${requester.owner}.${requester.actor}`};
const index:GoalIndexEntry={v:1,endpoint:"manager",owner:original.owner,actor:original.actor,uid:original.uid,goalId:custody.goalId,iid:currency.instanceId,allocated:{name:target.actor,actor:target.actor,uid:target.lifecycleUid,readinessDeadlineMs:30000}};
const bind:GoalBindFact={v:1,goalId:custody.goalId,fingerprint:custody.fingerprint};
const spec:GoalSpecValue={v:1,goalId:custody.goalId,fingerprint:custody.fingerprint,command:"spawn",caller:{id:`${original.owner}.${original.actor}`,lifecycleUid:original.uid},acceptedEpoch:7,requestId:custody.goalId,sourceSeq:0,acceptedAt:1,readinessDeadlineMs:30000};
const status:GoalStatusValue={state:"accepted",observedSpecRevision:4};
const trace:{gateIds:string[];refs:unknown[]}={gateIds:[],refs:[]};
const build=(over:Partial<{gate:EndpointGateRow|undefined;index:GoalIndexEntry|undefined;bind:GoalBindFact|undefined;spec:{value:GoalSpecValue;revision:number}|undefined;status:GoalStatusValue|undefined;authorize:()=>Promise<void>}>)=>({
 readManagerGate:async(id:string)=>{trace.gateIds.push(id);return over.gate===undefined&&!("gate" in over)?gate:over.gate;},
 readGoalIndex:async(ref:unknown)=>{trace.refs.push(ref);return over.index===undefined&&!("index" in over)?index:over.index;},
 readGoalBind:async(ref:unknown)=>{trace.refs.push(ref);return over.bind===undefined&&!("bind" in over)?bind:over.bind;},
 readGoalSpec:async(ref:unknown)=>{trace.refs.push(ref);return over.spec===undefined&&!("spec" in over)?{value:spec,revision:4}:over.spec;},
 readGoalStatus:async(ref:unknown)=>{trace.refs.push(ref);return over.status===undefined&&!("status" in over)?status:over.status;},
 authorizeOriginalSpawn:over.authorize??(async()=>{}),
}) as ManagerManagedRowAdmissionReaders;
const admit=(readers:ManagerManagedRowAdmissionReaders,c=requester,cur=currency,cust=custody)=>admitManagerManagedRow({space:"task84",caller:c,intent,currency:cur,custody:cust,readers});
await admit(build({})); // ordinary spawn scope, no admin requirement
await assert.rejects(()=>admit(build({gate:{...gate,processEpoch:8}})),/epoch is stale/);
await assert.rejects(()=>admit(build({gate:{...gate,principal:"local.FOREIGN"}})),/foreign requester/);
await assert.rejects(()=>admit(build({gate:undefined})),/no current open/);
await assert.rejects(()=>admit(build({index:{...index,iid:"eeeeeeeeeeeeeeeeeeeeeeeeee"}})),/goal index allocation/);
await assert.rejects(()=>admit(build({index:{...index,allocated:{...index.allocated!,uid:"eeeeeeeeeeeeeeeeeeeeeeeeee"}}})),/goal index allocation/);
await assert.rejects(()=>admit(build({bind:{...bind,fingerprint:"sha256:"+"c".repeat(64)}})),/goal bind/);
await assert.rejects(()=>admit(build({spec:{value:{...spec,sourceSeq:1},revision:4}})),/spawn spec/);
await assert.rejects(()=>admit(build({status:{state:"cancelled",observedSpecRevision:4}})),/terminal/);
await assert.rejects(()=>admit(build({status:{state:"cancelling",cancelMode:"graceful",observedSpecRevision:4}})),/cancel/);
let admissionPhase=0;
const drifting=build({});
drifting.readGoalStatus=async()=>++admissionPhase===1?status:{state:"cancelling",cancelMode:"terminate",observedSpecRevision:4};
await admit(drifting);
await assert.rejects(()=>admit(drifting),/cancel/);
await assert.rejects(()=>admit(build({authorize:async()=>{throw new Error("original caller lifecycle stale");}})),/original caller lifecycle stale/);
await assert.rejects(()=>admit(build({}),requester,currency,{...custody,target:{...target,owner:"u_bbbbbbbbbbbbbbbbbbbbbbbbbb"}}),/target does not match/);
await assert.rejects(()=>admit(build({}),{...requester,actor:"SUPERVISOR"}),/retained local manager serve identity/);
await assert.rejects(()=>admit(build({}),requester,{...currency,processEpoch:8}),/epoch is stale/);
await assert.rejects(()=>admitManagerManagedRow({space:"foreign",caller:requester,intent,currency,custody,readers:build({})}),/foreign space/);
trace.gateIds.length=0;trace.refs.length=0;
await admit(build({gate:{...gate,processEpoch:8}}),requester,{...currency,processEpoch:8}); // restarted successor epoch adopts immutable predecessor acceptance
assert.equal(trace.gateIds[0],currency.instanceId);assert.equal((trace.refs[0] as {goalId:string}).goalId,custody.goalId);assert.deepEqual((trace.refs[0] as {caller:EpCaller}).caller,original);
await assert.rejects(()=>admit(build({}),requester,{...currency,instanceId:"eeeeeeeeeeeeeeeeeeeeeeeeee"}),/foreign manager instance/);
await assert.rejects(()=>admit(build({index:{...index,iid:"eeeeeeeeeeeeeeeeeeeeeeeeee"}}),requester,currency,custody),/goal index allocation/);
await assert.rejects(()=>admit(build({gate:{...gate,principal:`u_aaaaaaaaaaaaaaaaaaaaaaaaaa.${requester.actor}`}}),{...requester,owner:"u_aaaaaaaaaaaaaaaaaaaaaaaaaa"}),/not the retained local manager serve identity/);
await assert.rejects(()=>admit(build({gate:{...gate,principal:`${DEV_OWNER}.OTHER_SERVE`}}),{...requester,actor:"OTHER_SERVE"}),/not the retained local manager serve identity/);
await assert.rejects(()=>admit(build({spec:{value:{...spec,requestId:"request_foreign"},revision:4}})),/spawn spec/);
await assert.rejects(()=>admit(build({spec:{value:{...spec,acceptedEpoch:6},revision:4}})),/spawn spec/);
await assert.rejects(()=>admit(build({status:{...status,observedSpecRevision:3}})),/missing, cancelling, or terminal/);
await assert.rejects(()=>admit(build({}),requester,currency,{...custody,operationId:"manager-spawn:foreigncccccccccccccccccc"}),/operation does not match/);
const attemptAuthority={kind:"local-manager" as const,instanceId:currency.instanceId,processEpoch:currency.processEpoch};
const boundAttempt=createManagedRowAttempt(requester,intent,Buffer.alloc(16,7),attemptAuthority);
assert.throws(()=>verifyManagedRowAttemptNonce(boundAttempt.nonce,requester,intent,{...attemptAuthority,processEpoch:8}),/commitment/);
assert.throws(()=>verifyManagedRowAttemptNonce(boundAttempt.nonce,requester,intent,{...attemptAuthority,instanceId:"eeeeeeeeeeeeeeeeeeeeeeeeee"}),/commitment/);
console.log("TASK84 MANAGER MANAGED-ROW ADMISSION 23 passed, 0 failed");
