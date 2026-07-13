/**
 * v0.4 §13.6 ACTION composite smoke — the goal machinery against a real broker: the
 * pre-acceptance goal-bind CAS (first-wins; same-fingerprint retry vs conflict), the goal
 * record projection through the single status vocabulary (legal/illegal transitions,
 * checkpoint fields, terminal immutability), the ONE terminal commit point (completion,
 * cancel, and the readiness `uncertain` settle race there; first terminal fact wins; the
 * loser observes the winner), the reserved-cancel semantics (unknown/terminal =
 * failed-precondition with the cached outcome attached; repeat cancel idempotent), and the
 * tombstone-summary reuse rules.
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
  isReachable, EpEnvelopeError,
  createEndpointStreams, openRecordsBucket, epeSubject,
  bindGoal, classifyGoalReuse, createGoal, readGoalStatus, transitionGoal, isLegalGoalTransition,
  commitGoalResult, readGoalResult, requestGoalCancel, settleGoalUncertain,
  goalResultSubject, goalProgressTopic,
  GOAL_TERMINAL_STATES,
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
// The bind subject derives from the broker-authenticated request (structural provenance);
// the smoke models the parsed submission with exactly the fields the derivation reads.
const req = { plane: "request", route: "one", endpoint: "manager", command: "deploy", caller } as unknown as ParsedEpRequest;
const specOf = (goalId: string, fingerprint: string, over: Record<string, unknown> = {}) => ({
  fingerprint, command: "deploy", caller: { id: "u_abc.worker", lifecycleUid: UID },
  sourceSeq: 7, acceptedAt: 1_000_000, ...over,
});
const NOW = 1_000_000;

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

  // ── the goal record: spec + status projection ──
  await createGoal(kv, ref("g1"), specOf("g1", "sha256:aa"));
  const s0 = await readGoalStatus(kv, ref("g1"));
  c("acceptance creates the spec + the `accepted` status projection", s0?.value.state === "accepted");
  await rejects("a duplicate goal creation is a loud conflict (the bind upstream makes this a replay signal)",
    () => createGoal(kv, ref("g1"), specOf("g1", "sha256:aa")), "conflict");
  c("an unknown goal reads undefined", (await readGoalStatus(kv, ref("g-none"))) === undefined);
  await transitionGoal(kv, ref("g1"), "running");
  const sWait = await transitionGoal(kv, ref("g1"), "waiting", { checkpoint: { token: "cp-1", deadlineGeneration: 3 } });
  c("waiting carries the checkpoint coordinate (token + deadline generation)",
    sWait.state === "waiting" && sWait.checkpoint?.token === "cp-1" && sWait.checkpoint?.deadlineGeneration === 3);
  await transitionGoal(kv, ref("g1"), "running");
  await rejects("an illegal transition refuses (running → accepted)",
    () => transitionGoal(kv, ref("g1"), "accepted"), "failed-precondition");
  await rejects("a transition on an unknown goal refuses",
    () => transitionGoal(kv, ref("g-none"), "running"), "failed-precondition");

  // ── cancel vs completion: ONE commit point, first terminal fact wins ──
  const cancelStatus = await requestGoalCancel(kv, jsm, SPACE, { ref: ref("g1"), mode: "graceful" });
  c("cancel transitions a live goal to `cancelling` recording the mode", cancelStatus.state === "cancelling" && cancelStatus.cancelMode === "graceful");
  const cancelAgain = await requestGoalCancel(kv, jsm, SPACE, { ref: ref("g1"), mode: "terminate" });
  c("a repeated cancel is idempotent (stays cancelling, mode unchanged)", cancelAgain.state === "cancelling" && cancelAgain.cancelMode === "graceful");
  // completion races the cancel at the commit point and WINS (first terminal fact):
  const done = await commitGoalResult(js, jsm, SPACE, { ref: ref("g1"), fingerprint: "sha256:aa", state: "succeeded", data: { url: "https://x" }, now: NOW + 500 });
  c("the completing commit wins the terminal CAS", done.won && done.fact.state === "succeeded" && done.fact.outcomeDigest.startsWith("sha256:"));
  const cancelCommit = await commitGoalResult(js, jsm, SPACE, { ref: ref("g1"), fingerprint: "sha256:aa", state: "cancelled", now: NOW + 600 });
  c("the losing cancel commit observes the WINNING terminal instead of re-deciding (cancel races completion)",
    !cancelCommit.won && cancelCommit.fact.state === "succeeded");
  await transitionGoal(kv, ref("g1"), "succeeded");
  c("the status projection follows the winning fact", (await readGoalStatus(kv, ref("g1")))?.value.state === "succeeded");
  await rejects("a terminal projection is immutable",
    () => transitionGoal(kv, ref("g1"), "running"), "failed-precondition");
  const cancelTerminal = await rejects("cancel of a TERMINAL goal is failed-precondition with the cached outcome ATTACHED",
    () => requestGoalCancel(kv, jsm, SPACE, { ref: ref("g1"), mode: "graceful" }), "failed-precondition");
  c("…and the attached outcome IS the winning terminal fact",
    (cancelTerminal as EpEnvelopeError & { outcome?: GoalResultFact })?.outcome?.state === "succeeded");
  await rejects("cancel of an UNKNOWN goal is failed-precondition",
    () => requestGoalCancel(kv, jsm, SPACE, { ref: ref("g-none"), mode: "graceful" }), "failed-precondition");

  // ── the cached outcome + tombstone summary ──
  const cached = await readGoalResult(jsm, SPACE, ref("g1"));
  c("the cached terminal fact carries the §13.6 tombstone summary (goalId, fingerprint, state, outcomeDigest)",
    cached?.goalId === "g1" && cached?.fingerprint === "sha256:aa" && cached?.state === "succeeded" && typeof cached?.outcomeDigest === "string");
  c("a not-terminal goal reads undefined", (await readGoalResult(jsm, SPACE, ref("g-none"))) === undefined);

  // ── bounded readiness: the acceptance-relative deadline settles `uncertain` terminally ──
  await bindGoal(js, jsm, SPACE, req, "g2", "sha256:cc");
  await createGoal(kv, ref("g2"), specOf("g2", "sha256:cc", { readinessDeadlineMs: 30_000 }));
  await rejects("an uncertain settle BEFORE the readiness deadline refuses (an early settle would steal a still-possible success)",
    () => settleGoalUncertain(js, jsm, SPACE, { ref: ref("g2"), fingerprint: "sha256:cc", acceptedAt: NOW, readinessDeadlineMs: 30_000, now: NOW + 29_999 }), "failed-precondition");
  const unc = await settleGoalUncertain(js, jsm, SPACE, { ref: ref("g2"), fingerprint: "sha256:cc", acceptedAt: NOW, readinessDeadlineMs: 30_000, now: NOW + 30_000 });
  c("past the deadline the goal settles terminally `uncertain` (a terminal outcome, not an absence)", unc.won && unc.fact.state === "uncertain");
  const lateSuccess = await commitGoalResult(js, jsm, SPACE, { ref: ref("g2"), fingerprint: "sha256:cc", state: "succeeded", now: NOW + 31_000 });
  c("a LATE success loses the terminal CAS and observes `uncertain` (the goal is never rewritten)",
    !lateSuccess.won && lateSuccess.fact.state === "uncertain");
  // and the reverse race: a success that lands FIRST beats the settle
  await bindGoal(js, jsm, SPACE, req, "g3", "sha256:dd");
  await createGoal(kv, ref("g3"), specOf("g3", "sha256:dd", { readinessDeadlineMs: 30_000 }));
  await commitGoalResult(js, jsm, SPACE, { ref: ref("g3"), fingerprint: "sha256:dd", state: "succeeded", now: NOW + 29_000 });
  const settleLate = await settleGoalUncertain(js, jsm, SPACE, { ref: ref("g3"), fingerprint: "sha256:dd", acceptedAt: NOW, readinessDeadlineMs: 30_000, now: NOW + 30_001 });
  c("a success that committed FIRST wins; the due settle observes it instead", !settleLate.won && settleLate.fact.state === "succeeded");

  // ── fail-closed storage reads ──
  await kv.delete(`goal.manager.u_abc.worker.${UID}.g3.status`);
  await rejects("a DEL marker on the goal status refuses (a deletion never erases a projection)",
    () => readGoalStatus(kv, ref("g3")), "failed-precondition");

  c("terminal subjects are goal-scoped", goalResultSubject(SPACE, ref("g1")) !== goalResultSubject(SPACE, ref("g2")));

  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT ACTION SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
