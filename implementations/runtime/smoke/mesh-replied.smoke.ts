/**
 * `wait(replied(agent))` on the real planes: a reply observed over THIS RUN's turn terminals.
 *
 * The load-bearing properties, one block each: a completed turn IS a reply and a wait that begins
 * after it resolves at once (replied is a LEVEL, like `down`); a wait that begins first parks and
 * resolves on the yield's own record; two replies resolve to the LATEST by the yield's `at`
 * stamp; a denied (deadline) turn is never a reply, so an unanswered wait rides its own mediated
 * timeout to `null`; a handle the run never turned or spawned refuses loudly on the roster; a
 * cancelled wait unwinds and claims its armed pause; and adoption reseeds the turn-goal registry
 * from the journal so a resumed run re-observes its recorded replies.
 *
 * The far side is the same suite-served MANAGER-SHAPED goal endpoint the turn suite drives (the
 * runtime never imports `@cotal-ai/manager`), scripting each turn's terminal in the real shapes:
 * a currency-proving `succeeded` or a goal-bound hold's deny.
 *
 * Run: pnpm smoke:runtime-mesh-replied   (needs nats-server on PATH)
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
  type EpCommandDef,
  type EpServeContext,
  type EpCaller,
  type Presence,
} from "@cotal-ai/core";
import { type JournalEntry } from "@cotal-ai/lang";
import { MeshHandler, EpfSettleWatcher, startRun } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "meshreplied";
const EP = "manager";
const MGR_IID = "m".repeat(26);
const HOLDER = { id: "manager", lifecycleUid: "u_meshreplied" };
const CALLER: EpCaller = { owner: "local", actor: "wf_meshreplied", uid: "a".repeat(26) };

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
const sd = mkdtempSync(join(tmpdir(), "cotal-meshreplied-"));
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
  urn: "ai.cotal.test.repliedmgr", revision: 1, attributes: [], events: [],
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
const isReplied = (v: unknown): v is { agent: string; status: string; note?: string; at: number } =>
  v !== null && typeof v === "object" && typeof (v as { agent?: unknown }).agent === "string"
  && typeof (v as { status?: unknown }).status === "string" && typeof (v as { at?: unknown }).at === "number";

// ── 1) a driven program observes its own completed turn at once ────────────────────────────────
{
  console.log("• 1 — a driven wait(replied) resolves at once on the run's completed turn");
  turnEndings.push({ state: "succeeded", status: "done", note: "built", delayMs: 100 });
  const out = await withDeadline(startRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "rp-1", lease: lease(),
    source: `const d = await spawn("builder");\nconst r = await turn(d, { name: "drive" });\nconst seen = await wait(replied(d), { name: "observe" });\nlog("seen", seen.status);`,
    handler: mk("rp-1"),
  }).catch((e: unknown) => ({ status: "threw" as const, error: `${(e as Error)?.name}: ${(e as Error)?.message?.slice(0, 140)}` })), 45_000, "the driven replied run");
  c("the run completes", (out as { status?: string } | undefined)?.status === "completed", JSON.stringify(out));
  const waitEntry = (await journalEntries("rp-1", "wait")).find((e) => e.state === "settled");
  const turnEntry = (await journalEntries("rp-1", "turn")).find((e) => e.state === "settled");
  const seen = waitEntry?.result as { agent?: string; status?: string; note?: string; at?: number } | undefined;
  const spawnV = (await journalEntries("rp-1", "spawn")).find((e) => e.state === "settled")?.result as { agent?: string } | undefined;
  c("the settled wait records the reply as the observation value: the handle, the yield, its stamp",
    seen?.agent === spawnV?.agent && seen?.status === "done" && seen?.note === "built" && typeof seen?.at === "number",
    JSON.stringify(seen));
  c("the observed stamp IS the yield's own: the wait invented no time",
    seen?.at === (turnEntry?.result as { at?: number } | undefined)?.at,
    JSON.stringify({ seen: seen?.at, yield: (turnEntry?.result as { at?: number } | undefined)?.at }));
}

// ── 2) a wait that begins first parks, and resolves on the yield ───────────────────────────────
{
  console.log("• 2 — a parked wait resolves when the reply lands");
  const h = mk("rp-2");
  const d = await spawnSeat(h, "a");
  turnEndings.push({ state: "succeeded", status: "blocked", note: "stuck on creds", delayMs: 2_500 });
  const W = token("b");
  const p = safe(h.wait({ event: { event: "replied", agent: d!.agent } } as never, stepCtx(W).ctx));
  const beat = await Promise.race([p.then(() => "resolved"), wait(1_000).then(() => "parked")]);
  c("the wait parks while no reply exists", beat === "parked", beat);
  // The reply: another step's turn, driven concurrently, whose yield the wait observes.
  const T = token("c");
  const turned = await withDeadline(safe(h.turn({ agent: { agent: d!.agent, persona: d!.persona }, deadline: "5m" } as never, stepCtx(T, { key: { scope: [], kind: "turn", name: "", occurrence: 0 } }).ctx)), 20_000, "the concurrent turn");
  const got = await withDeadline(p, 20_000, "the parked replied wait");
  c("the wait resolves with the yield's own record", isReplied(got) && got.status === "blocked" && got.note === "stuck on creds", JSON.stringify(got));
  c("the value names the observed handle and the turn saw the same yield",
    isReplied(got) && got.agent === d!.agent && (turned as { status?: string } | undefined)?.status === "blocked",
    JSON.stringify({ got, turned }));
}

// ── 3) two replies resolve to the LATEST, by the yield's own stamp ─────────────────────────────
{
  console.log("• 3 — the latest reply wins");
  const h = mk("rp-3");
  const d = await spawnSeat(h, "d");
  turnEndings.push({ state: "succeeded", status: "done", note: "first", delayMs: 50 });
  await withDeadline(safe(h.turn({ agent: { agent: d!.agent, persona: d!.persona }, deadline: "5m" } as never, stepCtx(token("e"), { key: { scope: [], kind: "turn", name: "", occurrence: 0 } }).ctx)), 20_000, "the first turn");
  await wait(50); // two yields need two distinct stamps
  turnEndings.push({ state: "succeeded", status: "done", note: "second", delayMs: 50 });
  await withDeadline(safe(h.turn({ agent: { agent: d!.agent, persona: d!.persona }, deadline: "5m" } as never, stepCtx(token("f"), { key: { scope: [], kind: "turn", name: "", occurrence: 1 } }).ctx)), 20_000, "the second turn");
  const got = await withDeadline(safe(h.wait({ event: { event: "replied", agent: d!.agent }, timeout: "10m" } as never, stepCtx(token("g")).ctx)), 20_000, "the level read");
  c("a wait over two completed turns resolves to the later yield", isReplied(got) && got.note === "second", JSON.stringify(got));
  const settle3 = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: token("g") });
  c("the resolution claims the armed pause: no timer fires into a run that moved on", settle3 !== undefined, JSON.stringify(settle3));
}

// ── 4) a denied turn is not a reply: the wait rides its own timeout to null ────────────────────
{
  console.log("• 4 — a deadline-denied turn never resolves the wait; the timeout does");
  const h = mk("rp-4");
  const d = await spawnSeat(h, "h");
  turnEndings.push({ state: "deadline", delayMs: 50 });
  const T = token("i");
  await withDeadline(safe(h.turn({ agent: { agent: d!.agent, persona: d!.persona }, deadline: "5m" } as never, stepCtx(T, { key: { scope: [], kind: "turn", name: "", occurrence: 0 } }).ctx)), 30_000, "the denied turn");
  const W = token("j");
  const p = safe(h.wait({ event: { event: "replied", agent: d!.agent }, timeout: "2s" } as never, stepCtx(W).ctx));
  await armPending(12);
  await armPending(4);
  const got = await withDeadline(p, 30_000, "the timing-out replied wait");
  c("the denied turn never resolves the wait: the timeout resolves null, never a throw", got === null, JSON.stringify(got));
  const settle = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: W });
  c("the timeout pause settled expired on the plane", (settle as { settle?: string } | undefined)?.settle === "expired", JSON.stringify(settle));
}

// ── 5) a handle the run never spawned or turned refuses on the roster ──────────────────────────
{
  console.log("• 5 — an unobservable handle refuses loudly");
  const h = mk("rp-5");
  const got = await withDeadline(safe(h.wait({ event: { event: "replied", agent: `stranger#${"z".repeat(26)}` } } as never, stepCtx(token("k")).ctx)), 20_000, "the roster refusal");
  c("wait(replied) on an unknown handle refuses naming the roster",
    (got as { threw?: boolean; message?: string } | undefined)?.threw === true && String((got as { message?: string })?.message).includes("roster"),
    JSON.stringify(got));
}

// ── 6) cancellation unwinds the park and claims the armed pause ────────────────────────────────
{
  console.log("• 6 — a cancelled wait unwinds and claims its pause");
  const h = mk("rp-6");
  const d = await spawnSeat(h, "l");
  const W = token("n");
  const s = stepCtx(W);
  const p = safe(h.wait({ event: { event: "replied", agent: d!.agent }, timeout: "10m" } as never, s.ctx));
  await armPending(6);
  await wait(500);
  s.cancel("race decided elsewhere");
  const got = await withDeadline(p, 20_000, "the cancelled replied wait");
  c("the cancellation unwinds as Cancelled", (got as { name?: string } | undefined)?.name === "Cancelled", JSON.stringify(got));
  const settle = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: W });
  c("the cancellation claims the armed pause", settle !== undefined, JSON.stringify(settle));
}

// ── 7) adoption reseeds the registry: a resumed run re-observes its recorded reply ─────────────
{
  console.log("• 7 — an adopted run re-observes the reply its journal records");
  const h = mk("rp-7");
  const d = await spawnSeat(h, "o");
  turnEndings.push({ state: "succeeded", status: "done", note: "shipped", delayMs: 50 });
  const T = token("q");
  const sT = stepCtx(T, { key: { scope: [], kind: "turn", name: "", occurrence: 0 } });
  await withDeadline(safe(h.turn({ agent: { agent: d!.agent, persona: d!.persona }, deadline: "5m" } as never, sT.ctx)), 20_000, "the recorded turn");
  const { name, uid } = { name: d!.agent.slice(0, d!.agent.lastIndexOf("#")), uid: d!.agent.slice(d!.agent.lastIndexOf("#") + 1) };
  const fresh = mk("rp-7");
  await fresh.adopted([
    {
      v: 1, seq: 1, run: "rp-7", scope: "", kind: "spawn", name: "seat", occurrence: 0,
      inputHash: "sha256:0", requestId: token("p"), state: "settled", status: "ok",
      result: { agent: d!.agent, persona: d!.persona },
      external: { goalId: token("p"), name, owner: "local", actor: "seatX", uid },
    },
    {
      v: 1, seq: 2, run: "rp-7", scope: "", kind: "turn", name: "drive", occurrence: 0,
      inputHash: "sha256:0", requestId: T, state: "settled", status: "ok",
      result: { status: "done", note: "shipped", at: 1 },
      external: { goalId: T, name, owner: "local", actor: "seatX", uid, deadlineAt: 1, noticeIds: [] },
    },
  ] as unknown as JournalEntry[]);
  const got = await withDeadline(safe(fresh.wait({ event: { event: "replied", agent: d!.agent } } as never, stepCtx(token("r")).ctx)), 20_000, "the adopted replied wait");
  c("the adopted handler re-observes the recorded reply at once", isReplied(got) && got.status === "done" && got.note === "shipped", JSON.stringify(got));
  c("its value rides the durable terminal, not the dead handler's memory", isReplied(got) && got.agent === d!.agent, JSON.stringify(got));
}

await Promise.allSettled(terminals);
await serve.stop().catch(() => { /* teardown */ });
await nc.close();
const EXPECTED_CELLS = 15;
const ran = ok + fail;
console.log(`mesh-replied.smoke: ${ok} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exitCode = 1;
  done();
  process.exit(1);
}
done();
process.exit(fail === 0 ? 0 : 1);
