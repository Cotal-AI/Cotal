/**
 * The Hermes event plane: the plugin's turn journal (plugin/cotal/journal.py) mapped to AG-UI
 * (src/agui-map.ts) and published by connector-core's emitter.
 *
 * The journal is written by the real plugin module under Python, so the record shape the mapper
 * reads is the one the plugin writes. Every mapped event goes through the bracket machine, and the
 * last cells drive the real emitter over the file, with a tool call and its result in separate
 * reads, to show the arguments and the result reach the payload rail and stay off the channel.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Part } from "@cotal-ai/core";
import { memorySubjectFrontier } from "@cotal-ai/smoke-kit";
import { AguiBrackets, AguiEmitter, EventWal, JsonlFileSource, type AguiEvent, type EmitterEndpoint } from "@cotal-ai/connector-core";
import { createHermesMapper, type HermesJournalRecord } from "../src/agui-map.js";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.error(`  x FAIL: ${name}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
  }
};

const root = mkdtempSync(join(tmpdir(), "hermes-agui-"));
const plugin = fileURLToPath(new URL("../plugin/cotal", import.meta.url));
const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
if (!python) throw new Error("python is not on PATH, so the plugin's journal cannot be written");

/** Run journal.py's writers in a fresh interpreter. `script` sees the module as `j`. */
function writeJournal(path: string, script: string): void {
  const r = spawnSync(python!, ["-I", "-c", `import importlib.util, sys
spec = importlib.util.spec_from_file_location("journal", sys.argv[1] + "/journal.py")
j = importlib.util.module_from_spec(spec); spec.loader.exec_module(j)
${script}`, plugin], { encoding: "utf8", env: { PATH: process.env.PATH, COTAL_HERMES_EVENTS: path } });
  if (r.status !== 0) throw new Error(`journal.py failed: ${r.stderr}`);
}
const records = (path: string): HermesJournalRecord[] =>
  readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as HermesJournalRecord);

/** Map records in order through a fresh mapper, feeding every event to the bracket machine. */
function mapAll(recs: readonly HermesJournalRecord[], opts: { reasoning?: boolean } = {}) {
  let n = 0;
  const map = createHermesMapper({ threadId: "thread", mintRunId: () => `run-${++n}`, ...opts });
  const brackets = new AguiBrackets();
  const events: (AguiEvent & Record<string, unknown>)[] = [];
  let bracketError: string | undefined;
  for (const rec of recs) {
    const out = map(rec);
    if (out === null || !("runId" in out)) continue;
    for (const e of out.events) {
      try {
        brackets.accept(e);
      } catch (err) {
        bracketError ??= (err as Error).message;
      }
      events.push(e as AguiEvent & Record<string, unknown>);
    }
  }
  return { events, types: events.map((e): string => e.type), bracketError, open: brackets.runId };
}

// One Cotal turn that calls a tool, written by the plugin. A response from another platform's turn
// and a result for a call no Cotal response announced are not recorded.
const turnPath = join(root, "turn.jsonl");
writeFileSync(turnPath, "");
writeJournal(turnPath, `
j.processing_started("m1")
j.model_response("telegram", {"content": "elsewhere", "tool_calls": [{"id": "tg1", "function": {"name": "terminal", "arguments": "{}"}}]})
j.model_response("cotal", {"content": "Running it.", "reasoning": "think first", "tool_calls": [{"id": "call_1", "function": {"name": "terminal", "arguments": "{\\"command\\": \\"echo hi\\"}"}}]})
j.tool_result("tg1", "not ours", "ok")
j.tool_result("call_1", "hi\\n", "ok")
j.model_response("cotal", {"content": [{"type": "text", "text": "It printed hi."}], "tool_calls": []})
j.processing_done("m1", "success")
`);
const turn = records(turnPath);
check("the plugin records only Cotal work: start, two responses, one result, done", turn.map((r) => r.k).join() === "start,assistant,tool,assistant,done", turn.map((r) => r.k));
const plain = mapAll(turn);
check("the turn maps inside the bracket rules", plain.bracketError === undefined, plain.bracketError);
check("one run opens at the first model response and finishes at the done", plain.types[0] === "RUN_STARTED" && plain.types[1] === "TEXT_MESSAGE_START" && plain.types.at(-1) === "RUN_FINISHED" && plain.open === undefined, plain.types);
check(
  "the tool call is START, ARGS, END, RESULT and the cotal.toolResult marker",
  ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT"].every((t) => plain.types.includes(t)) &&
    plain.events.some((e) => e.type === "CUSTOM" && e.name === "cotal.toolResult" && (e.value as { isError?: boolean }).isError === false),
  plain.types,
);
check("the arguments and the result are the plugin's", plain.events.some((e) => e.type === "TOOL_CALL_ARGS" && e.delta === '{"command": "echo hi"}') && plain.events.some((e) => e.type === "TOOL_CALL_RESULT" && e.content === "hi\n"));
check("both texts are assistant messages, part lists included", plain.events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta).join("|") === "Running it.|It printed hi.");
check("reasoning is off by default", !plain.types.some((t) => t.startsWith("REASONING")));
const reasoned = mapAll(turn, { reasoning: true });
check("reasoning is mapped when asked for", reasoned.events.some((e) => e.type === "REASONING_MESSAGE_CONTENT" && e.delta === "think first") && reasoned.bracketError === undefined);

// Unarmed: no journal path, nothing written.
const quiet = spawnSync(python, ["-I", "-c", `import importlib.util, sys
spec = importlib.util.spec_from_file_location("journal", sys.argv[1] + "/journal.py")
j = importlib.util.module_from_spec(spec); spec.loader.exec_module(j)
print(j.processing_started("m"), j.model_response("cotal", {"content": "x"}))`, plugin], { encoding: "utf8", env: { PATH: process.env.PATH } });
check("without COTAL_HERMES_EVENTS the plugin writes nothing", quiet.stdout.trim() === "False False", quiet.stdout + quiet.stderr);

// Hand-built records for the arms one live turn does not reach.
let seq = 0;
const rec = (k: HermesJournalRecord["k"], extra: Partial<HermesJournalRecord> = {}): HermesJournalRecord => ({ k, rid: `r${++seq}`, ts: 1_000 + seq, ...extra });
const call = (id: string) => ({ id, name: "terminal", arguments: "{}" });

const overlap = mapAll([
  rec("start", { key: "a" }),
  rec("start", { key: "b" }),
  rec("assistant", { calls: [call("t1")] }),
  rec("done", { key: "a", outcome: "success" }),
  rec("tool", { id: "t1", result: "ok" }),
  rec("done", { key: "b", outcome: "success" }),
]);
check("two messages in progress at once share one run, which finishes when both are done", overlap.types.filter((t) => t === "RUN_STARTED").length === 1 && overlap.types.at(-1) === "RUN_FINISHED" && overlap.types.indexOf("TOOL_CALL_RESULT") < overlap.types.indexOf("RUN_FINISHED") && overlap.bracketError === undefined, overlap.types);

const failed = mapAll([rec("start", { key: "a" }), rec("assistant", { calls: [call("t2")] }), rec("done", { key: "a", outcome: "failure" })]);
check("a failed message ends its open tool call without a result, and the run with RUN_ERROR", failed.types.join() === "RUN_STARTED,TOOL_CALL_START,TOOL_CALL_ARGS,TOOL_CALL_END,RUN_ERROR" && failed.bracketError === undefined, failed.types);

const empty = mapAll([rec("start", { key: "a" }), rec("done", { key: "a", outcome: "success" }), rec("start", { key: "b" }), rec("done", { key: "b", outcome: "cancelled" })]);
check("a message processed without a model response opens no run", empty.events.length === 0, empty.types);

const refusedEarly = mapAll([rec("start", { key: "a" }), rec("done", { key: "a", outcome: "failure" })]);
check("a message that fails before any model response opens and fails a run", refusedEarly.types.join() === "RUN_STARTED,RUN_ERROR" && refusedEarly.bracketError === undefined, refusedEarly.types);

const cancelled = mapAll([rec("start", { key: "a" }), rec("assistant", { content: "partial" }), rec("done", { key: "a", outcome: "cancelled" })]);
const fin = cancelled.events.at(-1) as { outcome?: { type?: string } } | undefined;
check("a cancelled message ends the run as an interrupt", fin?.outcome?.type === "interrupt", cancelled.events.at(-1));

const twice = mapAll([rec("start", { key: "a" }), rec("assistant", { calls: [call("t3")] }), rec("assistant", { content: "done", calls: [call("t3")] }), rec("tool", { id: "t3", result: "r" }), rec("done", { key: "a", outcome: "success" })]);
check("a call a later response repeats starts once", twice.types.filter((t) => t === "TOOL_CALL_START").length === 1 && twice.bracketError === undefined, twice.types);

const outside = mapAll([rec("assistant", { content: "late" }), rec("tool", { id: "zz", result: "r" }), rec("done", { key: "q", outcome: "success" })]);
check("records outside a run map to nothing", outside.events.length === 0);

// A re-established plane replays what it consumed and resumes the open run under the wire's id.
const prefix = [rec("start", { key: "a" }), rec("start", { key: "b" }), rec("assistant", { calls: [call("t4")] }), rec("done", { key: "a", outcome: "success" })];
const resumed = createHermesMapper({ threadId: "thread", mintRunId: () => "fresh", consumed: prefix, resumeRunId: "wire-run" });
const tail = [rec("tool", { id: "t4", result: "r" }), rec("done", { key: "b", outcome: "success" })].map((r) => resumed(r));
check("a resumed mapper continues the open run and its tool call", tail.every((o) => o !== null && "runId" in o && o.runId === "wire-run") && (tail[1] as { events: AguiEvent[] }).events.at(-1)?.type === "RUN_FINISHED", tail);
let refused = "";
try {
  createHermesMapper({ threadId: "thread", mintRunId: () => "x", consumed: prefix });
} catch (e) {
  refused = (e as Error).message;
}
check("a journal and a log that disagree about the open run are refused", /has a run open where the event plane's log has none/.test(refused), refused);

// The real emitter over the journal file: the call and its result arrive in separate reads.
const calls: { rail: string; parts: Part[] }[] = [];
let seqNo = 0;
const ep: EmitterEndpoint = {
  principal: { owner: "local", actor: "seat" },
  actorIsEphemeral: false,
  maxPayload: 100_000,
  assertExpectationSemantics: async () => {},
  eventPayloadLimit: async () => 50_000,
  encodedSize: (o) => Buffer.byteLength(JSON.stringify(o)) + 100,
  multicastExpecting: async (o) => {
    calls.push({ rail: "public", parts: o.parts });
    return { ack: { seq: ++seqNo, duplicate: false } };
  },
  publishEventPayload: async (o) => {
    calls.push({ rail: "payload", parts: o.parts });
    return { ack: { seq: ++seqNo, duplicate: false } };
  },
};
mkdirSync(join(root, "wal", "thread"), { recursive: true });
const journal = join(root, "live.jsonl");
writeFileSync(journal, "");
const wal = await EventWal.open(join(root, "wal", "thread", "wal.json"), { space: "s", threadId: "thread", principal: "local.seat", subjectMayExist: false });
const source = new JsonlFileSource<HermesJournalRecord>(journal);
await wal.advanceCursorOnly(await source.cursorAtBeginning());
const emitter = await AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map: createHermesMapper({ threadId: "thread", mintRunId: () => "run" }) });
const lines = readFileSync(turnPath, "utf8").split("\n").filter(Boolean);
let pumpError: string | undefined;
for (const chunk of [lines.slice(0, 2), lines.slice(2, 3), lines.slice(3)]) {
  appendFileSync(journal, chunk.map((l) => `${l}\n`).join(""));
  await emitter.pump().catch((e: Error) => (pumpError ??= e.message));
}
const pub = JSON.stringify(calls.filter((c) => c.rail === "public"));
const rail = JSON.stringify(calls.filter((c) => c.rail === "payload"));
check("the emitter publishes the split call and result without refusing", pumpError === undefined && wal.pending === null, pumpError);
check("the arguments and the result ride the payload rail", rail.includes("TOOL_CALL_ARGS") && rail.includes("echo hi") && rail.includes("TOOL_CALL_RESULT"), rail.slice(0, 300));
check("the channel carries the call by name and the marker, never its arguments or result", pub.includes("TOOL_CALL_START") && pub.includes("cotal.toolResult") && !pub.includes("TOOL_CALL_ARGS") && !pub.includes("TOOL_CALL_RESULT"), pub.slice(0, 300));
check("the channel carries the run and the text", pub.includes("RUN_STARTED") && pub.includes("RUN_FINISHED") && pub.includes("It printed hi."));

console.log(`hermes agui-map: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
