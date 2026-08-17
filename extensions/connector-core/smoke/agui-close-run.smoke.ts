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
 *   K1  advance the source cursor to the read end instead of republishing it unchanged
 *       -> `close:the-source-cursor-is-REPUBLISHED-UNCHANGED`
 *   K2  mint a run id when none is open, instead of answering null
 *       -> `close:a-stream-at-a-stopping-point-answers-null-and-publishes-NOTHING`
 *   K3  publish without validating on the clone first
 *       -> `close:a-message-still-open-under-the-run-REFUSES-and-publishes-NOTHING`
 *   K4  let the holder start an emitter on the way out of a turn
 *       -> `holder:a-close-on-a-holder-that-never-adopted-starts-NOTHING`
 *   K5  drop the `onRunClosed` report
 *       -> `holder:the-closed-run-is-reported-so-a-mapper-can-forget-it`
 *   K6  drop the halted guard
 *       -> `close:a-HALTED-emitter-refuses-to-close`
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
    this.publishes.push({ id: o.id, expectedLastSubjectSeq: o.expectedLastSubjectSeq, parts: o.parts });
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
    const em = await AguiEmitter.start({ endpoint: ep, wal, source, map: mapper });
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

    // And a record that arrives AFTER the out-of-band close must not throw. The mapper here still
    // believes nothing changed, so this is the raw hazard: it maps a fresh run and the stream takes
    // it, because a closed run leaves the machine at a legal stopping point.
    append(src, { open: "run-b" });
    ep.answers = [{ seq: 13, duplicate: false }];
    const late = await attempt(() => em.pump());
    c("close:a-LATER-record-after-a-close-does-not-throw", late.err === undefined && late.value?.frames === 1, {
      err: late.err?.message,
      pumped: late.value,
    });
  });

  // ── A CLOSE THAT WOULD BE A PROTOCOL VIOLATION IS REFUSED, NOT PUBLISHED ─────────────────────
  await block("A CLOSE THAT WOULD BE A PROTOCOL VIOLATION IS REFUSED, NOT PUBLISHED", async () => {
    const { src, wal, source } = await fresh("dangling");
    const ep = new FakeEndpoint();
    const em = await AguiEmitter.start({ endpoint: ep, wal, source, map: mapper });
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
    const em = await AguiEmitter.start({ endpoint: ep, wal, source, map: mapper });
    await em.pump(); // adopt
    append(src, { open: "run-a" });
    ep.answers = [{ seq: 31, duplicate: false }];
    await em.pump();

    // A NEW process: a fresh WAL object over the same file and a fresh emitter.
    const wal2 = await reopen(walPath);
    const ep2 = new FakeEndpoint();
    const em2 = await AguiEmitter.start({ endpoint: ep2, wal: wal2, source: new JsonlFileSource<Rec>(src), map: mapper });
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
    const em = await AguiEmitter.start({ endpoint: ep, wal, source, map: mapper });
    await em.pump(); // adopt
    append(src, { open: "run-a" });
    ep.answers = [{ seq: 41, duplicate: true }]; // a body we never wrote holds our id
    const pumped = await attempt(() => em.pump());
    c("close:CONTROL-the-duplicate-ack-really-halted-the-emitter", pumped.err instanceof AguiEmitterHalted && em.stopped, {
      err: pumped.err?.message,
      stopped: em.stopped,
    });
    const publishesBefore = ep.publishes.length;
    const closed = await attempt(() => em.closeRun({ timestamp: 99 }));
    c(
      "close:a-HALTED-emitter-refuses-to-close",
      closed.err instanceof AguiEmitterHalted && ep.publishes.length === publishesBefore,
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
      async () => AguiEmitter.start({ endpoint: ep, wal, source, map: mapper }),
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

  await block("THE HOLDER STARTS NOTHING ON THE WAY OUT OF A TURN", async () => {
    const { src, wal, source } = await fresh("holder-never-adopted");
    const ep = new FakeEndpoint();
    let started = 0;
    const holder = new AguiEmitterHolder<Rec>(
      async () => {
        started += 1;
        return AguiEmitter.start({ endpoint: ep, wal, source, map: mapper });
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
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`agui-close-run smoke: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
