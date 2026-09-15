import assert from "node:assert/strict";
import { authAdminListenerGrants, handleManagedRowNativeRequest } from "../src/auth-admin.js";
import { openManagedRowBrokerExecutor } from "../src/managed-row.js";
import { canonicalJson, createManagedRowAttempt, epRequestSubject, managedRowRequesterGrantRows, managedRowStableBytes, managedRowWireId, parseEpSubject, rawDigest, type CreateManagedRowIntent } from "@cotal-ai/core";

const caller={owner:"u_aaaaaaaaaaaaaaaaaaaaaaaaaa",actor:"manager",uid:"aaaaaaaaaaaaaaaaaaaaaaaaaa"};
const intent:CreateManagedRowIntent={ver:1,command:"create-managed-row",requestId:"request_aaaaaaaa",operationId:"manager-spawn:cccccccccccccccccccccccccc",space:"task84",target:{owner:caller.owner,actor:"worker",lifecycleUid:"cccccccccccccccccccccccccc"},tokenHash:"a".repeat(64),scope:["run","spawn"],allowSubscribe:["general"],allowPublish:["general"],role:"worker",parent:`${caller.owner}.${caller.actor}`,label:"worker"};
const attempt=createManagedRowAttempt(caller,intent,Buffer.alloc(16,9));
const wireId=managedRowWireId(intent);
const retryAttemptA=createManagedRowAttempt(caller,intent),retryAttemptB=createManagedRowAttempt(caller,intent);
assert.notEqual(retryAttemptA.nonce,retryAttemptB.nonce);assert.equal(managedRowWireId(retryAttemptA.intent),wireId);assert.equal(managedRowWireId(retryAttemptB.intent),wireId);
const retryGrantsA=managedRowRequesterGrantRows("task84",{command:intent.command,caller,nonce:retryAttemptA.nonce});
const retryGrantsB=managedRowRequesterGrantRows("task84",{command:intent.command,caller,nonce:retryAttemptB.nonce});
assert.equal(retryGrantsA.subscribe.length,1);assert.equal(retryGrantsB.subscribe.length,1);assert.notEqual(retryGrantsA.subscribe[0],retryGrantsB.subscribe[0]);
assert.equal(retryGrantsA.subscribe[0].endsWith(`.${retryAttemptA.nonce}`),true);assert.equal(retryGrantsB.subscribe[0].endsWith(`.${retryAttemptB.nonce}`),true);
assert.equal([...retryGrantsA.publish,...retryGrantsA.subscribe,...retryGrantsB.publish,...retryGrantsB.subscribe].some(row=>row.endsWith(".*")||row.endsWith(".>")),false);
const subject=epRequestSubject("task84",{route:{mode:"one"},endpoint:"auth",command:intent.command,caller,nonce:attempt.nonce});
const parsed=parseEpSubject(subject); assert(parsed&&parsed.plane==="request");
const order:string[]=[]; let effects=0;
const exact=Buffer.from(JSON.stringify({ok:true,id:wireId,data:{ver:1,command:intent.command,requestId:intent.requestId,operationId:intent.operationId,target:intent.target,state:"live",targetDigest:"sha256:"+"b".repeat(64),historyHead:"c".repeat(64)}}));
const deps={admit:async({phase}:{phase:string})=>{order.push(phase);},execute:async({wireId:received,finalAdmission}:{wireId:string;finalAdmission():Promise<void>})=>{assert.equal(received,wireId);order.push("execute");await finalAdmission();order.push("effect");effects++;return exact;}};
const out=await handleManagedRowNativeRequest("task84",parsed,Buffer.from(JSON.stringify({id:wireId,intent})),deps);
assert.equal(Buffer.compare(out,exact),0); assert.deepEqual(order,["initial","execute","final","effect"]); assert.equal(effects,1);
for(const bad of [Buffer.from(`{"id":"${wireId}","id":"other","intent":{}}`),Buffer.from("not-json"),Buffer.from(JSON.stringify({id:wireId,intent:{...intent,label:"changed"}}))]){
  const before: number = effects; await assert.rejects(()=>handleManagedRowNativeRequest("task84",parsed,bad,deps)); assert.equal(effects,before);
}
const beforeWrongWireOrder=order.length,beforeWrongWireEffects=effects;
await assert.rejects(()=>handleManagedRowNativeRequest("task84",parsed,Buffer.from(JSON.stringify({id:"nonce-coupled-wire",intent})),deps),/canonical immutable intent/);
assert.equal(order.length,beforeWrongWireOrder);assert.equal(effects,beforeWrongWireEffects);
await assert.rejects(()=>handleManagedRowNativeRequest("task84",parsed,Buffer.from(JSON.stringify({id:wireId,intent})),{...deps,admit:async({phase})=>{if(phase==="initial")throw new Error("initial denied");}})); assert.equal(effects,1);
await assert.rejects(()=>handleManagedRowNativeRequest("task84",parsed,Buffer.from(JSON.stringify({id:wireId,intent})),{...deps,admit:async({phase})=>{if(phase==="final")throw new Error("final denied");}})); assert.equal(effects,1);
await assert.rejects(()=>handleManagedRowNativeRequest("task84",parsed,Buffer.from(JSON.stringify({id:wireId,intent})),{...deps,execute:async()=>Buffer.from(JSON.stringify({ok:true,id:"wrong",data:{}}))}));
let revision=0; const rows=new Map<string,{value:Uint8Array,revision:number,operation:"PUT"}>();
const kv={get:async(key:string)=>rows.get(key)??null,create:async(key:string,value:Uint8Array)=>{if(rows.has(key))throw new Error("key exists");rows.set(key,{value,revision:++revision,operation:"PUT"});return revision;},update:async(key:string,value:Uint8Array,pin:number)=>{const cur=rows.get(key);if(!cur||cur.revision!==pin)throw new Error("wrong last sequence");rows.set(key,{value,revision:++revision,operation:"PUT"});return revision;}};
let projectRelease!:()=>void; const projectGate=new Promise<void>(r=>{projectRelease=r;});let executorEffects=0;
const executor=openManagedRowBrokerExecutor(kv as never,async()=>{},async()=>{await projectGate;executorEffects++;});
const first=executor.execute({wireId,intent,finalAdmission:async()=>{}});
let wrongWireFinalAdmissions=0;
await assert.rejects(()=>executor.execute({wireId:"nonce-coupled-wire",intent,finalAdmission:async()=>{wrongWireFinalAdmissions++;}}),/managed-row in-flight request request_aaaaaaaa conflicts with its retained intent or wire echo/);
assert.equal(executorEffects,0);assert.equal(wrongWireFinalAdmissions,0);
await assert.rejects(()=>executor.execute({wireId,intent:{...intent,label:"different"},finalAdmission:async()=>{}}),/intent/);
projectRelease(); const committed=await first; assert.equal(JSON.parse(new TextDecoder().decode(committed)).id,wireId); await executor.close();
const retryExecutor=openManagedRowBrokerExecutor(kv as never,async()=>{},async()=>{});
const same=await retryExecutor.execute({wireId,intent,finalAdmission:async()=>{throw new Error("committed retry must not re-admit");}});assert.equal(Buffer.compare(same,committed),0);
const revokeIntent={ver:1 as const,command:"revoke-managed-row" as const,requestId:"request_revokeaa",operationId:"manager-teardown:cccccccccccccccccccccccccc",space:"task84",target:intent.target};
const revoked=await retryExecutor.execute({wireId:managedRowWireId(revokeIntent),intent:revokeIntent,finalAdmission:async()=>{}});assert.equal(JSON.parse(new TextDecoder().decode(revoked)).data.state,"tombstone");
const successor={...intent,requestId:"request_successor",operationId:"manager-spawn:dddddddddddddddddddddddddd",target:{...intent.target,lifecycleUid:"dddddddddddddddddddddddddd"}};
const successorBytes=await retryExecutor.execute({wireId:managedRowWireId(successor),intent:successor,finalAdmission:async()=>{}});assert.equal(JSON.parse(new TextDecoder().decode(successorBytes)).data.state,"live");
const staleOldRevoke=await retryExecutor.execute({wireId:managedRowWireId(revokeIntent),intent:revokeIntent,finalAdmission:async()=>{throw new Error("committed stale retry must not re-admit");}});assert.equal(Buffer.compare(staleOldRevoke,revoked),0);
assert.equal((JSON.parse(new TextDecoder().decode(rows.get(`managedrowtarget.${intent.target.owner}.${intent.target.actor}`)!.value)) as {lifecycleUid:string}).lifecycleUid,successor.target.lifecycleUid);
const staleRevoke={...revokeIntent,requestId:"request_staleeee",operationId:"manager-teardown:cccccccccccccccccccccccccc",target:intent.target};
await assert.rejects(()=>retryExecutor.execute({wireId:managedRowWireId(staleRevoke),intent:staleRevoke,finalAdmission:async()=>{}}),/not the retained live owner|absent/);
await retryExecutor.close();

// Source-driven consumer-free recovery. The injected walker is only the explicit stream-read
// collaborator; execute/recover, operation reconstruction, CAS, projection, and result validation
// are the shipped executor.
type Row={value:Uint8Array,revision:number,operation:"PUT"};
const makeKv=(seed?:Map<string,Row>)=>{let rev=Math.max(0,...[...(seed?.values()??[])].map(v=>v.revision));const map=seed??new Map<string,Row>();return {map,kv:{get:async(key:string)=>map.get(key)??null,create:async(key:string,value:Uint8Array)=>{if(map.has(key))throw new Error("key exists");map.set(key,{value,revision:++rev,operation:"PUT"});return rev;},update:async(key:string,value:Uint8Array,pin:number)=>{const cur=map.get(key);if(!cur||cur.revision!==pin)throw new Error("wrong last sequence");map.set(key,{value,revision:++rev,operation:"PUT"});return rev;}}};};
const openEntries=(map:Map<string,Row>)=>async()=>[...map.entries()].filter(([key])=>key.startsWith("managedrowopen.")).map(([key,row])=>({key,...row}));
const enc=(v:unknown)=>new TextEncoder().encode(canonicalJson(v));
const dec=(v:Uint8Array)=>JSON.parse(new TextDecoder().decode(v)) as Record<string,unknown>;

const openOnly=makeKv(); let openOnlyProjected=0;
const crashBeforeEffect=openManagedRowBrokerExecutor(openOnly.kv as never,async()=>{},async()=>{openOnlyProjected++;},openEntries(openOnly.map) as never);
const openOnlyIntent={...intent,requestId:"request_openonly",operationId:"manager-spawn:openonlycccccccccccccccccc"};const openOnlyWireId=managedRowWireId(openOnlyIntent);
await assert.rejects(()=>crashBeforeEffect.execute({wireId:openOnlyWireId,intent:openOnlyIntent,finalAdmission:async()=>{throw new Error("injected pre-CAS death");}}),/injected pre-CAS death/);
assert.equal(openOnlyProjected,0); await crashBeforeEffect.close();
openOnly.map.delete("managedrowop.request_openonly"); // prove embedded operation reconstructs the open-before-op window
const recoverOpenOnly=openManagedRowBrokerExecutor(openOnly.kv as never,async()=>{},async()=>{openOnlyProjected++;},openEntries(openOnly.map) as never);
const recoveredOpen=await recoverOpenOnly.recover(async()=>({finalAdmission:async()=>{}}));
assert.deepEqual(recoveredOpen,{discovered:1,committed:0,recovered:1});assert.equal(openOnlyProjected,1);await recoverOpenOnly.close();

// Simulate death after operation+result commit but before open-index terminalization. Only the exact
// pending→committed transition may differ between the embedded reservation and operation row.
const committedOpen=makeKv(new Map([...openOnly.map].map(([k,v])=>[k,{...v,value:Buffer.from(v.value)}])));
const committedOp=dec(committedOpen.map.get("managedrowop.request_openonly")!.value);
const pendingOp:Record<string,unknown>={...committedOp,state:"pending"};delete pendingOp.resultDigest;
const priorOpen=committedOpen.map.get("managedrowopen.request_openonly")!;
committedOpen.map.set("managedrowopen.request_openonly",{...priorOpen,value:enc({ver:1,requestId:"request_openonly",intentDigest:committedOp.intentDigest,state:"open",operation:pendingOp})});
const recoverCommitted=openManagedRowBrokerExecutor(committedOpen.kv as never,async()=>{},async()=>{throw new Error("committed recovery must not project");},openEntries(committedOpen.map) as never);
assert.deepEqual(await recoverCommitted.recover(async()=>{throw new Error("committed recovery must not adopt");}),{discovered:1,committed:1,recovered:0});
assert.equal(dec(committedOpen.map.get("managedrowopen.request_openonly")!.value).state,"closed");await recoverCommitted.close();

for(const mutate of [
  (o:Record<string,unknown>)=>{o.extra=true;},
  (o:Record<string,unknown>)=>{(o.operation as Record<string,unknown>).wireId="foreign-wire";},
  (o:Record<string,unknown>)=>{o.intentDigest="sha256:"+"0".repeat(64);},
]){
  const bad=makeKv(new Map([...openOnly.map].map(([k,v])=>[k,{...v,value:Buffer.from(v.value)}])));
  const row=bad.map.get("managedrowopen.request_openonly")!;const obj=dec(row.value);mutate(obj);bad.map.set("managedrowopen.request_openonly",{...row,value:enc(obj)});
  const ex=openManagedRowBrokerExecutor(bad.kv as never,async()=>{},async()=>{},openEntries(bad.map) as never);
  await assert.rejects(()=>ex.recover(async()=>({finalAdmission:async()=>{}})),/does not validate|does not match|conflicts/);await ex.close();
}
let adoptedOnWalkFailure=false;const walkFailure=openManagedRowBrokerExecutor(openOnly.kv as never,async()=>{},async()=>{},async()=>{throw new Error("injected mid-walk broker failure");});
await assert.rejects(()=>walkFailure.recover(async()=>{adoptedOnWalkFailure=true;return{finalAdmission:async()=>{}};}),/mid-walk broker failure/);assert.equal(adoptedOnWalkFailure,false);await walkFailure.close();

// A retained result is not trusted merely because its digest matches the operation. Every externally
// observable coordinate is revalidated before exact replay.
const baseOpRow=openOnly.map.get("managedrowop.request_openonly")!;
const baseOp=dec(baseOpRow.value);const baseResultRow=openOnly.map.get("managedrowcommit.request_openonly")!;const baseResult=dec(baseResultRow.value);
const tamperers:[string,(data:Record<string,unknown>)=>void][]=[
  ["state",d=>{d.state="tombstone";}],["targetDigest",d=>{d.targetDigest="sha256:"+"0".repeat(64);}],["historyHead",d=>{d.historyHead="0".repeat(64);}],
  ["requestId",d=>{d.requestId="request_foreign";}],["operationId",d=>{d.operationId="manager-spawn:foreigncccccccccccccccccc";}],["command",d=>{d.command="revoke-managed-row";}],
  ["target",d=>{d.target={...(d.target as Record<string,unknown>),actor:"foreign"};}],
];
for(const [coordinate,tamper] of tamperers){
  const copy=makeKv(new Map([...openOnly.map].map(([k,v])=>[k,{...v,value:Buffer.from(v.value)}])));const result=structuredClone(baseResult);tamper(result.data as Record<string,unknown>);const bytes=enc(result);
  copy.map.set("managedrowcommit.request_openonly",{...baseResultRow,value:bytes});copy.map.set("managedrowop.request_openonly",{...baseOpRow,value:enc({...baseOp,resultDigest:rawDigest(bytes)})});
  const ex=openManagedRowBrokerExecutor(copy.kv as never,async()=>{},async()=>{},openEntries(copy.map) as never);
  await assert.rejects(()=>ex.execute({wireId:openOnlyWireId,intent:openOnlyIntent,finalAdmission:async()=>{}}),new RegExp(`coordinates|wire echo`),coordinate);await ex.close();
}
const grants=authAdminListenerGrants("task84","conn12345",{instanceId:"bbbbbbbbbbbbbbbbbbbbbbbbbb",epoch:0});
assert.equal(grants.subscribe.length,4); assert.equal(grants.subscribe.filter(r=>r.includes("create-managed-row")||r.includes("revoke-managed-row")).length,2); assert.equal(grants.subscribe.every(r=>!r.includes("$KV.")),true);
console.log("TASK84 MANAGED ROW NATIVE REQUEST 21 scenario groups passed, 0 failed; fresh retry nonce/stable wire/literal reply controls passed");
