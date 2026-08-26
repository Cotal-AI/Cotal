/**
 * v0.4 §13.6 GOAL-TERMINAL ATTRIBUTION smoke — the item-3 acceptance gate, REWRITTEN.
 *
 * WHAT THIS SUITE USED TO ASSERT, and why it was replaced. It encoded the epoch-scoped terminal
 * subject `…result.<execEpoch>`: one create-only subject per executor epoch, so a superseded
 * manager's terminal landed where no current reader looked. That mechanism was BOTH
 * non-conformant (SPEC §13.2 (reserved subjects) reserves the flat `goal.<cOwner>.<cActor>.<cUid>.<goalId>.result`
 * with no epoch token) AND actively wrong. It conflated two different jobs:
 *   - as a READ fence it produced WRONG ANSWERS. The window is "commit the terminal, then die
 *     before projecting it", where the pre-restart fact is the LEGITIMATE outcome, not a corpse's
 *     guess. Scoping by epoch hid that winner from every post-restart reader, made the crash
 *     reconciler throw instead of projecting, and then let the successor commit a SECOND,
 *     contradictory terminal on the new epoch's subject — the one callers actually read. A real
 *     `succeeded` was read back as `uncertain` for an agent that had genuinely spawned.
 *   - as a multi-manager WRITE fence it was load-bearing, which is why deleting it alone was not
 *     enough and this suite exists.
 *
 * WHAT IT ASSERTS NOW: one goal has ONE terminal subject, and every terminal is ATTRIBUTED, judged
 * against the goal's OWN accepted epoch and NEVER against the current one:
 *   - `committed == accepted` — the accepting executor answering for its own work. Valid FOREVER,
 *     however far the current epoch has advanced. This is the invariant the epoch subject lost.
 *   - `committed > accepted`  — a successor settling work it inherited. Valid.
 *   - `committed < accepted`  — impossible; refused as a garbled journal.
 *   - a half-attributed pair (epoch-bearing goal with an unattributed terminal, or a committer on
 *     a goal with no epoch context) is refused. There are no anonymous terminals.
 *
 * WHAT THIS SUITE DOES **NOT** PROVE, stated so no reader can mistake its scope. It is NOT a write
 * fence against a LIVE superseded committer. A corpse committing the terminal of a goal IT
 * accepted stamps `committed == accepted` and is accepted here, exactly as the true executor would
 * be — see the CORPSE case below, which asserts that indistinguishability rather than papering
 * over it. Create-only CAS conditions on subject ABSENCE and cannot express "only if my epoch is
 * still current", so the write fence is the §13.1 takeover barrier.
 *
 * THE RESIDUAL IS WIDER THAN "BYTES IN FLIGHT", and this suite says so because an earlier draft of
 * it got this wrong. A gate FREEZE neither kills the predecessor's connection nor advances the
 * epoch, and the currency belt compares `processEpoch` alone, so a deposed manager's belt STILL
 * PASSES from barrier start through PHASE 1-2 until the reopen. Revoking an `epcred` row marks a
 * ledger row; it does not re-check a live JWT mid-publish on an already-open connection. The
 * durable death of that publisher is the CLUSTER-VERIFIED EVICTION in PHASE 2, not the revoke. So
 * a deposed manager can still INITIATE new terminal publishes from barrier start until eviction is
 * verified. On an OPEN mesh no credential family exists, so that eviction is vacuous and there is
 * no durable fence at all — the belt there is cooperative only. The named follow-up that would
 * close this is the gate-linearized commit (routing the terminal through the issuance gate's own
 * CAS); it is deliberately deferred as substrate/item-3 territory.
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
  recordGoalIndex, readGoalIndex,
  projectGoalTerminal, goalResultSubject, goalRefOf, readLastFact, epfStreamName,
  type EpCaller, type GoalRef, type ParsedEpRequest, type ActionContext,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

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
const MGR = "m".repeat(26);   // the executing manager's (logical) instanceId
const MGR2 = "n".repeat(26);  // a DIFFERENT instance, for the cross-instance cases
const FP = "sha256:" + "a".repeat(64);
const NOW = 1_000_000;

// ── broker-free: the subject shape ──
// The signature takes NO epoch. A second argument would not type-check, which is the structural
// half of the fix: there is no way to address a per-epoch result subject any more.
c("a goal's terminal subject is the ONE flat SPEC:1433 (§13.2 reserved subjects) form, with no epoch token",
  goalResultSubject(SPACE, ref("g1")).endsWith(".g1.result")
  && !/\.result\.\d+$/.test(goalResultSubject(SPACE, ref("g1"))));

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, sd);

const newGoal = async (ctx: ActionContext, id: string, acceptedEpoch: number | undefined): Promise<GoalRef> => {
  const g = ref(id);
  await bindGoal(ctx, g, FP);
  await createGoal(ctx, g, {
    fingerprint: FP, command: "spawn",
    caller: { id: `${caller.owner}.${caller.actor}`, lifecycleUid: caller.uid },
    ...(acceptedEpoch !== undefined ? { acceptedEpoch } : {}),
    requestId: id, sourceSeq: 1, acceptedAt: NOW, readinessDeadlineMs: 30_000,
  });
  return g;
};

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  if (!up) throw new Error("broker did not come up");
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const jsm = await jetstreamManager(nc);
  await createEndpointStreams(jsm, new Kvm(nc), SPACE);
  await openRecordsBucket(nc, SPACE);
  // No resolveExecutorEpoch: the context cannot be wired to resolve a "current" epoch, because
  // judging a terminal against the current epoch is exactly the defect this suite replaced.
  const ctx: ActionContext = await actionContext(nc, SPACE);

  // ── THE REGRESSION THIS SUITE EXISTS TO CATCH: the legitimate pre-restart winner ──
  {
    const g = await newGoal(ctx, "g-pre-restart", 0);
    const won = await commitGoalResult(ctx, {
      ref: g, now: NOW + 5, cause: "complete", state: "succeeded",
      data: { name: "reviewer", id: "x".repeat(26) }, committer: { instanceId: MGR, epoch: 0 },
    });
    c("the live executor commits the real terminal", won.won === true && won.fact.state === "succeeded");
    // The executor dies here; the restart advances the gate's processEpoch 0 -> 1. Nothing about
    // how the committed fact is addressed or judged depends on that, which IS the fix.
    const after = await readGoalResult(ctx, g);
    c("the legitimate pre-restart winner is STILL surfaced after the epoch advance",
      after?.state === "succeeded", after === undefined ? "HIDDEN — the epoch-scoped regression is back" : after);
    c("the crash reconciler PROJECTS that terminal rather than throwing",
      (await projectGoalTerminal(ctx, g)).state === "succeeded");
    // The successor's readiness settle must LOSE: one goal, one terminal, first-fact-wins globally.
    const second = await settleGoalUncertain(ctx, { ref: g, now: NOW + 30_006, committer: { instanceId: MGR, epoch: 1 } });
    c("a successor cannot commit a SECOND, contradictory terminal for one goal", second.won === false);
    c("the outcome callers read is the REAL one, not the successor's guess",
      (await readGoalResult(ctx, g))?.state === "succeeded");
    c("exactly ONE result subject exists for the goal",
      (await readLastFact(jsm, epfStreamName(SPACE), goalResultSubject(SPACE, g))) !== undefined);
  }

  // ── attribution: judged against the ACCEPTED epoch, never the current one ──
  {
    const g = await newGoal(ctx, "g-attr", 0);
    await commitGoalResult(ctx, { ref: g, now: NOW + 7, cause: "complete", state: "succeeded", committer: { instanceId: MGR, epoch: 0 } });
    const f = await readGoalResult(ctx, g);
    c("a terminal records WHO committed it and under which epoch",
      f?.committer?.instanceId === MGR && f?.committer?.epoch === 0, f?.committer);
  }
  {
    const g = await newGoal(ctx, "g-successor", 0);
    const r = await settleGoalUncertain(ctx, { ref: g, now: NOW + 30_007, committer: { instanceId: MGR2, epoch: 1 } });
    c("committed > accepted: a SUCCESSOR settling inherited work commits, and is attributed to ITSELF",
      r.won === true && (await readGoalResult(ctx, g))?.committer?.epoch === 1);
  }
  {
    const g = await newGoal(ctx, "g-older", 3);
    await rejects("committed < accepted: refused - no incarnation commits under an epoch older than the accept",
      () => settleGoalUncertain(ctx, { ref: g, now: NOW + 30_008, committer: { instanceId: MGR, epoch: 2 } }), "failed-precondition");
    await rejects("an UNATTRIBUTED terminal on an epoch-bearing goal is refused (no anonymous terminals)",
      () => settleGoalUncertain(ctx, { ref: g, now: NOW + 30_009 }), "failed-precondition");
  }
  {
    const g = await newGoal(ctx, "g-noepoch", undefined);
    await rejects("a committer on a goal accepted with NO epoch context is a wiring confusion, refused",
      () => settleGoalUncertain(ctx, { ref: g, now: NOW + 30_010, committer: { instanceId: MGR, epoch: 0 } }), "failed-precondition");
    const r = await settleGoalUncertain(ctx, { ref: g, now: NOW + 30_011 });
    c("...and the same goal settles fine unattributed (the pair is all-or-nothing)", r.won === true);
  }

  // ── H2: THE RECONCILE INDEX REPORTS WHO WON, AND CARRIES THE ACCEPTANCE FLOOR ──
  // The index had NO behavioural coverage at this layer at all, which is how both defects survived.
  // A create-only loss used to be validated for SHAPE and then discarded, so a loss to a FOREIGN
  // incarnation was indistinguishable from one's own idempotent retry — the caller went on believing
  // the index pointed at ITS acceptance when it pointed at a sibling's.
  {
    const g = await newGoal(ctx, "g-index", 0);
    const mine = { name: "agent-a", actor: "act-a", uid: "uid-a" };
    const first = await recordGoalIndex(ctx, g, MGR, mine);
    c("the first incarnation to record an accepted goal wins the create-only CAS", first.recorded === true);

    const retry = await recordGoalIndex(ctx, g, MGR, mine);
    c("the SAME incarnation retrying is an idempotent loss that reports itself as the winner",
      retry.recorded === false && retry.recorded === false && (retry as { existing: { iid: string } }).existing.iid === MGR);

    const foreign = await recordGoalIndex(ctx, g, "mgr-sibling", { name: "agent-b", actor: "act-b", uid: "uid-b" });
    c("a FOREIGN incarnation's loss is DISTINGUISHABLE and names the instance that actually accepted",
      foreign.recorded === false && (foreign as { existing: { iid: string } }).existing.iid === MGR,
      foreign);
    c("...and the loser reads the WINNER's allocated identity, never its own",
      JSON.stringify((foreign as { existing: { allocated?: unknown } }).existing.allocated) === JSON.stringify(mine),
      (foreign as { existing: { allocated?: unknown } }).existing.allocated);

    // The floor is readable from the moment of acceptance — BEFORE any terminal exists. That is the
    // whole point: the window a same-goalId retry actually lands in is the one where the winner is
    // still in flight, which is exactly when the terminal cannot answer.
    c("the acceptance floor is readable with NO terminal committed (the window the terminal cannot serve)",
      (await readGoalResult(ctx, g)) === undefined
      && JSON.stringify((await readGoalIndex(ctx, g))?.allocated) === JSON.stringify(mine));
  }
  {
    // A floor with an empty component is the hollow acceptance this field exists to end: it reads as
    // an identity and names nothing, so it is refused as garbled rather than served.
    const g = await newGoal(ctx, "g-hollow", 0);
    await rejects("a hollow acceptance floor (empty component) is refused as garbled, never served",
      () => recordGoalIndex(ctx, g, MGR, { name: "", actor: "act", uid: "uid" }), "internal");
  }

  // ── THE CORPSE CASE, asserted rather than papered over ──
  // A live-superseded manager committing the terminal of a goal IT accepted is INDISTINGUISHABLE
  // here from the true executor: both stamp `committed == accepted`. This suite asserts that fact
  // explicitly so nobody reads the attribution rule as a write fence it is not.
  //
  // What stops the corpse is the §13.1 barrier's CLUSTER-VERIFIED EVICTION — and only from the
  // moment that eviction is verified. Read the module header for the full window: a freeze neither
  // kills the connection nor advances the epoch, so the corpse's own currency belt still passes
  // through it, and a ledger revoke marks a row rather than killing a live publisher. Successor
  // EXISTENCE (PHASE 4) and corpse DEATH (PHASE 2 eviction) are different steps, so an ordering
  // fact about the phases licenses no conclusion about when the corpse stops being able to write.
  {
    const g = await newGoal(ctx, "g-corpse", 0);
    const corpse = await commitGoalResult(ctx, {
      ref: g, now: NOW + 9, cause: "complete", state: "failed",
      data: { by: "live-superseded-incarnation" }, committer: { instanceId: MGR, epoch: 0 },
    });
    c("a corpse committing its OWN goal's terminal is NOT refused by attribution alone - the write fence is the 13.1 barrier, not this rule",
      corpse.won === true && (await readGoalResult(ctx, g))?.state === "failed");
  }

  await nc.drain().catch(() => nc.close());
} finally {
  broker.kill("SIGKILL");
  rmSync(sd, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}

console.log(`${fail === 0 ? "GOAL TERMINAL ATTRIBUTION SMOKE OK ✅" : "GOAL TERMINAL ATTRIBUTION SMOKE FAILED ❌"}  (${ok} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
