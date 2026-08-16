/**
 * The run driver: what actually advances a workflow run, and the only thing allowed to.
 *
 * A driver is not a scheduler and not a supervisor. Its whole job is to be the ONE process holding a
 * run, to hand the interpreter a journal that is durable and complete, and to stop the moment it is
 * no longer that process. Everything hard about the first and third parts lives in the activation
 * barrier (`@cotal-ai/core`); everything hard about the middle lives in the language. This file is
 * the join, and it is deliberately small — a driver with its own opinions about durability would be
 * a second answer to a question that already has one.
 *
 * **Start and resume are the same act with one bit of difference**, and the bit is not cosmetic. A
 * run's journal cannot say whether an empty subject means "never started" or "retired by purge", so
 * the caller states which it means: `startRun` activates with `expect: "new"` and `driveRun` with
 * `expect: "existing"`, and the barrier refuses the mismatch either way. That is why there are two
 * entry points rather than one that guesses from what it finds.
 *
 * **The prefix the barrier replayed IS the journal the interpreter resumes from.** Not a copy of it,
 * not a second read: the appender hands back exactly the records it validated as complete before it
 * activated, so there is no window in which the driver could resume from a different prefix than the
 * one it took the run over on.
 *
 * **A durability failure is not a run failure.** If the journal refuses an append — superseded,
 * stalled, retired — the run is not "failed", it is no longer THIS process's to speak for. The
 * distinction is the whole reason `RunJournalStore` maps those to L5010: a driver that reported them
 * as an outcome would be writing down a conclusion about work it can no longer see.
 */
import {
  activateRun,
  readRunRecord,
  createRunSpec,
  writeRunStatus,
  assertJournalTailIntact,
  RunJournalTailTruncated,
  type RunStatusValue,
  RunSuperseded,
  RunJournalStalled,
  StaleLeaseToken,
  ActivationNotAuthorized,
  RunNotResumable,
  RunAlreadyStarted,
  RunJournalPrefixTruncated,
} from "@cotal-ai/core";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import {
  Journal,
  JournalAppendRejected,
  run as runProgram,
  resume as resumeProgram,
  RunReleased,
  resolvePins,
  LANGUAGE_VERSION,
  PIN_DEFAULTS,
  type EffectHandler,
  type JournalEntry,
  type RunPins,
  type RunResult,
} from "@cotal-ai/lang";
import { RunJournalStore } from "./journal-store.js";

/**
 * The lease this driver holds the run under, from the work pool.
 *
 * `fencingToken` is `WorkLease.fencingToken` — monotonic per item, and the coordinate the barrier
 * orders takeovers by. `holder` and `epoch` are the identity it is bound to: a token alone would let
 * a returning process re-establish itself on a lease it still remembers, which is the same defect
 * the barrier exists to prevent.
 */
export interface RunLease {
  readonly holder: string;
  readonly epoch: number;
  readonly fencingToken: number;
  /**
   * The takeover id this driver's journal credential was minted for.
   *
   * It names the replay consumer, and a consumer name is one subject token, so it cannot be covered
   * by a grant pattern — it has to be known when the rows are minted. That is when the lease is
   * handed out, which is why it arrives with the lease rather than being chosen here.
   */
  readonly takeoverId: string;
}

/**
 * A pause an operator can ask for while a run is being driven.
 *
 * The driver reads it before each effect it has not already recorded, so a pause takes effect at the
 * next boundary and never in the middle of one. It is one-way on purpose: resuming is starting a
 * drive again, which is the same act as any other takeover and goes through the barrier like one.
 */
export class PauseToken {
  private why: string | undefined;

  pause(reason: string): void {
    this.why ??= reason;
  }

  get reason(): string | undefined {
    return this.why;
  }
}

export interface DriveRequest {
  readonly space: string;
  /**
   * The endpoint HOSTING this driver — the manager daemon (design §10). It leads the run record's
   * key, so a retirement drain and a per-endpoint enumeration both work by prefix.
   */
  readonly endpoint: string;
  readonly runId: string;
  /** The program. A resume MUST be handed the same source: a different one is a fork, not a resume. */
  readonly source: string;
  readonly lease: RunLease;
  readonly handler: EffectHandler;
  /**
   * The records bucket. NOT optional, and deliberately so: the run record holds the pins a resume
   * must read back and the high-water ordinal that is the only thing able to see a truncated
   * journal tail. A driver that could run without it would skip both silently, which is the failure
   * mode both exist to prevent.
   */
  readonly kv: KV;
  readonly seed?: string;
  readonly file?: string;
  readonly effectCeiling?: number;
  readonly stepBudget?: number;
  /**
   * The ABSOLUTE work horizon this driver accepted the item under (`WorkLease.workExpiry`).
   *
   * Past it the pool has already reconciled the item, so a driver still appending is writing into a
   * run the authority considers finished with. Nothing needs to be read to know this: the horizon is
   * fixed at acceptance and never re-set (SPEC 13.8), which is exactly what makes it safe to check
   * locally — unlike a lease deadline, whose current value is a fact on another machine and whose
   * check would be a read-then-publish with a gap that cannot be closed.
   */
  readonly workExpiry?: number;
  /** An operator's pause, honoured at the next effect boundary. */
  readonly pause?: PauseToken;
  /**
   * Repair external state bound to the PREVIOUS holder, once this driver holds the run and before
   * the program is resumed.
   *
   * The case that exists is timers: a checkpoint's armed schedule fires onto a subject derived from
   * the instance and epoch that armed it, so a run adopted by another host has live timers firing
   * where nobody is listening, and resuming the program does not repair that — the pause replays as
   * pending and goes straight back to waiting. What to re-arm is the mesh handler's business, not
   * the driver's, so the driver only says WHEN: after the activation, because arming timers for a
   * run this process turned out not to hold would point another driver's fires at this one.
   *
   * A failure here is a failure to take the run over, and is not swallowed: a driver that resumed a
   * program whose pauses it could not re-arm would look like it was holding a run it cannot advance.
   */
  readonly onActivated?: (entries: readonly JournalEntry[]) => Promise<void>;
}

/**
 * What a drive attempt did, as a two-exit answer rather than a value plus exceptions.
 *
 * `completed` is the program finishing under this driver. `released` is this driver ceasing to hold
 * the run — superseded, stalled, retired — which says nothing about the program and must never be
 * recorded as if it did. A program that FAILS is still `completed`: the failure is the run's result,
 * and the journal has it.
 */
export type DriveOutcome =
  | { readonly status: "completed"; readonly result: RunResult }
  | { readonly status: "released"; readonly reason: Error };

/** Start a run that has never been driven. Refused if the journal already has records. */
export async function startRun(
  js: JetStreamClient,
  jsm: JetStreamManager,
  req: DriveRequest,
): Promise<DriveOutcome> {
  return await drive(js, jsm, req, "new");
}

/** Take over a run that already exists and drive it to quiescence. Refused if its journal is empty:
 *  a run whose records were purged is retired, and re-running it would repeat what it already did. */
export async function driveRun(
  js: JetStreamClient,
  jsm: JetStreamManager,
  req: DriveRequest,
): Promise<DriveOutcome> {
  return await drive(js, jsm, req, "existing");
}

async function drive(
  js: JetStreamClient,
  jsm: JetStreamManager,
  req: DriveRequest,
  expect: "new" | "existing",
): Promise<DriveOutcome> {
  // The record FIRST, because two of the things it holds decide whether this attempt may proceed at
  // all: the pins the run was started under, and how far its journal is known to have got.
  const record = await readRunRecord(req.kv, req.endpoint, req.runId);
  const recordedStatus = record?.status?.value;

  let pins: RunPins;
  let statusRevision: number | undefined;
  if (expect === "new") {
    if (record !== undefined) {
      // Not `RunAlreadyStarted` from the journal — this run has a SPEC, which is the stronger
      // statement: it was started, pinned, and those pins are not this attempt's to re-decide.
      return { status: "released", reason: new RunAlreadyStarted(req.runId, 0) };
    }
    // Resolved ONCE, here, from the host clock read exactly once — from here on the epoch is a
    // recorded fact, and a second read could not be the same run's epoch.
    pins = resolvePins(
      {
        runId: req.runId,
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
        ...(req.effectCeiling !== undefined ? { effectCeiling: req.effectCeiling } : {}),
        ...(req.stepBudget !== undefined ? { stepBudget: req.stepBudget } : {}),
      },
      req.handler.now(),
    );
  } else {
    if (record === undefined) return { status: "released", reason: new RunNotResumable(req.runId, req.runId) };
    // READ BACK, never re-derived. A default is a property of the interpreter, and the interpreter
    // is the thing that may have changed between attempts.
    pins = record.spec.value.pins as RunPins;
    statusRevision = record.status?.revision;
  }

  let appender;
  try {
    appender = await activateRun(js, jsm, {
      space: req.space,
      runId: req.runId,
      holder: req.lease.holder,
      fencingToken: req.lease.fencingToken,
      epoch: req.lease.epoch,
      takeoverId: req.lease.takeoverId,
      at: req.handler.now(),
      expect,
    }, {
      // BETWEEN the replay and the activation, which is the only place this check is worth
      // anything: an activation appended over a rolled-back head is another record written into a
      // journal already known to be wrong, at an ordinal the deleted records already used.
      onReplayed: (replay) => {
        assertJournalTailIntact(req.runId, recordedStatus, lastOrdinal(replay.records));
      },
    });
  } catch (e) {
    // Every one of these means "this driver does not hold this run", and none of them is a fact
    // about the program. A caller that treated them as a run result would be recording a conclusion
    // about work it never saw.
    if (isNotOurs(e)) return { status: "released", reason: e as Error };
    throw e;
  }

  const resumed = appender.steps() as readonly JournalEntry[];
  if (req.onActivated !== undefined) await req.onActivated(resumed);

  const store = new RunJournalStore(appender);
  const journal = new Journal({
    run: req.runId,
    // The prefix the barrier validated and activated on, not a second read of the subject.
    entries: resumed,
    store,
  });

  // Asked before every effect that is not already recorded. Both reasons are the HOST's and neither
  // is the program's, so neither may be recorded as its outcome — the run stops where its journal
  // already says it is, and the next driver resumes from there.
  const shouldStop = (): string | undefined => {
    if (req.workExpiry !== undefined) {
      const now = req.handler.now();
      if (now >= req.workExpiry) return `the work horizon ${req.workExpiry} passed at ${now}`;
    }
    return req.pause?.reason;
  };

  const options = {
    runId: req.runId,
    handler: req.handler,
    shouldStop,
    pins,
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
    ...(req.file !== undefined ? { file: req.file } : {}),
    ...(req.effectCeiling !== undefined ? { effectCeiling: req.effectCeiling } : {}),
    ...(req.stepBudget !== undefined ? { stepBudget: req.stepBudget } : {}),
  };

  // The spec is created AFTER the activation, not before: until this driver holds the run it has
  // decided nothing, and a spec written by a driver that then lost the activation race would pin a
  // run for a winner who never agreed to those pins.
  if (expect === "new") {
    await createRunSpec(req.kv, req.endpoint, req.runId, {
      pins,
      createdAt: pins.startedAt,
    });
  }
  const specRevision = expect === "new"
    ? (await readRunRecord(req.kv, req.endpoint, req.runId))!.spec.revision
    : record!.spec.revision;
  statusRevision = await note(req, "running", appender.journalHigh, specRevision, statusRevision);

  try {
    const result =
      expect === "new"
        ? await runProgram(req.source, { ...options, journal })
        : await resumeProgram(req.source, journal, options);
    await note(req, "completed", appender.journalHigh, specRevision, statusRevision);
    return { status: "completed", result };
  } catch (e) {
    // L5010 is the journal saying it could not record — the run is not this driver's any more. It
    // arrives here rather than at the append because the interpreter is what was holding the stack.
    if (e instanceof JournalAppendRejected) {
      // Recorded on a BEST-EFFORT basis and never allowed to mask the real answer: the record is a
      // projection, and a driver that could not append to the journal may not be able to write here
      // either. What it must not do is turn a lost run into a different-looking failure.
      await noteQuietly(req, "released", appender.journalHigh, specRevision, statusRevision);
      return { status: "released", reason: e };
    }
    // The host stopping is the same kind of answer: this driver no longer holds the run, and the
    // program has neither failed nor finished.
    if (e instanceof RunReleased) {
      await note(req, "released", appender.journalHigh, specRevision, statusRevision);
      return { status: "released", reason: e };
    }
    // A program that FAILED is a fact about the program, and the run record is where a reader looks
    // for it. Recorded, then re-raised: swallowing it here would leave the caller believing the
    // driver finished normally.
    await note(req, "failed", appender.journalHigh, specRevision, statusRevision);
    throw e;
  }
}

function isNotOurs(e: unknown): boolean {
  return (
    e instanceof RunSuperseded ||
    e instanceof RunJournalStalled ||
    e instanceof StaleLeaseToken ||
    e instanceof ActivationNotAuthorized ||
    e instanceof RunNotResumable ||
    e instanceof RunAlreadyStarted ||
    e instanceof RunJournalPrefixTruncated
  );
}

/** The last ordinal in a replayed prefix, or -1 for a run that has none yet. */
function lastOrdinal(records: readonly { readonly record: { readonly n: number } }[]): number {
  return records.length === 0 ? -1 : records[records.length - 1]!.record.n;
}

/** Write the run's status. Returns the new revision so the next write can pin it. */
async function note(
  req: DriveRequest,
  state: RunStatusValue["state"],
  journalHigh: number,
  observedSpecRevision: number,
  expectedRevision: number | undefined,
): Promise<number> {
  return await writeRunStatus(
    req.kv,
    req.endpoint,
    req.runId,
    {
      observedSpecRevision,
      state,
      holder: req.lease.holder,
      epoch: req.lease.epoch,
      fencingToken: req.lease.fencingToken,
      journalHigh,
      at: req.handler.now(),
    },
    expectedRevision,
  );
}

/** The same write, where failing to make it must not replace the answer the caller is owed. */
async function noteQuietly(
  req: DriveRequest,
  state: RunStatusValue["state"],
  journalHigh: number,
  observedSpecRevision: number,
  expectedRevision: number | undefined,
): Promise<void> {
  try {
    await note(req, state, journalHigh, observedSpecRevision, expectedRevision);
  } catch {
    /* the record is a projection; the journal is the authority and it has already spoken */
  }
}
