import { EpEnvelopeError } from "./endpoint-envelope.js";
import { EP_UNBOUND_CALLER_AUTHORITY } from "./issued-authority.js";
import { assertIdToken, isIssuedCaller } from "./endpoint-subjects.js";
import type { EpServeContext } from "./endpoint-serve.js";
import type { RunHostOutcome } from "./run-host.js";
import type { RunRevocation } from "./run-admission.js";
import type { RunStatusValue } from "./run-record.js";
import type { JetStreamManager } from "@nats-io/jetstream";
import { readRecordLeader, recordSpecKey, recordStatusKey, RECORD_KINDS } from "./endpoint-records.js";

/** Cancellation needs a leader-served holder observation, never a follower KV projection.
 *  A torn pair refuses immediately; it does not become an absent or invented run state. */
export async function readRunCancellationStatus(jsm: JetStreamManager, space: string, endpoint: string, runId: string): Promise<RunStatusValue | undefined> {
  try {
    const spec = await readRecordLeader(jsm, space, recordSpecKey(RECORD_KINDS.run, [endpoint, runId]));
    const status = await readRecordLeader(jsm, space, recordStatusKey(RECORD_KINDS.run, [endpoint, runId]));
    if (!spec) {
      if (status) throw new Error("status without spec");
      return undefined;
    }
    const s = spec.value as { v?: unknown; run?: unknown; pins?: unknown; createdAt?: unknown } | null;
    if (!s || s.v !== 1 || s.run !== runId || !s.pins || typeof s.pins !== "object" || !Number.isSafeInteger(s.createdAt))
      throw new Error("invalid run spec");
    if (!status) return undefined;
    const value = status.value as RunStatusValue | null;
    if (!value || value.v !== 1 || !["running", "released", "completed", "failed"].includes(value.state)
      || typeof value.holder !== "string" || !value.holder
      || !Number.isSafeInteger(value.epoch) || value.epoch < 0
      || !Number.isSafeInteger(value.fencingToken) || value.fencingToken < 0
      || !Number.isSafeInteger(value.observedSpecRevision) || value.observedSpecRevision < 0
      || value.observedSpecRevision > spec.revision
      || !Number.isSafeInteger(value.journalHigh) || !Number.isSafeInteger(value.at))
      throw new Error("invalid or torn run status");
    return value;
  } catch {
    throw new EpEnvelopeError("unavailable", "run-cancel could not read a valid run record");
  }
}

export const RUN_CANCEL_MAX_DEADLINE_MS = 30_000;

export interface RunCancelInput {
  readonly runId: string;
  readonly reason: string;
}

export type RunCancelAuthority = "original" | "owner-interactive" | "admin";
export type RunCancelCommitCode = "permission-denied" | "failed-precondition" | "deadline-exceeded" | "resource-exhausted" | "unavailable";
export type RunCancelCommit =
  | { readonly kind: "committed"; readonly outcome: "created" | "existed"; readonly revocation: RunRevocation }
  | { readonly kind: "refused-before-dispatch" | "outcome-unknown"; readonly code: RunCancelCommitCode };

export interface RunCancelResult {
  readonly runId: string;
  readonly revocation?: Pick<RunRevocation, "by" | "reason" | "revokedAt">;
  readonly duplicate: boolean | null;
  readonly authority: RunCancelAuthority;
  readonly observed: {
    readonly processEpoch: number;
    readonly phase: "terminal" | "launch-abandoned" | "stop-requested" | "stopped" | "not-driven-here";
    readonly recordedState?: RunStatusValue["state"];
    readonly runEpoch?: number;
    readonly fencingToken?: number;
    readonly holder?: string;
    readonly driveOutcome?: RunHostOutcome;
  };
}

/** Shared by the served handler and issuing host's observer. Never truncate a reason. */
export function readRunCancelInput(raw: unknown): RunCancelInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("bad-request", "run-cancel requires a closed runId/reason object");
  const object = raw as Record<string, unknown>;
  if (Object.keys(object).length !== 2 || typeof object.runId !== "string" || typeof object.reason !== "string")
    throw new EpEnvelopeError("bad-request", "run-cancel requires only runId and reason strings");
  assertIdToken(object.runId, "runId");
  for (const character of object.reason) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff)
      throw new EpEnvelopeError("bad-request", "run-cancel reason must be well-formed Unicode");
  }
  const bytes = new TextEncoder().encode(object.reason).length;
  if (bytes < 1 || bytes > 512)
    throw new EpEnvelopeError("bad-request", "run-cancel reason must encode to 1..512 UTF-8 bytes");
  return { runId: object.runId, reason: object.reason };
}

/** Run before the manager's serving/reconciliation gate. Returns the original monotonic deadline. */
export function runCancelCoordinates(ctx: EpServeContext, instanceId: string): number {
  const caller = ctx.subject.caller;
  if (ctx.subject.rail !== "v1" || !isIssuedCaller(caller))
    throw new EpEnvelopeError("permission-denied", "run-cancel requires issued caller authority", [
      { kind: EP_UNBOUND_CALLER_AUTHORITY, owner: caller.owner, actor: caller.actor, uid: caller.uid },
    ]);
  const bind = ctx.request.bind;
  const deadline = ctx.request.deadlineMs;
  if (ctx.subject.route !== "inst" || ctx.subject.instanceId !== instanceId || ctx.subject.target !== null
    || !bind || bind.instanceId !== instanceId || bind.epoch !== ctx.identity.epoch
    || !Number.isFinite(ctx.receivedAtMonotonicMs) || !Number.isSafeInteger(deadline) || deadline! <= 0)
    throw new EpEnvelopeError("permission-denied", "run-cancel request is not authorized");
  if (deadline! > RUN_CANCEL_MAX_DEADLINE_MS)
    throw new EpEnvelopeError("bad-request", `run-cancel deadline exceeds ${RUN_CANCEL_MAX_DEADLINE_MS}ms`);
  return ctx.receivedAtMonotonicMs! + deadline!;
}
