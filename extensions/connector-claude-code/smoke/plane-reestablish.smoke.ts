/**
 * The event plane comes back after an outage, with the REAL parts between a Claude transcript and
 * the wire: the JSONL reader, the bound transcript source, the Claude mapper, the write-ahead log,
 * the subject frontier, the emitter and the holder. Only the broker is an instrument. The holder
 * is wired exactly as `mcp.ts` wires it: one source for its lifetime, a mapper built per start and
 * seeded from the log's bracket state, and the gap reporter.
 *
 * Three outages, each measured on 2026-10-12 before the fix as a plane that never published again:
 *
 *   A. the WAL directory becomes unwritable during a flush (the temp-file write fails EACCES; a
 *      full disk fails the same way), which is what the live seat test injected;
 *   B. one publish fails on the network after the frame was frozen pending (Sol's F1);
 *   C. the network failure lands MID-RUN, between the prompt frame and the assistant frame, so the
 *      re-established plane starts with the log's run open (Sol's F2);
 *   D. the turn FAILS while the plane is down: the connector's `StopFailure` terminal arrives
 *      during the outage, for a run the frozen frame opened (Sol's round-3 P1).
 *
 * Each cell asks the one question that matters: once the fault is gone, does the plane publish
 * what was written during and after the outage, under the run the log has open?
 */
import { mkdtempSync, writeFileSync, appendFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { principalKey, type Part } from "@cotal-ai/core";
import { AguiEmitter, AguiEmitterHolder, EventWal, FileSubjectFrontier, ensureEventWalDir, eventPlaneStopped, type DurableSource } from "@cotal-ai/connector-core";
import { createBoundClaudeTranscriptSource } from "../src/agui-source.js";
import { createClaudeMapper, type ClaudeEntry } from "../src/agui-map.js";

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
/** Whether the wire text carries a RUN_FINISHED for `runId` (the event names its run; the frame may not). */
const finished = (wire: string, runId: string) => wire.includes('"type":"RUN_FINISHED","threadId":"') && new RegExp('"type":"RUN_FINISHED","threadId":"[^"]+","runId":"' + runId + '"').test(wire);

/** The broker instrument: a single-replica subject with a scriptable network fault. A frame that
 *  fails here was frozen pending by the log first, as on the real wire. */
class Broker {
  principal = { owner: "local", actor: "tester" };
  actorIsEphemeral = false;
  maxPayload = 1 << 20;
  seq = 0;
  failNext = 0;
  frames: { runId: string; parts: Part[] }[] = [];
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
    // The run the frame names, read off the encoded parts without assuming their shape: an
    // instrument that throws here would fail the publish AFTER accepting it, which is a different
    // outage from the one under test.
    const runId = /"runId":"(run-\d+)"/.exec(JSON.stringify(o.parts))?.[1] ?? "?";
    this.frames.push({ runId, parts: o.parts });
    return { ack: { seq: this.seq, duplicate: false } };
  }
}

/** One plane over one transcript, wired as the connector wires it. */
function plane(opts: { seedMapper: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "plane-reestablish-"));
  const threadId = `thread-${Math.random().toString(36).slice(2, 10)}`;
  const transcript = join(root, `${threadId}.jsonl`);
  const space = "plane";
  const broker = new Broker();
  const principal = principalKey(broker.principal.owner, broker.principal.actor).key;
  const log: string[] = [];
  let runs = 0;
  let n = 0;
  const user = () => {
    n++;
    appendFileSync(
      transcript,
      JSON.stringify({ type: "user", uuid: `u${n}`, timestamp: new Date().toISOString(), origin: { kind: "human" }, message: { role: "user", content: `ping ${n}` } }) + "\n",
    );
  };
  const assistant = (tag = "") => {
    n++;
    appendFileSync(
      transcript,
      JSON.stringify({ type: "assistant", uuid: `a${n}`, timestamp: new Date().toISOString(), message: { id: `m${n}`, role: "assistant", content: [{ type: "text", text: `pong ${n}${tag}` }], stop_reason: "end_turn" } }) + "\n",
    );
  };
  writeFileSync(transcript, "");
  let source: DurableSource<ClaudeEntry> | undefined;
  let mapper: ReturnType<typeof createClaudeMapper> | undefined;
  let walDir = "";
  let starts = 0;
  const holder = new AguiEmitterHolder<ClaudeEntry, unknown>(
    async (path: string, sessionSource: unknown) => {
      starts++;
      const boundSource = (source ??= await createBoundClaudeTranscriptSource(path, sessionSource));
      const { walPath, subjectPath } = await ensureEventWalDir({ workspaceRoot: root, space, principal, threadId: basename(path, ".jsonl") });
      walDir = join(walPath, "..");
      const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space, principal });
      const wal = await EventWal.open(walPath, { space, threadId: basename(path, ".jsonl"), principal, subjectMayExist: false });
      const resumeRunId = opts.seedMapper ? (wal.pending === null ? wal.brackets?.run : wal.pending.brackets.run) : undefined;
      mapper = createClaudeMapper({ threadId: basename(path, ".jsonl"), mintRunId: () => `run-${++runs}`, resumeRunId });
      return AguiEmitter.start<ClaudeEntry>({ endpoint: broker, wal, subjectFrontier, source: boundSource, map: mapper.map, onUnreadable: (g) => log.push(`gap ${g.offset} ${g.reason}`) });
    },
    {
      onError: eventPlaneStopped({ log: (line) => log.push(line) }),
      // As `mcp.ts` wires it: the turn terminal closes a run the record stream never described.
      onRunClosed: (runId: string) => mapper?.forgetOpenRun(runId),
      retryMs: 20,
    },
  );
  const wal = () => {
    const d = JSON.parse(readFileSync(join(walDir, "wal.json"), "utf8")) as { frontier: { seq: number }; pending: null | { state: string } };
    return { seq: d.frontier.seq, pending: d.pending?.state ?? "none" };
  };
  const flush = async () => {
    holder.flush(transcript);
    await holder.settled();
  };
  const turnEnd = async (error?: { message: string; code?: string }) => {
    holder.closeRun(Date.now(), error);
    await holder.settled();
  };
  const close = async () => {
    await holder.close();
    chmodSync(walDir, 0o700);
    rmSync(root, { recursive: true, force: true });
  };
  return { holder, broker, log, transcript, threadId, user, assistant, flush, turnEnd, wal, walDir: () => walDir, starts: () => starts, close };
}

// ---- A. the WAL directory becomes unwritable during a flush ------------------------------------
{
  const p = plane({ seedMapper: true });
  p.holder.adopt(p.transcript, "startup");
  p.user();
  p.assistant();
  await p.flush();
  await p.turnEnd();
  const before = p.broker.seq;
  c("A:CONTROL-one-turn-published-before-the-outage", before > 0 && p.holder.running, { seq: before });
  chmodSync(p.walDir(), 0o500);
  p.user();
  p.assistant();
  await p.flush();
  await p.turnEnd();
  c("A:the-flush-under-the-fault-is-reported-with-a-delay", p.log.some((l) => l.includes("re-establishing the event plane in")), p.log);
  c("A:nothing-published-under-the-fault", p.broker.seq === before, p.broker.seq);
  chmodSync(p.walDir(), 0o700);
  await sleep(250);
  await p.holder.settled();
  c("A:the-plane-is-back-after-the-fault-clears", p.holder.running && p.starts() >= 2, { running: p.holder.running, starts: p.starts() });
  c("A:the-turn-written-under-the-fault-is-published-after-it", p.broker.seq > before, { before, after: p.broker.seq });
  const mid = p.broker.seq;
  p.user();
  p.assistant();
  await p.flush();
  await p.turnEnd();
  c("A:a-later-turn-publishes-on-the-re-established-plane", p.broker.seq > mid && p.wal().seq === p.broker.seq && p.wal().pending === "none", { mid, after: p.broker.seq, wal: p.wal() });
  await p.close();
}

// ---- B. one publish fails on the network after the frame is frozen -----------------------------
{
  const p = plane({ seedMapper: true });
  p.holder.adopt(p.transcript, "startup");
  p.user();
  p.assistant();
  await p.flush();
  await p.turnEnd();
  const before = p.broker.seq;
  p.broker.failNext = 1;
  p.user();
  p.assistant();
  await p.flush();
  c("B:the-failed-publish-leaves-the-frame-frozen-pending", p.wal().pending === "sent_unacked", p.wal());
  await p.turnEnd();
  await sleep(250);
  await p.holder.settled();
  c("B:the-re-establish-settles-the-pending-frame", p.wal().pending === "none" && p.holder.running, { wal: p.wal(), running: p.holder.running });
  c("B:the-frozen-frame-is-published-once-the-network-is-back", p.broker.seq > before, { before, after: p.broker.seq });
  const mid = p.broker.seq;
  p.user();
  p.assistant();
  await p.flush();
  await p.turnEnd();
  c("B:a-later-turn-publishes-on-the-re-established-plane", p.broker.seq > mid && p.wal().seq === p.broker.seq, { mid, after: p.broker.seq, wal: p.wal() });
  await p.close();
}

// ---- C. the network failure lands mid-run --------------------------------------------------------
for (const seedMapper of [true, false]) {
  const p = plane({ seedMapper });
  const tag = seedMapper ? "C" : "C:CONTROL-unseeded";
  p.holder.adopt(p.transcript, "startup");
  p.user();
  p.assistant();
  await p.flush();
  await p.turnEnd();
  p.user(); // the prompt of run-2 lands on its own: the run is open on the wire and in the log
  await p.flush();
  const openRun = p.broker.frames[p.broker.frames.length - 1]!.runId;
  c(`${tag}:CONTROL-the-prompt-opened-a-run-on-the-wire`, openRun === "run-2", openRun);
  p.broker.failNext = 1;
  p.assistant(" during"); // the assistant frame of run-2 fails on the wire
  await p.flush();
  await sleep(250);
  await p.holder.settled();
  c(`${tag}:the-mid-run-frame-is-published-after-the-re-establish`, p.holder.running && p.wal().pending === "none" && p.broker.frames.some((f) => f.runId === "run-2" && JSON.stringify(f.parts).includes("during")), { running: p.holder.running, wal: p.wal() });
  p.assistant(" after"); // the rest of run-2, written after the plane came back
  await p.flush();
  const afterFrame = p.broker.frames.find((f) => JSON.stringify(f.parts).includes("after"));
  await p.turnEnd();
  p.user();
  p.assistant();
  await p.flush();
  await p.turnEnd();
  const nextRun = p.broker.frames[p.broker.frames.length - 1]!.runId;
  if (seedMapper) {
    c("C:the-rest-of-the-run-is-attributed-to-the-run-the-log-has-open", afterFrame?.runId === "run-2", afterFrame?.runId);
    c("C:the-next-prompt-opens-the-next-run", nextRun === "run-3" && p.holder.running, { nextRun, running: p.holder.running });
  } else {
    // What the unseeded mapper does, and why `mcp.ts` seeds it: the rest of the run is dropped
    // without a word. (The turn terminal still closes run-2 on the wire, so the next prompt
    // opens cleanly; the loss is the records, and nothing reports it.)
    c("C:CONTROL-an-unseeded-mapper-drops-the-rest-of-the-run", afterFrame === undefined && nextRun === "run-3", { afterFrame: afterFrame?.runId, nextRun });
  }
  await p.close();
}

// ---- D. the turn fails while the plane is down -------------------------------------------------
{
  const p = plane({ seedMapper: true });
  p.holder.adopt(p.transcript, "startup");
  p.user();
  p.assistant();
  await p.flush();
  await p.turnEnd();
  p.broker.failNext = 1;
  p.user(); // run-2's prompt frame fails on the wire: frozen pending, run-2 open in the log
  p.assistant(" failed-turn");
  await p.flush();
  c("D:CONTROL-the-plane-is-down-with-run-2-frozen", p.wal().pending === "sent_unacked" && !p.holder.running, { wal: p.wal(), running: p.holder.running });
  await p.turnEnd({ message: "rate_limit", code: "rate_limit" }); // the terminal arrives during the outage
  c("D:CONTROL-nothing-closed-while-down", !p.broker.frames.some((f) => JSON.stringify(f.parts).includes("RUN_ERROR")));
  await sleep(250);
  await p.holder.settled();
  const run2 = p.broker.frames.filter((f) => f.runId === "run-2").map((f) => JSON.stringify(f.parts));
  c("D:the-turn-written-under-the-fault-is-published-under-run-2", run2.some((s) => s.includes("failed-turn")), run2.length);
  // The emitter publishes its fixed egress message for an error close, never the connector's text.
  c("D:the-held-terminal-closes-run-2-with-RUN_ERROR-after-the-re-establish", run2.some((s) => s.includes('"type":"RUN_ERROR"')) && p.holder.running, { run2, running: p.holder.running });
  c("D:the-records-come-before-the-terminal", run2.findIndex((s) => s.includes("failed-turn")) < run2.findIndex((s) => s.includes("RUN_ERROR")), run2);
  p.user();
  p.assistant();
  await p.flush();
  await p.turnEnd();
  const nextRun = p.broker.frames[p.broker.frames.length - 1]!.runId;
  c("D:the-next-prompt-opens-run-3-and-no-finish-is-synthesized-for-run-2", nextRun === "run-3" && !finished(p.broker.frames.map((f) => JSON.stringify(f.parts)).join(""), "run-2"), { nextRun });
  await p.close();
}

// ---- E. the terminal's own log write fails ------------------------------------------------------
{
  // Prompt and assistant fully acknowledged, the run open; then the directory becomes unwritable
  // and the only thing that fails is the terminal's write (Sol, review of 2026-10-13, through the
  // built MCP entry point: the terminal was lost and the next prompt closed the run as a finish).
  const p = plane({ seedMapper: true });
  p.holder.adopt(p.transcript, "startup");
  p.user();
  p.assistant();
  await p.flush();
  await p.turnEnd();
  p.user();
  p.assistant(" acked");
  await p.flush();
  const acked = p.broker.seq;
  c("E:CONTROL-run-2-is-open-and-fully-acknowledged", p.wal().pending === "none" && p.wal().seq === acked && p.holder.running && p.broker.frames.some((f) => f.runId === "run-2"), { wal: p.wal(), acked });
  chmodSync(p.walDir(), 0o500);
  await p.turnEnd({ message: "rate_limit", code: "rate_limit" });
  c("E:CONTROL-the-terminal-write-failed-and-the-plane-is-down", !p.holder.running && p.broker.seq === acked, { running: p.holder.running, seq: p.broker.seq });
  chmodSync(p.walDir(), 0o700);
  await sleep(250);
  await p.holder.settled();
  const run2 = p.broker.frames.filter((f) => f.runId === "run-2").map((f) => JSON.stringify(f.parts));
  c("E:the-terminal-whose-write-failed-is-published-after-the-re-establish", run2.some((s) => s.includes('"type":"RUN_ERROR"')) && p.holder.running, { run2: run2.length, running: p.holder.running });
  p.user();
  p.assistant();
  await p.flush();
  await p.turnEnd();
  c("E:the-next-prompt-opens-run-3-and-run-2-is-not-closed-as-a-finish", p.broker.frames[p.broker.frames.length - 1]!.runId === "run-3" && !finished(p.broker.frames.map((f) => JSON.stringify(f.parts)).join(""), "run-2"));
  await p.close();
}

// ---- F. the connector repeats the terminal during the outage -----------------------------------
{
  // A stop failure and then a stop for the same run, both while the plane is down (the live seat
  // sends both). The first terminal is the run's; the later finish must not replace it.
  const p = plane({ seedMapper: true });
  p.holder.adopt(p.transcript, "startup");
  p.user();
  p.assistant();
  await p.flush();
  await p.turnEnd();
  p.user();
  await p.flush(); // run-2 open and acknowledged on the wire
  chmodSync(p.walDir(), 0o500);
  p.assistant(" under-fault");
  await p.flush(); // the assistant frame's write fails: down
  c("F:CONTROL-the-plane-is-down-with-run-2-open", !p.holder.running, p.holder.running);
  await p.turnEnd({ message: "rate_limit", code: "rate_limit" });
  await p.turnEnd(); // the repeated terminal
  chmodSync(p.walDir(), 0o700);
  await sleep(250);
  await p.holder.settled();
  const run2 = p.broker.frames.filter((f) => f.runId === "run-2").map((f) => JSON.stringify(f.parts));
  c("F:the-FIRST-terminal-is-the-one-published", run2.some((s) => s.includes('"type":"RUN_ERROR"')) && !run2.some((s) => s.includes("RUN_FINISHED")) && run2.some((s) => s.includes("under-fault")) && p.holder.running, { run2, running: p.holder.running });
  await p.close();
}

// ---- G. the next prompt is already written when the plane comes back --------------------------
{
  // As E, but the user types the next prompt (and the assistant answers it) during the outage, so
  // the re-establish reads that prompt among the unread records. The failed run must still get
  // its error, after its own records and before the next run opens (Sol, round 5, through the
  // built MCP entry point: the failed run got one RUN_FINISHED and no RUN_ERROR).
  const p = plane({ seedMapper: true });
  p.holder.adopt(p.transcript, "startup");
  p.user();
  p.assistant();
  await p.flush();
  await p.turnEnd();
  p.user();
  p.assistant(" acked");
  await p.flush();
  chmodSync(p.walDir(), 0o500);
  await p.turnEnd({ message: "rate_limit", code: "rate_limit" }); // the terminal's own write fails
  c("G:CONTROL-the-terminal-write-failed-and-the-plane-is-down", !p.holder.running, p.holder.running);
  p.user(); // the next prompt, written during the outage
  p.assistant(" next-turn");
  p.holder.flush(p.transcript); // the hook fires while the plane is down: nothing is read
  await p.holder.settled();
  chmodSync(p.walDir(), 0o700);
  await sleep(250);
  await p.holder.settled();
  // The finish a prompt synthesizes for the prior run travels in the NEXT run's frame (the unit is
  // the prompt's), so the wire is read at the event level, not by frame label.
  const wire = p.broker.frames.map((f) => JSON.stringify(f.parts)).join("");
  const errorAt = wire.indexOf('"type":"RUN_ERROR"');
  const nextOpenAt = wire.indexOf('"type":"RUN_STARTED","threadId":"' + p.threadId + '","runId":"run-3"');
  c("G:the-failed-run-is-closed-with-RUN_ERROR-not-the-synthesized-finish", errorAt >= 0 && !finished(wire, "run-2") && p.holder.running, { errorAt, finished: finished(wire, "run-2"), running: p.holder.running });
  c("G:the-error-comes-after-the-failed-runs-records-and-before-the-next-run-opens", errorAt >= 0 && nextOpenAt > errorAt && wire.indexOf("acked") < errorAt, { errorAt, nextOpenAt, acked: wire.indexOf("acked") });
  c("G:the-next-turn-publishes-under-its-own-run", p.broker.frames.some((f) => f.runId === "run-3" && JSON.stringify(f.parts).includes("next-turn")), p.broker.frames.filter((f) => f.runId === "run-3").length);
  const before = p.broker.frames.length;
  await p.turnEnd();
  const last = p.broker.frames[p.broker.frames.length - 1]!;
  c("G:the-next-runs-own-terminal-closes-it-as-a-finish", p.broker.frames.length > before && last.runId === "run-3" && finished(JSON.stringify(last.parts), "run-3"));
  await p.close();
}

// ---- H. the terminal's write keeps failing: the retry is paced ----------------------------------
{
  const p = plane({ seedMapper: true });
  p.holder.adopt(p.transcript, "startup");
  p.user();
  p.assistant();
  await p.flush();
  chmodSync(p.walDir(), 0o500);
  await p.turnEnd({ message: "rate_limit", code: "rate_limit" });
  await sleep(300); // 20, 40, 80, 160: four re-establishes, each reading nothing and failing the close again
  await p.holder.settled();
  const delays = p.log.map((l) => /re-establishing the event plane in (\d+)ms/.exec(l)?.[1]).filter((d): d is string => d !== undefined);
  c("H:the-delay-DOUBLES-while-the-terminal-write-keeps-failing", delays.slice(0, 3).join(",") === "20,40,80", delays);
  chmodSync(p.walDir(), 0o700);
  await sleep(400);
  await p.holder.settled();
  c("H:the-terminal-is-published-once-the-write-goes-through", p.broker.frames.some((f) => f.runId === "run-1" && JSON.stringify(f.parts).includes('"type":"RUN_ERROR"')) && p.holder.running, { frames: p.broker.frames.length, running: p.holder.running });
  await p.close();
}

console.log(`claude-plane-reestablish smoke: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
