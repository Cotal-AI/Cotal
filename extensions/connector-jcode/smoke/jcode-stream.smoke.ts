/**
 * Jcode replies stream on the event plane before Jcode saves them, and every streamed part closes.
 *
 * The real JcodeDeltaStream, JcodeJournalSource, DeltaMergedSource, Jcode mapper and AguiEmitter run
 * over files. A stand-in client emits the Harness events, the test appends what Jcode would save, and
 * a stand-in endpoint records what the emitter publishes. No broker and no Jcode. A fold whose new
 * journal reuses the folded one's inode, as ext4 does, is made by truncating the journal in place.
 * Run: pnpm smoke:jcode-stream
 */
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JcodeClient } from "@1jehuang/jcode-sdk";
import type { Part } from "@cotal-ai/core";
import {
  AGUI_EVENT_TYPE, AguiEmitter, DELTA_JOURNAL_INTERVAL_MS, DeltaMergedSource, EventWal, streamSeed,
  type AguiEvent, type EmitterEndpoint, type Merged,
} from "@cotal-ai/connector-core";
import { memorySubjectFrontier } from "@cotal-ai/smoke-kit";
import { createJcodeMapper, type JcodeMapper, type PositionedJcodeJournalRecord } from "../src/agui-map.js";
import { initializeJcodeEventBoundary, JcodeJournalSource, positionedJcodeJournalSource } from "../src/agui-source.js";
import { JcodeDeltaStream } from "../src/stream-deltas.js";

let passed = 0;
let failed = 0;
const check = (label: string, ok: boolean, extra?: unknown): void => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return; }
  failed++;
  console.log(`  FAIL  ${label}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lineWritten = () => sleep(DELTA_JOURNAL_INTERVAL_MS + 60);

const SID = "session_stream";
const root = mkdtempSync(join(tmpdir(), "cotal-jcode-stream-"));
let n = 0;

/** One seat's files, its delta stream watching a stand-in client, and an emitter that `boot` starts
 *  again from its WAL, as a restart does. */
function seat() {
  const dir = mkdtempSync(join(root, `s${n++}-`));
  mkdirSync(join(dir, "sessions"));
  const journalPath = join(dir, "sessions", `${SID}.journal.jsonl`);
  writeFileSync(journalPath, "");
  const deltaPath = join(dir, "deltas.jsonl");
  const harness = new JcodeJournalSource(journalPath, 50);
  const stream = new JcodeDeltaStream();
  stream.open(SID, { path: deltaPath, anchor: () => harness.anchor(), onWrite: () => {}, onError: (e) => { throw e; } });
  const merged = new DeltaMergedSource(positionedJcodeJournalSource(harness), deltaPath);
  const client = new EventEmitter();
  stream.watch(client as unknown as JcodeClient, () => SID);
  const say = (ev: string, extra: Record<string, unknown> = {}) => client.emit(ev, { ev, session_id: SID, ...extra });
  const save = (...messages: unknown[]) => appendFileSync(journalPath, `${JSON.stringify({ append_messages: messages })}\n`);
  const published: AguiEvent[] = [];
  const ep: EmitterEndpoint = {
    principal: { owner: "local", actor: "seat" }, actorIsEphemeral: false, maxPayload: 1_000_000,
    assertExpectationSemantics: async () => {},
    encodedSize: (o) => Buffer.byteLength(JSON.stringify(o)) + 100,
    multicastExpecting: async (o) => {
      for (const p of o.parts as Part[]) published.push(...((p as unknown as { events?: AguiEvent[] }).events ?? []));
      return { ack: { seq: published.length, duplicate: false } };
    },
  };
  const frontier = memorySubjectFrontier();
  let runs = 0;
  let mapper: JcodeMapper | undefined;
  const boot = async (): Promise<AguiEmitter<Merged<PositionedJcodeJournalRecord>>> => {
    const wal = await EventWal.open(join(dir, "wal.json"), { space: "s", threadId: SID, principal: "local.seat", subjectMayExist: false });
    await initializeJcodeEventBoundary(journalPath, wal, merged);
    const seed = await streamSeed(deltaPath, wal.frontier.sourceCursor, wal.brackets);
    mapper = createJcodeMapper({ threadId: SID, mintRunId: () => `run-${++runs}`, resumeRunId: wal.brackets?.run, resumeTools: wal.brackets?.tools, seed });
    return AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: frontier, source: merged, map: mapper.map });
  };
  /** The host's turn end: end the turn's streams, read up to here, close the run, and tell the
   *  mapper, as the holder's `onRunClosed` does. */
  const endTurn = async (emitter: AguiEmitter<Merged<PositionedJcodeJournalRecord>>) => {
    stream.turnEnded();
    await emitter.pump();
    const runId = await emitter.closeRun({ timestamp: Date.now() });
    if (runId !== null) mapper!.forgetOpenRun(runId);
    return runId;
  };
  const snapshot = () => writeFileSync(join(dir, "sessions", `${SID}.json`), JSON.stringify({ id: SID, messages: [] }));
  return { dir, journalPath, deltaPath, harness, stream, say, save, published, boot, endTurn, snapshot };
}

type Ev = AguiEvent & { messageId?: string; delta?: string };
const of = (events: AguiEvent[]) => events as Ev[];
const streamIds = (events: AguiEvent[]) => [...new Set(of(events).filter((e) => e.messageId?.includes(":stream:")).map((e) => e.messageId!))];
const textOf = (events: AguiEvent[], id: string) => of(events).filter((e) => e.messageId === id && e.delta !== undefined).map((e) => e.delta).join("");
const typesOf = (events: AguiEvent[], id: string): string[] => of(events).filter((e) => e.messageId === id).map((e) => e.type);
const reply = (...content: unknown[]) => ({ role: "assistant", content });
/** Whether two positions name one inode on one device, as the cursor writes them. */
const sameFile = (a: string, b: string) => a.split(":").slice(0, 2).join(":") === b.split(":").slice(0, 2).join(":");

try {
  console.log("a reply streams");
  {
    const s = seat();
    const em = await s.boot();
    s.say("text_delta", { text: "Hel" });
    s.say("text_delta", { text: "lo" });
    await lineWritten();
    await em.pump();
    const [id] = streamIds(s.published);
    check("the streamed text publishes before Jcode saves the reply",
      id !== undefined && textOf(s.published, id) === "Hello" && !typesOf(s.published, id).includes(AGUI_EVENT_TYPE.TEXT_MESSAGE_END), of(s.published).map((e) => e.type));
    s.say("text_delta", { text: " wor" });
    s.save(reply({ type: "text", text: "Hello world" }));
    s.say("token_usage", { input: 10, output: 2 });
    s.say("turn_done");
    await em.pump();
    check("the saved reply sends the rest and ends the same message once",
      textOf(s.published, id!) === "Hello world" && typesOf(s.published, id!).filter((t) => t === AGUI_EVENT_TYPE.TEXT_MESSAGE_END).length === 1 &&
        streamIds(s.published).length === 1 && of(s.published).filter((e) => e.type === AGUI_EVENT_TYPE.TEXT_MESSAGE_START).length === 1, of(s.published).map((e) => `${e.type}:${e.delta ?? ""}`));
    check("the run closes at the turn end", (await s.endTurn(em)) === "run-1" && s.published.at(-1)?.type === AGUI_EVENT_TYPE.RUN_FINISHED);
    await lineWritten();
    await em.pump();
    check("a line written after the reply was saved publishes nothing more", streamIds(s.published).length === 1 && textOf(s.published, id!) === "Hello world");
  }

  console.log("calls, reasoning and retries");
  {
    const s = seat();
    const em = await s.boot();
    s.say("reasoning_delta", { text: "think" });
    s.say("text_delta", { text: "Calling." });
    await lineWritten();
    s.save(reply({ type: "text", text: "Calling." }, { type: "anthropic_thinking", thinking: "think hard", signature: "sig" }, { type: "tool_use", id: "call-1", name: "bash", input: {} }));
    s.say("token_usage", { input: 10, output: 2 });
    s.save({ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] });
    s.say("text_delta", { text: "Done" });
    await lineWritten();
    s.save(reply({ type: "text", text: "Done." }));
    s.say("token_usage", { input: 12, output: 1 });
    await em.pump();
    const ids = streamIds(s.published);
    const texts = ids.map((id) => textOf(s.published, id));
    check("each provider call streams under messages of its own, closed by the reply Jcode saved for it",
      ids.length === 3 && JSON.stringify(texts) === JSON.stringify(["think hard", "Calling.", "Done."]), texts);
    check("signed Anthropic thinking closes its streamed reasoning",
      typesOf(s.published, ids[0]!).join(",") === `${AGUI_EVENT_TYPE.REASONING_MESSAGE_START},${AGUI_EVENT_TYPE.REASONING_MESSAGE_CONTENT},${AGUI_EVENT_TYPE.REASONING_MESSAGE_CONTENT},${AGUI_EVENT_TYPE.REASONING_MESSAGE_END}`);
    check("no saved part publishes twice", of(s.published).filter((e) => e.type === AGUI_EVENT_TYPE.TEXT_MESSAGE_START).length === 2);
    s.say("text_delta", { text: "abandoned attempt" });
    await lineWritten();
    s.say("retry_rollback", { attempt: 1, max: 2 });
    s.say("text_delta", { text: " then retried" });
    await lineWritten();
    s.save(reply({ type: "text", text: "Retried." }));
    await em.pump();
    const retried = streamIds(s.published)[3]!;
    check("a retry inside a call ends the streamed part, and the saved reply publishes as a message of its own",
      textOf(s.published, retried) === "abandoned attempt then retried" && typesOf(s.published, retried).at(-1) === AGUI_EVENT_TYPE.TEXT_MESSAGE_END &&
        of(s.published).some((e) => e.delta === "Retried." && !e.messageId!.includes(":stream:")));
    check("and the run still closes", (await s.endTurn(em)) === "run-1");
  }

  console.log("a provider call that fails after it streamed");
  {
    const s = seat();
    const em = await s.boot();
    s.say("text_delta", { text: "Partial reply that " });
    await lineWritten();
    await em.pump();
    s.say("text_delta", { text: "Jcode never saves" });
    s.say("turn_stopped", { reason: "failure" });
    const closed = await s.endTurn(em);
    const [id] = streamIds(s.published);
    check("the turn end ends the streamed part with all it streamed, and the run closes",
      closed === "run-1" && textOf(s.published, id!) === "Partial reply that Jcode never saves" &&
        typesOf(s.published, id!).at(-1) === AGUI_EVENT_TYPE.TEXT_MESSAGE_END && s.published.at(-1)?.type === AGUI_EVENT_TYPE.RUN_FINISHED);
    s.say("text_delta", { text: "Next" });
    await lineWritten();
    s.save(reply({ type: "text", text: "Next." }));
    await em.pump();
    check("the next turn streams in a run of its own", streamIds(s.published).length === 2 && of(s.published).filter((e) => e.type === AGUI_EVENT_TYPE.RUN_STARTED).length === 2);
  }

  console.log("a fold");
  {
    const s = seat();
    const em = await s.boot();
    s.say("text_delta", { text: "Before the fold" });
    await lineWritten();
    await em.pump();
    s.snapshot();
    rmSync(s.journalPath);
    s.stream.turnEnded(); // the failed turn ends while the fold has left no journal
    await em.pump();
    const [id] = streamIds(s.published);
    const tail = of(s.published).slice(-2).map((e) => e.type);
    check("a fold ends the open streamed part before its RUN_ERROR",
      JSON.stringify(tail) === JSON.stringify([AGUI_EVENT_TYPE.TEXT_MESSAGE_END, AGUI_EVENT_TYPE.RUN_ERROR]) &&
        typesOf(s.published, id!).at(-1) === AGUI_EVENT_TYPE.TEXT_MESSAGE_END, tail);
    check("with the run closed, the turn end closes nothing more", (await em.closeRun({ timestamp: Date.now() })) === null);
    s.say("text_delta", { text: "After" });
    await lineWritten();
    await em.pump();
    check("a delta streamed while no journal exists waits for the next file", streamIds(s.published).length === 1);
    s.save({ role: "user", content: [{ type: "text", text: "next prompt" }] });
    await em.pump();
    const after = streamIds(s.published)[1];
    check("it then streams after the fold, in a new run", after !== undefined && textOf(s.published, after) === "After" &&
      of(s.published).findIndex((e) => e.messageId === after) > of(s.published).findLastIndex((e) => e.type === AGUI_EVENT_TYPE.RUN_STARTED));
    s.save(reply({ type: "text", text: "After all." }));
    await em.pump();
    check("and its saved reply closes it", typesOf(s.published, after!).at(-1) === AGUI_EVENT_TYPE.TEXT_MESSAGE_END && textOf(s.published, after!) === "After all.");
    check("the run closes", (await s.endTurn(em)) === "run-2");
  }

  console.log("a fold whose new journal has the folded one's identity");
  {
    const s = seat();
    const em = await s.boot();
    s.save({ role: "user", content: [{ type: "text", text: "first prompt" }] });
    s.save(reply({ type: "text", text: "A saved reply long enough that the journal holding it ends past the next journal's end." }));
    await em.pump();
    const before = s.harness.anchor();
    s.say("text_delta", { text: "Before the fold" });
    await lineWritten();
    s.snapshot();
    truncateSync(s.journalPath, 0);
    s.stream.turnEnded();
    s.save({ role: "user", content: [{ type: "text", text: "next" }] });
    check("the new journal has the folded one's identity", sameFile(before, s.harness.anchor()));
    s.say("text_delta", { text: "After" });
    await lineWritten();
    await em.pump();
    const [old, next] = streamIds(s.published);
    const error = of(s.published).findIndex((e) => e.type === AGUI_EVENT_TYPE.RUN_ERROR);
    check("a delta anchored on the folded journal streams and ends before the fold's RUN_ERROR",
      old !== undefined && textOf(s.published, old) === "Before the fold" && error > of(s.published).findLastIndex((e) => e.messageId === old) &&
        typesOf(s.published, old).at(-1) === AGUI_EVENT_TYPE.TEXT_MESSAGE_END, of(s.published).map((e) => `${e.type}:${e.delta ?? ""}`));
    check("and the next delta streams after the fold, in a new run", next !== undefined && textOf(s.published, next) === "After" &&
      of(s.published).findIndex((e) => e.messageId === next) > of(s.published).findLastIndex((e) => e.type === AGUI_EVENT_TYPE.RUN_STARTED), of(s.published).map((e) => `${e.type}:${e.delta ?? ""}`));
  }

  console.log("a restart mid-reply");
  {
    const s = seat();
    const first = await s.boot();
    s.say("text_delta", { text: "Hel" });
    await lineWritten();
    await first.pump();
    const second = await s.boot();
    s.save(reply({ type: "text", text: "Hello" }));
    await second.pump();
    const [id] = streamIds(s.published);
    check("a restarted emitter resumes the streamed part and closes it with the rest of the saved text",
      typesOf(s.published, id!).join(",") === [AGUI_EVENT_TYPE.TEXT_MESSAGE_START, AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT, AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT, AGUI_EVENT_TYPE.TEXT_MESSAGE_END].join(",") &&
        textOf(s.published, id!) === "Hello");
    check("and the run closes", (await s.endTurn(second)) === "run-1");
  }

  console.log("the delta stream");
  {
    const s = seat();
    const em = await s.boot();
    const unopened = new JcodeDeltaStream();
    const other = new EventEmitter();
    unopened.watch(other as unknown as JcodeClient, () => SID);
    other.emit("text_delta", { ev: "text_delta", session_id: SID, text: "before the plane" });
    unopened.turnEnded();
    check("a stream the plane has not opened takes deltas and turn ends and journals nothing", true);
    const client = new EventEmitter();
    s.stream.watch(client as unknown as JcodeClient, () => SID);
    client.emit("text_delta", { ev: "text_delta", session_id: "another_session", text: "not ours" });
    await lineWritten();
    await em.pump();
    check("a delta of another session is not journaled", s.published.length === 0, s.published);
  }

  console.log("positions across a fold");
  {
    const s = seat();
    s.save(reply({ type: "text", text: "old" }));
    const old = s.harness.anchor();
    s.snapshot();
    rmSync(s.journalPath);
    const gone = s.harness.anchor();
    check("with no journal, a delta anchors at the next file's beginning", gone === "jcode:next-file");
    check("which is after every position on the folded file", s.harness.compare(gone, old) > 0 && s.harness.compare(old, gone) < 0);
    s.save(reply({ type: "text", text: "new" }));
    const fresh = s.harness.anchor();
    check("a position on the file at the path is after one on the folded file", s.harness.compare(fresh, old) > 0 && s.harness.compare(old, fresh) < 0);
    check("and the next file's beginning is before it", s.harness.compare(gone, fresh) < 0 && s.harness.compare(fresh, gone) > 0);
    check("two positions on the same file compare by offset", s.harness.compare(fresh, fresh) === 0);
  }
  console.log("positions across a fold that keeps the inode");
  {
    const s = seat();
    s.save(reply({ type: "text", text: "a folded reply longer than the first one the next journal holds" }));
    const old = s.harness.anchor();
    s.snapshot();
    truncateSync(s.journalPath, 0);
    s.save(reply({ type: "text", text: "new" }));
    const short = s.harness.anchor();
    check("a position on the file at the path is after one past its end on the folded file",
      sameFile(old, short) && s.harness.compare(short, old) > 0 && s.harness.compare(old, short) < 0);
    s.save(reply({ type: "text", text: "a reply that takes the new journal past the folded position" }));
    const long = s.harness.anchor();
    check("...and still after it once the new journal grows past it", s.harness.compare(short, old) > 0 && s.harness.compare(old, short) < 0);
    check("positions on the file at the path still compare by offset", s.harness.compare(short, long) < 0 && s.harness.compare(long, long) === 0);
  }

} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
