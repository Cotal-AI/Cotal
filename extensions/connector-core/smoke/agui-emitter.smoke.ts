/**
 * The event emitter: the replica preflight's production call site, the one-unit-one-frame packing
 * rule, and the halts that are supposed to be halts.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT, stated up front because it decides what these cells prove.
 * The `EventWal` is real and on a real filesystem. The `JsonlFileSource` is real and reads real
 * appended bytes. ONLY the broker is substituted, and it is substituted by an instrument that
 * RECORDS every call rather than one that pretends to succeed — because most of what this suite
 * asserts is about calls that must NOT happen, and a mock that only knows how to return a value
 * cannot testify to an absence.
 *
 * THE ORDERING CELLS ARE THE POINT OF THE FILE. `assertExpectationSemantics()` shipped with ZERO
 * production callers: a check that existed, had its own suite, and never ran anywhere real. Moving
 * it into `AguiEmitter.start()` is only worth something if it runs BEFORE anything can publish, and
 * the publish that matters most is the one recovery makes — a `sent_unacked` frame re-published with
 * a frozen id. A preflight placed after recovery would leave exactly that publish outside the guard
 * while looking, in a diff, identical.
 *
 * THE HALT CELLS RE-READ THE WAL FROM DISK. Asserting on the in-memory frontier of the object that
 * just halted proves the object did not mutate a field; the claim is that NOTHING WAS PERSISTED, and
 * only a fresh `EventWal.open()` of the same path can say that.
 *
 * KILL SET, predicted as NAMES before the run:
 *   E1  run the preflight AFTER recovery instead of before
 *       -> `preflight:runs-before-RECOVERY-republishes-a-frozen-frame` ONLY. Every other cell stays
 *          green, including the ordinary preflight cell, because on a WAL with no pending frame the
 *          two orderings are indistinguishable. That is the whole danger.
 *   E2  treat a duplicate ack as success (fold it) instead of halting
 *       -> `halt:duplicate-on-a-FIRST-attempt-does-not-move-the-frontier-ON-DISK`
 *   E3  publish frames splitting at EVENT boundaries, so an oversized unit is truncated rather than
 *       refused -> `pack:one-observation-one-frame-a-single-oversized-unit-FAILS-LOUD`
 *   E4  let one frame carry two runs -> `pack:a-run-change-flushes-even-when-the-frame-has-room`
 *   E5  drop the cursor-only advance on an empty map -> `cursor-only:an-adopt-persists-its-cursor`
 *   E6  size with a SHORT id instead of the longest admissible one
 *       -> `sizing:the-UPPER-BOUND-keeps-a-packed-frame-under-the-REAL-ceiling`. Added because the
 *          two earlier sizing cells assert a property of `encodedSize` and NOT of the emitter, so
 *          they would have stayed green with `SIZING_ID` set to anything at all.
 *
 * ALL SIX KILLED, each on the cell it was predicted against, with the run's outcome recorded rather
 * than the prediction restated. E5 first came back KILLED-but-with-ZERO-MARKS — the right verdict
 * from a suite that had died rather than failed, which is the worse version of that defect because
 * a correct verdict invites no second look. Fixed by running each fixture block inside a guard.
 *
 * SECOND KILL SET (the [D1] interim: a bracket refusal must say WHOSE fault it is), predicted as
 * NAMES before its run. The two conditions are tested by their INVERSES, because each one alone
 * produces a CONFIDENT WRONG diagnosis — worse than the anonymous error it replaced, since a named
 * cause stops the search:
 *   B1  drop the "this process has fed nothing yet" condition
 *       -> `bracket:CONTROL-a-violation-after-this-process-FED-but-never-FOLDED-is-NOT-blamed-on-lost-state`
 *   B2  drop the "the frontier is non-virgin" condition
 *       -> `bracket:CONTROL-a-violation-on-a-MIGRATED-VIRGIN-frontier-is-NOT-blamed-on-lost-state`
 *   B3  never diagnose; surface the raw refusal
 *       -> `bracket:a-mid-run-restart-names-ITSELF-not-the-writer`
 *   B4  drop the "the WAL cannot say what was open" condition (added with WAL v2)
 *       -> `bracket:CONTROL-a-violation-after-a-RESTORED-restart-is-NOT-blamed-on-lost-state`
 *   V1  migrate a v1 document to an EMPTY bracket state instead of UNKNOWN
 *       -> `bracket:a-mid-run-restart-names-ITSELF-not-the-writer`
 *   V2  do not restore the persisted machine at startup
 *       -> `bracket:a-mid-run-restart-CONTINUES-because-the-state-was-persisted`
 *   V3  fold does not promote the frame's frozen bracket state
 *       -> `bracket:the-open-run-is-PERSISTED-in-the-WAL`
 * B1 and B2 are the pair worth reading together: each one leaves the headline cell GREEN and kills
 * only its own control, which is what a confident wrong diagnosis looks like from the inside.
 *
 * AND B1/B2 NAME DIFFERENT CELLS ABOVE THAN THEY DID ONE COMMIT AGO, BECAUSE WAL v2 SILENTLY
 * INVALIDATED THEIR OLD ONES. Both were KILLED before v2 and both SURVIVED after it, on an
 * unchanged predicate and unchanged controls. Adding the third condition (`the WAL cannot say what
 * was open`) meant every case those controls exercised was already answered by it — each used a v2
 * WAL, whose bracket state is non-null — so conditions 1 and 2 could be deleted with nothing
 * noticing. That is this fleet's own rule arriving from the other side: DEFENCE IN DEPTH DEFEATS
 * OUTCOME-BASED TESTING, and a control written against a two-term predicate does not survive a
 * third term for free.
 *
 * The diagnosis was NOT "equivalent mutant" and NOT "weak assertion" — those need opposite repairs
 * and the wrong one here would have deleted a live condition. Both conditions are REACHABLE with
 * `brackets === null` held constant, and neither was covered:
 *   - condition 1 is reached when a batch VALIDATES (setting `fedAnyEvent`) and then fails to PACK,
 *     so nothing folds and the WAL still records no bracket state;
 *   - condition 2 is reached by a MIGRATED v1 document that is also VIRGIN — nothing was ever
 *     published, so nothing could have been lost.
 * The two cells below hold `brackets === null` and vary one condition each. The pre-v2 controls are
 * kept: they no longer discriminate, but they still assert real behaviour, and deleting a cell
 * because a mutation stopped reaching it is how coverage is lost quietly.
 *
 * ALL SEVEN KILLED on their named cells, each with 1 mark against a baseline of 1 — so each verdict
 * came from a suite that RAN and failed, not one that died. Instrument: `pnpm mutation-proof
 * --config ../mut-agui-v2.json`, tree clean before and after.
 *
 * ONE THING NO CELL HERE CAN DISCRIMINATE, said plainly rather than left as an unproven constant:
 * `SIZING_EXPECTATION`. Measuring at `MAX_SAFE_INTEGER` is a provable upper bound, but the real
 * expectation is a stream sequence, and reaching a 16-digit one takes ~10^15 messages. A mutation
 * lowering it therefore survives on any reachable fixture. It is an equivalent mutant AT THIS SCALE,
 * not a coverage gap, and the distinction matters because the two need opposite repairs.
 *
 * Run: pnpm smoke:agui-emitter
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Part } from "@cotal-ai/core";
import {
  aguiFrame,
  AguiEmitter,
  AguiBracketStateLost,
  AguiEmitterHalted,
  AguiVocabularyError,
  packUnits,
  runFinished,
  runStarted,
  textMessageContent,
  textMessageEnd,
  textMessageStart,
  type AguiEvent,
  type AguiFrame,
  type EmitUnit,
} from "../src/agui.js";
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

/** Run and report the refusal AS A VALUE. A cell that lets the subject throw into its own assertion
 *  stops reporting the moment the subject throws, and a cell that stops reporting is
 *  indistinguishable from one that never ran — found by a mutation on a sibling suite, fixed at the
 *  class here rather than after the same mutation finds it again. */
const attempt = async <T>(fn: () => Promise<T>): Promise<{ value?: T; err?: Error }> => {
  try {
    return { value: await fn() };
  } catch (e) {
    return { err: e as Error };
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

/**
 * The broker instrument. It records; it does not pretend.
 *
 * `maxPayload` and `encodedSize` are deliberately a HONEST encoding of what the real endpoint does
 * — JSON bytes plus a fixed header allowance — rather than a constant. A packer measured against a
 * constant is not a packer.
 */
class FakeEndpoint {
  readonly principal = PRINCIPAL;
  readonly actorIsEphemeral = false;
  maxPayload = 4096;
  preflightError: Error | undefined;
  preflightCalls = 0;
  publishes: Call[] = [];
  /** Answers, consumed in order. A missing answer is a loud failure, never a default success. */
  answers: ({ seq: number; duplicate: boolean } | Error)[] = [];

  async assertExpectationSemantics(): Promise<void> {
    this.preflightCalls += 1;
    if (this.preflightError) throw this.preflightError;
  }

  encodedSize(o: { channel: string; parts: Part[]; id: string; expectedLastSubjectSeq: number }): number {
    return (
      Buffer.byteLength(JSON.stringify({ channel: o.channel, parts: o.parts, id: o.id, e: o.expectedLastSubjectSeq }), "utf8") +
      64 // a fixed stand-in for the encoded headers the real client adds
    );
  }

  async multicastExpecting(o: {
    channel: string;
    parts: Part[];
    id: string;
    expectedLastSubjectSeq: number;
  }): Promise<{ ack: { seq: number; duplicate: boolean } }> {
    this.publishes.push({ id: o.id, expectedLastSubjectSeq: o.expectedLastSubjectSeq, parts: o.parts });
    // THE INSTRUMENT ENFORCES THE CEILING, because the broker does. A fake that accepts any size
    // cannot witness an over-packed frame, and "the packer produced N frames" is not the property —
    // "every frame it produced could actually be sent" is.
    const size = this.encodedSize(o);
    if (size > this.maxPayload)
      throw new Error(`FakeEndpoint: payload ${size} exceeds max_payload ${this.maxPayload}`);
    const a = this.answers.shift();
    if (a === undefined) throw new Error("FakeEndpoint: publish with no scripted answer");
    if (a instanceof Error) throw a;
    return { ack: a };
  }
}

/** A neutral bracket snapshot for fixtures whose subject is NOT the bracket machine. Named so a
 *  reader can see at a glance which cells are about brackets and which merely need the field. */
const BR = { run: undefined, text: [], reasoning: [], tools: [] };

const casLoss = (): Error => Object.assign(new Error("wrong last sequence"), { code: 10071 });

/** One turn's worth of legal, bracketed events. */
const turn = (runId: string, messageId: string, text: string): AguiEvent[] => [
  runStarted({ threadId: THREAD, runId, timestamp: 1 }),
  textMessageStart({ messageId, timestamp: 2, role: "assistant" }),
  textMessageContent({ messageId, delta: text, timestamp: 3 }),
  textMessageEnd({ messageId, timestamp: 4 }),
  runFinished({ threadId: THREAD, runId, timestamp: 5 }),
];

type Rec = { run: string; msg: string; text: string } | { skip: true };

const mapper = (r: Rec) => ("skip" in r ? null : { runId: r.run, events: turn(r.run, r.msg, r.text) });

/**
 * Run one fixture block, converting an UNEXPECTED CRASH into a named cell failure.
 *
 * A cell that reports is worth something; a suite that dies is worth nothing. When a mutation makes
 * a read return no records, the very next line indexes into an empty array and the whole run ends
 * with no summary and no progress marks — the harness then sees a red it cannot attribute, which is
 * the same shape as a chain reporting zero graded lines. Guarding the CALL is not enough; a crash
 * anywhere in a block must not silence the other blocks' cells.
 */
const block = async (name: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (e) {
    c(`${name} (block crashed)`, false, String(e));
  }
};

const dir = mkdtempSync(join(tmpdir(), "agui-emitter-"));

const fresh = async (name: string, opts?: { subjectMayExist?: boolean }) => {
  const d = join(dir, name);
  const src = join(d, "session.jsonl");
  const walPath = join(d, "wal.json");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(d, { recursive: true });
  writeFileSync(src, "");
  const wal = await EventWal.open(walPath, {
    space: SPACE,
    threadId: THREAD,
    principal: PRINCIPAL_KEY,
    subjectMayExist: opts?.subjectMayExist ?? false,
  });
  return { d, src, walPath, wal, source: new JsonlFileSource<Rec>(src) };
};

const append = (path: string, ...recs: Rec[]) => {
  appendFileSync(path, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
};

try {
  // ── THE PREFLIGHT RUNS, AND IT RUNS BEFORE ANYTHING PUBLISHES ────────────────────────────────
  await block("THE PREFLIGHT RUNS, AND IT RUNS BEFORE ANYTHING PUBLISHES", async () => {
    const { wal, source } = await fresh("preflight-ok");
    const ep = new FakeEndpoint();
    const started = await attempt(() => AguiEmitter.start({ endpoint: ep, wal, source, map: mapper }));
    c("preflight:start-calls-it-exactly-once", ep.preflightCalls === 1 && !started.err, {
      calls: ep.preflightCalls,
      err: started.err?.message,
    });
    c("preflight:CONTROL-a-passing-preflight-does-not-block-the-emitter", started.value !== undefined, started.err?.message);
  });
  await block("THE PREFLIGHT RUNS, AND IT RUNS BEFORE ANYTHING PUBLISHES", async () => {
    const { wal, source } = await fresh("preflight-fails");
    const ep = new FakeEndpoint();
    ep.preflightError = new Error('stream "CHAT_main" reports num_replicas=3; serialized appends require 1.');
    const started = await attempt(() => AguiEmitter.start({ endpoint: ep, wal, source, map: mapper }));
    c(
      "preflight:a-refusing-preflight-refuses-the-EMITTER",
      started.err !== undefined && /num_replicas=3/.test(started.err.message),
      started.err?.message ?? "no throw",
    );
    // The refusal must assert WHICH refusal, and the emitter must not exist afterwards.
    c("preflight:nothing-was-published", ep.publishes.length === 0, ep.publishes);
  });

  // ── THE ORDERING CELL: RECOVERY'S RE-PUBLISH IS INSIDE THE GUARD, NOT AFTER IT ────────────────
  //
  // A WAL holding a `sent_unacked` frame is the one state where the preflight's placement is
  // OBSERVABLE. With no pending frame, before-recovery and after-recovery are the same program.
  await block("THE ORDERING CELL: RECOVERY'S RE-PUBLISH IS INSIDE THE GUARD, NOT AFTE", async () => {
    const { wal, source } = await fresh("preflight-before-recovery");
    await wal.beginSend({
      id: "frozen-id-1",
      E: 0,
      seq: 1,
      sourceCursor: "1:2:0:0000000000000000",
      body: [{ kind: "ag-ui.frame", protocol: "ag-ui/0.0.57" } as unknown as Part],
      brackets: BR,
    });
    const ep = new FakeEndpoint();
    ep.preflightError = new Error("cannot verify expectation semantics: stream info unavailable");
    ep.answers = [{ seq: 9, duplicate: false }];
    const started = await attempt(() => AguiEmitter.start({ endpoint: ep, wal, source, map: mapper }));
    c(
      "preflight:runs-before-RECOVERY-republishes-a-frozen-frame",
      started.err !== undefined && ep.publishes.length === 0,
      { err: started.err?.message, publishes: ep.publishes.length },
    );
    // …and the frame is STILL pending on disk: a refused startup must not consume the thing it
    // refused to handle.
    const reread = await EventWal.open(join(dir, "preflight-before-recovery", "wal.json"), {
      space: SPACE,
      threadId: THREAD,
      principal: PRINCIPAL_KEY,
      subjectMayExist: true,
    });
    c(
      "preflight:the-pending-frame-survives-a-refused-startup",
      reread.pending?.state === "sent_unacked" && reread.pending.id === "frozen-id-1",
      reread.pending,
    );
  });

  // ── THE WAL MUST BE THIS PRINCIPAL'S ──────────────────────────────────────────────────────────
  await block("THE WAL MUST BE THIS PRINCIPAL'S", async () => {
    const { source } = await fresh("wrong-principal");
    const other = await EventWal.open(join(dir, "wrong-principal", "other.json"), {
      space: SPACE,
      threadId: THREAD,
      principal: "local.bbb",
      subjectMayExist: false,
    });
    const ep = new FakeEndpoint();
    const started = await attempt(() => AguiEmitter.start({ endpoint: ep, wal: other, source, map: mapper }));
    c(
      "identity:a-WAL-belonging-to-another-principal-is-refused",
      started.err !== undefined && /local\.bbb/.test(started.err.message) && /local\.aaa/.test(started.err.message),
      started.err?.message ?? "no throw",
    );
  });

  // ── THE ORDINARY PATH: read, map, publish, fold ────────────────────────────────────────────────
  await block("THE ORDINARY PATH: read, map, publish, fold", async () => {
    const { wal, source, src, walPath } = await fresh("happy");
    const ep = new FakeEndpoint();
    const em = (await attempt(() => AguiEmitter.start({ endpoint: ep, wal, source, map: mapper }))).value!;

    // A fresh adopt reads nothing — and MUST still persist where it adopted, or the next read
    // adopts a LATER end and silently skips everything appended in between.
    const adopt = await attempt(() => em.pump());
    const afterAdopt = wal.frontier.sourceCursor;
    c("cursor-only:an-adopt-persists-its-cursor", adopt.value?.frames === 0 && typeof afterAdopt === "string", {
      pumped: adopt.value,
      cursor: afterAdopt,
    });

    append(src, { run: "r1", msg: "m1", text: "hello" });
    ep.answers = [{ seq: 11, duplicate: false }];
    const p1 = await attempt(() => em.pump());
    c("emit:one-record-becomes-one-frame", p1.value?.frames === 1 && p1.value.events === 5, { p: p1.value, err: p1.err?.message });
    c("emit:the-frame-is-the-only-part-and-carries-the-vocabulary", (() => {
      const parts = ep.publishes[0]?.parts;
      const f = parts?.[0] as unknown as AguiFrame | undefined;
      return parts?.length === 1 && f?.kind === "ag-ui.frame" && f.seq === 1 && f.runId === "r1" && f.events.length === 5;
    })(), ep.publishes[0]?.parts);
    c("emit:the-first-publish-expects-a-VIRGIN-subject", ep.publishes[0]?.expectedLastSubjectSeq === 0, ep.publishes[0]);

    // Transition 3 happened: the ack's seq is the new tip and the cursor moved off the adopt point.
    const disk = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: true });
    c(
      "emit:the-ack-is-folded-ON-DISK-and-pending-is-cleared",
      disk.pending === null && disk.frontier.seq === 1 && disk.frontier.lastSubjectSeq === 11 && disk.frontier.sourceCursor !== afterAdopt,
      disk.frontier,
    );

    // The NEXT publish expects the sequence the broker assigned, never a re-read tip.
    append(src, { run: "r2", msg: "m2", text: "again" });
    ep.answers = [{ seq: 12, duplicate: false }];
    await attempt(() => em.pump());
    c("emit:the-next-publish-expects-the-ACK'd-sequence", ep.publishes[1]?.expectedLastSubjectSeq === 11, ep.publishes[1]);
    c("emit:seq-advances-by-one-per-frame", (ep.publishes[1]?.parts[0] as unknown as AguiFrame | undefined)?.seq === 2, ep.publishes[1]?.parts[0]);
  });

  // ── THE CURSOR-ONLY RULE: A RECORD THAT MAPS TO NOTHING ADVANCES THE CURSOR AND NOTHING ELSE ────────────────
  await block("THE CURSOR-ONLY RULE: A RECORD THAT MAPS TO NOTHING ADVANCES THE CURSOR", async () => {
    const { wal, source, src, walPath } = await fresh("p7");
    const ep = new FakeEndpoint();
    const em = (await attempt(() => AguiEmitter.start({ endpoint: ep, wal, source, map: mapper }))).value!;
    await em.pump(); // adopt
    const before = wal.frontier;
    append(src, { skip: true }, { skip: true });
    const p = await attempt(() => em.pump());
    const disk = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: true });
    c(
      "cursor-only:a-dropped-range-advances-the-cursor-alone",
      p.value?.frames === 0 &&
        ep.publishes.length === 0 &&
        disk.frontier.seq === before.seq &&
        disk.frontier.lastSubjectSeq === before.lastSubjectSeq &&
        disk.frontier.sourceCursor !== before.sourceCursor,
      { pumped: p.value, before, after: disk.frontier },
    );
  });

  // ── HALT: A DUPLICATE ACK ON A FIRST ATTEMPT ─────────────────────────────────────────────────
  //
  // We have never published this id, so a body WE DID NOT WRITE holds it. Folding its `ackSeq`
  // would advance the frontier and the source cursor past events that were never published.
  await block("HALT: A DUPLICATE ACK ON A FIRST ATTEMPT", async () => {
    const { wal, source, src, walPath } = await fresh("dup-first");
    const ep = new FakeEndpoint();
    const em = (await attempt(() => AguiEmitter.start({ endpoint: ep, wal, source, map: mapper }))).value!;
    await em.pump();
    const before = wal.frontier;
    append(src, { run: "r1", msg: "m1", text: "hello" });
    ep.answers = [{ seq: 77, duplicate: true }];
    const p = await attempt(() => em.pump());
    c(
      "halt:a-duplicate-on-a-FIRST-attempt-halts-and-says-WHY",
      p.err instanceof AguiEmitterHalted &&
        p.err.reason === "duplicate-ack" &&
        /FIRST attempt/.test(p.err.message) &&
        /never published this id/.test(p.err.message),
      p.err?.message ?? "no throw",
    );
    // RE-READ FROM DISK. The claim is that nothing was persisted, and the in-memory object cannot
    // testify to that.
    const disk = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: true });
    c(
      "halt:duplicate-on-a-FIRST-attempt-does-not-move-the-frontier-ON-DISK",
      disk.frontier.seq === before.seq &&
        disk.frontier.lastSubjectSeq === before.lastSubjectSeq &&
        disk.frontier.sourceCursor === before.sourceCursor,
      { before, onDisk: disk.frontier },
    );
    c("halt:the-frame-stays-pending-and-unacked", disk.pending?.state === "sent_unacked", disk.pending);
    c("halt:the-emitter-refuses-to-pump-again", (await attempt(() => em.pump())).err instanceof AguiEmitterHalted, "");
    c("halt:it-reports-itself-stopped", em.stopped === true, em.stopped);
  });

  // ── HALT: A DUPLICATE ACK ON A RETRY — THE SINGLE-REPLICA RETRY RULE VIOLATED, AND THE MESSAGE MUST SAY SO ──────────
  //
  // The CONTROL that makes this cell mean something is the FIRST-attempt cell above: two halts that
  // both say "duplicate" prove nothing about which path produced them. These assert the DIFFERENT
  // diagnosis each one is supposed to carry.
  await block("HALT: A DUPLICATE ACK ON A RETRY — THE SINGLE-REPLICA RETRY RULE VIOLATED", async () => {
    const { source, walPath } = await fresh("dup-retry");
    const wal = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: false });
    await wal.beginSend({
      id: "frozen-retry",
      E: 0,
      seq: 1,
      sourceCursor: "1:2:0:0000000000000000",
      body: [{ kind: "ag-ui.frame", protocol: "ag-ui/0.0.57" } as unknown as Part],
      brackets: BR,
    });
    const ep = new FakeEndpoint();
    ep.answers = [{ seq: 88, duplicate: true }];
    const started = await attempt(() => AguiEmitter.start({ endpoint: ep, wal, source, map: mapper }));
    c(
      "halt:a-duplicate-on-a-RETRY-names-the-SINGLE-REPLICA-RETRY-RULE-rather-than-a-foreign-first-publish",
      started.err instanceof AguiEmitterHalted &&
        started.err.reason === "duplicate-ack" &&
        /RETRY/.test(started.err.message) &&
        /SINGLE-REPLICA RETRY RULE/.test(started.err.message) &&
        !/never published this id/.test(started.err.message),
      started.err?.message ?? "no throw",
    );
    c("halt:the-retry-published-the-FROZEN-id-and-E", ep.publishes[0]?.id === "frozen-retry" && ep.publishes[0].expectedLastSubjectSeq === 0, ep.publishes[0]);
    const disk = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: true });
    c("halt:the-retry-halt-leaves-the-frontier-at-zero-ON-DISK", disk.frontier.seq === 0 && disk.frontier.lastSubjectSeq === 0, disk.frontier);
  });

  // ── CONTROL: THE SAME RECOVERY PATH SUCCEEDS ON A NON-DUPLICATE ACK ──────────────────────────
  //    A halt that fires because the guard is correct and one that fires because the path is broken
  //    look identical from the halting side. This is the inverse of the predicate under test.
  await block("CONTROL: THE SAME RECOVERY PATH SUCCEEDS ON A NON-DUPLICATE ACK", async () => {
    const { source, walPath } = await fresh("retry-ok");
    const wal = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: false });
    await wal.beginSend({
      id: "frozen-ok",
      E: 0,
      seq: 1,
      sourceCursor: "1:2:0:0000000000000000",
      body: [{ kind: "ag-ui.frame", protocol: "ag-ui/0.0.57" } as unknown as Part],
      brackets: BR,
    });
    const ep = new FakeEndpoint();
    ep.answers = [{ seq: 5, duplicate: false }];
    const started = await attempt(() => AguiEmitter.start({ endpoint: ep, wal, source, map: mapper }));
    const disk = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: true });
    c(
      "halt:CONTROL-recovery-with-a-NON-duplicate-ack-folds-and-continues",
      started.err === undefined && disk.pending === null && disk.frontier.seq === 1 && disk.frontier.lastSubjectSeq === 5,
      { err: started.err?.message, frontier: disk.frontier },
    );
  });

  // ── HALT: A CAS LOSS ──────────────────────────────────────────────────────────────────────────
  await block("HALT: A CAS LOSS", async () => {
    const { wal, source, src, walPath } = await fresh("cas");
    const ep = new FakeEndpoint();
    const em = (await attempt(() => AguiEmitter.start({ endpoint: ep, wal, source, map: mapper }))).value!;
    await em.pump();
    const before = wal.frontier;
    append(src, { run: "r1", msg: "m1", text: "hello" });
    ep.answers = [casLoss()];
    const p = await attempt(() => em.pump());
    const disk = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: true });
    c(
      "halt:a-CAS-loss-halts-with-its-OWN-reason-and-leaves-the-frontier-ON-DISK",
      p.err instanceof AguiEmitterHalted &&
        p.err.reason === "cas-loss" &&
        disk.frontier.lastSubjectSeq === before.lastSubjectSeq &&
        disk.frontier.sourceCursor === before.sourceCursor,
      { err: p.err?.message, before, onDisk: disk.frontier },
    );
  });

  // ── A NETWORK ERROR IS NOT A HALT: "we do not know" is a state, and it is `sent_unacked` ──────
  await block("A NETWORK ERROR IS NOT A HALT: 'we do not know' is a state, and it is ", async () => {
    const { wal, source, src, walPath } = await fresh("netfail");
    const ep = new FakeEndpoint();
    const em = (await attempt(() => AguiEmitter.start({ endpoint: ep, wal, source, map: mapper }))).value!;
    await em.pump();
    append(src, { run: "r1", msg: "m1", text: "hello" });
    ep.answers = [new Error("connection reset")];
    const p = await attempt(() => em.pump());
    const disk = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: true });
    c(
      "net:a-transport-error-is-NOT-a-halt-and-leaves-the-frame-retriable",
      p.err !== undefined && !(p.err instanceof AguiEmitterHalted) && em.stopped === false && disk.pending?.state === "sent_unacked",
      { err: p.err?.message, stopped: em.stopped, pending: disk.pending?.state },
    );
  });

  // ── PACKING: ONE OBSERVATION IS ONE FRAME ─────────────────────────────────────────────────────────────────────────
  await block("PACKING: ONE OBSERVATION IS ONE FRAME", async () => {
    const measureOf = (ep: FakeEndpoint) => (f: AguiFrame) =>
      ep.encodedSize({ channel: "events.local.aaa", parts: [f as unknown as Part], id: "S".repeat(64), expectedLastSubjectSeq: Number.MAX_SAFE_INTEGER });
    const ep = new FakeEndpoint();
    const u = (runId: string, n: number, cursor: string): EmitUnit => ({ runId, events: turn(runId, `m${n}`, `t${n}`), cursor });

    const roomy = packUnits({
      threadId: THREAD,
      epoch: "e",
      firstSeq: 1,
      units: [u("r1", 1, "c1"), u("r1", 2, "c2")],
      measure: measureOf(ep),
      limit: 100_000,
    });
    c("pack:two-units-of-one-run-share-a-frame-when-they-fit", roomy.length === 1 && roomy[0]?.frame.events.length === 10, roomy.map((r) => r.frame.events.length));
    // The frame carries the LAST included unit's cursor — folding it means every record in it is
    // consumed, which is the whole reason the cursor is per-record.
    c("pack:a-frame-carries-its-LAST-unit's-cursor", roomy[0]?.cursor === "c2", roomy[0]?.cursor);

    // A run change flushes even with room to spare: a frame's envelope names ONE run, so this
    // is not a size decision and a size-only packer would silently mislabel the second run's events.
    const tworuns = packUnits({
      threadId: THREAD,
      epoch: "e",
      firstSeq: 1,
      units: [u("r1", 1, "c1"), u("r2", 2, "c2")],
      measure: measureOf(ep),
      limit: 100_000,
    });
    c(
      "pack:a-run-change-flushes-even-when-the-frame-has-room",
      tworuns.length === 2 && tworuns[0]?.frame.runId === "r1" && tworuns[1]?.frame.runId === "r2" && tworuns[1]?.frame.seq === 2,
      tworuns.map((r) => ({ run: r.frame.runId, seq: r.frame.seq })),
    );

    // THE UNLUCKY NEIGHBOUR: a unit that does not fit BEHIND another is not an oversized unit. The
    // ceiling is derived from the instrument — measuring one unit alone — rather than hand-picked,
    // because a hand-picked number is a second implementation of the sizing rule.
    const alone = measureOf(ep)({ kind: "ag-ui.frame", protocol: "ag-ui/0.0.57", threadId: THREAD, runId: "r1", epoch: "e", seq: 1, events: turn("r1", "m1", "t1") } as AguiFrame);
    const tight = packUnits({
      threadId: THREAD,
      epoch: "e",
      firstSeq: 1,
      units: [u("r1", 1, "c1"), u("r1", 2, "c2")],
      measure: measureOf(ep),
      limit: alone + 8,
    });
    c(
      "pack:a-unit-that-cannot-join-a-full-frame-gets-its-own-frame",
      tight.length === 2 && tight[0]?.frame.seq === 1 && tight[1]?.frame.seq === 2 && tight[0]?.cursor === "c1" && tight[1]?.cursor === "c2",
      tight.map((r) => ({ seq: r.frame.seq, cursor: r.cursor, n: r.frame.events.length })),
    );

    // A single unit that cannot fit ALONE fails loud. It is never truncated at a frame
    // boundary, because a frame ending mid-record has no cursor it can honestly store.
    let oversized: Error | undefined;
    try {
      packUnits({ threadId: THREAD, epoch: "e", firstSeq: 1, units: [u("r1", 1, "c1")], measure: measureOf(ep), limit: alone - 1 });
    } catch (e) {
      oversized = e as Error;
    }
    c(
      "pack:one-observation-one-frame-a-single-oversized-unit-FAILS-LOUD",
      oversized instanceof AguiVocabularyError && /does not fit in one frame/.test(oversized.message) && /One source observation is one frame/.test(oversized.message),
      oversized?.message ?? "no throw",
    );
    // CONTROL: one byte more and the SAME unit packs. Without this, the cell above passes for a
    // packer that refuses everything.
    const justFits = packUnits({ threadId: THREAD, epoch: "e", firstSeq: 1, units: [u("r1", 1, "c1")], measure: measureOf(ep), limit: alone });
    c("pack:CONTROL-the-same-unit-fits-at-exactly-its-measured-size", justFits.length === 1, justFits.length);
  });

  // ── A BRACKET REFUSAL MUST SAY WHOSE FAULT IT IS ─────────────────────────────────────────────
  //
  // The WAL persists epoch, frontier and the pending frame — NOT the open runs and messages. So a
  // process that dies mid-run restarts with an empty bracket machine, resumes at events whose
  // `RUN_STARTED` already published, and refuses the first one. That is OUR gap, not the writer's
  // bug, and two halts that both say "unbalanced" prove nothing about which produced one.
  //
  // The two CONTROLS are the inverses of the two conditions, not merely different inputs. Each
  // condition alone yields a confident WRONG diagnosis, which is worse than the anonymous error it
  // replaced, because a named cause stops the search.
  await block("A BRACKET REFUSAL MUST SAY WHOSE FAULT IT IS", async () => {
    // Mid-run content with no START — what a resume after a crash actually looks like.
    // Opens a run and never closes it — so the frame that goes out leaves the machine mid-run.
    const openRunOnly = (r: Rec) =>
      "skip" in r
        ? null
        : {
            runId: r.run,
            events: [
              runStarted({ threadId: THREAD, runId: r.run, timestamp: 1 }),
              textMessageStart({ messageId: r.msg, timestamp: 2, role: "assistant" as const }),
            ],
          };
    // Closes what `openRunOnly` opened. Legal ONLY if the machine remembers the open run — which is
    // exactly the property under test.
    const closeRunOnly = (r: Rec) =>
      "skip" in r
        ? null
        : {
            runId: r.run,
            events: [
              textMessageEnd({ messageId: r.msg, timestamp: 3 }),
              runFinished({ threadId: THREAD, runId: r.run, timestamp: 4 }),
            ],
          };
    const orphan = (r: Rec) =>
      "skip" in r
        ? null
        : { runId: r.run, events: [textMessageContent({ messageId: r.msg, delta: r.text, timestamp: 1 })] };

    // (1) THE HEADLINE, AND IT IS THE OPPOSITE OF WHAT IT WAS ONE COMMIT AGO. Since the WAL
    //     persists the bracket machine, a restart RESTORES it and the mid-run event is simply
    //     accepted. This cell is what the v2 migration bought; the diagnosis below is now only for
    //     a document that predates it.
    {
      const { wal, source, src, walPath } = await fresh("bracket-restart");
      const ep = new FakeEndpoint();
      const warm = await AguiEmitter.start({ endpoint: ep, wal, source, map: openRunOnly });
      await warm.pump(); // adopt
      append(src, { run: "r1", msg: "m1", text: "opens a run and leaves it open" });
      ep.answers = [{ seq: 4, duplicate: false }];
      await warm.pump(); // a frame goes out with the run STILL OPEN

      const reopened = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: true });
      c(
        "bracket:the-open-run-is-PERSISTED-in-the-WAL",
        reopened.brackets?.run === "r1" && reopened.brackets.text.includes("m1"),
        reopened.brackets,
      );
      // A NEW emitter over the SAME WAL is the restart: same durable state, and now the same
      // bracket state too.
      const restarted = await AguiEmitter.start({ endpoint: ep, wal: reopened, source: new JsonlFileSource<Rec>(src), map: closeRunOnly });
      append(src, { run: "r1", msg: "m1", text: "mid-run" });
      ep.answers = [{ seq: 5, duplicate: false }];
      const p = await attempt(() => restarted.pump());
      c(
        "bracket:a-mid-run-restart-CONTINUES-because-the-state-was-persisted",
        p.err === undefined && p.value?.frames === 1,
        { err: p.err?.message, pumped: p.value },
      );
    }

    // (1b) THE DIAGNOSIS, now reachable only through a MIGRATED v1 WAL — a document that records no
    //      bracket state because v1 never had one. Same failure, and it must still name itself.
    {
      const { src, walPath } = await fresh("bracket-migrated");
      // A REAL cursor, taken from the real source. A hand-written one is refused by the identity
      // check (dev/ino), which would make this cell fail for a reason that has nothing to do with
      // brackets — a refusal for the wrong reason is the failure mode this suite keeps finding.
      const adopted = (await new JsonlFileSource<Rec>(src).read(undefined)).cursor;
      writeFileSync(
        walPath,
        JSON.stringify({
          v: 1, // the whole point: a document written before brackets were persisted
          space: SPACE, epoch: "ep-v1", threadId: THREAD, principal: PRINCIPAL_KEY,
          frontier: { seq: 3, lastSubjectSeq: 9, sourceCursor: adopted },
          pending: null,
        }),
      );

      const wal = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: true });
      c("bracket:the-migrated-document-records-NO-bracket-state", wal.brackets === null, wal.brackets);
      const ep = new FakeEndpoint();
      const em = await AguiEmitter.start({ endpoint: ep, wal, source: new JsonlFileSource<Rec>(src), map: orphan });
      append(src, { run: "r1", msg: "m1", text: "mid-run" });
      const p = await attempt(() => em.pump());
      c(
        "bracket:a-mid-run-restart-names-ITSELF-not-the-writer",
        p.err instanceof AguiBracketStateLost &&
          /LOST ACROSS A RESTART/.test(p.err.message) &&
          /not a protocol violation by the writer/.test(p.err.message) &&
          /migrated from v1/.test(p.err.message),
        p.err?.message ?? "no throw",
      );
      c(
        "bracket:the-diagnosis-carries-the-underlying-refusal-rather-than-replacing-it",
        p.err instanceof AguiBracketStateLost && p.err.cause instanceof AguiVocabularyError && /run/i.test(p.err.cause.message),
        p.err instanceof AguiBracketStateLost ? p.err.cause?.message : "not diagnosed",
      );
    }

    // (1c) CONTROL FOR THE THIRD CONDITION — a restart whose state WAS persisted, hitting a genuine
    //      violation. Non-virgin frontier, nothing fed in this process: the first two conditions both
    //      hold, so only "the WAL can say what was open" keeps this from being misdiagnosed. Without
    //      this cell the third condition could be deleted and nothing would notice.
    {
      const { wal, source, src, walPath } = await fresh("bracket-restored-but-writer-wrong");
      const ep = new FakeEndpoint();
      const warm = await AguiEmitter.start({ endpoint: ep, wal, source, map: openRunOnly });
      await warm.pump();
      append(src, { run: "r1", msg: "m1", text: "opens a run" });
      ep.answers = [{ seq: 4, duplicate: false }];
      await warm.pump();

      const reopened = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: true });
      // The run IS open and IS remembered — so content for a message that was never started is the
      // writer being wrong, not us having forgotten.
      const restarted = await AguiEmitter.start({ endpoint: ep, wal: reopened, source: new JsonlFileSource<Rec>(src), map: orphan });
      append(src, { run: "r1", msg: "NEVER-STARTED", text: "x" });
      const p = await attempt(() => restarted.pump());
      c(
        "bracket:CONTROL-a-violation-after-a-RESTORED-restart-is-NOT-blamed-on-lost-state",
        p.err instanceof AguiVocabularyError && !(p.err instanceof AguiBracketStateLost),
        p.err?.message ?? "no throw",
      );
    }

    // (1d) AND (1e) — THE TWO CONTROLS THAT WAL v2 QUIETLY INVALIDATED.
    //
    // B1 and B2 were KILLED before v2 and SURVIVED after it, and the reason is the exact hazard this
    // fleet already has a rule for: DEFENCE IN DEPTH DEFEATS OUTCOME-BASED TESTING. Adding the third
    // condition meant every case the old controls exercised was ALREADY answered by it — both used a
    // v2 WAL, whose `brackets` is non-null, so conditions 1 and 2 could be deleted with nothing
    // noticing. The old controls did not become wrong; they stopped discriminating.
    //
    // The repair is to hold `brackets === null` CONSTANT and vary only the condition under test.
    // Both cases below are reachable and neither was covered.
    {
      // (1d) Migrated v1, NON-virgin, and this process HAS fed events — because its first batch
      //      validated and then failed to PACK (an oversized unit), so nothing folded and `brackets`
      //      is still null. A violation now is this stream's, not a ghost of the previous process.
      const { src, walPath } = await fresh("bracket-fed-but-unfolded");
      const adopted = (await new JsonlFileSource<Rec>(src).read(undefined)).cursor;
      writeFileSync(walPath, JSON.stringify({
        v: 1, space: SPACE, epoch: "ep-v1", threadId: THREAD, principal: PRINCIPAL_KEY,
        frontier: { seq: 3, lastSubjectSeq: 9, sourceCursor: adopted }, pending: null,
      }));
      const wal = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: true });
      const ep = new FakeEndpoint();
      // r1 opens a run and validates; r2 then finishes a run that was never started. The batch
      // therefore VALIDATES on the first pump (r1 alone) and VIOLATES on the second (r1 re-read,
      // then r2) — which is exactly the shape needed to reach a violation with `fedAnyEvent` set.
      const openThenViolate = (r: Rec) =>
        "skip" in r
          ? null
          : r.run === "r1"
            ? openRunOnly(r)
            : { runId: "rZ", events: [runFinished({ threadId: THREAD, runId: "rZ", timestamp: 9 })] };
      const em = await AguiEmitter.start({ endpoint: ep, wal, source: new JsonlFileSource<Rec>(src), map: openThenViolate });
      ep.maxPayload = 80; // smaller than any single unit: validation succeeds, packing refuses
      append(src, { run: "r1", msg: "m1", text: "hello" });
      const packFailed = await attempt(() => em.pump());
      c(
        "bracket:SETUP-a-batch-can-validate-and-then-fail-to-PACK-leaving-nothing-folded",
        packFailed.err instanceof AguiVocabularyError && wal.brackets === null,
        { err: packFailed.err?.message, brackets: wal.brackets },
      );
      ep.maxPayload = 4096;
      append(src, { run: "r2", msg: "m2", text: "mid-run" });
      const p = await attempt(() => em.pump());
      c(
        "bracket:CONTROL-a-violation-after-this-process-FED-but-never-FOLDED-is-NOT-blamed-on-lost-state",
        p.err instanceof AguiVocabularyError && !(p.err instanceof AguiBracketStateLost),
        p.err?.message ?? "no throw",
      );
    }
    {
      // (1e) Migrated v1 with a VIRGIN frontier: the document cannot say what was open AND nothing
      //      was ever published, so nothing could have been lost. The writer really is wrong.
      const { src, walPath } = await fresh("bracket-migrated-virgin");
      writeFileSync(walPath, JSON.stringify({
        v: 1, space: SPACE, epoch: "ep-v1", threadId: THREAD, principal: PRINCIPAL_KEY,
        frontier: { seq: 0, lastSubjectSeq: 0 }, pending: null,
      }));
      const wal = await EventWal.open(walPath, { space: SPACE, threadId: THREAD, principal: PRINCIPAL_KEY, subjectMayExist: true });
      c("bracket:SETUP-a-migrated-VIRGIN-document-also-records-no-bracket-state", wal.brackets === null, wal.brackets);
      const ep = new FakeEndpoint();
      const em = await AguiEmitter.start({ endpoint: ep, wal, source: new JsonlFileSource<Rec>(src), map: orphan });
      await em.pump(); // adopt
      append(src, { run: "r1", msg: "m1", text: "mid-run" });
      const p = await attempt(() => em.pump());
      c(
        "bracket:CONTROL-a-violation-on-a-MIGRATED-VIRGIN-frontier-is-NOT-blamed-on-lost-state",
        p.err instanceof AguiVocabularyError && !(p.err instanceof AguiBracketStateLost),
        p.err?.message ?? "no throw",
      );
    }

    // (2) CONTROL — VIRGIN frontier: nothing was ever published, so nothing could have been lost.
    //     The writer really is wrong and must be told so.
    {
      const { wal, source, src } = await fresh("bracket-virgin");
      const ep = new FakeEndpoint();
      const em = await AguiEmitter.start({ endpoint: ep, wal, source, map: orphan });
      await em.pump(); // adopt
      append(src, { run: "r1", msg: "m1", text: "mid-run" });
      const p = await attempt(() => em.pump());
      c(
        "bracket:CONTROL-a-violation-on-a-VIRGIN-frontier-is-NOT-blamed-on-a-restart",
        p.err instanceof AguiVocabularyError && !(p.err instanceof AguiBracketStateLost),
        p.err?.message ?? "no throw",
      );
    }

    // (3) CONTROL — MID-STREAM in this very process: the machine is in the state we put it in, so a
    //     refusal now is the writer's, however long ago the process started.
    {
      const { wal, source, src } = await fresh("bracket-midstream");
      const ep = new FakeEndpoint();
      const em = await AguiEmitter.start({
        endpoint: ep,
        wal,
        source,
        map: (r: Rec) => ("skip" in r ? null : r.text === "bad" ? orphan(r) : mapper(r)),
      });
      await em.pump(); // adopt
      append(src, { run: "r1", msg: "m1", text: "good" });
      ep.answers = [{ seq: 6, duplicate: false }];
      await em.pump(); // a legal turn goes through the machine in THIS process
      append(src, { run: "r2", msg: "m2", text: "bad" });
      const p = await attempt(() => em.pump());
      c(
        "bracket:CONTROL-a-violation-AFTER-this-process-has-emitted-is-NOT-blamed-on-a-restart",
        p.err instanceof AguiVocabularyError && !(p.err instanceof AguiBracketStateLost),
        p.err?.message ?? "no throw",
      );
    }
  });

  // ── SIZING IS AN UPPER BOUND, NOT AN ESTIMATE ────────────────────────────────────────────────
  //    The emitter measures at the longest admissible id and the widest admissible expectation,
  //    because neither is known while packing. This cell asserts the direction of the inequality:
  //    what is published must never be LARGER than what was measured.
  await block("SIZING IS AN UPPER BOUND, NOT AN ESTIMATE", async () => {
    const { wal, source, src } = await fresh("sizing");
    const ep = new FakeEndpoint();
    const em = (await attempt(() => AguiEmitter.start({ endpoint: ep, wal, source, map: mapper }))).value!;
    await em.pump();
    append(src, { run: "r1", msg: "m1", text: "x".repeat(200) });
    ep.answers = [{ seq: 3, duplicate: false }];
    await attempt(() => em.pump());
    const call = ep.publishes[0];
    if (!call) return c("sizing:a-frame-was-published-to-measure", false, ep.publishes);
    const published = ep.encodedSize({ channel: em.channel, parts: call.parts, id: call.id, expectedLastSubjectSeq: call.expectedLastSubjectSeq });
    const measured = ep.encodedSize({
      channel: em.channel,
      parts: call.parts,
      id: "S".repeat(64),
      expectedLastSubjectSeq: Number.MAX_SAFE_INTEGER,
    });
    c("sizing:what-is-published-is-never-larger-than-what-was-measured", published <= measured, { published, measured });
    c("sizing:and-the-bound-is-not-vacuous", measured > published, { published, measured });
  });

  // ── THE UPPER BOUND EARNS ITS KEEP AT THE CEILING, WHICH IS THE ONLY PLACE IT CAN ────────────
  //
  // Sizing with the id we EXPECT to use is the natural thing to write and is wrong by exactly the
  // difference between that id and the one actually minted. It is invisible everywhere except
  // within a few dozen bytes of `max_payload`, so the ceiling here is DERIVED FROM THE INSTRUMENT
  // — the real encoded size of the frame the emitter would build — and then set just below it.
  // A hand-picked number would be a second implementation of the sizing rule and would drift.
  //
  // Correct behaviour: the upper-bound measurement says the two units do not fit together, so two
  // frames go out and both are under the ceiling. Under-measure by even the id difference and the
  // packer emits ONE frame that the broker instrument then REFUSES — which is the real failure,
  // because a refused publish after a durable `beginSend` is a wedged emitter, not a retry.
  await block("THE UPPER BOUND EARNS ITS KEEP AT THE CEILING, WHICH IS THE ONLY PLACE", async () => {
    const { wal, source, src } = await fresh("ceiling");
    const ep = new FakeEndpoint();
    const em = (await attempt(() => AguiEmitter.start({ endpoint: ep, wal, source, map: mapper }))).value!;
    await em.pump(); // adopt

    const bothUnits = aguiFrame({
      threadId: THREAD,
      runId: "r1",
      epoch: wal.epoch,
      seq: 1,
      events: [...turn("r1", "m1", "t1"), ...turn("r1", "m2", "t2")],
    });
    // A real minted id is a UUID: 36 characters. The expectation on a virgin subject is `0`.
    const realBytes = ep.encodedSize({
      channel: em.channel,
      parts: [bothUnits as unknown as Part],
      id: "0".repeat(36),
      expectedLastSubjectSeq: 0,
    });
    ep.maxPayload = realBytes - 10;

    append(src, { run: "r1", msg: "m1", text: "t1" }, { run: "r1", msg: "m2", text: "t2" });
    ep.answers = [
      { seq: 1, duplicate: false },
      { seq: 2, duplicate: false },
    ];
    const p = await attempt(() => em.pump());
    c(
      "sizing:the-UPPER-BOUND-keeps-a-packed-frame-under-the-REAL-ceiling",
      p.err === undefined && p.value?.frames === 2,
      { err: p.err?.message, pumped: p.value, ceiling: ep.maxPayload, realBytes },
    );
    c(
      "sizing:CONTROL-the-two-units-really-would-have-fitted-under-a-naive-measure",
      realBytes <= ep.maxPayload + 10,
      { realBytes, ceiling: ep.maxPayload },
    );
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`agui-emitter smoke: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
