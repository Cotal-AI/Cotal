/**
 * The GUARD CHECKPOINT (SPEC §13.6): the pre-effect authorization hook. A command carrying the
 * governed `ai.cotal.guarded` trait MUST NOT effect until the guard endpoint named by the
 * verified trait value answered ALLOW (class call). Answers: `allow | deny | hold` plus
 * optional SIGNED obligations (attenuations the endpoint MUST apply; monotonic, §13.10 replay
 * matrix: bound to the goal/request, reusable within it). `hold` converts the action to
 * `waiting` on a checkpoint OWNED BY THE GUARD DECISION (the guard's authenticated responder
 * is the checkpoint holder — only IT can release the hold). Timeout, an unreachable guard, a
 * garbled answer, or an invalid obligation is DENY (fail closed). Ordering is
 * guard-then-effect; side-effecting guards own their own reconciliation.
 *
 * This module is THE guard gate. There is exactly one: {@link runGuardGate} owns the guard
 * call, the closed answer parse, and the D28 obligation verification, and BOTH production
 * rails run through it — the ephemeral serve rail via `assertGovernedPreEffect` (which
 * refuses hold, since an ephemeral request cannot wait) and the action composite via
 * {@link gateGoalExecution} (which ROUTES hold into the checkpoint pause and a guard deny
 * into the shared terminal commit). {@link reconcileGuardHold} is the durable backstop that
 * converges a settled hold whose projection crashed mid-flight. The gate never guesses:
 * every path that is not a well-formed, obligation-valid ALLOW or HOLD is a refusal.
 */
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { canonicalJson } from "./canonical.js";
import type { EpCaller } from "./endpoint-subjects.js";
import { verifyArtifactSignature, resolveAnchorForUse, assertAnchorScopeCovers, type AnchorResolver } from "./endpoint-signing.js";
import { mintCheckpoint, resumeCheckpoint, readCheckpointSpec, readCheckpointSettle, expireCheckpoint, type CheckpointSettleFact } from "./endpoint-checkpoint.js";
import { transitionGoal, commitGoalResult, projectGoalTerminal, readGoalStatus, readGoalResult, ownerCommitProof, snapshotRef, type ActionContext, type GoalRef, type GoalStatusValue, type GoalResultFact } from "./endpoint-action.js";

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A signed guard OBLIGATION (§13.6/§13.10): attenuations the effecting endpoint MUST apply,
 *  bound to its goal/request id, reusable within it. Verified against the anchor registry
 *  (role `obligations`, scope = the endpoints the key may attest for). */
export interface GuardObligation {
  v: 1;
  space: string;
  /** The guarded goal/request id this obligation binds to (§13.10: bound to its goal/request). */
  requestId: string;
  signer: { keyId: string };
  /** The monotonic attenuations the endpoint MUST apply; opaque to this wiring (the effecting
   *  handler interprets them), validated as non-empty structured entries and signed. */
  attenuations: unknown[];
  iat: number;
  exp: number;
  sig: string;
}

/** The guard endpoint's parsed answer (closed per decision): `hold` carries the checkpoint
 *  coordinates; `deny` carries an optional reason; obligations ride `allow`/`hold` only. */
export type GuardAnswer =
  | { decision: "allow"; obligations: GuardObligation[] }
  | { decision: "deny"; reason?: string }
  | { decision: "hold"; token: string; holdDeadlineMs: number; obligations: GuardObligation[] };

function denyClosed(why: string): never {
  throw new EpEnvelopeError("permission-denied", `guard gate DENIES: ${why} (SPEC 13.6: timeout, an unreachable guard, or a garbled answer is deny — the gate fails closed, never open)`);
}

function parseObligation(raw: unknown, i: number): Omit<GuardObligation, "sig"> & { sig: string } {
  if (!isRec(raw)) denyClosed(`obligation[${i}] is not an object`);
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["v", "space", "requestId", "signer", "attenuations", "iat", "exp", "sig"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) denyClosed(`obligation[${i}] carries the unknown field "${k}" (closed schema)`);
  if (o.v !== 1 || typeof o.space !== "string" || o.space.length === 0) denyClosed(`obligation[${i}] has no version/space`);
  if (typeof o.requestId !== "string" || o.requestId.length === 0) denyClosed(`obligation[${i}] binds no requestId`);
  if (!isRec(o.signer) || typeof (o.signer as Record<string, unknown>).keyId !== "string") denyClosed(`obligation[${i}] names no signer keyId`);
  if (!Array.isArray(o.attenuations) || o.attenuations.length === 0 || !o.attenuations.every(isRec))
    denyClosed(`obligation[${i}] carries no structured attenuations (an obligation that attenuates nothing is garbled)`);
  for (const f of ["iat", "exp"]) if (typeof o[f] !== "number" || !Number.isSafeInteger(o[f]) || (o[f] as number) < 0) denyClosed(`obligation[${i}] ${f} is not a non-negative safe integer`);
  if ((o.exp as number) <= (o.iat as number)) denyClosed(`obligation[${i}] exp is not after iat`);
  if (typeof o.sig !== "string" || o.sig.length === 0) denyClosed(`obligation[${i}] is unsigned`);
  return o as unknown as GuardObligation;
}

/** Race an await against the REMAINING guard budget: the whole gate (the guard call AND every
 *  obligation's anchor resolution) is ONE bounded operation, so a stuck registry after the
 *  guard answered cannot hang the gate. Timeout is DENY (SPEC 13.6: fail closed). Races
 *  `Promise.resolve(p)` unconditionally (a non-native thenable must not bypass the deadline). */
async function withGateBudget<T>(p: Promise<T> | T, remainingMs: number, what: string): Promise<T> {
  if (remainingMs <= 0)
    throw new EpEnvelopeError("permission-denied", `${what} found the guard budget already exhausted; the gate is one bounded operation and timeout is DENY (SPEC 13.6: fail closed)`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EpEnvelopeError("permission-denied", `${what} did not answer within the remaining ${remainingMs}ms guard budget; timeout is DENY (SPEC 13.6: fail closed)`)), remainingMs);
  });
  try { return await Promise.race([Promise.resolve(p), deadline]); } finally { clearTimeout(timer); }
}

/** Verify one obligation against the trust-anchor registry: D28 signature over the EXACT RAW
 *  artifact, `obligations` role, scope covering the GUARDED endpoint, anchor window at `iat`,
 *  obligation window at `now`, space + request binding. Any failure denies (fail closed), and
 *  the anchor resolution runs within the gate's REMAINING budget. */
async function verifyObligation(
  raw: unknown, ob: GuardObligation, i: number,
  opts: { resolveAnchor: AnchorResolver; now: number; space: string; endpoint: string; requestId: string; remainingMs: () => number },
): Promise<void> {
  if (ob.space !== opts.space) denyClosed(`obligation[${i}] is bound to space ${ob.space}, not ${opts.space}`);
  if (ob.requestId !== opts.requestId) denyClosed(`obligation[${i}] binds requestId ${ob.requestId}, not this request's ${opts.requestId} (an obligation is bound to its goal/request)`);
  if (opts.now < ob.iat || opts.now > ob.exp) denyClosed(`obligation[${i}] is outside its validity window [${ob.iat}, ${ob.exp}] at now ${opts.now}`);
  let anchor;
  try {
    anchor = await withGateBudget(
      resolveAnchorForUse(opts.resolveAnchor, { keyId: ob.signer.keyId, role: "obligations", at: ob.iat }),
      opts.remainingMs(), `obligation[${i}]'s anchor resolution`);
    assertAnchorScopeCovers(anchor, "obligations", opts.endpoint, `obligation[${i}] for endpoint`);
    verifyArtifactSignature(raw as Record<string, unknown>, anchor);
  } catch (e) {
    denyClosed(`obligation[${i}] does not verify (${(e as Error).message})`);
  }
}

/** Parse the guard endpoint's raw answer body, CLOSED per decision. Anything else denies. */
function parseGuardAnswer(raw: unknown): { answer: GuardAnswer; rawObligations: unknown[] } {
  if (!isRec(raw)) denyClosed("the guard answered with a non-object body");
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["v", "decision", "reason", "token", "holdDeadlineMs", "obligations"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) denyClosed(`the guard answer carries the unknown field "${k}" (closed schema)`);
  if (o.v !== 1) denyClosed("the guard answer version is not 1");
  if (o.decision !== "allow" && o.decision !== "deny" && o.decision !== "hold")
    denyClosed(`the guard decision ${JSON.stringify(o.decision)} is not allow|deny|hold`);
  const rawObs = o.obligations === undefined ? [] : o.obligations;
  if (!Array.isArray(rawObs)) denyClosed("the guard answer obligations is not an array");
  if (o.decision === "deny") {
    if (o.obligations !== undefined || o.token !== undefined || o.holdDeadlineMs !== undefined)
      denyClosed("a deny answer carries allow/hold fields (garbled cross-variant answer)");
    if (o.reason !== undefined && typeof o.reason !== "string") denyClosed("the deny reason is not a string");
    return { answer: { decision: "deny", ...(o.reason !== undefined ? { reason: o.reason as string } : {}) }, rawObligations: [] };
  }
  if (o.reason !== undefined) denyClosed(`a ${o.decision} answer carries a deny reason (garbled cross-variant answer)`);
  const obligations = rawObs.map((r, i) => parseObligation(r, i));
  if (o.decision === "allow") {
    if (o.token !== undefined || o.holdDeadlineMs !== undefined) denyClosed("an allow answer carries hold fields (garbled cross-variant answer)");
    return { answer: { decision: "allow", obligations }, rawObligations: rawObs };
  }
  if (typeof o.token !== "string" || o.token.length === 0) denyClosed("a hold answer names no checkpoint token");
  if (typeof o.holdDeadlineMs !== "number" || !Number.isSafeInteger(o.holdDeadlineMs) || o.holdDeadlineMs <= 0)
    denyClosed("a hold answer has no positive integer holdDeadlineMs (deadlines are mandatory, SPEC 13.6)");
  return { answer: { decision: "hold", token: o.token, holdDeadlineMs: o.holdDeadlineMs, obligations }, rawObligations: rawObs };
}

/** The injected class-call seam: invoke the guard endpoint's decision command and return its
 *  raw answer body PLUS the broker-authenticated responder identity (derived from the reply
 *  subject by the caller's transport layer, never from the body). The seam receives the
 *  guarded request's coordinates so the guard knows WHAT it is deciding; the GATE owns all
 *  parsing and verification of the answer, so no wiring can surface an unverified obligation. */
export type GuardCallSeam = (q: {
  /** The guard endpoint the VERIFIED trait value names. */
  guardEndpoint: string;
  /** The guarded request's broker-authenticated coordinates. */
  endpoint: string;
  command?: string;
  requestId: string;
  caller: EpCaller;
}) => Promise<{ answer: unknown; responder: { id: string; lifecycleUid: string } }>;

/** The gate's verdict for the effecting handler. */
export type GuardVerdict =
  | { decision: "allow"; obligations: GuardObligation[] }
  | { decision: "hold"; token: string; holdDeadlineMs: number; obligations: GuardObligation[]; responder: { id: string; lifecycleUid: string } };

/** Run the §13.6 guard gate for one guarded request: call the guard endpoint (via the injected
 *  seam) within `deadlineMs`, and classify FAIL-CLOSED — the ONLY outcomes are a verified
 *  ALLOW, a verified HOLD (the caller then wires the pause via {@link holdGuardedGoal}), or a
 *  `permission-denied` throw. A timeout, transport failure, garbled answer, cross-variant
 *  fields, or an obligation that does not verify (signature, scope, window, request binding)
 *  all DENY. Ordering is guard-then-effect: call this BEFORE any effect. */
export async function runGuardGate(opts: {
  /** The guard endpoint named by the VERIFIED `ai.cotal.guarded` trait value (the D6 governed
   *  attachment verification is the caller's step; this seam trusts its output only). */
  guardEndpoint: string;
  /** The guarded request's coordinates (broker-authenticated at the serve boundary). */
  request: { endpoint: string; command?: string; id: string; caller: EpCaller };
  callGuard: GuardCallSeam;
  /** The guard budget: past it the gate DENIES (never hangs, never allows). */
  deadlineMs: number;
  now: number;
  space: string;
  resolveAnchor: AnchorResolver;
}): Promise<GuardVerdict> {
  if (typeof opts.guardEndpoint !== "string" || opts.guardEndpoint.length === 0)
    denyClosed("the guarded trait names no guard endpoint");
  if (!Number.isSafeInteger(opts.deadlineMs) || opts.deadlineMs <= 0)
    throw new EpEnvelopeError("failed-precondition", `the guard deadline must be a positive integer; got ${JSON.stringify(opts.deadlineMs)}`);
  if (!Number.isSafeInteger(opts.now) || opts.now < 0)
    throw new EpEnvelopeError("failed-precondition", `now must be a non-negative safe integer; got ${JSON.stringify(opts.now)}`);

  // ONE total gate budget: the guard call and every obligation verification share this clock,
  // so a stuck anchor registry AFTER the guard answered is still a bounded DENY.
  const gateDeadlineAt = Date.now() + opts.deadlineMs;
  const remainingMs = () => gateDeadlineAt - Date.now();
  let called: { answer: unknown; responder: { id: string; lifecycleUid: string } };
  try {
    called = await withGateBudget(opts.callGuard({
      guardEndpoint: opts.guardEndpoint,
      endpoint: opts.request.endpoint,
      ...(opts.request.command !== undefined ? { command: opts.request.command } : {}),
      requestId: opts.request.id,
      caller: opts.request.caller,
    }), remainingMs(), "the guard");
  } catch (e) {
    if (e instanceof EpEnvelopeError && e.code === "permission-denied") throw e;
    denyClosed(`the guard call failed (${(e as Error)?.message ?? String(e)})`);
  }
  if (!isRec(called) || !isRec(called.responder)
    || typeof (called.responder as Record<string, unknown>).id !== "string"
    || typeof (called.responder as Record<string, unknown>).lifecycleUid !== "string")
    denyClosed("the guard call seam returned no authenticated responder identity");
  // SNAPSHOT the seam's answer and responder to DETACHED values at entry, BEFORE the parse and
  // the anchor awaits: the obligation signatures verify over EXACTLY these bytes, so a caller
  // that mutates the raw answer/obligations/responder during the awaited anchor resolution can
  // never split what was parsed/scoped from what the signature verifies (D28 consuming boundary).
  let answerSnapshot: unknown;
  try { answerSnapshot = JSON.parse(canonicalJson(called.answer)); } // throws on non-interchangeable I-JSON; the detached tree is unreachable to the caller
  catch (e) { return denyClosed(`the guard answer is not interchangeable JSON (${(e as Error).message})`); }
  const responder = Object.freeze({ id: called.responder.id, lifecycleUid: called.responder.lifecycleUid });

  const { answer, rawObligations } = parseGuardAnswer(answerSnapshot);
  if (answer.decision === "deny")
    throw new EpEnvelopeError("permission-denied", `the guard denied this request${answer.reason !== undefined ? `: ${answer.reason}` : ""} (SPEC 13.6: guard-then-effect)`);
  for (let i = 0; i < answer.obligations.length; i++)
    await verifyObligation(rawObligations[i], answer.obligations[i], i,
      { resolveAnchor: opts.resolveAnchor, now: opts.now, space: opts.space, endpoint: opts.request.endpoint, requestId: opts.request.id, remainingMs });
  if (answer.decision === "allow") return { decision: "allow", obligations: answer.obligations };
  return { decision: "hold", token: answer.token, holdDeadlineMs: answer.holdDeadlineMs, obligations: answer.obligations, responder };
}

/** The ACTION composite's guard gate (§13.6): run by the OWNING instance for a guarded goal
 *  BEFORE any execution effect — the counterpart of the ephemeral rail's
 *  `assertGovernedPreEffect`, with hold ROUTED instead of refused. {@link runGuardGate} does
 *  the calling, parsing, and obligation verification; this seam projects the verdict onto the
 *  goal:
 *   - ALLOW: the goal transitions accepted → running under the owner's construction-bound
 *     proof (this projection is the owner's admission to execute) and the VERIFIED
 *     obligations return for the executor, which MUST apply them;
 *   - HOLD: {@link holdGuardedGoal} mints the guard-holder-bound checkpoint and projects
 *     `waiting`;
 *   - DENY (or ANY fail-closed gate refusal: timeout, garble, unverifiable obligation): the
 *     goal commits terminal `failed` at the shared commit point under the OWNER's
 *     construction-bound proof — the owner runs this gate, so the deny predicate is the
 *     owner's own refusal to execute, carrying the gate's reason in the terminal payload.
 *  Obligations bind to the GOAL id (§13.10: bound to its goal/request, reusable within it). */
export async function gateGoalExecution(
  ctx: ActionContext,
  args: {
    goal: GoalRef;
    /** The guard endpoint named by the goal's VERIFIED `ai.cotal.guarded` trait value. */
    guardEndpoint: string;
    callGuard: GuardCallSeam;
    resolveAnchor: AnchorResolver;
    deadlineMs: number;
    now: number;
    /** The OWNING instance arming a hold's timer (its identity/epoch subject, §13.12). */
    instanceId: string;
    epoch: number;
  },
): Promise<
  | { outcome: "running"; obligations: GuardObligation[]; status: GoalStatusValue }
  | { outcome: "waiting"; hold: { token: string; holdDeadlineMs: number }; status: GoalStatusValue }
  | { outcome: "denied"; won: boolean; fact: GoalResultFact; status: GoalStatusValue }
> {
  const goal = snapshotRef(args.goal);
  let verdict: GuardVerdict;
  try {
    verdict = await runGuardGate({
      guardEndpoint: args.guardEndpoint,
      request: { endpoint: goal.endpoint, id: goal.goalId, caller: goal.caller },
      callGuard: args.callGuard,
      deadlineMs: args.deadlineMs,
      now: args.now,
      space: ctx.space,
      resolveAnchor: args.resolveAnchor,
    });
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "permission-denied")) throw e; // wiring errors propagate; only the gate's fail-closed deny terminalizes
    const res = await commitGoalResult(ctx, {
      ref: goal, now: args.now, cause: "deny", denial: { kind: "owner", owner: ownerCommitProof(ctx) },
      data: { code: "permission-denied", reason: (e as Error).message },
    });
    return { outcome: "denied", won: res.won, fact: res.fact, status: res.status };
  }
  if (verdict.decision === "hold") {
    const status = await holdGuardedGoal(ctx, {
      goal, hold: { token: verdict.token, holdDeadlineMs: verdict.holdDeadlineMs, responder: verdict.responder },
      instanceId: args.instanceId, epoch: args.epoch, now: args.now,
    });
    return { outcome: "waiting", hold: { token: verdict.token, holdDeadlineMs: verdict.holdDeadlineMs }, status };
  }
  const status = await transitionGoal(ctx, goal, "running", { owner: ownerCommitProof(ctx) });
  return { outcome: "running", obligations: verdict.obligations, status };
}

/** The durable HOLD reconciler (§13.6): converge a goal whose guard-hold checkpoint SETTLED
 *  while the goal projection lags (a release or expiry crashed mid-flight, or the timer fire
 *  settled the checkpoint and the owner's projection is still owed). For a goal `waiting` on
 *  checkpoint T whose spec binds THIS goal:
 *   - settle RESUMED: finish the projection to `running` (idempotent);
 *   - settle EXPIRED: drive the terminal deny via {@link expireGuardHold} (idempotent);
 *   - still live: nothing to do — the timer plane owns the deadline.
 *  A goal not waiting, or waiting on a token whose checkpoint does not bind it, is left
 *  untouched: this reconciler converges exactly the holds this module minted. */
export async function reconcileGuardHold(
  ctx: ActionContext,
  args: { goal: GoalRef; now: number },
): Promise<{ converged: "running" | "denied" | "none" }> {
  const goal = snapshotRef(args.goal);
  const status = await readGoalStatus(ctx, goal);
  if (status === undefined || status.value.state !== "waiting" || status.value.checkpoint === undefined)
    return { converged: "none" };
  const token = status.value.checkpoint.token;
  try { await bindCheckpointToGoal(ctx, goal, token); } catch { return { converged: "none" }; } // a foreign/unknown token's wait is not this reconciler's to converge
  const settle = await readCheckpointSettle(ctx.jsm, ctx.space, { endpoint: goal.endpoint, token });
  if (settle === undefined) return { converged: "none" };
  if (settle.settle === "resumed") {
    const cur = await readGoalStatus(ctx, goal);
    if (cur?.value.state === "waiting" && cur.value.checkpoint?.token === token)
      await transitionGoal(ctx, goal, "running", { owner: ownerCommitProof(ctx) });
    return { converged: "running" };
  }
  await expireGuardHold(ctx, { goal, token, now: args.now });
  return { converged: "denied" };
}

/** Convert a HELD action to `waiting` on a checkpoint OWNED BY THE GUARD DECISION (§13.6): the
 *  checkpoint's holder is the guard's authenticated responder (only IT may resume), the
 *  deadline is the hold's (mandatory), and the goal's status projects `waiting` carrying the
 *  checkpoint coordinate. The mint is idempotent and the timer is armed through the mediated
 *  plane by the checkpoint module. */
export async function holdGuardedGoal(
  ctx: ActionContext,
  args: {
    goal: GoalRef;
    hold: { token: string; holdDeadlineMs: number; responder: { id: string; lifecycleUid: string } };
    /** The OWNING instance arming the hold's timer (its identity/epoch subject, §13.12). */
    instanceId: string;
    epoch: number;
    now: number;
  },
): Promise<GoalStatusValue> {
  await mintCheckpoint(ctx.kv, ctx.js, ctx.space, {
    ref: { endpoint: args.goal.endpoint, token: args.hold.token },
    instanceId: args.instanceId, epoch: args.epoch,
    goal: { caller: args.goal.caller, goalId: args.goal.goalId },
    holder: args.hold.responder,
    deadline: args.now + args.hold.holdDeadlineMs, now: args.now,
  });
  // The pause is OWNER-authored (the owner mints the checkpoint and records the wait), not a
  // remote executor's progress step, so a target-pinned goal's hold does not require executor
  // currency here — the guard responder, not a superseded executor, is the checkpoint holder.
  // The authority is the CONSTRUCTION-BOUND owner proof from this context, never a raw flag.
  return transitionGoal(ctx, args.goal, "waiting", { fields: { checkpoint: { token: args.hold.token, deadlineGeneration: 1 } }, owner: ownerCommitProof(ctx) });
}

/** Bind a hold's checkpoint token to THIS goal (§13.6): read the checkpoint's recorded spec and
 *  require its `goal` to be the exact goal being released/expired — a checkpoint pauses ONE
 *  recorded goal (holdGuardedGoal mints it with that binding), so a valid token for goal A must
 *  never drive a transition on unrelated goal B. Fail-closed: an unknown token, a spec with no
 *  goal binding, or a mismatched caller/goalId all refuse before any state is touched. */
async function bindCheckpointToGoal(ctx: ActionContext, goal: GoalRef, token: string): Promise<void> {
  const spec = await readCheckpointSpec(ctx.kv, { endpoint: goal.endpoint, token });
  if (spec === undefined)
    throw new EpEnvelopeError("failed-precondition", `checkpoint "${token}" is unknown on endpoint "${goal.endpoint}"; a guard hold names a minted checkpoint (SPEC 13.6)`);
  const g = spec.goal;
  if (g === undefined)
    throw new EpEnvelopeError("permission-denied", `checkpoint "${token}" records no goal binding; it does not pause goal "${goal.goalId}" and cannot drive its transition (SPEC 13.6)`);
  if (g.goalId !== goal.goalId || g.caller.owner !== goal.caller.owner || g.caller.actor !== goal.caller.actor || g.caller.uid !== goal.caller.uid)
    throw new EpEnvelopeError("permission-denied", `checkpoint "${token}" pauses goal "${g.goalId}" (${g.caller.owner}.${g.caller.actor}/${g.caller.uid}), not the presented goal "${goal.goalId}"; a hold's token is goal-bound, never a free release of any goal on the endpoint (SPEC 13.6)`);
}

/** Release a guard hold: the GUARD (the checkpoint's holder, presenting as itself) resumes the
 *  one-use checkpoint, and the goal leaves `waiting` back to `running`. The token is first bound
 *  to THIS goal (a valid token for another goal never releases it), THEN the resume seam
 *  enforces holder binding, one-use, and the deadline fence (a hold past its deadline drives
 *  the EXPIRED settlement there and refuses; an expired hold never releases).
 *
 *  CRASH CONVERGENCE (the checkpoint settlement is the arbiter; the goal transition is its
 *  derived projection): a crash between the one-use resume and the goal transition leaves the
 *  checkpoint `resumed` and the goal `waiting` — the RETRY's resume loses `conflict`, so it
 *  OBSERVES the recorded settlement, requires it to be THIS presenter's own `resumed` (a
 *  foreign or expired settlement rethrows), and finishes the projection idempotently (a goal
 *  already `running` is the converged state, not an error). */
export async function releaseGuardHold(
  ctx: ActionContext,
  args: { goal: GoalRef; token: string; presenter: { id: string; lifecycleUid: string }; now: number },
): Promise<{ settle: CheckpointSettleFact; status: GoalStatusValue }> {
  // Entry snapshots (single-read): the presenter is compared against the recorded settlement on
  // the convergence path, and the FULL goal detaches ONCE here (MEDIUM) so bind, resume, and the
  // projection all read this snapshot - a goal mutated across the resume await can never validate
  // goal A's checkpoint and then project goal B.
  const presenter = Object.freeze({ id: String(args.presenter.id), lifecycleUid: String(args.presenter.lifecycleUid) });
  const goal = snapshotRef(args.goal);
  const token = String(args.token);
  const cpRef = { endpoint: goal.endpoint, token };
  await bindCheckpointToGoal(ctx, goal, token); // goal-binding BEFORE consuming the one-use resume
  let settle: CheckpointSettleFact;
  try {
    settle = await resumeCheckpoint(ctx.kv, ctx.js, ctx.jsm, ctx.space, { ref: cpRef, presenter, now: args.now });
  } catch (e) {
    if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
    // The one-use resume is already consumed: converge IFF the recorded settlement is THIS
    // presenter's own resume (the crashed earlier attempt won); anything else rethrows.
    const winner = await readCheckpointSettle(ctx.jsm, ctx.space, cpRef);
    if (winner === undefined || winner.settle !== "resumed"
      || winner.holder?.id !== presenter.id || winner.holder?.lifecycleUid !== presenter.lifecycleUid) throw e;
    settle = winner;
  }
  // The goal returns from its owner-driven pause to running (the guard's holder-bound resume is
  // the authority, verified by resumeCheckpoint; the proof is construction-bound), but ONLY if it
  // is currently waiting on THIS hold's checkpoint (HIGH 1): a stale or replayed release of an OLD
  // (already-resumed) hold must never move a goal that is now waiting on a DIFFERENT, live hold. An
  // already-running goal is the converged crash state (idempotent); a goal waiting on another token
  // (or terminal/unknown) refuses.
  const current = await readGoalStatus(ctx, goal);
  if (current?.value.state === "running") return { settle, status: current.value };
  const waitingToken = current?.value.state === "waiting" ? current.value.checkpoint?.token : undefined;
  if (waitingToken !== token)
    throw new EpEnvelopeError("failed-precondition", `goal "${goal.goalId}" is not waiting on checkpoint "${token}" (${current === undefined ? "unknown goal" : current.value.state === "waiting" ? `it waits on "${String(waitingToken)}"` : `it is ${current.value.state}`}); a release of an old hold never moves a goal paused on a newer one (SPEC 13.6)`);
  const status = await transitionGoal(ctx, goal, "running", { owner: ownerCommitProof(ctx) });
  return { settle, status };
}

/** Settle an EXPIRED guard hold onto the goal: an expired hold is DENY (fail closed). The token
 *  is first bound to THIS goal (an arbitrary token never terminal-fails an unrelated goal), then
 *  the CHECKPOINT is owner-expired (settling its status and stopping its timers, so no orphaned
 *  schedule lingers until the checkpoint's own deadline), and finally the goal commits terminal
 *  `failed` (permission-denied) at the shared commit point — where a racing completion or cancel
 *  may lawfully have won first (the caller observes the winner; the projection converges either
 *  way). Idempotent: an already-terminal goal returns its winner. */
export async function expireGuardHold(
  ctx: ActionContext,
  args: { goal: GoalRef; token: string; now: number },
): Promise<{ won: boolean; fact: GoalResultFact; status: GoalStatusValue }> {
  const goal = snapshotRef(args.goal); // detach the full goal ONCE (same discipline as release)
  const token = String(args.token);
  await bindCheckpointToGoal(ctx, goal, token); // goal-binding BEFORE terminalizing anything
  const status = await readGoalStatus(ctx, goal);
  if (status === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${goal.goalId}" is unknown; an expiry settles only an accepted goal (SPEC 13.6)`);
  // Owner-expire the DUE checkpoint so its status settles and its timers stop (idempotent; an
  // already-settled checkpoint returns its winner). The goal terminal is the authority for the
  // caller, but the checkpoint must not be left waiting with a live timer.
  const settled = await expireCheckpoint(ctx.kv, ctx.js, ctx.jsm, ctx.space, { ref: { endpoint: goal.endpoint, token }, now: args.now });
  if (settled.settle === "resumed") {
    // The hold was lawfully RELEASED before this expiry: a resumed hold never denies. A raced
    // caller observes the goal's recorded terminal if one exists. If the release resumed the
    // checkpoint but CRASHED before projecting the goal, the goal is still waiting on THIS token -
    // FINISH that projection here (goal -> running) so it never hangs waiting forever (HIGH 4: a
    // plain refusal is not crash recovery), then refuse (there is no terminal to return, and a
    // resumed hold never denies). Idempotent: an already-running/re-held goal is not re-projected.
    const fact = await readGoalResult(ctx, goal);
    if (fact !== undefined) return { won: false, fact, status: await projectGoalTerminal(ctx, goal) };
    const cur = await readGoalStatus(ctx, goal);
    if (cur?.value.state === "waiting" && cur.value.checkpoint?.token === token)
      await transitionGoal(ctx, goal, "running", { owner: ownerCommitProof(ctx) });
    throw new EpEnvelopeError("failed-precondition", `the guard hold "${token}" was RELEASED (resumed at ${settled.ts}), not expired; the goal projection is converged to running and a resumed hold never denies (SPEC 13.6)`);
  }
  // An expired hold is DENY (fail closed) → the goal commits terminal failed via the `deny`
  // cause at the shared commit point, where a racing completion/cancel may win first. The
  // denial carries its AUTHORITATIVE PREDICATE: the commit boundary itself re-verifies that
  // the named checkpoint binds THIS goal and that its recorded one-use settlement is EXPIRED
  // (the expiry recorded just above) — a bare deny cause proves nothing and is refused there.
  const res = await commitGoalResult(ctx, {
    ref: goal, now: args.now, cause: "deny", denial: { kind: "hold-expired", token },
    data: { code: "permission-denied", reason: `the guard hold "${token}" expired without a release; timeout is deny (SPEC 13.6: fail closed)` },
  });
  return res;
}
