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
import { connect, headers } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createUser } from "@nats-io/nkeys";
import {
  ownerCommitProof, type OwnerCommitProof,
  isReachable, EpEnvelopeError, contractDigest, updateRecordEntry,
  createEndpointStreams, openRecordsBucket, epeSubject, epfSubject,
  actionContext, bindGoal, classifyGoalReuse, resolveGoalSubmission, createGoal, readGoalSpec, readGoalStatus,
  transitionGoal, isLegalGoalTransition, projectGoalTerminal,
  commitGoalResult, readGoalResult, requestGoalCancel, settleGoalUncertain, goalTombstone,
  goalResultSubject, goalProgressTopic, goalRefOf,
  reconcileReceiptEmission, receiptStoreContext, readReceipt, publishReceipt, mintReceipt, publishFactCreateOnly,
  GOAL_TERMINAL_STATES, GOAL_TERMINAL_DETAIL_KIND,
  type EpCaller, type GoalRef, type ParsedEpRequest, type GoalResultFact, type ActionContext,
  type Receipt, type ReceiptEmissionWiring, type ReceiptStoreContext,
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
  requestId: "req-any", sourceSeq: 7, acceptedAt: 1_000_000, ...over,
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
  const ctx: ActionContext = await actionContext(nc, SPACE);

  // ── the branded context ──
  await rejects("a hand-assembled context look-alike is refused at every seam (the space bond is constructed, not asserted)",
    () => readGoalStatus({ kv, js, jsm, space: SPACE } as ActionContext, ref("g1")), "failed-precondition");

  // ── the goal bind: first-wins per goalId, BEFORE acceptance ──
  const b1 = await bindGoal(ctx, ref("g1"), "sha256:aa");
  c("the first bind of a goalId wins", b1.bound === true);
  const b1retry = await bindGoal(ctx, ref("g1"), "sha256:aa");
  c("a same-fingerprint rebind loses the CAS and reads the recorded bind (the caller's retry)",
    b1retry.bound === false && !b1retry.bound && classifyGoalReuse(b1retry.existing, "sha256:aa") === "cached");
  const b1forge = await bindGoal(ctx, ref("g1"), "sha256:bb");
  c("a DIFFERENT-fingerprint bind for the same goalId classifies conflict BEFORE acceptance and effect",
    b1forge.bound === false && !b1forge.bound && classifyGoalReuse(b1forge.existing, "sha256:bb") === "conflict");

  // ── orphaned-bind adoption + bind=spec agreement ──
  {
    await bindGoal(ctx, ref("g-orphan"), "sha256:oo");
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
    await bindGoal(ctx, ref("g-fence"), "sha256:fe");
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

    // The currency check is PAIRED with each CAS attempt: the first resolve answers CURRENT but
    // its attempt loses the CAS (a same-value revision bump interferes); the retry re-proves and
    // observes the takeover — a stale first resolve never carries a later attempt.
    {
      let calls = 0;
      const statusKey = `goal.manager.u_abc.worker.${UID}.g-fence.status`;
      const resolver = async () => {
        calls++;
        if (calls === 1) {
          const cur = await readGoalStatus(ctx, rt);
          await updateRecordEntry(kv, statusKey, cur!.value, cur!.revision); // same value, new revision: the outer CAS loses; the retry stays legal
          return 2; // current at the FIRST attempt
        }
        return 3; // superseded by the time the retry proves again
      };
      await rejects("executor currency is re-proven for EVERY CAS attempt (a takeover between attempts refuses on the retry, never commits on a stale first resolve)",
        () => transitionGoal(ctx, rt, "waiting", { executor: { lifecycleUid: TARGET.lifecycleUid, epoch: 2 }, resolveCurrentEpoch: resolver }), "expired");
      c("…and the resolver ran once per attempt (two attempts, two proofs)", calls === 2, calls);
    }
    // Owner authority is CONSTRUCTION-BOUND, never a raw flag: only a proof minted from THIS
    // context authorizes an owner-driven pause of a target-pinned goal.
    await rejects("a HAND-ASSEMBLED owner proof never authorizes",
      () => transitionGoal(ctx, rt, "waiting", { owner: { space: SPACE } as OwnerCommitProof }), "permission-denied");
    {
      const ctx2 = await actionContext(nc, SPACE);
      await rejects("an owner proof minted from ANOTHER context never authorizes here",
        () => transitionGoal(ctx, rt, "waiting", { owner: ownerCommitProof(ctx2) }), "permission-denied");
    }
    c("the owner's construction-bound proof pauses a target-pinned goal without executor currency",
      (await transitionGoal(ctx, rt, "waiting", { owner: ownerCommitProof(ctx) })).state === "waiting");
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
  const cancelCommit = await commitGoalResult(ctx, { ref: ref("g1"), now: NOW + 600, cause: "deny", denial: { kind: "owner", owner: ownerCommitProof(ctx) } });
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
    await bindGoal(ctx, ref("g-raw"), "sha256:rw");
    await createGoal(ctx, rr, specOf("sha256:rw"));
    await rejects("a `cancel` cause on a goal that is NOT cancelling refuses (no naked cancelled assertion)",
      () => commitGoalResult(ctx, { ref: rr, now: NOW, cause: "cancel" }), "failed-precondition");
    await rejects("a `readiness` cause on a goal with NO readiness bound refuses",
      () => commitGoalResult(ctx, { ref: rr, now: NOW + 999_999, cause: "readiness" }), "failed-precondition");
    await rejects("a completion with a non-succeeded/failed state refuses (the cause bounds the state)",
      () => commitGoalResult(ctx, { ref: rr, now: NOW, cause: "complete", state: "uncertain" as "succeeded" }), "failed-precondition");
    // The deny cause is never free: it commits only with its verified authoritative predicate.
    await rejects("a BARE deny cause refuses (any commit-seam holder could otherwise fail any accepted goal)",
      () => commitGoalResult(ctx, { ref: rr, now: NOW, cause: "deny" } as never), "failed-precondition");
    await rejects("a deny naming an UNKNOWN checkpoint refuses (hold-expired is verified against the arbiter, never asserted)",
      () => commitGoalResult(ctx, { ref: rr, now: NOW, cause: "deny", denial: { kind: "hold-expired", token: "ghost-token" } }), "failed-precondition");
    await rejects("a deny with a hand-assembled owner proof refuses",
      () => commitGoalResult(ctx, { ref: rr, now: NOW, cause: "deny", denial: { kind: "owner", owner: { space: SPACE } as OwnerCommitProof } }), "permission-denied");
  }

  // ── target-pinned completion currency + the target-pinned READINESS path (MEDIUM 4) ──
  {
    const rt = ref("g-target");
    await bindGoal(ctx, ref("g-target"), "sha256:tt");
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

  // ── H2 (epoch proof atomic with the commit CAS): the FENCING reads are LEADER-SERVED.
  //    transitionGoal's retry-loop status read (the CAS revision source, paired 1:1 with the
  //    epoch proof) and commitGoalResult's pre-proof spec read (which gates a create-only
  //    terminal CAS carrying no revision pin to catch a stale input later) must ride
  //    STREAM.MSG.GET against the leader. The probe observes the WIRE: an interposed
  //    connection records every records-KV STREAM.MSG.GET payload. HONESTY NOTE: on the
  //    CURRENT stack (@nats-io/kv 3.4.0, whose open path leaves `direct` off) plain kv.get
  //    ALSO rides STREAM.MSG.GET, so this probe cannot fail against the pre-H2 code today —
  //    it is the CANARY, not the revert-proof: the moment any client change honors the
  //    bucket's allow_direct and kv.get goes follower-servable, an unpinned fencing read
  //    disappears from this wire capture and the probe fails, which is exactly the silent
  //    regression H2 exists to make loud. The revert-proof for H2 is code-level (the fencing
  //    sites call readGoalStatusLeader/readGoalSpecLeader, never kv.get). ──
  {
    const observed: string[] = [];
    const observingNc = new Proxy(nc, {
      get(target, prop) {
        if (prop === "request") return (subj: string, payload?: Uint8Array, ...rest: unknown[]) => {
          if (typeof subj === "string" && subj.startsWith("$JS.API.STREAM.MSG.GET.KV_cotal_records_") && payload !== undefined)
            observed.push(new TextDecoder().decode(payload));
          return (target as unknown as { request: (...a: unknown[]) => unknown }).request(subj, payload, ...rest);
        };
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const octx = await actionContext(observingNc as never, SPACE);
    const rh = ref("g-h2fence");
    await bindGoal(octx, ref("g-h2fence"), "sha256:h2");
    await createGoal(octx, rh, specOf("sha256:h2", { target: TARGET }));
    observed.length = 0;
    await transitionGoal(octx, rh, "running", { executor: { lifecycleUid: TARGET.lifecycleUid, epoch: 3 }, resolveCurrentEpoch: () => 3 });
    c("transitionGoal's retry-loop status read rides the LEADER-SERVED STREAM.MSG.GET (H2: the CAS revision source is never a follower's answer)",
      observed.some((p) => p.includes("g-h2fence.status")));
    observed.length = 0;
    const done = await commitGoalResult(octx, { ref: rh, now: NOW + 50, cause: "complete", state: "succeeded", executor: { lifecycleUid: TARGET.lifecycleUid, epoch: 3 }, resolveCurrentEpoch: () => 3 });
    c("commitGoalResult's pre-proof spec read rides the LEADER-SERVED STREAM.MSG.GET (H2: the epoch proof's input comes from the leader)",
      done.won && observed.some((p) => p.includes("g-h2fence.spec")));
  }

  // ── MEDIUM 1: mid-flight ref mutation cannot split the commit ──
  {
    const rm = ref("g-mut");
    await bindGoal(ctx, ref("g-mut"), "sha256:mu");
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
    await kv.put(`goal.manager.u_abc.worker.${UID}.g-misprin.spec`, enc(JSON.stringify({ v: 1, goalId: "g-misprin", ...specOf("sha256:mp"), caller: { id: "u_evil.actor", lifecycleUid: UID } })));
    await rejects("a spec whose caller id does not name the subject's principal is garbled (identity-bound)", () => readGoalSpec(ctx, ref("g-misprin")), "internal");
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
  await bindGoal(ctx, ref("g2"), "sha256:cc");
  await createGoal(ctx, ref("g2"), specOf("sha256:cc", { readinessDeadlineMs: 30_000 }));
  await rejects("settleGoalUncertain BEFORE the persisted deadline refuses", () => settleGoalUncertain(ctx, { ref: ref("g2"), now: NOW + 29_999 }), "failed-precondition");
  c("past the deadline settleGoalUncertain settles `uncertain`", (await settleGoalUncertain(ctx, { ref: ref("g2"), now: NOW + 30_000 })).fact.state === "uncertain");
  await bindGoal(ctx, ref("g3"), "sha256:dd");
  await createGoal(ctx, ref("g3"), specOf("sha256:dd", { readinessDeadlineMs: 30_000 }));
  await commitGoalResult(ctx, { ref: ref("g3"), now: NOW + 29_000, cause: "complete", state: "succeeded" });
  c("a success that committed FIRST wins; the due settle observes it", (await settleGoalUncertain(ctx, { ref: ref("g3"), now: NOW + 30_001 })).fact.state === "succeeded");

  // ── the cached outcome completes the SAME authority chain: bind = spec = result ──
  {
    const rf = ref("g-ff");
    await bindGoal(ctx, rf, "sha256:ff");
    await createGoal(ctx, rf, specOf("sha256:ff"));
    const forged = { v: 1, goalId: "g-ff", fingerprint: "sha256:FOREIGN", state: "succeeded", outcomeDigest: contractDigest(null), ts: NOW };
    const h = headers(); h.set("Nats-Expected-Last-Subject-Sequence", "0");
    await js.publish(goalResultSubject(SPACE, rf), enc(JSON.stringify(forged)), { headers: h });
    await rejects("a recorded result whose fingerprint disagrees with the accepted spec is NEVER served as the cached outcome",
      () => resolveGoalSubmission(ctx, req, "g-ff", "sha256:ff"), "internal");
  }

  // ── §13.10 receipt emission (D9 part 2): inline at the commit, idempotent convergence, the
  //    reconciler backstop, and fail-closed wiring/chain ──
  {
    const kp = createUser();
    const store = await receiptStoreContext(nc, SPACE);
    const wiring: ReceiptEmissionWiring = { store, instance: { id: "u_mgr.manager", instanceId: "i".repeat(26), epoch: 2 }, signer: { keyId: "rcpt-1" }, keyPair: kp };
    const IN_D = contractDigest({ in: 1 });
    const OUT_D = contractDigest({ out: 1 });
    const ARGS = { image: "app:1" };
    const em = (x: unknown) => x as { outcome: string; receipt: Receipt; error?: EpEnvelopeError };
    let seqN = 100;
    // A durable acceptance at the goal's decision address, exactly as the canonicalizer records
    // it (parseDecisionFact validates the FULL shape on the emission read, so the fixture is a
    // real acceptance, not a shell).
    const acceptFixture = async (id: string, goalId: string, fingerprint: string): Promise<number> => {
      const sourceSeq = seqN++;
      const request = { v: 1, id, op: { endpoint: "manager", command: "deploy", inputDigest: IN_D, outputDigest: OUT_D }, class: "journal", replyExpected: false, deadlineMs: 5_000, goalId, args: ARGS, from: { id: "u_abc.worker", name: "w" } };
      const fact = { v: 1, id, decision: "accepted", fingerprint, request, caller: { id: "u_abc.worker", lifecycleUid: UID }, contractDigests: { input: IN_D, output: OUT_D }, authzDecision: { revision: 1, epoch: 1 }, route: "effects", sourceSeq, ts: NOW };
      const res = await publishFactCreateOnly(js, epfSubject(SPACE, "manager", ["dec", caller.owner, caller.actor, caller.uid, id]), enc(JSON.stringify(fact)));
      if (!res.won) throw new Error("acceptance fixture CAS lost");
      return sourceSeq;
    };
    const FP1 = contractDigest({ job: 1 });
    const FP2 = contractDigest({ job: 2 });
    const FP3 = contractDigest({ job: 3 });
    const FP4 = contractDigest({ job: 4 });
    const FP7 = contractDigest({ job: 7 });

    const r1 = ref("g-rcpt1");
    const s1 = await acceptFixture("req-rcpt1", "g-rcpt1", FP1);
    await bindGoal(ctx, r1, FP1);
    await createGoal(ctx, r1, specOf(FP1, { requestId: "req-rcpt1", sourceSeq: s1 }));
    const done1 = await commitGoalResult(ctx, { ref: r1, now: NOW + 5, cause: "complete", state: "succeeded", data: { deployed: true }, receipts: wiring });
    c("the commit emits the terminal's receipt INLINE: identity from the acceptance, outcome from the committed terminal",
      em(done1.receiptEmission).outcome === "emitted" && em(done1.receiptEmission).receipt.requestId === "req-rcpt1"
      && em(done1.receiptEmission).receipt.sourceSeq === s1 && em(done1.receiptEmission).receipt.command === "deploy"
      && em(done1.receiptEmission).receipt.argsDigest === contractDigest(ARGS)
      && em(done1.receiptEmission).receipt.outcome.ok === true && em(done1.receiptEmission).receipt.resultDigest === done1.fact.outcomeDigest);
    c("the emitted receipt is RECORDED at the execution's receipt subject (readable, not just returned)",
      (await readReceipt(store, { endpoint: "manager", caller, requestId: "req-rcpt1", sourceSeq: s1 }))?.sig === em(done1.receiptEmission).receipt.sig);
    const again = await commitGoalResult(ctx, { ref: r1, now: NOW + 99, cause: "complete", state: "succeeded", data: { deployed: true }, receipts: wiring });
    c("a repeat commit loses the terminal CAS and CONVERGES on the recorded receipt (a later clock, the same facts)",
      again.won === false && em(again.receiptEmission).outcome === "converged" && em(again.receiptEmission).receipt.sig === em(done1.receiptEmission).receipt.sig);
    const rec1 = await reconcileReceiptEmission(ctx, wiring, { ref: r1, now: NOW + 500 });
    c("the reconciler on an already-emitted goal converges (a post-crash re-mint adopts the recorded receipt)",
      rec1.outcome === "converged" && em(rec1).receipt.sig === em(done1.receiptEmission).receipt.sig);

    const r2 = ref("g-rcpt2");
    const s2 = await acceptFixture("req-rcpt2", "g-rcpt2", FP2);
    await createGoal(ctx, r2, specOf(FP2, { requestId: "req-rcpt2", sourceSeq: s2 }));
    const done2 = await commitGoalResult(ctx, { ref: r2, now: NOW + 5, cause: "complete", state: "failed", data: { err: "boom" } });
    c("a commit WITHOUT wiring emits nothing (the omitted-emission window the reconciler exists for)",
      done2.receiptEmission === undefined && (await readReceipt(store, { endpoint: "manager", caller, requestId: "req-rcpt2", sourceSeq: s2 })) === undefined);
    const rec2 = await reconcileReceiptEmission(ctx, wiring, { ref: r2, now: NOW + 900 });
    c("the reconciler is the MUST-emit backstop: it re-derives the receipt from the two facts alone; a FAILED terminal attests ok:false code:'failed'",
      rec2.outcome === "emitted" && em(rec2).receipt.outcome.ok === false && em(rec2).receipt.outcome.code === "failed"
      && em(rec2).receipt.resultDigest === done2.fact.outcomeDigest);

    const r3 = ref("g-rcpt3");
    const s3 = await acceptFixture("req-rcpt3", "g-rcpt3", FP3);
    await createGoal(ctx, r3, specOf(FP3, { requestId: "req-rcpt3", sourceSeq: s3 }));
    c("the reconciler on a non-terminal goal is `no-terminal` (nothing to attest, nothing minted)",
      (await reconcileReceiptEmission(ctx, wiring, { ref: r3, now: NOW })).outcome === "no-terminal");

    const r4 = ref("g-rcpt4");
    const s4 = await acceptFixture("req-rcpt4", "g-rcpt4", FP4);
    await createGoal(ctx, r4, specOf(FP4, { requestId: "req-rcpt4", sourceSeq: s4 }));
    // A buggy or malicious emitter records a SUCCESS receipt before the goal actually fails:
    // the forged-attestation class CF-1 closes must refuse on every emission path, never adopt.
    const forged = mintReceipt({
      ref: { endpoint: "manager", caller, requestId: "req-rcpt4", sourceSeq: s4 }, space: SPACE, command: "deploy",
      instance: wiring.instance, caller: { id: "u_abc.worker", lifecycleUid: UID }, schemaDigests: { input: IN_D, output: OUT_D },
      args: ARGS, outcome: { ok: true }, result: { forged: true }, ts: NOW, signer: { keyId: "rcpt-1" },
    }, kp);
    await publishReceipt(store, { endpoint: "manager", caller, requestId: "req-rcpt4", sourceSeq: s4 }, forged);
    const done4 = await commitGoalResult(ctx, { ref: r4, now: NOW + 5, cause: "complete", state: "failed", receipts: wiring });
    c("a recorded receipt that DISAGREES with the committed facts is NEVER adopted: the commit stands, the emission surfaces `conflict`",
      done4.fact.state === "failed" && em(done4.receiptEmission).outcome === "failed" && em(done4.receiptEmission).error?.code === "conflict");
    await rejects("…and the reconciler refuses the same forgery loudly (no silent convergence on a disagreeing receipt)",
      () => reconcileReceiptEmission(ctx, wiring, { ref: r4, now: NOW + 10 }), "conflict");

    const r5 = ref("g-rcpt5");
    await createGoal(ctx, r5, specOf(FP1, { requestId: "req-ghost", sourceSeq: 9_999 }));
    const done5 = await commitGoalResult(ctx, { ref: r5, now: NOW + 5, cause: "complete", state: "succeeded", receipts: wiring });
    c("a MISSING durable acceptance surfaces as a failed emission (failed-precondition) and never masks the committed terminal",
      done5.fact.state === "succeeded" && em(done5.receiptEmission).outcome === "failed" && em(done5.receiptEmission).error?.code === "failed-precondition");

    const r6 = ref("g-rcpt6");
    await createGoal(ctx, r6, specOf(contractDigest({ job: "other" }), { requestId: "req-rcpt1", sourceSeq: s1 }));
    await commitGoalResult(ctx, { ref: r6, now: NOW + 5, cause: "complete", state: "succeeded" });
    await rejects("an acceptance that is NOT the one this goal was created from never mints (the chain proves id + sourceSeq + fingerprint, not merely SOME fact on the subject)",
      () => reconcileReceiptEmission(ctx, wiring, { ref: r6, now: NOW + 10 }), "internal");

    // CF-2 HIGH 2 (security/critic/fact): createGoal takes a caller-supplied fingerprint, so a
    // goal PLANTED with another goal's fingerprint + requestId + sourceSeq + command passes every
    // chain field EXCEPT the acceptance's embedded request.goalId - which the fingerprint binds
    // and a plant cannot forge. req-rcpt1's acceptance embeds goalId "g-rcpt1"; a goal named
    // "g-plant" carrying it must never borrow that receipt.
    const rplant = ref("g-plant");
    await createGoal(ctx, rplant, specOf(FP1, { requestId: "req-rcpt1", sourceSeq: s1 }));
    await commitGoalResult(ctx, { ref: rplant, now: NOW + 5, cause: "complete", state: "succeeded" });
    await rejects("a goal PLANTED with a foreign goal's fingerprint/requestId/sourceSeq never mints its receipt (the acceptance's embedded goalId is the discriminator a plant cannot forge)",
      () => reconcileReceiptEmission(ctx, wiring, { ref: rplant, now: NOW + 10 }), "internal");

    const r7 = ref("g-rcpt7");
    const s7 = await acceptFixture("req-rcpt7", "g-rcpt7", FP7);
    await createGoal(ctx, r7, specOf(FP7, { requestId: "req-rcpt7", sourceSeq: s7 }));
    const foreignStore = await receiptStoreContext(nc, "epactother");
    await rejects("CROSS-SPACE wiring refuses at ENTRY (failed-precondition), before any terminal commits against it",
      () => commitGoalResult(ctx, { ref: r7, now: NOW, cause: "complete", state: "succeeded", receipts: { ...wiring, store: foreignStore } }), "failed-precondition");
    c("…and the refused commit left NO terminal (a wiring error is an entry refusal, not a post-commit emission failure)",
      (await readGoalResult(ctx, r7)) === undefined);
    await rejects("a HAND-ASSEMBLED store context never authorizes emission (the store brand is constructed, not asserted)",
      () => commitGoalResult(ctx, { ref: r7, now: NOW, cause: "complete", state: "succeeded", receipts: { ...wiring, store: { space: SPACE } as ReceiptStoreContext } }), "failed-precondition");
    // CF-2 HIGH 3 (security/fact): the store must derive from THIS context's OWN connection - a
    // SAME-SPACE store on a DIFFERENT connection (a fortiori a different broker) passes the
    // string-space compare yet publishes onto another connection's streams. The bond is
    // connection IDENTITY, never a name.
    const nc2 = await connect({ servers: `nats://127.0.0.1:${PORT}` });
    const sameSpaceOtherConn = await receiptStoreContext(nc2, SPACE);
    await rejects("a SAME-SPACE store on a DIFFERENT connection refuses at ENTRY (the one-connection bond is identity, not a space-string match)",
      () => commitGoalResult(ctx, { ref: r7, now: NOW, cause: "complete", state: "succeeded", receipts: { ...wiring, store: sameSpaceOtherConn } }), "failed-precondition");
    c("…and that refused cross-connection commit ALSO left no terminal",
      (await readGoalResult(ctx, r7)) === undefined);
    await nc2.close();
  }

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
  // Settle on every path the broker can take, including ALREADY-EXITED. Attaching once("exit")
  // only after kill races: under load the child can fully exit before the listener is armed, the
  // promise never settles, and tsx exits 13 with "Detected unsettled top-level await" after every
  // assertion has already passed (reproduced: forced already-exited path → exit 13 + same warning).
  await new Promise<void>((resolve) => {
    if (broker.exitCode !== null || broker.signalCode !== null) return resolve();
    const done = () => resolve();
    broker.once("exit", done);
    broker.once("error", done);
    // Re-check after arming: exit may have fired between the null test and once().
    if (broker.exitCode !== null || broker.signalCode !== null) resolve();
  });
  rmSync(sd, { recursive: true, force: true });
}

console.log(`\nENDPOINT ACTION SMOKE ${fail === 0 ? "OK ✅ " : "FAILED ❌ "} (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
