/**
 * Closing a run at a boundary the RECORD STREAM CANNOT SEE.
 *
 * The durable plane reads a file; a harness reports the end of a turn through a lifecycle hook that
 * writes no record. Without an out-of-band terminal the finish can only be derived from the NEXT
 * turn's opening record, which means a live view shows a finished agent as still running and the
 * last run of a session never closes at all. `AguiEmitter.closeRun` is that terminal.
 *
 * WHAT IS REAL AND WHAT IS NOT. The `EventWal` is real, on a real filesystem, and every frontier
 * claim below is re-read from DISK rather than from the object that just published. Only the broker
 * is substituted, by an instrument that RECORDS calls, because most of what this file asserts is
 * about a call that must NOT happen and a mock that only returns a value cannot testify to an
 * absence.
 *
 * KILL SET, predicted as NAMES before the run:
 *   K1  take the cursor from a fresh source read, the copy-paste from `pump`, instead of
 *       republishing the frontier's own
 *       -> `close:the-source-cursor-is-REPUBLISHED-UNCHANGED`
 *   K2  mint a run id when none is open, instead of answering null
 *       -> `close:a-stream-at-a-stopping-point-answers-null-and-publishes-NOTHING`
 *   K3  drop the pending guard -> `close:a-PENDING-frame-refuses-the-close`
 *   K4  drop the halted guard -> `close:a-HALTED-emitter-refuses-to-close`
 *   K5  drop the `onRunClosed` report
 *       -> `holder:the-closed-run-is-reported-so-a-mapper-can-forget-it`
 *   K6  publish a finish even when a failure was reported, which is what this plane shipped
 *       -> `close:the-closing-frame-carries-exactly-one-RUN_ERROR-with-its-message-and-code`
 *   K7  drop the reason in the holder, one layer above the emitter that would have carried it
 *       -> `holder:the-failure-reaches-the-wire-as-RUN_ERROR-with-the-reason-it-was-given`
 *   K8  skip the close-path bound, so an oversized failure detail still throws in packUnits
 *       -> `close:an-oversized-failure-detail-still-emits-exactly-one-bounded-RUN_ERROR`
 *   K9  delete `this.run = undefined` from the shared terminal arm of AguiBrackets.accept
 *       -> `close:a-run-closed-by-RUN_ERROR-can-NEVER-also-emit-a-RUN_FINISHED`
 *       The property is real; the claim that no deletion can violate it was false. The machine
 *       staying open after RUN_ERROR is exactly the line that lets a second close publish a finish.
 *
 * WHAT CARRIES NO KILL, NAMED RATHER THAN COUNTED AS COVERAGE:
 *   - the clone validation before the publish. A closing unit is ONE event, and the real machine
 *     refuses it before mutating anything, so removing the clone changes no observable outcome. It
 *     is kept as symmetry with `pump`, where a multi-event batch makes it load-bearing, and it is
 *     not claimed as a checked property here.
 *   - `holder:a-close-on-a-holder-that-never-adopted-starts-NOTHING` is enforced by the SIGNATURE:
 *     `closeRun` takes no path, so there is nothing to start an emitter from. The cell is a fence
 *     against a future signature that takes one, not evidence about today's code.
 *
 * Run: pnpm smoke:agui-close-run
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Part } from "@cotal-ai/core";
import {
  AguiEmitter,
  AguiEmitterHalted,
  AguiVocabularyError,
  runStarted,
  textMessageStart,
  textMessageContent,
  textMessageEnd,
  type AguiEvent,
  type AguiFrame,
} from "../src/agui.js";
import { AguiEmitterHolder } from "../src/agui-holder.js";
import { JsonlFileSource } from "../src/durable-source.js";
import { EventWal } from "../src/event-wal.js";
import { memorySubjectFrontier } from "@cotal-ai/smoke-kit";

let ok = 0,
  fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++;
  else {
    fail++;
    console.log("  x FAIL:", n, extra ?? "");
  }
};

/** Run and report the refusal AS A VALUE, so a cell keeps reporting when its subject throws. */
const attempt = async <T>(fn: () => Promise<T>): Promise<{ value?: T; err?: Error }> => {
  try {
    return { value: await fn() };
  } catch (e) {
    return { err: e as Error };
  }
};

/** A crash anywhere in a block must not silence the other blocks' cells. */
const block = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (e) {
    c(`${name} (block crashed)`, false, String(e));
  }
};

const PRINCIPAL = { owner: "local", actor: "aaa" };
const PRINCIPAL_KEY = "local.aaa";
const SPACE = "main";
const THREAD = "thread-1";

interface Call {
  id: string;
  expectedLastSubjectSeq: number;
  parts: Part[];
  channel: string;
  encodedSize: number;
}

class FakeEndpoint {
  readonly principal = PRINCIPAL;
  readonly actorIsEphemeral = false;
  maxPayload = 4096;
  publishes: Call[] = [];
  answers: ({ seq: number; duplicate: boolean } | Error)[] = [];

  async assertExpectationSemantics(): Promise<void> {}

  encodedSize(o: { channel: string; parts: Part[]; id: string; expectedLastSubjectSeq: number }): number {
    return (
      Buffer.byteLength(
        JSON.stringify({ channel: o.channel, parts: o.parts, id: o.id, e: o.expectedLastSubjectSeq }),
        "utf8",
      ) + 64
    );
  }

  async multicastExpecting(o: {
    channel: string;
    parts: Part[];
    id: string;
    expectedLastSubjectSeq: number;
  }): Promise<{ ack: { seq: number; duplicate: boolean } }> {
    const encodedSize = this.encodedSize(o);
    // THE INSTRUMENT ENFORCES THE CEILING, because the broker does. A fake that accepts any size
    // cannot witness an over-packed closing frame — the defect this suite's boundary cell grades.
    if (encodedSize > this.maxPayload)
      throw new Error(`FakeEndpoint: payload ${encodedSize} exceeds max_payload ${this.maxPayload}`);
    this.publishes.push({
      id: o.id,
      expectedLastSubjectSeq: o.expectedLastSubjectSeq,
      parts: o.parts,
      channel: o.channel,
      encodedSize,
    });
    const a = this.answers.shift();
    if (a === undefined) throw new Error("FakeEndpoint: publish with no scripted answer");
    if (a instanceof Error) throw a;
    return { ack: a };
  }
}

/**
 * A record that OPENS a run and leaves it open, which is the state a turn is in when its hook fires.
 * `full` additionally leaves a MESSAGE open, which is the one shape a close must refuse.
 */
type Rec = { open: string } | { open: string; dangling: true } | { skip: true };

const mapper = (r: Rec): { runId: string; events: AguiEvent[] } | null => {
  if ("skip" in r) return null;
  const events: AguiEvent[] = [runStarted({ threadId: THREAD, runId: r.open, timestamp: 1 })];
  if ("dangling" in r) {
    events.push(textMessageStart({ messageId: "m1", timestamp: 2, role: "assistant" }));
    events.push(textMessageContent({ messageId: "m1", delta: "half a sentence", timestamp: 3 }));
  } else {
    events.push(textMessageStart({ messageId: "m1", timestamp: 2, role: "assistant" }));
    events.push(textMessageContent({ messageId: "m1", delta: "a whole one", timestamp: 3 }));
    events.push(textMessageEnd({ messageId: "m1", timestamp: 4 }));
  }
  return { runId: r.open, events };
};

const dir = mkdtempSync(join(tmpdir(), "agui-close-"));

const fresh = async (name: string) => {
  const d = join(dir, name);
  const src = join(d, "session.jsonl");
  const walPath = join(d, "wal.json");
  mkdirSync(d, { recursive: true });
  writeFileSync(src, "");
  const wal = await EventWal.open(walPath, {
    space: SPACE,
    threadId: THREAD,
    principal: PRINCIPAL_KEY,
    subjectMayExist: false,
  });
  return { d, src, walPath, wal, source: new JsonlFileSource<Rec>(src) };
};

const append = (path: string, ...recs: Rec[]) => {
  appendFileSync(path, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
};

const frameOf = (call: Call): AguiFrame => call.parts[0] as unknown as AguiFrame;

const reopen = (walPath: string) =>
  EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: true });

try {
  // ── AN OPEN RUN IS CLOSED, AND THE CLOSING FRAME CONSUMES NO RECORD ──────────────────────────
  await block("AN OPEN RUN IS CLOSED, AND THE CLOSING FRAME CONSUMES NO RECORD", async () => {
    const { src, walPath, wal, source } = await fresh("closes");
    const ep = new FakeEndpoint();
    const em = await AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map: mapper });
    // ADOPT FIRST. A fresh read starts at the current end of file, so a record appended before the
    // first pump is skipped BY DESIGN and a fixture that skips it measures nothing.
    const adopt = await em.pump();
    c("close:CONTROL-the-adopting-read-publishes-nothing", adopt.frames === 0 && ep.publishes.length === 0, adopt);
    append(src, { open: "run-a" });
    ep.answers = [{ seq: 11, duplicate: false }];
    await em.pump();

    const afterPump = await reopen(walPath);
    const cursorBefore = afterPump.frontier.sourceCursor;
    const seqBefore = afterPump.frontier.seq;

    // A RECORD LANDS BETWEEN THE FLUSH AND THE CLOSE, which is the real shape of a turn ending: the
    // hook fires, the holder flushes, and the harness writes its last bytes a moment later. If the
    // closing frame took its cursor from a fresh read instead of from the frontier, this record
    // would be marked consumed without ever being mapped, and nothing downstream would show a gap.
    append(src, { open: "run-late" });

    ep.answers = [{ seq: 12, duplicate: false }];
    const closed = await attempt(() => em.closeRun({ timestamp: 99 }));

    c("close:an-open-run-is-CLOSED-and-the-terminal-NAMES-it", closed.value === "run-a", {
      returned: closed.value,
      err: closed.err?.message,
    });

    const last = ep.publishes[ep.publishes.length - 1];
    const frame = last ? frameOf(last) : undefined;
    c(
      "close:the-closing-frame-carries-exactly-one-RUN_FINISHED-for-that-run",
      ep.publishes.length === 2 &&
        frame?.events.length === 1 &&
        (frame.events[0] as { type?: string }).type === "RUN_FINISHED" &&
        (frame.events[0] as { runId?: string }).runId === "run-a" &&
        frame.runId === "run-a",
      { publishes: ep.publishes.length, events: frame?.events },
    );

    // THE CURSOR IS THE POINT. A closing frame maps no record, so a cursor that moved would mark
    // records consumed that were never mapped, and the next read would skip them with no seq gap
    // for a consumer to notice. Read from DISK: the claim is about what was persisted.
    const afterClose = await reopen(walPath);
    c(
      "close:the-source-cursor-is-REPUBLISHED-UNCHANGED",
      afterClose.frontier.sourceCursor === cursorBefore && cursorBefore !== undefined,
      { before: cursorBefore, after: afterClose.frontier.sourceCursor },
    );
    c("close:the-frame-sequence-DOES-advance", afterClose.frontier.seq === seqBefore + 1, {
      before: seqBefore,
      after: afterClose.frontier.seq,
    });

    // Idempotence, through the bracket machine rather than a flag.
    const again = await attempt(() => em.closeRun({ timestamp: 100 }));
    c(
      "close:a-stream-at-a-stopping-point-answers-null-and-publishes-NOTHING",
      again.value === null && again.err === undefined && ep.publishes.length === 2,
      { returned: again.value, err: again.err?.message, publishes: ep.publishes.length },
    );

    // The record that landed mid-close is STILL THERE to be mapped, and a record arriving after an
    // out-of-band close must not throw: a closed run leaves the machine at a legal stopping point,
    // so the next opening record is taken exactly as it would have been.
    ep.answers = [{ seq: 13, duplicate: false }];
    const late = await attempt(() => em.pump());
    c(
      "close:the-record-that-landed-DURING-the-close-is-still-emitted",
      late.err === undefined && late.value?.frames === 1 && late.value?.events === 4,
      { err: late.err?.message, pumped: late.value },
    );
  });

  // ── A CLOSE THAT WOULD BE A PROTOCOL VIOLATION IS REFUSED, NOT PUBLISHED ─────────────────────
  await block("A CLOSE THAT WOULD BE A PROTOCOL VIOLATION IS REFUSED, NOT PUBLISHED", async () => {
    const { src, wal, source } = await fresh("dangling");
    const ep = new FakeEndpoint();
    const em = await AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map: mapper });
    await em.pump(); // adopt
    append(src, { open: "run-a", dangling: true });
    ep.answers = [{ seq: 21, duplicate: false }];
    await em.pump();
    const publishesBefore = ep.publishes.length;

    const closed = await attempt(() => em.closeRun({ timestamp: 99 }));
    c(
      "close:a-message-still-open-under-the-run-REFUSES-and-publishes-NOTHING",
      closed.err instanceof AguiVocabularyError && ep.publishes.length === publishesBefore,
      { err: closed.err?.message, published: ep.publishes.length - publishesBefore },
    );
  });

  // ── A RUN OPENED BY A PREVIOUS PROCESS CLOSES AFTER A RESTART ────────────────────────────────
  //
  // The bracket machine is restored from the WAL, so the terminal does not depend on the process
  // that opened the run still being alive. This is the case the LAST run of a session is in.
  await block("A RUN OPENED BY A PREVIOUS PROCESS CLOSES AFTER A RESTART", async () => {
    const { src, walPath, wal, source } = await fresh("restart");
    const ep = new FakeEndpoint();
    const em = await AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map: mapper });
    await em.pump(); // adopt
    append(src, { open: "run-a" });
    ep.answers = [{ seq: 31, duplicate: false }];
    await em.pump();

    // A NEW process: a fresh WAL object over the same file and a fresh emitter.
    const wal2 = await reopen(walPath);
    const ep2 = new FakeEndpoint();
    const em2 = await AguiEmitter.start({ endpoint: ep2, wal: wal2, subjectFrontier: memorySubjectFrontier(), source: new JsonlFileSource<Rec>(src), map: mapper });
    ep2.answers = [{ seq: 32, duplicate: false }];
    const closed = await attempt(() => em2.closeRun({ timestamp: 99 }));
    c("close:a-run-opened-by-a-PREVIOUS-process-closes-after-a-restart", closed.value === "run-a", {
      returned: closed.value,
      err: closed.err?.message,
    });
  });

  // ── A HALTED EMITTER REFUSES TO CLOSE ────────────────────────────────────────────────────────
  await block("A HALTED EMITTER REFUSES TO CLOSE", async () => {
    const { src, wal, source } = await fresh("halted");
    const ep = new FakeEndpoint();
    const em = await AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map: mapper });
    await em.pump(); // adopt
    append(src, { open: "run-a" });
    ep.answers = [{ seq: 41, duplicate: true }]; // a body we never wrote holds our id
    const pumped = await attempt(() => em.pump());
    c("close:CONTROL-the-duplicate-ack-really-halted-the-emitter", pumped.err instanceof AguiEmitterHalted && em.stopped, {
      err: pumped.err?.message,
      stopped: em.stopped,
    });
    const publishesBefore = ep.publishes.length;
    // Scripted DELIBERATELY: without an answer waiting, an emitter that ignored the halt would fail
    // on the instrument rather than on the guard, and the cell would redden for the wrong reason.
    ep.answers = [{ seq: 42, duplicate: false }];
    const closed = await attempt(() => em.closeRun({ timestamp: 99 }));
    c(
      "close:a-HALTED-emitter-refuses-to-close",
      closed.err instanceof AguiEmitterHalted && ep.publishes.length === publishesBefore,
      { err: closed.err?.message, published: ep.publishes.length - publishesBefore },
    );
  });

  // ── AN UNCERTAIN FRAME REFUSES THE CLOSE ─────────────────────────────────────────────────────
  //
  // A network error leaves `pending` as `sent_unacked`, which is the state that means WE DO NOT
  // KNOW. Closing on top of it would publish a second frame claiming a `seq` the pending frame may
  // already hold, and the recovery that exists to re-publish the frozen one would then be racing a
  // frame nothing recorded.
  await block("AN UNCERTAIN FRAME REFUSES THE CLOSE", async () => {
    const { src, wal, source } = await fresh("pending");
    const ep = new FakeEndpoint();
    const em = await AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map: mapper });
    await em.pump(); // adopt
    append(src, { open: "run-a" });
    ep.answers = [new Error("connection reset")];
    const pumped = await attempt(() => em.pump());
    c(
      "close:CONTROL-a-network-error-really-left-the-frame-PENDING",
      pumped.err !== undefined && wal.pending?.state === "sent_unacked",
      { err: pumped.err?.message, pending: wal.pending },
    );
    const publishesBefore = ep.publishes.length;
    ep.answers = [{ seq: 61, duplicate: false }];
    const closed = await attempt(() => em.closeRun({ timestamp: 99 }));
    c(
      "close:a-PENDING-frame-refuses-the-close",
      closed.err !== undefined && /still pending/.test(closed.err.message) && ep.publishes.length === publishesBefore,
      { err: closed.err?.message, published: ep.publishes.length - publishesBefore },
    );
  });

  // ── THE HOLDER: THE SAME CONTRACT THE HOOK RELAY ALREADY CALLS ───────────────────────────────
  await block("THE HOLDER: THE SAME CONTRACT THE HOOK RELAY ALREADY CALLS", async () => {
    const { src, wal, source } = await fresh("holder");
    const ep = new FakeEndpoint();
    const errors: Error[] = [];
    const closedRuns: string[] = [];
    const holder = new AguiEmitterHolder<Rec>(
      async () => AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map: mapper }),
      (e) => errors.push(e),
      (runId) => closedRuns.push(runId),
    );

    holder.flush(src); // adopt
    await holder.settled();
    append(src, { open: "run-a" });
    ep.answers = [{ seq: 51, duplicate: false }, { seq: 52, duplicate: false }];
    holder.flush(src);
    await holder.settled();
    holder.closeRun(99);
    await holder.settled();

    c(
      "holder:the-closed-run-is-reported-so-a-mapper-can-forget-it",
      closedRuns.length === 1 && closedRuns[0] === "run-a" && errors.length === 0,
      { closedRuns, errors: errors.map((e) => e.message) },
    );

    // Reported ONCE. A second close has nothing open, so it must not report a run again: a mapper
    // told twice would forget a run it had legitimately reopened in between.
    holder.closeRun(100);
    await holder.settled();
    c("holder:a-second-close-reports-NOTHING", closedRuns.length === 1, closedRuns);
  });

  // ── AN ERROR CLOSE PUBLISHES RUN_ERROR, AND IT IS STILL A CLOSE ─────────────────────────────
  //
  // A turn that FAILED ended too, so it closes through this same terminal — the connector supplies
  // the reason and this file carries it to the wire. The property that matters to a reader is not
  // which method was called but WHAT THE SEQUENCE SAYS: `RUN_ERROR` closes a run on its own, so a
  // run that emitted one must never also emit a `RUN_FINISHED`. That is graded below by asking the
  // stream, after an error close, for another close and requiring it to publish nothing.
  await block("AN ERROR CLOSE PUBLISHES RUN_ERROR, AND IT IS STILL A CLOSE", async () => {
    const { src, walPath, wal, source } = await fresh("error-close");
    const ep = new FakeEndpoint();
    const em = await AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map: mapper });
    await em.pump(); // adopt
    append(src, { open: "run-e" });
    ep.answers = [{ seq: 21, duplicate: false }];
    await em.pump();

    const beforeClose = await reopen(walPath);
    const cursorBefore = beforeClose.frontier.sourceCursor;

    ep.answers = [{ seq: 22, duplicate: false }];
    const closed = await attempt(() =>
      em.closeRun({ timestamp: 99, error: { message: "upstream returned 500", code: "APIError" } }),
    );
    c("close:an-ERROR-close-names-the-run-it-closed", closed.value === "run-e", {
      returned: closed.value,
      err: closed.err?.message,
    });

    const errFrame = frameOf(ep.publishes[ep.publishes.length - 1]!);
    const ev = errFrame.events[0] as { type?: string; message?: string; code?: string; runId?: string };
    c(
      "close:the-closing-frame-carries-exactly-one-RUN_ERROR-with-its-message-and-code",
      errFrame.events.length === 1 &&
        ev.type === "RUN_ERROR" &&
        ev.message === "upstream returned 500" &&
        ev.code === "APIError" &&
        // RUN_ERROR has no runId of its own; the FRAME is what attributes it to a run.
        ev.runId === undefined &&
        errFrame.runId === "run-e",
      { events: errFrame.events, frameRun: errFrame.runId },
    );

    // Same cursor discipline as the finish: this frame consumed no source record either.
    const afterClose = await reopen(walPath);
    c(
      "close:an-ERROR-close-republishes-the-source-cursor-UNCHANGED",
      afterClose.frontier.sourceCursor === cursorBefore && cursorBefore !== undefined,
      { before: cursorBefore, after: afterClose.frontier.sourceCursor },
    );

    // THE SEQUENCE PROPERTY, asked of the stream rather than of the caller. Nothing here inspects
    // which method ran; it asks the emitter for an ordinary close and requires the answer to be
    // that there is nothing left to close, and requires the wire to have gained no frame.
    const publishesAfterError = ep.publishes.length;
    const second = await attempt(() => em.closeRun({ timestamp: 100 }));
    c(
      "close:a-run-closed-by-RUN_ERROR-can-NEVER-also-emit-a-RUN_FINISHED",
      second.value === null && second.err === undefined && ep.publishes.length === publishesAfterError,
      { returned: second.value, err: second.err?.message, publishes: ep.publishes.length },
    );
    const allEvents = ep.publishes.flatMap((call) => frameOf(call).events as { type?: string }[]);
    c(
      "close:and-no-RUN_FINISHED-appears-ANYWHERE-in-what-this-stream-published",
      !allEvents.some((e) => e.type === "RUN_FINISHED"),
      allEvents.map((e) => e.type),
    );
  });

  await block("THE HOLDER CARRIES A FAILURE THROUGH THE SAME CLOSE", async () => {
    const { src, wal, source } = await fresh("holder-error-close");
    const ep = new FakeEndpoint();
    const errors: Error[] = [];
    const closedRuns: string[] = [];
    const holder = new AguiEmitterHolder<Rec>(
      async () => AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map: mapper }),
      (e) => errors.push(e),
      (runId) => closedRuns.push(runId),
    );

    holder.flush(src); // adopt
    await holder.settled();
    append(src, { open: "run-h" });
    ep.answers = [{ seq: 61, duplicate: false }, { seq: 62, duplicate: false }];
    holder.flush(src);
    await holder.settled();
    holder.closeRun(99, { message: "provider rejected the request", code: "ProviderAuthError" });
    await holder.settled();

    const frame = frameOf(ep.publishes[ep.publishes.length - 1]!);
    const ev = frame.events[0] as { type?: string; message?: string; code?: string };
    c(
      "holder:the-failure-reaches-the-wire-as-RUN_ERROR-with-the-reason-it-was-given",
      ev.type === "RUN_ERROR" && ev.message === "provider rejected the request" && ev.code === "ProviderAuthError",
      { events: frame.events, errors: errors.map((e) => e.message) },
    );
    // An error close is still a close, so the mapper must be told to forget the run exactly as it is
    // told after a finish. Without this it attributes the next turn's records to a closed run.
    c(
      "holder:an-ERROR-close-reports-the-closed-run-so-a-mapper-can-forget-it",
      closedRuns.length === 1 && closedRuns[0] === "run-h" && errors.length === 0,
      { closedRuns, errors: errors.map((e) => e.message) },
    );
  });

  await block("THE HOLDER STARTS NOTHING ON THE WAY OUT OF A TURN", async () => {
    const { src, wal, source } = await fresh("holder-never-adopted");
    const ep = new FakeEndpoint();
    let started = 0;
    const holder = new AguiEmitterHolder<Rec>(
      async () => {
        started += 1;
        return AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(), source, map: mapper });
      },
      () => {},
      () => {},
    );
    holder.closeRun(99);
    await holder.settled();
    c(
      "holder:a-close-on-a-holder-that-never-adopted-starts-NOTHING",
      started === 0 && ep.publishes.length === 0 && holder.running === false,
      { started, publishes: ep.publishes.length, running: holder.running },
    );
    // And it did not BIND either. A holder that bound a path here would refuse the real transcript
    // when the next session's first hook finally handed one over.
    c("holder:a-close-does-not-BIND-a-path", holder.path === undefined, holder.path);
  });

  // ── AN OVERSIZED FAILURE DETAIL STILL CLOSES, AND A SHORT ONE IS UNCHANGED ───────────────────
  //
  // The close frame is the one a reader waits on. Upstream free text (`error_details` /
  // `data.message`) can encode past the live broker ceiling while still passing a 1e6 JS code-unit
  // control-socket guard. If packUnits then refuses the unit, no terminal is durable, the WAL has
  // no pending recovery, persisted brackets stay open, and the holder dies. This block drives that
  // shape through the REAL emitter and the REAL holder, at a 1 MiB ceiling, with a multibyte
  // payload. The short-message control is the inverse: the bound must not flatten ordinary text.
  await block("AN OVERSIZED FAILURE DETAIL STILL CLOSES, AND A SHORT ONE IS UNCHANGED", async () => {
    const CEILING = 1_048_576;
    const oversized = { message: "€".repeat(400_000), code: "APIError" };
    const noticeNeedle = "omitted or shortened because it exceeded the frame bound";

    const terminalsOf = (ep: FakeEndpoint): { type?: string; message?: string; code?: string }[] =>
      ep.publishes.flatMap((call) => frameOf(call).events as { type?: string; message?: string; code?: string }[]);

    {
      const { src, walPath, wal, source } = await fresh("bound-oversize-emitter");
      const ep = new FakeEndpoint();
      ep.maxPayload = CEILING;
      const em = await AguiEmitter.start({
        endpoint: ep,
        wal,
        subjectFrontier: memorySubjectFrontier(),
        source,
        map: mapper,
      });
      await em.pump();
      append(src, { open: "run-bound-e" });
      ep.answers = [{ seq: 71, duplicate: false }];
      await em.pump();
      ep.answers = [{ seq: 72, duplicate: false }];
      const closed = await attempt(() => em.closeRun({ timestamp: 99, error: oversized }));
      const terms = terminalsOf(ep).filter((e) => e.type === "RUN_ERROR" || e.type === "RUN_FINISHED");
      const errEv = terms.find((e) => e.type === "RUN_ERROR");
      const last = ep.publishes[ep.publishes.length - 1];
      const disk = await reopen(walPath);
      c(
        "close:an-oversized-failure-detail-still-emits-exactly-one-bounded-RUN_ERROR",
        closed.err === undefined &&
          closed.value === "run-bound-e" &&
          terms.length === 1 &&
          errEv?.type === "RUN_ERROR",
        { err: closed.err?.message, returned: closed.value, terms },
      );
      c(
        "close:the-bounded-RUN_ERROR-explicitly-says-the-original-detail-was-omitted-or-shortened",
        typeof errEv?.message === "string" && errEv.message.includes(noticeNeedle),
        errEv?.message?.slice(0, 200),
      );
      c("close:the-bounded-RUN_ERROR-preserves-the-failure-code", errEv?.code === "APIError", errEv?.code);
      c(
        "close:the-bounded-RUN_ERROR-fits-the-live-payload-ceiling",
        errEv?.type === "RUN_ERROR" &&
          last !== undefined &&
          last.encodedSize <= CEILING &&
          (frameOf(last).events[0] as { type?: string }).type === "RUN_ERROR",
        { encodedSize: last?.encodedSize, ceiling: CEILING, lastType: last ? (frameOf(last).events[0] as { type?: string }).type : undefined },
      );
      c(
        "close:an-oversized-close-leaves-NO-finish-terminal",
        errEv?.type === "RUN_ERROR" && !terminalsOf(ep).some((e) => e.type === "RUN_FINISHED"),
        terminalsOf(ep).map((e) => e.type),
      );
      c(
        "close:an-oversized-close-does-NOT-stop-the-emitter",
        closed.err === undefined && em.stopped === false,
        { err: closed.err?.message, stopped: em.stopped },
      );
      c(
        "close:an-oversized-close-closes-the-persisted-brackets",
        disk.brackets?.run === undefined && disk.pending === null,
        { brackets: disk.brackets, pending: disk.pending },
      );
    }

    {
      const { src, walPath, wal, source } = await fresh("bound-oversize-holder");
      const ep = new FakeEndpoint();
      ep.maxPayload = CEILING;
      const errors: Error[] = [];
      const closedRuns: string[] = [];
      const holder = new AguiEmitterHolder<Rec>(
        async () =>
          AguiEmitter.start({
            endpoint: ep,
            wal,
            subjectFrontier: memorySubjectFrontier(),
            source,
            map: mapper,
          }),
        (e) => errors.push(e),
        (runId) => closedRuns.push(runId),
      );
      holder.flush(src);
      await holder.settled();
      append(src, { open: "run-bound-h" });
      ep.answers = [{ seq: 81, duplicate: false }, { seq: 82, duplicate: false }];
      holder.flush(src);
      await holder.settled();
      holder.closeRun(99, oversized);
      await holder.settled();
      const terms = terminalsOf(ep).filter((e) => e.type === "RUN_ERROR" || e.type === "RUN_FINISHED");
      const errEv = terms.find((e) => e.type === "RUN_ERROR");
      const last = ep.publishes[ep.publishes.length - 1];
      const disk = await reopen(walPath);
      c(
        "holder:an-oversized-failure-detail-still-emits-exactly-one-bounded-RUN_ERROR",
        errors.length === 0 &&
          holder.failure === undefined &&
          terms.length === 1 &&
          errEv?.type === "RUN_ERROR" &&
          closedRuns[0] === "run-bound-h",
        { errors: errors.map((e) => e.message), terms, closedRuns, failure: holder.failure?.message },
      );
      c(
        "holder:the-bounded-RUN_ERROR-explicitly-says-the-original-detail-was-omitted-or-shortened",
        typeof errEv?.message === "string" && errEv.message.includes(noticeNeedle),
        errEv?.message?.slice(0, 200),
      );
      c("holder:the-bounded-RUN_ERROR-preserves-the-failure-code", errEv?.code === "APIError", errEv?.code);
      c(
        "holder:the-bounded-RUN_ERROR-fits-the-live-payload-ceiling",
        errEv?.type === "RUN_ERROR" &&
          last !== undefined &&
          last.encodedSize <= CEILING &&
          (frameOf(last).events[0] as { type?: string }).type === "RUN_ERROR",
        { encodedSize: last?.encodedSize, ceiling: CEILING, lastType: last ? (frameOf(last).events[0] as { type?: string }).type : undefined },
      );
      c(
        "holder:an-oversized-close-leaves-NO-finish-terminal",
        errEv?.type === "RUN_ERROR" && !terminalsOf(ep).some((e) => e.type === "RUN_FINISHED"),
        terminalsOf(ep).map((e) => e.type),
      );
      c(
        "holder:an-oversized-close-does-NOT-die",
        holder.failure === undefined && errors.length === 0,
        { failure: holder.failure?.message, errors: errors.map((e) => e.message) },
      );
      c(
        "holder:an-oversized-close-closes-the-persisted-brackets",
        disk.brackets?.run === undefined && disk.pending === null,
        { brackets: disk.brackets, pending: disk.pending },
      );
      // A later flush on the same holder must still act — death is what used to suppress it.
      append(src, { open: "run-bound-h2" });
      ep.answers = [{ seq: 83, duplicate: false }];
      const publishesBeforeLater = ep.publishes.length;
      holder.flush(src);
      await holder.settled();
      c(
        "holder:an-oversized-close-does-NOT-suppress-later-events",
        errors.length === 0 && ep.publishes.length === publishesBeforeLater + 1,
        { errors: errors.map((e) => e.message), published: ep.publishes.length - publishesBeforeLater },
      );
    }

    {
      const { src, wal, source } = await fresh("bound-short-control");
      const ep = new FakeEndpoint();
      ep.maxPayload = CEILING;
      const em = await AguiEmitter.start({
        endpoint: ep,
        wal,
        subjectFrontier: memorySubjectFrontier(),
        source,
        map: mapper,
      });
      await em.pump();
      append(src, { open: "run-bound-s" });
      ep.answers = [{ seq: 91, duplicate: false }];
      await em.pump();
      ep.answers = [{ seq: 92, duplicate: false }];
      const short = { message: "upstream returned 500", code: "APIError" };
      const closed = await attempt(() => em.closeRun({ timestamp: 99, error: short }));
      const last = ep.publishes[ep.publishes.length - 1];
      const ev = last ? (frameOf(last).events[0] as { type?: string; message?: string; code?: string }) : undefined;
      c(
        "close:CONTROL-a-short-failure-detail-is-byte-for-byte-unchanged",
        closed.err === undefined &&
          ev?.type === "RUN_ERROR" &&
          ev.message === "upstream returned 500" &&
          ev.code === "APIError" &&
          (last?.encodedSize ?? Infinity) <= CEILING,
        { err: closed.err?.message, ev, encodedSize: last?.encodedSize },
      );
      c(
        "close:CONTROL-a-short-failure-detail-does-NOT-carry-the-bound-notice",
        typeof ev?.message === "string" && !ev.message.includes(noticeNeedle),
        ev?.message,
      );
    }
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`agui-close-run smoke: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
