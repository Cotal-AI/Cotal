/**
 * `turn` on the real planes: the manager's turn RELAY, submitted under the step's own identity.
 *
 * The load-bearing properties, one block each: the goalId is the request id and the acceptance
 * floor binds before the terminal wait (spawn's recovery discipline, so a resumed run re-attaches
 * instead of re-relaying); the seat's context — every unconsumed notice addressed to it — rides
 * the submission as one durable payload and is consumed BY the goal that carried it; the deadline
 * is double-covered and the client's own armed pause is the L4003 authority that outlives a dead
 * manager; seat death is L4002 whether the manager said so (the reap terminal) or presence did
 * (the client's own watch); a handoff yield resolves against the run roster (L4005 outside it,
 * L4004 across worktrees) and honoring one — the next turn in the scope targeting its `to` —
 * links the goal chain and moves the run record's conversation owner, most-recent-per-scope,
 * with ambiguity recording nothing.
 *
 * The far side is a suite-served MANAGER-SHAPED goal endpoint built from core primitives (the
 * runtime never imports `@cotal-ai/manager`); the real-manager fidelity ride is bin/smoke's. The
 * suite scripts each turn's terminal — it IS the seat's yield, reduced to the fact the client
 * reads back.
 *
 * Run: pnpm smoke:runtime-mesh-turn   (needs nats-server on PATH)
 */
import { spawn as spawnProc } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  createEndpointStreams,
  createSpaceStreams,
  openRecordsBucket,
  timerWriterContext,
  timerWriterConsumerConfig,
  timerWriterDurable,
  armCheckpointTimer,
  eptReqStreamName,
  presenceBucket,
  readCheckpointSettle,
  compileContract,
  contractDigest,
  contractStoreContext,
  publishContractArtifact,
  contractArtifactCanonicalBytes,
  epAuthBucket,
  serveIssuanceGateKv,
  provisionEndpointGateOpen,
  endpointRegistrationBarrier,
  registerServiceInstance,
  authorizeServeGrant,
  serveEndpoint,
  actionContext,
  bindGoal,
  createGoal,
  commitGoalResult,
  mintCheckpoint,
  expireCheckpoint,
  goalRefOf,
  submissionFingerprint,
  writeRunNotice,
  readRunNotice,
  createRunSpec,
  writeRunStatus,
  readRunRecord,
  replayRunJournal,
  newTakeoverId,
  EpEnvelopeError,
  type EpCommandDef,
  type EpServeContext,
  type EpCaller,
  type GoalRef,
  type Presence,
} from "@cotal-ai/core";
import { Cancelled, EffectError, type JournalEntry } from "@cotal-ai/lang";
import { MeshHandler, EpfSettleWatcher, startRun } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "meshturn";
const EP = "manager";
const MGR_IID = "m".repeat(26);
const HOLDER = { id: "manager", lifecycleUid: "u_meshturn" };
const CALLER: EpCaller = { owner: "local", actor: "wf_meshturn", uid: "a".repeat(26) };

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withDeadline = async <T>(p: Promise<T>, ms: number, what: string): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); });
  try {
    const got = await Promise.race([p.then((v) => ({ v })), late]);
    if (got === undefined) { fail++; console.log(`  ✗ FAIL: ${what} did not end within ${ms}ms`); return undefined; }
    return got.v;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
/** Grade a rejection as a value rather than a process kill (the bare-call trap). */
const safe = (p: Promise<unknown>): Promise<unknown> =>
  p.catch((e: unknown) => ({ threw: true, name: (e as Error)?.name, code: (e as { code?: string })?.code, kind: (e as { kind?: string })?.kind, message: (e as Error)?.message ?? String(e) }));

// ── broker + planes ────────────────────────────────────────────────────────────────────────────
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-meshturn-"));
const broker = spawnProc("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);
let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
const js = jetstream(nc);
const jsm = await jetstreamManager(nc);
await createEndpointStreams(jsm, new Kvm(nc), SPACE);
await createSpaceStreams(jsm, SPACE);
const kv = await openRecordsBucket(nc, SPACE);
// The liveness registry the client's own death watch reads. The suite provisions it without a
// TTL, so a row lives until deleted — death is the suite's explicit delete, never decay.
const presenceKv = await new Kvm(nc).create(presenceBucket(SPACE));

// The timer pump: the client's own deadline pause rides the mediated timer plane, and no delivery
// daemon runs here. Drain WIDE before a block that needs its own arm.
await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
const wctx = await timerWriterContext(nc, SPACE);
const armPending = async (expect = 4): Promise<void> => {
  for await (const m of await writerC.fetch({ max_messages: expect, expires: 1_200 })) {
    await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
    m.ack();
  }
};

// ── the suite-served manager-shaped goal endpoint (spawn + turn) ───────────────────────────────
const SPAWN_INPUT = {
  type: "object", additionalProperties: false, required: ["name"],
  properties: {
    name: { type: "string", minLength: 1 }, agent: { type: "string" }, role: { type: "string" },
    model: { type: "string" }, variant: { type: "string" },
    subscribe: { type: "array", items: { type: "string" } },
  },
} as const;
const SPAWN_OUTPUT = {
  type: "object", additionalProperties: false,
  required: ["name", "owner", "actor", "uid", "goalId", "fingerprint", "executor"],
  properties: {
    name: { type: "string" }, owner: { type: "string" }, actor: { type: "string" }, uid: { type: "string" },
    goalId: { type: "string" }, fingerprint: { type: "string" }, readinessDeadlineMs: { type: "integer", minimum: 1 },
    executor: {
      type: "object", additionalProperties: false, required: ["lifecycleUid", "epoch"],
      properties: { lifecycleUid: { type: "string" }, epoch: { type: "integer", minimum: 0 } },
    },
  },
} as const;
const TURN_INPUT = {
  type: "object", additionalProperties: false, required: ["payload", "deadlineMs"],
  properties: {
    payload: { type: "string", minLength: 1, maxLength: 65536 },
    deadlineMs: { type: "integer", minimum: 1 },
    handoffFrom: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;
const TURN_OUTPUT = {
  type: "object", additionalProperties: false,
  required: ["name", "owner", "actor", "uid", "goalId", "fingerprint", "deadlineAt", "executor"],
  properties: {
    name: { type: "string" }, owner: { type: "string" }, actor: { type: "string" }, uid: { type: "string" },
    goalId: { type: "string" }, fingerprint: { type: "string" }, deadlineAt: { type: "integer", minimum: 1 },
    executor: {
      type: "object", additionalProperties: false, required: ["lifecycleUid", "epoch"],
      properties: { lifecycleUid: { type: "string" }, epoch: { type: "integer", minimum: 0 } },
    },
  },
} as const;

const cc = (root: unknown) => compileContract({ root: root as Record<string, unknown> });
const COMPILED = {
  spawn: { input: cc(SPAWN_INPUT), output: cc(SPAWN_OUTPUT) },
  turn: { input: cc(TURN_INPUT), output: cc(TURN_OUTPUT) },
};
const DOCUMENT = {
  urn: "ai.cotal.test.turnmgr", revision: 1, attributes: [], events: [],
  commands: [
    { name: "spawn", class: "ephemeral" as const, targeted: false, capability: "manager.spawn", inputDigest: COMPILED.spawn.input.closureDigest, outputDigest: COMPILED.spawn.output.closureDigest },
    { name: "turn", class: "ephemeral" as const, targeted: true, modes: ["owner", "any"], capability: "manager.lifecycle", inputDigest: COMPILED.turn.input.closureDigest, outputDigest: COMPILED.turn.output.closureDigest },
  ],
};
const ROOT_DIGEST = contractDigest(DOCUMENT);
const MANIFEST = { v: 1 as const, root: ROOT_DIGEST, members: [] as string[] };
const CLOSURE_DIGEST = contractDigest(MANIFEST);

const store = await contractStoreContext(nc, SPACE);
const artifactIndex = new Map<string, unknown>();
{
  const values: unknown[] = [];
  const seen = new Set<string>();
  for (const source of [SPAWN_INPUT, SPAWN_OUTPUT, TURN_INPUT, TURN_OUTPUT]) {
    const rootDigest = contractDigest(source);
    if (seen.has(rootDigest)) continue;
    seen.add(rootDigest);
    values.push(source, { v: 1, root: rootDigest, members: [] });
  }
  values.push(DOCUMENT, MANIFEST);
  for (const v of values) {
    artifactIndex.set(contractDigest(v), v);
    await publishContractArtifact(store, contractArtifactCanonicalBytes(v));
  }
}
const readClusterArtifact = (digest: string): unknown => artifactIndex.get(digest);
const authKv = await new Kvm(nc).open(epAuthBucket(SPACE));
const fence = serveIssuanceGateKv(authKv, SPACE, { endpoint: EP, instanceId: MGR_IID });
await provisionEndpointGateOpen(authKv, { endpoint: EP, instanceId: MGR_IID, principal: "local.mgr" });
const authority = { authorize: (endpoint: string, owner: string) => ({ authorized: endpoint === EP && owner === "local", revision: 0 }) };
const barrier = endpointRegistrationBarrier(authKv, SPACE, { endpoint: EP, instanceId: MGR_IID, opId: MGR_IID });
await registerServiceInstance(kv, {
  space: SPACE,
  spec: { endpoint: EP, owner: "local", clusterDigests: [CLOSURE_DIGEST], protocol: { v: 1 } },
  instanceId: MGR_IID, registrant: { owner: "local" }, authority, barrier, readClusterArtifact,
});
const observed = await fence.observe();
if (observed === null) throw new Error("the suite endpoint's issuance gate vanished after registration");
const EXEC_EPOCH = observed.processEpoch;
const grant = await authorizeServeGrant(kv, {
  space: SPACE, endpoint: EP, instanceId: MGR_IID, epoch: EXEC_EPOCH,
  holder: { owner: "local" }, authority, readProcessEpoch: () => EXEC_EPOCH, readClusterArtifact,
});

// The fake manager's book-keeping — what the cells read.
const goalCtx = await actionContext(nc, SPACE);
const spawnAccepts = new Map<string, Record<string, unknown>>();
const allocations: Array<{ goalId: string; name: string; owner: string; actor: string; uid: string; persona: string }> = [];
const mappings = new Map<string, { lifecycleUid: string; mappingRevision: number }>();
const putPresence = async (name: string, u: string, principal: string): Promise<void> => {
  const row: Presence = { card: { id: principal, name, kind: "agent" }, lifecycleUid: u, status: "idle", ts: Date.now() };
  await presenceKv.put(principal, JSON.stringify(row));
};
let seat = 0;
const terminals: Promise<void>[] = [];

const spawnHandler = async (ctx: EpServeContext): Promise<unknown> => {
  const args = (ctx.request.args ?? {}) as Record<string, unknown>;
  const persona = String(args.name);
  const goalId = ctx.request.id;
  const { fingerprint } = submissionFingerprint(ctx.request as unknown, ctx.subject);
  const prior = spawnAccepts.get(goalId);
  if (prior !== undefined) {
    if (prior.fingerprint !== fingerprint) throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted under a different submission (SPEC 13.6)`);
    return prior;
  }
  const ref = goalRefOf(ctx.subject, goalId);
  const b = await bindGoal(goalCtx, ref, fingerprint);
  if (!b.bound) throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already bound (SPEC 13.6)`);
  await createGoal(goalCtx, ref, {
    fingerprint, command: "spawn",
    caller: { id: `${ctx.subject.caller.owner}.${ctx.subject.caller.actor}`, lifecycleUid: ctx.subject.caller.uid },
    acceptedEpoch: EXEC_EPOCH, requestId: goalId, sourceSeq: 0, acceptedAt: Date.now(), readinessDeadlineMs: 30_000,
  });
  seat += 1;
  const name = `${persona}-${seat}`;
  const actor = `seat${seat}`;
  const uid = `s${String(seat).padStart(25, "0")}`;
  allocations.push({ goalId, name, owner: "local", actor, uid, persona });
  mappings.set(`local.${actor}`, { lifecycleUid: uid, mappingRevision: 1 });
  const acceptance = {
    name, owner: "local", actor, uid, goalId, fingerprint, readinessDeadlineMs: 30_000,
    executor: { lifecycleUid: MGR_IID, epoch: EXEC_EPOCH },
  };
  spawnAccepts.set(goalId, acceptance);
  terminals.push((async () => {
    await putPresence(name, uid, `local.${actor}`);
    await commitGoalResult(goalCtx, { ref, now: Date.now(), cause: "complete", state: "succeeded", data: { name, agent: "claude", id: `local.${actor}`, mode: "pty", lifecycleUid: uid }, committer: { instanceId: MGR_IID, epoch: EXEC_EPOCH } });
  })().catch((e) => { console.log("  ! fake spawn terminal failed:", (e as Error).message); }));
  return acceptance;
};

/** One relayed turn's scripted ENDING, in the REAL terminal shapes a relay can commit: a yield is
 *  a `complete succeeded` proving the SEAT's live executor currency (the goal is target-pinned),
 *  and a deadline is a DENY over the goal-bound hold's recorded expired settle — there is no
 *  complete-failed arm at all, because a dead target has no honest early terminal (SPEC 13.6
 *  item 7). An empty queue scripts NO ending (the deadline and death cells need a turn nobody
 *  answers). */
type TurnEnding =
  | { state: "succeeded"; status: "done" | "blocked" | "handoff"; to?: string; note?: string; delayMs?: number }
  | { state: "deadline"; delayMs?: number; agentDownAt?: number };
const turnEndings: TurnEnding[] = [];
const turnAccepts = new Map<string, Record<string, unknown>>();
/** Scripted faults for the NEXT turn invokes, one per invoke, in order. `entry` throws before the
 *  goal plane is touched (the shape a serve boundary refusing a dead target produces); `afterGoal`
 *  throws once the goal record exists, which is the lost-reply shape the client re-submits over. */
const turnFaults: Array<{ where: "entry"; err: Error } | { where: "hang" }> = [];
const turnInvokes: Array<{ goalId: string; payload: string; deadlineMs: number; handoffFrom?: string; target: { owner: string; actor: string; lifecycleUid: string } }> = [];

const turnHandler = async (ctx: EpServeContext): Promise<unknown> => {
  const args = (ctx.request.args ?? {}) as Record<string, unknown>;
  const goalId = ctx.request.id;
  const t = ctx.request.target as { owner: string; actor: string; lifecycleUid: string };
  turnInvokes.push({
    goalId, payload: String(args.payload), deadlineMs: Number(args.deadlineMs),
    ...(args.handoffFrom !== undefined ? { handoffFrom: String(args.handoffFrom) } : {}),
    target: { owner: t.owner, actor: t.actor, lifecycleUid: t.lifecycleUid },
  });
  const fault = turnFaults.shift();
  if (fault?.where === "entry") throw fault.err;
  const { fingerprint } = submissionFingerprint(ctx.request as unknown, ctx.subject);
  const prior = turnAccepts.get(goalId);
  if (prior !== undefined) {
    if (prior.fingerprint !== fingerprint) throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted under a different submission (SPEC 13.6)`);
    return prior;
  }
  const alloc = allocations.find((a) => a.owner === t.owner && a.actor === t.actor && a.uid === t.lifecycleUid);
  const name = alloc?.name ?? `${t.owner}.${t.actor}`;
  // The hold instant is the manager's, read at accept BEFORE the goal-plane writes and the reply;
  // a client that read its own clock after the round-trip could not coincide with it.
  const heldAt = Date.now();
  const ref = goalRefOf(ctx.subject, goalId);
  const b = await bindGoal(goalCtx, ref, fingerprint);
  if (!b.bound) throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already bound (SPEC 13.6)`);
  const deadlineMs = Number(args.deadlineMs);
  await createGoal(goalCtx, ref, {
    fingerprint, command: "turn",
    caller: { id: `${ctx.subject.caller.owner}.${ctx.subject.caller.actor}`, lifecycleUid: ctx.subject.caller.uid },
    acceptedEpoch: EXEC_EPOCH, requestId: goalId, sourceSeq: 0, acceptedAt: Date.now(), readinessDeadlineMs: deadlineMs,
    target: { owner: t.owner, actor: t.actor, lifecycleUid: t.lifecycleUid, mappingRevision: 1 },
  });
  // The lost reply: the goal record is written and the caller is not answered until after its own
  // accept deadline (TURN_ACCEPT_DEADLINE_MS, 30s), which is the one shape that sends the client
  // back for its own acceptance. Bounded rather than forever, because this endpoint serves one
  // request at a time and the re-read has to be served after it.
  if (fault?.where === "hang") await wait(33_000);
  const acceptance = {
    name, owner: t.owner, actor: t.actor, uid: t.lifecycleUid, goalId, fingerprint,
    deadlineAt: heldAt + deadlineMs, executor: { lifecycleUid: MGR_IID, epoch: EXEC_EPOCH },
  };
  turnAccepts.set(goalId, acceptance);
  await wait(10);
  const ending = turnEndings.shift();
  const handoffFrom = args.handoffFrom !== undefined ? String(args.handoffFrom) : undefined;
  const runCaller = { owner: ctx.subject.caller.owner, actor: ctx.subject.caller.actor, uid: ctx.subject.caller.uid };
  if (ending !== undefined) {
    terminals.push((async () => {
      if (ending.delayMs !== undefined) await wait(ending.delayMs);
      if (ending.state === "succeeded") {
        const data = { status: ending.status, ...(ending.to !== undefined ? { to: ending.to } : {}), ...(ending.note !== undefined ? { note: ending.note } : {}), ...(handoffFrom !== undefined ? { handoffFrom } : {}), at: Date.now() };
        await commitGoalResult(goalCtx, {
          ref, now: Date.now(), cause: "complete", state: "succeeded", data,
          committer: { instanceId: MGR_IID, epoch: EXEC_EPOCH },
          executor: { lifecycleUid: t.lifecycleUid, epoch: 0 },
          resolveCurrentEpoch: () => 0,
        });
        return;
      }
      // The deadline, in the real shape: a goal-bound hold, owner-expired once due, then the deny
      // whose predicate core verifies against that recorded settle.
      const holdRef = { endpoint: EP, token: `${goalId.slice(0, 42)}h` };
      const mintedAt = Date.now();
      await mintCheckpoint(kv, js, SPACE, {
        ref: holdRef, instanceId: MGR_IID, epoch: EXEC_EPOCH,
        goal: { caller: runCaller, goalId },
        holder: { id: "fakemgr", lifecycleUid: MGR_IID },
        deadline: mintedAt + 150, now: mintedAt,
      });
      await wait(250);
      await expireCheckpoint(kv, js, jsm, SPACE, { ref: holdRef, now: Date.now() });
      await commitGoalResult(goalCtx, {
        ref, now: Date.now(), cause: "deny", denial: { kind: "hold-expired", token: holdRef.token },
        data: { reason: "turn-deadline", ...(handoffFrom !== undefined ? { handoffFrom } : {}), ...(ending.agentDownAt !== undefined ? { agentDownAt: ending.agentDownAt } : {}) },
        committer: { instanceId: MGR_IID, epoch: EXEC_EPOCH },
      });
    })().catch((e) => { console.log("  ! fake turn terminal failed:", (e as Error).message); }));
  }
  return acceptance;
};

const defs: EpCommandDef[] = [
  { command: "spawn", contract: COMPILED.spawn, handler: spawnHandler },
  { command: "turn", contract: COMPILED.turn, handler: turnHandler },
];
const serve = serveEndpoint(nc, SPACE, grant, defs, { public: true }, {
  resolveTarget: (t) => mappings.get(`${t.owner}.${t.actor}`),
});

const mk = (runId: string): MeshHandler => new MeshHandler(
  nc, kv, js, jsm,
  { space: SPACE, endpoint: EP, runId, caller: CALLER, instanceId: "i".repeat(26), epoch: 1, holder: HOLDER, defaultCheckpointTimeout: "1h" },
  new EpfSettleWatcher(js, jsm, SPACE, 3_000),
  () => Date.now(),
);
const stepCtx = (requestId: string, opts: { resume?: Record<string, unknown>; key?: Record<string, unknown> } = {}) => {
  const listeners: ((reason: string) => void)[] = [];
  const signal = {
    cancelled: false, reason: undefined as string | undefined,
    onCancel(fn: (reason: string) => void) { listeners.push(fn); },
  };
  const bound: Record<string, unknown> = {};
  const ctx = {
    key: opts.key ?? { scope: [], kind: "turn", name: "", occurrence: 0 },
    requestId, attempt: 0, signal,
    ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
    bind: async (facts: Record<string, unknown>) => { Object.assign(bound, facts); },
  };
  return {
    ctx: ctx as never,
    bound,
    cancel(reason: string) { signal.cancelled = true; signal.reason = reason; for (const fn of listeners) fn(reason); },
  };
};
const token = (tag: string) => (tag.repeat(43)).slice(0, 43);
const lease = (() => { let n = 0; return () => ({ holder: "m1", epoch: 1, fencingToken: (n += 1), takeoverId: newTakeoverId() }); })();
const driven = (args: Parameters<typeof startRun>[2]) =>
  startRun(js, jsm, args).catch((e: unknown) => ({ status: "threw" as const, error: `${(e as Error)?.name}: ${(e as Error)?.message?.slice(0, 140)}` }));
const journalEntries = async (runId: string, kind: string): Promise<JournalEntry[]> => {
  const back = await replayRunJournal(js, jsm, SPACE, runId, newTakeoverId());
  return back.records
    .map((r) => r.record)
    .filter((r) => r.kind === "step")
    .map((r) => (r as { entry: unknown }).entry as JournalEntry)
    .filter((e) => e.kind === kind);
};
/** Spawn one seat through the handler under test, so the roster registration is the real path. */
const spawnSeat = async (handler: MeshHandler, tag: string, persona = "builder"): Promise<{ agent: string; persona: string } | undefined> => {
  const got = await withDeadline(safe(handler.spawn({ persona }, stepCtx(token(tag)).ctx)), 20_000, `the ${persona} spawn`);
  if (got !== undefined && typeof (got as { agent?: unknown }).agent === "string") return got as { agent: string; persona: string };
  console.log("  ! spawn did not yield a handle:", JSON.stringify(got));
  return undefined;
};
const isTurnResult = (v: unknown): v is { status: string; to?: { agent: string }; note?: string; at: number } =>
  v !== null && typeof v === "object" && typeof (v as { status?: unknown }).status === "string" && typeof (v as { at?: unknown }).at === "number";

// ── 1) a driven program turns end to end: the done yield ─────────────────────────────────────
{
  console.log("• 1 — a driven program turns its agent end to end");
  turnEndings.push({ state: "succeeded", status: "done", delayMs: 400 });
  const out = await withDeadline(driven({
    space: SPACE, endpoint: EP, kv, runId: "tn-1", lease: lease(),
    source: `const b = await spawn("builder");\nconst r = await turn(b, { name: "build", deadline: "5m" });\nlog("turned", r.status);`,
    handler: mk("tn-1"),
  }), 30_000, "the turning run");
  c("the run completes through the real relay accept and the real terminal", out?.status === "completed", JSON.stringify(out));
  const entries = await journalEntries("tn-1", "turn");
  const pending = entries.filter((e) => e.state === "pending").at(-1);
  const settled = entries.find((e) => e.state === "settled");
  const inv = turnInvokes[0];
  c("the turn goal was bound under the step's own request id: the envelope id IS the goalId",
    inv !== undefined && pending?.requestId === inv.goalId, { requestId: pending?.requestId, goalId: inv?.goalId });
  c("the acceptance floor and deadline are bound as the entry's external state before the wait",
    pending?.external?.goalId === pending?.requestId
      && typeof pending?.external?.deadlineAt === "number"
      && typeof pending?.external?.name === "string"
      && typeof pending?.external?.owner === "string"
      && typeof pending?.external?.actor === "string"
      && Array.isArray(pending?.external?.noticeIds),
    JSON.stringify(pending?.external));
  c("the bound deadline is the acceptance's own instant (the manager's hold), not a second clock read before the round-trip",
    inv !== undefined && pending?.external?.deadlineAt === (turnAccepts.get(inv.goalId) as { deadlineAt?: unknown } | undefined)?.deadlineAt,
    { bound: pending?.external?.deadlineAt, served: (turnAccepts.get(inv?.goalId ?? "") as { deadlineAt?: unknown } | undefined)?.deadlineAt });
  c("the settled entry records the yield: status done, at stamped",
    settled?.status === "ok" && isTurnResult(settled.result) && settled.result.status === "done",
    JSON.stringify(settled?.result));
  const payload = inv === undefined ? undefined : JSON.parse(inv.payload) as { run?: unknown; step?: unknown; context?: unknown; noticeIds?: unknown };
  c("the submission's payload carries the run, the step, the rendered context and the notice ids",
    payload?.run === "tn-1" && typeof payload.step === "string" && String(payload.step).includes("turn:build")
      && typeof payload.context === "string" && String(payload.context).includes("<run-context")
      && Array.isArray(payload.noticeIds),
    JSON.stringify(payload));
  c("the target pins the spawned seat's own incarnation",
    inv !== undefined && allocations[0] !== undefined && inv.target.lifecycleUid === allocations[0].uid, JSON.stringify(inv?.target));
  const settle = inv === undefined ? undefined : await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: inv.goalId });
  c("the done yield claims the client's own armed deadline: the pause is settled", settle !== undefined, settle?.settle);
}

// ── 2) notices ride the payload and are consumed by the goal that carried them ────────────────
{
  console.log("• 2 — the seat's unconsumed notices ride the payload and are consumed by the turn");
  const handler = mk("tn-2");
  const a = await spawnSeat(handler, "b");
  if (a === undefined) { fail += 1; console.log("  ✗ FAIL: no seat to turn"); }
  else {
    await writeRunNotice(kv, EP, "n1".padEnd(20, "x"), {
      v: 1, run: "tn-2", addressee: a.agent, step: "/notify#0",
      fact: { decision: "release", outcome: "approved", detail: { tag: "v1" } }, at: Date.now(),
    });
    const T = token("c");
    turnEndings.push({ state: "succeeded", status: "done", delayMs: 300 });
    const before = turnInvokes.length;
    const got = await withDeadline(safe(handler.turn({ agent: a, deadline: "5m" }, stepCtx(T).ctx)), 20_000, "the noticed turn");
    c("the turn resolves done", isTurnResult(got) && got.status === "done", JSON.stringify(got));
    const inv = turnInvokes[before];
    const payload = inv === undefined ? undefined : JSON.parse(inv.payload) as { context?: string; noticeIds?: string[] };
    c("the rendered context carries the notice's decision and outcome",
      payload?.context !== undefined && payload.context.includes("release") && payload.context.includes("approved"),
      payload?.context);
    const nid = payload?.noticeIds?.[0];
    const read = nid === undefined ? undefined : await readRunNotice(kv, EP, "tn-2", a.agent, nid);
    c("the notice is consumed BY this goal after the yield",
      read?.consumed !== undefined && read.consumed.by === T, JSON.stringify(read?.consumed));
  }
}

// ── 3) an idempotent resubmission is served, never re-relayed ─────────────────────────────────
{
  console.log("• 3 — the same pinned id resubmitted is served the recorded acceptance");
  const handler = mk("tn-3");
  const a = await spawnSeat(handler, "d");
  if (a !== undefined) {
    const T = token("e");
    turnEndings.push({ state: "succeeded", status: "done", delayMs: 200 });
    const acceptsBefore = turnAccepts.size;
    const first = await withDeadline(safe(handler.turn({ agent: a, deadline: "5m" }, stepCtx(T).ctx)), 20_000, "the first submission");
    const again = await withDeadline(safe(handler.turn({ agent: a, deadline: "5m" }, stepCtx(T).ctx)), 20_000, "the resubmission");
    c("both submissions return the identical yield",
      isTurnResult(first) && isTurnResult(again) && first.status === "done" && again.status === "done" && first.at === again.at,
      { first: JSON.stringify(first), again: JSON.stringify(again) });
    c("the far side accepted once for two submissions",
      turnInvokes.filter((i) => i.goalId === T).length === 2 && turnAccepts.size === acceptsBefore + 1,
      { invokes: turnInvokes.filter((i) => i.goalId === T).length });
  }
}

// ── 4) a resume with the bound external state re-attaches without re-invoking ─────────────────
{
  console.log("• 4 — a resume with the bound state re-attaches to the pending relay");
  const handler = mk("tn-4");
  const a = await spawnSeat(handler, "f");
  if (a !== undefined) {
    const T = token("g");
    turnEndings.push({ state: "succeeded", status: "done", delayMs: 2_500 });
    const first = stepCtx(T);
    const firstP = safe(handler.turn({ agent: a, deadline: "5m" }, first.ctx));
    for (let i = 0; i < 100 && first.bound.goalId === undefined; i += 1) await wait(50);
    c("the external state is bound before the terminal wait", first.bound.goalId === T, JSON.stringify(first.bound));
    const invokesBefore = turnInvokes.length;
    const resumed = await withDeadline(safe(mk("tn-4").turn({ agent: a, deadline: "5m" }, stepCtx(T, { resume: { ...first.bound } }).ctx)), 20_000, "the resumed attempt");
    const original = await withDeadline(firstP, 20_000, "the original attempt");
    c("both attempts read the one recorded yield",
      isTurnResult(resumed) && isTurnResult(original) && resumed.status === "done" && original.status === "done",
      { resumed: JSON.stringify(resumed), original: JSON.stringify(original) });
    c("the resume sent NOTHING to the endpoint: the recorded acceptance is the submission",
      turnInvokes.length === invokesBefore, { extra: turnInvokes.length - invokesBefore });
  }
}

// ── 5) the client's own deadline authority: L4003 with nobody answering ───────────────────────
{
  console.log("• 5 — the deadline elapses with no yield: the client's own pause is the L4003 authority");
  const handler = mk("tn-5");
  const a = await spawnSeat(handler, "h");
  if (a !== undefined) {
    const T = token("i");
    // No scripted ending: the relay accepts and nobody ever yields.
    const p = safe(handler.turn({ agent: a, deadline: "3s" }, stepCtx(T).ctx));
    await wait(800);
    await armPending(24);
    const got = await withDeadline(p, 20_000, "the abandoned turn");
    c("the turn throws the effect's own L4003",
      (got as { code?: string })?.code === "L4003" && (got as { kind?: string })?.kind === "turn-deadline", JSON.stringify(got));
  }
}

// ── 6) the manager's deadline verdict maps to the same L4003 ──────────────────────────────────
{
  console.log("• 6 — a manager-committed turn-deadline failure is the same L4003");
  const handler = mk("tn-6");
  const a = await spawnSeat(handler, "j");
  if (a !== undefined) {
    const T = token("k");
    turnEndings.push({ state: "deadline", delayMs: 300 });
    const got = await withDeadline(safe(handler.turn({ agent: a, deadline: "5m" }, stepCtx(T).ctx)), 20_000, "the manager-expired turn");
    c("the deny's turn-deadline reason maps to L4003",
      (got as { code?: string })?.code === "L4003", JSON.stringify(got));
    const settle = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: T });
    c("the terminal claims the client's armed pause on the way out", settle !== undefined, settle?.settle);
  }
  // The relay marks a seat that died while the turn was outstanding on the deny it rides to
  // (`agentDownAt`): read here, before the client's own presence poll could notice, that death is
  // the agent-down failure, never a deadline the program could have set longer.
  const a2 = await spawnSeat(handler, "j2");
  if (a2 !== undefined) {
    const T2 = token("k2");
    turnEndings.push({ state: "deadline", delayMs: 300, agentDownAt: Date.now() });
    const got2 = await withDeadline(safe(handler.turn({ agent: a2, deadline: "5m" }, stepCtx(T2).ctx)), 20_000, "the deadline deny of a dead seat");
    c("a deny marked agentDownAt is the agent-down L4002, never the deadline",
      (got2 as { code?: string })?.code === "L4002" && (got2 as { kind?: string })?.kind === "turn"
        && String((got2 as { message?: string })?.message).includes("carries its death"),
      JSON.stringify(got2));
  }
}

// (There is deliberately NO manager agent-down terminal block: a dead target has no honest early
// goal ending — the deadline deny converges the plane, and the client's own presence watch, block
// 8, is the run's L4002 authority.)

// ── 8) the client's own death watch: presence gone, nobody commits, L4002 ─────────────────────
{
  console.log("• 8 — the seat's presence row vanishes with no terminal: the client's own watch is the L4002 authority");
  const handler = mk("tn-8");
  const a = await spawnSeat(handler, "n");
  if (a !== undefined) {
    const alloc = allocations.find((x) => `${x.name}#${x.uid}` === a.agent);
    const T = token("o");
    // No scripted ending, and the seat dies mid-wait: the manager (which would reap) says nothing.
    const p = safe(handler.turn({ agent: a, deadline: "5m" }, stepCtx(T).ctx));
    await wait(1_200);
    if (alloc !== undefined) await presenceKv.delete(`local.${alloc.actor}`);
    const got = await withDeadline(p, 20_000, "the orphaned turn");
    c("the client observes the death itself and throws L4002, naming the reason",
      (got as { code?: string })?.code === "L4002" && String((got as { message?: string })?.message).includes("lapsed"),
      JSON.stringify(got));
    const settle = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: T });
    c("the death claims the armed pause", settle !== undefined, settle?.settle);
  }
}

// ── 9) handoff honored: the roster resolves `to`, the link and the owner move ─────────────────
{
  console.log("• 9 — a handoff yield resolves to the roster handle; the next turn links the chain");
  const handler = mk("tn-9");
  const a = await spawnSeat(handler, "p");
  const b = await spawnSeat(handler, "q", "reviewer");
  await createRunSpec(kv, EP, "tn-9", { pins: { seed: "s", startedAt: 1, yieldEvery: 1, stepBudget: 100, effectCeiling: 100, languageVersion: "1" }, createdAt: Date.now() });
  await writeRunStatus(kv, EP, "tn-9", { observedSpecRevision: 1, state: "running", holder: "m1", epoch: 1, fencingToken: 1, journalHigh: 0, at: Date.now() });
  if (a !== undefined && b !== undefined) {
    const bName = b.agent.split("#")[0]!;
    const T1 = token("r");
    turnEndings.push({ state: "succeeded", status: "handoff", to: bName, note: "your tree now", delayMs: 300 });
    const got = await withDeadline(safe(handler.turn({ agent: a, deadline: "5m" }, stepCtx(T1).ctx)), 20_000, "the handing-off turn");
    c("the yield resolves `to` against the run roster, as the full handle",
      isTurnResult(got) && got.status === "handoff" && got.to?.agent === b.agent && got.note === "your tree now",
      JSON.stringify(got));
    const T2 = token("s");
    turnEndings.push({ state: "succeeded", status: "done", delayMs: 300 });
    const honored = await withDeadline(safe(handler.turn({ agent: b, deadline: "5m" }, stepCtx(T2).ctx)), 20_000, "the honoring turn");
    c("the honoring turn completes", isTurnResult(honored) && honored.status === "done", JSON.stringify(honored));
    const inv = turnInvokes.find((i) => i.goalId === T2);
    c("the honoring submission carries the goal-chain link: handoffFrom is the previous turn's goalId",
      inv?.handoffFrom === T1, JSON.stringify(inv));
    const settled = await readGoalResultData(T2);
    c("the manager mirrors the link into the terminal's own data",
      settled?.handoffFrom === T1, JSON.stringify(settled));
  }
}

// ── 10) a handoff outside the roster is L4005 ─────────────────────────────────────────────────
{
  console.log("• 10 — a handoff to an agent outside the run's roster is L4005");
  const handler = mk("tn-10");
  const a = await spawnSeat(handler, "t");
  if (a !== undefined) {
    turnEndings.push({ state: "succeeded", status: "handoff", to: "stranger", delayMs: 200 });
    const got = await withDeadline(safe(handler.turn({ agent: a, deadline: "5m" }, stepCtx(token("u")).ctx)), 20_000, "the stray handoff");
    c("the yield is refused as the effect's own L4005",
      (got as { code?: string })?.code === "L4005" && (got as { kind?: string })?.kind === "turn-handoff", JSON.stringify(got));
  }
}

// ── 11) a handoff across worktrees is L4004 ───────────────────────────────────────────────────
{
  console.log("• 11 — a handoff to an agent in a different worktree is L4004");
  const handler = mk("tn-11");
  // The worktree'd colleague enters through ADOPTION (spawn({worktree}) is still seam-refused):
  // a settled spawn entry whose recorded handle carries the worktree, exactly what a resumed run
  // replays. This also exercises the roster seeding an adopted run depends on.
  await handler.adopted([{
    v: 1, seq: 1, run: "tn-11", scope: "", kind: "spawn", name: "wt", occurrence: 0,
    inputHash: "sha256:0", requestId: token("v"), state: "settled", status: "ok",
    result: { agent: `treed-1#${"t".repeat(26)}`, persona: "builder", worktree: "wt-1" },
    external: { goalId: token("v"), name: "treed-1", owner: "local", actor: "treedseat", uid: "t".repeat(26) },
  } as unknown as JournalEntry]);
  const a = await spawnSeat(handler, "w");
  if (a !== undefined) {
    turnEndings.push({ state: "succeeded", status: "handoff", to: "treed-1", delayMs: 200 });
    const got = await withDeadline(safe(handler.turn({ agent: a, deadline: "5m" }, stepCtx(token("x")).ctx)), 20_000, "the cross-tree handoff");
    c("the yield is refused as the effect's own L4004",
      (got as { code?: string })?.code === "L4004" && String((got as { message?: string })?.message).includes("worktree"),
      JSON.stringify(got));
  }
}

// ── 12) the memo is spent at every begin; ambiguity records nothing ───────────────────────────
{
  console.log("• 12 — honoring is immediate-only and two same-name pending handoffs record nothing");
  const handler = mk("tn-12");
  const a = await spawnSeat(handler, "y");
  const b = await spawnSeat(handler, "z", "reviewer");
  const d = await spawnSeat(handler, "A", "tester");
  if (a !== undefined && b !== undefined && d !== undefined) {
    const bName = b.agent.split("#")[0]!;
    // Not-honored-immediately: a handoff to b, then a turn on d (not b) spends the memo.
    turnEndings.push({ state: "succeeded", status: "handoff", to: bName, delayMs: 200 });
    await withDeadline(safe(handler.turn({ agent: a, deadline: "5m" }, stepCtx(token("B")).ctx)), 20_000, "the ignored handoff");
    turnEndings.push({ state: "succeeded", status: "done", delayMs: 200 });
    await withDeadline(safe(handler.turn({ agent: d, deadline: "5m" }, stepCtx(token("C")).ctx)), 20_000, "the intervening turn");
    const T3 = token("D");
    turnEndings.push({ state: "succeeded", status: "done", delayMs: 200 });
    await withDeadline(safe(handler.turn({ agent: b, deadline: "5m" }, stepCtx(T3).ctx)), 20_000, "the late turn on b");
    c("a handoff not honored by the NEXT turn in the scope links nothing",
      turnInvokes.find((i) => i.goalId === T3)?.handoffFrom === undefined,
      JSON.stringify(turnInvokes.find((i) => i.goalId === T3)));
    // Ambiguity: two concurrent turns in ONE scope both yield handoff to b with no begin between
    // the yields — the memo goes ambiguous and the next turn on b links nothing.
    const TA = token("E"); const TB = token("F");
    turnEndings.push({ state: "succeeded", status: "handoff", to: bName, delayMs: 700 });
    turnEndings.push({ state: "succeeded", status: "handoff", to: bName, delayMs: 900 });
    const pa = safe(handler.turn({ agent: a, deadline: "5m" }, stepCtx(TA).ctx));
    await wait(150);
    const pb = safe(handler.turn({ agent: d, deadline: "5m" }, stepCtx(TB).ctx));
    await withDeadline(Promise.all([pa, pb]), 20_000, "the concurrent handoffs");
    const T4 = token("G");
    turnEndings.push({ state: "succeeded", status: "done", delayMs: 200 });
    await withDeadline(safe(handler.turn({ agent: b, deadline: "5m" }, stepCtx(T4).ctx)), 20_000, "the post-ambiguity turn");
    c("two pending handoffs naming one agent record no linkage at all",
      turnInvokes.find((i) => i.goalId === T4)?.handoffFrom === undefined,
      JSON.stringify(turnInvokes.find((i) => i.goalId === T4)));
  }
}

// ── 13) a turn on an agent this run never spawned refuses loudly ──────────────────────────────
{
  console.log("• 13 — a turn outside the run's roster refuses loudly, before any wire work");
  const handler = mk("tn-13");
  const invokesBefore = turnInvokes.length;
  const got = await withDeadline(safe(handler.turn({ agent: { agent: `ghost#${"g".repeat(26)}`, persona: "dev" }, deadline: "5m" }, stepCtx(token("H")).ctx)), 10_000, "the roster refusal");
  c("the refusal names the roster and reaches no endpoint",
    (got as { threw?: boolean })?.threw === true && String((got as { message?: string })?.message).includes("roster") && turnInvokes.length === invokesBefore,
    JSON.stringify(got));
}

// ── 14) cancellation claims the armed pause ───────────────────────────────────────────────────
{
  console.log("• 14 — a cancelled turn unwinds as Cancelled and claims its pause");
  const handler = mk("tn-14");
  const a = await spawnSeat(handler, "I");
  if (a !== undefined) {
    const T = token("J");
    const step = stepCtx(T);
    const p = safe(handler.turn({ agent: a, deadline: "5m" }, step.ctx));
    await wait(1_000);
    step.cancel("a race decided against this branch");
    const got = await withDeadline(p, 20_000, "the cancelled turn");
    c("the turn unwinds as Cancelled", (got as { name?: string })?.name === "Cancelled", JSON.stringify(got));
    const settle = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: T });
    c("the cancellation claims the armed pause", settle !== undefined, settle?.settle);
  }
}

// ── 15) adoption seeds the memos: a rebuilt handler honors a recorded handoff ─────────────────
{
  console.log("• 15 — an adopted run rebuilds its roster and handoff memos from the journal alone");
  const fresh = mk("tn-15");
  const aUid = "K".toLowerCase().repeat(26);
  const bUid = "L".toLowerCase().repeat(26);
  seat += 1; const aActor = `seat${seat}`;
  seat += 1; const bActor = `seat${seat}`;
  mappings.set(`local.${aActor}`, { lifecycleUid: aUid, mappingRevision: 1 });
  mappings.set(`local.${bActor}`, { lifecycleUid: bUid, mappingRevision: 1 });
  allocations.push({ goalId: token("M"), name: "adopt-a", owner: "local", actor: aActor, uid: aUid, persona: "builder" });
  allocations.push({ goalId: token("N"), name: "adopt-b", owner: "local", actor: bActor, uid: bUid, persona: "reviewer" });
  await putPresence("adopt-a", aUid, `local.${aActor}`);
  await putPresence("adopt-b", bUid, `local.${bActor}`);
  await fresh.adopted([
    {
      v: 1, seq: 1, run: "tn-15", scope: "", kind: "spawn", name: "a", occurrence: 0,
      inputHash: "sha256:0", requestId: token("M"), state: "settled", status: "ok",
      result: { agent: `adopt-a#${aUid}`, persona: "builder" },
      external: { goalId: token("M"), name: "adopt-a", owner: "local", actor: aActor, uid: aUid },
    },
    {
      v: 1, seq: 2, run: "tn-15", scope: "", kind: "spawn", name: "b", occurrence: 0,
      inputHash: "sha256:0", requestId: token("N"), state: "settled", status: "ok",
      result: { agent: `adopt-b#${bUid}`, persona: "reviewer" },
      external: { goalId: token("N"), name: "adopt-b", owner: "local", actor: bActor, uid: bUid },
    },
    {
      v: 1, seq: 3, run: "tn-15", scope: "", kind: "turn", name: "hand", occurrence: 0,
      inputHash: "sha256:0", requestId: token("O"), state: "settled", status: "ok",
      result: { status: "handoff", to: { agent: `adopt-b#${bUid}`, persona: "reviewer" }, at: 1 },
      external: { goalId: token("O"), name: "adopt-a", owner: "local", actor: aActor, uid: aUid, deadlineAt: 1, noticeIds: [] },
    },
  ] as unknown as JournalEntry[]);
  const T = token("P");
  turnEndings.push({ state: "succeeded", status: "done", delayMs: 200 });
  const got = await withDeadline(safe(fresh.turn({ agent: { agent: `adopt-b#${bUid}`, persona: "reviewer" }, deadline: "5m" }, stepCtx(T).ctx)), 20_000, "the adopted honoring turn");
  c("the adopted handler turns the recorded roster's agent", isTurnResult(got) && got.status === "done", JSON.stringify(got));
  c("the adopted memo links the recorded handoff into the honoring submission",
    turnInvokes.find((i) => i.goalId === T)?.handoffFrom === token("O"),
    JSON.stringify(turnInvokes.find((i) => i.goalId === T)));
}

// ── 16) permits.turns: the budget is spent at the turn that would exceed it ───────────────────
{
  console.log("• 16 — a turns permit: the turn past the budget is L4001, before any wire work, and an adopted run counts recorded turns");
  const handler = mk("tn-16");
  const b = await withDeadline(safe(handler.spawn({ persona: "builder", permits: { turns: 1 } }, stepCtx(token("Q")).ctx)), 20_000, "the permitted spawn") as { agent: string; persona: string } | undefined;
  turnEndings.push({ state: "succeeded", status: "done", delayMs: 200 });
  const first = await withDeadline(safe(handler.turn({ agent: b!, deadline: "5m" }, stepCtx(token("R")).ctx)), 20_000, "the first permitted turn");
  c("the first turn is within the budget", isTurnResult(first) && first.status === "done", JSON.stringify(first));
  const before = turnInvokes.length;
  const second = await withDeadline(safe(handler.turn({ agent: b!, deadline: "5m" }, stepCtx(token("S")).ctx)), 10_000, "the over-budget turn");
  c("the second is the catchable L4001 (kind permit-turns), naming the budget, and reaches no endpoint",
    (second as { code?: string })?.code === "L4001" && (second as { kind?: string })?.kind === "permit-turns"
      && String((second as { message?: string })?.message).includes("permit of 1") && turnInvokes.length === before,
    JSON.stringify(second));
  // The budget is spent by turns the journal recorded, whatever they came to: a recovering run
  // reads them from its entries, never from a counter the dead process held.
  const alloc = allocations.find((a) => `${a.name}#${a.uid}` === b?.agent);
  const fresh = mk("tn-16");
  await fresh.adopted([
    {
      v: 1, seq: 1, run: "tn-16", scope: "", kind: "spawn", name: "builder", occurrence: 0,
      inputHash: "sha256:0", requestId: token("Q"), state: "settled", status: "ok", result: b,
      external: { goalId: token("Q"), name: alloc?.name, owner: alloc?.owner, actor: alloc?.actor, uid: alloc?.uid, permits: { turns: 1 }, spawnedAt: Date.now() - 1_000 },
    },
    {
      v: 1, seq: 2, run: "tn-16", scope: "", kind: "turn", name: "", occurrence: 0,
      inputHash: "sha256:0", requestId: token("R"), state: "settled", status: "failed", error: { code: "L4003", kind: "turn-deadline", message: "elapsed" },
      external: { goalId: token("R"), name: alloc?.name, owner: alloc?.owner, actor: alloc?.actor, uid: alloc?.uid, deadlineAt: 1, noticeIds: [] },
    },
  ] as unknown as JournalEntry[]);
  const adopted = await withDeadline(safe(fresh.turn({ agent: b!, deadline: "5m" }, stepCtx(token("T")).ctx)), 10_000, "the adopted over-budget turn");
  c("an adopted run reads the spent budget off its journal: a recorded turn counts even when it ended on a deadline",
    (adopted as { code?: string })?.code === "L4001" && (adopted as { kind?: string })?.kind === "permit-turns", JSON.stringify(adopted));

  // THE REAL CALLER HANDS OVER AN APPEND LOG, and a completed step is in it TWICE. The driver seeds
  // from `RunJournalAppender.steps()`, which replays every record in order: the pending one and the
  // settled one. Counting rows rather than steps charged one turn to the budget twice, so an agent
  // with two turns was refused its second the moment its run recovered. `fork.ts` carries the same
  // warning about the same list. The cell below is the shape a driver actually passes.
  const two = await withDeadline(safe(handler.spawn({ persona: "builder", permits: { turns: 2 } }, stepCtx(token("Q2")).ctx)), 20_000, "the two-turn spawn") as { agent: string; persona: string } | undefined;
  const alloc2 = allocations.find((a) => `${a.name}#${a.uid}` === two?.agent);
  const log = mk("tn-16");
  const turnExt = { goalId: token("R2"), name: alloc2?.name, owner: alloc2?.owner, actor: alloc2?.actor, uid: alloc2?.uid, deadlineAt: 1, noticeIds: [] };
  await log.adopted([
    {
      v: 1, seq: 1, run: "tn-16", scope: "", kind: "spawn", name: "builder", occurrence: 0,
      inputHash: "sha256:0", requestId: token("Q2"), state: "pending",
      external: { goalId: token("Q2"), name: alloc2?.name, owner: alloc2?.owner, actor: alloc2?.actor, uid: alloc2?.uid, permits: { turns: 2 }, spawnedAt: Date.now() - 1_000 },
    },
    {
      v: 1, seq: 2, run: "tn-16", scope: "", kind: "spawn", name: "builder", occurrence: 0,
      inputHash: "sha256:0", requestId: token("Q2"), state: "settled", status: "ok", result: two,
      external: { goalId: token("Q2"), name: alloc2?.name, owner: alloc2?.owner, actor: alloc2?.actor, uid: alloc2?.uid, permits: { turns: 2 }, spawnedAt: Date.now() - 1_000 },
    },
    {
      v: 1, seq: 3, run: "tn-16", scope: "", kind: "turn", name: "one", occurrence: 0,
      inputHash: "sha256:0", requestId: token("R2"), state: "pending", external: turnExt,
    },
    {
      v: 1, seq: 4, run: "tn-16", scope: "", kind: "turn", name: "one", occurrence: 0,
      inputHash: "sha256:0", requestId: token("R2"), state: "settled", status: "ok",
      result: { status: "done", at: 1 }, external: turnExt,
    },
  ] as unknown as JournalEntry[]);
  turnEndings.push({ state: "succeeded", status: "done", delayMs: 200 });
  const secondOfTwo = await withDeadline(safe(log.turn({ agent: two!, deadline: "5m" }, stepCtx(token("S2")).ctx)), 20_000, "the second of two permitted turns");
  c("ONE recorded turn costs ONE turn, though the append log holds it twice: the second of two proceeds",
    isTurnResult(secondOfTwo) && secondOfTwo.status === "done", JSON.stringify(secondOfTwo));
  const thirdOfTwo = await withDeadline(safe(log.turn({ agent: two!, deadline: "5m" }, stepCtx(token("T2")).ctx)), 10_000, "the third of two permitted turns");
  c("and the third is still refused, so the fold did not lose the count",
    (thirdOfTwo as { code?: string })?.code === "L4001" && (thirdOfTwo as { kind?: string })?.kind === "permit-turns", JSON.stringify(thirdOfTwo));
}

// ── 16b) a turn the endpoint refused took no turn, and a lost reply over a dead seat is L4002 ─
{
  console.log("• 16b — a refused turn spends no permit, and the acceptance re-read classes a gone seat as L4002");
  const handler = mk("tn-16b");
  const b = await withDeadline(safe(handler.spawn({ persona: "builder", permits: { turns: 1 } }, stepCtx(token("Qb")).ctx)), 20_000, "the one-turn spawn") as { agent: string; persona: string } | undefined;
  // A permit is a budget for turns the AGENT TAKES. A turn the endpoint refused never reached it,
  // and nothing durable records it, so a recovering run would read a different count than a live
  // one that had already spent it.
  turnFaults.push({ where: "entry", err: new EpEnvelopeError("unavailable", "the manager is not serving turns") });
  const refused = await withDeadline(safe(handler.turn({ agent: b!, deadline: "5m" }, stepCtx(token("Rb")).ctx)), 20_000, "the refused turn");
  c("the endpoint's refusal reaches the program as the refusal it is",
    String((refused as { message?: string })?.message).includes("was refused by"), JSON.stringify(refused));
  turnEndings.push({ state: "succeeded", status: "done", delayMs: 200 });
  const after = await withDeadline(safe(handler.turn({ agent: b!, deadline: "5m" }, stepCtx(token("Sb")).ctx)), 20_000, "the turn after the refusal");
  c("the agent's one permitted turn is still there: a refused turn spent nothing",
    isTurnResult(after) && after.status === "done", JSON.stringify(after));

  // The lost reply: the invoke did not come back but the goal record exists, so the acceptance is
  // asked for again. If the seat died in between, that re-read carries the SAME `expired`, and
  // classing it as an ordinary refusal turned a catchable L4002 into an uncatchable fault.
  const h2 = mk("tn-16b");
  const b2 = await withDeadline(safe(h2.spawn({ persona: "builder" }, stepCtx(token("Tb")).ctx)), 20_000, "the second spawn") as { agent: string; persona: string } | undefined;
  turnFaults.push({ where: "hang" });
  turnFaults.push({ where: "entry", err: new EpEnvelopeError("expired", "target is not a live managed agent") });
  const gone = await withDeadline(safe(h2.turn({ agent: b2!, deadline: "5m" }, stepCtx(token("Ub")).ctx)), 90_000, "the turn whose re-read found the seat gone");
  c("a seat that died between the submit and the acceptance re-read is the catchable L4002",
    (gone as { code?: string })?.code === "L4002" && (gone as { kind?: string })?.kind === "turn", JSON.stringify(gone));
}

// ── 17) permits.wallClock: a deadline the agent's remaining wall clock cannot hold is refused ─
{
  console.log("• 17 — a wall-clock permit: a turn that would run past it is L4001, one that fits proceeds");
  const handler = mk("tn-17");
  const b = await withDeadline(safe(handler.spawn({ persona: "builder", permits: { wallClock: "30s" } }, stepCtx(token("U")).ctx)), 20_000, "the clocked spawn") as { agent: string; persona: string } | undefined;
  const before = turnInvokes.length;
  const over = await withDeadline(safe(handler.turn({ agent: b!, deadline: "5m" }, stepCtx(token("V")).ctx)), 10_000, "the over-clock turn");
  c("a deadline past the remaining wall clock is L4001 (kind permit-wall-clock), naming both, and reaches no endpoint",
    (over as { code?: string })?.code === "L4001" && (over as { kind?: string })?.kind === "permit-wall-clock"
      && String((over as { message?: string })?.message).includes("runs past") && turnInvokes.length === before,
    JSON.stringify(over));
  turnEndings.push({ state: "succeeded", status: "done", delayMs: 200 });
  const within = await withDeadline(safe(handler.turn({ agent: b!, deadline: "5s" }, stepCtx(token("W")).ctx)), 20_000, "the within-clock turn");
  c("a deadline the remaining wall clock holds proceeds", isTurnResult(within) && within.status === "done", JSON.stringify(within));
}

// ── 18) a budget this host cannot meter is refused at spawn, before anything is submitted ─────
{
  console.log("• 18 — permits this host has no meter for are refused loudly at spawn");
  const handler = mk("tn-18");
  const before = spawnAccepts.size;
  const tokens = await withDeadline(safe(handler.spawn({ persona: "builder", permits: { tokens: 5_000 } }, stepCtx(token("X")).ctx)), 10_000, "the unmeterable spawn");
  c("permits.tokens is refused naming the meter this host lacks, and no spawn was submitted",
    (tokens as { threw?: boolean })?.threw === true && String((tokens as { message?: string })?.message).includes("no meter") && spawnAccepts.size === before,
    JSON.stringify(tokens));
  const zero = await withDeadline(safe(handler.spawn({ persona: "builder", permits: { turns: 0 } }, stepCtx(token("Y")).ctx)), 10_000, "the zero-turn spawn");
  c("a turns budget that is not a positive integer is refused as malformed",
    (zero as { threw?: boolean })?.threw === true && String((zero as { message?: string })?.message).includes("positive integer") && spawnAccepts.size === before,
    JSON.stringify(zero));
}

async function readGoalResultData(goalId: string): Promise<Record<string, unknown> | undefined> {
  const { readGoalResult } = await import("@cotal-ai/core");
  const fact = await readGoalResult(goalCtx, { endpoint: EP, caller: CALLER, goalId });
  return fact?.data as Record<string, unknown> | undefined;
}

await Promise.allSettled(terminals);
await serve.stop().catch(() => { /* teardown */ });
await nc.close();
const EXPECTED_CELLS = 47;
const ran = ok + fail;
console.log(`mesh-turn.smoke: ${ok} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  done();
  process.exit(1);
}
done();
process.exit(fail === 0 ? 0 : 1);
