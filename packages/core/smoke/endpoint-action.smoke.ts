/**
 * v0.4 §13.6 ACTION composite smoke — the goal machinery against a real broker: the
 * pre-acceptance goal-bind CAS (first-wins; same-fingerprint retry vs conflict; ORPHANED-bind
 * adoption), idempotent goal creation (spec+status replay/crash repair), the goal record
 * projection through the single status vocabulary (legal/illegal transitions, closed
 * state-dependent fields, terminal ONLY via fact projection), the ONE terminal commit point
 * (bound to the PERSISTED spec; executor lifecycle/epoch currency for target-pinned goals;
 * completion, cancel, and the readiness `uncertain` settle race there; first terminal fact
 * wins; the loser observes the winner and the status converges), the reserved-cancel semantics
 * (structurally caller-bound; unknown/terminal = failed-precondition with the cached outcome
 * riding error.details onto the wire; repeat cancel idempotent), digest-verified result facts,
 * and the tombstone serving form.
 *
 * Run: pnpm smoke:ep-action   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError, contractDigest,
  createEndpointStreams, openRecordsBucket, epeSubject,
  bindGoal, classifyGoalReuse, resolveGoalSubmission, createGoal, readGoalSpec, readGoalStatus,
  transitionGoal, isLegalGoalTransition, projectGoalTerminal,
  commitGoalResult, readGoalResult, requestGoalCancel, settleGoalUncertain, goalTombstone,
  goalResultSubject, goalProgressTopic, goalRefOf,
  GOAL_TERMINAL_STATES, GOAL_TERMINAL_DETAIL_KIND,
  type EpCaller, type GoalRef, type ParsedEpRequest, type GoalResultFact,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); return undefined; } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
    return e;
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "epact";
const UID = "u".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };
const ref = (goalId: string): GoalRef => ({ endpoint: "manager", caller, goalId });
// The bind/cancel subjects derive from the broker-authenticated request (structural
// provenance); the smoke models the parsed submission with exactly the fields read.
const req = { plane: "request", route: "one", endpoint: "manager", command: "deploy", caller } as unknown as ParsedEpRequest;
const TARGET = { owner: "u_wrk", actor: "svc", lifecycleUid: "e".repeat(26), mappingRevision: 4 };
const specOf = (fingerprint: string, over: Record<string, unknown> = {}) => ({
  fingerprint, command: "deploy", caller: { id: "u_abc.worker", lifecycleUid: UID },
  sourceSeq: 7, acceptedAt: 1_000_000, ...over,
});
const NOW = 1_000_000;
const enc = (s: string) => new TextEncoder().encode(s);

// ── broker-free: the state machine table ──
c("the §13.6 machine: accepted → running ⇄ waiting; cancelling from any non-terminal; only a terminal leaves cancelling",
  isLegalGoalTransition("accepted", "running") && isLegalGoalTransition("running", "waiting")
  && isLegalGoalTransition("waiting", "running") && isLegalGoalTransition("running", "cancelling")
  && isLegalGoalTransition("cancelling", "cancelled") && !isLegalGoalTransition("cancelling", "running")
  && !isLegalGoalTransition("accepted", "accepted") && !isLegalGoalTransition("waiting", "accepted"));
c("terminal states are immutable in the machine",
  GOAL_TERMINAL_STATES.every((t) => !isLegalGoalTransition(t, "running") && !isLegalGoalTransition(t, "cancelled")));
c("the per-goal progress topic carries the caller identity for mint-time read containment",
  epeSubject(SPACE, "manager", "i".repeat(26), 1, goalProgressTopic(ref("g1")))
    .endsWith(`.goal.u_abc.worker.${UID}.g1.progress`));

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epact-"));
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

  // ── the goal bind: first-wins per goalId, BEFORE acceptance ──
  const b1 = await bindGoal(js, jsm, SPACE, req, "g1", "sha256:aa");
  c("the first bind of a goalId wins", b1.bound === true);
  const b1retry = await bindGoal(js, jsm, SPACE, req, "g1", "sha256:aa");
  c("a same-fingerprint rebind loses the CAS and reads the recorded bind (the caller's retry)",
    b1retry.bound === false && !b1retry.bound && classifyGoalReuse(b1retry.existing, "sha256:aa") === "cached");
  const b1forge = await bindGoal(js, jsm, SPACE, req, "g1", "sha256:bb");
  c("a DIFFERENT-fingerprint bind for the same goalId classifies conflict BEFORE acceptance and effect",
    b1forge.bound === false && !b1forge.bound && classifyGoalReuse(b1forge.existing, "sha256:bb") === "conflict");

  // ── HIGH: the orphaned-bind crash window has a recovery path ──
  {
    // the bind winner crashed BEFORE acceptance: bind exists, no goal record.
    await bindGoal(js, jsm, SPACE, req, "g-orphan", "sha256:oo");
    const adopted = await resolveGoalSubmission(kv, js, jsm, SPACE, req, "g-orphan", "sha256:oo");
    c("a same-fingerprint resubmission ADOPTS an orphaned bind and proceeds to acceptance (crash recovery)", adopted.kind === "adopted");
    const forged = await resolveGoalSubmission(kv, js, jsm, SPACE, req, "g-orphan", "sha256:xx");
    c("a different-fingerprint resubmission against the orphaned bind stays conflict", forged.kind === "conflict");
    await createGoal(kv, ref("g-orphan"), specOf("sha256:oo"));
    const cachedNow = await resolveGoalSubmission(kv, js, jsm, SPACE, req, "g-orphan", "sha256:oo");
    c("once the adopted submission accepts, the SAME resubmission classifies cached", cachedNow.kind === "cached");
    const fresh = await resolveGoalSubmission(kv, js, jsm, SPACE, req, "g-new", "sha256:nn");
    c("a virgin goalId is NEW work (its bind CAS wins)", fresh.kind === "new");
  }

  // ── the goal record: idempotent creation (spec + status, replay/crash-repairable) ──
  await createGoal(kv, ref("g1"), specOf("sha256:aa"));
  const s0 = await readGoalStatus(kv, ref("g1"));
  c("acceptance creates the spec + the `accepted` status projection", s0?.value.state === "accepted");
  const replay = await createGoal(kv, ref("g1"), specOf("sha256:aa"));
  c("an IDENTICAL goal re-creation is idempotent (an adopted retry / replayed acceptance repairs, never conflicts)",
    replay.specRevision === (await readGoalSpec(kv, ref("g1")))?.revision);
  await rejects("a DIFFERENT definition under the same goalId is a loud conflict",
    () => createGoal(kv, ref("g1"), specOf("sha256:zz")), "conflict");
  {
    // the spec→status crash window: spec landed, status never did; an identical retry repairs.
    const rc = ref("g-crash");
    await kv.put(`goal.manager.u_abc.worker.${UID}.g-crash.spec`, enc(JSON.stringify({ v: 1, goalId: "g-crash", ...specOf("sha256:cr") })));
    c("(manufactured) the crashed creation left no status", (await readGoalStatus(kv, rc)) === undefined);
    await createGoal(kv, rc, specOf("sha256:cr"));
    c("an identical retry repairs the missing status (no stranded spec-only goal)", (await readGoalStatus(kv, rc))?.value.state === "accepted");
  }
  c("an unknown goal reads undefined", (await readGoalStatus(kv, ref("g-none"))) === undefined);
  await transitionGoal(kv, ref("g1"), "running");
  const sWait = await transitionGoal(kv, ref("g1"), "waiting", { checkpoint: { token: "cp-1", deadlineGeneration: 3 } });
  c("waiting carries the checkpoint coordinate (token + deadline generation)",
    sWait.state === "waiting" && sWait.checkpoint?.token === "cp-1" && sWait.checkpoint?.deadlineGeneration === 3);
  const sRun = await transitionGoal(kv, ref("g1"), "running");
  c("leaving waiting DROPS the checkpoint coordinate (closed state-dependent schema)", sRun.checkpoint === undefined);
  await rejects("an illegal transition refuses (running → accepted)",
    () => transitionGoal(kv, ref("g1"), "accepted"), "failed-precondition");
  await rejects("a transition on an unknown goal refuses",
    () => transitionGoal(kv, ref("g-none"), "running"), "failed-precondition");
  // HIGH: the status NEVER leads the journal — naked terminal transitions are refused outright.
  await rejects("a NAKED terminal transition refuses (a terminal status exists only as the fact's projection)",
    () => transitionGoal(kv, ref("g1"), "succeeded"), "failed-precondition");
  await rejects("projecting a terminal without a committed fact refuses",
    () => projectGoalTerminal(kv, jsm, SPACE, ref("g1")), "failed-precondition");

  // ── cancel vs completion: ONE commit point, first terminal fact wins ──
  const cancelStatus = await requestGoalCancel(kv, jsm, SPACE, { request: req, goalId: "g1", mode: "graceful" });
  c("cancel transitions a live goal to `cancelling` recording the mode", cancelStatus.state === "cancelling" && cancelStatus.cancelMode === "graceful");
  const cancelAgain = await requestGoalCancel(kv, jsm, SPACE, { request: req, goalId: "g1", mode: "terminate" });
  c("a repeated cancel is idempotent (stays cancelling, the FIRST mode wins)", cancelAgain.state === "cancelling" && cancelAgain.cancelMode === "graceful");
  // HIGH: the cancel seam is STRUCTURALLY caller-bound — another caller's request cannot
  // address this goal (its derived ref names its OWN goals only).
  {
    const foreign = { plane: "request", route: "one", endpoint: "manager", command: "cancel", caller: { owner: "u_zzz", actor: "worker", uid: "z".repeat(26) } } as unknown as ParsedEpRequest;
    await rejects("a cancel derives its goal from the BROKER-AUTHENTICATED caller: another caller's request finds no such goal (confused deputy closed)",
      () => requestGoalCancel(kv, jsm, SPACE, { request: foreign, goalId: "g1", mode: "graceful" }), "failed-precondition");
  }
  // completion races the cancel at the commit point and WINS (first terminal fact). The commit
  // binds to the PERSISTED spec: no caller-supplied fingerprint, and the status auto-converges.
  const done = await commitGoalResult(kv, js, jsm, SPACE, { ref: ref("g1"), state: "succeeded", data: { url: "https://x" }, now: NOW + 500 });
  c("the completing commit wins the terminal CAS and stamps the PERSISTED fingerprint",
    done.won && done.fact.state === "succeeded" && done.fact.fingerprint === "sha256:aa" && done.fact.outcomeDigest.startsWith("sha256:"));
  c("…and the status projection follows the winning fact AT the commit (no naked transition needed)", done.status.state === "succeeded");
  const cancelCommit = await commitGoalResult(kv, js, jsm, SPACE, { ref: ref("g1"), state: "cancelled", now: NOW + 600 });
  c("the losing cancel commit observes the WINNING terminal instead of re-deciding (cancel races completion)",
    !cancelCommit.won && cancelCommit.fact.state === "succeeded" && cancelCommit.status.state === "succeeded");
  await rejects("a terminal projection is immutable",
    () => transitionGoal(kv, ref("g1"), "running"), "failed-precondition");
  const cancelTerminal = await rejects("cancel of a TERMINAL goal is failed-precondition with the cached outcome ATTACHED",
    () => requestGoalCancel(kv, jsm, SPACE, { request: req, goalId: "g1", mode: "graceful" }), "failed-precondition") as EpEnvelopeError;
  {
    // MEDIUM: the cached outcome rides error.details so it SURVIVES toEpError() onto the wire.
    const detail = cancelTerminal?.details?.find((d) => d.kind === GOAL_TERMINAL_DETAIL_KIND) as { fact?: GoalResultFact } | undefined;
    c("…and the attached outcome IS the winning terminal fact, riding error.details", detail?.fact?.state === "succeeded");
    const wire = cancelTerminal?.toEpError();
    c("…and toEpError() carries it across the wire boundary (never dropped)",
      wire?.details?.some((d) => d.kind === GOAL_TERMINAL_DETAIL_KIND && (d as { fact?: GoalResultFact }).fact?.state === "succeeded") === true);
  }
  await rejects("cancel of an UNKNOWN goal is failed-precondition",
    () => requestGoalCancel(kv, jsm, SPACE, { request: req, goalId: "g-none", mode: "graceful" }), "failed-precondition");

  // ── HIGH: the terminal commit is BOUND to the persisted accepted goal ──
  await rejects("a commit for a goal with NO accepted spec refuses (a terminal never commits for an unaccepted goal)",
    () => commitGoalResult(kv, js, jsm, SPACE, { ref: ref("g-none"), state: "succeeded", now: NOW }), "failed-precondition");
  {
    // executor lifecycle/epoch currency for a TARGET-PINNED goal (§13.6 item 7).
    const rt = ref("g-target");
    await bindGoal(js, jsm, SPACE, req, "g-target", "sha256:tt");
    await createGoal(kv, rt, specOf("sha256:tt", { target: TARGET }));
    await rejects("committing a target-pinned goal WITHOUT the executor identity refuses",
      () => commitGoalResult(kv, js, jsm, SPACE, { ref: rt, state: "succeeded", now: NOW }), "failed-precondition");
    await rejects("…without a fresh-epoch resolver refuses",
      () => commitGoalResult(kv, js, jsm, SPACE, { ref: rt, state: "succeeded", now: NOW, executor: { lifecycleUid: TARGET.lifecycleUid, epoch: 2 } }), "failed-precondition");
    await rejects("a SAME-NAME SUCCESSOR lifecycle cannot commit (the goal binds the accepted lifecycle)",
      () => commitGoalResult(kv, js, jsm, SPACE, { ref: rt, state: "succeeded", now: NOW, executor: { lifecycleUid: "f".repeat(26), epoch: 2 }, resolveCurrentEpoch: () => 2 }), "expired");
    await rejects("a SUPERSEDED epoch cannot commit transitions",
      () => commitGoalResult(kv, js, jsm, SPACE, { ref: rt, state: "succeeded", now: NOW, executor: { lifecycleUid: TARGET.lifecycleUid, epoch: 2 }, resolveCurrentEpoch: () => 3 }), "expired");
    await rejects("a RETIRED target lifecycle (resolver null) cannot commit",
      () => commitGoalResult(kv, js, jsm, SPACE, { ref: rt, state: "succeeded", now: NOW, executor: { lifecycleUid: TARGET.lifecycleUid, epoch: 2 }, resolveCurrentEpoch: () => null }), "expired");
    await rejects("a NON-INTEGER resolver answer never authorizes",
      () => commitGoalResult(kv, js, jsm, SPACE, { ref: rt, state: "succeeded", now: NOW, executor: { lifecycleUid: TARGET.lifecycleUid, epoch: 2 }, resolveCurrentEpoch: (() => "2") as unknown as () => number }), "internal");
    const okT = await commitGoalResult(kv, js, jsm, SPACE, { ref: rt, state: "succeeded", now: NOW, executor: { lifecycleUid: TARGET.lifecycleUid, epoch: 2 }, resolveCurrentEpoch: () => 2 });
    c("a CURRENT executor (matching lifecycle + fresh epoch) commits", okT.won && okT.status.state === "succeeded");
    await rejects("an executor supplied for an UNTARGETED goal refuses (wiring confusion, fail-loud)",
      () => commitGoalResult(kv, js, jsm, SPACE, { ref: ref("g-orphan"), state: "succeeded", now: NOW, executor: { lifecycleUid: UID, epoch: 1 }, resolveCurrentEpoch: () => 1 }), "failed-precondition");
  }

  // ── MEDIUM: the committed outcome is a detached strict-canonical snapshot ──
  {
    const rs = ref("g-snap");
    await bindGoal(js, jsm, SPACE, req, "g-snap", "sha256:ss");
    await createGoal(kv, rs, specOf("sha256:ss"));
    const out = { n: 1, tags: ["a"] };
    const snap = await commitGoalResult(kv, js, jsm, SPACE, { ref: rs, state: "succeeded", data: out, now: NOW + 10 });
    out.n = 999; out.tags.push("MUTATED");
    const readBack = await readGoalResult(jsm, SPACE, rs);
    c("the cached outcome is a DETACHED snapshot whose tombstone digest matches its payload",
      snap.won && (readBack?.data as { n: number; tags: string[] }).n === 1 && (readBack?.data as { n: number; tags: string[] }).tags.length === 1);
  }

  // ── HIGH: a crashed commit (fact landed, projection didn't) converges from the fact ──
  {
    const rr = ref("g-repair");
    await bindGoal(js, jsm, SPACE, req, "g-repair", "sha256:rr");
    await createGoal(kv, rr, specOf("sha256:rr"));
    await transitionGoal(kv, rr, "running");
    // manufacture the crash: the fact exists, the status still says running.
    const fact: GoalResultFact = { v: 1, goalId: "g-repair", fingerprint: "sha256:rr", state: "failed", outcomeDigest: contractDigest(null), ts: NOW + 20 };
    await js.publish(goalResultSubject(SPACE, rr), enc(JSON.stringify(fact)));
    c("(manufactured) the stale projection still says running", (await readGoalStatus(kv, rr))?.value.state === "running");
    const converged = await projectGoalTerminal(kv, jsm, SPACE, rr);
    c("projectGoalTerminal converges the stale projection to the winning fact (crashed-commit repair)", converged.state === "failed");
    c("…idempotently (a second projection returns unchanged)", (await projectGoalTerminal(kv, jsm, SPACE, rr)).state === "failed");
  }

  // ── the cached outcome + tombstone serving form ──
  const cached = await readGoalResult(jsm, SPACE, ref("g1"));
  c("the cached terminal fact carries the §13.6 tombstone summary (goalId, fingerprint, state, outcomeDigest)",
    cached?.goalId === "g1" && cached?.fingerprint === "sha256:aa" && cached?.state === "succeeded" && typeof cached?.outcomeDigest === "string");
  c("goalTombstone serves the payload-evicted retry form (summary + data.evicted, same outcome identity)",
    cached !== undefined && (goalTombstone(cached).data as { evicted: boolean }).evicted === true
    && goalTombstone(cached).outcomeDigest === cached.outcomeDigest && goalTombstone(cached).state === "succeeded");
  c("a not-terminal goal reads undefined", (await readGoalResult(jsm, SPACE, ref("g-none"))) === undefined);

  // ── MEDIUM: garbled/mis-subjected/digest-inconsistent facts never authorize ──
  {
    const rb = ref("g-bad");
    const badFact = { v: 1, goalId: "OTHER", fingerprint: "sha256:bb", state: "succeeded", outcomeDigest: contractDigest(null), ts: NOW };
    await js.publish(goalResultSubject(SPACE, rb), enc(JSON.stringify(badFact)));
    await rejects("a result fact naming a DIFFERENT goalId than its subject is rejected as garbled",
      () => readGoalResult(jsm, SPACE, rb), "internal");
    const rd = ref("g-baddigest");
    const digestFact = { v: 1, goalId: "g-baddigest", fingerprint: "sha256:dd", state: "succeeded", outcomeDigest: contractDigest({ forged: true }), data: { real: true }, ts: NOW };
    await js.publish(goalResultSubject(SPACE, rd), enc(JSON.stringify(digestFact)));
    await rejects("a result fact whose tombstone digest does not match its payload is rejected as garbled",
      () => readGoalResult(jsm, SPACE, rd), "internal");
    await kv.put(`goal.manager.u_abc.worker.${UID}.g-badstatus.status`, enc(JSON.stringify({ state: "running", checkpoint: { token: "cp", deadlineGeneration: 1 }, observedSpecRevision: 1 })));
    await rejects("a status carrying a checkpoint outside `waiting` is rejected as garbled (closed state-dependent schema)",
      () => readGoalStatus(kv, ref("g-badstatus")), "internal");
  }

  // ── bounded readiness: the PERSISTED acceptance-relative deadline settles `uncertain` ──
  await bindGoal(js, jsm, SPACE, req, "g2", "sha256:cc");
  await createGoal(kv, ref("g2"), specOf("sha256:cc", { readinessDeadlineMs: 30_000 }));
  await rejects("an uncertain settle BEFORE the persisted readiness deadline refuses (supplied coordinates never substitute)",
    () => settleGoalUncertain(kv, js, jsm, SPACE, { ref: ref("g2"), now: NOW + 29_999 }), "failed-precondition");
  await rejects("an uncertain settle on a goal that declared NO readiness bound refuses",
    () => settleGoalUncertain(kv, js, jsm, SPACE, { ref: ref("g1"), now: NOW + 999_999 }), "failed-precondition");
  const unc = await settleGoalUncertain(kv, js, jsm, SPACE, { ref: ref("g2"), now: NOW + 30_000 });
  c("past the deadline the goal settles terminally `uncertain` and the status converges",
    unc.won && unc.fact.state === "uncertain" && unc.status.state === "uncertain");
  const lateSuccess = await commitGoalResult(kv, js, jsm, SPACE, { ref: ref("g2"), state: "succeeded", now: NOW + 31_000 });
  c("a LATE success loses the terminal CAS and observes `uncertain` (the goal is never rewritten)",
    !lateSuccess.won && lateSuccess.fact.state === "uncertain");
  // and the reverse race: a success that lands FIRST beats the settle
  await bindGoal(js, jsm, SPACE, req, "g3", "sha256:dd");
  await createGoal(kv, ref("g3"), specOf("sha256:dd", { readinessDeadlineMs: 30_000 }));
  await commitGoalResult(kv, js, jsm, SPACE, { ref: ref("g3"), state: "succeeded", now: NOW + 29_000 });
  const settleLate = await settleGoalUncertain(kv, js, jsm, SPACE, { ref: ref("g3"), now: NOW + 30_001 });
  c("a success that committed FIRST wins; the due settle observes it instead", !settleLate.won && settleLate.fact.state === "succeeded");

  // ── fail-closed storage reads ──
  await kv.delete(`goal.manager.u_abc.worker.${UID}.g3.status`);
  await rejects("a DEL marker on the goal status refuses (a deletion never erases a projection)",
    () => readGoalStatus(kv, ref("g3")), "failed-precondition");
  await kv.delete(`goal.manager.u_abc.worker.${UID}.g3.spec`);
  await rejects("a DEL marker on the goal spec refuses (a deletion never erases an accepted goal)",
    () => readGoalSpec(kv, ref("g3")), "failed-precondition");

  c("terminal subjects are goal-scoped", goalResultSubject(SPACE, ref("g1")) !== goalResultSubject(SPACE, ref("g2")));
  c("goalRefOf derives the ref from the broker-authenticated request",
    goalRefOf(req, "g9").caller.owner === "u_abc" && goalRefOf(req, "g9").endpoint === "manager");

  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT ACTION SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
