/**
 * v0.4 §13.6 GUARD CHECKPOINT smoke — the pre-effect authorization hook against a real broker:
 * the fail-closed gate (allow | deny | hold; timeout / unreachable / garbled / cross-variant
 * answers all DENY), signed-obligation verification (D28 signature, obligations role + scope,
 * window, request binding — any failure denies), and the hold wiring over the checkpoint pause
 * primitive (hold → mint owned by the guard's authenticated responder + goal `waiting`;
 * release = holder-bound one-use resume + goal `running`; an expired hold is DENY → the goal
 * commits terminal failed at the shared commit point, converging on any racing winner).
 *
 * Run: pnpm smoke:ep-guard   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createUser } from "@nats-io/nkeys";
import {
  isReachable, EpEnvelopeError, signArtifact,
  createEndpointStreams, openRecordsBucket,
  actionContext, runGuardGate, holdGuardedGoal, releaseGuardHold, expireGuardHold,
  gateGoalExecution, reconcileGuardHold,
  createGoal, readGoalStatus, transitionGoal, commitGoalResult, readCheckpointStatus,
  ownerCommitProof, resumeCheckpoint, expireCheckpoint, readCheckpointSpec,
  type EpCaller, type GoalRef, type SignerAnchor, type AnchorResolver, type GuardCallSeam, type ActionContext,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "epguard";
const NOW = 1_000_000;
const UID = "u".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };
const goalOf = (goalId: string): GoalRef => ({ endpoint: "manager", caller, goalId });
const guardResponder = { id: "u_guard.svc", lifecycleUid: "g".repeat(26) };

// The obligation-signing anchor (role `obligations`, scoped to the guarded endpoint).
const guardKp = createUser();
const anchors = new Map<string, SignerAnchor>();
anchors.set("guard-1", { keyId: "guard-1", publicKey: guardKp.getPublicKey(), owner: "u_guard.svc", roles: ["obligations"], scope: { obligations: ["manager"] }, validFrom: 0, validTo: NOW + 10_000_000 });
anchors.set("narrow-1", { keyId: "narrow-1", publicKey: guardKp.getPublicKey(), owner: "u_guard.svc", roles: ["obligations"], scope: { obligations: ["other-endpoint"] }, validFrom: 0, validTo: NOW + 10_000_000 });
const resolveAnchor: AnchorResolver = (keyId) => anchors.get(keyId);

const obligationBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1, space: SPACE, requestId: "req-1", signer: { keyId: "guard-1" },
  attenuations: [{ maxItems: 5 }], iat: NOW - 1_000, exp: NOW + 60_000, ...over,
});
const answering = (answer: unknown, responder = guardResponder): GuardCallSeam => () => Promise.resolve({ answer, responder });
const gate = (seam: GuardCallSeam, over: Record<string, unknown> = {}) => runGuardGate({
  guardEndpoint: "approvals", request: { endpoint: "manager", id: "req-1", caller },
  callGuard: seam, deadlineMs: 5_000, now: NOW, space: SPACE, resolveAnchor, ...over,
});

// ── the fail-closed gate (broker-free) ──
{
  const allow = await gate(answering({ v: 1, decision: "allow" }));
  c("a plain ALLOW passes the gate with no obligations", allow.decision === "allow" && allow.obligations.length === 0);
  const signedOb = signArtifact(obligationBody(), guardKp);
  const allowOb = await gate(answering({ v: 1, decision: "allow", obligations: [signedOb] }));
  c("an ALLOW with a VALID signed obligation passes and returns it (the endpoint MUST apply it)",
    allowOb.decision === "allow" && allowOb.obligations.length === 1 && (allowOb.obligations[0].attenuations[0] as { maxItems: number }).maxItems === 5);
  const hold = await gate(answering({ v: 1, decision: "hold", token: "cp-hold", holdDeadlineMs: 30_000 }));
  c("a HOLD passes the gate carrying the checkpoint coordinates and the authenticated responder",
    hold.decision === "hold" && hold.token === "cp-hold" && hold.holdDeadlineMs === 30_000 && hold.responder.id === "u_guard.svc");
}
await rejects("a DENY refuses permission-denied (guard-then-effect)",
  () => gate(answering({ v: 1, decision: "deny", reason: "policy" })), "permission-denied");
await rejects("a guard TIMEOUT is deny (fail closed, bounded)",
  () => gate(() => new Promise(() => { /* never answers */ }), { deadlineMs: 100 }), "permission-denied");
await rejects("a non-native never-settling thenable cannot bypass the guard deadline",
  () => gate((() => ({ then() { /* never settles */ } })) as unknown as GuardCallSeam, { deadlineMs: 100 }), "permission-denied");
await rejects("an UNREACHABLE guard (transport throw) is deny",
  () => gate(() => Promise.reject(new Error("no responders"))), "permission-denied");
await rejects("a GARBLED decision is deny",
  () => gate(answering({ v: 1, decision: "maybe" })), "permission-denied");
await rejects("a cross-variant answer (deny carrying obligations) is deny-as-garbled",
  () => gate(answering({ v: 1, decision: "deny", obligations: [] })), "permission-denied");
await rejects("an allow answer carrying HOLD fields is garbled",
  () => gate(answering({ v: 1, decision: "allow", token: "cp-x", holdDeadlineMs: 5 })), "permission-denied");
await rejects("a hold answer without a positive holdDeadlineMs is garbled (deadlines are mandatory)",
  () => gate(answering({ v: 1, decision: "hold", token: "cp-x" })), "permission-denied");
await rejects("an unknown answer field is garbled (closed schema)",
  () => gate(answering({ v: 1, decision: "allow", rogue: 1 })), "permission-denied");
await rejects("a call seam returning NO authenticated responder is deny",
  () => gate((() => Promise.resolve({ answer: { v: 1, decision: "allow" } })) as unknown as GuardCallSeam), "permission-denied");
// obligation verification failures all deny:
await rejects("an obligation bound to a DIFFERENT request id denies",
  () => gate(answering({ v: 1, decision: "allow", obligations: [signArtifact(obligationBody({ requestId: "req-OTHER" }), guardKp)] })), "permission-denied");
await rejects("an obligation signed by an UNKNOWN key denies",
  () => gate(answering({ v: 1, decision: "allow", obligations: [signArtifact(obligationBody({ signer: { keyId: "who" } }), guardKp)] })), "permission-denied");
await rejects("an obligation whose key's scope does not cover the guarded endpoint denies",
  () => gate(answering({ v: 1, decision: "allow", obligations: [signArtifact(obligationBody({ signer: { keyId: "narrow-1" } }), guardKp)] })), "permission-denied");
await rejects("an EXPIRED obligation denies",
  () => gate(answering({ v: 1, decision: "allow", obligations: [signArtifact(obligationBody({ exp: NOW - 1 }), guardKp)] }), {}), "permission-denied");
await rejects("a TAMPERED obligation fails its signature and denies",
  () => gate(answering({ v: 1, decision: "allow", obligations: [{ ...signArtifact(obligationBody(), guardKp), attenuations: [{ maxItems: 999 }] }] })), "permission-denied");
await rejects("an obligation with NO attenuations is garbled (an obligation that attenuates nothing)",
  () => gate(answering({ v: 1, decision: "allow", obligations: [signArtifact(obligationBody({ attenuations: [] }), guardKp)] })), "permission-denied");
await rejects("a STUCK anchor registry AFTER the guard answered is a bounded DENY (obligation verification is inside the gate budget)",
  () => gate(answering({ v: 1, decision: "allow", obligations: [signArtifact(obligationBody(), guardKp)] }),
    { resolveAnchor: () => new Promise(() => { /* never settles */ }), deadlineMs: 150 }), "permission-denied");
await rejects("the guard call and obligation verification share ONE gate budget (each alone fits; their sum must not)",
  () => gate(() => new Promise((res) => setTimeout(() => res({ answer: { v: 1, decision: "allow", obligations: [signArtifact(obligationBody(), guardKp)] }, responder: guardResponder }), 100)),
    { resolveAnchor: (k: string) => new Promise((res) => setTimeout(() => res(anchors.get(k)), 100)), deadlineMs: 150 }), "permission-denied");
{
  // TOCTOU: a caller mutating the obligation DURING the awaited anchor resolution cannot split
  // what was parsed/scoped from what the signature verifies — the answer is snapshotted at entry.
  const ob = signArtifact(obligationBody(), guardKp) as Record<string, unknown>;
  const answer = { v: 1, decision: "allow", obligations: [ob] };
  const res = await gate(() => Promise.resolve({ answer, responder: guardResponder }), {
    resolveAnchor: (k: string) => new Promise<SignerAnchor | undefined>((r) => { ob.attenuations = [{ maxItems: 999 }]; setTimeout(() => r(anchors.get(k)), 20); }),
  });
  c("a mid-verification obligation mutation does NOT change the verified verdict (the guard answer is snapshotted at entry)",
    res.decision === "allow" && res.obligations.length === 1 && (res.obligations[0].attenuations[0] as { maxItems: number }).maxItems === 5);
}

// ── the hold wiring over the checkpoint pause primitive (real broker) ──
const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epguard-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);
  const kv = await openRecordsBucket(nc, SPACE);
  const ctx: ActionContext = await actionContext(nc, SPACE);
  const INSTANCE = "i".repeat(26);
  const spec = (fingerprint: string) => ({ fingerprint, command: "deploy", caller: { id: "u_abc.worker", lifecycleUid: UID }, requestId: "req-guard", sourceSeq: 1, acceptedAt: NOW });

  // hold → checkpoint owned by the guard responder + goal waiting
  const g1 = goalOf("g-hold");
  await createGoal(ctx, g1, spec("sha256:h1"));
  await transitionGoal(ctx, g1, "running", { owner: ownerCommitProof(ctx) });
  const held = await holdGuardedGoal(ctx, { goal: g1, hold: { token: "cp-g1", holdDeadlineMs: 60_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW });
  c("a HOLD converts the action to waiting carrying the checkpoint coordinate",
    held.state === "waiting" && held.checkpoint?.token === "cp-g1" && held.checkpoint?.deadlineGeneration === 1);
  const cpStatus = await readCheckpointStatus(kv, { endpoint: "manager", token: "cp-g1" });
  c("…and the minted checkpoint is waiting with the hold's deadline", cpStatus?.value.state === "waiting" && cpStatus?.value.deadline === NOW + 60_000);
  await rejects("a release by a presenter that is NOT the guard responder refuses (the checkpoint is owned by the guard decision)",
    () => releaseGuardHold(ctx, { goal: g1, token: "cp-g1", presenter: { id: "u_evil", lifecycleUid: "e".repeat(26) }, now: NOW + 100 }), "permission-denied");
  const released = await releaseGuardHold(ctx, { goal: g1, token: "cp-g1", presenter: guardResponder, now: NOW + 200 });
  c("the guard responder's release resumes the one-use checkpoint and the goal returns to running",
    released.settle.settle === "resumed" && released.status.state === "running");
  {
    // A duplicate release by the SAME presenter is a retry (indistinguishable from crash
    // recovery) and CONVERGES idempotently: the ONE recorded resumed settlement is observed,
    // never re-consumed or re-decided — one-use lives in the settlement fact, and any OTHER
    // presenter still refuses (the foreign-presenter probes below).
    const dup = await releaseGuardHold(ctx, { goal: g1, token: "cp-g1", presenter: guardResponder, now: NOW + 300 });
    c("a DUPLICATE release by the SAME presenter converges idempotently on the one recorded settlement",
      dup.settle.settle === "resumed" && dup.status.state === "running");
  }

  // expiry: an expired hold is DENY → the goal fails closed
  const g2 = goalOf("g-expire");
  await createGoal(ctx, g2, spec("sha256:h2"));
  await transitionGoal(ctx, g2, "running", { owner: ownerCommitProof(ctx) });
  await holdGuardedGoal(ctx, { goal: g2, hold: { token: "cp-g2", holdDeadlineMs: 1_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW });
  await rejects("a release AFTER the hold deadline refuses (the resume seam drives EXPIRED; an expired hold never releases)",
    () => releaseGuardHold(ctx, { goal: g2, token: "cp-g2", presenter: guardResponder, now: NOW + 1_000 }), "failed-precondition");
  const expired = await expireGuardHold(ctx, { goal: g2, token: "cp-g2", now: NOW + 1_100 });
  c("an expired hold commits the goal terminal FAILED (timeout is deny, fail closed)",
    expired.won && expired.fact.state === "failed" && (expired.fact.data as { code: string }).code === "permission-denied");
  c("…and the goal's projection follows", (await readGoalStatus(ctx, g2))?.value.state === "failed");
  c("…and the CHECKPOINT itself is settled expired (owner-expired, no orphaned timer left waiting)",
    (await readCheckpointStatus(kv, { endpoint: "manager", token: "cp-g2" }))?.value.state === "expired");

  // a valid token for goal A must NEVER release/expire an unrelated goal B on the same endpoint:
  // the hold's checkpoint records ONE goal and both seams bind to it before touching state.
  const gA = goalOf("g-bindA"); const gB = goalOf("g-bindB");
  await createGoal(ctx, gA, spec("sha256:ba")); await transitionGoal(ctx, gA, "running", { owner: ownerCommitProof(ctx) });
  await holdGuardedGoal(ctx, { goal: gA, hold: { token: "cp-bindA", holdDeadlineMs: 60_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW });
  await createGoal(ctx, gB, spec("sha256:bb")); await transitionGoal(ctx, gB, "running", { owner: ownerCommitProof(ctx) });
  await holdGuardedGoal(ctx, { goal: gB, hold: { token: "cp-bindB", holdDeadlineMs: 60_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW });
  await rejects("a release presenting goal B with goal A's checkpoint token refuses (the token is goal-bound)",
    () => releaseGuardHold(ctx, { goal: gB, token: "cp-bindA", presenter: guardResponder, now: NOW + 100 }), "permission-denied");
  await rejects("an expiry presenting goal B with goal A's token refuses (an arbitrary token never terminal-fails an unrelated goal)",
    () => expireGuardHold(ctx, { goal: gB, token: "cp-bindA", now: NOW + 100 }), "permission-denied");
  c("goal B is UNTOUCHED by the cross-goal attempts (still waiting on its own hold)",
    (await readGoalStatus(ctx, gB))?.value.state === "waiting");
  const relB = await releaseGuardHold(ctx, { goal: gB, token: "cp-bindB", presenter: guardResponder, now: NOW + 200 });
  c("goal B's OWN token still releases it (the binding blocks only the cross-goal case)", relB.status.state === "running");
  await rejects("an expiry with an UNKNOWN token refuses (no minted checkpoint pauses the goal)",
    () => expireGuardHold(ctx, { goal: gA, token: "cp-nonexistent", now: NOW + 100 }), "failed-precondition");

  // ── re-verify 5aab089 (distsys): H1 stale-release token match, H4 resumed-expiry crash converge ──
  {
    // HIGH 1: a stale/replayed release of an OLD (already-resumed) hold must NOT move a goal that
    // is now waiting on a DIFFERENT, live hold. Hold on cp-h1a, release (goal running), hold AGAIN
    // on cp-h1b (goal waiting on cp-h1b); a replayed release(cp-h1a) must refuse and leave it alone.
    const gH = goalOf("g-h1");
    await createGoal(ctx, gH, spec("sha256:gh1"));
    await transitionGoal(ctx, gH, "running", { owner: ownerCommitProof(ctx) });
    await holdGuardedGoal(ctx, { goal: gH, hold: { token: "cp-h1a", holdDeadlineMs: 60_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW });
    await releaseGuardHold(ctx, { goal: gH, token: "cp-h1a", presenter: guardResponder, now: NOW + 100 });
    await holdGuardedGoal(ctx, { goal: gH, hold: { token: "cp-h1b", holdDeadlineMs: 60_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW + 200 });
    await rejects("a replayed release of the OLD (resumed) hold refuses when the goal now waits on a NEWER hold",
      () => releaseGuardHold(ctx, { goal: gH, token: "cp-h1a", presenter: guardResponder, now: NOW + 300 }), "failed-precondition");
    c("…and the goal is UNTOUCHED (still waiting on the newer hold, never wrongly moved to running)",
      (await readGoalStatus(ctx, gH))?.value.state === "waiting" && (await readGoalStatus(ctx, gH))?.value.checkpoint?.token === "cp-h1b");

    // HIGH 4: a release that RESUMED the checkpoint but crashed before projecting the goal must be
    // FINISHED by a later expiry, never left waiting forever. Simulate the crash by resuming the
    // checkpoint directly (no goal projection); the expiry then converges goal → running and refuses.
    const gC = goalOf("g-h4");
    await createGoal(ctx, gC, spec("sha256:gh4"));
    await transitionGoal(ctx, gC, "running", { owner: ownerCommitProof(ctx) });
    await holdGuardedGoal(ctx, { goal: gC, hold: { token: "cp-h4", holdDeadlineMs: 60_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW });
    await resumeCheckpoint(kv, js, jsm, SPACE, { ref: { endpoint: "manager", token: "cp-h4" }, presenter: guardResponder, now: NOW + 100 });
    c("precondition: the checkpoint is resumed but the goal still hangs waiting (the release crash window)",
      (await readGoalStatus(ctx, gC))?.value.state === "waiting");
    await rejects("an expiry over a RESUMED-but-unprojected hold refuses (a resumed hold never denies)",
      () => expireGuardHold(ctx, { goal: gC, token: "cp-h4", now: NOW + 200 }), "failed-precondition");
    c("…but it FINISHED the crashed projection: the goal is converged to running, no longer hung",
      (await readGoalStatus(ctx, gC))?.value.state === "running");
  }

  // expiry racing a completion: a stale hold-expiry after the goal already terminalized observes
  // the WINNING terminal (goal-bound token, checkpoint already settled by the release, idempotent).
  const g3 = goalOf("g-race");
  await createGoal(ctx, g3, spec("sha256:h3"));
  await transitionGoal(ctx, g3, "running", { owner: ownerCommitProof(ctx) });
  await holdGuardedGoal(ctx, { goal: g3, hold: { token: "cp-g3", holdDeadlineMs: 1_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW });
  await releaseGuardHold(ctx, { goal: g3, token: "cp-g3", presenter: guardResponder, now: NOW + 10 });
  await commitGoalResult(ctx, { ref: g3, now: NOW + 20, cause: "complete", state: "succeeded" });
  const raced = await expireGuardHold(ctx, { goal: g3, token: "cp-g3", now: NOW + 1_100 });
  c("a stale hold-expiry after the goal already completed observes the WINNING terminal (first terminal fact wins uniformly)",
    !raced.won && raced.fact.state === "succeeded" && (await readGoalStatus(ctx, g3))?.value.state === "succeeded");

  // a TARGET-PINNED goal's hold expiry: the deny cause is owner-authored, so no executor is
  // required at the terminal commit and the target pin cannot strand an expired hold.
  const g4 = goalOf("g-target");
  await createGoal(ctx, g4, { ...spec("sha256:h4"), target: { owner: "u_t", actor: "svc", lifecycleUid: "t".repeat(26), mappingRevision: 1 } });
  await transitionGoal(ctx, g4, "running", { owner: ownerCommitProof(ctx) });
  await holdGuardedGoal(ctx, { goal: g4, hold: { token: "cp-g4", holdDeadlineMs: 1_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW });
  const expiredT = await expireGuardHold(ctx, { goal: g4, token: "cp-g4", now: NOW + 1_100 });
  c("a TARGET-PINNED guard-held goal expires cleanly (deny is owner-authored: no executor at the terminal commit)",
    expiredT.won && expiredT.fact.state === "failed" && (await readGoalStatus(ctx, g4))?.value.state === "failed");

  // ── crash convergence: the checkpoint settlement is the arbiter, the goal transition its
  //    derived projection — a release that crashed between the two is finished by the retry. ──
  const g5 = goalOf("g-crash");
  await createGoal(ctx, g5, spec("sha256:h5"));
  await transitionGoal(ctx, g5, "running", { owner: ownerCommitProof(ctx) });
  await holdGuardedGoal(ctx, { goal: g5, hold: { token: "cp-g5", holdDeadlineMs: 60_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW });
  // manufacture the crash window: the one-use resume is consumed, the goal transition never ran
  await resumeCheckpoint(kv, js, jsm, SPACE, { ref: { endpoint: "manager", token: "cp-g5" }, presenter: guardResponder, now: NOW + 10 });
  c("crash manufacture: checkpoint resumed, goal still waiting", (await readGoalStatus(ctx, g5))?.value.state === "waiting");
  const conv = await releaseGuardHold(ctx, { goal: g5, token: "cp-g5", presenter: guardResponder, now: NOW + 20 });
  c("a crashed release RETRY CONVERGES: it observes its own recorded resume and finishes the goal to running",
    conv.settle.settle === "resumed" && conv.status.state === "running");
  const conv2 = await releaseGuardHold(ctx, { goal: g5, token: "cp-g5", presenter: guardResponder, now: NOW + 30 });
  c("…and the converged release is IDEMPOTENT (an already-running goal observes, never errors)", conv2.status.state === "running");
  await rejects("a FOREIGN presenter can never adopt the recorded resume (holder-bound refusal, not convergence)",
    () => releaseGuardHold(ctx, { goal: g5, token: "cp-g5", presenter: { id: "u_evil", lifecycleUid: "e".repeat(26) }, now: NOW + 40 }), "permission-denied");
  await rejects("an expiry of a RELEASED hold refuses (a resumed hold never denies) instead of failing the goal",
    () => expireGuardHold(ctx, { goal: g5, token: "cp-g5", now: NOW + 80_000 }), "failed-precondition");
  c("…and the released goal stays running", (await readGoalStatus(ctx, g5))?.value.state === "running");

  // ── the commit boundary itself refuses a deny whose hold is still LIVE ──
  const g6 = goalOf("g-live");
  await createGoal(ctx, g6, spec("sha256:h6"));
  await transitionGoal(ctx, g6, "running", { owner: ownerCommitProof(ctx) });
  await holdGuardedGoal(ctx, { goal: g6, hold: { token: "cp-g6", holdDeadlineMs: 60_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW });
  await rejects("a deny naming a LIVE hold refuses at the commit boundary (no recorded expired settlement — a live hold never denies)",
    () => commitGoalResult(ctx, { ref: g6, now: NOW + 10, cause: "deny", denial: { kind: "hold-expired", token: "cp-g6" } }), "failed-precondition");

  // ── OPTION A: the ACTION composite's own gate (gateGoalExecution) — hold ROUTED, deny
  //    terminalized, allow admits with VERIFIED obligations. H5+H6: every guard path is
  //    reachable end-to-end through PRODUCTION exports, exercised here on a real broker. ──
  {
    const ga = goalOf("g-gate-allow");
    await createGoal(ctx, ga, spec("sha256:ga"));
    const allowSeam: GuardCallSeam = (q) => Promise.resolve({
      answer: { v: 1, decision: "allow", obligations: [signArtifact(obligationBody({ requestId: q.requestId }), guardKp)] },
      responder: guardResponder,
    });
    const ra = await gateGoalExecution(ctx, { goal: ga, guardEndpoint: "approvals", callGuard: allowSeam, resolveAnchor, deadlineMs: 5_000, now: NOW, instanceId: INSTANCE, epoch: 1 });
    c("gateGoalExecution ALLOW admits the goal to running with VERIFIED goal-bound obligations for the executor",
      ra.outcome === "running" && ra.status.state === "running"
      && (ra.obligations[0].attenuations[0] as { maxItems: number }).maxItems === 5
      && ra.obligations[0].requestId === "g-gate-allow");

    const gh = goalOf("g-gate-hold");
    await createGoal(ctx, gh, spec("sha256:gh"));
    const rh = await gateGoalExecution(ctx, { goal: gh, guardEndpoint: "approvals", callGuard: answering({ v: 1, decision: "hold", token: "cp-gate-h", holdDeadlineMs: 60_000 }), resolveAnchor, deadlineMs: 5_000, now: NOW, instanceId: INSTANCE, epoch: 1 });
    const heldStatus = await readGoalStatus(ctx, gh);
    const heldSpec = await readCheckpointSpec(ctx.kv, { endpoint: "manager", token: "cp-gate-h" });
    c("gateGoalExecution HOLD routes into the checkpoint pause: goal waiting on the minted checkpoint whose HOLDER is the guard's authenticated responder (H5: production-reachable)",
      rh.outcome === "waiting" && heldStatus?.value.state === "waiting" && heldStatus.value.checkpoint?.token === "cp-gate-h"
      && heldSpec?.holder.id === guardResponder.id && heldSpec.holder.lifecycleUid === guardResponder.lifecycleUid);

    // HIGH 1 (distsys, fact-confirmed): a HOLD's VERIFIED obligations must SURVIVE the pause
    // (SPEC :1628-1630 MUST-apply, :2311 reusable within the goal) - persisted on the hold's
    // immutable record at mint, returned identically from release and reconcile.
    const go = goalOf("g-gate-obl");
    await createGoal(ctx, go, spec("sha256:go"));
    const holdOblSeam: GuardCallSeam = (q) => Promise.resolve({
      answer: { v: 1, decision: "hold", token: "cp-gate-obl", holdDeadlineMs: 60_000, obligations: [signArtifact(obligationBody({ requestId: q.requestId }), guardKp)] },
      responder: guardResponder,
    });
    const rho = await gateGoalExecution(ctx, { goal: go, guardEndpoint: "approvals", callGuard: holdOblSeam, resolveAnchor, deadlineMs: 5_000, now: NOW, instanceId: INSTANCE, epoch: 1 });
    const oblSpec = await readCheckpointSpec(ctx.kv, { endpoint: "manager", token: "cp-gate-obl" });
    c("a HOLD's VERIFIED obligations are PERSISTED on the hold's immutable record and surfaced on the waiting outcome",
      rho.outcome === "waiting" && (rho as { obligations: { requestId: string }[] }).obligations[0]?.requestId === "g-gate-obl"
      && oblSpec?.obligations?.length === 1 && oblSpec.obligations[0].requestId === "g-gate-obl");
    const relObl = await releaseGuardHold(ctx, { goal: go, token: "cp-gate-obl", presenter: guardResponder, now: NOW + 50 });
    c("release returns EXACTLY the recorded set, signature-intact (the executor resumes with the guard's attenuations, never zero)",
      relObl.status.state === "running" && relObl.obligations.length === 1
      && relObl.obligations[0].sig === (rho as { obligations: { sig: string }[] }).obligations[0].sig
      && relObl.obligations[0].requestId === "g-gate-obl");

    const gd = goalOf("g-gate-deny");
    await createGoal(ctx, gd, spec("sha256:gd"));
    const rd = await gateGoalExecution(ctx, { goal: gd, guardEndpoint: "approvals", callGuard: answering({ v: 1, decision: "deny", reason: "policy said no" }), resolveAnchor, deadlineMs: 5_000, now: NOW, instanceId: INSTANCE, epoch: 1 });
    c("gateGoalExecution DENY terminal-fails the goal at the shared commit point, carrying the gate's reason",
      rd.outcome === "denied" && rd.won === true && rd.fact.state === "failed" && rd.status.state === "failed"
      && String((rd.fact.data as { reason?: string })?.reason ?? "").includes("policy said no"));

    const gf = goalOf("g-gate-forged");
    await createGoal(ctx, gf, spec("sha256:gf"));
    const rf = await gateGoalExecution(ctx, { goal: gf, guardEndpoint: "approvals", callGuard: answering({ v: 1, decision: "allow", obligations: [{ ...obligationBody({ requestId: "g-gate-forged" }), sig: "Zm9yZ2Vk" }] }), resolveAnchor, deadlineMs: 5_000, now: NOW, instanceId: INSTANCE, epoch: 1 });
    c("gateGoalExecution with an UNVERIFIABLE obligation is fail-closed: the goal terminal-fails, the executor never starts",
      rf.outcome === "denied" && rf.fact.state === "failed");

    // Security H3: a hostile answer GETTER that mutates the responder mid-serialize must not
    // move the recorded presenter (the responder identity is single-read + frozen BEFORE the
    // answer is ever evaluated).
    const gm = goalOf("g-gate-mutate");
    await createGoal(ctx, gm, spec("sha256:gm"));
    const mutSeam: GuardCallSeam = () => {
      const responder = { id: guardResponder.id, lifecycleUid: guardResponder.lifecycleUid };
      // A Proxy answer whose get trap (code, run during canonicalJson serialization) mutates the
      // responder mid-flight - the exact H3 vector, distinct from a getter (the strict path refuses those).
      const target = { v: 1, decision: "hold", token: "cp-gate-mut", holdDeadlineMs: 60_000 };
      const answer = new Proxy(target, { get(t, k, r) { responder.id = "u_evil.warden"; return Reflect.get(t, k, r); } });
      return Promise.resolve({ responder, answer } as never);
    };
    const rm = await gateGoalExecution(ctx, { goal: gm, guardEndpoint: "approvals", callGuard: mutSeam, resolveAnchor, deadlineMs: 5_000, now: NOW, instanceId: INSTANCE, epoch: 1 });
    const mutSpec = await readCheckpointSpec(ctx.kv, { endpoint: "manager", token: "cp-gate-mut" });
    c("a hostile Proxy answer whose get-trap mutates the responder MID-SERIALIZE cannot move the recorded holder (responder single-read before the answer is touched)",
      rm.outcome === "waiting" && mutSpec?.holder.id === guardResponder.id && mutSpec.holder.id !== "u_evil.warden");
  }

  // ── OPTION A: the durable hold reconciler — release/expiry convergence reachable from a
  //    durable scan, not only from a live guard call. ──
  {
    const gr = goalOf("g-rec-resumed");
    await createGoal(ctx, gr, spec("sha256:gr"));
    await holdGuardedGoal(ctx, { goal: gr, hold: { token: "cp-rec-r", holdDeadlineMs: 60_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW });
    await resumeCheckpoint(ctx.kv, ctx.js, ctx.jsm, SPACE, { ref: { endpoint: "manager", token: "cp-rec-r" }, presenter: guardResponder, now: NOW + 10 }); // the release's resume landed; the goal projection "crashed"
    const rr = await reconcileGuardHold(ctx, { goal: gr, now: NOW + 20 });
    c("reconcileGuardHold converges a RESUMED hold's crashed projection to running",
      rr.converged === "running" && (await readGoalStatus(ctx, gr))?.value.state === "running");

    const gro = goalOf("g-rec-obl");
    await createGoal(ctx, gro, spec("sha256:gro"));
    const recObl = signArtifact(obligationBody({ requestId: "g-rec-obl" }), guardKp) as unknown as Parameters<typeof holdGuardedGoal>[1]["hold"]["obligations"];
    await holdGuardedGoal(ctx, { goal: gro, hold: { token: "cp-rec-obl", holdDeadlineMs: 60_000, responder: guardResponder, obligations: [recObl].flat() as never }, instanceId: INSTANCE, epoch: 1, now: NOW });
    await resumeCheckpoint(ctx.kv, ctx.js, ctx.jsm, SPACE, { ref: { endpoint: "manager", token: "cp-rec-obl" }, presenter: guardResponder, now: NOW + 10 });
    const rro = await reconcileGuardHold(ctx, { goal: gro, now: NOW + 20 });
    c("the reconciler's crashed-release convergence carries the hold's RECORDED obligations (a crash never launders the attenuations away)",
      rro.converged === "running" && rro.obligations?.length === 1 && (rro.obligations[0] as { requestId: string }).requestId === "g-rec-obl");

    const ge = goalOf("g-rec-expired");
    await createGoal(ctx, ge, spec("sha256:ge"));
    await holdGuardedGoal(ctx, { goal: ge, hold: { token: "cp-rec-e", holdDeadlineMs: 1_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW });
    await expireCheckpoint(ctx.kv, ctx.js, ctx.jsm, SPACE, { ref: { endpoint: "manager", token: "cp-rec-e" }, now: NOW + 2_000 }); // the fire settled the checkpoint; the goal projection is owed
    const re = await reconcileGuardHold(ctx, { goal: ge, now: NOW + 2_010 });
    c("reconcileGuardHold converges an EXPIRED hold to the terminal deny",
      re.converged === "denied" && (await readGoalStatus(ctx, ge))?.value.state === "failed");

    const gl = goalOf("g-rec-live");
    await createGoal(ctx, gl, spec("sha256:gl"));
    await holdGuardedGoal(ctx, { goal: gl, hold: { token: "cp-rec-l", holdDeadlineMs: 60_000, responder: guardResponder }, instanceId: INSTANCE, epoch: 1, now: NOW });
    c("reconcileGuardHold leaves a LIVE hold untouched (the timer plane owns the deadline)",
      (await reconcileGuardHold(ctx, { goal: gl, now: NOW + 10 })).converged === "none"
      && (await readGoalStatus(ctx, gl))?.value.state === "waiting");
    c("reconcileGuardHold leaves a non-waiting goal untouched",
      (await reconcileGuardHold(ctx, { goal: gr, now: NOW + 30 })).converged === "none");
  }

  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT GUARD SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
