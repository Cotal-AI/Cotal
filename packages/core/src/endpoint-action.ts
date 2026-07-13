/**
 * The ACTION composite (SPEC §13.6): a long-running command as a pattern over the journal +
 * records + events — zero new transport. `action` is a command MARKER, never a class: an
 * action's submissions are `class: journal`, its accept/reject is the durable decision fact
 * (§13.4), and there is no reply-rail answer to recover.
 *
 * THE RESULT FACT IS THE SINGLE TERMINAL ARBITER; THE STATUS ONLY EVER FOLLOWS IT. The pieces,
 * each owned by the §13.9 principal named on its row:
 *  - the GOAL BIND (canonicalizer): a create-only CAS on
 *    `epf.<e>.goal.<caller triple>.<goalId>.bind` carrying the accepted fingerprint, BEFORE
 *    acceptance — the decision CAS keys on `id`, which alone would let two ids name one goal;
 *    the bind keys on `goalId` and stops the second before acceptance and effect. A bind whose
 *    winner crashed BEFORE acceptance (no goal record exists) is ORPHANED, and a same-fingerprint
 *    resubmission ADOPTS it and proceeds to acceptance ({@link resolveGoalSubmission}): every
 *    step downstream is a create-only rail, so the adopted retry is replay-safe end to end.
 *  - the GOAL RECORD (commit path): `goal.<e>.<caller triple>.<goalId>` spec (the accepted
 *    definition, the trusted source every later seam validates against) + status (the CURRENT
 *    state projection). The journal owns the facts; the status is a status-only projection with
 *    the §13.6 single status vocabulary `accepted → running ⇄ waiting → terminal`, `cancelling`
 *    between a cancel and its terminal state. A TERMINAL status exists ONLY as the projection of
 *    the committed result fact ({@link projectGoalTerminal}); {@link transitionGoal} refuses
 *    terminal targets outright, so the status can never lead or contradict the journal.
 *  - the TERMINAL RESULT (commit path): a create-only CAS on
 *    `epf.<e>.goal.<caller triple>.<goalId>.result` — first terminal fact wins UNIFORMLY
 *    (completion, cancel, expiry, and the bounded-readiness `uncertain` settle all race at this
 *    one commit point; the loser observes the winner). The commit BINDS to the persisted
 *    accepted goal: the fingerprint is stamped FROM the spec (never a caller claim), and a goal
 *    accepted against a pinned target lifecycle demands the executor's FRESH lifecycle/epoch
 *    currency (§13.6 item 7: not effectful against a same-name successor; a superseded epoch
 *    cannot commit).
 *  - the TOMBSTONE (§13.6 item 5): the summary `{goalId, fingerprint, state, outcomeDigest}`
 *    lives INSIDE the one immutable result fact. Both retention minimums are realized by keeping
 *    the fact at least the idempotency horizon (payload "at least result retention" is a floor,
 *    not a ceiling — retaining it the full horizon satisfies it). A deployment that evicts
 *    payloads EARLIER does so in a serving layer above the broker, answering retries with
 *    {@link goalTombstone} (`data.evicted: true`); the stored fact itself is immutable.
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
import { canonicalJson, contractDigest } from "./canonical.js";
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

/** Derive a goal ref STRUCTURALLY from the broker-authenticated request (§13.6): the caller
 *  triple comes from the subject the broker admitted, never from body fields, so a seam taking
 *  this ref can only address the authenticated caller's own goals. */
export function goalRefOf(request: ParsedEpRequest, goalId: string): GoalRef {
  return { endpoint: request.endpoint, caller: request.caller, goalId: assertIdToken(goalId, "goalId") };
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

function assertSafeInt(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw new EpEnvelopeError("failed-precondition", `${what} must be a non-negative safe integer; got ${JSON.stringify(v)}`);
  return v;
}

// ---- the goal bind (§13.4 item 3, canonicalizer-owned) ---------------------------------------

/** The bind fact: the goalId's accepted fingerprint, immutable for the goal's lifetime. */
export interface GoalBindFact { v: 1; goalId: string; fingerprint: string }

/** Closed validation, IDENTITY-BOUND to the subject it was read from (§13.4): a garbled or
 *  mis-subjected bind never gates acceptance. */
function parseBind(raw: unknown, subject: string, goalId: string): GoalBindFact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `goal-bind fact on ${subject} is not an object; garbled mediated fact state never authorizes (SPEC 13.4)`);
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.goalId !== "string" || typeof o.fingerprint !== "string" || o.fingerprint.length === 0)
    throw new EpEnvelopeError("internal", `goal-bind fact on ${subject} is malformed; garbled state never authorizes (SPEC 13.4)`);
  if (o.goalId !== goalId)
    throw new EpEnvelopeError("internal", `goal-bind fact on ${subject} names goalId ${JSON.stringify(o.goalId)}, not its subject's ${goalId}; a mis-subjected fact never authorizes (SPEC 13.4)`);
  return { v: 1, goalId: o.goalId, fingerprint: o.fingerprint };
}

/** Bind a goal to its accepted fingerprint BEFORE acceptance (the canonicalizer's seam): a
 *  create-only CAS per goalId. The winner proceeds to acceptance; a loser reads the recorded
 *  bind and decides — the SAME fingerprint is the caller's retry (route it via
 *  {@link resolveGoalSubmission}), a DIFFERENT fingerprint is a `conflict` rejection BEFORE
 *  acceptance and effect (two distinct ids can never both be accepted-and-effected against one
 *  goalId). The subject derives structurally from the broker-authenticated request, never body
 *  fields. */
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
  return { bound: false, existing: parseBind(raw, subject, goalId) };
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

/** The submission-vs-bind verdict (§13.6 item 5 + orphan recovery). */
export type GoalSubmissionVerdict =
  | { kind: "new" }
  | { kind: "cached"; bind: GoalBindFact; result?: GoalResultFact }
  | { kind: "adopted"; bind: GoalBindFact }
  | { kind: "conflict"; bind: GoalBindFact };

/** Resolve a goal submission against the bind rail (the canonicalizer's composed seam):
 *   - the bind CAS wins → NEW work; proceed to acceptance;
 *   - a bind exists with the SAME fingerprint and the goal record exists → the caller's retry:
 *     serve the CACHED decision/outcome (the terminal result rides along when one exists);
 *   - a bind exists with the SAME fingerprint but NO goal record → the bind's winner crashed
 *     BEFORE acceptance (the orphaned-bind crash window): this submission ADOPTS the bind and
 *     proceeds to acceptance — the decision CAS, spec create, and status create downstream are
 *     all create-only/idempotent, so the adoption is replay-safe however far the crash got;
 *   - a DIFFERENT fingerprint is `conflict` (immutable bind; two definitions never share a
 *     goalId inside the horizon), whether or not the goal record exists. */
export async function resolveGoalSubmission(
  kv: KV,
  js: JetStreamClient,
  jsm: JetStreamManager,
  space: string,
  request: ParsedEpRequest,
  goalId: string,
  fingerprint: string,
): Promise<GoalSubmissionVerdict> {
  const bound = await bindGoal(js, jsm, space, request, goalId, fingerprint);
  if (bound.bound) return { kind: "new" };
  if (bound.existing.fingerprint !== fingerprint) return { kind: "conflict", bind: bound.existing };
  const ref = goalRefOf(request, goalId);
  const spec = await readGoalSpec(kv, ref);
  if (spec === undefined) return { kind: "adopted", bind: bound.existing };
  const result = await readGoalResult(jsm, space, ref);
  return { kind: "cached", bind: bound.existing, ...(result !== undefined ? { result } : {}) };
}

// ---- the goal record: spec + status projection (§13.6 item 2/3, commit-path-owned) -----------

/** The §13.6 single status vocabulary for every long-running surface. */
export const GOAL_STATES = ["accepted", "running", "waiting", "cancelling", "succeeded", "failed", "cancelled", "expired", "uncertain"] as const;
export type GoalState = (typeof GOAL_STATES)[number];
/** All five are TERMINAL and immutable; first-terminal-fact-wins applies uniformly. */
export const GOAL_TERMINAL_STATES: readonly GoalState[] = Object.freeze(["succeeded", "failed", "cancelled", "expired", "uncertain"]);

/** The legal §13.6 transitions: `accepted → running ⇄ waiting`, `cancelling` between a cancel
 *  and its terminal, every non-terminal may project a terminal (the FACT decides which one
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

/** The goal SPEC (written once at acceptance by the commit path): the accepted definition every
 *  later seam validates against — the terminal commit stamps ITS fingerprint from here, and the
 *  readiness settle reads ITS bound from here, never from caller claims. `acceptedAt` +
 *  `readinessDeadlineMs` are the §13.6 item-6 acceptance-relative readiness bound (persisted
 *  goal state, NOT the submission deadline). */
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

/** Closed spec validation, identity-bound to the ref whose key it was read from (§13.4). */
function parseSpec(raw: unknown, key: string, ref: GoalRef): GoalSpecValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `goal spec ${key} is not an object; garbled mediated record state never authorizes (SPEC 13.4)`);
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.goalId !== "string" || typeof o.fingerprint !== "string" || o.fingerprint.length === 0 || typeof o.command !== "string")
    throw new EpEnvelopeError("internal", `goal spec ${key} is malformed; garbled state never authorizes (SPEC 13.4)`);
  if (o.goalId !== ref.goalId)
    throw new EpEnvelopeError("internal", `goal spec ${key} names goalId ${JSON.stringify(o.goalId)}, not its key's ${ref.goalId}; a mis-keyed record never authorizes (SPEC 13.4)`);
  const c = o.caller as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object" || typeof c.id !== "string" || typeof c.lifecycleUid !== "string")
    throw new EpEnvelopeError("internal", `goal spec ${key} carries no valid caller identity; garbled state never authorizes (SPEC 13.4)`);
  for (const [n, v] of [["sourceSeq", o.sourceSeq], ["acceptedAt", o.acceptedAt]] as const)
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
      throw new EpEnvelopeError("internal", `goal spec ${key} field ${n} is not a safe integer; garbled state never authorizes (SPEC 13.4)`);
  if (o.readinessDeadlineMs !== undefined && (typeof o.readinessDeadlineMs !== "number" || !Number.isSafeInteger(o.readinessDeadlineMs) || o.readinessDeadlineMs <= 0))
    throw new EpEnvelopeError("internal", `goal spec ${key} readinessDeadlineMs is not a positive integer; garbled state never authorizes (SPEC 13.6)`);
  if (o.target !== undefined) {
    const t = o.target as Record<string, unknown>;
    if (t === null || typeof t !== "object" || typeof t.owner !== "string" || typeof t.actor !== "string" || typeof t.lifecycleUid !== "string"
      || typeof t.mappingRevision !== "number" || !Number.isSafeInteger(t.mappingRevision) || t.mappingRevision < 0)
      throw new EpEnvelopeError("internal", `goal spec ${key} carries a malformed target tuple; garbled state never authorizes (SPEC 13.4)`);
  }
  return o as unknown as GoalSpecValue;
}

/** Read the persisted accepted goal (`undefined` = never accepted). A DEL marker refuses:
 *  a deletion never erases an accepted goal's definition. */
export async function readGoalSpec(kv: KV, ref: GoalRef): Promise<{ value: GoalSpecValue; revision: number } | undefined> {
  const key = recordSpecKey(RECORD_KINDS.goal, goalQualifiers(ref));
  const entry = await kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the goal spec ${key} carries a ${entry.operation} marker; a deletion never erases an accepted goal - reconcile the store (SPEC 13.4)`);
  return { value: parseSpec(JSON.parse(new TextDecoder().decode(entry.value)), key, ref), revision: entry.revision };
}

/** The goal STATUS value: the current state projection. State-dependent fields are CLOSED:
 *  `checkpoint` exists only in `waiting`, `cancelMode` only in `cancelling`.
 *  `observedSpecRevision` per §13.4. */
export interface GoalStatusValue extends Record<string, unknown> {
  state: GoalState;
  checkpoint?: { token: string; deadlineGeneration: number };
  cancelMode?: "graceful" | "terminate";
  observedSpecRevision: number;
}

/** Create the goal record at acceptance (commit path), IDEMPOTENTLY: spec create-only, then the
 *  `accepted` status projecting it. A crash between the two writes (or an adopted-retry replay)
 *  re-reads the spec, requires it CONTENT-IDENTICAL (a different definition under the same
 *  goalId is a loud `conflict`), and ensures the initial status exists — no stranded spec-only
 *  goal survives a retry. An existing status is left alone (it may have advanced). */
export async function createGoal(kv: KV, ref: GoalRef, spec: Omit<GoalSpecValue, "v" | "goalId">): Promise<{ specRevision: number }> {
  const value: GoalSpecValue = { v: 1, goalId: ref.goalId, ...spec };
  const specKey = recordSpecKey(RECORD_KINDS.goal, goalQualifiers(ref));
  let specRevision: number;
  try {
    specRevision = await createRecordEntry(kv, specKey, value);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    const existing = await readGoalSpec(kv, ref);
    if (existing === undefined)
      throw new EpEnvelopeError("conflict", `the goal spec CAS for ${specKey} was lost but no record is readable; re-read and re-decide (SPEC 13.4)`);
    if (canonicalJson(existing.value) !== canonicalJson(value))
      throw new EpEnvelopeError("conflict", `goal "${ref.goalId}" already has a DIFFERENT accepted definition; one goalId never carries two specs (SPEC 13.6)`);
    specRevision = existing.revision;
  }
  const statusKey = recordStatusKey(RECORD_KINDS.goal, goalQualifiers(ref));
  const statusEntry = await kv.get(statusKey);
  if (!statusEntry || statusEntry.operation !== "PUT") {
    if (statusEntry && statusEntry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `the goal status ${statusKey} carries a ${statusEntry.operation} marker; a deletion never erases a goal's projection (SPEC 13.4)`);
    try { await createRecordEntry(kv, statusKey, assertStatusValue({ state: "accepted", observedSpecRevision: specRevision })); }
    catch (e) { if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e; } // a concurrent repair won; identical by construction
  }
  return { specRevision };
}

/** Closed, STATE-DEPENDENT status validation (§13.4/§13.6): `checkpoint` only in `waiting`
 *  (token + safe-int deadlineGeneration), `cancelMode` only in `cancelling`; garbled
 *  cross-variant state never authorizes. */
function parseStatus(raw: unknown, key: string): GoalStatusValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `goal status ${key} is not an object; garbled mediated record state never authorizes (SPEC 13.4)`);
  const o = raw as Record<string, unknown>;
  if (typeof o.state !== "string" || !(GOAL_STATES as readonly string[]).includes(o.state))
    throw new EpEnvelopeError("internal", `goal status ${key} carries unknown state ${JSON.stringify(o.state)}; garbled state never authorizes (SPEC 13.6)`);
  if (typeof o.observedSpecRevision !== "number" || !Number.isSafeInteger(o.observedSpecRevision) || o.observedSpecRevision < 0)
    throw new EpEnvelopeError("internal", `goal status ${key} has no valid observedSpecRevision (SPEC 13.4)`);
  if (o.checkpoint !== undefined) {
    if (o.state !== "waiting")
      throw new EpEnvelopeError("internal", `goal status ${key} carries a checkpoint outside \`waiting\`; garbled cross-variant state never authorizes (SPEC 13.6)`);
    const cp = o.checkpoint as Record<string, unknown>;
    if (cp === null || typeof cp !== "object" || typeof cp.token !== "string" || cp.token.length === 0
      || typeof cp.deadlineGeneration !== "number" || !Number.isSafeInteger(cp.deadlineGeneration) || cp.deadlineGeneration < 0)
      throw new EpEnvelopeError("internal", `goal status ${key} carries a malformed checkpoint coordinate; garbled state never authorizes (SPEC 13.6)`);
  }
  if (o.cancelMode !== undefined) {
    if (o.state !== "cancelling")
      throw new EpEnvelopeError("internal", `goal status ${key} carries a cancelMode outside \`cancelling\`; garbled cross-variant state never authorizes (SPEC 13.6)`);
    if (o.cancelMode !== "graceful" && o.cancelMode !== "terminate")
      throw new EpEnvelopeError("internal", `goal status ${key} carries unknown cancelMode ${JSON.stringify(o.cancelMode)}; garbled state never authorizes (SPEC 13.6)`);
  }
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

/** CAS the goal's status through the NON-TERMINAL part of the §13.6 machine. A TERMINAL target
 *  is REFUSED OUTRIGHT: a terminal status exists only as the projection of the committed result
 *  fact — commit at the shared point ({@link commitGoalResult}, which projects) or converge an
 *  observed fact via {@link projectGoalTerminal}. The status never leads the journal. An illegal
 *  transition is `failed-precondition`; a CAS loss is a loud `conflict` (re-read and re-decide).
 *  State-dependent fields are closed: `checkpoint` is carried only INTO `waiting`, `cancelMode`
 *  only INTO `cancelling`. */
export async function transitionGoal(
  kv: KV,
  ref: GoalRef,
  to: GoalState,
  fields: Partial<Pick<GoalStatusValue, "checkpoint" | "cancelMode">> = {},
): Promise<GoalStatusValue> {
  if (GOAL_TERMINAL_STATES.includes(to))
    throw new EpEnvelopeError("failed-precondition", `a goal status never transitions to terminal "${to}" directly; commit the result fact and project it - the journal owns terminals, the status follows (SPEC 13.6)`);
  const current = await readGoalStatus(kv, ref);
  if (current === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${ref.goalId}" is unknown; a transition projects only an accepted goal (SPEC 13.6)`);
  if (!isLegalGoalTransition(current.value.state, to))
    throw new EpEnvelopeError("failed-precondition", `goal "${ref.goalId}" cannot transition ${current.value.state} -> ${to} (SPEC 13.6: accepted -> running <-> waiting -> terminal, cancelling between a cancel and its terminal; terminals are immutable)`);
  const next: GoalStatusValue = assertStatusValue({
    state: to,
    ...(to === "waiting" && fields.checkpoint !== undefined ? { checkpoint: fields.checkpoint } : {}),
    ...(to === "cancelling" && fields.cancelMode !== undefined ? { cancelMode: fields.cancelMode } : {}),
    observedSpecRevision: current.value.observedSpecRevision,
  });
  await updateRecordEntry(kv, recordStatusKey(RECORD_KINDS.goal, goalQualifiers(ref)), next, current.revision);
  return next;
}

/** Project the WINNING terminal fact onto the status — the ONLY path a status reaches a
 *  terminal state, and the crash reconciler for a commit that fenced the fact but died before
 *  projecting. Idempotent (an already-projected terminal returns unchanged); a status missing
 *  entirely (the create-goal crash window) is created AT the terminal; a racing non-terminal
 *  advance loses its revision and this projection retries onto the new one. */
export async function projectGoalTerminal(kv: KV, jsm: JetStreamManager, space: string, ref: GoalRef): Promise<GoalStatusValue> {
  const fact = await readGoalResult(jsm, space, ref);
  if (fact === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${ref.goalId}" has no terminal fact; only a committed result projects a terminal status (SPEC 13.6)`);
  const key = recordStatusKey(RECORD_KINDS.goal, goalQualifiers(ref));
  for (let pass = 0; pass < 2; pass++) {
    const current = await readGoalStatus(kv, ref);
    if (current === undefined) {
      const spec = await readGoalSpec(kv, ref);
      if (spec === undefined)
        throw new EpEnvelopeError("internal", `goal "${ref.goalId}" has a terminal fact but no accepted spec; garbled state never authorizes (SPEC 13.4)`);
      const created: GoalStatusValue = assertStatusValue({ state: fact.state, observedSpecRevision: spec.revision });
      try { await createRecordEntry(kv, key, created); return created; }
      catch (e) { if (e instanceof EpEnvelopeError && e.code === "conflict") continue; throw e; }
    }
    if (current.value.state === fact.state) return current.value; // already projected
    if (GOAL_TERMINAL_STATES.includes(current.value.state))
      throw new EpEnvelopeError("internal", `goal "${ref.goalId}" status is terminal ${current.value.state} but the winning fact is ${fact.state}; a projection never contradicts the journal (SPEC 13.6)`);
    const next: GoalStatusValue = assertStatusValue({ state: fact.state, observedSpecRevision: current.value.observedSpecRevision });
    try { await updateRecordEntry(kv, key, next, current.revision); return next; }
    catch (e) { if (e instanceof EpEnvelopeError && e.code === "conflict") continue; throw e; }
  }
  throw new EpEnvelopeError("conflict", `the goal status ${key} moved twice during one terminal projection; re-read and re-decide (SPEC 13.4)`);
}

// ---- the terminal result (§13.6 items 2/4/5/6, commit-principal-owned) ------------------------

export type GoalOutcomeState = "succeeded" | "failed" | "cancelled" | "expired" | "uncertain";

/** The goal's terminal fact: the cached outcome PLUS the §13.6 item-5 tombstone summary
 *  (`goalId`, `fingerprint`, `state`, `outcomeDigest`) in one immutable artifact. Retaining the
 *  fact at least the idempotency horizon realizes BOTH retention minimums (the payload's
 *  "at least result retention" is a floor); early payload eviction is a serving-layer policy
 *  answered with {@link goalTombstone}, never a mutation of this fact. */
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

/** The §13.6 item-5 tombstone serving form for a payload-evicted retry: the summary fields with
 *  `data.evicted: true`, derived from the stored fact — the caller learns the outcome identity
 *  (`state` + `outcomeDigest`) without the evicted payload. */
export function goalTombstone(fact: GoalResultFact): GoalResultFact {
  return { v: 1, goalId: fact.goalId, fingerprint: fact.fingerprint, state: fact.state, outcomeDigest: fact.outcomeDigest, data: { evicted: true }, ts: fact.ts };
}

/** Closed validation, IDENTITY-BOUND to the subject/ref it was read for, with the tombstone
 *  digest RE-VERIFIED against the carried payload (§13.4): a garbled, mis-subjected, or
 *  digest-inconsistent fact never counts as authoritative settlement. */
function parseResult(raw: unknown, subject: string, ref: GoalRef): GoalResultFact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `goal result fact on ${subject} is not an object; garbled state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.goalId !== "string" || typeof o.fingerprint !== "string" || o.fingerprint.length === 0
    || typeof o.state !== "string" || !(GOAL_TERMINAL_STATES as readonly string[]).includes(o.state)
    || typeof o.outcomeDigest !== "string" || o.outcomeDigest.length === 0
    || typeof o.ts !== "number" || !Number.isSafeInteger(o.ts) || o.ts < 0)
    throw new EpEnvelopeError("internal", `goal result fact on ${subject} is malformed; garbled state never authorizes (SPEC 13.6)`);
  if (o.goalId !== ref.goalId)
    throw new EpEnvelopeError("internal", `goal result fact on ${subject} names goalId ${JSON.stringify(o.goalId)}, not its subject's ${ref.goalId}; a mis-subjected fact never authorizes (SPEC 13.4)`);
  if (contractDigest(o.data === undefined ? null : o.data) !== o.outcomeDigest)
    throw new EpEnvelopeError("internal", `goal result fact on ${subject} carries an outcomeDigest that does not match its payload; a digest-inconsistent fact never authorizes (SPEC 13.6)`);
  return o as unknown as GoalResultFact;
}

/** Read the goal's cached terminal outcome (`undefined` = not terminal yet). */
export async function readGoalResult(jsm: JetStreamManager, space: string, ref: GoalRef): Promise<GoalResultFact | undefined> {
  const subject = goalResultSubject(space, ref);
  const raw = await readLastFact(jsm, epfStreamName(space), subject);
  return raw === undefined ? undefined : parseResult(raw, subject, ref);
}

/** The committing executor's identity, as authenticated at the handler boundary (subject/creds,
 *  never body claims). Required when the goal's spec pins a target lifecycle. */
export interface GoalExecutor { lifecycleUid: string; epoch: number }

/** Commit the goal's terminal state, BOUND TO THE PERSISTED ACCEPTED GOAL: the spec must exist
 *  (a terminal never commits for an unaccepted goal), the fact's fingerprint is stamped FROM the
 *  spec (never a caller claim), and — when the spec pins a target lifecycle (§13.6 item 7) — the
 *  executor must BE that lifecycle at its CURRENT epoch, freshly resolved from trusted authority
 *  immediately before the commit: a same-name successor or a superseded epoch is `expired`.
 *
 *  ONE create-only CAS at the mediated commit point — completion, cancel, expiry, and the
 *  readiness `uncertain` settle ALL race here, first terminal fact wins uniformly, and the loser
 *  gets `{won: false}` with the WINNING fact (never re-deciding). The outcome payload is
 *  snapshotted to an immutable strict-canonical copy BEFORE digesting and publishing, so the
 *  tombstone digest and the carried payload can never diverge under a concurrent mutation of the
 *  caller's object. The winning fact is then PROJECTED onto the status (idempotent; a crash
 *  before projecting is repaired by {@link projectGoalTerminal}). */
export async function commitGoalResult(
  kv: KV,
  js: JetStreamClient,
  jsm: JetStreamManager,
  space: string,
  args: {
    ref: GoalRef;
    state: GoalOutcomeState;
    data?: unknown;
    now: number;
    /** REQUIRED iff the persisted spec pins a target lifecycle. */
    executor?: GoalExecutor;
    /** REQUIRED iff the spec pins a target: freshly resolves the target principal's CURRENT
     *  process epoch from trusted authority (null = retired/unknown lifecycle). */
    resolveCurrentEpoch?: (target: { owner: string; actor: string; lifecycleUid: string }) => Promise<number | null> | number | null;
  },
): Promise<{ won: boolean; fact: GoalResultFact; status: GoalStatusValue }> {
  assertSafeInt(args.now, "now");
  const spec = await readGoalSpec(kv, args.ref);
  if (spec === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${args.ref.goalId}" has no accepted spec; a terminal commits only for an accepted goal (SPEC 13.6)`);
  if (spec.value.target !== undefined) {
    if (args.executor === undefined || typeof args.executor.lifecycleUid !== "string" || !Number.isSafeInteger(args.executor.epoch) || args.executor.epoch < 0)
      throw new EpEnvelopeError("failed-precondition", `goal "${args.ref.goalId}" is pinned to a target lifecycle; committing requires the executor's authenticated (lifecycleUid, epoch) (SPEC 13.6)`);
    if (typeof args.resolveCurrentEpoch !== "function")
      throw new EpEnvelopeError("failed-precondition", `goal "${args.ref.goalId}" is pinned to a target lifecycle; committing requires a fresh-epoch resolver (SPEC 13.6: a superseded epoch cannot commit transitions)`);
    if (args.executor.lifecycleUid !== spec.value.target.lifecycleUid)
      throw new EpEnvelopeError("expired", `the goal was accepted against lifecycle ${spec.value.target.lifecycleUid} but the executor is ${args.executor.lifecycleUid}; a goal is never effectful against a same-name successor (SPEC 13.6)`);
    const current = await args.resolveCurrentEpoch(spec.value.target);
    if (current !== null && (typeof current !== "number" || !Number.isSafeInteger(current) || current < 0))
      throw new EpEnvelopeError("internal", `the fresh-epoch resolver returned ${JSON.stringify(current)}; a non-integer epoch never authorizes (SPEC 13.6)`);
    if (current === null)
      throw new EpEnvelopeError("expired", `the target lifecycle is retired/unknown; a retired executor cannot commit (SPEC 13.6)`);
    if (current !== args.executor.epoch)
      throw new EpEnvelopeError("expired", `the executor carries epoch ${args.executor.epoch} but the current process epoch is ${current}; a superseded epoch cannot commit transitions (SPEC 13.6)`);
  } else if (args.executor !== undefined || args.resolveCurrentEpoch !== undefined) {
    throw new EpEnvelopeError("failed-precondition", `goal "${args.ref.goalId}" pins no target lifecycle; an executor/resolver here indicates a wiring confusion, refused (SPEC 13.6)`);
  }
  // Snapshot the payload to an immutable strict-canonical copy BEFORE digesting/publishing, so
  // the tombstone digest and the carried data can never diverge under a concurrent mutation.
  const data: unknown = args.data === undefined ? undefined : JSON.parse(canonicalJson(args.data));
  const fact: GoalResultFact = {
    v: 1, goalId: args.ref.goalId, fingerprint: spec.value.fingerprint, state: args.state,
    outcomeDigest: contractDigest(data === undefined ? null : data),
    ...(data !== undefined ? { data } : {}), ts: args.now,
  };
  const subject = goalResultSubject(space, args.ref);
  const res = await publishCreateOnly(js, subject, new TextEncoder().encode(JSON.stringify(fact)));
  const winner = res.won ? fact : await readGoalResult(jsm, space, args.ref);
  if (winner === undefined)
    throw new EpEnvelopeError("internal", `the goal terminal CAS for ${subject} was lost but no winning fact is readable (SPEC 13.4)`);
  const status = await projectGoalTerminal(kv, jsm, space, args.ref);
  return { won: res.won, fact: winner, status };
}

// ---- cancel (§13.6 item 4) --------------------------------------------------------------------

/** The reverse-DNS detail kind carrying a goal's cached terminal fact on an error (§13.3). */
export const GOAL_TERMINAL_DETAIL_KIND = "ai.cotal.goal.terminal";

function alreadyTerminal(goalId: string, fact: GoalResultFact): EpEnvelopeError {
  // The cached outcome rides the error's details[] so it SURVIVES toEpError() onto the wire
  // (SPEC 13.6 item 4: failed-precondition with the cached outcome attached).
  return new EpEnvelopeError("failed-precondition",
    `goal "${goalId}" is already terminal (${fact.state}); the cached outcome is attached (SPEC 13.6)`,
    [{ kind: GOAL_TERMINAL_DETAIL_KIND, fact }]);
}

/** The reserved `cancel` command's handler seam. The goal ref derives STRUCTURALLY from the
 *  broker-authenticated request (§13.6: a caller cancels only its own goals; body fields never
 *  choose the target). An unknown goal is `failed-precondition`; a terminal goal is
 *  `failed-precondition` with the cached outcome attached as an `ai.cotal.goal.terminal` error
 *  detail (it survives the wire boundary). Otherwise the status transitions to `cancelling`
 *  recording the mode (`graceful` runs compensations, `terminate` does not) and the OWNER drives
 *  the actual stop, then commits `cancelled` at the shared commit point — where a racing
 *  completion may lawfully win first. A repeated/concurrent cancel is IDEMPOTENT (first mode
 *  wins); a completion fact that lands during the transition is observed AFTER it: the stale
 *  `cancelling` projection is immediately converged to the winner and the caller gets the
 *  terminal, never a dangling cancel. */
export async function requestGoalCancel(
  kv: KV,
  jsm: JetStreamManager,
  space: string,
  args: { request: ParsedEpRequest; goalId: string; mode: "graceful" | "terminate" },
): Promise<GoalStatusValue> {
  if (args.mode !== "graceful" && args.mode !== "terminate")
    throw new EpEnvelopeError("failed-precondition", `cancel mode must be "graceful" or "terminate"; got ${JSON.stringify(args.mode)} (SPEC 13.6)`);
  const ref = goalRefOf(args.request, args.goalId);
  const cached = await readGoalResult(jsm, space, ref);
  if (cached !== undefined) throw alreadyTerminal(ref.goalId, cached);
  let projected: GoalStatusValue | undefined;
  for (let pass = 0; pass < 2 && projected === undefined; pass++) {
    const status = await readGoalStatus(kv, ref);
    if (status === undefined)
      throw new EpEnvelopeError("failed-precondition", `goal "${ref.goalId}" is unknown; cancel addresses only an accepted goal (SPEC 13.6)`);
    if (status.value.state === "cancelling") { projected = status.value; break; } // idempotent: the first mode wins
    if (GOAL_TERMINAL_STATES.includes(status.value.state)) {
      const fact = await readGoalResult(jsm, space, ref);
      if (fact === undefined)
        throw new EpEnvelopeError("internal", `goal "${ref.goalId}" status is terminal but no result fact is readable; a projection never leads the journal (SPEC 13.6)`);
      throw alreadyTerminal(ref.goalId, fact);
    }
    try { projected = await transitionGoal(kv, ref, "cancelling", { cancelMode: args.mode }); }
    catch (e) { if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e; } // a concurrent cancel/advance raced; re-read and re-decide
  }
  if (projected === undefined)
    throw new EpEnvelopeError("conflict", `the goal status for "${ref.goalId}" moved twice during one cancel; re-read and re-decide (SPEC 13.4)`);
  // Completion races cancel at the COMMIT point, not here: a fact that landed while we projected
  // `cancelling` has already won. Observe it, converge the stale projection, report the winner.
  const raced = await readGoalResult(jsm, space, ref);
  if (raced !== undefined) {
    await projectGoalTerminal(kv, jsm, space, ref);
    throw alreadyTerminal(ref.goalId, raced);
  }
  return projected;
}

// ---- bounded readiness (§13.6 item 6) ----------------------------------------------------------

/** Settle a goal `uncertain` when its ACCEPTANCE-RELATIVE readiness deadline passed without the
 *  success signal (the owner's clock decides). The bound is read from the PERSISTED spec — a
 *  goal that declared no readiness deadline can never be settled uncertain, and supplied
 *  coordinates never substitute for accepted ones. `uncertain` is a terminal outcome like any
 *  other — immutable, first-terminal-fact-wins — so a racing late success that commits first
 *  lawfully wins and this settle returns the winner instead. Settling BEFORE the deadline is
 *  refused: the bound is the contract, not a hint. */
export async function settleGoalUncertain(
  kv: KV,
  js: JetStreamClient,
  jsm: JetStreamManager,
  space: string,
  args: { ref: GoalRef; now: number },
): Promise<{ won: boolean; fact: GoalResultFact; status: GoalStatusValue }> {
  assertSafeInt(args.now, "now");
  const spec = await readGoalSpec(kv, args.ref);
  if (spec === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${args.ref.goalId}" has no accepted spec; only an accepted goal settles (SPEC 13.6)`);
  if (spec.value.readinessDeadlineMs === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${args.ref.goalId}" declares no readiness deadline; an unbounded goal is never settled uncertain (SPEC 13.6)`);
  if (args.now < spec.value.acceptedAt + spec.value.readinessDeadlineMs)
    throw new EpEnvelopeError("failed-precondition", `goal "${args.ref.goalId}" is not past its readiness deadline (acceptedAt ${spec.value.acceptedAt} + ${spec.value.readinessDeadlineMs}ms > now ${args.now}); an early uncertain settle would steal a still-possible success (SPEC 13.6)`);
  return commitGoalResult(kv, js, jsm, space, {
    ref: args.ref, state: "uncertain",
    data: { reason: "the success signal did not arrive within the readiness deadline", readinessDeadlineMs: spec.value.readinessDeadlineMs },
    now: args.now,
  });
}

// ---- goalId reuse (§13.6 item 5) ---------------------------------------------------------------

/** Classify a resubmission against the recorded bind: the SAME fingerprint is the caller's
 *  retry (serve the cached decision/outcome; after payload eviction, {@link goalTombstone});
 *  a DIFFERENT fingerprint is `conflict`. Beyond the idempotency horizon the bind fact has
 *  expired with its retention, the CAS is virgin again, and a reused goalId is explicitly NEW
 *  work — that path never reaches this classifier. {@link resolveGoalSubmission} composes this
 *  with the orphaned-bind recovery. */
export function classifyGoalReuse(existing: GoalBindFact, submittedFingerprint: string): "cached" | "conflict" {
  return existing.fingerprint === submittedFingerprint ? "cached" : "conflict";
}
