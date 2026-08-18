/**
 * `resolveCheckpoint` — the run-driver command through which a checkpoint is answered.
 *
 * **Nothing outside presents the token.** A checkpoint's resume is holder-bound (SPEC §13.10), and
 * a workflow checkpoint's holder is the run driver: it is the one principal guaranteed to exist for
 * the pause's whole life. So an observer UI, a notification action, or another agent does not talk
 * to `endpoint-checkpoint` at all — each calls this, which authorizes the caller under the run's
 * own ACL, files their answer, and then presents the token as the driver. "Resolvable from
 * anywhere" is true at the product level while resume stays holder-bound at the protocol level, and
 * §13.10 is not weakened by a millimetre. The cost is that the driver must be reachable to answer a
 * checkpoint, which is the same condition under which the run advances at all.
 *
 * **The answer is written BEFORE the token is presented,** and the two are separate facts on
 * purpose. The record is the payload; the settle is the one-use arbiter that releases the run. In
 * that order a crash in between leaves an answer nobody accepted — orphaned, read by nothing, and
 * harmless. In the other order it would leave a run released with its answer nowhere.
 *
 * **The step is addressed by its KEY, not by its token.** A token is `ctx.requestId`, derived from
 * the run, the step key, the input hash and the attempt, and a resolver has none of those: it knows
 * "the checkpoint named `approve` in this run". The journal is what maps one to the other, and it is
 * also what says whether that step is still open — which is the question a resolver most needs
 * answered before it collects a human's decision.
 */
import {
  replayRunJournal,
  newTakeoverId,
  recordCheckpointAnswer,
  checkpointAnswerId,
  resumeCheckpoint,
  type CheckpointSettleFact,
} from "@cotal-ai/core";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import { journalEntryKeyString, type JournalEntry } from "@cotal-ai/lang";

/** No open checkpoint answers to this address in this run. */
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
          "not-a-checkpoint": "that step is not a checkpoint",
          "no-identity": "that step is pending but carries no request id, so the checkpoint it is waiting on cannot be named",
        }[why]
      }`,
    );
    this.name = "CheckpointNotOpen";
  }
}

export interface ResolveCheckpointRequest {
  readonly runId: string;
  /** The step's canonical key string, e.g. `/checkpoint:approve#0` (`stepKeyString`). */
  readonly stepKey: string;
  /** WHO answered, as the run's ACL knows them. Recorded; never the presenting principal. */
  readonly by: string;
  readonly value?: unknown;
  /** The digest of what the answerer actually saw — an approval as evidence, not as a claim. */
  readonly artifact?: string;
  readonly now: number;
}

export interface ResolveCheckpointResult {
  readonly token: string;
  readonly answerId: string;
  readonly settle: CheckpointSettleFact;
}

export interface ResolveCheckpointDeps {
  readonly kv: KV;
  readonly js: JetStreamClient;
  readonly jsm: JetStreamManager;
  readonly space: string;
  /** The endpoint hosting the driver, and the holder it presents as. */
  readonly endpoint: string;
  readonly holder: { readonly id: string; readonly lifecycleUid: string };
}

/**
 * Answer a run's open checkpoint.
 *
 * Refusals are the plane's own and are not softened here: a checkpoint already resumed is a
 * `conflict` (resume authorization is one-use) and one already expired is a `failed-precondition`
 * (expiry fails closed). Both mean the answer arrived too late, and both leave this resolver's
 * record filed and unaccepted — which is what the caller needs to be told rather than a success
 * that names a settlement somebody else won.
 */
export async function resolveCheckpoint(
  deps: ResolveCheckpointDeps,
  req: ResolveCheckpointRequest,
): Promise<ResolveCheckpointResult> {
  const entries = await replayRunEntries(deps, req.runId);
  const token = openCheckpointToken(entries, req.runId, req.stepKey);

  const answerId = checkpointAnswerId({
    token,
    by: req.by,
    ...(req.value !== undefined ? { value: req.value } : {}),
    ...(req.artifact !== undefined ? { artifact: req.artifact } : {}),
  });
  await recordCheckpointAnswer(deps.kv, deps.endpoint, {
    v: 1,
    token,
    answerId,
    ...(req.value !== undefined ? { value: req.value } : {}),
    ...(req.artifact !== undefined ? { artifact: req.artifact } : {}),
    by: req.by,
    at: req.now,
  });

  const settle = await resumeCheckpoint(deps.kv, deps.js, deps.jsm, deps.space, {
    ref: { endpoint: deps.endpoint, token },
    presenter: deps.holder,
    now: req.now,
    answerId,
  });
  return { token, answerId, settle };
}

/** The token of the open checkpoint at this address, or a loud refusal naming which it is not. */
export function openCheckpointToken(
  entries: readonly JournalEntry[],
  runId: string,
  stepKey: string,
): string {
  // Append order, later record wins: a settled step has a settled entry written after its pending
  // one, and answering the pending one would present a token whose pause is already over.
  let entry: JournalEntry | undefined;
  for (const e of entries) if (journalEntryKeyString(e) === stepKey) entry = e;
  if (entry === undefined) throw new CheckpointNotOpen(runId, stepKey, "unknown");
  if (entry.kind !== "checkpoint") throw new CheckpointNotOpen(runId, stepKey, "not-a-checkpoint");
  if (entry.state !== "pending") throw new CheckpointNotOpen(runId, stepKey, "settled");
  if (entry.requestId === undefined) throw new CheckpointNotOpen(runId, stepKey, "no-identity");
  return entry.requestId;
}

/** The run's step entries, in append order. Read-only: this replays under its own consumer name and
 *  activates nothing, so it never contends with the driver actually holding the run. */
async function replayRunEntries(deps: ResolveCheckpointDeps, runId: string): Promise<JournalEntry[]> {
  const replay = await replayRunJournal(deps.js, deps.jsm, deps.space, runId, newTakeoverId());
  const entries: JournalEntry[] = [];
  for (const stored of replay.records) {
    if (stored.record.kind === "step") entries.push(stored.record.entry as JournalEntry);
  }
  return entries;
}
