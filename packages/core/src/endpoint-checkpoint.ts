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
 *    subject's own tokens, never a body field. A same-`(timerId, generation)` arm re-derives
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
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { headers as natsHeaders, type MsgHdrs } from "@nats-io/transport-node";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { epfSubject, eptSubject, parseEpSubject, assertIdToken, type EpCaller } from "./endpoint-subjects.js";
import { RECORD_KINDS, recordSpecKey, recordStatusKey, createRecordEntry, updateRecordEntry, assertStatusValue } from "./endpoint-records.js";
import { epfStreamName, readLastFact } from "./endpoint-journal.js";

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
  holder: { id: string; lifecycleUid: string };
  mintedAt: number;
}

function isHolder(v: unknown): v is { id: string; lifecycleUid: string } {
  return v !== null && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" && typeof (v as { lifecycleUid?: unknown }).lifecycleUid === "string";
}

function parseCpSpec(raw: unknown, ref: CheckpointRef, key: string): CheckpointSpecValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `checkpoint spec ${key} is not an object; garbled state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || o.token !== ref.token || !isHolder(o.holder) || typeof o.mintedAt !== "number" || !Number.isSafeInteger(o.mintedAt))
    throw new EpEnvelopeError("internal", `checkpoint spec ${key} is malformed or its token disagrees with its subject (SPEC 13.6); garbled state never authorizes`);
  return o as unknown as CheckpointSpecValue;
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
  if (o.v !== 1 || o.token !== ref.token || (o.settle !== "resumed" && o.settle !== "expired")
    || typeof o.generation !== "number" || !Number.isSafeInteger(o.generation) || o.generation < 1
    || typeof o.ts !== "number" || !Number.isSafeInteger(o.ts)
    || (o.holder !== undefined && !isHolder(o.holder)))
    throw new EpEnvelopeError("internal", `checkpoint settle fact on ${subject} is malformed or its token disagrees with its subject (SPEC 13.6); garbled state never authorizes`);
  return raw as CheckpointSettleFact;
}

function parseCpStatus(raw: unknown, key: string): CheckpointStatusValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `checkpoint status ${key} is not an object; garbled state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  if ((o.state !== "waiting" && o.state !== "resumed" && o.state !== "expired")
    || typeof o.deadlineGeneration !== "number" || !Number.isSafeInteger(o.deadlineGeneration) || o.deadlineGeneration < 1
    || typeof o.deadline !== "number" || !Number.isSafeInteger(o.deadline)
    || typeof o.observedSpecRevision !== "number"
    || (o.settledGeneration !== undefined && (typeof o.settledGeneration !== "number" || !Number.isSafeInteger(o.settledGeneration) || o.settledGeneration < 1))
    || (o.settledTs !== undefined && (typeof o.settledTs !== "number" || !Number.isSafeInteger(o.settledTs)))
    || (o.settledHolder !== undefined && !isHolder(o.settledHolder)))
    throw new EpEnvelopeError("internal", `checkpoint status ${key} is malformed; garbled state never authorizes (SPEC 13.6)`);
  return o as CheckpointStatusValue;
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
    /** MANDATORY (§13.6/§13.10): resume is holder-bound; an omitted holder = a bearer token. */
    holder: { id: string; lifecycleUid: string };
    deadline: number; now: number;
  },
): Promise<{ specRevision: number }> {
  assertIdToken(args.ref.token, "checkpoint token");
  const now = assertOwnerClock(args.now);
  if (!isHolder(args.holder))
    throw new EpEnvelopeError("failed-precondition", `a checkpoint requires a holder {id, lifecycleUid}: resume is holder-bound, never a bearer token (SPEC 13.6/13.10)`);
  if (!Number.isSafeInteger(args.deadline) || args.deadline <= now)
    throw new EpEnvelopeError("failed-precondition", `a checkpoint deadline is mandatory and must be in the owner's future (deadline ${args.deadline}, now ${now}); deadlines are the §13.6 contract, never optional`);
  const spec: CheckpointSpecValue = {
    v: 1, token: args.ref.token,
    ...(args.goal !== undefined ? { goal: args.goal } : {}),
    holder: args.holder, mintedAt: now,
  };
  const specKey = recordSpecKey(RECORD_KINDS.cp, cpQualifiers(args.ref));
  const statusKey = recordStatusKey(RECORD_KINDS.cp, cpQualifiers(args.ref));
  // Idempotent-if-identical (the mint is a two-key composite; a crash between spec and status, or
  // a retry, must not strand a spec-only token): create the spec; on a conflict re-read it and
  // require an IDENTICAL spec (a differing spec under the same token is a loud conflict), then
  // ensure the initial `waiting` status exists.
  let specRevision: number;
  try {
    specRevision = await createRecordEntry(kv, specKey, spec);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    const existing = await kv.get(specKey);
    if (!existing || existing.operation !== "PUT")
      throw new EpEnvelopeError("conflict", `checkpoint "${args.ref.token}" spec is not readable after a create conflict; reconcile the store (SPEC 13.6)`);
    const prior = parseCpSpec(JSON.parse(new TextDecoder().decode(existing.value)), args.ref, specKey);
    if (prior.holder.id !== spec.holder.id || prior.holder.lifecycleUid !== spec.holder.lifecycleUid || JSON.stringify(prior.goal) !== JSON.stringify(spec.goal))
      throw new EpEnvelopeError("conflict", `checkpoint "${args.ref.token}" already exists with a DIFFERENT spec (holder/goal); a token is minted once (SPEC 13.6)`);
    specRevision = existing.revision;
  }
  const existingStatus = await kv.get(statusKey);
  if (!existingStatus || existingStatus.operation !== "PUT") {
    try {
      await createRecordEntry(kv, statusKey, assertStatusValue({ state: "waiting", deadlineGeneration: 1, deadline: args.deadline, observedSpecRevision: specRevision }));
    } catch (e) { if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e; /* a concurrent mint created it */ }
  }
  await emitScheduleRequest(js, space, { endpoint: args.ref.endpoint, instanceId: args.instanceId, epoch: args.epoch, token: args.ref.token, generation: 1, deadline: args.deadline });
  return { specRevision };
}

/** Reconstruct the one-use `epf.<e>.cp.<token>` fact from a SETTLED status (the status is the
 *  arbiter; the fact is its derived durable copy). */
function deriveSettleFact(ref: CheckpointRef, s: CheckpointStatusValue): CheckpointSettleFact {
  return {
    v: 1, token: ref.token, settle: s.state === "expired" ? "expired" : "resumed",
    generation: s.settledGeneration ?? s.deadlineGeneration,
    ...(s.settledHolder !== undefined ? { holder: s.settledHolder } : {}), ts: s.settledTs ?? 0,
  };
}

/** Publish a settled status's derived one-use fact (create-only; idempotent). */
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
    return winner ?? fact; // the fact already exists (byte-consistent, derived from the same status)
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
  const now = assertOwnerClock(args.now);
  const current = await readCheckpointStatus(kv, args.ref);
  if (current === undefined)
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${args.ref.token}" is unknown; a heartbeat extends only a minted checkpoint (SPEC 13.6)`);
  const settled = await settledOrConverge(kv, js, jsm, space, args.ref);
  if (settled !== undefined)
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${args.ref.token}" is settled ${settled.settle}; a settled checkpoint never extends (SPEC 13.6)`);
  if (current.value.state !== "waiting")
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${args.ref.token}" is ${current.value.state}; only a waiting checkpoint extends (SPEC 13.6)`);
  // DEADLINE FENCE: a checkpoint at/after its current authoritative deadline is DUE — it must
  // expire, not be revived. A heartbeat only extends a still-live checkpoint (SPEC 13.6).
  if (now >= current.value.deadline)
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${args.ref.token}" is at/after its deadline ${current.value.deadline} (now ${now}); a due checkpoint expires and cannot be extended (SPEC 13.6)`);
  if (!Number.isSafeInteger(args.deadline) || args.deadline <= now)
    throw new EpEnvelopeError("failed-precondition", `the extended deadline must be in the owner's future (deadline ${args.deadline}, now ${now})`);
  if (current.value.deadlineGeneration + 1 > Number.MAX_SAFE_INTEGER)
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${args.ref.token}" generation would overflow; reconcile the store (SPEC 13.6)`);
  const next: CheckpointStatusValue = assertStatusValue({
    state: "waiting", deadlineGeneration: current.value.deadlineGeneration + 1, deadline: args.deadline,
    observedSpecRevision: current.value.observedSpecRevision,
  });
  // The status CAS is the shared coordinate: a concurrent settle CAS-ing the SAME revision loses,
  // so this heartbeat and any fire/resume settlement serialize on the status revision.
  try {
    await updateRecordEntry(kv, recordStatusKey(RECORD_KINDS.cp, cpQualifiers(args.ref)), next, current.revision);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    throw new EpEnvelopeError("conflict", `checkpoint "${args.ref.token}" was settled or heartbeat concurrently; re-read and re-decide (SPEC 13.6)`);
  }
  await emitScheduleRequest(js, space, { endpoint: args.ref.endpoint, instanceId: args.instanceId, epoch: args.epoch, token: args.ref.token, generation: next.deadlineGeneration, deadline: args.deadline });
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

/** The timer writer's FRESH-CHECK seam (§13.9): read the checkpoint's CURRENT authoritative
 *  `(deadlineGeneration, deadline)` from the records KV. The writer arms ONLY a request whose
 *  generation+deadline match the current status; a delayed/redelivered stale-generation request
 *  is DISCARDED, never armed (otherwise a same-subject rollup could roll `.armed` back to a
 *  superseded generation and silently lose the live deadline). */
export type CheckpointStatusResolver = (ref: CheckpointRef) => Promise<{ deadlineGeneration: number; deadline: number; state: "waiting" | "resumed" | "expired" } | undefined> | { deadlineGeneration: number; deadline: number; state: "waiting" | "resumed" | "expired" } | undefined;

/** A ready-made resolver over a records KV. */
export function checkpointStatusResolver(kv: KV): CheckpointStatusResolver {
  return async (ref) => {
    const s = await readCheckpointStatus(kv, ref);
    return s === undefined ? undefined : { deadlineGeneration: s.value.deadlineGeneration, deadline: s.value.deadline, state: s.value.state };
  };
}

/** The TIMER WRITER: turn one authenticated `.schedule` request into the authoritative `.armed`
 *  publish. The armed/fire subjects derive from the REQUEST SUBJECT's own tokens (never body
 *  fields); the body must agree with the subject's timerId; any scheduling header on the request
 *  is a loud refusal. The writer FRESH-CHECKS the authoritative `(generation, deadline)` via
 *  `resolveStatus` and arms ONLY the current generation — a stale/delayed request is DISCARDED
 *  (`{ armed: false }`), so a rollup can never roll `.armed` back to a superseded deadline. A
 *  current request re-derives the same `.armed`; the server rollup makes it an idempotent no-op
 *  replacement (what the reconciler's over-emission rests on). */
export async function armCheckpointTimer(
  js: JetStreamClient,
  msg: { subject: string; headers?: MsgHdrs; data: Uint8Array },
  resolveStatus: CheckpointStatusResolver,
): Promise<{ armed: boolean; armedSubject?: string; fireSubject?: string; generation?: number; reason?: "stale" | "settled" | "unknown" }> {
  for (const h of SCHEDULING_HEADERS)
    if (msg.headers?.get(h))
      throw new EpEnvelopeError("permission-denied", `the .schedule request on ${msg.subject} carries the scheduling header ${h}; a request's headers are inert bytes and the writer rejects them - only the writer's own .armed publish schedules (SPEC 13.2, ADR-51)`);
  const parsed = parseEpSubject(msg.subject);
  if (parsed === null || parsed.plane !== "timer" || parsed.phase !== "schedule")
    throw new EpEnvelopeError("failed-precondition", `${msg.subject} is not a .schedule request subject; the writer arms nothing else (SPEC 13.2)`);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(msg.data)); } catch (e) {
    throw new EpEnvelopeError("failed-precondition", `the .schedule request on ${msg.subject} does not decode as JSON: ${(e as Error).message}`);
  }
  const o = (body ?? {}) as Record<string, unknown>;
  if (o.v !== 1 || o.timerId !== parsed.timerId
    || typeof o.generation !== "number" || !Number.isSafeInteger(o.generation) || o.generation < 1
    || typeof o.deadline !== "number" || !Number.isSafeInteger(o.deadline) || o.deadline < 0 || o.deadline > MAX_SCHEDULE_MS)
    throw new EpEnvelopeError("failed-precondition", `the .schedule request on ${msg.subject} is malformed, its body timerId disagrees with the authenticated subject token, or its deadline is out of the scheduler's date range (SPEC 13.2)`);
  // FRESH-CHECK: arm only the current generation/deadline; discard a stale or settled request.
  const current = await resolveStatus({ endpoint: parsed.endpoint, token: parsed.timerId });
  if (current === undefined) return { armed: false, reason: "unknown" };
  if (current.state !== "waiting") return { armed: false, reason: "settled" };
  if (current.deadlineGeneration !== o.generation || current.deadline !== o.deadline)
    return { armed: false, reason: "stale" }; // a heartbeat superseded this request; arming it would roll back the live deadline
  const armedSubject = eptSubject(space(msg.subject), parsed.endpoint, parsed.instanceId, parsed.epoch, parsed.timerId, "armed");
  const fireSubject = eptSubject(space(msg.subject), parsed.endpoint, parsed.instanceId, parsed.epoch, parsed.timerId, "fire");
  const h = natsHeaders();
  h.set("Nats-Schedule", `@at ${new Date(o.deadline as number).toISOString()}`);
  h.set("Nats-Schedule-Target", fireSubject);
  await js.publish(armedSubject, new TextEncoder().encode(JSON.stringify({ v: 1, timerId: parsed.timerId, generation: o.generation, deadline: o.deadline })), { headers: h });
  return { armed: true, armedSubject, fireSubject, generation: o.generation as number };
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
  const now = assertOwnerClock(args.now);
  const parsed = parseEpSubject(args.msg.subject);
  // Bind the FULL resource coordinate (endpoint + instance + epoch + token), not just the token:
  // a valid broker fire for another instance/endpoint sharing this token cannot settle this ref.
  if (parsed === null || parsed.plane !== "timer" || parsed.phase !== "fire"
    || parsed.endpoint !== args.ref.endpoint || parsed.instanceId !== args.instanceId
    || parsed.epoch !== args.epoch || parsed.timerId !== args.ref.token)
    return { acted: false, reason: "forged-origin" };
  const expectedArmed = eptSubject(space_, parsed.endpoint, parsed.instanceId, parsed.epoch, parsed.timerId, "armed");
  if (args.msg.headers?.get("Nats-Scheduler") !== expectedArmed)
    return { acted: false, reason: "forged-origin" }; // only the broker's scheduler stamps this header with the schedule's own subject
  let body: Record<string, unknown>;
  try { body = JSON.parse(new TextDecoder().decode(args.msg.data)) as Record<string, unknown>; } catch { return { acted: false, reason: "forged-origin" }; }
  const settledAlready = await settledOrConverge(kv, js, jsm, space_, args.ref);
  if (settledAlready !== undefined) return { acted: false, reason: "not-waiting" };
  const status = await readCheckpointStatus(kv, args.ref);
  if (status === undefined || status.value.state !== "waiting") return { acted: false, reason: "not-waiting" };
  if (body.generation !== status.value.deadlineGeneration) return { acted: false, reason: "stale-generation" };
  if (now < status.value.deadline) {
    // A genuine broker fire under owner-behind clock skew: re-emit the CURRENT generation's
    // schedule so the deadline is not silently lost (over-emission is idempotent at the writer).
    await emitScheduleRequest(js, space_, { endpoint: args.ref.endpoint, instanceId: args.instanceId, epoch: args.epoch, token: args.ref.token, generation: status.value.deadlineGeneration, deadline: status.value.deadline });
    return { acted: false, reason: "re-armed" };
  }
  const settled = await settleCheckpoint(kv, js, jsm, space_, { ref: args.ref, settle: "expired", now, statusEntry: status });
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
  const now = assertOwnerClock(args.now);
  const specKey = recordSpecKey(RECORD_KINDS.cp, cpQualifiers(args.ref));
  const specEntry = await kv.get(specKey);
  if (!specEntry || specEntry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${args.ref.token}" is unknown (or its spec carries a deletion marker); resume presents only a minted token (SPEC 13.6)`);
  const spec = parseCpSpec(JSON.parse(new TextDecoder().decode(specEntry.value)), args.ref, specKey);
  if (spec.holder.id !== args.presenter.id || spec.holder.lifecycleUid !== args.presenter.lifecycleUid)
    throw new EpEnvelopeError("permission-denied", `resume of checkpoint "${args.ref.token}" is holder-bound to ${spec.holder.id}/${spec.holder.lifecycleUid}; the presenter ${args.presenter.id}/${args.presenter.lifecycleUid} is not the holder (SPEC 13.10)`);

  for (let attempt = 0; attempt < 2; attempt++) {
    const already = await settledOrConverge(kv, js, jsm, space_, args.ref);
    if (already !== undefined)
      throw new EpEnvelopeError(already.settle === "resumed" ? "conflict" : "failed-precondition",
        `checkpoint "${args.ref.token}" is already settled ${already.settle} at ${already.ts}; resume authorization is one-use and expiry fails closed (SPEC 13.6)`);
    const status = await readCheckpointStatus(kv, args.ref);
    if (status === undefined)
      throw new EpEnvelopeError("failed-precondition", `checkpoint "${args.ref.token}" has no status; reconcile the store (SPEC 13.6)`);
    if (status.value.state !== "waiting")
      continue; // settled between the two reads — the loop's settledOrConverge will surface it
    // DEADLINE FENCE: at/after the authoritative deadline, resume MUST NOT win — expiry fails
    // closed, so drive the EXPIRED settlement (the caller sees failed-precondition below).
    const settle: "resumed" | "expired" = now >= status.value.deadline ? "expired" : "resumed";
    const settled = await settleCheckpoint(kv, js, jsm, space_, {
      ref: args.ref, settle, now, statusEntry: status,
      ...(settle === "resumed" ? { holder: args.presenter } : {}),
    });
    if (settled.outcome === "stale") continue; // a heartbeat advanced the generation — retry once
    if (settled.outcome === "won" && settle === "resumed") return settled.fact!;
    const winner = settled.fact!;
    throw new EpEnvelopeError(winner.settle === "resumed" ? "conflict" : "failed-precondition",
      winner.settle === "resumed"
        ? `checkpoint "${args.ref.token}" was already resumed at ${winner.ts}; resume authorization is one-use (SPEC 13.6)`
        : `checkpoint "${args.ref.token}" expired at ${winner.ts}${settle === "expired" ? " (resume after deadline fails closed)" : " before this resume"}; expiry fails the checkpoint closed (SPEC 13.6)`);
  }
  throw new EpEnvelopeError("conflict", `checkpoint "${args.ref.token}" status moved twice during resume; re-read and re-decide (SPEC 13.6)`);
}

/** Read the recorded settlement (`undefined` = still waiting). */
export async function readCheckpointSettle(jsm: JetStreamManager, space_: string, ref: CheckpointRef): Promise<CheckpointSettleFact | undefined> {
  const subject = checkpointSettleSubject(space_, ref);
  const raw = await readLastFact(jsm, epfStreamName(space_), subject);
  return raw === undefined ? undefined : parseSettle(raw, subject, ref);
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
  const status = await readCheckpointStatus(kv, args.ref);
  if (status === undefined || status.value.state !== "waiting") return { reEmitted: false };
  if ((await settledOrConverge(kv, js, jsm, space_, args.ref)) !== undefined) return { reEmitted: false };
  await emitScheduleRequest(js, space_, {
    endpoint: args.ref.endpoint, instanceId: args.instanceId, epoch: args.epoch,
    token: args.ref.token, generation: status.value.deadlineGeneration, deadline: status.value.deadline,
  });
  return { reEmitted: true, generation: status.value.deadlineGeneration };
}
