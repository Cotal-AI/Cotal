/**
 * The §9 worktree binding on the real planes: a LOGICAL worktree a spawn declares and the run
 * enforces exclusivity over.
 *
 * The load-bearing properties, one block each: a worktree spawn PERFORMS (the old seam refusal is
 * gone) and its handle carries the logical id into the journal; the runtime half of "two agents
 * MUST NOT share a worktree concurrently" (spec 6.5) refuses a second spawn into a live holder's
 * tree as the catchable L4008; sequential reuse is legal the moment the holder's presence row is
 * gone — a discharged loser or a crashed seat releases its tree with no bookkeeping of its own;
 * a handoff yield across worktrees is the turn client's L4004, here on REAL worktree-carrying
 * handles rather than synthetic ones; and adoption reseeds the holder registry from journal spawn
 * results so a resumed run keeps enforcing what its journal shows. The validator's static half
 * (L3022, literal worktrees in one concurrent scope) is graded in the lang grammar suite.
 *
 * The far side is the same suite-served MANAGER-SHAPED goal endpoint the turn suite drives (the
 * runtime never imports `@cotal-ai/manager`).
 *
 * Run: pnpm smoke:runtime-mesh-worktree   (needs nats-server on PATH)
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
  replayRunJournal,
  newTakeoverId,
  EpEnvelopeError,
  IncompleteKvScan,
  type EpCommandDef,
  type EpServeContext,
  type EpCaller,
  type Presence,
} from "@cotal-ai/core";
import { type JournalEntry } from "@cotal-ai/lang";
import { MeshHandler, EpfSettleWatcher, startRun } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "meshworktree";
const EP = "manager";
const MGR_IID = "m".repeat(26);
const HOLDER = { id: "manager", lifecycleUid: "u_meshworktree" };
const CALLER: EpCaller = { owner: "local", actor: "wf_meshworktree", uid: "a".repeat(26) };

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
  p.catch((e: unknown) => ({ threw: true, name: (e as Error)?.name, code: (e as { code?: string })?.code, message: (e as Error)?.message ?? String(e) }));

// ── broker + planes ────────────────────────────────────────────────────────────────────────────
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-meshworktree-"));
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
// Rows live until deleted — a seat stays alive for the whole suite unless a cell kills it.
const presenceKv = await new Kvm(nc).create(presenceBucket(SPACE));

// The timer pump for the wait's own mediated timeout. Drain WIDE before a block that needs an arm.
await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
const wctx = await timerWriterContext(nc, SPACE);
const armPending = async (expect = 4): Promise<void> => {
  for await (const m of await writerC.fetch({ max_messages: expect, expires: 1_200 })) {
    await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
    m.ack();
  }
};

// ── the suite-served manager-shaped goal endpoint (spawn + turn), the turn suite's rig ─────────
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
  urn: "ai.cotal.test.worktreemgr", revision: 1, attributes: [], events: [],
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
/** Cell knobs: hold the next spawn's terminal back (an accepted seat still coming up), or refuse
 *  the next submission at accept (nothing bound, nothing provisioned). */
let spawnTerminalHoldMs = 0;
let refuseNextSpawn: EpEnvelopeError | undefined;

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
  if (refuseNextSpawn !== undefined) {
    const refusal = refuseNextSpawn;
    refuseNextSpawn = undefined;
    throw refusal;
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
  const holdMs = spawnTerminalHoldMs;
  terminals.push((async () => {
    if (holdMs > 0) await wait(holdMs);
    await putPresence(name, uid, `local.${actor}`);
    await commitGoalResult(goalCtx, { ref, now: Date.now(), cause: "complete", state: "succeeded", data: { name, agent: "claude", id: `local.${actor}`, mode: "pty", lifecycleUid: uid }, committer: { instanceId: MGR_IID, epoch: EXEC_EPOCH } });
  })().catch((e) => { console.log("  ! fake spawn terminal failed:", (e as Error).message); }));
  return acceptance;
};

/** One relayed turn's scripted ENDING, in the real terminal shapes (the turn suite's contract):
 *  a currency-proving `succeeded`, or a goal-bound hold minted, expired once due, and denied. */
type TurnEnding =
  | { state: "succeeded"; status: "done" | "blocked" | "handoff"; to?: string; note?: string; delayMs?: number }
  | { state: "deadline"; delayMs?: number };
const turnEndings: TurnEnding[] = [];
const turnAccepts = new Map<string, Record<string, unknown>>();

const turnHandler = async (ctx: EpServeContext): Promise<unknown> => {
  const args = (ctx.request.args ?? {}) as Record<string, unknown>;
  const goalId = ctx.request.id;
  const t = ctx.request.target as { owner: string; actor: string; lifecycleUid: string };
  const { fingerprint } = submissionFingerprint(ctx.request as unknown, ctx.subject);
  const prior = turnAccepts.get(goalId);
  if (prior !== undefined) {
    if (prior.fingerprint !== fingerprint) throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted under a different submission (SPEC 13.6)`);
    return prior;
  }
  const alloc = allocations.find((a) => a.owner === t.owner && a.actor === t.actor && a.uid === t.lifecycleUid);
  const name = alloc?.name ?? `${t.owner}.${t.actor}`;
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
  const acceptance = {
    name, owner: t.owner, actor: t.actor, uid: t.lifecycleUid, goalId, fingerprint,
    deadlineAt: Date.now() + deadlineMs, executor: { lifecycleUid: MGR_IID, epoch: EXEC_EPOCH },
  };
  turnAccepts.set(goalId, acceptance);
  const ending = turnEndings.shift();
  const runCaller = { owner: ctx.subject.caller.owner, actor: ctx.subject.caller.actor, uid: ctx.subject.caller.uid };
  if (ending !== undefined) {
    terminals.push((async () => {
      if (ending.delayMs !== undefined) await wait(ending.delayMs);
      if (ending.state === "succeeded") {
        const data = { status: ending.status, ...(ending.to !== undefined ? { to: ending.to } : {}), ...(ending.note !== undefined ? { note: ending.note } : {}), at: Date.now() };
        await commitGoalResult(goalCtx, {
          ref, now: Date.now(), cause: "complete", state: "succeeded", data,
          committer: { instanceId: MGR_IID, epoch: EXEC_EPOCH },
          executor: { lifecycleUid: t.lifecycleUid, epoch: 0 },
          resolveCurrentEpoch: () => 0,
        });
        return;
      }
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
        data: { reason: "turn-deadline" },
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
  new EpfSettleWatcher(jsm, SPACE, 3_000),
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
    key: opts.key ?? { scope: [], kind: "wait", name: "", occurrence: 0 },
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
/** Spawn one seat with a worktree through the handler under test. */
const spawnInto = async (handler: MeshHandler, tag: string, worktree: string, persona = "builder"): Promise<unknown> =>
  await withDeadline(safe(handler.spawn({ persona, worktree } as never, stepCtx(token(tag)).ctx)), 20_000, `the ${persona} spawn into ${worktree}`);
const isHandle = (v: unknown): v is { agent: string; persona: string; worktree?: string } =>
  v !== null && typeof v === "object" && typeof (v as { agent?: unknown }).agent === "string";

// ── 1) a worktree spawn performs, and the handle carries the logical id ────────────────────────
{
  console.log("• 1 — a driven worktree spawn performs end to end");
  const out = await withDeadline(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "wt-1", lease: lease(),
    source: `const d = await spawn("builder", { worktree: "wt-a", onFork: "adopt" });\nlog("tree", d.worktree);`,
    handler: mk("wt-1"),
  }).catch((e: unknown) => ({ status: "threw" as const, error: `${(e as Error)?.name}: ${(e as Error)?.message?.slice(0, 140)}` })), 45_000, "the driven worktree run");
  c("the run completes: the seam refusal is gone and the spawn performs",
    (out as { status?: string } | undefined)?.status === "completed", JSON.stringify(out));
  const settled = (await journalEntries("wt-1", "spawn")).find((e) => e.state === "settled");
  const handle = settled?.result as { agent?: string; worktree?: string } | undefined;
  c("the settled handle carries the logical worktree into the journal",
    settled?.status === "ok" && handle?.worktree === "wt-a", JSON.stringify(handle));
  const bound = settled?.external as { worktree?: unknown; onFork?: unknown } | undefined;
  c("the bound external state carries the worktree (for adoption's reservation) and the onFork policy (for a fork)",
    bound?.worktree === "wt-a" && bound?.onFork === "adopt", JSON.stringify(bound));
}

// ── 2) a second agent into a LIVE holder's tree is the catchable L4008 ─────────────────────────
const h = mk("wt-2");
let holder: { agent: string; persona: string } | undefined;
{
  console.log("• 2 — a live holder's tree refuses a second spawn as L4008");
  const first = await spawnInto(h, "a", "wt-b");
  c("the first spawn holds the tree", isHandle(first) && first.worktree === "wt-b", JSON.stringify(first));
  holder = first as { agent: string; persona: string };
  const second = await spawnInto(h, "b", "wt-b", "reviewer");
  c("the second spawn refuses as the effect's own L4008, naming the tree and its holder",
    (second as { code?: string } | undefined)?.code === "L4008"
      && String((second as { message?: string }).message).includes("wt-b")
      && String((second as { message?: string }).message).includes(holder.agent),
    JSON.stringify(second));
}

// ── 3) sequential reuse: a dead holder releases its tree with no bookkeeping ───────────────────
{
  console.log("• 3 — the holder dies and the tree is reusable");
  const uid = holder!.agent.slice(holder!.agent.lastIndexOf("#") + 1);
  const alloc = allocations.find((a) => a.uid === uid);
  await presenceKv.delete(`${alloc!.owner}.${alloc!.actor}`);
  const third = await spawnInto(h, "c", "wt-b", "successor");
  c("a spawn into the dead holder's tree performs: sequential reuse is legal",
    isHandle(third) && third.worktree === "wt-b", JSON.stringify(third));
}

// ── 4) a handoff yield across worktrees is L4004, on REAL worktree-carrying handles ────────────
{
  console.log("• 4 — the live L4004 path: real handles, different trees");
  const d1 = await spawnInto(h, "d", "wt-c", "driver");
  const d2 = await spawnInto(h, "e", "wt-d", "colleague");
  c("both seats hold their own trees", isHandle(d1) && isHandle(d2), JSON.stringify({ d1, d2 }));
  const toName = isHandle(d2) ? d2.agent.slice(0, d2.agent.lastIndexOf("#")) : "";
  turnEndings.push({ state: "succeeded", status: "handoff", to: toName, delayMs: 100 });
  const got = await withDeadline(safe(h.turn(
    { agent: d1, deadline: "5m" } as never,
    stepCtx(token("f"), { key: { scope: [], kind: "turn", name: "", occurrence: 0 } }).ctx,
  )), 20_000, "the cross-tree handoff turn");
  c("the yield is refused as the effect's own L4004: you cannot hand someone a working tree they are not in",
    (got as { code?: string } | undefined)?.code === "L4004", JSON.stringify(got));
}

// ── 5) adoption reseeds the holders: a resumed run keeps enforcing its journal ─────────────────
{
  console.log("• 5 — an adopted run enforces the holder its journal records");
  const wUid = `w${"0".repeat(24)}9`;
  await putPresence("adopt-w", wUid, "local.adoptw");
  const fresh = mk("wt-5");
  await fresh.adopted([
    {
      v: 1, seq: 1, run: "wt-5", scope: "", kind: "spawn", name: "seat", occurrence: 0,
      inputHash: "sha256:0", requestId: token("g"), state: "settled", status: "ok",
      result: { agent: `adopt-w#${wUid}`, persona: "builder", worktree: "wt-z" },
      external: { goalId: token("g"), name: "adopt-w", owner: "local", actor: "adoptw", uid: wUid },
    },
  ] as unknown as JournalEntry[]);
  const refused = await spawnInto(fresh, "i", "wt-z", "intruder");
  c("the adopted holder registry refuses a spawn into the recorded live holder's tree",
    (refused as { code?: string } | undefined)?.code === "L4008", JSON.stringify(refused));
  await presenceKv.delete("local.adoptw");
  const after = await spawnInto(fresh, "j", "wt-z", "successor");
  c("and admits it once that holder's presence lapses", isHandle(after) && after.worktree === "wt-z", JSON.stringify(after));
}

// ── 6) a spawn still in flight already holds its tree ─────────────────────────────────────────
{
  console.log("• 6 — an accepted spawn holds its tree before its seat exists");
  const h6 = mk("wt-6");
  spawnTerminalHoldMs = 1_500;
  const first = spawnInto(h6, "k", "wt-e");
  await wait(400); // accepted; no presence row and no terminal yet
  spawnTerminalHoldMs = 0;
  const second = await spawnInto(h6, "l", "wt-e", "intruder");
  c("a second spawn into the tree refuses as L4008 while the first is still bringing its seat up",
    (second as { code?: string } | undefined)?.code === "L4008"
      && String((second as { message?: string }).message).includes("still bringing one up"),
    JSON.stringify(second));
  const got = await first;
  c("and the first spawn goes on to its handle", isHandle(got) && got.worktree === "wt-e", JSON.stringify(got));
}

// ── 7) a spawn that ends without a handle gives its tree back ─────────────────────────────────
{
  console.log("• 7 — a refused spawn releases its reservation");
  const h7 = mk("wt-7");
  refuseNextSpawn = new EpEnvelopeError("not-found", "no persona \"ghost\"");
  const refused = await spawnInto(h7, "m", "wt-f", "ghost");
  c("the refusal is the host declining the request (L4000): no agent was ever allocated, so never L4002",
    (refused as { code?: string } | undefined)?.code === "L4000", JSON.stringify(refused));
  const next = await spawnInto(h7, "n", "wt-f", "builder");
  c("the tree is free again: the failed spawn left no reservation behind",
    isHandle(next) && next.worktree === "wt-f", JSON.stringify(next));
}

// ── 8) adoption re-takes a reservation the journal shows in flight ────────────────────────────
{
  console.log("• 8 — an adopted run keeps a pending spawn's tree held");
  const fresh = mk("wt-8");
  await fresh.adopted([
    {
      v: 1, seq: 1, run: "wt-8", scope: "", kind: "spawn", name: "seat", occurrence: 0,
      inputHash: "sha256:0", requestId: token("o"), state: "pending",
      external: { goalId: token("o"), name: "inflight", owner: "local", actor: "inflight", uid: `x${"0".repeat(25)}`, worktree: "wt-y" },
    },
  ] as unknown as JournalEntry[]);
  const refused = await spawnInto(fresh, "p", "wt-y", "intruder");
  c("a spawn into the tree refuses as L4008 naming the in-flight goal",
    (refused as { code?: string } | undefined)?.code === "L4008" && String((refused as { message?: string }).message).includes(token("o")),
    JSON.stringify(refused));
}

// ── 8b) a spawn the journal shows FAILED holds nothing: the reservation is not immortal ───────
{
  console.log("• 8b — an adopted run frees the tree of a spawn that ended without an agent");
  // The real list is an append log: the failed spawn is in it as a pending record AND a settled
  // one. Reading the pending record on its own left a reservation nothing could ever release,
  // because the release runs on the live path and this run is a recovery.
  const fresh = mk("wt-8b");
  const ext = { goalId: token("q"), name: "gone", owner: "local", actor: "gone", uid: `y${"0".repeat(25)}`, worktree: "wt-z" };
  await fresh.adopted([
    {
      v: 1, seq: 1, run: "wt-8b", scope: "", kind: "spawn", name: "seat", occurrence: 0,
      inputHash: "sha256:0", requestId: token("q"), state: "pending", external: ext,
    },
    {
      v: 1, seq: 2, run: "wt-8b", scope: "", kind: "spawn", name: "seat", occurrence: 0,
      inputHash: "sha256:0", requestId: token("q"), state: "settled", status: "failed",
      error: { code: "L4000", kind: "spawn", message: "no persona" }, external: ext,
    },
  ] as unknown as JournalEntry[]);
  const next = await spawnInto(fresh, "r", "wt-z", "builder");
  c("the tree is free after adoption: a spawn that never produced an agent holds no reservation",
    isHandle(next) && next.worktree === "wt-z", JSON.stringify(next));
}

// ── 9) the liveness read is bounded: a scan that never completes is raised, not parked on ─────
{
  console.log("• 9 — an incomplete presence scan is retried a bounded number of times, then raised");
  const h9 = mk("wt-9");
  const wUid = `w${"0".repeat(24)}8`;
  await h9.adopted([
    {
      v: 1, seq: 1, run: "wt-9", scope: "", kind: "spawn", name: "seat", occurrence: 0,
      inputHash: "sha256:0", requestId: token("q"), state: "settled", status: "ok",
      result: { agent: `scan-w#${wUid}`, persona: "builder", worktree: "wt-x" },
      external: { goalId: token("q"), name: "scan-w", owner: "local", actor: "scanw", uid: wUid },
    },
  ] as unknown as JournalEntry[]);
  (h9 as unknown as { presenceRows: () => Promise<never> }).presenceRows = async () => {
    throw new IncompleteKvScan(presenceBucket(SPACE), 1, 2);
  };
  const t0 = Date.now();
  const got = await withDeadline(safe(h9.spawn({ persona: "builder", worktree: "wt-x" } as never, stepCtx(token("r")).ctx)), 25_000, "the guard over a broken scan");
  c("the guard gives up with the scan's own error after its bounded retries instead of parking the spawn for good",
    (got as { name?: string } | undefined)?.name === "IncompleteKvScan" && Date.now() - t0 >= 7_000,
    JSON.stringify({ got, ms: Date.now() - t0 }));
}

// ── 10) the claim is atomic: two computed spawns into one tree in one concurrent scope ────────
{
  console.log("• 10 — the validator cannot see a computed worktree; the runtime admits exactly one of two concurrent spawns into it");
  const out = await withDeadline(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "wt-10", lease: lease(),
    source: `const wt = "wt-" + "g";
await parallel({
  a: async () => { try { await spawn("dev", { name: "a", worktree: wt }); log("a", "ok"); } catch (e) { log("a", e.code); } },
  b: async () => { try { await spawn("dev", { name: "b", worktree: wt }); log("b", "ok"); } catch (e) { log("b", e.code); } },
}, { name: "both" });`,
    handler: mk("wt-10"),
  }).catch((e: unknown) => ({ status: "threw" as const, error: `${(e as Error)?.name}: ${(e as Error)?.message?.slice(0, 140)}` })), 45_000, "the computed concurrent spawn run");
  c("the run completes with one branch admitted and one refused in-program",
    (out as { status?: string } | undefined)?.status === "completed", JSON.stringify(out));
  const spawns = (await journalEntries("wt-10", "spawn")).filter((e) => e.state === "settled");
  const held = spawns.filter((e) => e.status === "ok").length;
  const refused = spawns.filter((e) => e.status === "failed" && e.error?.code === "L4008").length;
  c("exactly one spawn holds the tree and the other is the catchable L4008: never two live seats in one tree",
    held === 1 && refused === 1, JSON.stringify(spawns.map((e) => [e.name, e.status, e.error?.code])));
}

// ── 11) a dead holder's tree is claimed once: the re-read after the liveness wait ─────────────
{
  console.log("• 11 — two spawns pass a dead holder's liveness read together; only the first claims the tree");
  const h11 = mk("wt-11");
  const wUid = `w${"0".repeat(24)}7`;
  await h11.adopted([
    {
      v: 1, seq: 1, run: "wt-11", scope: "", kind: "spawn", name: "seat", occurrence: 0,
      inputHash: "sha256:0", requestId: token("u"), state: "settled", status: "ok",
      result: { agent: `gone-w#${wUid}`, persona: "builder", worktree: "wt-h" },
      external: { goalId: token("u"), name: "gone-w", owner: "local", actor: "gonew", uid: wUid },
    },
  ] as unknown as JournalEntry[]);
  const [x, y] = await Promise.all([spawnInto(h11, "v", "wt-h", "first"), spawnInto(h11, "w", "wt-h", "second")]);
  const handles = [x, y].filter(isHandle).length;
  const refusals = [x, y].filter((r) => (r as { code?: string } | undefined)?.code === "L4008").length;
  c("exactly one of the two is admitted and the other is L4008: the claim is re-read after the wait, not assumed",
    handles === 1 && refusals === 1, JSON.stringify({ x, y }));
}

await Promise.allSettled(terminals);
await serve.stop().catch(() => { /* teardown */ });
await nc.close();
const EXPECTED_CELLS = 20;
const ran = ok + fail;
console.log(`mesh-worktree.smoke: ${ok} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
  done();
  process.exit(1);
}
done();
process.exit(fail === 0 ? 0 : 1);
