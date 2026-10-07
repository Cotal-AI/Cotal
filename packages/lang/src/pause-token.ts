/**
 * Which pause a run's step is waiting on, read off the step's journal records. The hosting manager
 * reads it to answer a step, and the issuing host reads it to pin an answering credential to that
 * step's pause and no other.
 */
import { holdRequestId } from "./keys.js";
import { journalEntryKeyString, type JournalEntry } from "./journal.js";

/** No open checkpoint (or ask) answers to this address in this run. */
export class CheckpointNotOpen extends Error {
  constructor(
    readonly runId: string,
    readonly stepKey: string,
    readonly why: "unknown" | "settled" | "not-a-checkpoint" | "no-identity",
  ) {
    super(
      `run ${runId} has no open checkpoint at ${stepKey}: ${
        {
          unknown: "no step is recorded under that key",
          settled: "that step has already settled",
          "not-a-checkpoint": "that step is neither a checkpoint nor an ask",
          "no-identity": "that step is pending but carries no request id, so the checkpoint it is waiting on cannot be named",
        }[why]
      }`,
    );
    this.name = "CheckpointNotOpen";
  }
}

/** No accepted answer at this address that an amendment could be filed beside. */
export class CheckpointNotAmendable extends Error {
  constructor(
    readonly runId: string,
    readonly stepKey: string,
    readonly why: "unknown" | "open" | "not-a-checkpoint" | "unanswered",
  ) {
    super(
      `run ${runId} has no accepted answer to amend at ${stepKey}: ${
        {
          unknown: "no step is recorded under that key",
          open: "that step is still open, so answer it instead",
          "not-a-checkpoint": "that step is neither a checkpoint nor an ask",
          unanswered: "that step settled without accepting an answer",
        }[why]
      }`,
    );
    this.name = "CheckpointNotAmendable";
  }
}

/** The token a step's pause is read under, over the step's records in append order. A held step
 *  (spec/cotal-lang.md §7.8) reads at its hold id whatever its kind. An `ask` reads at its LAST
 *  attempt's token, which rides its records as `askToken` (attempt 1 is the request id), and any
 *  other step at its request id. */
export function stepPauseToken(records: readonly JournalEntry[]): string | undefined {
  const last = records.at(-1);
  if (last?.requestId === undefined) return undefined;
  if (records.some((e) => e.hold !== undefined)) return holdRequestId(last.requestId);
  if (last.kind !== "ask") return last.requestId;
  const askToken = records.findLast((e) => typeof e.external?.askToken === "string")?.external?.askToken;
  return typeof askToken === "string" ? askToken : last.requestId;
}

/** The token a settled checkpoint, ask or held step settled under, or a loud refusal naming why the
 *  step has none to amend. */
export function settledPauseToken(
  entries: readonly JournalEntry[],
  runId: string,
  stepKey: string,
): string | undefined {
  const records = entries.filter((e) => journalEntryKeyString(e) === stepKey);
  const entry = records.at(-1);
  if (entry === undefined) throw new CheckpointNotAmendable(runId, stepKey, "unknown");
  if (!records.some((e) => e.hold !== undefined) && entry.kind !== "checkpoint" && entry.kind !== "ask")
    throw new CheckpointNotAmendable(runId, stepKey, "not-a-checkpoint");
  if (entry.state === "pending") throw new CheckpointNotAmendable(runId, stepKey, "open");
  return stepPauseToken(records);
}

/** The token of the open checkpoint (or ask attempt) at this address, or a loud refusal naming
 *  which it is not. An `ask` parks on the checkpoint plane too — one pause per attempt — and the
 *  CURRENT attempt's token rides the entry's external state as `askToken` (attempt 1 is the
 *  request id itself), so an answer always lands on the pause that is actually open. */
export function openCheckpointToken(
  entries: readonly JournalEntry[],
  runId: string,
  stepKey: string,
): string {
  // Append order, later record wins: a settled step has a settled entry written after its pending
  // one, and answering the pending one would present a token whose pause is already over.
  const records = entries.filter((e) => journalEntryKeyString(e) === stepKey);
  const entry = records.at(-1);
  if (entry === undefined) throw new CheckpointNotOpen(runId, stepKey, "unknown");
  if (!records.some((e) => e.hold !== undefined) && entry.kind !== "checkpoint" && entry.kind !== "ask")
    throw new CheckpointNotOpen(runId, stepKey, "not-a-checkpoint");
  if (entry.state !== "pending") throw new CheckpointNotOpen(runId, stepKey, "settled");
  const token = stepPauseToken(records);
  if (token === undefined) throw new CheckpointNotOpen(runId, stepKey, "no-identity");
  return token;
}
