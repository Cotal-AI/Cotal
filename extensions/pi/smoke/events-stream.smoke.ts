/**
 * A Pi reply streams on the event plane, through the REAL `PiEvents`: Pi's `message_update` deltas
 * go into the session's delta journal, the merged source reads them in among the saved session, and
 * the shipped mapper publishes them. Only the mesh is an instrument.
 *
 * Covered: several TEXT_MESSAGE_CONTENT for one message before Pi saves it, and the streamed text
 * plus the rest equal to the saved text; a seat that restarts mid-reply closing the part with the
 * rest of its saved text; a provider retry ending the streamed part and publishing the saved text
 * as its own message; a reply that streamed nothing publishing as it always did; thinking journaled
 * only when reasoning is published, which the `reasoningEvents` launch field turns on, and never the
 * placeholder of a redacted block.
 *
 * Run: pnpm smoke:pi-events-stream
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Part } from "@cotal-ai/core";
import { LAUNCH_MATERIAL_ENV, readLaunchMaterial } from "@cotal-ai/core";
import { eventWalLocation, type AguiEvent, type MeshAgent } from "@cotal-ai/connector-core";
import { piConnector } from "../src/connector.js";
import { PiEvents } from "../src/events.js";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The mesh instrument: a single-replica subject that records every frame. */
class Broker {
  principal = { owner: "local", actor: "pistream" };
  actorIsEphemeral = false;
  maxPayload = 1 << 20;
  seq = 0;
  events: AguiEvent[] = [];
  async assertExpectationSemantics(): Promise<void> {}
  encodedSize(o: unknown): number {
    return Buffer.byteLength(JSON.stringify(o)) + 64;
  }
  async multicastExpecting(o: { parts: Part[]; expectedLastSubjectSeq: number }) {
    if (o.expectedLastSubjectSeq !== this.seq) throw new Error(`expectation ${o.expectedLastSubjectSeq} is not the tip ${this.seq}`);
    this.seq++;
    for (const p of o.parts) this.events.push(...((p as unknown as { events?: AguiEvent[] }).events ?? []));
    return { ack: { seq: this.seq, duplicate: false } };
  }
}

const roots: string[] = [];
const T = 1_795_500_000_000;

function rig(session: string, reasoning = false, root = mkdtempSync(join(tmpdir(), "pi-events-stream-")), broker = new Broker()) {
  roots.push(root);
  process.env.COTAL_WORKSPACE_ROOT = root;
  const mesh = { ep: broker, waitUntilConnected: async () => {} } as unknown as MeshAgent;
  const errors: string[] = [];
  const events = new PiEvents(mesh, "plane", (error) => errors.push(error.message), false, reasoning);
  const path = join(root, `${session}.jsonl`);
  const text = (delta: string, index = 0, ts = T) => events.delta({ type: "text_delta", contentIndex: index, delta, partial: { timestamp: ts } });
  /** Pi writes the session file at its first saved reply, header and prompt included. */
  const saved = (id: string, content: unknown[], ts = T) => {
    events.settle();
    appendFileSync(path,
      `${JSON.stringify({ type: "session", id: session })}\n${JSON.stringify({ type: "message", id: `${id}-user`, message: { role: "user", content: "hi", timestamp: ts - 1 } })}\n` +
      `${JSON.stringify({ type: "message", id, timestamp: new Date(ts).toISOString(), message: { role: "assistant", content, stopReason: "stop", timestamp: ts } })}\n`);
  };
  const flush = async () => {
    events.flush(session, path);
    await (events as unknown as { pending: Promise<void> }).pending;
    await (events as unknown as { holder?: { settled(): Promise<void> } }).holder?.settled();
  };
  /** Wait for the journal's next line and the pump it wakes. */
  const streamed = async () => {
    await sleep(400);
    await flush();
  };
  const of = (type: string, messageId?: string) => broker.events.filter((e) => e.type === type && (messageId === undefined || (e as { messageId?: string }).messageId === messageId));
  const content = (messageId: string) => of("TEXT_MESSAGE_CONTENT", messageId).map((e) => (e as { delta: string }).delta);
  return { root, broker, events, errors, path, session, text, saved, flush, streamed, of, content };
}

console.log("a reply streams before Pi saves it");
{
  const r = rig("fresh");
  await r.events.start(r.session, r.path, true);
  const key = `${T}:text:0`;
  r.text("The answer ");
  await r.streamed();
  check("the first delta opens the run and the message", r.of("RUN_STARTED").length === 1 && r.of("TEXT_MESSAGE_START", key).length === 1, { errors: r.errors, events: r.broker.events.map((e) => e.type) });
  r.text("is ");
  await r.streamed();
  r.text("forty");
  await r.streamed();
  check("each journal line publishes content for the same message", JSON.stringify(r.content(key)) === JSON.stringify(["The answer ", "is ", "forty"]), r.content(key));
  r.text("-two, never journaled");
  r.saved("m1", [{ type: "text", text: "The answer is forty-two." }]);
  await r.flush();
  const all = r.content(key).join("");
  check("the saved reply sends the rest and ends the message", all === "The answer is forty-two." && r.of("TEXT_MESSAGE_END", key).length === 1, all);
  check("no second message is published for the saved part", r.of("TEXT_MESSAGE_START").length === 1 && r.of("RUN_FINISHED").length === 1);
  check("the run spans the stream and the saved reply", r.broker.events[0]?.type === "RUN_STARTED" && r.broker.events.at(-1)?.type === "RUN_FINISHED");
  check("no error", r.errors.length === 0, r.errors);
  const journal = eventWalLocation({ workspaceRoot: r.root, space: "plane", principal: "local.pistream", threadId: r.session }).deltaJournalPath;
  check("the journal sits next to the WAL, readable only by its owner", readFileSync(journal, "utf8").includes("The answer") && (statSync(journal).mode & 0o777) === 0o600);
  await r.events.shutdown();
}

console.log("a seat restarted mid-reply");
{
  const first = rig("restart");
  await first.events.start(first.session, first.path, true);
  const key = `${T}:text:0`;
  first.text("Half ");
  await first.streamed();
  first.text("way ");
  await first.streamed();
  await first.events.shutdown();
  const second = rig("restart", false, first.root, first.broker);
  await second.events.start(second.session, second.path, true);
  second.saved("m1", [{ type: "text", text: "Half way there." }]);
  await second.flush();
  check("the restarted seat closes the part with the rest of its saved text",
    second.content(key).join("") === "Half way there." && second.of("TEXT_MESSAGE_END", key).length === 1 && second.of("TEXT_MESSAGE_START").length === 1,
    { content: second.content(key), errors: second.errors });
  await second.events.shutdown();
}

console.log("a provider retry");
{
  const r = rig("retry");
  await r.events.start(r.session, r.path, true);
  const key = `${T}:text:0`;
  r.text("Hello wor");
  await r.streamed();
  r.saved("m1", [{ type: "text", text: "Goodbye." }]);
  await r.flush();
  const order = r.broker.events.map((e) => `${e.type}:${(e as { messageId?: string }).messageId ?? ""}`);
  check("the streamed part ends and the saved text is a message of its own",
    order.join() === [`RUN_STARTED:`, `TEXT_MESSAGE_START:${key}`, `TEXT_MESSAGE_CONTENT:${key}`, `TEXT_MESSAGE_END:${key}`,
      "TEXT_MESSAGE_START:m1:text:0", "TEXT_MESSAGE_CONTENT:m1:text:0", "TEXT_MESSAGE_END:m1:text:0", "RUN_FINISHED:"].join(), order);
  check("the abandoned text shows once and the saved text in full", r.content(key).join("") === "Hello wor" && r.content("m1:text:0").join("") === "Goodbye.");
  await r.events.shutdown();
}

console.log("a reply that streamed nothing");
{
  const r = rig("quiet");
  await r.events.start(r.session, r.path, true);
  r.saved("m1", [{ type: "text", text: "Saved only." }]);
  await r.flush();
  check("publishes from its saved record as before", r.broker.events.map((e) => e.type).join() ===
    "RUN_STARTED,TEXT_MESSAGE_START,TEXT_MESSAGE_CONTENT,TEXT_MESSAGE_END,RUN_FINISHED" && r.content("m1:text:0").join("") === "Saved only.", r.broker.events);
  await r.events.shutdown();
}

console.log("thinking");
{
  const think = (r: ReturnType<typeof rig>) => r.events.delta({ type: "thinking_delta", contentIndex: 0, delta: "Let me check", partial: { timestamp: T } });
  const off = rig("think-off");
  await off.events.start(off.session, off.path, true);
  think(off);
  off.text("Answer.", 1);
  await off.streamed();
  check("is not journaled while reasoning is off", off.of("REASONING_MESSAGE_START").length === 0 && off.of("TEXT_MESSAGE_START").length === 1);
  await off.events.shutdown();
  const on = rig("think-on", true);
  await on.events.start(on.session, on.path, true);
  think(on);
  await on.streamed();
  on.saved("m1", [{ type: "thinking", thinking: "Let me check the file." }, { type: "text", text: "Done." }]);
  await on.flush();
  const reasoning = on.broker.events.filter((e) => e.type === "REASONING_MESSAGE_CONTENT").map((e) => (e as { delta: string }).delta).join("");
  check("streams as reasoning when it is published", reasoning === "Let me check the file." && on.of("REASONING_MESSAGE_START").length === 1, reasoning);
  await on.events.shutdown();
  // Pi's Bedrock provider streams this placeholder as a thinking delta once a block turns redacted.
  const redacted = rig("think-redacted", true);
  await redacted.events.start(redacted.session, redacted.path, true);
  redacted.events.delta({ type: "thinking_delta", contentIndex: 0, delta: "[Reasoning redacted]", partial: { timestamp: T, content: [{ type: "thinking", redacted: true }] } });
  redacted.text("Done.", 1);
  await redacted.streamed();
  redacted.saved("m1", [{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true }, { type: "text", text: "Done." }]);
  await redacted.flush();
  check("a redacted block's placeholder is never published", redacted.of("REASONING_MESSAGE_START").length === 0 &&
    redacted.content(`${T}:text:1`).join("") === "Done." && redacted.errors.length === 0, { events: redacted.broker.events.map((e) => e.type), errors: redacted.errors });
  await redacted.events.shutdown();
}

console.log("the reasoningEvents launch field");
{
  const material = (reasoningEvents?: boolean) =>
    readLaunchMaterial(piConnector.buildLaunch({ space: "test", name: "pi", events: false, creds: "creds", ...(reasoningEvents ? { reasoningEvents } : {}) }).env![LAUNCH_MATERIAL_ENV]!);
  check("pi declares reasoningEvents", piConnector.supportsReasoningEvents === true);
  check("a launch with it carries the field to the seat", material(true).reasoningEvents === true);
  check("a launch without it carries nothing", material().reasoningEvents === undefined);
}

for (const root of roots) rmSync(root, { recursive: true, force: true });
console.log(`\npi-events-stream smoke: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
