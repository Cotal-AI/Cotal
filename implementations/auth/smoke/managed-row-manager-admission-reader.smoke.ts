import assert from "node:assert/strict";
import { managerManagedRowAdmissionGrants } from "../src/authority-client.js";
import { managerManagedRowAdmissionReaders, openManagerManagedRowAdmissionPlane } from "../src/manager-managed-row-admission.js";
import { DEV_OWNER, RECORD_KINDS, epAuthBucket, epfGoalBindSubject, epfStreamName, epgateKey, recordAtomicKey, recordSpecKey, recordStatusKey, recordsBucket, type EpCaller } from "@cotal-ai/core";

const space="task84",instanceId="dddddddddddddddddddddddddd",connId="conn12345";
const grants=managerManagedRowAdmissionGrants(space,connId);
assert.deepEqual(grants.publish,["$JS.API.INFO",`$JS.API.STREAM.MSG.GET.KV_${recordsBucket(space)}`,`$JS.API.STREAM.MSG.GET.${epfStreamName(space)}`,`$JS.API.STREAM.MSG.GET.KV_${epAuthBucket(space)}`]);
assert.deepEqual(grants.subscribe,[`_INBOX_${connId}.>`]);
for(const forbidden of ["STREAM.CREATE","STREAM.UPDATE","STREAM.DELETE","CONSUMER","$KV.","DIRECT.GET"])
 assert.equal(grants.publish.some((row)=>row.includes(forbidden)),false,`forbidden grant ${forbidden}`);
const calls:Array<{stream:string;request:unknown}>=[];
const gate={state:"open",generation:1,processEpoch:7,registrationRevision:4,nameAuthorityRevision:3,principal:`${DEV_OWNER}.SERVENKEY`};
const fakeJsm={streams:{getMessage:async(stream:string,request:unknown)=>{calls.push({stream,request});return{data:Buffer.from(JSON.stringify(gate)),seq:9,header:undefined};}}};
const readers=managerManagedRowAdmissionReaders({space,jsm:fakeJsm as never,authorizeOriginalSpawn:async()=>{}});
assert.deepEqual(await readers.readManagerGate(instanceId),gate);
assert.deepEqual(calls[0],{stream:`KV_${epAuthBucket(space)}`,request:{last_by_subj:`$KV.${epAuthBucket(space)}.${epgateKey("manager",instanceId)}`}});
const markerJsm={streams:{getMessage:async()=>({data:Buffer.from(JSON.stringify(gate)),seq:1,header:{get:()=>"DEL"}})}};
await assert.rejects(()=>managerManagedRowAdmissionReaders({space,jsm:markerJsm as never,authorizeOriginalSpawn:async()=>{}}).readManagerGate(instanceId),/DEL marker/);
const malformedJsm={streams:{getMessage:async()=>({data:Buffer.from('{"state":"open"}'),seq:1,header:undefined})}};
await assert.rejects(()=>managerManagedRowAdmissionReaders({space,jsm:malformedJsm as never,authorizeOriginalSpawn:async()=>{}}).readManagerGate(instanceId),/does not validate/);
const caller:EpCaller={owner:"u_aaaaaaaaaaaaaaaaaaaaaaaaaa",actor:"cli",uid:"aaaaaaaaaaaaaaaaaaaaaaaaaa"},goalId="goal_reader";
const ref={endpoint:"manager" as const,caller,goalId};
const goalCalls:Array<{stream:string;request:Record<string,string>}>=[];
const index={v:1,endpoint:"manager",owner:caller.owner,actor:caller.actor,uid:caller.uid,goalId,iid:instanceId,allocated:{name:"worker",actor:"worker",uid:"cccccccccccccccccccccccccc"}};
const spec={v:1,goalId,fingerprint:"sha256:"+"a".repeat(64),command:"spawn",caller:{id:`${caller.owner}.${caller.actor}`,lifecycleUid:caller.uid},acceptedEpoch:7,requestId:goalId,sourceSeq:0,acceptedAt:1};
const status={state:"accepted",observedSpecRevision:22};const bind={v:1,goalId,fingerprint:spec.fingerprint};
const values=new Map<string,unknown>([
 [recordAtomicKey(RECORD_KINDS.goalidx,["manager",caller.owner,caller.actor,caller.uid,goalId]),index],
 [recordSpecKey(RECORD_KINDS.goal,["manager",caller.owner,caller.actor,caller.uid,goalId]),spec],
 [recordStatusKey(RECORD_KINDS.goal,["manager",caller.owner,caller.actor,caller.uid,goalId]),status],
 [epfGoalBindSubject(space,ref,goalId),bind],
]);
const goalJsm={streams:{getMessage:async(stream:string,request:Record<string,string>)=>{goalCalls.push({stream,request});const subject=request.last_by_subj;const key=subject.startsWith(`$KV.${recordsBucket(space)}.`)?subject.slice(`$KV.${recordsBucket(space)}.`.length):subject;return{data:Buffer.from(JSON.stringify(values.get(key))),seq:key.includes(".status")?23:22,header:undefined};}}};
const goalReaders=managerManagedRowAdmissionReaders({space,jsm:goalJsm as never,authorizeOriginalSpawn:async()=>{}});
assert.deepEqual(await goalReaders.readGoalIndex(ref),index);assert.deepEqual(await goalReaders.readGoalBind(ref),bind);
assert.deepEqual(await goalReaders.readGoalSpec(ref),{value:spec,revision:22});assert.deepEqual(await goalReaders.readGoalStatus(ref),status);
assert.deepEqual(goalCalls.map(c=>c.stream),[`KV_${recordsBucket(space)}`,epfStreamName(space),`KV_${recordsBucket(space)}`,`KV_${recordsBucket(space)}`]);
assert.equal(goalCalls.every(c=>Object.keys(c.request).join(",")==="last_by_subj"),true);
let closes=0;
await assert.rejects(()=>openManagerManagedRowAdmissionPlane({space,open:async()=>({jsm:fakeJsm as never,close:async()=>{closes++;}}),authorizeOriginalSpawn:async()=>{},afterOpen:async()=>{throw new Error("injected admission initialization failure");}}),/initialization failure/);
assert.equal(closes,1);
const plane=await openManagerManagedRowAdmissionPlane({space,open:async()=>({jsm:fakeJsm as never,close:async()=>{closes++;}}),authorizeOriginalSpawn:async()=>{}});
await plane.close();await plane.close();assert.equal(closes,2); // fence/shutdown share one idempotent owner close
console.log("TASK84 MANAGER ADMISSION READER/GRANTS/LIFECYCLE 20 passed, 0 failed");
