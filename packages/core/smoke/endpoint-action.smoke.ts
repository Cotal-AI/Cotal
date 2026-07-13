/**
 * v0.4 §13.6 ACTION composite smoke — the goal machinery against a real broker, every seam over
 * a BRANDED action context. Covers: the pre-acceptance bind CAS (first-wins; retry vs conflict;
 * orphan adoption; bind=spec agreement), idempotent creation, the status machine (legal/illegal,
 * closed state-dependent fields, terminal ONLY via projection), FENCED transitions (a
 * target-pinned progress transition proves executor currency or refuses), the ONE cause-
 * discriminated commit point (complete needs executor currency; cancel needs `cancelling`;
 * readiness needs the persisted deadline; deny is owner fail-closed; a raw terminal state is
 * never accepted), first-terminal-fact-wins races, closed identity-bound schemas, the bounded
 * resolver, and the wire-surviving cached outcome.
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
  actionContext, bindGoal, classifyGoalReuse, resolveGoalSubmission, createGoal, readGoalSpec, readGoalStatus,
  transitionGoal, isLegalGoalTransition, projectGoalTerminal,
  commitGoalResult, readGoalResult, requestGoalCancel, settleGoalUncertain, goalTombstone,
  goalResultSubject, goalProgressTopic, goalRefOf,
  GOAL_TERMINAL_STATES, GOAL_TERMINAL_DETAIL_KIND,
  type EpCaller, type GoalRef, type ParsedEpRequest, type GoalResultFact, type ActionContext,
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
  const ctx: ActionContext = actionContext(kv, js, jsm, SPACE);

  // ── the branded context ──
  await rejects("a hand-assembled context look-alike is refused at every seam (the space bond is constructed, not asserted)",
    () => readGoalStatus({ kv, js, jsm, space: SPACE } as ActionContext, ref("g1")), "failed-precondition");

  // ── the goal bind: first-wins per goalId, BEFORE acceptance ──
  const b1 = await bindGoal(ctx, req, "g1", "sha256:aa");
  c("the first bind of a goalId wins", b1.bound === true);
  const b1retry = await bindGoal(ctx, req, "g1", "sha256:aa");
  c("a same-fingerprint rebind loses the CAS and reads the recorded bind (the caller's retry)",
    b1retry.bound === false && !b1retry.bound && classifyGoalReuse(b1retry.existing, "sha256:aa") === "cached");
  const b1forge = await bindGoal(ctx, req, "g1", "sha256:bb");
  c("a DIFFERENT-fingerprint bind for the same goalId classifies conflict BEFORE acceptance and effect",
    b1forge.bound === false && !b1forge.bound && classifyGoalReuse(b1forge.existing, "sha256:bb") === "conflict");

  // ── orphaned-bind adoption + bind=spec agreement ──
  {
    await bindGoal(ctx, req, "g-orphan", "sha256:oo");
    c("a same-fingerprint resubmission ADOPTS an orphaned bind (crash recovery)", (await resolveGoalSubmission(ctx, req, "g-orphan", "sha256:oo")).kind === "adopted");
    c("a different-fingerprint resubmission against the orphaned bind stays conflict", (await resolveGoalSubmission(ctx, req, "g-orphan", "sha256:xx")).kind === "conflict");
    await createGoal(ctx, ref("g-orphan"), specOf("sha256:oo"));
    c("once the adopted submission accepts, the same resubmission classifies cached", (await resolveGoalSubmission(ctx, req, "g-orphan", "sha256:oo")).kind === "cached");
    c("a virgin goalId is NEW work", (await resolveGoalSubmission(ctx, req, "g-new", "sha256:nn")).kind === "new");
  }

  // ── idempotent creation ──
  await createGoal(ctx, ref("g1"), specOf("sha256:aa"));
  c("acceptance creates the spec + `accepted` status", (await readGoalStatus(ctx, ref("g1")))?.value.state === "accepted");
  c("an IDENTICAL re-creation is idempotent", (await createGoal(ctx, ref("g1"), specOf("sha256:aa"))).specRevision === (await readGoalSpec(ctx, ref("g1")))?.revision);
  await rejects("a DIFFERENT definition under one goalId is a loud conflict", () => createGoal(ctx, ref("g1"), specOf("sha256:zz")), "conflict");
  {
    const rc = ref("g-crash");
    await kv.put(`goal.manager.u_abc.worker.${UID}.g-crash.spec`, enc(JSON.stringify({ v: 1, goalId: "g-crash", ...specOf("sha256:cr") })));
    c("(manufactured) the crashed creation left no status", (await readGoalStatus(ctx, rc)) === undefined);
    await createGoal(ctx, rc, specOf("sha256:cr"));
    c("an identical retry repairs the missing status (no stranded spec-only goal)", (await readGoalStatus(ctx, rc))?.value.state === "accepted");
  }
  c("an unknown goal reads undefined", (await readGoalStatus(ctx, ref("g-none"))) === undefined);

  // ── the status machine + FENCED transitions ──
  await transitionGoal(ctx, ref("g1"), "running");
  const sWait = await transitionGoal(ctx, ref("g1"), "waiting", { fields: { checkpoint: { token: "cp-1", deadlineGeneration: 3 } } });
  c("waiting carries the checkpoint coordinate", sWait.state === "waiting" && sWait.checkpoint?.token === "cp-1");
  c("leaving waiting DROPS the checkpoint (closed state-dependent schema)", (await transitionGoal(ctx, ref("g1"), "running")).checkpoint === undefined);
  await rejects("an illegal transition refuses (running → accepted)", () => transitionGoal(ctx, ref("g1"), "accepted"), "failed-precondition");
  await rejects("a NAKED terminal transition refuses (a terminal exists only as the fact's projection)", () => transitionGoal(ctx, ref("g1"), "succeeded"), "failed-precondition");
  await rejects("projecting a terminal with no committed fact refuses", () => projectGoalTerminal(ctx, ref("g1")), "failed-precondition");
  {
    // HIGH 1: a TARGET-PINNED goal's progress transition must prove executor currency.
    const rt = ref("g-fence");
    await bindGoal(ctx, req, "g-fence", "sha256:fe");
    await createGoal(ctx, rt, specOf("sha256:fe", { target: TARGET }));
    await rejects("a target-pinned progress transition with NO executor/owner-authored refuses (a superseded epoch cannot commit transitions)",
      () => transitionGoal(ctx, rt, "running"), "failed-precondition");
    await rejects("a target-pinned transition by a SUPERSEDED executor epoch refuses",
      () => transitionGoal(ctx, rt, "running", { executor: { lifecycleUid: TARGET.lifecycleUid, epoch: 2 }, resolveCurrentEpoch: () => 3 }), "expired");
    await rejects("a target-pinned transition by a SAME-NAME SUCCESSOR lifecycle refuses",
      () => transitionGoal(ctx, rt, "running", { executor: { lifecycleUid: "f".repeat(26), epoch: 2 }, resolveCurrentEpoch: () => 2 }), "expired");
    const okT = await transitionGoal(ctx, rt, "running", { executor: { lifecycleUid: TARGET.lifecycleUid, epoch: 2 }, resolveCurrentEpoch: () => 2 });
    c("a target-pinned transition by the CURRENT executor (matching lifecycle + fresh epoch) succeeds", okT.state === "running");
    await rejects("a HUNG executor-epoch resolver refuses `unavailable` within the budget",
      () => transitionGoal(ctx, rt, "waiting", { executor: { lifecycleUid: TARGET.lifecycleUid, epoch: 2 }, resolveCurrentEpoch: () => new Promise<never>(() => {}), epochResolveBudgetMs: 100 }), "unavailable");
    await rejects("an executor supplied for a NON-TARGET transition refuses (wiring confusion)",
      () => transitionGoal(ctx, ref("g1"), "waiting", { executor: { lifecycleUid: UID, epoch: 1 }, resolveCurrentEpoch: () => 1 }), "failed-precondition");
  }

  // ── cancel vs completion at the ONE commit point ──
  const cancelStatus = await requestGoalCancel(ctx, { request: req, goalId: "g1", mode: "graceful" });
  c("cancel transitions a live goal to `cancelling` recording the mode", cancelStatus.state === "cancelling" && cancelStatus.cancelMode === "graceful");
  c("a repeated cancel is idempotent (first mode wins)", (await requestGoalCancel(ctx, { request: req, goalId: "g1", mode: "terminate" })).cancelMode === "graceful");
  {
    const foreign = { plane: "request", route: "one", endpoint: "manager", command: "cancel", caller: { owner: "u_zzz", actor: "worker", uid: "z".repeat(26) } } as unknown as ParsedEpRequest;
    await rejects("a cancel derives its goal from the BROKER-AUTHENTICATED caller (confused deputy closed)",
      () => requestGoalCancel(ctx, { request: foreign, goalId: "g1", mode: "graceful" }), "failed-precondition");
  }
  // HIGH 2: the commit is CAUSE-discriminated. A `complete` succeeds; `cancel` needs cancelling.
  const done = await commitGoalResult(ctx, { ref: ref("g1"), now: NOW + 500, cause: "complete", state: "succeeded", data: { url: "https://x" } });
  c("a completion commit wins the terminal, stamps the PERSISTED fingerprint, projects the winner",
    done.won && done.fact.state === "succeeded" && done.fact.fingerprint === "sha256:aa" && done.status.state === "succeeded");
  const cancelCommit = await commitGoalResult(ctx, { ref: ref("g1"), now: NOW + 600, cause: "deny" });
  c("a losing commit observes the WINNING terminal instead of re-deciding", !cancelCommit.won && cancelCommit.fact.state === "succeeded" && cancelCommit.status.state === "succeeded");
  const term = await rejects("cancel of a TERMINAL goal is failed-precondition with the cached outcome attached",
    () => requestGoalCancel(ctx, { request: req, goalId: "g1", mode: "graceful" }), "failed-precondition") as EpEnvelopeError;
  {
    const detail = term?.details?.find((d) => d.kind === GOAL_TERMINAL_DETAIL_KIND) as { fact?: GoalResultFact } | undefined;
    c("…and the attached outcome rides error.details and survives toEpError()",
      detail?.fact?.state === "succeeded" && term?.toEpError().details?.some((d) => d.kind === GOAL_TERMINAL_DETAIL_KIND) === true);
  }

  // HIGH 2: a raw terminal state is NEVER accepted — the cause derives the state.
  {
    const rr = ref("g-raw");
    await bindGoal(ctx, req, "g-raw", "sha256:rw");
    await createGoal(ctx, rr, specOf("sha256:rw"));
    await rejects("a `cancel` cause on a goal that is NOT cancelling refuses (no naked cancelled assertion)",
      () => commitGoalResult(ctx, { ref: rr, now: NOW, cause: "cancel" }), "failed-precondition");
    await rejects("a `readiness` cause on a goal with NO readiness bound refuses",
      () => commitGoalResult(ctx, { ref: rr, now: NOW + 999_999, cause: "readiness" }), "failed-precondition");
    await rejects("a completion with a non-succeeded/failed state refuses (the cause bounds the state)",
      () => commitGoalResult(ctx, { ref: rr, now: NOW, cause: "complete", state: "uncertain" as "succeeded" }), "failed-precondition");
  }

  // ── target-pinned completion currency + the target-pinned READINESS path (MEDIUM 4) ──
  {
    const rt = ref("g-target");
    await bindGoal(ctx, req, "g-target", "sha256:tt");
    await createGoal(ctx, rt, specOf("sha256:tt", { target: TARGET, readinessDeadlineMs: 30_000 }));
    await rejects("a target-pinned completion WITHOUT executor identity refuses",
      () => commitGoalResult(ctx, { ref: rt, now: NOW, cause: "complete", state: "succeeded" }), "failed-precondition");
    await rejects("a target-pinned completion by a superseded epoch refuses",
      () => commitGoalResult(ctx, { ref: rt, now: NOW, cause: "complete", state: "succeeded", executor: { lifecycleUid: TARGET.lifecycleUid, epoch: 2 }, resolveCurrentEpoch: () => 3 }), "expired");
    // the OWNER readiness deadline is reachable for a target-pinned goal WITHOUT an executor:
    const unc = await commitGoalResult(ctx, { ref: rt, now: NOW + 30_000, cause: "readiness" });
    c("a target-pinned goal's OWNER readiness deadline settles `uncertain` with NO executor (MEDIUM 4 reachable)",
      unc.won && unc.fact.state === "uncertain" && unc.status.state === "uncertain");
  }

  // ── MEDIUM 1: mid-flight ref mutation cannot split the commit ──
  {
    const rm = ref("g-mut");
    await bindGoal(ctx, req, "g-mut", "sha256:mu");
    await createGoal(ctx, rm, specOf("sha256:mu"));
    const mutRef: GoalRef = { endpoint: "manager", caller: { ...caller }, goalId: "g-mut" };
    const pending = commitGoalResult(ctx, { ref: mutRef, now: NOW + 5, cause: "complete", state: "succeeded" });
    mutRef.goalId = "g-HIJACK";
    const mres = await pending;
    c("a mid-flight ref mutation lands the terminal on the ENTRY-SNAPSHOTTED goal, not the hijacked one",
      mres.won && (await readGoalResult(ctx, ref("g-mut")))?.state === "succeeded" && (await readGoalResult(ctx, ref("g-HIJACK"))) === undefined);
  }

  // ── MEDIUM 2: closed identity-bound schemas ──
  {
    await kv.put(`goal.manager.u_abc.worker.${UID}.g-badspec.spec`, enc(JSON.stringify({ v: 1, goalId: "g-badspec", ...specOf("sha256:bs"), rogue: 1 })));
    await rejects("a goal spec carrying an UNKNOWN field is garbled (closed schema)", () => readGoalSpec(ctx, ref("g-badspec")), "internal");
    await kv.put(`goal.manager.u_abc.worker.${UID}.g-misattr.spec`, enc(JSON.stringify({ v: 1, goalId: "g-misattr", ...specOf("sha256:ma"), caller: { id: "u_abc.worker", lifecycleUid: "OTHER" } })));
    await rejects("a spec whose caller lifecycle is NOT its subject uid is garbled (identity-bound)", () => readGoalSpec(ctx, ref("g-misattr")), "internal");
    await kv.put(`goal.manager.u_abc.worker.${UID}.g-badstatus.status`, enc(JSON.stringify({ state: "running", checkpoint: { token: "cp", deadlineGeneration: 1 }, observedSpecRevision: 1 })));
    await rejects("a status with a checkpoint outside `waiting` is garbled", () => readGoalStatus(ctx, ref("g-badstatus")), "internal");
  }

  // ── the tombstone serving form + digest-inconsistent rejection ──
  const cached = await readGoalResult(ctx, ref("g1"));
  c("goalTombstone serves the payload-evicted retry form (same outcome identity)",
    cached !== undefined && (goalTombstone(cached).data as { evicted: boolean }).evicted === true && goalTombstone(cached).outcomeDigest === cached.outcomeDigest);
  {
    const rd = ref("g-baddigest");
    const digestFact = { v: 1, goalId: "g-baddigest", fingerprint: "sha256:dd", state: "succeeded", outcomeDigest: contractDigest({ forged: true }), data: { real: true }, ts: NOW };
    await js.publish(goalResultSubject(SPACE, rd), enc(JSON.stringify(digestFact)));
    await rejects("a result fact whose tombstone digest does not match its payload is rejected", () => readGoalResult(ctx, rd), "internal");
  }

  // ── settleGoalUncertain wrapper + the reverse race ──
  await bindGoal(ctx, req, "g2", "sha256:cc");
  await createGoal(ctx, ref("g2"), specOf("sha256:cc", { readinessDeadlineMs: 30_000 }));
  await rejects("settleGoalUncertain BEFORE the persisted deadline refuses", () => settleGoalUncertain(ctx, { ref: ref("g2"), now: NOW + 29_999 }), "failed-precondition");
  c("past the deadline settleGoalUncertain settles `uncertain`", (await settleGoalUncertain(ctx, { ref: ref("g2"), now: NOW + 30_000 })).fact.state === "uncertain");
  await bindGoal(ctx, req, "g3", "sha256:dd");
  await createGoal(ctx, ref("g3"), specOf("sha256:dd", { readinessDeadlineMs: 30_000 }));
  await commitGoalResult(ctx, { ref: ref("g3"), now: NOW + 29_000, cause: "complete", state: "succeeded" });
  c("a success that committed FIRST wins; the due settle observes it", (await settleGoalUncertain(ctx, { ref: ref("g3"), now: NOW + 30_001 })).fact.state === "succeeded");

  // ── fail-closed storage reads ──
  await kv.delete(`goal.manager.u_abc.worker.${UID}.g3.status`);
  await rejects("a DEL marker on the goal status refuses", () => readGoalStatus(ctx, ref("g3")), "failed-precondition");
  await kv.delete(`goal.manager.u_abc.worker.${UID}.g3.spec`);
  await rejects("a DEL marker on the goal spec refuses", () => readGoalSpec(ctx, ref("g3")), "failed-precondition");

  c("terminal subjects are goal-scoped", goalResultSubject(SPACE, ref("g1")) !== goalResultSubject(SPACE, ref("g2")));
  c("goalRefOf derives the ref from the broker-authenticated request", goalRefOf(req, "g9").caller.owner === "u_abc" && goalRefOf(req, "g9").endpoint === "manager");

  await nc.close();
} finally {
  broker.kill("SIGKILL");
  await new Promise<void>((resolve) => { broker.once("exit", () => resolve()); broker.once("error", () => resolve()); });
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT ACTION SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
