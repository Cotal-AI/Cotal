/**
 * Reply text a Hermes seat streams on its event plane before Hermes saves the response.
 *
 * The plugin half (plugin/cotal/streams.py) runs under Python in plugin-streams.probe.py, over the
 * real adapter, hooks and journal: Hermes's drafts become deltas under one key per stretch of text,
 * and the saved response's record names the key. The mapper half (src/agui-map.ts) maps delta
 * lines merged in among the records, and the last cells drive the real delta journal, merged
 * source and emitter over files, as the sidecar does (src/events.ts).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { Part } from "@cotal-ai/core";
import { createSuite, memorySubjectFrontier, skipSuite } from "@cotal-ai/smoke-kit";
import {
  AguiBrackets, AguiEmitter, DeltaJournal, DeltaMergedSource, EventWal, JsonlFileSource,
  type AguiEvent, type EmitterEndpoint, type Merged, type StreamDelta,
} from "@cotal-ai/connector-core";
import { createHermesMapper, type HermesJournalRecord } from "../src/agui-map.js";

if (process.platform === "win32") skipSuite("the Hermes connector is Unix-only");

const { check, finish } = createSuite();
const root = mkdtempSync(join(tmpdir(), "hermes-stream-"));

// ---- the plugin: drafts to deltas, and the key on the saved response's record ----------------
const python = ["python3", "python"].find((bin) => spawnSync(bin, ["-c", ""], { stdio: "ignore" }).status === 0);
if (!python) throw new Error("python is not on PATH, so the plugin's streams cannot be verified");
const probe = fileURLToPath(new URL("./plugin-streams.probe.py", import.meta.url));
const plugin = fileURLToPath(new URL("../plugin", import.meta.url));
const journalPath = join(root, "probe-journal.jsonl");
writeFileSync(journalPath, "");
const res = spawnSync(python, ["-I", probe, plugin, journalPath], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH } });
const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT "));
if (res.status !== 0 || !line) throw new Error(`the probe did not run:\n${res.stdout}\n${res.stderr}`);
type Frame = { t: string; key: string; text?: string };
type Draft = { success?: boolean; frames: Frame[]; error?: string };
const out = JSON.parse(line.slice("RESULT ".length)) as Record<string, unknown> & Record<"d1" | "d2" | "same" | "other_chat" | "late" | "n1" | "n2" | "broken1" | "broken2" | "ws1" | "ws2" | "ws3" | "cut" | "after_done" | "unarmed", Draft> & { done: Frame[]; peer_done: Frame[]; reply: Record<string, unknown>[] };
const saved = readFileSync(journalPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as HermesJournalRecord);

check("the adapter takes Hermes's drafts, the chat id Hermes 0.21 passes included", out.buttons === true);
check("and never asks Hermes to split a streamed reply", typeof out.limit === "number" && out.limit > 1e9);
const key = out.d1.frames[0]?.key;
check("a draft becomes a delta, and the gateway hears it was shown",
  out.d1.success === true && isDeepStrictEqual(out.d1.frames, [{ t: "delta", key, text: "Hel" }]) && /^hermes-stream-/.test(key ?? ""), out.d1);
check("a later draft sends only the text it adds, under the same key", isDeepStrictEqual(out.d2.frames, [{ t: "delta", key, text: "lo wor" }]), out.d2);
check("a draft that adds nothing sends nothing", key !== undefined && out.same.error === undefined && out.same.frames.length === 0, out.same);
check("another chat's draft streams under a key of its own", out.other_chat.frames.length === 1 && out.other_chat.frames[0]!.key !== key);
const responses = saved.filter((r) => r.k === "assistant");
check("a response recorded before any stream names none, and reads no session context", out.first === null && responses[0]?.content === "before any stream" && responses[0]?.stream === undefined, out.first ?? responses[0]);
check("the saved response names the stream its text streamed under", key !== undefined && responses[1]?.content === "Hello world." && responses[1]?.stream === key, responses[1]);
check("a response on another platform closes no stream and is not recorded", responses.length === 4 && !responses.some((r) => r.content === "Elsewhere, saved."));
check("a draft after its response was saved is dropped", key !== undefined && out.late.error === undefined && out.late.frames.length === 0, out.late);
const k9 = out.n1.frames[0]?.key;
const k10 = out.n2.frames.find((f) => f.t === "delta")?.key;
check("a new stretch of text ends one no response closed, then streams under a new key",
  isDeepStrictEqual(out.n2.frames, [{ t: "delta_end", key: k9 }, { t: "delta", key: k10, text: "Second" }]) && k9 !== k10, out.n2);
check("a draft that does not extend the text stops the stream's deltas", k10 !== undefined && out.broken1.error === undefined && out.broken1.frames.length === 0 && out.broken2.frames.length === 0, [out.broken1, out.broken2]);
check("and the saved response still names that stream, to close it with the text of record", k10 !== undefined && responses[2]?.stream === k10 && responses[2]?.content === "Second, longer and saved.", responses[2]);
const wsKey = out.ws1.frames[0]?.key;
check("the blank lines Hermes trims from a saved response do not stream, and trailing space waits for text",
  out.ws1.frames[0]?.text === "Output:" && out.ws2.frames[0]?.text === " ok" && out.ws3.frames[0]?.text === " \nDone" && out.ws3.frames[0]?.key === wsKey, [out.ws1, out.ws2, out.ws3]);
check("so what streamed is the start of the saved text", wsKey !== undefined && responses[3]?.stream === wsKey && responses[3]?.content?.startsWith("Output: ok \nDone") === true, responses[3]);
const kCut = out.cut.frames[0]?.key;
check("a message that ends with its stream open ends the stream", kCut !== undefined && isDeepStrictEqual(out.done, [{ t: "delta_end", key: kCut }]), out.done);
check("and a draft of it after that is dropped", kCut !== undefined && out.after_done.error === undefined && out.after_done.frames.length === 0, out.after_done);
check("a peer chat's stream no response closed ends when its message does", out.other_chat.frames.length === 1 && isDeepStrictEqual(out.peer_done, [{ t: "delta_end", key: out.other_chat.frames[0]!.key }]), out.peer_done);
check("a reply a peer gets is trimmed, as Hermes trims a reply it does not stream",
  isDeepStrictEqual(out.reply, [{ t: "reply", target: { peerId: "peer" }, text: "Output: ok" }]), out.reply);
check("an unarmed seat streams nothing, and the gateway still hears the draft was shown", out.unarmed.success === true && out.unarmed.frames.length === 0, out.unarmed);

// ---- the mapper: delta lines among the records ------------------------------------------------
let seq = 0;
const rec = (k: HermesJournalRecord["k"], extra: Partial<HermesJournalRecord> = {}): Merged<HermesJournalRecord> => ({ harness: { k, rid: `r${++seq}`, ts: 1_000 + seq, ...extra } });
const deltas = (list: Array<[string, string]>, ends?: string[]): Merged<HermesJournalRecord> =>
  ({ deltas: list.map(([k, text]): StreamDelta => ({ key: k, kind: "text", text })), timestamp: 1_000 + ++seq, ...(ends ? { ends } : {}) });

function mapAll(items: readonly Merged<HermesJournalRecord>[], opts: Parameters<typeof createHermesMapper>[0] | undefined = undefined) {
  let n = 0;
  const map = createHermesMapper(opts ?? { threadId: "thread", mintRunId: () => `run-${++n}` });
  const brackets = new AguiBrackets();
  const events: (AguiEvent & Record<string, unknown>)[] = [];
  let bracketError: string | undefined;
  let mapError: string | undefined;
  for (const item of items) {
    let o: ReturnType<typeof map>;
    try {
      o = map(item);
    } catch (err) {
      mapError ??= (err as Error).message;
      continue;
    }
    if (o === null || !("runId" in o)) continue;
    for (const e of o.events) {
      try {
        brackets.accept(e);
      } catch (err) {
        bracketError ??= (err as Error).message;
      }
      events.push(e as AguiEvent & Record<string, unknown>);
    }
  }
  const text = (id: string) => events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.messageId === id).map((e) => e.delta).join("");
  return { events, types: events.map((e): string => e.type), bracketError: bracketError ?? mapError, text };
}

const streamed = mapAll([rec("start", { key: "a" }), deltas([["s1", "Hello "]]), deltas([["s1", "wor"]]), rec("assistant", { content: "Hello world.", stream: "s1", reasoning: "r" }), rec("done", { key: "a", outcome: "success" })]);
check("a delta while a message is in progress opens the run and streams under its key",
  streamed.types.slice(0, 3).join() === "RUN_STARTED,TEXT_MESSAGE_START,TEXT_MESSAGE_CONTENT" && streamed.events[1]!.messageId === "s1", streamed.types);
check("the saved response closes it with the text that did not stream, once", streamed.text("s1") === "Hello world." &&
  streamed.types.filter((t) => t === "TEXT_MESSAGE_START").length === 1 && streamed.bracketError === undefined, streamed.types);
check("the run finishes at the done", streamed.types.at(-1) === "RUN_FINISHED");

const retried = mapAll([rec("start", { key: "a" }), deltas([["s2", "Draft text"]]), rec("assistant", { content: "Other text.", stream: "s2" }), rec("done", { key: "a", outcome: "success" })]);
const retriedNew = retried.events.find((e) => e.type === "TEXT_MESSAGE_START" && e.messageId !== "s2")?.messageId as string | undefined;
check("a saved text that does not continue the stream ends it, then comes as a message of its own",
  retried.text("s2") === "Draft text" && retriedNew !== undefined && retried.text(retriedNew) === "Other text." && retried.bracketError === undefined, retried.types);

const outside = mapAll([deltas([["s3", "stray"]]), rec("start", { key: "a" }), deltas([["s3", " more"]]), rec("assistant", { content: "Saved.", stream: "s3" }), rec("done", { key: "a", outcome: "success" })]);
check("a delta while no message is in progress is dropped, and its key stays closed",
  outside.text("s3") === "" && outside.events.some((e) => e.type === "TEXT_MESSAGE_CONTENT" && e.delta === "Saved.") && outside.bracketError === undefined, outside.types);

const cancelled = mapAll([rec("start", { key: "a" }), deltas([["s4", "Half a rep"]]), rec("done", { key: "a", outcome: "cancelled" })]);
const fin = cancelled.events.at(-1) as { outcome?: { type?: string } } | undefined;
check("a run cancelled mid-stream ends the streamed message, then the run as an interrupt",
  cancelled.types.join() === "RUN_STARTED,TEXT_MESSAGE_START,TEXT_MESSAGE_CONTENT,TEXT_MESSAGE_END,RUN_FINISHED" && fin?.outcome?.type === "interrupt" && cancelled.bracketError === undefined, cancelled.types);

const ended = mapAll([rec("start", { key: "a" }), deltas([["s5", "Abandoned"]]), deltas([], ["s5"]), deltas([["s5", " late"]]), rec("done", { key: "a", outcome: "success" })]);
check("a stream the plugin ends is ended at once, and later text under it is dropped",
  ended.types.join() === "RUN_STARTED,TEXT_MESSAGE_START,TEXT_MESSAGE_CONTENT,TEXT_MESSAGE_END,RUN_FINISHED" && ended.text("s5") === "Abandoned", ended.types);

// A re-established plane replays the merged records it consumed and resumes the stream it had open.
const prefix = [rec("start", { key: "a" }), deltas([["s6", "Resumed "]])];
let tail: ReturnType<ReturnType<typeof createHermesMapper>>[] = [];
let resumeError: string | undefined;
try {
  const resumedMap = createHermesMapper({ threadId: "thread", mintRunId: () => "fresh", consumed: prefix, resumeRunId: "wire-run", seed: { open: [{ key: "s6", kind: "text", text: "Resumed " }], closed: [] } });
  tail = [deltas([["s6", "text"]]), rec("assistant", { content: "Resumed text.", stream: "s6" }), rec("done", { key: "a", outcome: "success" })].map((r) => resumedMap(r));
} catch (e) {
  resumeError = (e as Error).message;
}
const tailEvents = tail.flatMap((o) => (o !== null && "runId" in o ? o.events : [])) as (AguiEvent & Record<string, unknown>)[];
check("a run a delta opened is open again after a replay, under the wire's id", tail.length === 3 && tail.every((o) => o !== null && "runId" in o && o.runId === "wire-run"), resumeError ?? tail);
check("and the stream resumes from the text it streamed", tailEvents.filter((e) => e.type === "TEXT_MESSAGE_CONTENT").map((e) => e.delta).join("|") === "text|." &&
  !tailEvents.some((e) => e.type === "TEXT_MESSAGE_START"), tailEvents.map((e) => e.type));

// ---- the real delta journal, merged source and emitter over files ------------------------------
const calls: { rail: string; parts: Part[] }[] = [];
let ackSeq = 0;
const ep: EmitterEndpoint = {
  principal: { owner: "local", actor: "seat" },
  actorIsEphemeral: false,
  maxPayload: 100_000,
  assertExpectationSemantics: async () => {},
  eventPayloadLimit: async () => 50_000,
  encodedSize: (o) => Buffer.byteLength(JSON.stringify(o)) + 100,
  multicastExpecting: async (o) => {
    calls.push({ rail: "public", parts: o.parts });
    return { ack: { seq: ++ackSeq, duplicate: false } };
  },
  publishEventPayload: async (o) => {
    calls.push({ rail: "payload", parts: o.parts });
    return { ack: { seq: ++ackSeq, duplicate: false } };
  },
};
mkdirSync(join(root, "wal", "thread"), { recursive: true });
const turnJournal = join(root, "turn.jsonl");
writeFileSync(turnJournal, "");
const harness = new JsonlFileSource<HermesJournalRecord>(turnJournal);
const deltaPath = join(root, "wal", "thread", "deltas.jsonl");
let woke = 0;
const journal = DeltaJournal.open({ path: deltaPath, anchor: () => harness.endSync(), onWrite: () => woke++, onError: (e) => { throw e; } });
const source = new DeltaMergedSource(harness, deltaPath);
const wal = await EventWal.open(join(root, "wal", "thread", "wal.json"), { space: "s", threadId: "thread", principal: "local.seat", subjectMayExist: false });
await wal.advanceCursorOnly(source.start(await harness.cursorAtBeginning()));
const emitter = await AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map: createHermesMapper({ threadId: "thread", mintRunId: () => "run" }) });
const write = (r: Partial<HermesJournalRecord>) => appendFileSync(turnJournal, `${JSON.stringify({ rid: `w${++seq}`, ts: Date.now(), ...r })}\n`);
const published = () => calls.filter((c) => c.rail === "public").flatMap((c) => c.parts).map((p) => JSON.stringify(p)).join("\n");
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

write({ k: "start", key: "m" });
journal.append({ key: "live", kind: "text", text: "Streaming " });
await settle(20);
journal.append({ key: "live", kind: "text", text: "now" });
await settle(1_000);
let pumpError: string | undefined;
await emitter.pump().catch((e: Error) => (pumpError ??= e.message));
const before = published();
check("the journal coalesces the deltas into lines and wakes the plane", woke >= 1);
check("the plane publishes the streamed text before Hermes saves the response",
  pumpError === undefined && before.includes("TEXT_MESSAGE_START") && before.includes("Streaming ") && before.includes("now") && !before.includes("TEXT_MESSAGE_END"), before.slice(0, 400));
write({ k: "assistant", content: "Streaming now, saved.", reasoning: "", calls: [], stream: "live" });
write({ k: "done", key: "m", outcome: "success" });
await emitter.pump().catch((e: Error) => (pumpError ??= e.message));
const after = published();
check("the saved response sends the rest and ends the message, and the run finishes",
  pumpError === undefined && after.includes(", saved.") && after.includes("TEXT_MESSAGE_END") && after.includes("RUN_FINISHED") && wal.pending === null, pumpError ?? after.slice(-400));
check("the streamed message is one message, published under its key", (after.match(/TEXT_MESSAGE_START/g) ?? []).length === 1 && after.includes('"live"'));
journal.close();

finish();
