/**
 * The run record: what a workflow run IS, beside the journal that says what it DID.
 *
 * The journal on WFJ is append-only and authoritative about events. This is last-value-wins and
 * authoritative about state — who holds the run, what state it is in, and the PIN SET resolved once
 * at start. Two runs of one program under different pins are two different runs, so a resume reads
 * the pins back rather than re-deriving them: "the default" is a property of the interpreter, and
 * the interpreter is the thing that may have changed between attempts.
 *
 * It also carries the one fact the journal cannot hold about itself: **how far the journal has
 * got**. A record deleted from the TAIL of a run's subject leaves the survivors contiguous — the
 * ordinal chain sees nothing missing, because the missing part is the part it would have compared
 * against — and the per-subject head is recalculated backwards, so the fence accepts an append at a
 * head the run already moved past. Measured end to end: the run replays SHORT and intact, a
 * successor activates on it, and it resumes from a prefix that is missing work the run really did.
 * No anchor inside the journal can detect that. `journalHigh` is the anchor OUTSIDE it.
 *
 * What that anchor does and does not cover, stated plainly because a guard believed to be wider
 * than it is is worse than none: it is written at each ACTIVATION, so it detects truncation back
 * past the last takeover. Steps appended since that activation are not covered — writing the record
 * per append would double every step's cost, and the journal's own ordinal chain already covers
 * every interior loss.
 */
import type { KV } from "@nats-io/kv";
import {
  RECORD_KINDS,
  createRecordEntry,
  updateRecordEntry,
  readRecord,
  recordSpecKey,
  recordStatusKey,
  assertStatusValue,
  type MergedRecord,
} from "./endpoint-records.js";

/**
 * The pins, resolved. Structurally the language's `RunPins` — `@cotal-ai/core` does not depend on
 * `@cotal-ai/lang`, and the wire shape is the contract between them rather than a shared type.
 */
export interface RunPinsValue {
  readonly seed: string;
  /** The run's logical epoch. `now()` derives from THIS, never from the resuming host's clock. */
  readonly startedAt: number;
  readonly yieldEvery: number;
  readonly stepBudget: number;
  readonly effectCeiling: number;
  readonly languageVersion: string;
}

/**
 * The immutable half: what this run IS, decided once and never re-decided.
 *
 * Deliberately NOT carrying a program hash yet. The interpreter reports one, but only after a run,
 * and a hash computed here from the source would be a different function's answer wearing the same
 * name — the divergence check that matters is per-step and the language already makes it from the
 * recorded input hashes. A source-identity pin is its own item, not a field filled with a guess.
 */
export interface RunSpecValue {
  readonly v: 1;
  readonly run: string;
  readonly pins: RunPinsValue;
  readonly createdAt: number;
}

/**
 * What a run is doing now.
 *
 * `released` and `failed` are not the same thing and the distinction is the point: a program that
 * failed has a result and the journal has it, while a released run has no result at all — its
 * driver stopped holding it. Recording one as the other would write down a conclusion about work
 * nobody observed.
 */
export type RunState = "running" | "released" | "completed" | "failed";

export interface RunStatusValue {
  readonly v: 1;
  readonly observedSpecRevision: number;
  readonly state: RunState;
  readonly holder: string;
  readonly epoch: number;
  readonly fencingToken: number;
  /**
   * The highest journal ordinal this run is KNOWN to have reached, written at each activation.
   * A replay whose last ordinal is BELOW this has lost records from its tail.
   */
  readonly journalHigh: number;
  readonly at: number;
}

/** A run's journal is missing records from its END — which nothing inside the journal can see. */
export class RunJournalTailTruncated extends Error {
  constructor(
    readonly run: string,
    readonly recordedHigh: number,
    readonly replayedHigh: number,
  ) {
    super(
      `run ${run}: the journal replayed to ordinal ${replayedHigh}, but this run is recorded as having reached ${recordedHigh}. ` +
        `Records are missing from the END of the subject: the surviving prefix is contiguous, so the ordinal chain cannot see it, ` +
        `and the subject's head has rolled back with them. Resuming here would repeat work the run already did. ` +
        `Recover the missing records or retire the run; do not drive it.`,
    );
    this.name = "RunJournalTailTruncated";
  }
}

/** Read a run's record. `undefined` = this run has never been started. */
export async function readRunRecord(
  kv: KV,
  endpoint: string,
  runId: string,
): Promise<MergedRecord<RunSpecValue, RunStatusValue> | undefined> {
  return await readRecord<RunSpecValue, RunStatusValue>(kv, RECORD_KINDS.run, [endpoint, runId]);
}

/**
 * Create a run's spec. Create-only: a spec that already exists means this run was started before,
 * and starting it again under a fresh set of pins would be a different run wearing the same id.
 */
export async function createRunSpec(
  kv: KV,
  endpoint: string,
  runId: string,
  value: Omit<RunSpecValue, "v" | "run">,
): Promise<number> {
  const spec: RunSpecValue = { v: 1, run: runId, ...value };
  return await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.run, [endpoint, runId]), spec);
}

/**
 * Write a run's status. `expectedRevision` is `undefined` for the first write and the last read
 * revision thereafter — the CAS is what keeps two drivers from taking turns overwriting each
 * other's view of who holds the run.
 */
export async function writeRunStatus(
  kv: KV,
  endpoint: string,
  runId: string,
  value: Omit<RunStatusValue, "v">,
  expectedRevision?: number,
): Promise<number> {
  const status = assertStatusValue({ v: 1 as const, ...value });
  // Through the key BUILDER, never a join of our own: it is what asserts the endpoint and the run
  // id are grammatical tokens, and a run id that tokenized loose would write into another run's key.
  const key = recordStatusKey(RECORD_KINDS.run, [endpoint, runId]);
  return expectedRevision === undefined
    ? await createRecordEntry(kv, key, status)
    : await updateRecordEntry(kv, key, status, expectedRevision);
}

/**
 * The tail check, run BETWEEN the replay and the activation.
 *
 * Before, and not after, because an activation appended over a rolled-back head is itself a record
 * written into a journal we already know is wrong — and it would be written at an ordinal the
 * deleted records already used, which is a hole the chain would then blame on someone else.
 */
export function assertJournalTailIntact(
  runId: string,
  recorded: RunStatusValue | undefined,
  replayedHigh: number,
): void {
  if (recorded === undefined) return;
  if (replayedHigh < recorded.journalHigh) {
    throw new RunJournalTailTruncated(runId, recorded.journalHigh, replayedHigh);
  }
}
