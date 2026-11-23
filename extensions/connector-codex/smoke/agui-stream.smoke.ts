/**
 * A Codex reply and reasoning summary stream on the event plane from the delta journal, and the saved
 * record closes each.
 *
 * The host journals each `item/agentMessage/delta` and `item/reasoning/summaryTextDelta` under
 * `stream:<item id>`, and the item id is the `id` of the record Codex saves. These cells write the rollout and the journal lines by hand,
 * each line anchored at the rollout's end as the journal anchors it, and read them through the
 * shipped mapper, the shared merged source and the shared emitter over a fake endpoint. No broker
 * is started.
 *
 * Run: pnpm smoke:agui-codex-stream
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Part } from "@cotal-ai/core";
import {
  AguiEmitter, DeltaMergedSource, EventWal, JsonlFileSource, streamSeed,
  type AguiEvent, type DeltaRecord, type EmitterEndpoint, type Merged,
} from "@cotal-ai/connector-core";
import { emitSentinel, memorySubjectFrontier } from "@cotal-ai/smoke-kit";
import { codexStreamKey, createCodexMapper, type CodexRecord } from "../src/agui-map.js";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};

const at = (ms: number) => new Date(Date.UTC(2026, 10, 23, 12, 0, 0, ms)).toISOString();
const started = (turn: string): CodexRecord => ({ timestamp: at(0), type: "event_msg", payload: { type: "task_started", turn_id: turn } });
const saved = (id: string, text: string): CodexRecord =>
  ({ timestamp: at(500), type: "response_item", payload: { type: "message", role: "assistant", id, content: [{ type: "output_text", text }] } });
const complete = (turn: string): CodexRecord => ({ timestamp: at(900), type: "event_msg", payload: { type: "task_complete", turn_id: turn, error: null } });
const reasoning = (id: string, text: string): CodexRecord =>
  ({ timestamp: at(300), type: "response_item", payload: { type: "reasoning", id, summary: [{ type: "summary_text", text }], encrypted_content: "opaque" } });
const aborted = (turn: string): CodexRecord => ({ timestamp: at(900), type: "event_msg", payload: { type: "turn_aborted", turn_id: turn, reason: "interrupted" } });

/** One step of a script: a rollout record, a journal line of `[item id, text]` reply deltas or
 *  reasoning deltas, a line that ends streams, or a restart of the emitter. Every step is read on
 *  its own. */
type Step = { record: CodexRecord } | { deltas: [string, string][] } | { thinking: [string, string][] } | { ends: string[] } | "restart" | "closeRun";

/** `reasoning` is the launch's `reasoningEvents`. */
async function publish(script: Step[], reasoning = true) {
  const root = mkdtempSync(join(tmpdir(), "cotal-codex-stream-"));
  const published: AguiEvent[] = [];
  const events = (parts: Part[]) => parts.flatMap((p) => ((p as unknown as { events?: AguiEvent[] }).events ?? []));
  const ep: EmitterEndpoint = {
    principal: { owner: "local", actor: "seat" }, actorIsEphemeral: false, maxPayload: 100_000,
    assertExpectationSemantics: async () => {}, eventPayloadLimit: async () => 100_000,
    encodedSize: (o) => Buffer.byteLength(JSON.stringify(o)) + 100,
    multicastExpecting: async (o) => { published.push(...events(o.parts)); return { ack: { seq: published.length, duplicate: false } }; },
    publishEventPayload: async () => ({ ack: { seq: 0, duplicate: false } }),
  };
  try {
    mkdirSync(join(root, "thread"));
    const rollout = join(root, "rollout.jsonl");
    const journal = join(root, "thread", "deltas.jsonl");
    writeFileSync(rollout, "");
    writeFileSync(journal, "", { mode: 0o600 });
    const harness = new JsonlFileSource<CodexRecord>(rollout);
    const source = new DeltaMergedSource(harness, journal);
    const frontier = memorySubjectFrontier();
    let run = 0;
    let ts = 1_000;
    const line = (r: Omit<DeltaRecord, "anchor" | "ts">) => appendFileSync(journal, `${JSON.stringify({ anchor: harness.endSync(), ts: ts++, ...r })}\n`);
    // As the host's binding starts an emitter: the mapper resumes the run and the streams the log
    // has open, from the bracket state and the journal up to the log's cursor.
    const start = async () => {
      const wal = await EventWal.open(join(root, "thread", "wal.json"), { space: "codex", threadId: "thread", principal: "local.seat", subjectMayExist: false });
      if (wal.frontier.sourceCursor === undefined) await wal.advanceCursorOnly(source.start(harness.endSync()));
      const brackets = wal.pending === null ? wal.brackets : wal.pending.brackets;
      const cursor = wal.pending === null ? wal.frontier.sourceCursor : wal.pending.sourceCursor;
      const mapper = createCodexMapper({ threadId: "thread", mintRunId: () => `run-${++run}`, resumeRunId: brackets?.run, seed: await streamSeed(journal, cursor, brackets), reasoning });
      return AguiEmitter.start<Merged<CodexRecord>>({ endpoint: ep, wal, subjectFrontier: frontier, source, map: mapper.mapMerged });
    };
    let emitter = await start();
    const errors: string[] = [];
    for (const step of script) {
      if (step === "restart") emitter = await start();
      else if (step === "closeRun") await emitter.closeRun({ timestamp: ts++ }).catch((e: Error) => errors.push(e.message));
      else if ("record" in step) appendFileSync(rollout, `${JSON.stringify(step.record)}\n`);
      else if ("deltas" in step) line({ deltas: step.deltas.map(([id, text]) => ({ key: codexStreamKey(id), kind: "text", text })) });
      else if ("thinking" in step) line({ deltas: step.thinking.map(([id, text]) => ({ key: codexStreamKey(id), kind: "reasoning", text })) });
      else line({ deltas: [], ends: step.ends.map(codexStreamKey) });
      await emitter.pump().catch((e: Error) => errors.push(e.message));
    }
    return { events: published, errors };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The public events as `TYPE` or `TYPE(messageId)`, and the text each message carried. */
function summary(p: Awaited<ReturnType<typeof publish>>) {
  const text = new Map<string, string>();
  for (const e of p.events) {
    const m = e as { messageId?: string; delta?: string };
    if (e.type === "TEXT_MESSAGE_CONTENT" || e.type === "REASONING_MESSAGE_CONTENT") text.set(m.messageId!, (text.get(m.messageId!) ?? "") + m.delta);
  }
  const types = p.events.map((e) => {
    const id = (e as { messageId?: string }).messageId;
    return id !== undefined && e.type.includes("_MESSAGE_") ? `${e.type}(${id})` : e.type;
  });
  return { types, text: Object.fromEntries(text), errors: p.errors };
}
const count = (types: string[], t: string) => types.filter((x) => x === t).length;

console.log("A reply that streamed, then was saved");
const streamed = summary(await publish([
  { record: started("t1") }, { deltas: [["m1", "Hel"], ["m1", "lo "]] }, { deltas: [["m1", "wor"]] },
  { record: saved("m1", "Hello world") }, { deltas: [["m1", "ld"]] }, { record: complete("t1") },
]));
check("its text is published from the journal before the saved record, under the stream key",
  JSON.stringify(streamed.types.slice(0, 4)) === JSON.stringify(["RUN_STARTED", "TEXT_MESSAGE_START(stream:m1)", "TEXT_MESSAGE_CONTENT(stream:m1)", "TEXT_MESSAGE_CONTENT(stream:m1)"]), streamed);
check("the saved record sends only the rest and ends it, so the wire carries the saved text once",
  streamed.text["stream:m1"] === "Hello world" && count(streamed.types, "TEXT_MESSAGE_START(stream:m1)") === 1 && count(streamed.types, "TEXT_MESSAGE_END(stream:m1)") === 1, streamed);
check("the saved message is not published again under its own id", !streamed.types.some((t) => t.endsWith("(m1)")), streamed.types);
check("a line written after the save publishes nothing, and the run finishes", streamed.types.at(-1) === "RUN_FINISHED" && streamed.errors.length === 0, streamed);

console.log("A reply that never streamed");
const whole = summary(await publish([{ record: started("t1") }, { record: saved("m1", "Hi") }, { record: complete("t1") }]));
check("maps whole under its own id", JSON.stringify(whole.types) ===
  JSON.stringify(["RUN_STARTED", "TEXT_MESSAGE_START(m1)", "TEXT_MESSAGE_CONTENT(m1)", "TEXT_MESSAGE_END(m1)", "RUN_FINISHED"]), whole);

console.log("A saved text that does not continue what streamed");
const retried = summary(await publish([
  { record: started("t1") }, { deltas: [["m1", "Draft"]] }, { record: saved("m1", "Final answer") }, { record: complete("t1") },
]));
check("ends the stream, then publishes the saved text as its own message",
  JSON.stringify(retried.types) === JSON.stringify(["RUN_STARTED", "TEXT_MESSAGE_START(stream:m1)", "TEXT_MESSAGE_CONTENT(stream:m1)", "TEXT_MESSAGE_END(stream:m1)",
    "TEXT_MESSAGE_START(m1)", "TEXT_MESSAGE_CONTENT(m1)", "TEXT_MESSAGE_END(m1)", "RUN_FINISHED"]) && retried.text.m1 === "Final answer", retried);

console.log("A line read before its turn's run opened");
const early = summary(await publish([
  { deltas: [["m1", "Hel"]] }, { record: started("t1") }, { deltas: [["m1", "lo"]] }, { record: saved("m1", "Hello") }, { record: complete("t1") },
]));
check("publishes nothing, and the message never opens partway through its text",
  !early.types.some((t) => t.includes("stream:")) && early.text.m1 === "Hello" && early.errors.length === 0, early);

console.log("A turn interrupted while its reply streamed");
const interrupted = summary(await publish([{ record: started("t1") }, { deltas: [["m1", "Half a re"]] }, { record: aborted("t1") }]));
check("the stream ends before the run's terminal",
  JSON.stringify(interrupted.types.slice(-2)) === JSON.stringify(["TEXT_MESSAGE_END(stream:m1)", "RUN_FINISHED"]) && interrupted.errors.length === 0, interrupted);

console.log("A reasoning summary that streamed, then a reply that streamed");
const thought = summary(await publish([
  { record: started("t1") }, { thinking: [["rs1", "Weigh "], ["rs1", "the rivers"]] }, { record: reasoning("rs1", "Weigh the rivers.") },
  { deltas: [["m1", "The Nile"]] }, { record: saved("m1", "The Nile is longer.") }, { record: complete("t1") },
]));
check("the summary streams as reasoning under its stream key, and its saved record sends the rest and ends it",
  JSON.stringify(thought.types.slice(0, 6)) === JSON.stringify(["RUN_STARTED", "REASONING_MESSAGE_START(stream:rs1)", "REASONING_MESSAGE_CONTENT(stream:rs1)",
    "REASONING_MESSAGE_CONTENT(stream:rs1)", "REASONING_MESSAGE_CONTENT(stream:rs1)", "REASONING_MESSAGE_END(stream:rs1)"]) &&
    thought.text["stream:rs1"] === "Weigh the rivers.", thought);
check("the reply then streams as text, and neither part is published again under its own id",
  thought.text["stream:m1"] === "The Nile is longer." && !thought.types.some((t) => t.endsWith("(rs1)") || t.endsWith("(m1)")) && thought.types.at(-1) === "RUN_FINISHED", thought);
const halfThought = summary(await publish([{ record: started("t1") }, { thinking: [["rs1", "Weigh"]] }, { record: aborted("t1") }]));
check("a turn interrupted while its summary streams ends the summary before the run's terminal",
  JSON.stringify(halfThought.types.slice(-2)) === JSON.stringify(["REASONING_MESSAGE_END(stream:rs1)", "RUN_FINISHED"]) && halfThought.errors.length === 0, halfThought);

console.log("A seat launched without reasoningEvents, whose binding journals no reasoning");
const unasked = summary(await publish([
  { record: started("t1") }, { record: reasoning("rs1", "Weigh the rivers.") },
  { deltas: [["m1", "The Nile"]] }, { record: saved("m1", "The Nile is longer.") }, { record: complete("t1") },
], false));
check("publishes the reply and none of the saved summary",
  !unasked.types.some((t) => t.startsWith("REASONING")) && unasked.text["stream:m1"] === "The Nile is longer." && unasked.types.at(-1) === "RUN_FINISHED" && unasked.errors.length === 0, unasked);

console.log("An emitter restarted mid-reply");
const restarted = summary(await publish([
  { record: started("t1") }, { deltas: [["m1", "Hel"], ["m1", "lo "]] }, "restart", { deltas: [["m1", "wor"]] },
  { record: saved("m1", "Hello world") }, { record: complete("t1") },
]));
check("continues the open message, as one process reading the same files does",
  JSON.stringify(restarted.types) === JSON.stringify(streamed.types) && restarted.text["stream:m1"] === "Hello world", { restarted, streamed: streamed.types });

console.log("A stream the harness abandoned, then a run closed out of band");
const abandoned = summary(await publish([{ record: started("t1") }, { deltas: [["m1", "Half"]] }, { ends: ["m1"] }, "closeRun"]));
check("the journal's end closes the message, so the run can close",
  JSON.stringify(abandoned.types.slice(-2)) === JSON.stringify(["TEXT_MESSAGE_END(stream:m1)", "RUN_FINISHED"]) && abandoned.errors.length === 0, abandoned);
const refused = summary(await publish([{ record: started("t1") }, { deltas: [["m1", "Half"]] }, "closeRun"]));
check("control: without it the close is refused while the message is open", refused.errors.length > 0 && !refused.types.includes("RUN_FINISHED"), refused);

console.log(`\n${failed === 0 ? "AGUI-CODEX-STREAM SMOKE OK" : "AGUI-CODEX-STREAM SMOKE FAILED"}  (${passed} passed, ${failed} failed)`);
emitSentinel({ passed, failed });
process.exit(failed === 0 ? 0 : 1);
