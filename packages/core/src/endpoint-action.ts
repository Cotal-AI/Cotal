/**
 * The ACTION composite (SPEC §13.6): a long-running command as a pattern over the journal +
 * records + events — zero new transport. `action` is a command MARKER, never a class: an
 * action's submissions are `class: journal`, its accept/reject is the durable decision fact
 * (§13.4), and there is no reply-rail answer to recover.
 *
 * THE RESULT FACT IS THE SINGLE TERMINAL ARBITER; THE STATUS ONLY EVER FOLLOWS IT, and every
 * authority coordinate is bound to the PERSISTED accepted goal, never a caller claim. The
 * pieces, each owned by the §13.9 principal named on its row:
 *  - the GOAL BIND (canonicalizer): a create-only CAS on
 *    `epf.<e>.goal.<caller triple>.<goalId>.bind` carrying the accepted fingerprint, BEFORE
 *    acceptance — the bind keys on `goalId` and stops a second distinct submission before
 *    acceptance and effect. A bind whose winner crashed BEFORE acceptance (no goal record) is
 *    ORPHANED, and a same-fingerprint resubmission ADOPTS it ({@link resolveGoalSubmission}).
 *  - the GOAL RECORD (commit path): `goal.<e>.<caller triple>.<goalId>` spec (the accepted
 *    definition — the trusted source every later seam validates against) + status (the CURRENT
 *    state projection). The status vocabulary is `accepted → running ⇄ waiting → terminal`,
 *    `cancelling` between a cancel and its terminal. A TERMINAL status exists ONLY as the
 *    projection of the committed result fact ({@link projectGoalTerminal}); {@link
 *    transitionGoal} refuses terminal targets, so the status never leads the journal. Every
 *    EXECUTOR-authored transition on a TARGET-PINNED goal proves the executor's fresh
 *    lifecycle/epoch currency (§13.6 item 7: a superseded epoch cannot commit transitions).
 *  - the TERMINAL RESULT (commit path): a create-only CAS on
 *    `epf.<e>.goal.<caller triple>.<goalId>.result` — the ONE commit point where completion,
 *    cancel, expiry-deny, and the readiness `uncertain` settle race, first terminal fact wins
 *    uniformly. The raw CAS is PRIVATE; the public commit takes a CLOSED CAUSE whose
 *    authoritative predicate is verified INSIDE the boundary (a `complete` proves executor
 *    currency, a `cancel` proves the goal is `cancelling`, a `readiness` proves the deadline
 *    passed) and DERIVES the terminal state from the cause — a raw state is never accepted.
 *  - the TOMBSTONE (§13.6 item 5): the summary lives INSIDE the one immutable result fact;
 *    retaining the fact the full idempotency horizon satisfies both retention minimums, and
 *    early payload eviction is a serving-layer policy answered with {@link goalTombstone}.
 *  - PROGRESS rides per-goal events, read-scoped to the caller at mint time.
 *
 * Every seam takes a BRANDED {@link ActionContext} bonding the record store + fact stream +
 * space, so a composition mixup cannot read an accepted spec from space A and project through
 * space B. Clocks are inputs everywhere (`now`, `acceptedAt`): the owner's clock decides.
 */
import type { KV } from "@nats-io/kv";
import { jetstream, jetstreamManager, type JetStreamClient, type JetStreamManager } from "@nats-io/jetstream";
import { headers as natsHeaders, type NatsConnection } from "@nats-io/transport-node";
import { canonicalJson, contractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { epfSubject, assertIdToken, endpointToken, type EpCaller, type ParsedEpRequest } from "./endpoint-subjects.js";
import { RECORD_KINDS, recordSpecKey, recordStatusKey, recordAtomicKey, createRecordEntry, updateRecordEntry, assertStatusValue, openRecordsBucket, readRecordLeader } from "./endpoint-records.js";
import { epfStreamName, epfGoalBindSubject, readLastFact, parseDecisionFact } from "./endpoint-journal.js";
import { readCheckpointSpec, readCheckpointSettle } from "./endpoint-checkpoint.js";
import {
  mintReceiptFromFacts, receiptOutcomeOfGoal, publishReceipt, readReceipt,
  assertReceiptAttestsSameFacts, assertReceiptStoreContext, assertReceiptStoreConnection,
  type Receipt, type ReceiptStoreContext,
} from "./endpoint-receipt.js";

/** A trusted, space-bonded action context: the KV + JS + JSM all DERIVE from one binding-layer
 *  connection and one space by the constructor (never injected independently — a branded bundle
 *  of split resources would still split accepted state from terminal authority), so a
 *  composition mixup can never read an accepted spec through one broker and commit its terminal
 *  through another. BRANDED: a hand-assembled structural look-alike is rejected at every seam,
 *  not just discouraged. */
export interface ActionContext {
  kv: KV;
  js: JetStreamClient;
  jsm: JetStreamManager;
  space: string;
}
const BRANDED_CONTEXTS = new WeakSet<ActionContext>();
/** The context's source connection, held privately for the §13.4 one-connection bond: emission
 *  wiring proves its receipt store derives from EXACTLY this connection, so a same-space store
 *  on a different broker (which passes any string-space compare) can never splice receipts
 *  across brokers. */
const ACTION_CONNECTIONS = new WeakMap<ActionContext, NatsConnection>();
export async function actionContext(nc: NatsConnection, space: string): Promise<ActionContext> {
  if (nc === null || typeof nc !== "object" || typeof (nc as unknown as { close?: unknown }).close !== "function")
    throw new EpEnvelopeError("failed-precondition", "an action context is constructed from ONE binding-layer connection; separate resources are never accepted (SPEC 13.4)");
  if (typeof space !== "string" || space.length === 0) throw new EpEnvelopeError("failed-precondition", "an action context needs a space");
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const kv = await openRecordsBucket(nc, space);
  const ctx = Object.freeze({ kv, js, jsm, space });
  BRANDED_CONTEXTS.add(ctx);
  ACTION_CONNECTIONS.set(ctx, nc);
  return ctx;
}
function assertCtx(ctx: ActionContext): void {
  if (!BRANDED_CONTEXTS.has(ctx))
    throw new EpEnvelopeError("failed-precondition", `the action context was not constructed by actionContext(); a hand-assembled resource bundle never authorizes - the space bond is constructed, not asserted (SPEC 13.4)`);
}

/** A CONSTRUCTION-BOUND owner-authority proof: minted only from the branded context by the
 *  commit principal itself, and accepted only against THAT context. This replaces a raw
 *  `ownerAuthored` boolean — a flag any caller could set by typo or confusion — with a value
 *  that cannot be hand-assembled and cannot leak across contexts: owner authority over a
 *  target-pinned goal's pause/deny is proven by construction, never asserted (SPEC 13.6). */
export interface OwnerCommitProof { readonly space: string }
const OWNER_PROOFS = new WeakMap<OwnerCommitProof, ActionContext>();
export function ownerCommitProof(ctx: ActionContext): OwnerCommitProof {
  assertCtx(ctx);
  const proof: OwnerCommitProof = Object.freeze({ space: ctx.space });
  OWNER_PROOFS.set(proof, ctx);
  return proof;
}
/** `false` = no proof presented; `true` = a genuine proof minted from THIS context. A proof
 *  from any other (or hand-assembled) source is a loud refusal, never a silent downgrade. */
function assertOwnerProof(proof: OwnerCommitProof | undefined, ctx: ActionContext, what: string): boolean {
  if (proof === undefined) return false;
  if (OWNER_PROOFS.get(proof) !== ctx)
    throw new EpEnvelopeError("permission-denied", `${what} presents an owner proof that was not minted from THIS action context (ownerCommitProof); owner authority is construction-bound, never a raw flag (SPEC 13.6)`);
  return true;
}

/** A GATE-MINTED clearance: the only key that opens a GUARDED goal's edge into `running`
 *  (SPEC 13.6: a guarded command MUST NOT effect until the guard answered allow, and `running`
 *  IS effecting). The mint lives behind a ONE-SHOT claim that THE guard gate module takes at
 *  load, so no other holder of an action context can mint gate passage - an owner proof
 *  deliberately does NOT satisfy this edge (any context holder mints owner proofs; only the
 *  gate, whose allow/release/reconcile arms verified the guard's answer, mints clearance). */
export interface GuardClearance { readonly goalId: string }
const GUARD_CLEARANCES = new WeakMap<GuardClearance, ActionContext>();
let clearanceMintClaimed = false;
/** ONE-SHOT handoff of the clearance mint to THE gate (endpoint-guard claims it at module
 *  load; the package always loads it). Every later call is a loud refusal: there is exactly
 *  one gate, so a second claimant is by definition not it (SPEC 13.6). */
export function claimGuardClearanceMint(): (ctx: ActionContext, goalId: string) => GuardClearance {
  if (clearanceMintClaimed)
    throw new EpEnvelopeError("permission-denied", "the guard-clearance mint is already claimed by THE gate; a guarded goal's edge into running opens only through it (SPEC 13.6)");
  clearanceMintClaimed = true;
  return (ctx, goalId) => {
    assertCtx(ctx);
    const clearance: GuardClearance = Object.freeze({ goalId: assertIdToken(goalId, "goalId") });
    GUARD_CLEARANCES.set(clearance, ctx);
    return clearance;
  };
}
/** Verify a presented clearance against THIS context and THIS goal. A clearance is never
 *  ignored: presenting an invalid one is a loud refusal even where none was required. */
function assertGuardClearance(clearance: GuardClearance, ctx: ActionContext, goalId: string, what: string): void {
  if (GUARD_CLEARANCES.get(clearance) !== ctx || clearance.goalId !== goalId)
    throw new EpEnvelopeError("permission-denied", `${what} presents a guard clearance that was not minted by THE gate from THIS context for THIS goal; gate passage is construction-bound, never asserted (SPEC 13.6)`);
}

/** A goal's coordinates: the owning endpoint + the caller triple + the client-chosen goalId. */
export interface GoalRef {
  endpoint: string;
  caller: EpCaller;
  goalId: string;
}

/** Snapshot a caller-supplied ref to a validated DETACHED copy at seam entry, BEFORE the first
 *  await: a shared mutable ref can otherwise split one operation's identity across its reads,
 *  its CAS, and its terminal publish. Exported for the guard seams, which detach the goal they
 *  bind, resume, and project against the same discipline. */
export function snapshotRef(ref: GoalRef): GoalRef {
  const c = ref?.caller;
  if (ref === null || typeof ref !== "object" || typeof ref.endpoint !== "string"
    || c === null || typeof c !== "object" || typeof c.owner !== "string" || typeof c.actor !== "string" || typeof c.uid !== "string")
    throw new EpEnvelopeError("failed-precondition", "a goal ref must carry a string endpoint and a full caller triple (SPEC 13.2)");
  return { endpoint: ref.endpoint, caller: { owner: c.owner, actor: c.actor, uid: c.uid }, goalId: assertIdToken(ref.goalId, "goalId") };
}

/** Derive a goal ref STRUCTURALLY from the broker-authenticated request (§13.6): the caller
 *  triple comes from the subject the broker admitted, DETACHED so a later mutation of the parsed
 *  request cannot retarget it, never from body fields — a seam taking this ref addresses only
 *  the authenticated caller's own goals. */
export function goalRefOf(request: ParsedEpRequest, goalId: string): GoalRef {
  const c = request.caller;
  return { endpoint: request.endpoint, caller: { owner: c.owner, actor: c.actor, uid: c.uid }, goalId: assertIdToken(goalId, "goalId") };
}

/** The goal's terminal-result fact subject — the ONE subject SPEC:1433 reserves (§13.2 reserved subjects, `goal.<cOwner>.<cActor>.<cUid>.<goalId>.result`),
 *  `epf.<e>.goal.<cOwner>.<cActor>.<cUid>.<goalId>.result`, with NO epoch token.
 *
 *  An earlier revision epoch-scoped this (`…result.<execEpoch>`) to fence a live-superseded
 *  committer by giving each executor epoch its own create-only subject. That was non-conformant
 *  AND wrong: the window it addressed is "commit the fact, then die before the projection", where
 *  the pre-restart fact is the LEGITIMATE outcome, not a corpse's guess. Scoping by epoch hid that
 *  winner from every post-restart reader, let the successor commit a SECOND contradictory terminal
 *  at the new epoch, and surfaced the wrong one to callers (executed repro: a real `succeeded`
 *  read back as `uncertain`). One goal has one terminal, on one subject, first-fact-wins globally.
 *  The fence against a superseded committer is the §13.1 takeover barrier, which revokes and
 *  cluster-verify-evicts the family BEFORE it advances the process epoch. */
export function goalResultSubject(space: string, ref: GoalRef): string {
  return epfSubject(space, ref.endpoint, ["goal", ref.caller.owner, ref.caller.actor, ref.caller.uid, ref.goalId, "result"]);
}

/** The per-goal progress EVENT topic tail (§13.2 reserved topics). */
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

function assertClosedKeys(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o))
    if (!allowed.includes(k))
      throw new EpEnvelopeError("internal", `${what} carries unknown field ${JSON.stringify(k)}; a closed schema admits no extras - garbled state never authorizes (SPEC 13.4)`);
}

/** Bound an executor-epoch resolver await: past the budget the caller REFUSES `unavailable`
 *  (fail-closed, retryable) instead of hanging. Races `Promise.resolve` unconditionally so a
 *  non-native thenable cannot bypass the deadline. */
async function resolveWithBudget(p: Promise<number | null> | number | null, budgetMs: number): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EpEnvelopeError("unavailable", `the executor-epoch resolver did not answer within ${budgetMs}ms; a stuck lifecycle authority is a bounded refusal, never a hung transition (SPEC 13.6)`)), budgetMs);
  });
  try { return await Promise.race([Promise.resolve(p), deadline]); } finally { clearTimeout(timer); }
}

// ---- the goal bind (§13.4 item 3, canonicalizer-owned) ---------------------------------------

/** The bind fact: the goalId's accepted fingerprint, immutable for the goal's lifetime. */
export interface GoalBindFact { v: 1; goalId: string; fingerprint: string }

function parseBind(raw: unknown, subject: string, goalId: string): GoalBindFact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `goal-bind fact on ${subject} is not an object; garbled mediated fact state never authorizes (SPEC 13.4)`);
  const o = raw as Record<string, unknown>;
  assertClosedKeys(o, ["v", "goalId", "fingerprint"], `goal-bind fact on ${subject}`);
  if (o.v !== 1 || typeof o.goalId !== "string" || typeof o.fingerprint !== "string" || o.fingerprint.length === 0)
    throw new EpEnvelopeError("internal", `goal-bind fact on ${subject} is malformed; garbled state never authorizes (SPEC 13.4)`);
  if (o.goalId !== goalId)
    throw new EpEnvelopeError("internal", `goal-bind fact on ${subject} names goalId ${JSON.stringify(o.goalId)}, not its subject's ${goalId}; a mis-subjected fact never authorizes (SPEC 13.4)`);
  return { v: 1, goalId: o.goalId, fingerprint: o.fingerprint };
}

/** Bind a goal to its accepted fingerprint BEFORE acceptance (the canonicalizer's seam): a
 *  create-only CAS per goalId. The winner proceeds; a loser reads the recorded bind and decides
 *  (same fingerprint = retry, different = `conflict` before acceptance and effect). The subject
 *  derives from the goal ref — ONE entry-derived identity (a caller derives it from the
 *  broker-authenticated request via {@link goalRefOf} exactly once), never body fields. */
export async function bindGoal(
  ctx: ActionContext,
  ref: GoalRef,
  fingerprint: string,
): Promise<{ bound: true } | { bound: false; existing: GoalBindFact }> {
  assertCtx(ctx);
  const snap = snapshotRef(ref);
  const goalId = snap.goalId;
  if (typeof fingerprint !== "string" || fingerprint.length === 0)
    throw new EpEnvelopeError("failed-precondition", "a goal bind needs a non-empty fingerprint (SPEC 13.4)");
  const subject = epfGoalBindSubject(ctx.space, snap, goalId);
  const fact: GoalBindFact = { v: 1, goalId: assertIdToken(goalId, "goalId"), fingerprint };
  const res = await publishCreateOnly(ctx.js, subject, new TextEncoder().encode(JSON.stringify(fact)));
  if (res.won) return { bound: true };
  const raw = await readLastFact(ctx.jsm, epfStreamName(ctx.space), subject);
  if (raw === undefined)
    throw new EpEnvelopeError("internal", `the goal-bind CAS for ${subject} was lost but no winning fact is readable (SPEC 13.4)`);
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

/** Resolve a goal submission against the bind rail (the canonicalizer's composed seam): NEW
 *  work (bind won); the caller's retry serving the CACHED decision/outcome (same fingerprint +
 *  a persisted goal whose spec AGREES with the bind); orphan ADOPTION (same fingerprint, no goal
 *  record — the bind winner crashed pre-acceptance); or `conflict` (different fingerprint). A
 *  persisted spec whose fingerprint disagrees with the bind is a loud `internal` (garbled
 *  authority chain), never a silent cached serve. */
export async function resolveGoalSubmission(
  ctx: ActionContext,
  request: ParsedEpRequest,
  goalId: string,
  fingerprint: string,
): Promise<GoalSubmissionVerdict> {
  // ONE entry-derived identity: the ref derives from the broker-authenticated request EXACTLY
  // ONCE, BEFORE any await, and the bind, the spec read, and the result read all use this
  // detached snapshot — a mutable request can never bind caller A and then serve caller B's
  // cached outcome from the post-await reads.
  const ref = snapshotRef(goalRefOf(request, goalId));
  const bound = await bindGoal(ctx, ref, fingerprint);
  if (bound.bound) return { kind: "new" };
  if (bound.existing.fingerprint !== fingerprint) return { kind: "conflict", bind: bound.existing };
  const spec = await readGoalSpec(ctx, ref);
  if (spec === undefined) return { kind: "adopted", bind: bound.existing };
  if (spec.value.fingerprint !== bound.existing.fingerprint)
    throw new EpEnvelopeError("internal", `goal "${ref.goalId}" has a persisted spec fingerprint that disagrees with its bind fact; the authority chain (bind = spec) is broken - never serve a cached outcome over it (SPEC 13.4/13.6)`);
  const result = await readGoalResult(ctx, ref);
  // The cached outcome must complete the SAME authority chain: bind = spec = result. A result
  // fact whose fingerprint disagrees with the accepted spec (digest-consistent or not) is a
  // foreign outcome and is never served as this goal's cached decision.
  if (result !== undefined && result.fingerprint !== spec.value.fingerprint)
    throw new EpEnvelopeError("internal", `goal "${ref.goalId}" has a recorded result whose fingerprint disagrees with its accepted spec; a foreign-fingerprint fact is never served as the cached outcome (SPEC 13.4/13.6)`);
  return { kind: "cached", bind: bound.existing, ...(result !== undefined ? { result } : {}) };
}

// ---- the goal record: spec + status projection (§13.6 item 2/3, commit-path-owned) -----------

/** The §13.6 single status vocabulary for every long-running surface. */
export const GOAL_STATES = Object.freeze(["accepted", "running", "waiting", "cancelling", "succeeded", "failed", "cancelled", "expired", "uncertain"] as const);
export type GoalState = (typeof GOAL_STATES)[number];
/** All five are TERMINAL and immutable; first-terminal-fact-wins applies uniformly. */
export const GOAL_TERMINAL_STATES: readonly GoalState[] = Object.freeze(["succeeded", "failed", "cancelled", "expired", "uncertain"]);

/** The legal §13.6 transitions: `accepted → running ⇄ waiting`, `cancelling` between a cancel
 *  and its terminal, every non-terminal may project a terminal, a terminal absorbs. */
export function isLegalGoalTransition(from: GoalState, to: GoalState): boolean {
  if (GOAL_TERMINAL_STATES.includes(from)) return false;
  if (GOAL_TERMINAL_STATES.includes(to)) return true;
  switch (from) {
    case "accepted": return to === "running" || to === "waiting" || to === "cancelling";
    case "running": return to === "waiting" || to === "cancelling";
    case "waiting": return to === "running" || to === "cancelling";
    case "cancelling": return false;
    default: return false;
  }
}

/** The goal SPEC (written once at acceptance): the accepted definition every later seam
 *  validates against — the terminal commit stamps ITS fingerprint from here, the readiness
 *  settle reads ITS bound from here, and a target-pinned goal fences on ITS target lifecycle. */
export interface GoalSpecValue {
  v: 1;
  goalId: string;
  fingerprint: string;
  command: string;
  caller: { id: string; lifecycleUid: string };
  target?: { owner: string; actor: string; lifecycleUid: string; mappingRevision: number };
  /** The ACCEPTING incarnation's process epoch (§13.1), recorded at acceptance. Paired with the
   *  terminal fact's {@link GoalResultFact.committer} epoch, it is what makes a terminal
   *  ATTRIBUTABLE: `committed == accepted` is the executor answering for its OWN work and stays
   *  valid FOREVER however far the current epoch advances (this is what keeps the legitimate
   *  pre-restart winner readable — the property HIGH-1 lost); `committed > accepted` is a
   *  successor settling inherited work; `committed < accepted` cannot happen and is refused as
   *  garbled. Present exactly when the endpoint commits under an epoch at all. */
  acceptedEpoch?: number;
  /** The accepted submission's request id — the goal's ADDRESS for its durable acceptance fact
   *  (`epf.<e>.dec.<triple>.<id>`), written at acceptance when it is known. The raw submission
   *  (EPJ) is age-evicted, so receipt reconstruction after a crash reads the acceptance THROUGH
   *  this address and proves the chain (id + sourceSeq + fingerprint) before minting (§13.10). */
  requestId: string;
  /** The guard endpoint named by the command's VERIFIED `ai.cotal.guarded` trait value,
   *  recorded at acceptance. Its PRESENCE is what {@link transitionGoal} enforces: a guarded
   *  goal's edge into `running` opens only with THE gate's {@link GuardClearance} - an
   *  unrecorded guard binding is unenforceable, so the acceptance path MUST record it
   *  (SPEC 13.6/13.7). */
  guard?: string;
  sourceSeq: number;
  acceptedAt: number;
  readinessDeadlineMs?: number;
}

/** Closed spec validation, identity-bound to the ref whose key it was read from (§13.4): the
 *  caller's lifecycle evidence MUST equal the subject's uid (a mis-attributed spec never
 *  authorizes). */
function parseSpec(raw: unknown, key: string, ref: GoalRef): GoalSpecValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `goal spec ${key} is not an object; garbled mediated record state never authorizes (SPEC 13.4)`);
  const o = raw as Record<string, unknown>;
  assertClosedKeys(o, ["v", "goalId", "fingerprint", "command", "caller", "target", "acceptedEpoch", "requestId", "guard", "sourceSeq", "acceptedAt", "readinessDeadlineMs"], `goal spec ${key}`);
  if (o.acceptedEpoch !== undefined && (typeof o.acceptedEpoch !== "number" || !Number.isSafeInteger(o.acceptedEpoch) || o.acceptedEpoch < 0))
    throw new EpEnvelopeError("internal", `goal spec ${key} acceptedEpoch is not an unsigned integer; garbled state never authorizes (SPEC 13.1/13.6)`);
  if (o.guard !== undefined && (typeof o.guard !== "string" || o.guard.length === 0))
    throw new EpEnvelopeError("internal", `goal spec ${key} carries a malformed guard binding; garbled state never authorizes (SPEC 13.4/13.6)`);
  if (o.v !== 1 || typeof o.goalId !== "string" || typeof o.fingerprint !== "string" || o.fingerprint.length === 0 || typeof o.command !== "string")
    throw new EpEnvelopeError("internal", `goal spec ${key} is malformed; garbled state never authorizes (SPEC 13.4)`);
  try { assertIdToken(o.requestId as string, "requestId"); }
  catch { throw new EpEnvelopeError("internal", `goal spec ${key} carries no valid requestId (the goal's address for its durable acceptance fact); garbled state never authorizes (SPEC 13.4/13.10)`); }
  if (o.goalId !== ref.goalId)
    throw new EpEnvelopeError("internal", `goal spec ${key} names goalId ${JSON.stringify(o.goalId)}, not its key's ${ref.goalId}; a mis-keyed record never authorizes (SPEC 13.4)`);
  const c = o.caller as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object" || typeof c.id !== "string" || typeof c.lifecycleUid !== "string")
    throw new EpEnvelopeError("internal", `goal spec ${key} carries no valid caller identity; garbled state never authorizes (SPEC 13.4)`);
  assertClosedKeys(c, ["id", "lifecycleUid"], `goal spec ${key} caller`);
  if (c.lifecycleUid !== ref.caller.uid)
    throw new EpEnvelopeError("internal", `goal spec ${key} caller lifecycle ${JSON.stringify(c.lifecycleUid)} is not its subject's uid ${ref.caller.uid}; a mis-attributed spec never authorizes (SPEC 13.4)`);
  if (c.id !== `${ref.caller.owner}.${ref.caller.actor}`)
    throw new EpEnvelopeError("internal", `goal spec ${key} caller id ${JSON.stringify(c.id)} does not name its subject's principal ${ref.caller.owner}.${ref.caller.actor}; a mis-attributed spec never authorizes (SPEC 13.4)`);
  for (const [n, v] of [["sourceSeq", o.sourceSeq], ["acceptedAt", o.acceptedAt]] as const)
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
      throw new EpEnvelopeError("internal", `goal spec ${key} field ${n} is not a safe integer; garbled state never authorizes (SPEC 13.4)`);
  if (o.readinessDeadlineMs !== undefined && (typeof o.readinessDeadlineMs !== "number" || !Number.isSafeInteger(o.readinessDeadlineMs) || o.readinessDeadlineMs <= 0))
    throw new EpEnvelopeError("internal", `goal spec ${key} readinessDeadlineMs is not a positive integer; garbled state never authorizes (SPEC 13.6)`);
  if (o.target !== undefined) {
    const t = o.target as Record<string, unknown>;
    if (t === null || typeof t !== "object")
      throw new EpEnvelopeError("internal", `goal spec ${key} target is not an object; garbled state never authorizes (SPEC 13.4)`);
    assertClosedKeys(t, ["owner", "actor", "lifecycleUid", "mappingRevision"], `goal spec ${key} target`);
    if (typeof t.owner !== "string" || typeof t.actor !== "string" || typeof t.lifecycleUid !== "string"
      || typeof t.mappingRevision !== "number" || !Number.isSafeInteger(t.mappingRevision) || t.mappingRevision < 0)
      throw new EpEnvelopeError("internal", `goal spec ${key} carries a malformed target tuple; garbled state never authorizes (SPEC 13.4)`);
  }
  return o as unknown as GoalSpecValue;
}

/** Read the persisted accepted goal (`undefined` = never accepted). A DEL marker refuses. */
export async function readGoalSpec(ctx: ActionContext, ref: GoalRef): Promise<{ value: GoalSpecValue; revision: number } | undefined> {
  assertCtx(ctx);
  const snap = snapshotRef(ref);
  const key = recordSpecKey(RECORD_KINDS.goal, goalQualifiers(snap));
  const entry = await ctx.kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the goal spec ${key} carries a ${entry.operation} marker; a deletion never erases an accepted goal - reconcile the store (SPEC 13.4)`);
  return { value: parseSpec(JSON.parse(new TextDecoder().decode(entry.value)), key, snap), revision: entry.revision };
}

/** The goal STATUS value: the current state projection. State-dependent fields are CLOSED. */
export interface GoalStatusValue extends Record<string, unknown> {
  state: GoalState;
  checkpoint?: { token: string; deadlineGeneration: number };
  cancelMode?: "graceful" | "terminate";
  observedSpecRevision: number;
}

/** Create the goal record at acceptance, IDEMPOTENTLY (spec create-only, then the `accepted`
 *  status): a crash between the two writes (or an adopted-retry replay) re-reads the spec,
 *  requires it CONTENT-IDENTICAL, and ensures the status — no stranded spec-only goal. */
export async function createGoal(ctx: ActionContext, ref: GoalRef, spec: Omit<GoalSpecValue, "v" | "goalId">): Promise<{ specRevision: number }> {
  assertCtx(ctx);
  const snap = snapshotRef(ref);
  const value: GoalSpecValue = { v: 1, goalId: snap.goalId, ...spec };
  const specKey = recordSpecKey(RECORD_KINDS.goal, goalQualifiers(snap));
  let specRevision: number;
  try {
    specRevision = await createRecordEntry(ctx.kv, specKey, value);
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    const existing = await readGoalSpec(ctx, snap);
    if (existing === undefined)
      throw new EpEnvelopeError("conflict", `the goal spec CAS for ${specKey} was lost but no record is readable; re-read and re-decide (SPEC 13.4)`);
    if (canonicalJson(existing.value) !== canonicalJson(value))
      throw new EpEnvelopeError("conflict", `goal "${snap.goalId}" already has a DIFFERENT accepted definition; one goalId never carries two specs (SPEC 13.6)`);
    specRevision = existing.revision;
  }
  const statusKey = recordStatusKey(RECORD_KINDS.goal, goalQualifiers(snap));
  const statusEntry = await ctx.kv.get(statusKey);
  if (!statusEntry || statusEntry.operation !== "PUT") {
    if (statusEntry && statusEntry.operation !== "PUT")
      throw new EpEnvelopeError("failed-precondition", `the goal status ${statusKey} carries a ${statusEntry.operation} marker; a deletion never erases a goal's projection (SPEC 13.4)`);
    try { await createRecordEntry(ctx.kv, statusKey, assertStatusValue({ state: "accepted", observedSpecRevision: specRevision })); }
    catch (e) { if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e; }
  }
  return { specRevision };
}

/** Closed, STATE-DEPENDENT status validation (§13.4/§13.6). */
function parseStatus(raw: unknown, key: string): GoalStatusValue {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `goal status ${key} is not an object; garbled mediated record state never authorizes (SPEC 13.4)`);
  const o = raw as Record<string, unknown>;
  assertClosedKeys(o, ["state", "checkpoint", "cancelMode", "observedSpecRevision"], `goal status ${key}`);
  if (typeof o.state !== "string" || !(GOAL_STATES as readonly string[]).includes(o.state))
    throw new EpEnvelopeError("internal", `goal status ${key} carries unknown state ${JSON.stringify(o.state)}; garbled state never authorizes (SPEC 13.6)`);
  if (typeof o.observedSpecRevision !== "number" || !Number.isSafeInteger(o.observedSpecRevision) || o.observedSpecRevision < 0)
    throw new EpEnvelopeError("internal", `goal status ${key} has no valid observedSpecRevision (SPEC 13.4)`);
  if (o.checkpoint !== undefined) {
    if (o.state !== "waiting")
      throw new EpEnvelopeError("internal", `goal status ${key} carries a checkpoint outside \`waiting\`; garbled cross-variant state never authorizes (SPEC 13.6)`);
    const cp = o.checkpoint as Record<string, unknown>;
    if (cp === null || typeof cp !== "object")
      throw new EpEnvelopeError("internal", `goal status ${key} checkpoint is not an object (SPEC 13.6)`);
    assertClosedKeys(cp, ["token", "deadlineGeneration"], `goal status ${key} checkpoint`);
    if (typeof cp.token !== "string" || cp.token.length === 0 || typeof cp.deadlineGeneration !== "number" || !Number.isSafeInteger(cp.deadlineGeneration) || cp.deadlineGeneration < 0)
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
export async function readGoalStatus(ctx: ActionContext, ref: GoalRef): Promise<{ value: GoalStatusValue; revision: number } | undefined> {
  assertCtx(ctx);
  const key = recordStatusKey(RECORD_KINDS.goal, goalQualifiers(snapshotRef(ref)));
  const entry = await ctx.kv.get(key);
  if (!entry) return undefined;
  if (entry.operation !== "PUT")
    throw new EpEnvelopeError("failed-precondition", `the goal status ${key} carries a ${entry.operation} marker; a deletion never erases a goal's projection - reconcile the store (SPEC 13.4)`);
  return { value: parseStatus(JSON.parse(new TextDecoder().decode(entry.value)), key), revision: entry.revision };
}

/** LEADER-SERVED goal reads for the FENCING paths (the H2 epoch-CAS gap): the status read that
 *  supplies a transition's CAS revision, and the spec read that gates a terminal commit's epoch
 *  proof, must be read-your-writes against the leader — PINNED here, never inherited. The
 *  records bucket is `allow_direct`, which invites follower-served Direct Gets; whether
 *  `kv.get` actually issues one is a CLIENT-VERSION accident (@nats-io/kv 3.4.0's open path
 *  happens to leave `direct` off and rides STREAM.MSG.GET today), and a fence must not rest on
 *  an accident a client upgrade silently flips: a stale revision only loses the CAS later, but
 *  the epoch proof PAIRED with that read would have validated against a superseded projection —
 *  the staleness the checkpoint arm-fence closed. Non-fencing reads stay on `kv.get` (the
 *  same split as the checkpoint module). */
async function readGoalSpecLeader(ctx: ActionContext, snap: GoalRef): Promise<{ value: GoalSpecValue; revision: number } | undefined> {
  const key = recordSpecKey(RECORD_KINDS.goal, goalQualifiers(snap));
  const entry = await readRecordLeader(ctx.jsm, ctx.space, key);
  return entry === undefined ? undefined : { value: parseSpec(entry.value, key, snap), revision: entry.revision };
}

async function readGoalStatusLeader(ctx: ActionContext, snap: GoalRef): Promise<{ value: GoalStatusValue; revision: number } | undefined> {
  const key = recordStatusKey(RECORD_KINDS.goal, goalQualifiers(snap));
  const entry = await readRecordLeader(ctx.jsm, ctx.space, key);
  return entry === undefined ? undefined : { value: parseStatus(entry.value, key), revision: entry.revision };
}

/** Leader-read a goal's status projection by ref ALONE (no {@link ActionContext}) — a fencing read
 *  for a caller OUTSIDE the action module. The retirement drain uses it to decide whether an
 *  accepted ACTION goal is still `accepted` (never entered `running`, the guard/currency-fenced
 *  effecting edge, so provably never effected) before it may create-only cancel it: a `cancelled`
 *  terminal must mean the effect did NOT run (SPEC 13.6). `undefined` = no goal record at all
 *  (never created ⇒ never ran). Leader-served (read-your-writes), so a running executor's
 *  transition is never missed as a stale absence and a mis-read never authorizes a false cancel. */
export async function readGoalStatusByRefLeader(jsm: JetStreamManager, space: string, ref: GoalRef): Promise<GoalStatusValue | undefined> {
  const key = recordStatusKey(RECORD_KINDS.goal, goalQualifiers(snapshotRef(ref)));
  const entry = await readRecordLeader(jsm, space, key);
  return entry === undefined ? undefined : parseStatus(entry.value, key);
}

/** The executor's authenticated identity (subject/creds, never a body claim), required when a
 *  goal's spec pins a target lifecycle (§13.6 item 7). */
export interface GoalExecutor { lifecycleUid: string; epoch: number }

/** Assert an EXECUTOR's fresh lifecycle/epoch currency against a target-pinned spec (§13.6 item
 *  7). A non-pinned goal accepts NO executor (a supplied one is a wiring confusion, refused). A
 *  pinned goal requires the executor's authenticated (lifecycleUid, epoch) plus a fresh-epoch
 *  resolver, and refuses a same-name successor (`expired`), a superseded/retired epoch
 *  (`expired`), a non-integer answer (`internal`), or a stuck resolver (`unavailable`). */
async function assertExecutorCurrency(
  spec: GoalSpecValue,
  goalId: string,
  executor: GoalExecutor | undefined,
  resolveCurrentEpoch: ((target: { owner: string; actor: string; lifecycleUid: string }) => Promise<number | null> | number | null) | undefined,
  budgetMs: number,
): Promise<void> {
  if (spec.target === undefined) {
    if (executor !== undefined || resolveCurrentEpoch !== undefined)
      throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" pins no target lifecycle; an executor/resolver here indicates a wiring confusion, refused (SPEC 13.6)`);
    return;
  }
  if (executor === undefined || typeof executor.lifecycleUid !== "string" || !Number.isSafeInteger(executor.epoch) || executor.epoch < 0)
    throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is pinned to a target lifecycle; this requires the executor's authenticated (lifecycleUid, epoch) (SPEC 13.6 item 7)`);
  if (typeof resolveCurrentEpoch !== "function")
    throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is pinned to a target lifecycle; this requires a fresh-epoch resolver (SPEC 13.6: a superseded epoch cannot commit transitions)`);
  if (executor.lifecycleUid !== spec.target.lifecycleUid)
    throw new EpEnvelopeError("expired", `goal "${goalId}" was accepted against lifecycle ${spec.target.lifecycleUid} but the executor is ${executor.lifecycleUid}; a goal is never effectful against a same-name successor (SPEC 13.6)`);
  const current = await resolveWithBudget(resolveCurrentEpoch(spec.target), budgetMs);
  if (current !== null && (typeof current !== "number" || !Number.isSafeInteger(current) || current < 0))
    throw new EpEnvelopeError("internal", `the fresh-epoch resolver returned ${JSON.stringify(current)}; a non-integer epoch never authorizes (SPEC 13.6)`);
  if (current === null)
    throw new EpEnvelopeError("expired", `goal "${goalId}"'s target lifecycle is retired/unknown; a retired executor cannot commit transitions (SPEC 13.6)`);
  if (current !== executor.epoch)
    throw new EpEnvelopeError("expired", `goal "${goalId}"'s executor carries epoch ${executor.epoch} but the current process epoch is ${current}; a superseded epoch cannot commit transitions (SPEC 13.6)`);
}

/** CAS the goal's status through the NON-TERMINAL machine. A TERMINAL target is REFUSED (a
 *  terminal status exists only as {@link projectGoalTerminal}). An EXECUTOR-authored PROGRESS
 *  transition (`running`/`waiting`) on a TARGET-PINNED goal MUST prove the executor's fresh
 *  currency; a `cancelling` transition is owner/caller-authored (its authority is the cancel's
 *  broker-authenticated caller, {@link requestGoalCancel}) and takes no executor; an OWNER pause
 *  (guard hold → `waiting`) may declare `ownerAuthored`. A target-pinned progress transition
 *  with neither executor nor `ownerAuthored` is refused. */
export async function transitionGoal(
  ctx: ActionContext,
  ref: GoalRef,
  to: GoalState,
  opts: {
    fields?: Partial<Pick<GoalStatusValue, "checkpoint" | "cancelMode">>;
    executor?: GoalExecutor;
    resolveCurrentEpoch?: (target: { owner: string; actor: string; lifecycleUid: string }) => Promise<number | null> | number | null;
    epochResolveBudgetMs?: number;
    /** The owner's own commit principal drives this (guard-hold pause/release): a
     *  CONSTRUCTION-BOUND {@link ownerCommitProof} from THIS context, never a raw flag. */
    owner?: OwnerCommitProof;
    /** THE gate's construction-bound {@link GuardClearance} - REQUIRED on a GUARDED goal's
     *  edge into `running` (SPEC 13.6 MUST-NOT-effect-until-allow; an owner proof does NOT
     *  satisfy this edge, since any context holder mints owner proofs). */
    clearance?: GuardClearance;
  } = {},
): Promise<GoalStatusValue> {
  assertCtx(ctx);
  // ENTRY SNAPSHOT (single-read, before the first await): the ref, the executor, the resolver
  // reference, the owner proof, the gate clearance, and the projected fields all detach here —
  // nothing below reads `opts` again, so a caller mutating it across an await cannot move an
  // authority coordinate (an ownerAuthored false→true flip mid-read was exactly such a bypass).
  const snap = snapshotRef(ref);
  const executor = opts.executor !== undefined ? { lifecycleUid: String(opts.executor.lifecycleUid), epoch: opts.executor.epoch } : undefined;
  const resolveCurrentEpoch = opts.resolveCurrentEpoch;
  const ownerAuthored = assertOwnerProof(opts.owner, ctx, `the transition of goal "${snap.goalId}"`);
  const clearance = opts.clearance;
  // A presented clearance is NEVER ignored: verify it against THIS context and THIS goal up
  // front (a hand-assembled or foreign proof is a loud refusal on every edge, not only the
  // guarded one). Whether one is REQUIRED is decided below against the accepted spec.
  if (clearance !== undefined) assertGuardClearance(clearance, ctx, snap.goalId, `the transition of goal "${snap.goalId}"`);
  const budget = opts.epochResolveBudgetMs ?? 5_000;
  if (!Number.isSafeInteger(budget) || budget <= 0)
    throw new EpEnvelopeError("failed-precondition", `epochResolveBudgetMs must be a positive integer; got ${JSON.stringify(opts.epochResolveBudgetMs)}`);
  const fieldsIn = opts.fields;
  const checkpointIn = fieldsIn?.checkpoint;
  const fields: Partial<Pick<GoalStatusValue, "checkpoint" | "cancelMode">> = {
    ...(checkpointIn !== undefined ? { checkpoint: { token: String(checkpointIn.token), deadlineGeneration: checkpointIn.deadlineGeneration } } : {}),
    ...(fieldsIn?.cancelMode !== undefined ? { cancelMode: fieldsIn.cancelMode } : {}),
  };
  if (GOAL_TERMINAL_STATES.includes(to))
    throw new EpEnvelopeError("failed-precondition", `a goal status never transitions to terminal "${to}" directly; commit the result fact and project it - the journal owns terminals (SPEC 13.6)`);
  const spec = await readGoalSpec(ctx, snap);
  if (spec === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${snap.goalId}" is unknown; a transition projects only an accepted goal (SPEC 13.6)`);
  // THE structural guard fence (SPEC 13.6: a guarded command MUST NOT effect until the guard
  // answered allow; `running` IS effecting): a goal whose ACCEPTED record binds a guard opens
  // its edge into `running` only with THE gate's clearance. This closes BOTH public bypasses -
  // the unpinned edge (no proof at all) and the pinned+owner edge (any context holder mints
  // owner proofs; the gate's own allow/release/reconcile arms are the only clearance minters).
  if (to === "running" && spec.value.guard !== undefined && clearance === undefined)
    throw new EpEnvelopeError("permission-denied", `goal "${snap.goalId}" is guarded by "${spec.value.guard}" and MUST NOT effect until that guard answered allow; only THE gate's clearance opens its edge into running - an owner proof or executor currency alone never does (SPEC 13.6)`);
  const isProgress = to === "running" || to === "waiting";
  let needsCurrency = false;
  if (isProgress && spec.value.target !== undefined) {
    if (executor === undefined && !ownerAuthored)
      throw new EpEnvelopeError("failed-precondition", `goal "${snap.goalId}" is target-pinned; an executor-authored progress transition to "${to}" must prove the executor's fresh currency (or present the owner's construction-bound proof) - a superseded epoch cannot commit transitions (SPEC 13.6 item 7)`);
    needsCurrency = executor !== undefined;
  } else if (executor !== undefined || resolveCurrentEpoch !== undefined) {
    throw new EpEnvelopeError("failed-precondition", `a transition to "${to}"${spec.value.target === undefined ? " on a non-target goal" : ""} takes no executor/resolver (SPEC 13.6)`);
  }
  for (let pass = 0; pass < 2; pass++) {
    // LEADER-SERVED (H2): this read supplies the CAS revision below AND pairs the currency
    // proof; a follower-served revision would let the proof validate against a superseded
    // projection and only find out at the CAS. The fence reads its coordinate from the leader.
    const current = await readGoalStatusLeader(ctx, snap);
    if (current === undefined)
      throw new EpEnvelopeError("failed-precondition", `goal "${snap.goalId}" is unknown; a transition projects only an accepted goal (SPEC 13.6)`);
    if (!isLegalGoalTransition(current.value.state, to))
      throw new EpEnvelopeError("failed-precondition", `goal "${snap.goalId}" cannot transition ${current.value.state} -> ${to} (SPEC 13.6: accepted -> running <-> waiting -> terminal, cancelling between a cancel and its terminal; terminals are immutable)`);
    // The currency check is PAIRED 1:1 with its CAS attempt, immediately before it: a lost CAS
    // re-reads the status AND re-proves the executor's epoch, so a takeover landing between
    // attempts refuses on the retry instead of committing on a stale first resolve (SPEC 13.6
    // item 7: a superseded epoch cannot commit transitions).
    if (needsCurrency) await assertExecutorCurrency(spec.value, snap.goalId, executor, resolveCurrentEpoch, budget);
    const next: GoalStatusValue = assertStatusValue({
      state: to,
      ...(to === "waiting" && fields.checkpoint !== undefined ? { checkpoint: fields.checkpoint } : {}),
      ...(to === "cancelling" && fields.cancelMode !== undefined ? { cancelMode: fields.cancelMode } : {}),
      observedSpecRevision: current.value.observedSpecRevision,
    });
    try { await updateRecordEntry(ctx.kv, recordStatusKey(RECORD_KINDS.goal, goalQualifiers(snap)), next, current.revision); return next; }
    catch (e) { if (e instanceof EpEnvelopeError && e.code === "conflict") continue; throw e; }
  }
  throw new EpEnvelopeError("conflict", `the goal status for "${snap.goalId}" moved twice during one transition; re-read and re-decide (SPEC 13.4)`);
}

/** Project the WINNING terminal fact onto the status — the ONLY path a status reaches a terminal
 *  state, and the crash reconciler for a commit that fenced the fact but died before projecting.
 *  Cross-checks the fact's fingerprint against the persisted spec (a terminal fact whose
 *  fingerprint disagrees with the accepted goal is a garbled authority chain). One goal has ONE
 *  terminal subject (§13.2 reserved subjects), so the projection follows the one committed fact — there is no
 *  epoch to resolve and no per-epoch variant of "the winner". */
export async function projectGoalTerminal(ctx: ActionContext, ref: GoalRef): Promise<GoalStatusValue> {
  assertCtx(ctx);
  const snap = snapshotRef(ref);
  const spec = await readGoalSpec(ctx, snap);
  if (spec === undefined)
    throw new EpEnvelopeError("internal", `goal "${snap.goalId}" has a terminal fact but no accepted spec; garbled state never authorizes (SPEC 13.4)`);
  const subject = goalResultSubject(ctx.space, snap);
  const raw = await readLastFact(ctx.jsm, epfStreamName(ctx.space), subject);
  const fact = raw === undefined ? undefined : parseGoalResultFact(raw, subject, snap);
  if (fact === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${snap.goalId}" has no terminal fact; only a committed result projects a terminal status (SPEC 13.6)`);
  if (fact.fingerprint !== spec.value.fingerprint)
    throw new EpEnvelopeError("internal", `goal "${snap.goalId}"'s terminal fact fingerprint disagrees with its accepted spec; a projection never follows a garbled fact (SPEC 13.6)`);
  assertTerminalAttribution(fact, spec.value, snap.goalId);
  const key = recordStatusKey(RECORD_KINDS.goal, goalQualifiers(snap));
  const terminal = (state: GoalState, observedSpecRevision: number): GoalStatusValue =>
    assertStatusValue({ state, observedSpecRevision });
  for (let pass = 0; pass < 2; pass++) {
    const current = await readGoalStatus(ctx, snap);
    if (current === undefined) {
      const created = terminal(fact.state, spec.revision);
      try { await createRecordEntry(ctx.kv, key, created); return created; }
      catch (e) { if (e instanceof EpEnvelopeError && e.code === "conflict") continue; throw e; }
    }
    // The same terminal is already projected: converge.
    if (current.value.state === fact.state) return current.value;
    if (GOAL_TERMINAL_STATES.includes(current.value.state))
      throw new EpEnvelopeError("internal", `goal "${snap.goalId}" status is terminal ${current.value.state} but the winning fact is ${fact.state}; a projection never contradicts the journal (SPEC 13.6)`);
    const next = terminal(fact.state, current.value.observedSpecRevision);
    try { await updateRecordEntry(ctx.kv, key, next, current.revision); return next; }
    catch (e) { if (e instanceof EpEnvelopeError && e.code === "conflict") continue; throw e; }
  }
  throw new EpEnvelopeError("conflict", `the goal status ${key} moved twice during one terminal projection; re-read and re-decide (SPEC 13.4)`);
}

// ---- the terminal result (§13.6 items 2/4/5/6, commit-principal-owned) ------------------------

export type GoalOutcomeState = "succeeded" | "failed" | "cancelled" | "expired" | "uncertain";

/** The goal's terminal fact + the §13.6 item-5 tombstone summary in one immutable artifact. */
export interface GoalResultFact {
  v: 1;
  goalId: string;
  fingerprint: string;
  state: GoalOutcomeState;
  outcomeDigest: string;
  data?: unknown;
  /** WHO committed this terminal, and under which process epoch. The fact records its own
   *  authorship so a reader can tell the accepting executor's own answer from a successor's
   *  settle of inherited work; without it a terminal is anonymous and neither case is
   *  distinguishable from the other. Judged against the goal spec's `acceptedEpoch`, never
   *  against the CURRENT epoch — comparing to current is precisely what hid the legitimate
   *  pre-restart winner, because a corpse's fact and a real pre-restart winner's fact are
   *  byte-identical to a reader looking only at "is this epoch stale". */
  committer?: { instanceId: string; epoch: number };
  ts: number;
}

/** Build the retirement-cancelled goal terminal (§13.8 option (i)): the FIRST-CLASS `cancelled`
 *  outcome state the goal union ALREADY carries — no new wire shape — bound to the acceptance's
 *  fingerprint, with the retirement attribution riding the digest-bound payload
 *  (`data.cancelledBy = { opId, target }`). Published create-only on the goal's result subject,
 *  so a racing real commit wins by landing first (first-terminal-wins, §13.8). A retirement
 *  cancels only ITS OWN target's accepted goals. */
export function goalCancelledResultOf(
  acceptance: { fingerprint: string; request: Record<string, unknown>; target?: { owner: string; actor: string; lifecycleUid: string } },
  cancelled: { opId: string; target: { owner: string; actor: string; lifecycleUid: string } },
  ts: number,
): GoalResultFact {
  const goalId = acceptance.request.goalId;
  if (typeof goalId !== "string" || goalId.length === 0)
    throw new EpEnvelopeError("failed-precondition", "a cancelled goal terminal requires the acceptance's goalId (SPEC 13.6)");
  if (typeof cancelled.opId !== "string" || cancelled.opId.length === 0 || cancelled.opId.length > 64)
    throw new EpEnvelopeError("failed-precondition", "a cancelled goal terminal requires the retirement opId (SPEC 13.8)");
  if (acceptance.target === undefined || acceptance.target.lifecycleUid !== cancelled.target.lifecycleUid)
    throw new EpEnvelopeError("failed-precondition", `a retirement cancels only ITS target's accepted goals: the acceptance targets ${acceptance.target?.lifecycleUid ?? "(none)"}, not ${cancelled.target.lifecycleUid} (SPEC 13.8)`);
  const data = { cancelledBy: { opId: cancelled.opId, target: { ...cancelled.target } } };
  return { v: 1, goalId, fingerprint: acceptance.fingerprint, state: "cancelled", outcomeDigest: contractDigest(data), data, ts };
}

/** The §13.6 item-5 tombstone serving form for a payload-evicted retry. */
export function goalTombstone(fact: GoalResultFact): GoalResultFact {
  return { v: 1, goalId: fact.goalId, fingerprint: fact.fingerprint, state: fact.state, outcomeDigest: fact.outcomeDigest, data: { evicted: true }, ts: fact.ts };
}

/** Judge a parsed terminal against the ACCEPTED goal (the §13.6 attribution rule). The comparison
 *  is against the goal's OWN accepted epoch, never the current one:
 *   - `committed == accepted` — the accepting executor answering for its own work. Valid FOREVER,
 *     however far the current epoch has advanced since. This is the invariant HIGH-1 lost.
 *   - `committed > accepted`  — a successor settling work it inherited. Valid.
 *   - `committed < accepted`  — no incarnation can commit under an epoch older than the one that
 *     accepted the goal; the journal is garbled and it refuses loud.
 *  A goal accepted with no epoch context takes no committer, and vice versa: a half-attributed
 *  pair is a wiring confusion, not a silent pass.
 *
 *  WHAT THIS IS NOT: it is not a write fence against a LIVE superseded committer. A corpse
 *  committing the terminal of a goal IT accepted stamps `committed == accepted` and is accepted
 *  here, exactly as the real executor would be. Create-only CAS conditions on subject ABSENCE and
 *  cannot express "only if my epoch is still current", so the write fence is the §13.1 barrier.
 *
 *  AND THE BARRIER'S WINDOW IS WIDER THAN "BYTES IN FLIGHT", which an earlier revision of this
 *  comment claimed. A gate FREEZE neither kills the predecessor's connection nor advances the
 *  epoch, and the currency belt compares `processEpoch` alone, so a deposed manager's belt STILL
 *  PASSES from barrier start through PHASE 1-2 until the reopen. Revoking an `epcred` row marks a
 *  ledger row; it does not re-check a live JWT mid-publish on an already-open connection. What
 *  durably kills that publisher is the CLUSTER-VERIFIED EVICTION in PHASE 2, not the revoke. So
 *  the window in which a deposed manager can still INITIATE a new terminal publish runs from
 *  barrier start until eviction is verified — not merely the bytes already on the wire. On an OPEN
 *  mesh no credential family exists, so that eviction is vacuous and there is no durable fence at
 *  all; the belt there is cooperative only. */
function assertTerminalAttribution(fact: GoalResultFact, spec: GoalSpecValue, goalId: string): void {
  const accepted = spec.acceptedEpoch;
  const committed = fact.committer?.epoch;
  if (accepted === undefined && committed === undefined) return;
  if (accepted === undefined || committed === undefined)
    throw new EpEnvelopeError("internal", `goal "${goalId}" has ${accepted === undefined ? "no accepted epoch but a committer-stamped terminal" : "an accepted epoch but an unattributed terminal"}; a half-attributed terminal never authorizes (SPEC 13.6)`);
  if (committed < accepted)
    throw new EpEnvelopeError("internal", `goal "${goalId}" carries a terminal committed under epoch ${committed} but was accepted under ${accepted}; no incarnation commits under an epoch older than the one that accepted the goal - the journal is garbled (SPEC 13.1/13.6)`);
}

/** Closed validation, IDENTITY-BOUND to the ref, with the tombstone digest RE-VERIFIED. */
export function parseGoalResultFact(raw: unknown, subject: string, ref: GoalRef): GoalResultFact {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `goal result fact on ${subject} is not an object; garbled state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  assertClosedKeys(o, ["v", "goalId", "fingerprint", "state", "outcomeDigest", "data", "committer", "ts"], `goal result fact on ${subject}`);
  if (o.committer !== undefined) {
    const cm = o.committer as Record<string, unknown>;
    if (cm === null || typeof cm !== "object" || Array.isArray(cm))
      throw new EpEnvelopeError("internal", `goal result fact on ${subject} committer is not an object; garbled state never authorizes (SPEC 13.6)`);
    assertClosedKeys(cm, ["instanceId", "epoch"], `goal result fact on ${subject} committer`);
    if (typeof cm.instanceId !== "string" || cm.instanceId.length === 0
      || typeof cm.epoch !== "number" || !Number.isSafeInteger(cm.epoch) || cm.epoch < 0)
      throw new EpEnvelopeError("internal", `goal result fact on ${subject} carries a malformed committer; garbled state never authorizes (SPEC 13.6)`);
  }
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

/** Read the goal's cached terminal outcome (`undefined` = not terminal yet). ONE goal, ONE
 *  terminal subject (§13.2 reserved subjects), read exactly (never a wildcard `last_by_subj` — the append-shadow
 *  lesson): a committed terminal is surfaced to every reader, in every incarnation, forever. */
export async function readGoalResult(ctx: ActionContext, ref: GoalRef): Promise<GoalResultFact | undefined> {
  assertCtx(ctx);
  const snap = snapshotRef(ref);
  const subject = goalResultSubject(ctx.space, snap);
  const raw = await readLastFact(ctx.jsm, epfStreamName(ctx.space), subject);
  return raw === undefined ? undefined : parseGoalResultFact(raw, subject, snap);
}

/** The raw create-only terminal CAS (PRIVATE): the state is already authorized by the cause,
 *  the spec already read. Snapshots the payload strict-canonical BEFORE the CAS, stamps the
 *  fingerprint FROM the spec, projects the winner, and proves a lost-CAS winner's fingerprint
 *  agrees with the spec. */
async function commitTerminalFact(
  ctx: ActionContext, snap: GoalRef, spec: GoalSpecValue, state: GoalOutcomeState, data: unknown, now: number, committer: { instanceId: string; epoch: number } | undefined,
): Promise<{ won: boolean; fact: GoalResultFact; status: GoalStatusValue }> {
  const snapshotData: unknown = data === undefined ? undefined : JSON.parse(canonicalJson(data));
  const fact: GoalResultFact = {
    v: 1, goalId: snap.goalId, fingerprint: spec.fingerprint, state,
    outcomeDigest: contractDigest(snapshotData === undefined ? null : snapshotData),
    ...(snapshotData !== undefined ? { data: snapshotData } : {}),
    ...(committer !== undefined ? { committer } : {}), ts: now,
  };
  // ONE terminal subject per goal (§13.2 reserved subjects). First fact wins GLOBALLY: a late or superseded
  // committer loses the create-only CAS and reads the winner, rather than winning a private
  // per-epoch subject of its own that hides the real outcome from everyone else.
  const subject = goalResultSubject(ctx.space, snap);
  const res = await publishCreateOnly(ctx.js, subject, new TextEncoder().encode(JSON.stringify(fact)));
  let winner: GoalResultFact | undefined;
  if (res.won) winner = fact;
  else {
    const raw = await readLastFact(ctx.jsm, epfStreamName(ctx.space), subject);
    winner = raw === undefined ? undefined : parseGoalResultFact(raw, subject, snap);
  }
  if (winner === undefined)
    throw new EpEnvelopeError("internal", `the goal terminal CAS for ${subject} was lost but no winning fact is readable (SPEC 13.4)`);
  if (winner.fingerprint !== spec.fingerprint)
    throw new EpEnvelopeError("internal", `the recorded terminal for goal "${snap.goalId}" carries fingerprint ${JSON.stringify(winner.fingerprint)}, not the accepted spec's ${spec.fingerprint}; a foreign-fingerprint winner is never adopted (SPEC 13.4/13.6)`);
  assertTerminalAttribution(winner, spec, snap.goalId);
  const status = await projectGoalTerminal(ctx, snap);
  return { won: res.won, fact: winner, status };
}

// ---- receipt emission (§13.10, D9 part 2) -----------------------------------------------------

/** What receipt emission needs beyond the action context: the receipt store bonded to the SAME
 *  space AND the same connection, the EMITTING instance recorded as EVIDENCE (who produced this
 *  attestation - after a crash the reconciling instance records ITSELF here, so this is never
 *  proof of who EXECUTED the goal, and never redemption authority; the executed outcome's
 *  authority is the committed terminal fact alone), and the receipts-scoped signer + key. */
export interface ReceiptEmissionWiring {
  store: ReceiptStoreContext;
  instance: { id: string; instanceId: string; epoch: number };
  signer: { keyId: string };
  keyPair: { sign(input: Uint8Array): Uint8Array };
}

/** One emission attempt's outcome: `emitted` (this attempt's receipt won the create-only CAS)
 *  or `converged` (a receipt already attests these facts — an earlier attempt's or a racing
 *  emitter's, ADOPTED only after it proves agreement with the facts). A recorded receipt that
 *  DISAGREES with the committed facts is a loud `conflict`, never adopted. */
export type ReceiptEmissionResult = { outcome: "emitted" | "converged"; receipt: Receipt };

/** Validate emission wiring at seam ENTRY (fail loud BEFORE any commit or publish happens
 *  against it): the store must be BRANDED (minted by receiptStoreContext), bonded to THIS
 *  context's space — a cross-space store would publish receipts into a foreign space's stream —
 *  and derived from THIS context's own connection (security CF-2 HIGH: a same-space store on a
 *  DIFFERENT broker passes the string compare and splices receipts across brokers; §13.4 "JS +
 *  JSM derive from ONE connection" makes the bond connection identity, never a name). */
function assertEmissionWiring(ctx: ActionContext, wiring: ReceiptEmissionWiring): void {
  if (wiring === null || typeof wiring !== "object"
    || typeof (wiring.keyPair as { sign?: unknown } | undefined)?.sign !== "function"
    || typeof (wiring.signer as { keyId?: unknown } | undefined)?.keyId !== "string")
    throw new EpEnvelopeError("failed-precondition", "receipt emission wiring carries the receipt store context, the instance evidence, the signer keyId, and the signing key (SPEC 13.10)");
  assertReceiptStoreContext(wiring.store);
  if (wiring.store.space !== ctx.space)
    throw new EpEnvelopeError("failed-precondition", `the receipt store is bonded to space ${JSON.stringify(wiring.store.space)}, not this action context's ${JSON.stringify(ctx.space)}; a cross-space emission never publishes (SPEC 13.4)`);
  assertReceiptStoreConnection(wiring.store, ACTION_CONNECTIONS.get(ctx));
}

/** The SHARED emission core (§13.10), MODULE-PRIVATE (engineer/security HIGH: `spec` and
 *  `fact` are TRUSTED inputs here, so only the two callers that derive them from their own
 *  authority reads may reach this seam - commitGoalResult passes its terminal-CAS winner and
 *  leader-read spec, reconcileReceiptEmission passes its own fresh reads; a public seam would
 *  let a fabricated terminal permanently win the create-only receipt subject): derive the goal
 *  terminal's receipt from the two authoritative facts and publish it idempotently, so the
 *  receipt is reconstructable after any crash between effect and emission. Steps: read the DURABLE acceptance through the goal's recorded address
 *  (`spec.requestId`), prove the chain (the fact must be the acceptance THIS spec was written
 *  from — id + sourceSeq + fingerprint + command, not merely SOME fact on the subject, which
 *  post-horizon id reuse could make a different execution's), mint via
 *  {@link mintReceiptFromFacts}, then create-only publish. A racing emitter with different
 *  evidence (its own ts/instance) is adopted exactly when its receipt attests the SAME facts;
 *  a recorded receipt that disagrees is the forged-attestation class CF-1 closes and throws. */
async function emitReceiptForTerminal(
  ctx: ActionContext,
  wiring: ReceiptEmissionWiring,
  args: { ref: GoalRef; spec: GoalSpecValue; fact: GoalResultFact; ts: number },
): Promise<ReceiptEmissionResult> {
  assertCtx(ctx);
  assertEmissionWiring(ctx, wiring);
  const snap = snapshotRef(args.ref);
  const ts = assertSafeInt(args.ts, "ts");
  const spec = args.spec;
  const fact = args.fact;
  if (fact.goalId !== snap.goalId || fact.fingerprint !== spec.fingerprint)
    throw new EpEnvelopeError("internal", `the terminal fact (goal ${JSON.stringify(fact.goalId)}, fingerprint ${JSON.stringify(fact.fingerprint)}) does not belong to goal "${snap.goalId}" under the accepted fingerprint ${spec.fingerprint}; a foreign terminal never mints a receipt (SPEC 13.10)`);
  const subject = epfSubject(ctx.space, snap.endpoint, ["dec", snap.caller.owner, snap.caller.actor, snap.caller.uid, spec.requestId]);
  const raw = await readLastFact(ctx.jsm, epfStreamName(ctx.space), subject);
  if (raw === undefined)
    throw new EpEnvelopeError("failed-precondition", `no decision fact exists at ${subject}; a receipt derives from the durable acceptance and cannot be reconstructed without it - check the fact retention floor (SPEC 13.10/13.12)`);
  const decision = parseDecisionFact(raw, subject);
  if (decision.decision !== "accepted")
    throw new EpEnvelopeError("internal", `the decision fact for request "${spec.requestId}" is a rejection, yet goal "${snap.goalId}" carries a committed terminal; the authority chain is broken - reconcile the store (SPEC 13.4)`);
  if (decision.sourceSeq !== spec.sourceSeq || decision.fingerprint !== spec.fingerprint)
    throw new EpEnvelopeError("internal", `the acceptance at ${subject} (sourceSeq ${decision.sourceSeq}, fingerprint ${decision.fingerprint}) is not the acceptance goal "${snap.goalId}" was created from (sourceSeq ${spec.sourceSeq}, fingerprint ${spec.fingerprint}); a foreign acceptance never mints this goal's receipt (SPEC 13.10)`);
  const op = (decision.request as { op?: { command?: unknown } }).op;
  if (op?.command !== spec.command)
    throw new EpEnvelopeError("internal", `the acceptance at ${subject} carries command ${JSON.stringify(op?.command)}, not the accepted goal's ${JSON.stringify(spec.command)}; a foreign acceptance never mints this goal's receipt (SPEC 13.10)`);
  // The chain proves the acceptance names THIS goal (security CF-2 HIGH): createGoal accepts a
  // caller-supplied fingerprint, so goal B planted with goal A's fingerprint/requestId/sourceSeq
  // passes every check above - but A's acceptance embeds `goalId: A`, and the fingerprint binds
  // it, so the embedded request's goalId is the discriminator a plant cannot forge.
  const reqGoalId = (decision.request as { goalId?: unknown }).goalId;
  if (reqGoalId !== snap.goalId)
    throw new EpEnvelopeError("internal", `the acceptance at ${subject} names goal ${JSON.stringify(reqGoalId)}, not "${snap.goalId}"; an acceptance whose accepted request does not name THIS goal never mints its receipt - a planted fingerprint cannot borrow a foreign acceptance (SPEC 13.10)`);
  const candidate = mintReceiptFromFacts({
    acceptance: decision, caller: snap.caller, space: ctx.space,
    terminal: receiptOutcomeOfGoal(fact.state, fact.outcomeDigest),
    instance: wiring.instance, ts, signer: wiring.signer,
  }, wiring.keyPair);
  const rref = { endpoint: snap.endpoint, caller: snap.caller, requestId: decision.id, sourceSeq: decision.sourceSeq };
  const recorded = await readReceipt(wiring.store, rref);
  if (recorded !== undefined) {
    assertReceiptAttestsSameFacts(recorded, candidate);
    return { outcome: "converged", receipt: recorded };
  }
  try {
    const res = await publishReceipt(wiring.store, rref, candidate);
    return { outcome: res.won ? "emitted" : "converged", receipt: res.receipt };
  } catch (e) {
    // publishReceipt's byte-identity convergence loses to a racing emitter whose evidence
    // (ts/instance) legitimately differs; adopt its receipt exactly when it attests the SAME
    // facts, and propagate the conflict when it does not.
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    const winner = await readReceipt(wiring.store, rref);
    if (winner === undefined) throw e;
    assertReceiptAttestsSameFacts(winner, candidate);
    return { outcome: "converged", receipt: winner };
  }
}

/** The durable backstop for the §13.10 MUST-emit guarantee: re-derive and publish the receipt
 *  for a goal whose terminal committed but whose emission was omitted (a crash between the
 *  terminal CAS and the publish, or a commit made without emission wiring). Reads the persisted
 *  spec and the committed terminal FRESH, then runs the SAME emission seam the inline path uses.
 *  `no-terminal` = nothing to attest yet (the goal simply is not terminal — never an error). */
export async function reconcileReceiptEmission(
  ctx: ActionContext,
  wiring: ReceiptEmissionWiring,
  args: { ref: GoalRef; now: number },
): Promise<ReceiptEmissionResult | { outcome: "no-terminal" }> {
  assertCtx(ctx);
  assertEmissionWiring(ctx, wiring);
  const snap = snapshotRef(args.ref);
  const now = assertSafeInt(args.now, "now");
  const spec = await readGoalSpec(ctx, snap);
  if (spec === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${snap.goalId}" has no accepted spec; only an accepted goal's terminal ever carries a receipt (SPEC 13.6/13.10)`);
  const fact = await readGoalResult(ctx, snap);
  if (fact === undefined) return { outcome: "no-terminal" };
  return emitReceiptForTerminal(ctx, wiring, { ref: snap, spec: spec.value, fact, ts: now });
}

/** A deny's AUTHORITATIVE PREDICATE (§13.6): a bare `deny` proves nothing, so the commit
 *  boundary requires and VERIFIES one of:
 *   - `hold-expired`: the named checkpoint's recorded spec must BIND this exact goal and its
 *     recorded one-use settlement must be `expired` (the arbiter's own fact — a live or resumed
 *     hold never denies);
 *   - `owner`: the owner's construction-bound {@link ownerCommitProof} from THIS context (a
 *     guard-verdict deny the owner itself is committing). */
export type GoalDenial =
  | { kind: "hold-expired"; token: string }
  | { kind: "owner"; owner: OwnerCommitProof };

/** The closed terminal CAUSE (§13.6): the public commit accepts ONLY these, each with its own
 *  authoritative predicate verified inside the boundary; the terminal state is DERIVED, never a
 *  raw caller value.
 *   - `complete`: the executor's own outcome (`succeeded`|`failed`), proving fresh currency for
 *     a target-pinned goal;
 *   - `cancel`: `cancelled`, requiring the goal to be `cancelling` (a cancel was requested);
 *   - `deny`: `failed`, requiring the verified {@link GoalDenial} predicate (a bare deny cause
 *     is refused — any commit-seam holder could otherwise fail any accepted goal);
 *   - `readiness`: `uncertain`, the OWNER's deadline settlement, requiring `now` past the
 *     persisted acceptance-relative readiness deadline (no executor — a target-pinned goal's
 *     owner deadline is reachable). */
export type GoalCommitCause =
  | { cause: "complete"; state: "succeeded" | "failed"; data?: unknown; executor?: GoalExecutor; resolveCurrentEpoch?: (target: { owner: string; actor: string; lifecycleUid: string }) => Promise<number | null> | number | null; epochResolveBudgetMs?: number }
  | { cause: "cancel"; data?: unknown }
  | { cause: "deny"; denial: GoalDenial; data?: unknown }
  | { cause: "readiness" };

/** Commit the goal's terminal state at the ONE mediated commit point, BOUND to the persisted
 *  accepted goal and its CAUSE (see {@link GoalCommitCause}). First terminal fact wins uniformly
 *  (completion, cancel, deny, and readiness race here); a loser observes the winner and its
 *  projection converges. Every operation input detaches at ENTRY (single-read, before the first
 *  await): a caller mutating cause/state/data/executor across the spec read changes nothing.
 *
 *  RECEIPT EMISSION (§13.10): with `receipts` wired, the commit emits the terminal's receipt
 *  INLINE, best-effort, for the WINNING fact (won or lost — the terminal is committed either
 *  way and emission is idempotent). Invalid wiring refuses at ENTRY, before any terminal
 *  commits; a RUNTIME emission failure after the irreversible commit surfaces as
 *  `receiptEmission: { outcome: "failed" }` — it never masks the committed terminal, and
 *  {@link reconcileReceiptEmission} is the durable backstop that converges it. */
export async function commitGoalResult(
  ctx: ActionContext,
  args: { ref: GoalRef; now: number; receipts?: ReceiptEmissionWiring; committer?: { instanceId: string; epoch: number } } & GoalCommitCause,
): Promise<{ won: boolean; fact: GoalResultFact; status: GoalStatusValue; receiptEmission?: ReceiptEmissionResult | { outcome: "failed"; error: EpEnvelopeError } }> {
  assertCtx(ctx);
  // ENTRY SNAPSHOT (single-read): ref, clock, cause, wiring, and every per-cause field detach
  // BEFORE the first await; the terminal payload detaches strict-canonical here too.
  const snap = snapshotRef(args.ref);
  const now = assertSafeInt(args.now, "now");
  const receipts = args.receipts;
  if (receipts !== undefined) assertEmissionWiring(ctx, receipts);
  const committerIn = args.committer;
  const committer = committerIn === undefined ? undefined : { instanceId: String(committerIn.instanceId), epoch: committerIn.epoch };
  if (committer !== undefined && (committer.instanceId.length === 0 || !Number.isSafeInteger(committer.epoch) || committer.epoch < 0))
    throw new EpEnvelopeError("failed-precondition", `a terminal committer is an instanceId plus an unsigned epoch; got ${JSON.stringify(args.committer)} (SPEC 13.6)`);
  const cause = args.cause;
  const dataRaw = (args as { data?: unknown }).data;
  let data: unknown;
  if (dataRaw !== undefined) {
    try { data = JSON.parse(canonicalJson(dataRaw)); }
    catch (e) { throw new EpEnvelopeError("failed-precondition", `the terminal payload is not interchangeable JSON (${(e as Error).message}); a garbled payload never commits (SPEC 13.6)`); }
  }
  type CommitPlan =
    | { cause: "complete"; state: "succeeded" | "failed"; executor?: GoalExecutor; resolver?: (target: { owner: string; actor: string; lifecycleUid: string }) => Promise<number | null> | number | null; budget: number }
    | { cause: "cancel" }
    | { cause: "deny"; denial: { kind: "hold-expired"; token: string } | { kind: "owner" } }
    | { cause: "readiness" };
  let plan: CommitPlan;
  if (cause === "complete") {
    const state = args.state;
    if (state !== "succeeded" && state !== "failed")
      throw new EpEnvelopeError("failed-precondition", `a completion commits "succeeded" or "failed"; got ${JSON.stringify(state)} (SPEC 13.6)`);
    const executor = args.executor !== undefined ? { lifecycleUid: String(args.executor.lifecycleUid), epoch: args.executor.epoch } : undefined;
    const budget = args.epochResolveBudgetMs ?? 5_000;
    if (!Number.isSafeInteger(budget) || budget <= 0)
      throw new EpEnvelopeError("failed-precondition", `epochResolveBudgetMs must be a positive integer; got ${JSON.stringify(args.epochResolveBudgetMs)}`);
    plan = { cause, state, executor, resolver: args.resolveCurrentEpoch, budget };
  } else if (cause === "cancel") {
    plan = { cause };
  } else if (cause === "deny") {
    const denial = args.denial as GoalDenial | undefined;
    const kind = denial === null || typeof denial !== "object" ? undefined : denial.kind;
    if (kind === "hold-expired") {
      const token = (denial as { token?: unknown }).token;
      if (typeof token !== "string" || token.length === 0)
        throw new EpEnvelopeError("failed-precondition", `a hold-expired denial names its checkpoint token (SPEC 13.6)`);
      plan = { cause, denial: { kind, token } };
    } else if (kind === "owner") {
      // Verified HERE, at entry: a hand-assembled or cross-context proof is a loud refusal.
      if (!assertOwnerProof((denial as { owner?: OwnerCommitProof }).owner, ctx, `the deny of goal "${snap.goalId}"`))
        throw new EpEnvelopeError("failed-precondition", `an owner deny presents the owner's construction-bound proof (ownerCommitProof); a bare deny cause proves nothing (SPEC 13.6)`);
      plan = { cause, denial: { kind } };
    } else {
      throw new EpEnvelopeError("failed-precondition", `a deny commits only with its authoritative predicate (a goal-bound EXPIRED hold settlement, or the owner's construction-bound proof); a bare deny cause could fail any accepted goal (SPEC 13.6)`);
    }
  } else if (cause === "readiness") {
    plan = { cause };
  } else {
    throw new EpEnvelopeError("failed-precondition", `unknown commit cause ${JSON.stringify(cause)}; the terminal commit accepts only complete|cancel|deny|readiness (SPEC 13.6)`);
  }

  // LEADER-SERVED (H2): this spec read gates the epoch proof below and the terminal CAS is
  // create-only (first-terminal-wins, no revision pin to catch a stale input later), so the
  // proof's input must come from the leader, not a possibly-follower Direct Get.
  const spec = await readGoalSpecLeader(ctx, snap);
  if (spec === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${snap.goalId}" has no accepted spec; a terminal commits only for an accepted goal (SPEC 13.6)`);
  // Attribution is REQUIRED exactly when the goal was accepted under an epoch, and refused when it
  // was not: an unattributed terminal on an epoch-bearing goal is the anonymous-fact state this
  // rule exists to end, and a committer on a goal with no epoch context is a wiring confusion.
  if ((spec.value.acceptedEpoch !== undefined) !== (committer !== undefined))
    throw new EpEnvelopeError("failed-precondition", spec.value.acceptedEpoch !== undefined
      ? `goal "${snap.goalId}" was accepted under epoch ${spec.value.acceptedEpoch}; its terminal MUST carry the committing instance and epoch (SPEC 13.6)`
      : `goal "${snap.goalId}" was accepted with no epoch context; a terminal committer here is a wiring confusion (SPEC 13.6)`);
  if (committer !== undefined && committer.epoch < spec.value.acceptedEpoch!)
    throw new EpEnvelopeError("failed-precondition", `goal "${snap.goalId}" was accepted under epoch ${spec.value.acceptedEpoch} but the committer presents ${committer.epoch}; no incarnation commits under an epoch older than the one that accepted the goal (SPEC 13.1/13.6)`);

  // The post-commit emission tail every cause routes through: the terminal is already committed
  // and immutable when this runs, so a runtime emission failure SURFACES on the result instead
  // of masking the commit (the reconciler converges it); wiring errors refused at entry above.
  const finish = async (committed: { won: boolean; fact: GoalResultFact; status: GoalStatusValue }) => {
    if (receipts === undefined) return committed;
    try {
      return { ...committed, receiptEmission: await emitReceiptForTerminal(ctx, receipts, { ref: snap, spec: spec.value, fact: committed.fact, ts: now }) };
    } catch (e) {
      const error = e instanceof EpEnvelopeError ? e : new EpEnvelopeError("internal", `receipt emission failed: ${(e as Error)?.message ?? String(e)}`);
      return { ...committed, receiptEmission: { outcome: "failed" as const, error } };
    }
  };

  if (plan.cause === "complete") {
    // Currency immediately before the terminal CAS — the check is paired with the commit it
    // fences, never a stale earlier read (SPEC 13.6 item 7).
    await assertExecutorCurrency(spec.value, snap.goalId, plan.executor, plan.resolver, plan.budget);
    return finish(await commitTerminalFact(ctx, snap, spec.value, plan.state, data, now, committer));
  }
  if (plan.cause === "cancel") {
    const status = await readGoalStatus(ctx, snap);
    if (status === undefined || status.value.state !== "cancelling")
      throw new EpEnvelopeError("failed-precondition", `goal "${snap.goalId}" is not \`cancelling\` (state ${status?.value.state ?? "unknown"}); a cancel terminal follows a requested cancel, never a naked assertion (SPEC 13.6)`);
    return finish(await commitTerminalFact(ctx, snap, spec.value, "cancelled", data, now, committer));
  }
  if (plan.cause === "deny") {
    if (plan.denial.kind === "hold-expired") {
      // The predicate is the checkpoint arbiter's OWN recorded state: the spec must bind THIS
      // goal (a token for goal A never fails unrelated goal B) and the one-use settlement must
      // be EXPIRED — a live or resumed hold never denies.
      const cpRef = { endpoint: snap.endpoint, token: plan.denial.token };
      const cpSpec = await readCheckpointSpec(ctx.kv, cpRef);
      if (cpSpec === undefined)
        throw new EpEnvelopeError("failed-precondition", `checkpoint "${plan.denial.token}" is unknown on endpoint "${snap.endpoint}"; a hold-expired denial names a minted checkpoint (SPEC 13.6)`);
      const g = cpSpec.goal;
      if (g === undefined || g.goalId !== snap.goalId
        || g.caller.owner !== snap.caller.owner || g.caller.actor !== snap.caller.actor || g.caller.uid !== snap.caller.uid)
        throw new EpEnvelopeError("permission-denied", `checkpoint "${plan.denial.token}" does not pause goal "${snap.goalId}" (${snap.caller.owner}.${snap.caller.actor}/${snap.caller.uid}); a hold-expired denial is goal-bound (SPEC 13.6)`);
      const settle = await readCheckpointSettle(ctx.jsm, ctx.space, cpRef);
      if (settle === undefined || settle.settle !== "expired")
        throw new EpEnvelopeError("failed-precondition", `checkpoint "${plan.denial.token}" has no RECORDED expired settlement (${settle === undefined ? "still live" : `settled ${settle.settle}`}); a live or resumed hold never denies (SPEC 13.6)`);
    }
    return finish(await commitTerminalFact(ctx, snap, spec.value, "failed", data, now, committer));
  }
  // readiness
  if (spec.value.readinessDeadlineMs === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${snap.goalId}" declares no readiness deadline; an unbounded goal is never settled uncertain (SPEC 13.6)`);
  if (now < spec.value.acceptedAt + spec.value.readinessDeadlineMs)
    throw new EpEnvelopeError("failed-precondition", `goal "${snap.goalId}" is not past its readiness deadline (acceptedAt ${spec.value.acceptedAt} + ${spec.value.readinessDeadlineMs}ms > now ${now}); an early uncertain settle would steal a still-possible success (SPEC 13.6)`);
  return finish(await commitTerminalFact(ctx, snap, spec.value, "uncertain", { reason: "the success signal did not arrive within the readiness deadline", readinessDeadlineMs: spec.value.readinessDeadlineMs }, now, committer));
}

// ---- cancel (§13.6 item 4) --------------------------------------------------------------------

/** The reverse-DNS detail kind carrying a goal's cached terminal fact on an error (§13.3). */
export const GOAL_TERMINAL_DETAIL_KIND = "ai.cotal.goal.terminal";

function alreadyTerminal(goalId: string, fact: GoalResultFact): EpEnvelopeError {
  return new EpEnvelopeError("failed-precondition",
    `goal "${goalId}" is already terminal (${fact.state}); the cached outcome is attached (SPEC 13.6)`,
    [{ kind: GOAL_TERMINAL_DETAIL_KIND, fact }]);
}

/** The reserved `cancel` command's handler seam. The goal ref derives STRUCTURALLY from the
 *  broker-authenticated request (a caller cancels only its own goals). Unknown = failed-
 *  precondition; terminal = failed-precondition with the cached outcome on error.details;
 *  otherwise the status transitions to `cancelling` (owner/caller-authored — no executor) and
 *  the owner later commits the `cancel` cause. A completion that landed during the transition is
 *  observed AFTER it and converges the projection. */
export async function requestGoalCancel(
  ctx: ActionContext,
  args: { request: ParsedEpRequest; goalId: string; mode: "graceful" | "terminate" },
): Promise<GoalStatusValue> {
  assertCtx(ctx);
  if (args.mode !== "graceful" && args.mode !== "terminate")
    throw new EpEnvelopeError("failed-precondition", `cancel mode must be "graceful" or "terminate"; got ${JSON.stringify(args.mode)} (SPEC 13.6)`);
  const ref = goalRefOf(args.request, args.goalId);
  const cached = await readGoalResult(ctx, ref);
  if (cached !== undefined) throw alreadyTerminal(ref.goalId, cached);
  let projected: GoalStatusValue | undefined;
  for (let pass = 0; pass < 2 && projected === undefined; pass++) {
    const status = await readGoalStatus(ctx, ref);
    if (status === undefined)
      throw new EpEnvelopeError("failed-precondition", `goal "${ref.goalId}" is unknown; cancel addresses only an accepted goal (SPEC 13.6)`);
    if (status.value.state === "cancelling") { projected = status.value; break; }
    if (GOAL_TERMINAL_STATES.includes(status.value.state)) {
      const fact = await readGoalResult(ctx, ref);
      if (fact === undefined)
        throw new EpEnvelopeError("internal", `goal "${ref.goalId}" status is terminal but no result fact is readable; a projection never leads the journal (SPEC 13.6)`);
      throw alreadyTerminal(ref.goalId, fact);
    }
    try { projected = await transitionGoal(ctx, ref, "cancelling", { fields: { cancelMode: args.mode } }); }
    catch (e) { if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e; }
  }
  if (projected === undefined)
    throw new EpEnvelopeError("conflict", `the goal status for "${ref.goalId}" moved twice during one cancel; re-read and re-decide (SPEC 13.4)`);
  const raced = await readGoalResult(ctx, ref);
  if (raced !== undefined) {
    await projectGoalTerminal(ctx, ref);
    throw alreadyTerminal(ref.goalId, raced);
  }
  return projected;
}

// ---- bounded readiness (§13.6 item 6) ----------------------------------------------------------

/** Settle a goal `uncertain` at its persisted acceptance-relative readiness deadline (the
 *  `readiness` cause). The bound is read from the PERSISTED spec; a target-pinned goal is
 *  REACHABLE (readiness is the owner's deadline, not an executor completion, so no executor is
 *  required). A racing late success that committed first wins and this returns the winner. */
export async function settleGoalUncertain(
  ctx: ActionContext,
  args: { ref: GoalRef; now: number; committer?: { instanceId: string; epoch: number } },
): Promise<{ won: boolean; fact: GoalResultFact; status: GoalStatusValue }> {
  return commitGoalResult(ctx, { ref: args.ref, now: args.now, cause: "readiness", ...(args.committer !== undefined ? { committer: args.committer } : {}) });
}

// ---- the reconcile index (§13.6 crash recovery for the Model-B inline executor) ---------------

/** One reconcile-index entry: a pointer to a goal ref plus the ACCEPTING executor's instanceId —
 *  the coordinates a SUCCESSOR incarnation needs to find + settle an orphaned in-flight goal it
 *  never held in memory. `iid` is the accepting incarnation's instanceId: a single-manager
 *  successor (a fresh instanceId) reconciles every entry, but it is the hook a multi-instance
 *  sweep filters on (never settle a goal a still-LIVE sibling instance owns — a filter-only add,
 *  no schema change). The acceptance clock is NOT duplicated here (it lives in the goal spec the
 *  sweep reads); for one (endpoint, iid) a concurrent same-goalId retry writes the byte-IDENTICAL
 *  entry (create-only idempotent). */
export interface GoalIndexEntry {
  v: 1; endpoint: string; owner: string; actor: string; uid: string; goalId: string; iid: string;
  /** THE ACCEPTANCE FLOOR (H2). The identity the accepting incarnation ALLOCATED for this goal,
   *  written here because this entry is the only durable record that exists BEFORE the acceptance
   *  is acked — the goal spec does not carry it and the terminal fact does not exist yet. Without
   *  it, a concurrent same-goalId attempt that loses the bind has nothing truthful to serve while
   *  the winner is still in flight, and the honest answers are only "here is what the winner
   *  allocated" or a refusal. OPTIONAL for read compatibility with entries written before this
   *  field existed; absent means the floor was never persisted and a reader must refuse rather
   *  than invent one. */
  allocated?: { name: string; actor: string; uid: string };
}

function goalIndexKey(ref: GoalRef): string {
  return recordAtomicKey(RECORD_KINDS.goalidx, [ref.endpoint, ref.caller.owner, ref.caller.actor, ref.caller.uid, ref.goalId]);
}

function goalIndexEntryOf(ref: GoalRef, iid: string, allocated?: { name: string; actor: string; uid: string }): GoalIndexEntry {
  // Refuse a hollow floor AT THE WRITE, not only when someone reads it back: an entry naming an
  // empty identity is the exact defect this field exists to end, and letting it land would just
  // move the failure to whichever unlucky retry reads it.
  if (allocated !== undefined && !(["name", "actor", "uid"] as const).every((k) => typeof allocated[k] === "string" && allocated[k].length > 0))
    throw new EpEnvelopeError("internal", `the acceptance floor for goal "${ref.goalId}" has an empty component; a hollow identity is never recorded (SPEC 13.6)`);
  return {
    v: 1, endpoint: ref.endpoint, owner: ref.caller.owner, actor: ref.caller.actor, uid: ref.caller.uid, goalId: ref.goalId, iid,
    ...(allocated !== undefined ? { allocated: { name: allocated.name, actor: allocated.actor, uid: allocated.uid } } : {}),
  };
}

function parseGoalIndexEntry(raw: unknown, key: string): GoalIndexEntry {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new EpEnvelopeError("internal", `goal-index entry ${key} is not an object; garbled reconcile state never authorizes (SPEC 13.6)`);
  const o = raw as Record<string, unknown>;
  assertClosedKeys(o, ["v", "endpoint", "owner", "actor", "uid", "goalId", "iid", "allocated"], `goal-index entry ${key}`);
  if (o.v !== 1 || typeof o.endpoint !== "string" || typeof o.owner !== "string" || typeof o.actor !== "string"
    || typeof o.uid !== "string" || typeof o.goalId !== "string" || typeof o.iid !== "string")
    throw new EpEnvelopeError("internal", `goal-index entry ${key} is malformed; garbled reconcile state never authorizes (SPEC 13.6)`);
  if (o.allocated !== undefined) {
    const a = o.allocated as Record<string, unknown>;
    if (a === null || typeof a !== "object" || Array.isArray(a))
      throw new EpEnvelopeError("internal", `goal-index entry ${key} carries a malformed acceptance floor; garbled reconcile state never authorizes (SPEC 13.6)`);
    assertClosedKeys(a, ["name", "actor", "uid"], `goal-index entry ${key} allocated`);
    // A floor with an EMPTY component is the hollow acceptance this field exists to end: it would
    // read as a real identity and name nothing. Refuse it as garbled rather than serve it.
    if (!["name", "actor", "uid"].every((k) => typeof a[k] === "string" && (a[k] as string).length > 0))
      throw new EpEnvelopeError("internal", `goal-index entry ${key} carries an acceptance floor with an empty component; a hollow identity never authorizes (SPEC 13.6)`);
  }
  return o as unknown as GoalIndexEntry;
}

/** Record an accepted goal in the endpoint's reconcile index, CREATE-ONLY and BEFORE the bind
 *  (must-5 Q-B): the atomicity is `index-CAS-before-bind`, so recoverability is clean either side
 *  of a crash — a crash AFTER this write and BEFORE the bind leaves an index entry whose goal
 *  status is absent (the sweep treats it as a no-goal and clears it); a crash BEFORE it leaves no
 *  entry, so the acceptance was never durable. `iid` is the accepting incarnation's instanceId.
 *  Idempotent for an adopted or concurrent same-goalId retry (a byte-identical pointer). */
export async function recordGoalIndex(
  ctx: ActionContext, ref: GoalRef, iid: string, allocated?: { name: string; actor: string; uid: string },
): Promise<{ recorded: true } | { recorded: false; existing: GoalIndexEntry }> {
  assertCtx(ctx);
  const snap = snapshotRef(ref);
  const key = goalIndexKey(snap);
  try {
    await createRecordEntry(ctx.kv, key, goalIndexEntryOf(snap, iid, allocated));
    return { recorded: true };
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    // A non-PUT marker is corruption, never reusable absence.
    const existing = await ctx.kv.get(key);
    if (!existing || existing.operation !== "PUT")
      throw new EpEnvelopeError("internal", `goal-index entry ${key} lost its create-only CAS but is absent/deleted; reconcile the store (SPEC 13.6)`);
    const entry = parseGoalIndexEntry(JSON.parse(new TextDecoder().decode(existing.value)), key);
    // H2: the loss is only an IDEMPOTENT RETRY when the winner is the same incarnation. A FOREIGN
    // `iid` means another instance accepted this goalId, which this function must not silently
    // absorb: the caller was proceeding on the belief that the index points at ITS acceptance, and
    // it does not. Report the winner instead of deciding — who may be served, and whether a foreign
    // winner is answerable at all, is the endpoint's policy, not the substrate's.
    return { recorded: false, existing: entry };
  }
}

/** Delete an index entry once its goal is terminal (or after a sweep settles it): a terminal goal
 *  is never reconciled again. Idempotent — an absent entry is a no-op. */
export async function clearGoalIndex(ctx: ActionContext, ref: GoalRef): Promise<void> {
  assertCtx(ctx);
  await ctx.kv.delete(goalIndexKey(snapshotRef(ref)));
}

/** Read ONE reconcile-index entry over the goal-writer's own bonded KV — the durable answer to
 *  "who accepted this goalId, and what identity did they allocate for it", available from the
 *  moment of acceptance rather than only once a terminal exists. Absent means no incarnation ever
 *  durably accepted it. */
export async function readGoalIndex(ctx: ActionContext, ref: GoalRef): Promise<GoalIndexEntry | undefined> {
  assertCtx(ctx);
  const key = goalIndexKey(snapshotRef(ref));
  const e = await ctx.kv.get(key);
  if (!e || e.operation !== "PUT") return undefined;
  return parseGoalIndexEntry(JSON.parse(new TextDecoder().decode(e.value)), key);
}

/** Enumerate the endpoint's in-flight reconcile index over a RAW records KV: a successor's boot
 *  sweep opens it with the PROVISIONER credential (records CONSUMER.CREATE), never the goal-writer
 *  (which holds no enumeration grant), and settles each unterminal goal so an accepted goal is
 *  never dropped across a manager restart. Returns each recorded GoalRef + the accepting `iid` (the
 *  hook a multi-instance sweep filters on so it never settles a live sibling's goal). */
export async function listGoalIndex(kv: KV, endpoint: string): Promise<{ ref: GoalRef; iid: string }[]> {
  const filter = `${RECORD_KINDS.goalidx.kind}.${endpointToken(endpoint)}.>`;
  const out: { ref: GoalRef; iid: string }[] = [];
  for await (const key of await kv.keys(filter)) {
    const e = await kv.get(key);
    if (!e || e.operation !== "PUT") continue; // deleted/absent since the key listed: terminal already cleared
    const v = parseGoalIndexEntry(JSON.parse(new TextDecoder().decode(e.value)), key);
    out.push({ ref: { endpoint: v.endpoint, caller: { owner: v.owner, actor: v.actor, uid: v.uid }, goalId: v.goalId }, iid: v.iid });
  }
  return out;
}

// ---- goalId reuse (§13.6 item 5) ---------------------------------------------------------------

/** Classify a resubmission against the recorded bind: same fingerprint = retry (cached), else
 *  `conflict`. {@link resolveGoalSubmission} composes this with the orphaned-bind recovery. */
export function classifyGoalReuse(existing: GoalBindFact, submittedFingerprint: string): "cached" | "conflict" {
  return existing.fingerprint === submittedFingerprint ? "cached" : "conflict";
}
