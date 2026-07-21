/**
 * The AWAITABLE CHECKPOINT (SPEC §13.6): ONE durable pause primitive (approvals, guard holds,
 * payment authorization) as a pattern over the `cp` record, the one-use `epf….cp.<token>`
 * settle fact, and the MEDIATED timer plane (§13.2/§13.12) — zero new transport.
 *
 * The moving parts and their owners (§13.9 rows):
 *  - the `cp` RECORD (commit path): spec = the minted checkpoint (token, the goal it pauses,
 *    the bound holder); status = `waiting` with the DEADLINE GENERATION — the monotonic
 *    counter every heartbeat CAS-advances BEFORE replacing the timer.
 *  - the SETTLE FACT (commit path): ONE create-only CAS on `epf.<e>.cp.<token>` is the
 *    arbiter for the checkpoint's single settlement — a RESUME and the deadline EXPIRY race
 *    there, first claim wins, the loser observes it. Resume authorization is thereby ONE-USE
 *    (a duplicate resume is `conflict`) and expiry FAILS CLOSED (a post-expiry resume is
 *    refused with the recorded expiry).
 *  - the TIMER WRITER (its own principal): instances publish only `.schedule` REQUESTS into
 *    the schedules-DISABLED `EPT_REQ` stream, where any client-set scheduling header is inert
 *    bytes — and the writer REJECTS a request carrying one (the ADR-51 confused-deputy
 *    closure). The writer alone publishes the authoritative `.armed` (on EPT) with
 *    `Nats-Schedule-Target` = the sibling `.fire` derived from the AUTHENTICATED request
 *    subject's own tokens, never a body field. Every arm is FENCED: the writer reads the
 *    `.armed` subject's last sequence, proves the authoritative status LEADER-SERVED
 *    (`STREAM.MSG.GET`, never a possibly-follower Direct Get), and publishes with
 *    `Nats-Expected-Last-Subject-Sequence` pinned to that read — a delayed writer whose proof
 *    was superseded is rejected by the BROKER, so `.armed` can never roll back to a stale
 *    deadline. A same-`(timerId, generation)` arm re-derives
 *    the same `.armed` — the server's same-subject rollup makes a duplicate a no-op
 *    replacement, so the durable RECONCILER simply re-emits a `.schedule` at the current
 *    generation for every `waiting` status it owns; over-emission is harmless and a missing
 *    schedule is repaired without any status↔schedule read.
 *  - FIRE handling (the endpoint's trusted seam): act only on a fired message whose
 *    broker-authored `Nats-Scheduler` header equals the exact sibling `.armed` subject AND
 *    whose carried `(timerId, generation)` matches current status AND whose deadline is due
 *    at the owner's clock; everything else is discarded (forged) or a stale no-op.
 *
 * Deadlines are mandatory; clocks are inputs (`now`), never a module-internal Date.now.
 */
import type { KV } from "@nats-io/kv";
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { headers as natsHeaders, type MsgHdrs, type NatsConnection } from "@nats-io/transport-node";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { canonicalJson } from "./canonical.js";
import { epfSubject, eptSubject, parseEpSubject, assertIdToken, type EpCaller } from "./endpoint-subjects.js";
import { RECORD_KINDS, recordSpecKey, recordStatusKey, createRecordEntry, updateRecordEntry, assertStatusValue, readRecordLeader, isCasLoss } from "./endpoint-records.js";
import { epfStreamName, readLastFact } from "./endpoint-journal.js";
import { eptStreamName } from "./endpoint-binding.js";

/** A checkpoint's coordinates: the owning endpoint + the minted token. */
export interface CheckpointRef {
  endpoint: string;
  token: string;
}

/** The one-use settle-fact subject (`epf.<e>.cp.<token>`, §13.9). */
export function checkpointSettleSubject(space: string, ref: CheckpointRef): string {
  return epfSubject(space, ref.endpoint, ["cp", ref.token]);
}

function cpQualifiers(ref: CheckpointRef): string[] {
  return [ref.endpoint, ref.token];
}

/** The checkpoint SPEC (written once at mint): what is paused and who may resume. `holder` is
 *  MANDATORY (§13.6:1622/§13.10:2315: checkpoint resume is holder-bound — an omitted holder
 *  would make the token a BEARER credential resumable by anyone who learns it). The deep
 *  signature verification is the capability-handle slice; this seam enforces the recorded
 *  identity. `goal` is present iff the checkpoint pauses an action goal. */
export interface CheckpointSpecValue {
  v: 1;
  token: string;
  goal?: { caller: EpCaller; goalId: string };
  /** The guard's VERIFIED signed obligations, persisted at mint so they SURVIVE the pause
   *  (§13.6/§13.10: obligations are MUST-apply and reusable within their goal — a hold that
   *  verified them and then dropped them would release the executor with zero attenuations).
   *  Present iff the hold carried a non-empty set; release/reconcile return exactly this
   *  recorded set, signatures intact. Only meaningful with a `goal` binding. */
  obligations?: CheckpointObligation[];
  holder: { id: string; lifecycleUid: string };
  mintedAt: number;
  /** The initial (generation-1) deadline, recorded in the IMMUTABLE spec (distsys 8dcad72 M3):
   *  a mint that crashes after the spec exists but before the status is created must, on retry,
   *  re-derive the SAME initial deadline from the spec - never silently install a different one
   *  because the status was missing. Heartbeats extend the LIVE deadline in the status; this is
   *  only the original intent, fixed at mint. */
  initialDeadline: number;
}

/** Closed-schema guard: an unknown field in a persisted record (or a smuggled extra on an
 *  input) is refused, never carried along. */
function closedKeys(o: Record<string, unknown>, allowed: readonly string[], what: string, code: "internal" | "failed-precondition"): void {
  for (const k of Object.keys(o))
    if (!allowed.includes(k))
      throw new EpEnvelopeError(code, `${what} carries the unknown field "${k}"; checkpoint schemas are closed (SPEC 13.6)`);
}

function isHolder(v: unknown): v is { id: string; lifecycleUid: string } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return Object.keys(o).length === 2
    && typeof o.id === "string" && o.id.length > 0
    && typeof o.lifecycleUid === "string" && o.lifecycleUid.length > 0;
}

/** Detach a caller-supplied holder/presenter to a frozen exact copy at seam entry: a live
 *  object mutated across an await must never move an authority coordinate mid-seam. Every
 *  property is READ EXACTLY ONCE (a getter answering differently between a validation read and
 *  a copy read must not split what was checked from what is used). */
function snapshotHolder(v: unknown, what: string): { id: string; lifecycleUid: string } {
  if (v === null || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 2)
    throw new EpEnvelopeError("failed-precondition", `${what} must be a closed {id, lifecycleUid} pair of nonempty strings (SPEC 13.6/13.10)`);
  const id = (v as Record<string, unknown>).id;
  const lifecycleUid = (v as Record<string, unknown>).lifecycleUid;
  if (typeof id !== "string" || id.length === 0 || typeof lifecycleUid !== "string" || lifecycleUid.length === 0)
    throw new EpEnvelopeError("failed-precondition", `${what} must be a closed {id, lifecycleUid} pair of nonempty strings (SPEC 13.6/13.10)`);
  return Object.freeze({ id, lifecycleUid });
}

/** Detach a caller-supplied ref to a frozen exact copy at seam entry (single-read). */
function snapshotCpRef(ref: CheckpointRef): CheckpointRef {
  if (ref === null || typeof ref !== "object")
    throw new EpEnvelopeError("failed-precondition", `a checkpoint ref must carry a nonempty endpoint and token (SPEC 13.6)`);
  const endpoint = (ref as unknown as Record<string, unknown>).endpoint;
  const token = (ref as unknown as Record<string, unknown>).token;
  if (typeof endpoint !== "string" || endpoint.length === 0 || typeof token !== "string" || token.length === 0)
    throw new EpEnvelopeError("failed-precondition", `a checkpoint ref must carry a nonempty endpoint and token (SPEC 13.6)`);
  return Object.freeze({ endpoint, token });
}

/** Detach + validate a caller-supplied goal binding at seam entry (closed shapes, single-read). */
function snapshotGoal(v: unknown): { caller: EpCaller; goalId: string } {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    throw new EpEnvelopeError("failed-precondition", `a checkpoint goal binding must be a {caller, goalId} object (SPEC 13.6)`);
  const o = v as Record<string, unknown>;
  closedKeys(o, ["caller", "goalId"], "a checkpoint goal binding", "failed-precondition");
  const goalId = o.goalId;
  const rawCaller = o.caller;
  if (rawCaller === null || typeof rawCaller !== "object" || Array.isArray(rawCaller) || Object.keys(rawCaller).length !== 3)
    throw new EpEnvelopeError("failed-precondition", `a checkpoint goal binding must carry a closed caller {owner, actor, uid} and a nonempty goalId (SPEC 13.6)`);
  const owner = (rawCaller as Record<string, unknown>).owner;
  const actor = (rawCaller as Record<string, unknown>).actor;
  const uid = (rawCaller as Record<string, unknown>).uid;
  if (typeof owner !== "string" || owner.length === 0
    || typeof actor !== "string" || actor.length === 0
    || typeof uid !== "string" || uid.length === 0
    || typeof goalId !== "string" || goalId.length === 0)
    throw new EpEnvelopeError("failed-precondition", `a checkpoint goal binding must carry a closed caller {owner, actor, uid} and a nonempty goalId (SPEC 13.6)`);
  return Object.freeze({ caller: Object.freeze({ owner, actor, uid }), goalId });
}

/** The persisted shape of one guard obligation (structurally identical to the guard module's
 *  GuardObligation; typed here to keep this module free of a runtime guard dependency). */
export interface CheckpointObligation {
  v: 1;
  space: string;
  requestId: string;
  signer: { keyId: string };
  attenuations: unknown[];
  iat: number;
  exp: number;
  sig: string;
}

/** Validate + DETACH one persisted/incoming obligation (closed schema; the signed artifact's
 *  bytes are carried verbatim — this seam stores and returns them, it never re-verifies: the
 *  gate verified at HOLD time and the mediated record is the custody chain). */
function snapshotObligation(v: unknown, what: string, code: "internal" | "failed-precondition"): CheckpointObligation {
  if (v === null || typeof v !== "object" || Array.isArray(v))
    throw new EpEnvelopeError(code, `${what} is not an object; obligation schemas are closed (SPEC 13.6/13.10)`);
  const o = v as Record<string, unknown>;
  closedKeys(o, ["v", "space", "requestId", "signer", "attenuations", "iat", "exp", "sig"], what, code);
  const signer = o.signer as Record<string, unknown> | null;
  if (o.v !== 1 || typeof o.space !== "string" || o.space.length === 0
    || typeof o.requestId !== "string" || o.requestId.length === 0
    || signer === null || typeof signer !== "object" || Array.isArray(signer) || Object.keys(signer).length !== 1 || typeof signer.keyId !== "string" || signer.keyId.length === 0
    || !Array.isArray(o.attenuations) || o.attenuations.length === 0
    || typeof o.iat !== "number" || !Number.isSafeInteger(o.iat)
    || typeof o.exp !== "number" || !Number.isSafeInteger(o.exp)
    || typeof o.sig !== "string" || o.sig.length === 0)
    throw new EpEnvelopeError(code, `${what} is malformed; a garbled obligation never rides a hold (SPEC 13.6/13.10)`);
  return JSON.parse(JSON.stringify({
    v: 1, space: o.space, requestId: o.requestId, signer: { keyId: signer.keyId },
    attenuations: o.attenuations, iat: o.iat, exp: o.exp, sig: o.sig,
  })) as CheckpointObligation;
}

function parseCpSpec(raw: unknown, ref: CheckpointRef, key: string): CheckpointSpecValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `checkpoint spec ${key} is not an object; garbled state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  closedKeys(o, ["v", "token", "goal", "obligations", "holder", "mintedAt", "initialDeadline"], `checkpoint spec ${key}`, "internal");
  if (o.v !== 1 || o.token !== ref.token || !isHolder(o.holder)
    || typeof o.mintedAt !== "number" || !Number.isSafeInteger(o.mintedAt) || o.mintedAt < 0
    || typeof o.initialDeadline !== "number" || !Number.isSafeInteger(o.initialDeadline) || o.initialDeadline < 0)
    throw new EpEnvelopeError("internal", `checkpoint spec ${key} is malformed or its token disagrees with its subject (SPEC 13.6); garbled state never authorizes`);
  let goal: { caller: EpCaller; goalId: string } | undefined;
  if (o.goal !== undefined) {
    try { goal = snapshotGoal(o.goal); } catch {
      throw new EpEnvelopeError("internal", `checkpoint spec ${key} carries a malformed goal binding; garbled state never authorizes (SPEC 13.6)`);
    }
  }
  let obligations: CheckpointObligation[] | undefined;
  if (o.obligations !== undefined) {
    if (!Array.isArray(o.obligations) || o.obligations.length === 0 || goal === undefined)
      throw new EpEnvelopeError("internal", `checkpoint spec ${key} carries a malformed obligations set (obligations ride a goal-bound hold as a non-empty array); garbled state never authorizes (SPEC 13.6/13.10)`);
    obligations = o.obligations.map((e, i) => snapshotObligation(e, `checkpoint spec ${key} obligations[${i}]`, "internal"));
  }
  // Picked construction: the returned value carries exactly the schema fields, byte-derived.
  return {
    v: 1, token: o.token as string,
    ...(goal !== undefined ? { goal } : {}),
    ...(obligations !== undefined ? { obligations } : {}),
    holder: { id: (o.holder as { id: string }).id, lifecycleUid: (o.holder as { lifecycleUid: string }).lifecycleUid },
    mintedAt: o.mintedAt, initialDeadline: o.initialDeadline,
  };
}

function assertOwnerClock(now: unknown): number {
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0)
    throw new EpEnvelopeError("failed-precondition", `the owner clock must be a non-negative safe integer; got ${JSON.stringify(now)} (a NaN clock would bypass a deadline comparison, SPEC 13.6)`);
  return now;
}

/** The checkpoint STATUS — the SINGLE SETTLEMENT ARBITER. Its KV revision is the one
 *  linearization point heartbeat, resume, and fire all contend on (a settle CAS-es the status
 *  BEFORE deriving the EPF fact, so a stale-generation fire loses to a heartbeat that advanced
 *  the revision). `state` is `waiting` until the ONE settlement; the deadline generation is the
 *  monotonic heartbeat counter and `deadline` is the CURRENT generation's absolute bound. When
 *  settled it carries the settlement details (`settledHolder`/`settledGeneration`/`settledTs`) so
 *  the derived one-use `epf.<e>.cp.<token>` fact is RECONSTRUCTABLE — a crash between the status
 *  CAS and the fact publish is repaired by re-deriving the fact from the settled status. */
export interface CheckpointStatusValue extends Record<string, unknown> {
  state: "waiting" | "resumed" | "expired";
  deadlineGeneration: number;
  deadline: number;
  observedSpecRevision: number;
  settledGeneration?: number;
  settledHolder?: { id: string; lifecycleUid: string };
  settledTs?: number;
}

/** The one-use settlement: resume and expiry race for this single create-only CAS. */
export interface CheckpointSettleFact {
  v: 1;
  token: string;
  settle: "resumed" | "expired";
  generation: number;
  holder?: { id: string; lifecycleUid: string };
  ts: number;
}

function parseSettle(raw: unknown, subject: string, ref: CheckpointRef): CheckpointSettleFact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `checkpoint settle fact on ${subject} is not an object; garbled state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  closedKeys(o, ["v", "token", "settle", "generation", "holder", "ts"], `checkpoint settle fact on ${subject}`, "internal");
  if (o.v !== 1 || o.token !== ref.token || (o.settle !== "resumed" && o.settle !== "expired")
    || typeof o.generation !== "number" || !Number.isSafeInteger(o.generation) || o.generation < 1
    || typeof o.ts !== "number" || !Number.isSafeInteger(o.ts) || o.ts < 0)
    throw new EpEnvelopeError("internal", `checkpoint settle fact on ${subject} is malformed or its token disagrees with its subject (SPEC 13.6); garbled state never authorizes`);
  // Per-settle variant: a RESUMED fact carries the resuming holder; an EXPIRED fact never does
  // (an expiry has no resuming principal; a holder on it would forge resume attribution).
  if (o.settle === "resumed" ? !isHolder(o.holder) : o.holder !== undefined)
    throw new EpEnvelopeError("internal", `checkpoint settle fact on ${subject} violates its ${String(o.settle)} variant (resumed requires the holder; expired forbids one) (SPEC 13.6)`);
  return {
    v: 1, token: o.token as string, settle: o.settle,
    generation: o.generation,
    ...(o.holder !== undefined ? { holder: { id: (o.holder as { id: string }).id, lifecycleUid: (o.holder as { lifecycleUid: string }).lifecycleUid } } : {}),
    ts: o.ts,
  };
}

function parseCpStatus(raw: unknown, key: string): CheckpointStatusValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `checkpoint status ${key} is not an object; garbled state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  closedKeys(o, ["state", "deadlineGeneration", "deadline", "observedSpecRevision", "settledGeneration", "settledHolder", "settledTs"], `checkpoint status ${key}`, "internal");
  if ((o.state !== "waiting" && o.state !== "resumed" && o.state !== "expired")
    || typeof o.deadlineGeneration !== "number" || !Number.isSafeInteger(o.deadlineGeneration) || o.deadlineGeneration < 1
    || typeof o.deadline !== "number" || !Number.isSafeInteger(o.deadline) || o.deadline < 0
    || typeof o.observedSpecRevision !== "number" || !Number.isSafeInteger(o.observedSpecRevision) || o.observedSpecRevision < 1)
    throw new EpEnvelopeError("internal", `checkpoint status ${key} is malformed; garbled state never authorizes (SPEC 13.6)`);
  // Per-state variants: WAITING carries no settlement coordinates; a settled state carries its
  // full settlement (generation + ts, and the holder exactly when RESUMED). A cross-variant
  // record is garbled, never papered over with defaults.
  const settledShape =
    typeof o.settledGeneration === "number" && Number.isSafeInteger(o.settledGeneration) && o.settledGeneration >= 1
    && typeof o.settledTs === "number" && Number.isSafeInteger(o.settledTs) && o.settledTs >= 0;
  if (o.state === "waiting"
    ? (o.settledGeneration !== undefined || o.settledHolder !== undefined || o.settledTs !== undefined)
    : (!settledShape || (o.state === "resumed" ? !isHolder(o.settledHolder) : o.settledHolder !== undefined)))
    throw new EpEnvelopeError("internal", `checkpoint status ${key} violates its ${String(o.state)} variant (settled coordinates are exact, never defaulted) (SPEC 13.6)`);
  // A settlement is the settlement of the CURRENT deadline generation (distsys 8dcad72 M7): the
  // settledGeneration must EQUAL the deadlineGeneration, so `deriveSettleFact` and the one-use
  // `.cp` fact can never publish a settled coordinate that contradicts the generation the
  // checkpoint actually reached. A record naming two different generations is garbled, never split.
  if (o.state !== "waiting" && o.settledGeneration !== o.deadlineGeneration)
    throw new EpEnvelopeError("internal", `checkpoint status ${key} settles generation ${String(o.settledGeneration)} but its deadline generation is ${String(o.deadlineGeneration)}; a settlement is of the current generation (SPEC 13.6)`);
  return {
    state: o.state, deadlineGeneration: o.deadlineGeneration, deadline: o.deadline,
    observedSpecRevision: o.observedSpecRevision,
    ...(o.settledGeneration !== undefined ? { settledGeneration: o.settledGeneration as number } : {}),
    ...(o.settledHolder !== undefined ? { settledHolder: { id: (o.settledHolder as { id: string }).id, lifecycleUid: (o.settledHolder as { lifecycleUid: string }).lifecycleUid } } : {}),
    ...(o.settledTs !== undefined ? { settledTs: o.settledTs as number } : {}),
  };
}

/** Read the checkpoint's current status (`undefined` = unknown token). Fail-closed on DEL. */
export async function readCheckpointStatus(kv: KV, ref: CheckpointRef): Promise<{ value: CheckpointStatusValue; revision: number } | undefined> {
  const key = recordStatusKey(RECORD_KINDS.cp, cpQualifiers(ref));
  const entry = await kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the checkpoint status ${key} carries a ${entry.operation} marker; a deletion never erases a pause - reconcile the store (SPEC 13.6)`);
  return { value: parseCpStatus(JSON.parse(new TextDecoder().decode(entry.value)), key), revision: entry.revision };
}

/** Publish a `.schedule` REQUEST onto the mediated timer plane — the ONLY timer publish an
 *  instance holds (§13.9). Plain bytes, NO scheduling headers (a header would be inert on the
 *  schedules-disabled request stream and the writer rejects it anyway); the mint, the
 *  heartbeat, and the durable reconciler all share exactly this emission, which is what makes
 *  reconciliation over-emission harmless (same `(timerId, generation)` → the writer re-derives
 *  the same `.armed`, a no-op replacement). */
export async function emitScheduleRequest(
  js: JetStreamClient,
  space: string,
  args: { endpoint: string; instanceId: string; epoch: number; token: string; generation: number; deadline: number },
): Promise<void> {
  const subject = eptSubject(space, args.endpoint, args.instanceId, args.epoch, args.token, "schedule");
  const body = { v: 1, timerId: args.token, generation: args.generation, deadline: args.deadline };
  await js.publish(subject, new TextEncoder().encode(JSON.stringify(body)));
}

/** Mint a checkpoint (the commit path, §13.6): the durable token's spec + a `waiting` status
 *  at generation 1 with the MANDATORY deadline, then the `.schedule` request. The record is
 *  durable BEFORE the timer exists; a crash between the two is exactly what the reconciler's
 *  re-emit repairs. */
export async function mintCheckpoint(
  kv: KV,
  js: JetStreamClient,
  space: string,
  args: {
    ref: CheckpointRef; instanceId: string; epoch: number;
    goal?: { caller: EpCaller; goalId: string };
    /** The guard's VERIFIED obligations to persist across the pause (goal-bound holds only);
     *  an empty array is treated as absent. */
    obligations?: CheckpointObligation[];
    /** MANDATORY (§13.6/§13.10): resume is holder-bound; an omitted holder = a bearer token. */
    holder: { id: string; lifecycleUid: string };
    deadline: number; now: number;
  },
): Promise<{ specRevision: number }> {
  // Snapshot the FULL mint input to detached locals at entry: nothing below reads args again.
  const ref = snapshotCpRef(args.ref);
  assertIdToken(ref.token, "checkpoint token");
  const holder = snapshotHolder(args.holder, "a checkpoint holder (resume is holder-bound, never a bearer token)");
  const goal = args.goal !== undefined ? snapshotGoal(args.goal) : undefined;
  let obligations: CheckpointObligation[] | undefined;
  if (args.obligations !== undefined && args.obligations.length > 0) {
    if (goal === undefined)
      throw new EpEnvelopeError("failed-precondition", "checkpoint obligations ride a goal-bound hold; a goal-less checkpoint carries none (SPEC 13.6/13.10)");
    obligations = args.obligations.map((e, i) => snapshotObligation(e, `checkpoint mint obligations[${i}]`, "failed-precondition"));
  }
  const instanceId = args.instanceId;
  const epoch = args.epoch;
  const deadline = args.deadline;
  const now = assertOwnerClock(args.now);
  if (!Number.isSafeInteger(deadline) || deadline <= now)
    throw new EpEnvelopeError("failed-precondition", `a checkpoint deadline is mandatory and must be in the owner's future (deadline ${deadline}, now ${now}); deadlines are the §13.6 contract, never optional`);
  if (deadline > MAX_SCHEDULE_MS)
    throw new EpEnvelopeError("failed-precondition", `a checkpoint deadline ${deadline} exceeds the scheduler's representable range (${MAX_SCHEDULE_MS}); admission rejects a deadline the timer writer could never arm, so a MAX_SAFE deadline never strands a waiting checkpoint unarmable (distsys 8dcad72 M4, SPEC 13.6/13.9)`);
  const spec: CheckpointSpecValue = {
    v: 1, token: ref.token,
    ...(goal !== undefined ? { goal } : {}),
    ...(obligations !== undefined ? { obligations } : {}),
    holder, mintedAt: now, initialDeadline: deadline,
  };
  const specKey = recordSpecKey(RECORD_KINDS.cp, cpQualifiers(ref));
  const statusKey = recordStatusKey(RECORD_KINDS.cp, cpQualifiers(ref));
  // Idempotent-if-identical (the mint is a two-key composite; a crash between spec and status, or
  // a retry, must not strand a spec-only token): create the spec; on a conflict re-read it and
  // require an IDENTICAL spec (a differing spec under the same token is a loud conflict), then
  // ensure the initial `waiting` status exists. The create CAS covers the key's ENTIRE history
  // (createRecordEntry never recreates over a tombstone), so a DELETED spec is a permanent
  // refusal here — a spec-DEL can never rebind the one-use resume holder to a new principal.
  let specRevision: number;
  try {
    specRevision = await createRecordEntry(kv, specKey, spec);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    const existing = await kv.get(specKey);
    if (existing && existing.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `checkpoint "${ref.token}" spec carries a ${existing.operation} marker; a deletion never erases a pause and a re-mint never rebinds its holder - reconcile the store (SPEC 13.6)`);
    if (!existing)
      throw new EpEnvelopeError("conflict", `checkpoint "${ref.token}" spec is not readable after a create conflict; reconcile the store (SPEC 13.6)`);
    const prior = parseCpSpec(JSON.parse(new TextDecoder().decode(existing.value)), ref, specKey);
    if (prior.holder.id !== holder.id || prior.holder.lifecycleUid !== holder.lifecycleUid
      || prior.initialDeadline !== deadline
      || (prior.goal === undefined) !== (goal === undefined)
      || (goal !== undefined && prior.goal !== undefined && (prior.goal.goalId !== goal.goalId
        || prior.goal.caller.owner !== goal.caller.owner || prior.goal.caller.actor !== goal.caller.actor || prior.goal.caller.uid !== goal.caller.uid))
      // The OBLIGATIONS are part of the mint's identity (distsys M1 / freelance HIGH): a retry
      // presenting a different verified set - including absent-vs-present in either direction -
      // is a DIFFERENT intent, and adopting the recorded spec here would silently swap or drop
      // attenuations the gate verified (SPEC 13.6/13.10: MUST-apply).
      || canonicalJson(prior.obligations ?? null) !== canonicalJson(obligations ?? null))
      throw new EpEnvelopeError("conflict", `checkpoint "${ref.token}" already exists with a DIFFERENT spec (holder/goal/deadline/obligations); a token is minted once (SPEC 13.6)`);
    specRevision = existing.revision;
    // The spec's immutable initialDeadline is now the authority for the generation-1 status: a
    // retry that reached here supplied the SAME deadline (the conflict check above), so creating
    // the missing status at `deadline` re-establishes the ORIGINAL intent, never a new one - the
    // crash-before-status window can no longer install a divergent deadline (distsys 8dcad72 M3).
  }
  // A DEL/PURGE marker on the status is a DELETION of one-use settlement state, never absence:
  // recreating over it would re-open a settled one-use checkpoint and let the same holder
  // resume twice. This marker read is only the FAST-PATH refusal (the same fail-closed rule as
  // readCheckpointStatus); the ARBITER is the create below — createRecordEntry's CAS covers the
  // key's entire history, so a delete landing between this read and the create loses THERE, and
  // the conflict path classifies the tombstone. The check-then-create pair carries no race.
  const existingStatus = await kv.get(statusKey);
  if (existingStatus && existingStatus.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${ref.token}" status carries a ${existingStatus.operation} marker; a deletion never erases a pause and a mint never resurrects one - reconcile the store (SPEC 13.6)`);
  let statusValue: CheckpointStatusValue;
  if (!existingStatus) {
    const initial: CheckpointStatusValue = assertStatusValue({ state: "waiting", deadlineGeneration: 1, deadline, observedSpecRevision: specRevision });
    try {
      await createRecordEntry(kv, statusKey, initial);
      statusValue = initial;
    } catch (e) {
      if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
      // The create lost its CAS: either a concurrent mint won (re-read and PROVE the winner —
      // parse + the replay rules below, never assume it) or the key carries a tombstone the
      // fast-path read missed (the race the arbiter exists for) — refuse it fail-closed.
      const won = await kv.get(statusKey);
      if (won && won.operation !== "PUT")
        throw new EpEnvelopeError("failed-precondition", `checkpoint "${ref.token}" status carries a ${won.operation} marker; a deletion never erases a pause and a mint never resurrects one - reconcile the store (SPEC 13.6)`);
      if (!won)
        throw new EpEnvelopeError("conflict", `checkpoint "${ref.token}" status is not readable after a create conflict; reconcile the store (SPEC 13.6)`);
      statusValue = parseCpStatus(JSON.parse(new TextDecoder().decode(won.value)), statusKey);
    }
  } else {
    statusValue = parseCpStatus(JSON.parse(new TextDecoder().decode(existingStatus.value)), statusKey);
  }
  // Replay identity covers the DEADLINE too: a still-initial (generation-1 waiting) status must
  // carry exactly the requested deadline (a differing deadline is a different mint intent). A
  // SETTLED status is never reset and arms nothing. A heartbeat-advanced waiting status is the
  // same live checkpoint; the schedule re-emits at the CURRENT authoritative coordinates, never
  // the caller's, so a replayed mint can repair the mint-crash window without rolling back.
  if (statusValue.state !== "waiting") return { specRevision };
  if (statusValue.deadlineGeneration === 1 && statusValue.deadline !== deadline)
    throw new EpEnvelopeError("conflict", `checkpoint "${ref.token}" already exists with deadline ${statusValue.deadline}; a replayed mint with a different deadline (${deadline}) is a different intent (SPEC 13.6)`);
  await emitScheduleRequest(js, space, { endpoint: ref.endpoint, instanceId, epoch, token: ref.token, generation: statusValue.deadlineGeneration, deadline: statusValue.deadline });
  return { specRevision };
}

/** Reconstruct the one-use `epf.<e>.cp.<token>` fact from a SETTLED status (the status is the
 *  arbiter; the fact is its derived durable copy). A waiting status derives nothing, and the
 *  settled coordinates are EXACT (parseCpStatus enforces the per-state variant) - a missing
 *  coordinate is garbled state, never papered over with a default. */
function deriveSettleFact(ref: CheckpointRef, s: CheckpointStatusValue): CheckpointSettleFact {
  if (s.state === "waiting" || s.settledGeneration === undefined || s.settledTs === undefined
    || (s.state === "resumed") !== (s.settledHolder !== undefined))
    throw new EpEnvelopeError("internal", `checkpoint "${ref.token}" status does not carry a full ${s.state} settlement; garbled state never authorizes (SPEC 13.6)`);
  return {
    v: 1, token: ref.token, settle: s.state === "expired" ? "expired" : "resumed",
    generation: s.settledGeneration,
    ...(s.settledHolder !== undefined ? { holder: { id: s.settledHolder.id, lifecycleUid: s.settledHolder.lifecycleUid } } : {}),
    ts: s.settledTs,
  };
}

/** Canonical settle-fact equality (field-exact, holder included). */
function settleFactsEqual(a: CheckpointSettleFact, b: CheckpointSettleFact): boolean {
  return a.token === b.token && a.settle === b.settle && a.generation === b.generation && a.ts === b.ts
    && (a.holder === undefined) === (b.holder === undefined)
    && (a.holder === undefined || b.holder === undefined
      || (a.holder.id === b.holder.id && a.holder.lifecycleUid === b.holder.lifecycleUid));
}

/** Publish a settled status's derived one-use fact (create-only; idempotent). On a lost CAS the
 *  recorded winner must be READABLE and CANONICALLY EQUAL to the status-derived fact - the
 *  status is the arbiter, so a contradicting or missing winner is a loud `internal`, never
 *  adopted and never fabricated. */
async function ensureSettleFact(kv: KV, js: JetStreamClient, jsm: JetStreamManager, space: string, ref: CheckpointRef, s: CheckpointStatusValue): Promise<CheckpointSettleFact> {
  const fact = deriveSettleFact(ref, s);
  const subject = checkpointSettleSubject(space, ref);
  try {
    const h = natsHeaders(); h.set("Nats-Expected-Last-Subject-Sequence", "0");
    await js.publish(subject, new TextEncoder().encode(JSON.stringify(fact)), { headers: h });
    return fact;
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code !== 10071 && code !== 10164) throw e;
    const winner = await readCheckpointSettle(jsm, space, ref);
    if (winner === undefined)
      throw new EpEnvelopeError("internal", `checkpoint "${ref.token}" settle-fact CAS lost but no winner is readable; reconcile the store (SPEC 13.6)`);
    if (!settleFactsEqual(winner, fact))
      throw new EpEnvelopeError("internal", `checkpoint "${ref.token}" recorded settle fact (${winner.settle} generation ${winner.generation} ts ${winner.ts}) contradicts the status arbiter (${fact.settle} generation ${fact.generation} ts ${fact.ts}); a contradicting winner is never adopted (SPEC 13.6)`);
    return winner;
  }
}

/** The AUTHORITATIVE liveness gate: is this checkpoint settled? The STATUS record is the arbiter
 *  (its revision is the shared settlement coordinate). If settled, this ENSURES the derived
 *  one-use fact exists (repairing a crash between the status CAS and the fact publish) and
 *  returns it. `undefined` iff genuinely still waiting. */
async function settledOrConverge(
  kv: KV, js: JetStreamClient, jsm: JetStreamManager, space: string, ref: CheckpointRef,
): Promise<CheckpointSettleFact | undefined> {
  const status = await readCheckpointStatus(kv, ref);
  if (status === undefined || status.value.state === "waiting") return undefined;
  return ensureSettleFact(kv, js, jsm, space, ref, status.value);
}

/** Heartbeat/extend: gate on the SETTLE FACT first (a settled checkpoint refuses and its
 *  lagging status is converged), then CAS-advance the deadline generation IN STATUS FIRST, then
 *  replace the timer (a new `.schedule` at the new generation — the mediated writer's
 *  same-subject `.armed` publish is the server rollup; the 2.14 atomic stop-plus-publish is NOT
 *  assumed at the 2.12 floor). The generation order is load-bearing: a crash after the CAS and
 *  before the emission leaves a stale-generation timer whose fire NO-OPS at the handler, and the
 *  reconciler re-emits the current generation — never a fire acting on a superseded deadline. */
export async function heartbeatCheckpoint(
  kv: KV,
  js: JetStreamClient,
  jsm: JetStreamManager,
  space: string,
  args: { ref: CheckpointRef; instanceId: string; epoch: number; deadline: number; now: number },
): Promise<CheckpointStatusValue> {
  // Snapshot the FULL operation input to detached locals at entry; nothing below reads args again.
  const ref = snapshotCpRef(args.ref);
  const instanceId = args.instanceId;
  const epoch = args.epoch;
  const deadline = args.deadline;
  const now = assertOwnerClock(args.now);
  const current = await readCheckpointStatus(kv, ref);
  if (current === undefined)
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${ref.token}" is unknown; a heartbeat extends only a minted checkpoint (SPEC 13.6)`);
  const settled = await settledOrConverge(kv, js, jsm, space, ref);
  if (settled !== undefined)
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${ref.token}" is settled ${settled.settle}; a settled checkpoint never extends (SPEC 13.6)`);
  if (current.value.state !== "waiting")
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${ref.token}" is ${current.value.state}; only a waiting checkpoint extends (SPEC 13.6)`);
  // DEADLINE FENCE: a checkpoint at/after its current authoritative deadline is DUE — it must
  // expire, not be revived. A heartbeat only extends a still-live checkpoint (SPEC 13.6).
  if (now >= current.value.deadline)
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${ref.token}" is at/after its deadline ${current.value.deadline} (now ${now}); a due checkpoint expires and cannot be extended (SPEC 13.6)`);
  if (!Number.isSafeInteger(deadline) || deadline <= now)
    throw new EpEnvelopeError("failed-precondition", `the extended deadline must be in the owner's future (deadline ${deadline}, now ${now})`);
  if (deadline > MAX_SCHEDULE_MS)
    throw new EpEnvelopeError("failed-precondition", `the extended deadline ${deadline} exceeds the scheduler's representable range (${MAX_SCHEDULE_MS}); a heartbeat never advances a checkpoint to an unarmable deadline (distsys 8dcad72 M4, SPEC 13.6/13.9)`);
  if (current.value.deadlineGeneration + 1 > Number.MAX_SAFE_INTEGER)
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${ref.token}" generation would overflow; reconcile the store (SPEC 13.6)`);
  const next: CheckpointStatusValue = assertStatusValue({
    state: "waiting", deadlineGeneration: current.value.deadlineGeneration + 1, deadline,
    observedSpecRevision: current.value.observedSpecRevision,
  });
  // The status CAS is the shared coordinate: a concurrent settle CAS-ing the SAME revision loses,
  // so this heartbeat and any fire/resume settlement serialize on the status revision.
  try {
    await updateRecordEntry(kv, recordStatusKey(RECORD_KINDS.cp, cpQualifiers(ref)), next, current.revision);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    throw new EpEnvelopeError("conflict", `checkpoint "${ref.token}" was settled or heartbeat concurrently; re-read and re-decide (SPEC 13.6)`);
  }
  await emitScheduleRequest(js, space, { endpoint: ref.endpoint, instanceId, epoch, token: ref.token, generation: next.deadlineGeneration, deadline });
  return next;
}

// ---- the timer writer's seam (§13.2/§13.9/§13.12) --------------------------------------------

/** Every header that would make bytes scheduling-active — a `.schedule` REQUEST carrying any
 *  of them is REJECTED by the writer (the ADR-51 confused deputy: schedule headers are copied
 *  to the target verbatim, so a header-carrying request could install another instance's
 *  schedule state if the writer ever echoed it). */
const SCHEDULING_HEADERS = ["Nats-Schedule", "Nats-Schedule-Target", "Nats-Schedule-Rollup", "Nats-Scheduler"] as const;

/** The largest ms-epoch the broker's `@at <ISO>` schedule can represent (JS Date's ISO range). */
const MAX_SCHEDULE_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** The timer writer's RESOURCE-ATTESTED context: an OPAQUE token carrying only the ONE space
 *  this writer serves. The broker resources it operates with (the `.armed` publish rail and the
 *  leader-read authority) are derived from ONE connection at construction and live in a
 *  module-private WeakMap keyed by the frozen token — they are not reachable properties, so a
 *  holder of the token cannot rebind the writer's publish rail or its status authority after
 *  construction (`ctx.js = evil` has nothing to assign to), and a hand-assembled look-alike
 *  carries no resources at all (the same containment as the receipt and contract stores). */
export interface TimerWriterContext {
  readonly space: string;
}

interface TimerWriterResources {
  js: JetStreamClient;
  jsm: JetStreamManager;
}

const TIMER_RESOURCES = new WeakMap<TimerWriterContext, TimerWriterResources>();

export async function timerWriterContext(nc: NatsConnection, space: string): Promise<TimerWriterContext> {
  if (nc === null || typeof nc !== "object")
    throw new EpEnvelopeError("failed-precondition", `a timer-writer context requires a NATS connection (SPEC 13.2)`);
  if (typeof space !== "string" || space.length === 0)
    throw new EpEnvelopeError("failed-precondition", `a timer-writer context requires a nonempty space (SPEC 13.2)`);
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const ctx: TimerWriterContext = Object.freeze({ space });
  TIMER_RESOURCES.set(ctx, { js, jsm });
  return ctx;
}

/** Brand check AND resource fetch in one step: only a token minted by {@link timerWriterContext}
 *  has an entry. */
function timerResources(ctx: TimerWriterContext): TimerWriterResources {
  const r = ctx === null || typeof ctx !== "object" ? undefined : TIMER_RESOURCES.get(ctx);
  if (r === undefined)
    throw new EpEnvelopeError("permission-denied", `the timer-writer context was not constructed by timerWriterContext(); a hand-assembled context never attests its resources (SPEC 13.2)`);
  return r;
}

/** Race the fresh-check against the writer's budget: a stuck status authority is a bounded
 *  `unavailable` refusal, never a hung writer. Races `Promise.resolve(p)` unconditionally so a
 *  non-native thenable cannot bypass the deadline. */
async function withStatusBudget<T>(p: Promise<T> | T, budgetMs: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EpEnvelopeError("unavailable", `${what} did not answer within ${budgetMs}ms; the timer writer is bounded and fails closed (SPEC 13.2)`)), budgetMs);
  });
  try { return await Promise.race([Promise.resolve(p), deadline]); } finally { clearTimeout(timer); }
}

/** LEADER-SERVED status read for the writer's fresh-check (distsys 8dcad72 M2): the fence the
 *  arm decision rests on needs read-your-writes against the leader. `kv.get` on the
 *  `allow_direct` records bucket may be FOLLOWER-served and answer a superseded generation —
 *  a fresh-check over that answer would arm exactly the stale deadline the check exists to
 *  discard. Same rule and mechanism as {@link readLastFact}. */
async function readCheckpointStatusLeader(
  jsm: JetStreamManager, space_: string, ref: CheckpointRef,
): Promise<{ value: CheckpointStatusValue; revision: number } | undefined> {
  const key = recordStatusKey(RECORD_KINDS.cp, cpQualifiers(ref));
  const entry = await readRecordLeader(jsm, space_, key);
  return entry === undefined ? undefined : { value: parseCpStatus(entry.value, key), revision: entry.revision };
}

/** The `.armed` subject's current last stream sequence (0 = no armed message), leader-served:
 *  the CAS coordinate of the arm fence below. */
async function readLastArmedSeq(jsm: JetStreamManager, space_: string, armedSubject: string): Promise<number> {
  try {
    const m = await jsm.streams.getMessage(eptStreamName(space_), { last_by_subj: armedSubject });
    return m?.seq ?? 0;
  } catch (e) {
    if ((e as { code?: unknown }).code === 10037) return 0; // no message on the subject
    throw e;
  }
}

/** One FENCED arm of `(generation, deadline)` onto the derived armed/fire subjects — the arm
 *  fence (distsys 8dcad72 HIGH). Order is load-bearing: (1) read the `.armed` subject's last
 *  sequence, (2) prove the authoritative status LEADER-SERVED, (3) publish `.armed` with
 *  `Nats-Expected-Last-Subject-Sequence` pinned to read (1). A publish can then land ONLY if no
 *  other `.armed` landed after this writer's sequence read — and its status proof is newer than
 *  that read — so a DELAYED writer that proved a since-superseded generation cannot replace the
 *  newer schedule: the broker rejects its publish, the bounded retry re-proves the (moved)
 *  status, and the stale coordinate is discarded. The broker orders the fence, never process
 *  timing. A lost CAS with the coordinate still current retries (a competing writer armed the
 *  SAME coordinate — the retry converges on the rollup). */
async function armCoordinate(
  r: TimerWriterResources,
  space_: string,
  parsed: { endpoint: string; instanceId: string; epoch: number; timerId: string },
  want: { generation: number; deadline: number },
  budget: number,
  subject: string,
): Promise<{ armed: boolean; armedSubject?: string; fireSubject?: string; generation?: number; reason?: "stale" | "settled" | "unknown" }> {
  const armedSubject = eptSubject(space_, parsed.endpoint, parsed.instanceId, parsed.epoch, parsed.timerId, "armed");
  const fireSubject = eptSubject(space_, parsed.endpoint, parsed.instanceId, parsed.epoch, parsed.timerId, "fire");
  for (let attempt = 0; attempt < 3; attempt++) {
    const lastSeq = await withStatusBudget(readLastArmedSeq(r.jsm, space_, armedSubject), budget, `the .armed sequence read for ${subject}`);
    const current = await withStatusBudget(
      readCheckpointStatusLeader(r.jsm, space_, { endpoint: parsed.endpoint, token: parsed.timerId }),
      budget, `the status fresh-check for ${subject}`,
    );
    if (current === undefined) return { armed: false, reason: "unknown" };
    if (current.value.state !== "waiting") return { armed: false, reason: "settled" };
    if (current.value.deadlineGeneration !== want.generation || current.value.deadline !== want.deadline)
      return { armed: false, reason: "stale" }; // a heartbeat superseded this coordinate; arming it would roll back the live deadline
    const h = natsHeaders();
    h.set("Nats-Schedule", `@at ${new Date(want.deadline).toISOString()}`);
    h.set("Nats-Schedule-Target", fireSubject);
    h.set("Nats-Expected-Last-Subject-Sequence", String(lastSeq));
    try {
      await r.js.publish(armedSubject, new TextEncoder().encode(JSON.stringify({ v: 1, timerId: parsed.timerId, generation: want.generation, deadline: want.deadline })), { headers: h });
    } catch (e) {
      if (isCasLoss(e)) continue; // a competing .armed landed after the sequence read — re-prove and retry
      throw e;
    }
    return { armed: true, armedSubject, fireSubject, generation: want.generation };
  }
  throw new EpEnvelopeError("conflict", `the .armed subject for ${subject} moved on every fenced attempt; re-deliver the request and retry (SPEC 13.6)`);
}

/** The TIMER WRITER: turn one authenticated `.schedule` request into the authoritative `.armed`
 *  publish. The armed/fire subjects derive from the REQUEST SUBJECT's own tokens (never body
 *  fields); the body must agree with the subject's timerId; any scheduling header on the request
 *  is a loud refusal; a request whose subject space is not the context's space is refused (the
 *  writer's status authority answers for ONE space). The writer FRESH-CHECKS the authoritative
 *  `(generation, deadline)` LEADER-SERVED within a bounded budget and arms ONLY the current
 *  generation under the {@link armCoordinate} broker CAS fence — a stale/delayed request is
 *  DISCARDED (`{ armed: false }`) and a delayed PUBLISH is rejected by the broker itself, so
 *  `.armed` can never roll back to a superseded deadline. A current request re-derives the same
 *  `.armed`; the server rollup makes it an idempotent no-op replacement (what the reconciler's
 *  over-emission rests on). After a successful arm the writer RE-READS the status and, if a
 *  heartbeat advanced it mid-flight, immediately arms the LIVE coordinate (bounded self-heal;
 *  the durable reconciler stays the crash backstop). */
export async function armCheckpointTimer(
  ctx: TimerWriterContext,
  msg: { subject: string; headers?: MsgHdrs; data: Uint8Array },
  opts?: { statusBudgetMs?: number },
): Promise<{ armed: boolean; armedSubject?: string; fireSubject?: string; generation?: number; reason?: "stale" | "settled" | "unknown" }> {
  const resources = timerResources(ctx);
  // Snapshot the FULL request input to detached locals at entry (the subject, the headers ref, and
  // the body bytes are read EXACTLY ONCE, before any parse/space-check/publish): a shifting subject
  // getter must not let the writer parse one coordinate, then space-check, arm, or error against a
  // different one (distsys 8dcad72 M5). Nothing below reads `msg` again.
  const subject = msg.subject;
  const headers = msg.headers;
  const data = new Uint8Array(msg.data); // COPY, not a reference: a caller-controlled header getter invoked in the scheduling-header scan below could otherwise mutate the live msg.data buffer between here and the decode (a Node Buffer/Uint8Array aliases through `const`). new Uint8Array(...) detaches the bytes at entry (distsys 6e8634d M5 re-open, same class as db85c4f).
  if (typeof subject !== "string" || subject.length === 0)
    throw new EpEnvelopeError("failed-precondition", `a .schedule request carries a subject string (SPEC 13.2)`);
  const budget = opts?.statusBudgetMs ?? 5_000;
  if (!Number.isSafeInteger(budget) || budget <= 0)
    throw new EpEnvelopeError("failed-precondition", `statusBudgetMs must be a positive integer; got ${JSON.stringify(opts?.statusBudgetMs)}`);
  for (const h of SCHEDULING_HEADERS)
    if (headers?.get(h))
      throw new EpEnvelopeError("permission-denied", `the .schedule request on ${subject} carries the scheduling header ${h}; a request's headers are inert bytes and the writer rejects them - only the writer's own .armed publish schedules (SPEC 13.2, ADR-51)`);
  const parsed = parseEpSubject(subject);
  if (parsed === null || parsed.plane !== "timer" || parsed.phase !== "schedule")
    throw new EpEnvelopeError("failed-precondition", `${subject} is not a .schedule request subject; the writer arms nothing else (SPEC 13.2)`);
  if (space(subject) !== ctx.space)
    throw new EpEnvelopeError("permission-denied", `the .schedule request on ${subject} is for space "${space(subject)}" but this writer serves "${ctx.space}"; a cross-space fresh-check would answer with the wrong authority (SPEC 13.2)`);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(data)); } catch (e) {
    throw new EpEnvelopeError("failed-precondition", `the .schedule request on ${subject} does not decode as JSON: ${(e as Error).message}`);
  }
  const o = (body ?? {}) as Record<string, unknown>;
  if (o.v !== 1 || o.timerId !== parsed.timerId
    || typeof o.generation !== "number" || !Number.isSafeInteger(o.generation) || o.generation < 1
    || typeof o.deadline !== "number" || !Number.isSafeInteger(o.deadline) || o.deadline < 0 || o.deadline > MAX_SCHEDULE_MS)
    throw new EpEnvelopeError("failed-precondition", `the .schedule request on ${subject} is malformed, its body timerId disagrees with the authenticated subject token, or its deadline is out of the scheduler's date range (SPEC 13.2)`);
  // The FENCED arm: leader-served fresh-check + broker subject-CAS (armCoordinate).
  const result = await armCoordinate(resources, ctx.space, parsed, { generation: o.generation as number, deadline: o.deadline as number }, budget, subject);
  if (!result.armed) return result;
  // POST-PUBLISH SELF-HEAL: if a heartbeat advanced the status while this arm was in flight, the
  // request for the NEW coordinate may itself be delayed — arm the LIVE coordinate now (one
  // bounded pass) instead of leaving the superseded schedule live until that request or the
  // reconciler's next scan lands. A `conflict` here means a competing writer is already arming
  // the live schedule: the winner is observed, never fought.
  const live = await withStatusBudget(
    readCheckpointStatusLeader(resources.jsm, ctx.space, { endpoint: parsed.endpoint, token: parsed.timerId }),
    budget, `the post-publish re-read for ${subject}`,
  );
  if (live !== undefined && live.value.state === "waiting"
    && (live.value.deadlineGeneration !== o.generation || live.value.deadline !== o.deadline)) {
    try {
      await armCoordinate(resources, ctx.space, parsed, { generation: live.value.deadlineGeneration, deadline: live.value.deadline }, budget, subject);
    } catch (e) {
      if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    }
  }
  return result;
}

function space(subject: string): string {
  const parts = subject.split(".");
  if (parts[0] !== "cotal" || parts.length < 3) throw new EpEnvelopeError("internal", `subject ${subject} carries no space prefix`);
  return parts[1];
}

// ---- fire handling + settlement (the endpoint's trusted seam) ---------------------------------

export type CheckpointFireVerdict =
  | { acted: false; reason: "forged-origin" | "stale-generation" | "not-waiting" | "not-due" | "re-armed" }
  | { acted: true; settle: CheckpointSettleFact; won: boolean };

/** Handle one fired timer message: act ONLY on a fire whose broker-authored `Nats-Scheduler`
 *  header equals the exact sibling `.armed` subject (anything else is forged and discarded),
 *  whose `(timerId, generation)` matches the CURRENT waiting status (stale fires no-op: a
 *  heartbeat superseded that deadline), and whose authoritative deadline is due at the
 *  owner's clock. A valid fire EXPIRES the checkpoint by claiming the one-use settle CAS —
 *  where a concurrent resume may have lawfully claimed first: the fire then no-ops observing
 *  it. Expiry fails the checkpoint CLOSED (status `expired`; the paused goal's own terminal
 *  path is the action commit point). */
export async function handleCheckpointFire(
  kv: KV,
  js: JetStreamClient,
  jsm: JetStreamManager,
  space_: string,
  args: {
    ref: CheckpointRef;
    /** The instance/epoch the checkpoint's timer is armed under — bound so a colliding-token
     *  fire for a DIFFERENT instance/epoch can never settle this ref. */
    instanceId: string; epoch: number;
    msg: { subject: string; headers?: MsgHdrs; data: Uint8Array };
    now: number;
  },
): Promise<CheckpointFireVerdict> {
  // Snapshot the FULL operation input to detached locals at entry (subject, header, and body
  // bytes are read exactly once, before any await); nothing below reads args again.
  const ref = snapshotCpRef(args.ref);
  const instanceId = args.instanceId;
  const epoch = args.epoch;
  const now = assertOwnerClock(args.now);
  const subject = args.msg.subject;
  const schedulerHeader = args.msg.headers?.get("Nats-Scheduler");
  const dataBytes = args.msg.data;
  const parsed = parseEpSubject(subject);
  // Bind the FULL resource coordinate (endpoint + instance + epoch + token), not just the token:
  // a valid broker fire for another instance/endpoint sharing this token cannot settle this ref.
  if (parsed === null || parsed.plane !== "timer" || parsed.phase !== "fire"
    || parsed.endpoint !== ref.endpoint || parsed.instanceId !== instanceId
    || parsed.epoch !== epoch || parsed.timerId !== ref.token)
    return { acted: false, reason: "forged-origin" };
  const expectedArmed = eptSubject(space_, parsed.endpoint, parsed.instanceId, parsed.epoch, parsed.timerId, "armed");
  if (schedulerHeader !== expectedArmed)
    return { acted: false, reason: "forged-origin" }; // only the broker's scheduler stamps this header with the schedule's own subject
  let body: Record<string, unknown>;
  try { body = JSON.parse(new TextDecoder().decode(dataBytes)) as Record<string, unknown>; } catch { return { acted: false, reason: "forged-origin" }; }
  const generation = body.generation;
  const settledAlready = await settledOrConverge(kv, js, jsm, space_, ref);
  if (settledAlready !== undefined) return { acted: false, reason: "not-waiting" };
  const status = await readCheckpointStatus(kv, ref);
  if (status === undefined || status.value.state !== "waiting") return { acted: false, reason: "not-waiting" };
  if (generation !== status.value.deadlineGeneration) return { acted: false, reason: "stale-generation" };
  if (now < status.value.deadline) {
    // A genuine broker fire under owner-behind clock skew: re-emit the CURRENT generation's
    // schedule so the deadline is not silently lost (over-emission is idempotent at the writer).
    await emitScheduleRequest(js, space_, { endpoint: ref.endpoint, instanceId, epoch, token: ref.token, generation: status.value.deadlineGeneration, deadline: status.value.deadline });
    return { acted: false, reason: "re-armed" };
  }
  const settled = await settleCheckpoint(kv, js, jsm, space_, { ref, settle: "expired", now, statusEntry: status });
  if (settled.outcome === "stale") return { acted: false, reason: "stale-generation" }; // a heartbeat advanced the generation on the shared status revision
  return { acted: true, settle: settled.fact!, won: settled.outcome === "won" };
}

/** Resume a waiting checkpoint: HOLDER-BOUND (the spec's recorded holder MUST be the
 *  authenticated presenter) and ONE-USE (the status-arbiter CAS is the single settlement). A
 *  resume AT/AFTER the authoritative deadline does NOT claim `resumed` — expiry fails closed, so
 *  it drives/observes the EXPIRED settlement instead. Contends on the status revision with a
 *  concurrent heartbeat/fire: a stale (heartbeat-superseded) attempt retries once. */
export async function resumeCheckpoint(
  kv: KV,
  js: JetStreamClient,
  jsm: JetStreamManager,
  space_: string,
  args: { ref: CheckpointRef; presenter: { id: string; lifecycleUid: string }; now: number },
): Promise<CheckpointSettleFact> {
  // Snapshot the FULL operation input to detached locals at entry; nothing below reads args again.
  const ref = snapshotCpRef(args.ref);
  const presenter = snapshotHolder(args.presenter, "a resume presenter");
  const now = assertOwnerClock(args.now);
  const specKey = recordSpecKey(RECORD_KINDS.cp, cpQualifiers(ref));
  const specEntry = await kv.get(specKey);
  if (!specEntry || specEntry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${ref.token}" is unknown (or its spec carries a deletion marker); resume presents only a minted token (SPEC 13.6)`);
  const spec = parseCpSpec(JSON.parse(new TextDecoder().decode(specEntry.value)), ref, specKey);
  if (spec.holder.id !== presenter.id || spec.holder.lifecycleUid !== presenter.lifecycleUid)
    throw new EpEnvelopeError("permission-denied", `resume of checkpoint "${ref.token}" is holder-bound to ${spec.holder.id}/${spec.holder.lifecycleUid}; the presenter ${presenter.id}/${presenter.lifecycleUid} is not the holder (SPEC 13.10)`);

  for (let attempt = 0; attempt < 2; attempt++) {
    const already = await settledOrConverge(kv, js, jsm, space_, ref);
    if (already !== undefined)
      throw new EpEnvelopeError(already.settle === "resumed" ? "conflict" : "failed-precondition",
        `checkpoint "${ref.token}" is already settled ${already.settle} at ${already.ts}; resume authorization is one-use and expiry fails closed (SPEC 13.6)`);
    const status = await readCheckpointStatus(kv, ref);
    if (status === undefined)
      throw new EpEnvelopeError("failed-precondition", `checkpoint "${ref.token}" has no status; reconcile the store (SPEC 13.6)`);
    if (status.value.state !== "waiting")
      continue; // settled between the two reads — the loop's settledOrConverge will surface it
    // DEADLINE FENCE: at/after the authoritative deadline, resume MUST NOT win — expiry fails
    // closed, so drive the EXPIRED settlement (the caller sees failed-precondition below).
    const settle: "resumed" | "expired" = now >= status.value.deadline ? "expired" : "resumed";
    const settled = await settleCheckpoint(kv, js, jsm, space_, {
      ref, settle, now, statusEntry: status,
      ...(settle === "resumed" ? { holder: presenter } : {}),
    });
    if (settled.outcome === "stale") continue; // a heartbeat advanced the generation — retry once
    if (settled.outcome === "won" && settle === "resumed") return settled.fact!;
    const winner = settled.fact!;
    throw new EpEnvelopeError(winner.settle === "resumed" ? "conflict" : "failed-precondition",
      winner.settle === "resumed"
        ? `checkpoint "${ref.token}" was already resumed at ${winner.ts}; resume authorization is one-use (SPEC 13.6)`
        : `checkpoint "${ref.token}" expired at ${winner.ts}${settle === "expired" ? " (resume after deadline fails closed)" : " before this resume"}; expiry fails the checkpoint closed (SPEC 13.6)`);
  }
  throw new EpEnvelopeError("conflict", `checkpoint "${ref.token}" status moved twice during resume; re-read and re-decide (SPEC 13.6)`);
}

/** Read the recorded settlement (`undefined` = still waiting). */
export async function readCheckpointSettle(jsm: JetStreamManager, space_: string, ref: CheckpointRef): Promise<CheckpointSettleFact | undefined> {
  const subject = checkpointSettleSubject(space_, ref);
  const raw = await readLastFact(jsm, epfStreamName(space_), subject);
  return raw === undefined ? undefined : parseSettle(raw, subject, ref);
}

/** Read the checkpoint's recorded SPEC (`undefined` = unknown token; fail-closed on a deletion
 *  marker). The spec records WHAT the checkpoint pauses (its optional `goal` binding) and WHO
 *  may resume (`holder`) — a caller that must confirm a token pauses THIS goal reads it here. */
export async function readCheckpointSpec(kv: KV, ref: CheckpointRef): Promise<CheckpointSpecValue | undefined> {
  const key = recordSpecKey(RECORD_KINDS.cp, cpQualifiers(ref));
  const entry = await kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the checkpoint spec ${key} carries a ${entry.operation} marker; a deletion never erases a pause - reconcile the store (SPEC 13.6)`);
  return parseCpSpec(JSON.parse(new TextDecoder().decode(entry.value)), ref, key);
}

/** OWNER-forced expiry (§13.6): the pause's owner settles a DUE checkpoint `expired` without a
 *  broker fire — used when the owner already knows the hold deadline passed (a guard-hold
 *  expiry). Idempotent and fail-closed: an already-settled checkpoint returns its recorded
 *  settlement (the owner observes the winner); a still-live checkpoint (`now < deadline`)
 *  REFUSES (only a due checkpoint expires); a stale-generation CAS loss re-reads the winner.
 *  Never resets a settled checkpoint and never fabricates a settlement. */
export async function expireCheckpoint(
  kv: KV,
  js: JetStreamClient,
  jsm: JetStreamManager,
  space_: string,
  args: { ref: CheckpointRef; now: number },
): Promise<CheckpointSettleFact> {
  const ref = snapshotCpRef(args.ref);
  const now = assertOwnerClock(args.now);
  for (let attempt = 0; attempt < 2; attempt++) {
    const already = await settledOrConverge(kv, js, jsm, space_, ref);
    if (already !== undefined) return already; // already settled (resumed or expired) — observe the winner
    const status = await readCheckpointStatus(kv, ref);
    if (status === undefined)
      throw new EpEnvelopeError("failed-precondition", `checkpoint "${ref.token}" is unknown; an owner expiry settles only a minted checkpoint (SPEC 13.6)`);
    if (status.value.state !== "waiting") continue; // settled between the two reads — the loop surfaces it
    if (now < status.value.deadline)
      throw new EpEnvelopeError("failed-precondition", `checkpoint "${ref.token}" is not yet due (deadline ${status.value.deadline}, now ${now}); only a DUE checkpoint is owner-expired (SPEC 13.6)`);
    const settled = await settleCheckpoint(kv, js, jsm, space_, { ref, settle: "expired", now, statusEntry: status });
    if (settled.outcome === "stale") continue; // a heartbeat advanced the generation — retry once
    return settled.fact!;
  }
  throw new EpEnvelopeError("conflict", `checkpoint "${ref.token}" status moved twice during owner expiry; re-read and re-decide (SPEC 13.6)`);
}

/** Settle the checkpoint by CAS-ing the STATUS record (the arbiter) on the exact revision the
 *  caller validated, THEN deriving the one-use fact. The status CAS is the shared coordinate: a
 *  concurrent heartbeat (which CAS-advances the same revision) or a competing settle contends
 *  here, so a stale settler loses. Outcomes:
 *   - `won`: our CAS won → the fact is derived and published;
 *   - `lost`: a competing settle already settled the status → return the WINNER (derived +
 *     ensured); the loser observes it;
 *   - `stale`: the status advanced but is still `waiting` (a heartbeat moved the generation) →
 *     this settler's generation is superseded; the caller (fire) no-ops or (resume) retries. */
async function settleCheckpoint(
  kv: KV,
  js: JetStreamClient,
  jsm: JetStreamManager,
  space_: string,
  args: {
    ref: CheckpointRef; settle: "resumed" | "expired"; now: number;
    statusEntry: { value: CheckpointStatusValue; revision: number };
    holder?: { id: string; lifecycleUid: string };
  },
): Promise<{ outcome: "won" | "lost" | "stale"; fact?: CheckpointSettleFact }> {
  const settledStatus: CheckpointStatusValue = assertStatusValue({
    state: args.settle,
    deadlineGeneration: args.statusEntry.value.deadlineGeneration,
    deadline: args.statusEntry.value.deadline,
    observedSpecRevision: args.statusEntry.value.observedSpecRevision,
    settledGeneration: args.statusEntry.value.deadlineGeneration,
    ...(args.holder !== undefined ? { settledHolder: args.holder } : {}),
    settledTs: args.now,
  });
  try {
    await updateRecordEntry(kv, recordStatusKey(RECORD_KINDS.cp, cpQualifiers(args.ref)), settledStatus, args.statusEntry.revision);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    const now2 = await readCheckpointStatus(kv, args.ref);
    if (now2 === undefined) throw new EpEnvelopeError("internal", `checkpoint "${args.ref.token}" status vanished mid-settle (SPEC 13.6)`);
    if (now2.value.state !== "waiting")
      return { outcome: "lost", fact: await ensureSettleFact(kv, js, jsm, space_, args.ref, now2.value) };
    return { outcome: "stale" }; // a heartbeat advanced the generation; this settler is superseded
  }
  return { outcome: "won", fact: await ensureSettleFact(kv, js, jsm, space_, args.ref, settledStatus) };
}

/** The durable reconciler's re-emission (§13.6): for every genuinely-`waiting` checkpoint the
 *  endpoint owns, re-emit the `.schedule` request at the CURRENT generation. Idempotent at the
 *  writer (same-generation re-arm is a rollup no-op), so over-emission is harmless and a missing
 *  schedule is repaired without observing whether one exists. GATED ON THE SETTLE FACT, not the
 *  status projection: an already-settled checkpoint whose status still lags `waiting` (the
 *  crash window) is converged and NOT re-armed — without this gate the reconciler would re-emit
 *  schedules forever for a settled checkpoint (the C1 timer leak). */
export async function reconcileCheckpointSchedule(
  kv: KV,
  js: JetStreamClient,
  jsm: JetStreamManager,
  space_: string,
  args: { ref: CheckpointRef; instanceId: string; epoch: number },
): Promise<{ reEmitted: boolean; generation?: number }> {
  const ref = snapshotCpRef(args.ref);
  const instanceId = args.instanceId;
  const epoch = args.epoch;
  const status = await readCheckpointStatus(kv, ref);
  if (status === undefined) return { reEmitted: false };
  // The settled gate is settledOrConverge for EVERY state, not a bare status early-return: a
  // SETTLED status whose derived fact is missing (the crash window between the status CAS and
  // the fact publish) is exactly what the durable reconciler must repair - converge ensures the
  // fact exists before this seam declares nothing to do.
  if ((await settledOrConverge(kv, js, jsm, space_, ref)) !== undefined) return { reEmitted: false };
  // Emit from a FRESH authoritative read taken AFTER the settle-gate (distsys 8dcad72 M6): the
  // status may have advanced (a heartbeat CAS-ed a new generation) between the first read above and
  // here. Re-emitting the STALE first-read generation would be discarded by the writer, leaving the
  // LIVE generation unarmed until another scan. Re-read and emit the current generation; a
  // checkpoint that settled or vanished in the meantime re-emits nothing.
  const live = await readCheckpointStatus(kv, ref);
  if (live === undefined || live.value.state !== "waiting") return { reEmitted: false };
  await emitScheduleRequest(js, space_, {
    endpoint: ref.endpoint, instanceId, epoch,
    token: ref.token, generation: live.value.deadlineGeneration, deadline: live.value.deadline,
  });
  return { reEmitted: true, generation: live.value.deadlineGeneration };
}
