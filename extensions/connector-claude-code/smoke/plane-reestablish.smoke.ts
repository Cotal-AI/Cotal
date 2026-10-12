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
  return { holder, broker, log, transcript, user, assistant, flush, turnEnd, wal, walDir: () => walDir, starts: () => starts, close };
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
  c("D:the-next-prompt-opens-run-3-and-no-finish-is-synthesized-for-run-2", nextRun === "run-3" && !run2.some((s) => s.includes("RUN_FINISHED")) && !p.broker.frames.some((f) => f.runId === "run-2" && JSON.stringify(f.parts).includes("RUN_FINISHED")), { nextRun });
  await p.close();
}

console.log(`claude-plane-reestablish smoke: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
