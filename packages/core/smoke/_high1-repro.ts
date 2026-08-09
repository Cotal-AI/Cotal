/**
 * HIGH-1 REPRO (Lane A) — the epoch-scoped terminal subject hides a LEGITIMATE pre-restart winner.
 *
 * The window the panel named: an executor COMMITS the terminal fact and then DIES before
 * projectGoalTerminal runs. The fact is durable and correct. After the restart the executor's gate
 * epoch has advanced, so readGoalResult resolves the CURRENT epoch and reads `…result.<N+1>` —
 * while the legitimate winner sits on `…result.<N>`. The goal is terminal in the journal and
 * reports as not-terminal to every reader. This is NOT the superseded-corpse case the epoch scoping
 * was designed for: nothing here is a corpse's wrong answer, it is the real outcome.
 *
 * Run against CURRENT code it must FAIL (the winner is hidden). That failure is the repro.
 *
 * Run: pnpm tsx packages/core/smoke/_high1-repro.ts   (needs nats-server on PATH)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, createEndpointStreams, openRecordsBucket,
  actionContext, bindGoal, createGoal, commitGoalResult, readGoalResult, projectGoalTerminal,
  goalRefOf, type EpCaller, type GoalRef, type ParsedEpRequest, type ActionContext,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; console.log("  ✓", n); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE = "high1";
const UID = "u".repeat(26);
const MGR = "m".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };
const reqOf = (goalId: string): ParsedEpRequest =>
  ({ plane: "request", route: "one", endpoint: "manager", command: "spawn", caller, id: goalId } as unknown as ParsedEpRequest);
const ref = (goalId: string): GoalRef => goalRefOf(reqOf(goalId), goalId);
const FP = "sha256:" + "b".repeat(64);

const PORT = 20000 + Math.floor(Math.random() * 40000);
const sd = mkdtempSync(join(tmpdir(), "cotal-high1-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const jsm = await jetstreamManager(nc);
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);
  await openRecordsBucket(nc, SPACE);

  // POST-FIX: there is no executor pin and no epoch to resolve, so a restart changes NOTHING about
  // how the committed terminal is addressed. That is the fix — the restart is now irrelevant.
  const ctx: ActionContext = await actionContext(nc, SPACE);

  const g = ref("g-high1");
  await bindGoal(ctx, g, FP);
  await createGoal(ctx, g, {
    fingerprint: FP, command: "spawn",
    caller: { id: `${caller.owner}.${caller.actor}`, lifecycleUid: caller.uid },
    requestId: "g-high1", sourceSeq: 1, acceptedAt: 1_000_000, readinessDeadlineMs: 30_000,
  });

  console.log("\n── the legitimate pre-restart winner ──");
  // The REAL outcome, committed by the LIVE executor at its CURRENT epoch 0. Nothing is superseded
  // here: this is the honest terminal. commitGoalResult also projects it, so we assert the fact and
  // the projection both exist before the restart.
  const won = await commitGoalResult(ctx, {
    ref: g, now: 1_000_005, cause: "complete", state: "succeeded",
    data: { name: "reviewer", id: "n".repeat(26) },
  });
  c("the live executor committed the real terminal at epoch 0", won.won === true && won.fact.state === "succeeded");
  c("it is readable BEFORE the restart", (await readGoalResult(ctx, g))?.state === "succeeded");

  console.log("\n── the executor dies and restarts: PHASE 4 advances processEpoch 0 -> 1 ──");

  // THE FINDING. The fact is durable, correct, and the only terminal that was ever committed.
  const after = await readGoalResult(ctx, g);
  c("HIGH-1: the legitimate pre-restart winner is STILL surfaced after the restart",
    after?.state === "succeeded", after === undefined ? "readGoalResult returned undefined — the winner is HIDDEN" : after);

  // And the crash-reconciler that exists precisely to project a committed-but-unprojected terminal
  // cannot find it either, so the goal can never reach a terminal status.
  let projected: string | undefined;
  let projectError: string | undefined;
  try { projected = (await projectGoalTerminal(ctx, g)).state; }
  catch (e) { projectError = (e as Error).message; }
  c("HIGH-1: the crash reconciler can still project that terminal after the restart",
    projected !== undefined, projectError ?? projected);

  // THE SHARPEST CONSEQUENCE. Because the successor sees no terminal, its boot reconcile settles the
  // goal itself — at the NEW epoch, on a DIFFERENT create-only subject. One goal now carries TWO
  // contradictory terminal facts, and the one callers read is the WRONG one: the agent really did
  // spawn, and the goal reports `uncertain`.
  const second = await commitGoalResult(ctx, { ref: g, now: 1_030_006, cause: "readiness" });
  c("HIGH-1: the successor cannot commit a SECOND, contradictory terminal for one goal",
    second.won === false, `successor committed ${second.fact.state} while the journal already holds succeeded`);
  const surfaced = await readGoalResult(ctx, g);
  c("HIGH-1: the outcome callers read is the REAL one, not the successor's guess",
    surfaced?.state === "succeeded", surfaced);

  await nc.drain().catch(() => nc.close());
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nhigh1-repro: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
