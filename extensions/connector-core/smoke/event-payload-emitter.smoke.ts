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
