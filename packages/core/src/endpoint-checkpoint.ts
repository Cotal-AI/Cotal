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

/** The checkpoint SPEC (written once at mint): what is paused and who may resume. `holder`,
 *  when present, binds resume to that principal (§13.10 holder-binding; the deep signature
 *  verification is the capability-handle slice — this seam enforces the recorded identity). */
export interface CheckpointSpecValue {
  v: 1;
  token: string;
  /** The paused goal (per-goal `waiting` status carries the mirror coordinate). */
  goal?: { caller: EpCaller; goalId: string };
  holder?: { id: string; lifecycleUid: string };
  mintedAt: number;
}

/** The checkpoint STATUS: `waiting` until the ONE settlement; the deadline generation is the
 *  monotonic heartbeat counter, and `deadline` is the CURRENT generation's absolute bound. */
export interface CheckpointStatusValue extends Record<string, unknown> {
  state: "waiting" | "resumed" | "expired";
  deadlineGeneration: number;
  deadline: number;
  observedSpecRevision: number;
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

function parseSettle(raw: unknown, subject: string): CheckpointSettleFact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `checkpoint settle fact on ${subject} is not an object; garbled state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.token !== "string" || (o.settle !== "resumed" && o.settle !== "expired")
    || typeof o.generation !== "number" || typeof o.ts !== "number")
    throw new EpEnvelopeError("internal", `checkpoint settle fact on ${subject} is malformed; garbled state never authorizes (SPEC 13.6)`);
  return raw as CheckpointSettleFact;
}

function parseCpStatus(raw: unknown, key: string): CheckpointStatusValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `checkpoint status ${key} is not an object; garbled state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  if ((o.state !== "waiting" && o.state !== "resumed" && o.state !== "expired")
    || typeof o.deadlineGeneration !== "number" || !Number.isSafeInteger(o.deadlineGeneration) || o.deadlineGeneration < 1
    || typeof o.deadline !== "number" || !Number.isSafeInteger(o.deadline)
    || typeof o.observedSpecRevision !== "number")
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
    holder?: { id: string; lifecycleUid: string };
    deadline: number; now: number;
  },
): Promise<{ specRevision: number }> {
  assertIdToken(args.ref.token, "checkpoint token");
  if (!Number.isSafeInteger(args.deadline) || args.deadline <= args.now)
    throw new EpEnvelopeError("failed-precondition", `a checkpoint deadline is mandatory and must be in the owner's future (deadline ${args.deadline}, now ${args.now}); deadlines are the §13.6 contract, never optional`);
  const spec: CheckpointSpecValue = {
    v: 1, token: args.ref.token,
    ...(args.goal !== undefined ? { goal: args.goal } : {}),
    ...(args.holder !== undefined ? { holder: args.holder } : {}),
    mintedAt: args.now,
  };
  const specRevision = await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.cp, cpQualifiers(args.ref)), spec);
  await createRecordEntry(kv, recordStatusKey(RECORD_KINDS.cp, cpQualifiers(args.ref)),
    assertStatusValue({ state: "waiting", deadlineGeneration: 1, deadline: args.deadline, observedSpecRevision: specRevision }));
  await emitScheduleRequest(js, space, { endpoint: args.ref.endpoint, instanceId: args.instanceId, epoch: args.epoch, token: args.ref.token, generation: 1, deadline: args.deadline });
  return { specRevision };
}

/** The AUTHORITATIVE liveness gate for the pause primitive: is this checkpoint still open? The
 *  ONE-USE settle FACT is the truth (its create-only CAS is the single settlement), NOT the
 *  status projection — a projection can lag or be lost after the fact wins (the acknowledged
 *  crash window between {@link settleCheckpoint}'s CAS and its status update). So heartbeat,
 *  reconcile, and resume all gate on the fact, and this helper CONVERGES a lagging `waiting`
 *  status to the fact's disposition when it finds one, so the projection is repaired at every
 *  liveness touch instead of leaking timers forever against an already-settled checkpoint.
 *  Returns the settled fact iff the checkpoint is settled (the caller then refuses/converges);
 *  `undefined` iff genuinely still waiting. */
async function settledOrConverge(
  kv: KV, jsm: JetStreamManager, space: string, ref: CheckpointRef,
): Promise<CheckpointSettleFact | undefined> {
  const settled = await readCheckpointSettle(jsm, space, ref);
  if (settled === undefined) return undefined;
  const status = await readCheckpointStatus(kv, ref);
  if (status !== undefined && status.value.state === "waiting") {
    // Repair the lagging projection to match the fact (idempotent: a CAS loss means a
    // concurrent converge already landed — the fact stays the truth either way).
    const next: CheckpointStatusValue = assertStatusValue({
      state: settled.settle, deadlineGeneration: status.value.deadlineGeneration,
      deadline: status.value.deadline, observedSpecRevision: status.value.observedSpecRevision,
    });
    try { await updateRecordEntry(kv, recordStatusKey(RECORD_KINDS.cp, cpQualifiers(ref)), next, status.revision); }
    catch (e) { if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e; }
  }
  return settled;
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
  const current = await readCheckpointStatus(kv, args.ref);
  if (current === undefined)
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${args.ref.token}" is unknown; a heartbeat extends only a minted checkpoint (SPEC 13.6)`);
  const settled = await settledOrConverge(kv, jsm, space, args.ref);
  if (settled !== undefined)
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${args.ref.token}" is settled ${settled.settle} (the one-use settle fact is the truth, not the status projection); a settled checkpoint never extends and its lagging status is converged (SPEC 13.6)`);
  if (current.value.state !== "waiting")
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${args.ref.token}" is ${current.value.state}; only a waiting checkpoint extends (SPEC 13.6)`);
  if (!Number.isSafeInteger(args.deadline) || args.deadline <= args.now)
    throw new EpEnvelopeError("failed-precondition", `the extended deadline must be in the owner's future (deadline ${args.deadline}, now ${args.now})`);
  const next: CheckpointStatusValue = assertStatusValue({
    state: "waiting", deadlineGeneration: current.value.deadlineGeneration + 1, deadline: args.deadline,
    observedSpecRevision: current.value.observedSpecRevision,
  });
  await updateRecordEntry(kv, recordStatusKey(RECORD_KINDS.cp, cpQualifiers(args.ref)), next, current.revision);
  await emitScheduleRequest(js, space, { endpoint: args.ref.endpoint, instanceId: args.instanceId, epoch: args.epoch, token: args.ref.token, generation: next.deadlineGeneration, deadline: args.deadline });
  return next;
}

// ---- the timer writer's seam (§13.2/§13.9/§13.12) --------------------------------------------

/** Every header that would make bytes scheduling-active — a `.schedule` REQUEST carrying any
 *  of them is REJECTED by the writer (the ADR-51 confused deputy: schedule headers are copied
 *  to the target verbatim, so a header-carrying request could install another instance's
 *  schedule state if the writer ever echoed it). */
const SCHEDULING_HEADERS = ["Nats-Schedule", "Nats-Schedule-Target", "Nats-Schedule-Rollup", "Nats-Scheduler"] as const;

/** The TIMER WRITER: turn one authenticated `.schedule` request into the authoritative
 *  `.armed` publish. The armed/fire subjects derive from the REQUEST SUBJECT's own tokens
 *  (never body fields); the body must agree with the subject's timerId; any scheduling header
 *  on the request is a loud refusal. A same-`(timerId, generation)` request re-derives the
 *  same `.armed` — the server rollup makes the duplicate a no-op replacement, which is the
 *  idempotence the durable reconciler's over-emission rests on. */
export async function armCheckpointTimer(
  js: JetStreamClient,
  msg: { subject: string; headers?: MsgHdrs; data: Uint8Array },
): Promise<{ armedSubject: string; fireSubject: string; generation: number }> {
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
    || typeof o.deadline !== "number" || !Number.isSafeInteger(o.deadline) || o.deadline < 0)
    throw new EpEnvelopeError("failed-precondition", `the .schedule request on ${msg.subject} is malformed or its body timerId disagrees with the authenticated subject token (SPEC 13.2: subject wins, a disagreeing body is refused)`);
  const armedSubject = eptSubject(space(msg.subject), parsed.endpoint, parsed.instanceId, parsed.epoch, parsed.timerId, "armed");
  const fireSubject = eptSubject(space(msg.subject), parsed.endpoint, parsed.instanceId, parsed.epoch, parsed.timerId, "fire");
  const h = natsHeaders();
  h.set("Nats-Schedule", `@at ${new Date(o.deadline as number).toISOString()}`);
  h.set("Nats-Schedule-Target", fireSubject);
  await js.publish(armedSubject, new TextEncoder().encode(JSON.stringify({ v: 1, timerId: parsed.timerId, generation: o.generation, deadline: o.deadline })), { headers: h });
  return { armedSubject, fireSubject, generation: o.generation as number };
}

function space(subject: string): string {
  const parts = subject.split(".");
  if (parts[0] !== "cotal" || parts.length < 3) throw new EpEnvelopeError("internal", `subject ${subject} carries no space prefix`);
  return parts[1];
}

// ---- fire handling + settlement (the endpoint's trusted seam) ---------------------------------

export type CheckpointFireVerdict =
  | { acted: false; reason: "forged-origin" | "stale-generation" | "not-waiting" | "not-due" }
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
    msg: { subject: string; headers?: MsgHdrs; data: Uint8Array };
    now: number;
  },
): Promise<CheckpointFireVerdict> {
  const parsed = parseEpSubject(args.msg.subject);
  if (parsed === null || parsed.plane !== "timer" || parsed.phase !== "fire" || parsed.timerId !== args.ref.token)
    return { acted: false, reason: "forged-origin" };
  const expectedArmed = eptSubject(space_, parsed.endpoint, parsed.instanceId, parsed.epoch, parsed.timerId, "armed");
  if (args.msg.headers?.get("Nats-Scheduler") !== expectedArmed)
    return { acted: false, reason: "forged-origin" }; // only the broker's scheduler stamps this header with the schedule's own subject
  let body: Record<string, unknown>;
  try { body = JSON.parse(new TextDecoder().decode(args.msg.data)) as Record<string, unknown>; } catch { return { acted: false, reason: "forged-origin" }; }
  const status = await readCheckpointStatus(kv, args.ref);
  if (status === undefined || status.value.state !== "waiting") return { acted: false, reason: "not-waiting" };
  if (body.generation !== status.value.deadlineGeneration) return { acted: false, reason: "stale-generation" };
  if (args.now < status.value.deadline) return { acted: false, reason: "not-due" };
  const settled = await settleCheckpoint(kv, js, jsm, space_, { ref: args.ref, settle: "expired", generation: status.value.deadlineGeneration, now: args.now, statusEntry: status });
  return { acted: true, settle: settled.fact, won: settled.won };
}

/** Resume a waiting checkpoint: HOLDER-BOUND (the spec's recorded holder must be the
 *  authenticated presenter) and ONE-USE — the create-only settle CAS is the authorization's
 *  single use; a duplicate resume is `conflict` with the recorded settlement, and a resume
 *  racing the deadline expiry observes whichever claimed first (expiry fails closed). */
export async function resumeCheckpoint(
  kv: KV,
  js: JetStreamClient,
  jsm: JetStreamManager,
  space_: string,
  args: { ref: CheckpointRef; presenter: { id: string; lifecycleUid: string }; now: number },
): Promise<CheckpointSettleFact> {
  const specKey = recordSpecKey(RECORD_KINDS.cp, cpQualifiers(args.ref));
  const specEntry = await kv.get(specKey);
  if (!specEntry || specEntry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${args.ref.token}" is unknown (or its spec carries a deletion marker); resume presents only a minted token (SPEC 13.6)`);
  const spec = JSON.parse(new TextDecoder().decode(specEntry.value)) as CheckpointSpecValue;
  if (spec.holder !== undefined
    && (spec.holder.id !== args.presenter.id || spec.holder.lifecycleUid !== args.presenter.lifecycleUid))
    throw new EpEnvelopeError("permission-denied", `resume of checkpoint "${args.ref.token}" is holder-bound to ${spec.holder.id}/${spec.holder.lifecycleUid}; the presenter ${args.presenter.id}/${args.presenter.lifecycleUid} is not the holder (SPEC 13.10)`);
  // Gate on the SETTLE FACT (a lagging waiting status is converged): if the checkpoint already
  // settled, resume refuses on the fact, never on a stale projection. (The settleCheckpoint CAS
  // below is a second, atomic fence — but reading the fact first gives the precise refusal and
  // repairs the projection.)
  const already = await settledOrConverge(kv, jsm, space_, args.ref);
  if (already !== undefined)
    throw new EpEnvelopeError(already.settle === "resumed" ? "conflict" : "failed-precondition",
      `checkpoint "${args.ref.token}" is already settled ${already.settle} at ${already.ts}; resume authorization is one-use and expiry fails closed (SPEC 13.6)`);
  const status = await readCheckpointStatus(kv, args.ref);
  if (status === undefined)
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${args.ref.token}" has no status; reconcile the store (SPEC 13.6)`);
  if (status.value.state !== "waiting")
    throw new EpEnvelopeError(status.value.state === "resumed" ? "conflict" : "failed-precondition",
      `checkpoint "${args.ref.token}" is already ${status.value.state}; resume authorization is one-use and expiry fails closed (SPEC 13.6)`);
  const settled = await settleCheckpoint(kv, js, jsm, space_, {
    ref: args.ref, settle: "resumed", generation: status.value.deadlineGeneration, now: args.now, statusEntry: status,
    holder: args.presenter,
  });
  if (!settled.won) {
    if (settled.fact.settle === "expired")
      throw new EpEnvelopeError("failed-precondition", `checkpoint "${args.ref.token}" expired at ${settled.fact.ts} before this resume; expiry fails the checkpoint closed (SPEC 13.6)`);
    throw new EpEnvelopeError("conflict", `checkpoint "${args.ref.token}" was already resumed at ${settled.fact.ts}; resume authorization is one-use (SPEC 13.6)`);
  }
  return settled.fact;
}

/** Read the recorded settlement (`undefined` = still waiting). */
export async function readCheckpointSettle(jsm: JetStreamManager, space_: string, ref: CheckpointRef): Promise<CheckpointSettleFact | undefined> {
  const subject = checkpointSettleSubject(space_, ref);
  const raw = await readLastFact(jsm, epfStreamName(space_), subject);
  return raw === undefined ? undefined : parseSettle(raw, subject);
}

async function settleCheckpoint(
  kv: KV,
  js: JetStreamClient,
  jsm: JetStreamManager,
  space_: string,
  args: {
    ref: CheckpointRef; settle: "resumed" | "expired"; generation: number; now: number;
    statusEntry: { value: CheckpointStatusValue; revision: number };
    holder?: { id: string; lifecycleUid: string };
  },
): Promise<{ won: boolean; fact: CheckpointSettleFact }> {
  const fact: CheckpointSettleFact = {
    v: 1, token: args.ref.token, settle: args.settle, generation: args.generation,
    ...(args.holder !== undefined ? { holder: args.holder } : {}), ts: args.now,
  };
  const subject = checkpointSettleSubject(space_, args.ref);
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", "0");
  let won = true;
  try {
    await js.publish(subject, new TextEncoder().encode(JSON.stringify(fact)), { headers: h });
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code !== 10071 && code !== 10164) throw e;
    won = false;
  }
  if (!won) {
    const winner = await readCheckpointSettle(jsm, space_, args.ref);
    if (winner === undefined)
      throw new EpEnvelopeError("internal", `the checkpoint settle CAS for ${subject} was lost but no winning fact is readable (SPEC 13.4)`);
    return { won: false, fact: winner };
  }
  // Project the settlement (status follows the fact; a CAS loss here means a concurrent
  // projection already landed — re-read confirms, never overwrite).
  const next: CheckpointStatusValue = assertStatusValue({
    state: args.settle, deadlineGeneration: args.statusEntry.value.deadlineGeneration,
    deadline: args.statusEntry.value.deadline, observedSpecRevision: args.statusEntry.value.observedSpecRevision,
  });
  try {
    await updateRecordEntry(kv, recordStatusKey(RECORD_KINDS.cp, cpQualifiers(args.ref)), next, args.statusEntry.revision);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    // the projection raced; the fact is the truth and the reconciler/next reader converges it
  }
  return { won: true, fact };
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
  if ((await settledOrConverge(kv, jsm, space_, args.ref)) !== undefined) return { reEmitted: false };
  await emitScheduleRequest(js, space_, {
    endpoint: args.ref.endpoint, instanceId: args.instanceId, epoch: args.epoch,
    token: args.ref.token, generation: status.value.deadlineGeneration, deadline: status.value.deadline,
  });
  return { reEmitted: true, generation: status.value.deadlineGeneration };
}
