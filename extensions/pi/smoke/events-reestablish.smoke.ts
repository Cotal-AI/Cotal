/**
 * The pi adapter's event plane comes back after an outage, through the REAL `PiEvents` start
 * factory re-entered by the holder's re-establish: the session source, the pi mapper, the
 * write-ahead log and the emitter. Only the mesh is an instrument. Two defects of the first cut,
 * both found by review on 2026-10-12 and both reproduced here before the fix:
 *
 *   A. a NEW native session (no file at start) could never re-establish: the factory read the
 *      acknowledged cursor as proof the file had vanished, without looking at the file;
 *   B. the mapper was rebuilt from the log's acknowledged brackets rather than the pending frame's,
 *      so a tool call the frozen frame opened was unknown to the plane that came back, its result
 *      was dropped, and the terminal tried to open a second run.
 */
import { mkdtempSync, writeFileSync, appendFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Part } from "@cotal-ai/core";
import type { MeshAgent } from "@cotal-ai/connector-core";
import { PiEvents } from "../src/events.js";

let ok = 0,
  fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++;
  else {
    fail++;
    console.log("  x FAIL:", n, extra ?? "");
  }
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The mesh instrument: a single-replica subject with a scriptable network fault. */
class Broker {
  principal = { owner: "local", actor: "pitester" };
  actorIsEphemeral = false;
  maxPayload = 1 << 20;
  seq = 0;
  failNext = 0;
  frames: string[] = [];
  async assertExpectationSemantics(): Promise<void> {}
  encodedSize(o: { channel: string; parts: Part[]; id: string; expectedLastSubjectSeq: number }): number {
    return Buffer.byteLength(JSON.stringify(o)) + 64;
  }
  async multicastExpecting(o: { channel: string; parts: Part[]; id: string; expectedLastSubjectSeq: number }) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("network: connection reset before send");
    }
    if (o.expectedLastSubjectSeq !== this.seq) throw new Error(`expectation ${o.expectedLastSubjectSeq} is not the tip ${this.seq}`);
    this.seq++;
    this.frames.push(JSON.stringify(o.parts));
    return { ack: { seq: this.seq, duplicate: false } };
  }
}

const roots: string[] = [];

/** One workspace root per rig: the subject frontier is per principal, and the rigs share one. */
function rig(session: string) {
  const root = mkdtempSync(join(tmpdir(), "pi-events-reestablish-"));
  roots.push(root);
  process.env.COTAL_WORKSPACE_ROOT = root;
  const broker = new Broker();
  const mesh = { ep: broker, waitUntilConnected: async () => {} } as unknown as MeshAgent;
  const stops: (number | null)[] = [];
  const errors: string[] = [];
  const events = new PiEvents(mesh, "plane", (error, retryInMs) => {
    errors.push(error.message);
    stops.push(retryInMs);
  });
  const path = join(root, `${session}.jsonl`);
  let n = 0;
  const assistant = (content: Array<{ type: string; text?: string; id?: string; name?: string }>, stopReason: string) => {
    n++;
    appendFileSync(path, JSON.stringify({ type: "message", id: `m${n}`, timestamp: new Date().toISOString(), message: { role: "assistant", content, stopReason, timestamp: Date.now() } }) + "\n");
  };
  const toolResult = (toolCallId: string) => {
    n++;
    appendFileSync(path, JSON.stringify({ type: "message", id: `r${n}`, timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId, timestamp: Date.now() } }) + "\n");
  };
  // `flush` queues on the adapter's own chain; the chain is awaited through the holder it adopted.
  const flush = async () => {
    events.flush(session, path);
    await (events as unknown as { pending: Promise<void> }).pending;
    await (events as unknown as { holder?: { settled(): Promise<void> } }).holder?.settled();
  };
  const frames_has = (text: string) => broker.frames.some((f) => f.includes(text));
  return { broker, events, stops, errors, path, assistant, toolResult, flush, session, frames_has };
}

// ---- A. a new native session re-establishes ----------------------------------------------------
{
  const r = rig("fresh");
  await r.events.start(r.session, r.path, true); // no file yet: pi creates it with the first save
  r.assistant([{ type: "text", text: "first answer" }], "stop");
  await r.flush();
  c("A:CONTROL-the-first-turn-published", r.broker.seq === 1 && r.stops.length === 0, { seq: r.broker.seq, stops: r.stops, errors: r.errors });
  r.broker.failNext = 1;
  r.assistant([{ type: "text", text: "second answer" }], "stop");
  await r.flush();
  c("A:CONTROL-the-second-turn-failed-on-the-wire", r.broker.seq === 1 && r.stops.length === 1 && r.stops[0] === 0, { seq: r.broker.seq, stops: r.stops });
  await sleep(1400); // the holder's first re-establish is one second out
  await r.flush();
  c("A:the-re-establish-does-NOT-read-the-acknowledged-cursor-as-a-vanished-file", !r.errors.some((e) => e.includes("vanished")) && existsSync(r.path), r.errors);
  c("A:the-turn-written-under-the-fault-is-published-after-it", r.broker.seq === 2 && r.frames_has("second answer"), { seq: r.broker.seq });
  r.assistant([{ type: "text", text: "third answer" }], "stop");
  await r.flush();
  c("A:a-later-turn-publishes-on-the-re-established-plane", r.broker.seq === 3 && r.stops.length === 1, { seq: r.broker.seq, stops: r.stops });
  await r.events.shutdown();
}

// ---- B. the frozen frame opened a tool call ----------------------------------------------------
{
  const r = rig("tools");
  writeFileSync(r.path, "");
  await r.events.start(r.session, r.path, false); // an existing (empty) native file
  r.broker.failNext = 1;
  r.assistant([{ type: "toolCall", id: "tool-1", name: "read" }], "toolUse"); // opens the run and tool-1
  await r.flush();
  c("B:CONTROL-the-tool-call-frame-failed-on-the-wire", r.broker.seq === 0 && r.stops.length === 1, { seq: r.broker.seq, stops: r.stops, errors: r.errors });
  await sleep(1400);
  await r.flush();
  c("B:the-frozen-frame-is-published-once-the-network-is-back", r.broker.seq === 1 && r.frames_has("TOOL_CALL_START"), { seq: r.broker.seq, errors: r.errors });
  r.toolResult("tool-1");
  await r.flush();
  c("B:the-tool-result-closes-the-call-the-frozen-frame-opened", r.broker.seq === 2 && r.frames_has("TOOL_CALL_END"), { seq: r.broker.seq, errors: r.errors });
  r.assistant([{ type: "text", text: "done" }], "stop");
  await r.flush();
  c("B:the-terminal-closes-the-run-the-frozen-frame-opened", r.broker.seq === 3 && r.frames_has("RUN_FINISHED") && r.stops.length === 1, { seq: r.broker.seq, stops: r.stops, errors: r.errors });
  await r.events.shutdown();
}

for (const root of roots) rmSync(root, { recursive: true, force: true });
console.log(`pi-events-reestablish smoke: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
