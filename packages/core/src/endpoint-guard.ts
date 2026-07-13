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
 * This module is the WIRING between the D6 governed-trait verification (which yields the guard
 * endpoint), the class-call verb (injected as a seam so the wiring stays transport-thin), the
 * awaitable checkpoint (the §13.6 pause primitive the hold reuses), and the action's status
 * projection. The gate never guesses: every path that is not a well-formed, obligation-valid
 * ALLOW or HOLD is a refusal.
 */
import { EpEnvelopeError } from "./endpoint-envelope.js";
import type { EpCaller } from "./endpoint-subjects.js";
import { verifyArtifactSignature, resolveAnchorForUse, assertAnchorScopeCovers, type AnchorResolver } from "./endpoint-signing.js";
import { mintCheckpoint, resumeCheckpoint, type CheckpointSettleFact } from "./endpoint-checkpoint.js";
import { transitionGoal, commitGoalResult, projectGoalTerminal, readGoalStatus, type ActionContext, type GoalRef, type GoalStatusValue, type GoalResultFact } from "./endpoint-action.js";

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
 *  subject by the caller's transport layer, never from the body). */
export type GuardCallSeam = (guardEndpoint: string) => Promise<{ answer: unknown; responder: { id: string; lifecycleUid: string } }>;

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
  request: { endpoint: string; id: string; caller: EpCaller };
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
    called = await withGateBudget(opts.callGuard(opts.guardEndpoint), remainingMs(), "the guard");
  } catch (e) {
    if (e instanceof EpEnvelopeError && e.code === "permission-denied") throw e;
    denyClosed(`the guard call failed (${(e as Error)?.message ?? String(e)})`);
  }
  if (!isRec(called) || !isRec(called.responder)
    || typeof (called.responder as Record<string, unknown>).id !== "string"
    || typeof (called.responder as Record<string, unknown>).lifecycleUid !== "string")
    denyClosed("the guard call seam returned no authenticated responder identity");

  const { answer, rawObligations } = parseGuardAnswer(called.answer);
  if (answer.decision === "deny")
    throw new EpEnvelopeError("permission-denied", `the guard denied this request${answer.reason !== undefined ? `: ${answer.reason}` : ""} (SPEC 13.6: guard-then-effect)`);
  for (let i = 0; i < answer.obligations.length; i++)
    await verifyObligation(rawObligations[i], answer.obligations[i], i,
      { resolveAnchor: opts.resolveAnchor, now: opts.now, space: opts.space, endpoint: opts.request.endpoint, requestId: opts.request.id, remainingMs });
  if (answer.decision === "allow") return { decision: "allow", obligations: answer.obligations };
  return { decision: "hold", token: answer.token, holdDeadlineMs: answer.holdDeadlineMs, obligations: answer.obligations, responder: called.responder };
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
  return transitionGoal(ctx, args.goal, "waiting", { fields: { checkpoint: { token: args.hold.token, deadlineGeneration: 1 } }, ownerAuthored: true });
}

/** Release a guard hold: the GUARD (the checkpoint's holder, presenting as itself) resumes the
 *  one-use checkpoint, and the goal leaves `waiting` back to `running`. The resume seam
 *  enforces holder binding, one-use, and the deadline fence — it RETURNS only a won `resumed`
 *  settlement and throws on everything else (a hold past its deadline drives the EXPIRED
 *  settlement there and refuses; an expired hold never releases). */
export async function releaseGuardHold(
  ctx: ActionContext,
  args: { goal: GoalRef; token: string; presenter: { id: string; lifecycleUid: string }; now: number },
): Promise<{ settle: CheckpointSettleFact; status: GoalStatusValue }> {
  const settle = await resumeCheckpoint(ctx.kv, ctx.js, ctx.jsm, ctx.space, {
    ref: { endpoint: args.goal.endpoint, token: args.token }, presenter: args.presenter, now: args.now,
  });
  // The release is OWNER-authored (the guard's holder-bound resume is the authority, verified
  // by resumeCheckpoint); the goal returns from the owner-driven pause to running.
  const status = await transitionGoal(ctx, args.goal, "running", { ownerAuthored: true });
  return { settle, status };
}

/** Settle an EXPIRED guard hold onto the goal: an expired hold is DENY (fail closed), so the
 *  goal commits terminal `failed` (permission-denied) at the shared commit point — where a
 *  racing completion or cancel may lawfully have won first (the caller observes the winner;
 *  the projection converges either way). Idempotent: an already-terminal goal returns its
 *  winner. */
export async function expireGuardHold(
  ctx: ActionContext,
  args: { goal: GoalRef; token: string; now: number },
): Promise<{ won: boolean; fact: GoalResultFact; status: GoalStatusValue }> {
  const status = await readGoalStatus(ctx, args.goal);
  if (status === undefined)
    throw new EpEnvelopeError("failed-precondition", `goal "${args.goal.goalId}" is unknown; an expiry settles only an accepted goal (SPEC 13.6)`);
  // An expired hold is DENY (owner-authored fail-closed) → the goal commits terminal failed via
  // the `deny` cause at the shared commit point, where a racing completion/cancel may win first.
  const res = await commitGoalResult(ctx, {
    ref: args.goal, now: args.now, cause: "deny",
    data: { code: "permission-denied", reason: `the guard hold "${args.token}" expired without a release; timeout is deny (SPEC 13.6: fail closed)` },
  });
  return res;
}
