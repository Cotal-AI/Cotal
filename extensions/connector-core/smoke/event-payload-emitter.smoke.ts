import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memorySubjectFrontier } from "@cotal-ai/smoke-kit";
import type { Part } from "@cotal-ai/core";
import { AguiEmitter, type EmitterEndpoint } from "../src/agui-emitter.js";
import { EventWal } from "../src/event-wal.js";
import { JsonlFileSource } from "../src/durable-source.js";
import { runStarted, toolCallStart, toolCallArgs, toolCallEnd, toolCallResult, toolResultMarker } from "../src/agui.js";
const root = await mkdtemp(join(tmpdir(), "payload-emitter-"));
await mkdir(join(root,"thread"));
const path = join(root,"thread","wal.json"), src=join(root,"source.jsonl");
await writeFile(src,"");
const calls: {rail:string;parts:Part[]}[]=[];
const ep: EmitterEndpoint = {
 principal:{owner:"local",actor:"seat"},actorIsEphemeral:false,maxPayload:10000,
 assertExpectationSemantics:async()=>{},eventPayloadLimit:async()=>1500,
 encodedSize:o=>Buffer.byteLength(JSON.stringify(o))+100,
 multicastExpecting:async o=>{calls.push({rail:"public",parts:o.parts});return {ack:{seq:2,duplicate:false}};},
 publishEventPayload:async o=>{calls.push({rail:"payload",parts:o.parts});return {ack:{seq:1,duplicate:false}};},
};
const wal=await EventWal.open(path,{space:"payload",threadId:"native",principal:"local.seat",subjectMayExist:false});
const emitter=await AguiEmitter.start({endpoint:ep,wal,subjectFrontier:memorySubjectFrontier(),source:new JsonlFileSource(src),map:()=>({runId:"run",events:[runStarted({threadId:"native",runId:"run",timestamp:1}),toolCallStart({toolCallId:"call",toolCallName:"bash",timestamp:2}),toolCallArgs({toolCallId:"call",delta:'{"command":"printf test"}',timestamp:2}),toolCallEnd({toolCallId:"call",timestamp:3}),toolCallResult({messageId:"result",toolCallId:"call",content:"x".repeat(10000),timestamp:3}),toolResultMarker({toolCallId:"call",isError:false,timestamp:3})]})});
await emitter.pump();
await writeFile(src,'{}\n');
await emitter.pump();
assert.deepEqual(calls.map(c=>c.rail),["payload","public"]);
assert.ok(JSON.stringify(calls[0]).includes("cotalPayloadCut"));
assert.ok(JSON.stringify(calls[0]).includes("sha256"));
assert.ok(!JSON.stringify(calls[1]).includes("TOOL_CALL_ARGS"));
assert.ok(!JSON.stringify(calls[1]).includes("TOOL_CALL_RESULT"));
assert.equal(wal.pending,null);
console.log("PASS sibling payload before public commit, whole-body cut marker, public fence retained");
const ownRoot=await mkdtemp(join(tmpdir(),"payload-own-"));
await mkdir(join(ownRoot,"thread"));
const ownSrc=join(ownRoot,"source.jsonl"); await writeFile(ownSrc,"");
const ownWal=await EventWal.open(join(ownRoot,"thread","wal.json"),{space:"payload",threadId:"native",principal:"local.seat",subjectMayExist:false});
calls.length=0;
const ownEmitter=await AguiEmitter.start({endpoint:ep,wal:ownWal,subjectFrontier:memorySubjectFrontier(),source:new JsonlFileSource(ownSrc),map:()=>({runId:"run",events:[runStarted({threadId:"native",runId:"run",timestamp:1}),toolCallStart({toolCallId:"own",toolCallName:"mcp__cotal__cotal_spawn",timestamp:2}),toolCallArgs({toolCallId:"own",delta:'{"launch":"credential-canary"}',timestamp:2}),toolCallEnd({toolCallId:"own",timestamp:3}),toolCallResult({messageId:"result",toolCallId:"own",content:"credential-canary",timestamp:3}),toolResultMarker({toolCallId:"own",isError:false,timestamp:3})]})});
await ownEmitter.pump(); await writeFile(ownSrc,'{}\n'); await ownEmitter.pump();
assert.deepEqual(calls.map(c=>c.rail),["public"]);
assert.ok(!JSON.stringify(calls).includes("credential-canary"));
assert.deepEqual(ownWal.payloadCalls,{});
console.log("PASS catalog-identified own-tool args and launch result excluded");
const withheldRoot=await mkdtemp(join(tmpdir(),"payload-withheld-"));
await mkdir(join(withheldRoot,"thread"));
const withheldSrc=join(withheldRoot,"source.jsonl"); await writeFile(withheldSrc,"");
const withheldWal=await EventWal.open(join(withheldRoot,"thread","wal.json"),{space:"payload",threadId:"native",principal:"local.seat",subjectMayExist:false});
calls.length=0;
const withheld=await AguiEmitter.start({endpoint:ep,withholdPayloads:true,wal:withheldWal,subjectFrontier:memorySubjectFrontier(),source:new JsonlFileSource(withheldSrc),map:()=>({runId:"run",events:[runStarted({threadId:"native",runId:"run",timestamp:1}),toolCallStart({toolCallId:"call",toolCallName:"bash",timestamp:2}),toolCallArgs({toolCallId:"call",delta:"withheld-input",timestamp:2}),toolCallEnd({toolCallId:"call",timestamp:3}),toolCallResult({messageId:"result",toolCallId:"call",content:"withheld-output",timestamp:3}),toolResultMarker({toolCallId:"call",isError:false,timestamp:3})]})});
await withheld.pump(); await writeFile(withheldSrc,'{}\n'); await withheld.pump();
assert.deepEqual(calls.map(c=>c.rail),["public"]);
assert.ok(!JSON.stringify(calls).includes("withheld-input"));
assert.ok(!JSON.stringify(calls).includes("withheld-output"));
console.log("PASS explicit withholding retains public status only");

for (const mode of ["missing-api", "missing-stream", "error"] as const) {
  const legacyRoot = await mkdtemp(join(tmpdir(), "payload-legacy-"));
  await mkdir(join(legacyRoot, "thread"));
  const legacySrc = join(legacyRoot, "source.jsonl");
  await writeFile(legacySrc, "");
  const legacyWal = await EventWal.open(join(legacyRoot, "thread", "wal.json"), { space: "payload", threadId: "native", principal: "local.seat", subjectMayExist: false });
  const failure = new Error("authorization/network/config sentinel");
  const legacyEp: EmitterEndpoint = { ...ep, eventPayloadLimit: mode === "missing-api" ? undefined : async () => { if (mode === "error") throw failure; return null; }, publishEventPayload: mode === "missing-api" ? undefined : ep.publishEventPayload };
  calls.length = 0;
  const start = () => AguiEmitter.start({ endpoint: legacyEp, wal: legacyWal, subjectFrontier: memorySubjectFrontier(), source: new JsonlFileSource(legacySrc), map: () => ({ runId: "run", events: [runStarted({ threadId: "native", runId: "run", timestamp: 1 }), toolCallStart({ toolCallId: "call", toolCallName: "bash", timestamp: 2 }), toolCallArgs({ toolCallId: "call", delta: "legacy-private-input", timestamp: 2 }), toolCallEnd({ toolCallId: "call", timestamp: 3 }), toolCallResult({ messageId: "result", toolCallId: "call", content: "legacy-private-output", timestamp: 3 })] }) });
  if (mode === "error") {
    await assert.rejects(start, error => error === failure);
    assert.equal(calls.length, 0);
    continue;
  }
  const legacy = await start();
  await legacy.pump(); await writeFile(legacySrc, "{}\n"); await legacy.pump();
  assert.deepEqual(calls.map(call => call.rail), ["public"]);
  assert.ok(JSON.stringify(calls).includes("bash"));
  assert.ok(!JSON.stringify(calls).includes("legacy-private"));
  assert.deepEqual(legacyWal.payloadCalls, {});
  // A missing rail must not fold a frozen sibling, even if both acknowledgements are durable.
  for (const acked of [false, true]) {
    const frozenWal = await EventWal.open(join(legacyRoot, "thread", `frozen-${acked}.json`), { space: "payload", threadId: "native", principal: "local.seat", subjectMayExist: false });
    const frontier = memorySubjectFrontier();
    await frozenWal.bindSubjectFrontier(frontier);
    await frozenWal.beginSend({ id: `frozen${acked}`, E: 0, seq: 1, sourceCursor: "frozen-cursor", body: [{ kind: "text", text: "status" }], brackets: { run: undefined, text: [], reasoning: [], tools: [] }, payload: { id: `sibling${acked}`, E: 0, body: [{ kind: "text", text: "private" }] } });
    if (acked) { await frozenWal.recordPayloadAck(1); await frozenWal.recordAck(3); }
    const pending = JSON.stringify(frozenWal.pending);
    await assert.rejects(() => AguiEmitter.start({ endpoint: legacyEp, wal: frozenWal, subjectFrontier: frontier, source: new JsonlFileSource(legacySrc), map: () => null }), /previously frozen sibling payload requires an available/);
    assert.equal(JSON.stringify(frozenWal.pending), pending);
  }
}
console.log("PASS legacy adapters and missing streams preserve metadata, failures propagate, frozen siblings refuse recovery");

const sharedRoot = await mkdtemp(join(tmpdir(), "payload-shared-"));
let payloadTip = 0;
let publicTip = 0;
const sharedFrontier = memorySubjectFrontier();
const sharedEp: EmitterEndpoint = { ...ep,
  publishEventPayload: async o => { assert.equal(o.expectedLastSubjectSeq, payloadTip); return { ack: { seq: ++payloadTip, duplicate: false } }; },
  multicastExpecting: async o => { assert.equal(o.expectedLastSubjectSeq, publicTip); return { ack: { seq: ++publicTip, duplicate: false } }; },
};
for (const threadId of ["first", "second"]) {
  await mkdir(join(sharedRoot, threadId));
  const sourcePath = join(sharedRoot, threadId, "source.jsonl");
  await writeFile(sourcePath, "");
  const threadWal = await EventWal.open(join(sharedRoot, threadId, "wal.json"), { space: "payload", threadId, principal: "local.seat", subjectMayExist: false });
  const threadEmitter = await AguiEmitter.start({ endpoint: sharedEp, wal: threadWal, subjectFrontier: sharedFrontier, source: new JsonlFileSource(sourcePath), map: () => ({ runId: "run", events: [runStarted({ threadId, runId: "run", timestamp: 1 }), toolCallStart({ toolCallId: "call", toolCallName: "bash", timestamp: 2 }), toolCallArgs({ toolCallId: "call", delta: "input", timestamp: 2 }), toolCallEnd({ toolCallId: "call", timestamp: 3 })] }) });
  await threadEmitter.pump(); await writeFile(sourcePath, "{}\n"); await threadEmitter.pump();
}
assert.equal(payloadTip, 2);
console.log("PASS same space/principal sibling threads share payload subject frontier");
