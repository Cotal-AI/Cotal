/**
 * The ACTION composite (SPEC §13.6): a long-running command as a pattern over the journal +
 * records + events — zero new transport. `action` is a command MARKER, never a class: an
 * action's submissions are `class: journal`, its accept/reject is the durable decision fact
 * (§13.4), and there is no reply-rail answer to recover.
 *
 * The pieces, each owned by the §13.9 principal named on its row:
 *  - the GOAL BIND (canonicalizer): a create-only CAS on
 *    `epf.<e>.goal.<caller triple>.<goalId>.bind` carrying the accepted fingerprint, BEFORE
 *    acceptance — the decision CAS keys on `id`, which alone would let two ids name one goal;
 *    the bind keys on `goalId` and stops the second before acceptance and effect.
 *  - the GOAL RECORD (commit path): `goal.<e>.<caller triple>.<goalId>` spec (the accepted
 *    definition) + status (the CURRENT state projection). The journal owns the facts; the
 *    status is a status-only projection with the §13.6 single status vocabulary
 *    `accepted → running ⇄ waiting → terminal`, `cancelling` between a cancel and its
 *    terminal state.
 *  - the TERMINAL RESULT (commit path): a create-only CAS on
 *    `epf.<e>.goal.<caller triple>.<goalId>.result` — first terminal fact wins UNIFORMLY
 *    (completion, cancel, expiry, and the bounded-readiness `uncertain` settle all race at
 *    this one commit point; the loser observes the winner). The fact carries the §13.6
 *    terminal-tombstone summary `{goalId, fingerprint, state, outcomeDigest}` alongside the
 *    payload, so the tombstone outlives payload retention without a second write.
 *  - PROGRESS rides per-goal events (`epe….goal.<caller triple>.<goalId>.progress`),
 *    read-scoped to the caller at mint time; this module derives the topic, the emitting
 *    instance publishes it under its own identity/epoch subject.
 *
 * Clocks are inputs everywhere (`now`, `acceptedAt`): the owner's clock decides, never a
 * module-internal Date.now.
 */
import type { KV } from "@nats-io/kv";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { headers as natsHeaders } from "@nats-io/transport-node";
import { contractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { epfSubject, assertIdToken, type EpCaller, type ParsedEpRequest } from "./endpoint-subjects.js";
import { RECORD_KINDS, recordSpecKey, recordStatusKey, createRecordEntry, updateRecordEntry, assertStatusValue } from "./endpoint-records.js";
import { epfStreamName, epfGoalBindSubject, readLastFact } from "./endpoint-journal.js";

/** A goal's coordinates: the owning endpoint + the caller triple + the client-chosen goalId. */
export interface GoalRef {
  endpoint: string;
  caller: EpCaller;
  goalId: string;
}

/** The goal's terminal-result fact subject (`epf.<e>.goal.<triple>.<goalId>.result`, §13.2). */
export function goalResultSubject(space: string, ref: GoalRef): string {
  return epfSubject(space, ref.endpoint, ["goal", ref.caller.owner, ref.caller.actor, ref.caller.uid, ref.goalId, "result"]);
}

/** The per-goal progress EVENT topic tail (§13.2 reserved topics): the emitting instance
 *  publishes it under its own `epe.<e>.<instanceId>.<epoch>.<topic…>` subject; the caller
 *  identity in the topic gives mint-time read containment. */
export function goalProgressTopic(ref: GoalRef): string[] {
  return ["goal", ref.caller.owner, ref.caller.actor, ref.caller.uid, assertIdToken(ref.goalId, "goalId"), "progress"];
}

function goalQualifiers(ref: GoalRef): string[] {
  return [ref.endpoint, ref.caller.owner, ref.caller.actor, ref.caller.uid, ref.goalId];
}

// ---- the goal bind (§13.4 item 3, canonicalizer-owned) ---------------------------------------

/** The bind fact: the goalId's accepted fingerprint, immutable for the goal's lifetime. */
export interface GoalBindFact { v: 1; goalId: string; fingerprint: string }

function parseBind(raw: unknown, subject: string): GoalBindFact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `goal-bind fact on ${subject} is not an object; garbled mediated fact state never authorizes (SPEC 13.4)`);
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.goalId !== "string" || typeof o.fingerprint !== "string")
    throw new EpEnvelopeError("internal", `goal-bind fact on ${subject} is malformed; garbled state never authorizes (SPEC 13.4)`);
  return { v: 1, goalId: o.goalId, fingerprint: o.fingerprint };
}

/** Bind a goal to its accepted fingerprint BEFORE acceptance (the canonicalizer's seam): a
 *  create-only CAS per goalId. The winner proceeds to acceptance; a loser reads the recorded
 *  bind and decides — the SAME fingerprint is the caller's retry (route it to the cached
 *  decision/outcome), a DIFFERENT fingerprint is a `conflict` rejection BEFORE acceptance and
 *  effect (two distinct ids can never both be accepted-and-effected against one goalId). The
 *  subject derives structurally from the broker-authenticated request, never body fields. */
export async function bindGoal(
  js: JetStreamClient,
  jsm: JetStreamManager,
  space: string,
  request: ParsedEpRequest,
  goalId: string,
  fingerprint: string,
): Promise<{ bound: true } | { bound: false; existing: GoalBindFact }> {
  const subject = epfGoalBindSubject(space, request, goalId);
  const fact: GoalBindFact = { v: 1, goalId, fingerprint };
  const res = await publishCreateOnly(js, subject, new TextEncoder().encode(JSON.stringify(fact)));
  if (res.won) return { bound: true };
  const raw = await readLastFact(jsm, epfStreamName(space), subject);
  if (raw === undefined)
    throw new EpEnvelopeError("internal", `the goal-bind CAS for ${subject} was lost but no winning fact is readable; the leader-served read must observe the winner (SPEC 13.4)`);
  return { bound: false, existing: parseBind(raw, subject) };
}

async function publishCreateOnly(js: JetStreamClient, subject: string, bytes: Uint8Array): Promise<{ won: boolean }> {
  const h = natsHeaders();
  h.set("Nats-Expected-Last-Subject-Sequence", "0");
  try {
    await js.publish(subject, bytes, { headers: h });
    return { won: true };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code === 10071 || code === 10164) return { won: false };
    throw e;
  }
}

// ---- the goal record: spec + status projection (§13.6 item 2/3, commit-path-owned) -----------

/** The §13.6 single status vocabulary for every long-running surface. */
export const GOAL_STATES = ["accepted", "running", "waiting", "cancelling", "succeeded", "failed", "cancelled", "expired", "uncertain"] as const;
export type GoalState = (typeof GOAL_STATES)[number];
/** All five are TERMINAL and immutable; first-terminal-fact-wins applies uniformly. */
export const GOAL_TERMINAL_STATES: readonly GoalState[] = Object.freeze(["succeeded", "failed", "cancelled", "expired", "uncertain"]);

/** The legal §13.6 transitions: `accepted → running ⇄ waiting`, `cancelling` between a cancel
 *  and its terminal, every non-terminal may commit a terminal (the FACT decides which one
 *  first), a terminal absorbs. */
export function isLegalGoalTransition(from: GoalState, to: GoalState): boolean {
  if (GOAL_TERMINAL_STATES.includes(from)) return false; // terminal states are immutable
  if (GOAL_TERMINAL_STATES.includes(to)) return true; // the terminal FACT is the arbiter; status follows it
  switch (from) {
    case "accepted": return to === "running" || to === "waiting" || to === "cancelling";
    case "running": return to === "waiting" || to === "cancelling";
    case "waiting": return to === "running" || to === "cancelling";
    case "cancelling": return false; // only a terminal leaves cancelling
    default: return false;
  }
}

/** The goal SPEC (written once at acceptance by the commit path): the accepted definition the
 *  status projects against. `acceptedAt` + `readinessDeadlineMs` are the §13.6 item-6
 *  acceptance-relative readiness bound (persisted goal state, NOT the submission deadline). */
export interface GoalSpecValue {
  v: 1;
  goalId: string;
  fingerprint: string;
  command: string;
  caller: { id: string; lifecycleUid: string };
  target?: { owner: string; actor: string; lifecycleUid: string; mappingRevision: number };
  sourceSeq: number;
  acceptedAt: number;
  readinessDeadlineMs?: number;
}

/** The goal STATUS value: the current state projection (+ the waiting checkpoint coordinate
 *  and the accepted cancel mode when present). `observedSpecRevision` per §13.4. */
export interface GoalStatusValue extends Record<string, unknown> {
  state: GoalState;
  checkpoint?: { token: string; deadlineGeneration: number };
  cancelMode?: "graceful" | "terminate";
  observedSpecRevision: number;
}

/** Create the goal record at acceptance (commit path): spec create-only + the `accepted`
 *  status projecting it. A goalId whose spec already exists is a loud `conflict` (the bind
 *  CAS upstream makes this unreachable for distinct submissions; reaching it means a replayed
 *  acceptance, which reads the existing goal instead). */
export async function createGoal(kv: KV, ref: GoalRef, spec: Omit<GoalSpecValue, "v" | "goalId">): Promise<{ specRevision: number }> {
  const value: GoalSpecValue = { v: 1, goalId: ref.goalId, ...spec };
  const specRevision = await createRecordEntry(kv, recordSpecKey(RECORD_KINDS.goal, goalQualifiers(ref)), value);
  await createRecordEntry(kv, recordStatusKey(RECORD_KINDS.goal, goalQualifiers(ref)), assertStatusValue({ state: "accepted", observedSpecRevision: specRevision }));
  return { specRevision };
}

function parseStatus(raw: unknown, key: string): GoalStatusValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `goal status ${key} is not an object; garbled mediated record state never authorizes (SPEC 13.4)`);
  const o = raw as Record<string, unknown>;
  if (typeof o.state !== "string" || !(GOAL_STATES as readonly string[]).includes(o.state))
    throw new EpEnvelopeError("internal", `goal status ${key} carries unknown state ${JSON.stringify(o.state)}; garbled state never authorizes (SPEC 13.6)`);
  if (typeof o.observedSpecRevision !== "number" || !Number.isSafeInteger(o.observedSpecRevision) || o.observedSpecRevision < 0)
    throw new EpEnvelopeError("internal", `goal status ${key} has no valid observedSpecRevision (SPEC 13.4)`);
  return o as GoalStatusValue;
}

/** Read the goal's current status projection (`undefined` = unknown goal). */
export async function readGoalStatus(kv: KV, ref: GoalRef): Promise<{ value: GoalStatusValue; revision: number } | undefined> {
  const key = recordStatusKey(RECORD_KINDS.goal, goalQualifiers(ref));
  const entry = await kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the goal status ${key} carries a ${entry.operation} marker; a deletion never erases a goal's projection - reconcile the store (SPEC 13.4)`);
  return { value: parseStatus(JSON.parse(new TextDecoder().decode(entry.value)), key), revision: entry.revision };
}

/** CAS the goal's status through the §13.6 machine. An illegal transition is
 *  `failed-precondition`; a CAS loss is a loud `conflict` (re-read and re-decide). Terminal
 *  transitions are the PROJECTION of a committed result fact — commit the fact FIRST
 *  ({@link commitGoalResult}); status follows the journal, never leads it. */
export async function transitionGoal(
  kv: KV,
  ref: GoalRef,
  to: GoalState,
  fields: Partial<Pick<GoalStatusValue, "checkpoint" | "cancelMode">> = {},
): Promise<GoalStatusValue> {
  const current = await readGoalStatus(kv, ref);
  if (current === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${ref.goalId}" is unknown; a transition projects only an accepted goal (SPEC 13.6)`);
  if (!isLegalGoalTransition(current.value.state, to))
    throw new EpEnvelopeError("failed-precondition", `goal "${ref.goalId}" cannot transition ${current.value.state} -> ${to} (SPEC 13.6: accepted -> running <-> waiting -> terminal, cancelling between a cancel and its terminal; terminals are immutable)`);
  const next: GoalStatusValue = assertStatusValue({
    state: to,
    ...(fields.checkpoint !== undefined ? { checkpoint: fields.checkpoint } : {}),
    ...(fields.cancelMode !== undefined ? { cancelMode: fields.cancelMode } : current.value.cancelMode !== undefined ? { cancelMode: current.value.cancelMode } : {}),
    observedSpecRevision: current.value.observedSpecRevision,
  });
  await updateRecordEntry(kv, recordStatusKey(RECORD_KINDS.goal, goalQualifiers(ref)), next, current.revision);
  return next;
}

// ---- the terminal result (§13.6 items 2/4/5/6, commit-principal-owned) ------------------------

export type GoalOutcomeState = "succeeded" | "failed" | "cancelled" | "expired" | "uncertain";

/** The goal's terminal fact: the cached outcome PLUS the §13.6 item-5 tombstone summary
 *  (`goalId`, `fingerprint`, `state`, `outcomeDigest`) in one artifact, so the summary
 *  outlives payload retention without a second write (`data` may be evicted by policy above
 *  the broker; the summary fields are bounded and stay). */
export interface GoalResultFact {
  v: 1;
  goalId: string;
  fingerprint: string;
  state: GoalOutcomeState;
  /** `contractDigest` of `data` (of `null` when absent) — the tombstone's outcome identity. */
  outcomeDigest: string;
  data?: unknown;
  ts: number;
}

function parseResult(raw: unknown, subject: string): GoalResultFact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `goal result fact on ${subject} is not an object; garbled state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.goalId !== "string" || typeof o.fingerprint !== "string"
    || typeof o.state !== "string" || !(GOAL_TERMINAL_STATES as readonly string[]).includes(o.state)
    || typeof o.outcomeDigest !== "string" || typeof o.ts !== "number")
    throw new EpEnvelopeError("internal", `goal result fact on ${subject} is malformed; garbled state never authorizes (SPEC 13.6)`);
  return raw as GoalResultFact;
}

/** Read the goal's cached terminal outcome (`undefined` = not terminal yet). */
export async function readGoalResult(jsm: JetStreamManager, space: string, ref: GoalRef): Promise<GoalResultFact | undefined> {
  const subject = goalResultSubject(space, ref);
  const raw = await readLastFact(jsm, epfStreamName(space), subject);
  return raw === undefined ? undefined : parseResult(raw, subject);
}

/** Commit the goal's terminal state: ONE create-only CAS at the mediated commit point —
 *  completion, cancel, expiry, and the readiness `uncertain` settle ALL race here, first
 *  terminal fact wins uniformly, and the loser gets `{won: false}` with the WINNING fact
 *  (never re-deciding). The projection follows: the caller SHOULD `transitionGoal` to the
 *  winning fact's state after the commit (status follows the journal). */
export async function commitGoalResult(
  js: JetStreamClient,
  jsm: JetStreamManager,
  space: string,
  args: { ref: GoalRef; fingerprint: string; state: GoalOutcomeState; data?: unknown; now: number },
): Promise<{ won: boolean; fact: GoalResultFact }> {
  if (!Number.isSafeInteger(args.now) || args.now < 0)
    throw new EpEnvelopeError("failed-precondition", `now must be a non-negative safe integer; got ${JSON.stringify(args.now)}`);
  const fact: GoalResultFact = {
    v: 1, goalId: args.ref.goalId, fingerprint: args.fingerprint, state: args.state,
    outcomeDigest: contractDigest(args.data === undefined ? null : args.data),
    ...(args.data !== undefined ? { data: args.data } : {}), ts: args.now,
  };
  const subject = goalResultSubject(space, args.ref);
  const res = await publishCreateOnly(js, subject, new TextEncoder().encode(JSON.stringify(fact)));
  if (res.won) return { won: true, fact };
  const winner = await readGoalResult(jsm, space, args.ref);
  if (winner === undefined)
    throw new EpEnvelopeError("internal", `the goal terminal CAS for ${subject} was lost but no winning fact is readable (SPEC 13.4)`);
  return { won: false, fact: winner };
}

// ---- cancel (§13.6 item 4) --------------------------------------------------------------------

/** The reserved `cancel` command's handler seam. An unknown or already-terminal goal is
 *  `failed-precondition` with the cached outcome ATTACHED (`error.outcome`); otherwise the
 *  status transitions to `cancelling` recording the mode (`graceful` runs compensations,
 *  `terminate` does not) and the OWNER drives the actual stop, then commits `cancelled` at
 *  the shared commit point — where a racing completion may lawfully win first (the caller
 *  observes whichever terminal won). */
export async function requestGoalCancel(
  kv: KV,
  jsm: JetStreamManager,
  space: string,
  args: { ref: GoalRef; mode: "graceful" | "terminate" },
): Promise<GoalStatusValue> {
  const cached = await readGoalResult(jsm, space, args.ref);
  if (cached !== undefined) {
    const e = new EpEnvelopeError("failed-precondition", `goal "${args.ref.goalId}" is already terminal (${cached.state}); the cached outcome is attached (SPEC 13.6)`);
    (e as EpEnvelopeError & { outcome?: GoalResultFact }).outcome = cached;
    throw e;
  }
  const status = await readGoalStatus(kv, args.ref);
  if (status === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${args.ref.goalId}" is unknown; cancel addresses only an accepted goal (SPEC 13.6)`);
  if (status.value.state === "cancelling") return status.value; // idempotent: a repeated cancel changes nothing
  return transitionGoal(kv, args.ref, "cancelling", { cancelMode: args.mode });
}

// ---- bounded readiness (§13.6 item 6) ----------------------------------------------------------

/** Settle a goal `uncertain` when its ACCEPTANCE-RELATIVE readiness deadline passed without
 *  the success signal (the owner's clock decides). `uncertain` is a terminal outcome like any
 *  other — immutable, first-terminal-fact-wins — so a racing late success that commits first
 *  lawfully wins and this settle returns the winner instead. Settling BEFORE the deadline is
 *  refused: the bound is the contract, not a hint. */
export async function settleGoalUncertain(
  js: JetStreamClient,
  jsm: JetStreamManager,
  space: string,
  args: { ref: GoalRef; fingerprint: string; acceptedAt: number; readinessDeadlineMs: number; now: number },
): Promise<{ won: boolean; fact: GoalResultFact }> {
  if (!Number.isSafeInteger(args.readinessDeadlineMs) || args.readinessDeadlineMs <= 0)
    throw new EpEnvelopeError("failed-precondition", `readinessDeadlineMs must be a positive integer; got ${JSON.stringify(args.readinessDeadlineMs)}`);
  if (args.now < args.acceptedAt + args.readinessDeadlineMs)
    throw new EpEnvelopeError("failed-precondition", `goal "${args.ref.goalId}" is not past its readiness deadline (acceptedAt ${args.acceptedAt} + ${args.readinessDeadlineMs}ms > now ${args.now}); an early uncertain settle would steal a still-possible success (SPEC 13.6)`);
  return commitGoalResult(js, jsm, space, {
    ref: args.ref, fingerprint: args.fingerprint, state: "uncertain",
    data: { reason: "the success signal did not arrive within the readiness deadline", readinessDeadlineMs: args.readinessDeadlineMs },
    now: args.now,
  });
}

// ---- goalId reuse (§13.6 item 5) ---------------------------------------------------------------

/** Classify a resubmission against the recorded bind: the SAME fingerprint is the caller's
 *  retry (serve the cached decision/outcome; after payload eviction, the tombstone summary
 *  with `evicted: true`); a DIFFERENT fingerprint is `conflict`. Beyond the idempotency
 *  horizon the bind fact has expired with its retention, the CAS is virgin again, and a
 *  reused goalId is explicitly NEW work — that path never reaches this classifier. */
export function classifyGoalReuse(existing: GoalBindFact, submittedFingerprint: string): "cached" | "conflict" {
  return existing.fingerprint === submittedFingerprint ? "cached" : "conflict";
}
