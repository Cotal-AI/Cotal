/**
 * v0.4 §13.6 (i) INSTANT EPOCH FENCE smoke — P2 item 3 slice 3.0, the HARD-BLOCKING opener.
 *
 * THE EXIT CRITERION (a test, not a comment): the corpse-wrong-terminal-during-window property —
 * a SUPERSEDED manager's WRONG terminal committed under the OLD gate epoch is NOT surfaced by a
 * CURRENT-EPOCH reader; the successor's settle under the current epoch is what callers see. The
 * mechanism is the epoch-scoped terminal-fact subject (`…result.<execEpoch>`, one create-only
 * subject per executor epoch) + the current-epoch-resolved read (readLastFact on the EXACT epoch
 * subject, never a wildcard `last_by_subj` — the 1c.1 append-shadow lesson). No item-3 slice that
 * enables a SECOND CONCURRENT manager may merge before this smoke is green.
 *
 * Also covers: the (ii) commit belt (a superseded / retired committer is refused `expired`), the
 * wiring guards (executor-pinned goal without an epoch, or epoch on a non-pinned goal, or an
 * executor goal through a context with no resolver — all refuse loud), and the UNTOUCHED flat
 * path (a non-executor goal keeps the caller-keyed `…result` subject and first-terminal-wins).
 *
 * Run: pnpm smoke:goal-epoch-fence   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, EpEnvelopeError, createEndpointStreams, openRecordsBucket,
  actionContext, bindGoal, createGoal, commitGoalResult, readGoalResult, settleGoalUncertain,
  goalResultSubject, goalRefOf, readLastFact, epfStreamName,
  type EpCaller, type GoalRef, type ParsedEpRequest, type ActionContext,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const rejects = async (n: string, fn: () => Promise<unknown> | unknown, code?: string) => {
  try { await fn(); c(n, false, "no throw"); } catch (e) {
    c(n, code === undefined || (e instanceof EpEnvelopeError && e.code === code), `code ${(e as EpEnvelopeError).code ?? (e as Error).message}`);
  }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "epfence";
const UID = "u".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };
const reqOf = (goalId: string): ParsedEpRequest =>
  ({ plane: "request", route: "one", endpoint: "manager", command: "spawn", caller, id: goalId } as unknown as ParsedEpRequest);
const ref = (goalId: string): GoalRef => goalRefOf(reqOf(goalId), goalId);
const MGR = "m".repeat(26); // the executing manager's (logical) instanceId
const NOW = 1_000_000;

// ── broker-free: the subject shape ──
c("an executor-pinned goal's result subject is EPOCH-SCOPED; flat otherwise",
  goalResultSubject(SPACE, ref("g1"), 7).endsWith(`.g1.result.7`)
  && goalResultSubject(SPACE, ref("g1")).endsWith(`.g1.result`)
  && goalResultSubject(SPACE, ref("g1"), 7) !== goalResultSubject(SPACE, ref("g1"), 8));

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-epfence-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const jsm = await jetstreamManager(nc);
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);
  await openRecordsBucket(nc, SPACE);

  // The CURRENT-EPOCH source is controllable: the smoke plays the §13.1 gate. A reader/committer
  // resolves the executor's CURRENT epoch through this, exactly as the manager wires its gate.
  let currentEpoch = 1;
  const ctx: ActionContext = await actionContext(nc, SPACE, { resolveExecutorEpoch: (iid) => (iid === MGR ? currentEpoch : null) });
  const ctxNoResolver: ActionContext = await actionContext(nc, SPACE); // no fence wiring

  const acceptSpawn = async (goalId: string, over: Record<string, unknown> = {}) => {
    const r = ref(goalId);
    await bindGoal(ctx, r, `fp-${goalId}`);
    await createGoal(ctx, r, {
      fingerprint: `fp-${goalId}`, command: "spawn", caller: { id: "u_abc.worker", lifecycleUid: UID },
      requestId: goalId, sourceSeq: 0, acceptedAt: NOW, readinessDeadlineMs: 30_000,
      executor: { instanceId: MGR }, ...over,
    });
    return r;
  };

  // ── THE EXIT CRITERION: corpse-wrong-terminal-during-window ──
  {
    const r = await acceptSpawn("g-corpse");
    currentEpoch = 1; // the accepting (soon-corpse) incarnation is at e1

    // The corpse commits a WRONG terminal WHILE still current (the belt passes: e1 == e1). This is
    // the window the (i) fence covers: nothing yet knows it is about to be superseded.
    await commitGoalResult(ctx, { ref: r, now: NOW + 1, cause: "complete", state: "failed", data: { by: "corpse-e1" }, executorEpoch: 1 });
    c("before supersession the e1 terminal is the current view",
      (await readGoalResult(ctx, r))?.state === "failed");

    // SUPERSESSION: a successor incarnation advances the gate epoch to e2 (same logical instanceId).
    currentEpoch = 2;

    // THE FENCE: a current-epoch (e2) reader does NOT surface the corpse's OLD-epoch wrong terminal.
    c("a superseded manager's OLD-epoch wrong terminal is INVISIBLE to a current-epoch reader",
      (await readGoalResult(ctx, r)) === undefined);

    // The corpse's fact is NOT deleted — it is durably parked on its own stale-epoch subject,
    // simply never resolved-to. (Proves the fence is epoch-scoping, not erasure.)
    const parked = await readLastFact(jsm, epfStreamName(SPACE), goalResultSubject(SPACE, r, 1));
    c("the corpse's terminal is retained on its OWN stale-epoch subject (fenced, not erased)",
      parked !== undefined && (parked as { state?: string }).state === "failed");

    // The SUCCESSOR (e2) settles the goal — its settle under the current epoch is what callers see.
    await commitGoalResult(ctx, { ref: r, now: NOW + 2, cause: "complete", state: "succeeded", data: { by: "successor-e2" }, executorEpoch: 2 });
    const seen = await readGoalResult(ctx, r);
    c("the successor's settle under the CURRENT epoch is what callers see",
      seen?.state === "succeeded" && (seen?.data as { by?: string })?.by === "successor-e2");
  }

  // ── the (ii) commit belt: a superseded / retired committer is refused ──
  {
    const r = await acceptSpawn("g-belt");
    currentEpoch = 2; // the goal's executor is now at e2
    await rejects("a committer already superseded at commit time is refused (belt)",
      () => commitGoalResult(ctx, { ref: r, now: NOW + 3, cause: "complete", state: "succeeded", executorEpoch: 1 }), "expired");
  }
  {
    // Retirement: the resolver returns null (executor gone) -> a terminal commit is `expired`.
    const rr = ref("g-belt"); // already accepted, executor MGR
    const ctxRetired: ActionContext = await actionContext(nc, SPACE, { resolveExecutorEpoch: () => null });
    await rejects("a retired executor cannot commit a terminal (belt, null resolve)",
      () => commitGoalResult(ctxRetired, { ref: rr, now: NOW + 4, cause: "complete", state: "succeeded", executorEpoch: 2 }), "expired");
    currentEpoch = 2;
  }

  // ── wiring guards: an omission never silently reads/writes a flat terminal ──
  {
    const r = await acceptSpawn("g-guard");
    currentEpoch = 2;
    await rejects("an executor-pinned goal committed WITHOUT an epoch refuses loud",
      () => commitGoalResult(ctx, { ref: r, now: NOW + 5, cause: "complete", state: "succeeded" }), "failed-precondition");
    await rejects("an executor-pinned goal read through a context with NO resolver refuses loud",
      () => readGoalResult(ctxNoResolver, r), "failed-precondition");
    await rejects("an executor-pinned goal committed through a context with NO resolver refuses loud",
      () => commitGoalResult(ctxNoResolver, { ref: r, now: NOW + 5, cause: "complete", state: "succeeded", executorEpoch: 2 }), "failed-precondition");
  }

  // ── the flat (non-executor) path is UNTOUCHED ──
  {
    const r = ref("g-flat");
    await bindGoal(ctx, r, "fp-flat");
    await createGoal(ctx, r, {
      fingerprint: "fp-flat", command: "spawn", caller: { id: "u_abc.worker", lifecycleUid: UID },
      requestId: "g-flat", sourceSeq: 0, acceptedAt: NOW, readinessDeadlineMs: 30_000,
      // NO executor: an ordinary goal keeps the caller-keyed flat subject.
    });
    await rejects("an executorEpoch on a NON-executor goal is a wiring confusion, refused",
      () => commitGoalResult(ctx, { ref: r, now: NOW + 6, cause: "complete", state: "succeeded", executorEpoch: 2 }), "failed-precondition");
    await commitGoalResult(ctx, { ref: r, now: NOW + 6, cause: "complete", state: "succeeded", data: { flat: true } });
    const seen = await readGoalResult(ctx, r); // resolves NOTHING (no executor) -> flat read
    c("a non-executor goal commits + reads via the flat `…result` subject (epoch-agnostic)",
      seen?.state === "succeeded" && (seen?.data as { flat?: boolean })?.flat === true
      && (await readLastFact(jsm, epfStreamName(SPACE), goalResultSubject(SPACE, r))) !== undefined);
  }

  // ── settleGoalUncertain threads the executor epoch (the manager's readiness path) ──
  {
    const r = await acceptSpawn("g-uncertain");
    currentEpoch = 3;
    await rejects("settleGoalUncertain on an executor goal without an epoch refuses loud",
      () => settleGoalUncertain(ctx, { ref: r, now: NOW + 40_000 }), "failed-precondition");
    const res = await settleGoalUncertain(ctx, { ref: r, now: NOW + 40_000, executorEpoch: 3 });
    c("settleGoalUncertain commits `uncertain` under the executor epoch and a current reader sees it",
      res.fact.state === "uncertain" && (await readGoalResult(ctx, r))?.state === "uncertain");
  }

  await nc.drain().catch(() => nc.close());
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
}

console.log(`goal-epoch-fence smoke: ${ok} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
