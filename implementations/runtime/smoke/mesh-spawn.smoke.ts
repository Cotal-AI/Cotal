/**
 * `spawn` on the real planes: the manager's spawn ACTION, submitted under the step's own identity.
 *
 * The load-bearing property is RECOVERY BY DERIVATION: the envelope id is pinned to the step's
 * request id, the far side binds its goal under exactly that id, and the goal's terminal fact sits
 * on a subject the run can re-derive from nothing but its journal — so a crashed run re-attaches
 * to the SAME spawn instead of allocating a second seat, whichever side of the acceptance the
 * crash landed on. The suite stages each side of that window: an idempotent resubmission (crash
 * before the bind), a resume that must NOT re-invoke (crash after it), and a lost reply whose
 * accepted goal is found by the probe (the submission landed, the answer did not).
 *
 * The far side here is a suite-served MANAGER-SHAPED goal endpoint built from core primitives —
 * the runtime package must not import `@cotal-ai/manager` (implementations never import each
 * other), and the real-manager fidelity ride is bin/smoke's. What it mirrors is the acceptance
 * semantics the caller contract depends on: goalId = env.id, same-goalId + same-fingerprint served
 * from the recorded acceptance, refuse-at-accept binds nothing, terminals through
 * `commitGoalResult`.
 *
 * Run: pnpm smoke:runtime-mesh-spawn   (needs nats-server on PATH)
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
  settleGoalUncertain,
  goalRefOf,
  submissionFingerprint,
  readGoalResult,
  replayRunJournal,
  readRunRecord,
  newTakeoverId,
  EpEnvelopeError,
  type EpCommandDef,
  type EpServeContext,
  type EpCaller,
  type GoalRef,
} from "@cotal-ai/core";
import { Cancelled, EffectError, type JournalEntry } from "@cotal-ai/lang";
import { MeshHandler, EpfSettleWatcher, startRun, driveRun, migrateRun, commitMigration } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "meshspawn";
const EP = "manager";
const MGR_IID = "m".repeat(26);
const HOLDER = { id: "manager", lifecycleUid: "u_meshspawn" };
const CALLER: EpCaller = { owner: "local", actor: "wf_meshspawn", uid: "a".repeat(26) };

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

// ── broker + planes ────────────────────────────────────────────────────────────────────────────
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-meshspawn-"));
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

// The timer pump, for the one block that races a spawn against a `sleep` (the sleep's expiry
// rides the mediated timer plane, and no delivery daemon runs here).
await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
const wctx = await timerWriterContext(nc, SPACE);
const armPending = async (expect = 4): Promise<void> => {
  for await (const m of await writerC.fetch({ max_messages: expect, expires: 1_200 })) {
    await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
    m.ack();
  }
};

// ── the suite-served manager-shaped goal endpoint ──────────────────────────────────────────────
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
const DESPAWN_INPUT = { type: "object", additionalProperties: false, properties: { graceful: { type: "boolean" } } } as const;
const DESPAWN_OUTPUT = {
  type: "object", additionalProperties: false, required: ["name", "stopped", "graceful"],
  properties: { name: { type: "string" }, stopped: { type: "boolean" }, graceful: { type: "boolean" } },
} as const;

const cc = (root: unknown) => compileContract({ root: root as Record<string, unknown> });
const COMPILED = {
  spawn: { input: cc(SPAWN_INPUT), output: cc(SPAWN_OUTPUT) },
  despawn: { input: cc(DESPAWN_INPUT), output: cc(DESPAWN_OUTPUT) },
};
const DOCUMENT = {
  urn: "ai.cotal.test.spawnmgr", revision: 1, attributes: [], events: [],
  commands: [
    { name: "spawn", class: "ephemeral" as const, targeted: false, capability: "manager.spawn", inputDigest: COMPILED.spawn.input.closureDigest, outputDigest: COMPILED.spawn.output.closureDigest },
    { name: "despawn", class: "ephemeral" as const, targeted: true, modes: ["owner", "any"], capability: "manager.lifecycle", inputDigest: COMPILED.despawn.input.closureDigest, outputDigest: COMPILED.despawn.output.closureDigest },
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
  for (const source of [SPAWN_INPUT, SPAWN_OUTPUT, DESPAWN_INPUT, DESPAWN_OUTPUT]) {
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
// The registration seam reads by the PREFIXED digest (the manager's own reader is an in-memory
// map, and it is the author); the EPC store above is what a resolving CALLER fetches.
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
const acceptances = new Map<string, Record<string, unknown>>();
const spawnInvokes: string[] = [];                       // every spawn submission's goalId, in order
const allocations: Array<{ goalId: string; name: string; owner: string; actor: string; uid: string; persona: string }> = [];
const despawns: Array<{ owner: string; actor: string; lifecycleUid: string; graceful: unknown }> = [];
const mappings = new Map<string, { lifecycleUid: string; mappingRevision: number }>();
const gone = new Set<string>();                          // despawned lifecycleUids → not-found on re-despawn
/** Scripted per-persona outcome; default is a prompt `succeeded`. `readinessMs` narrows the
 *  accepted window (an uncertain settle is refused before the window elapses, SPEC 13.6). */
const OUTCOME: Record<string, { state: "succeeded" | "failed" | "uncertain"; error?: string; reason?: string; delayMs?: number; readinessMs?: number }> = {};
const terminals: Promise<void>[] = [];
let seat = 0;

const spawnHandler = async (ctx: EpServeContext): Promise<unknown> => {
  const args = (ctx.request.args ?? {}) as Record<string, unknown>;
  const persona = String(args.name);
  const goalId = ctx.request.id;
  spawnInvokes.push(goalId);
  const { fingerprint } = submissionFingerprint(ctx.request as unknown, ctx.subject);
  // Idempotent same-goalId retry: the recorded acceptance, never a second allocation.
  const prior = acceptances.get(goalId);
  if (prior !== undefined) {
    if (prior.fingerprint !== fingerprint)
      throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted under a different submission (SPEC 13.6)`);
    return prior;
  }
  // Refuse-at-accept: nothing bound, nothing provisioned.
  if (OUTCOME[persona] === undefined && persona.startsWith("missing"))
    throw new EpEnvelopeError("failed-precondition", `no persona "${persona}" in the catalog`);
  if (OUTCOME[persona] === undefined && persona.startsWith("crowded"))
    throw new EpEnvelopeError("resource-exhausted", `the endpoint's seat capacity is full`);
  const ref = goalRefOf(ctx.subject, goalId);
  const b = await bindGoal(goalCtx, ref, fingerprint);
  if (!b.bound) throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already bound (SPEC 13.6)`);
  const readinessMs = OUTCOME[persona]?.readinessMs ?? 30_000;
  await createGoal(goalCtx, ref, {
    fingerprint, command: "spawn",
    caller: { id: `${ctx.subject.caller.owner}.${ctx.subject.caller.actor}`, lifecycleUid: ctx.subject.caller.uid },
    acceptedEpoch: EXEC_EPOCH, requestId: goalId, sourceSeq: 0, acceptedAt: Date.now(), readinessDeadlineMs: readinessMs,
  });
  seat += 1;
  const name = `${persona}-${seat}`;
  const actor = `seat${seat}`;
  const uid = `s${String(seat).padStart(25, "0")}`;
  allocations.push({ goalId, name, owner: "local", actor, uid, persona });
  mappings.set(`local.${actor}`, { lifecycleUid: uid, mappingRevision: 1 });
  const acceptance = {
    name, owner: "local", actor, uid, goalId, fingerprint, readinessDeadlineMs: readinessMs,
    executor: { lifecycleUid: MGR_IID, epoch: EXEC_EPOCH },
  };
  acceptances.set(goalId, acceptance);
  const script = OUTCOME[persona] ?? { state: "succeeded" as const };
  terminals.push((async () => {
    if (script.delayMs !== undefined) await wait(script.delayMs);
    if (script.state === "uncertain") {
      // The manager's readiness-window verdict: no identity rides the fact — the reason is all.
      await settleGoalUncertain(goalCtx, { ref, now: Date.now(), committer: { instanceId: MGR_IID, epoch: EXEC_EPOCH }, reason: script.reason ?? "the readiness window elapsed" });
      return;
    }
    const data = script.state === "succeeded"
      ? { name, agent: "claude", id: `local.${actor}`, mode: "pty", lifecycleUid: uid }
      : { error: script.error ?? "spawn failed" };
    await commitGoalResult(goalCtx, { ref, now: Date.now(), cause: "complete", state: script.state, data, committer: { instanceId: MGR_IID, epoch: EXEC_EPOCH } });
  })().catch((e) => { console.log("  ! fake terminal commit failed:", (e as Error).message); }));
  return acceptance;
};

const despawnHandler = (ctx: EpServeContext): unknown => {
  const t = ctx.request.target as { owner: string; actor: string; lifecycleUid: string };
  if (gone.has(t.lifecycleUid) || !mappings.has(`${t.owner}.${t.actor}`))
    throw new EpEnvelopeError("not-found", `no agent at ${t.owner}.${t.actor} (${t.lifecycleUid})`);
  gone.add(t.lifecycleUid);
  const graceful = ((ctx.request.args ?? {}) as { graceful?: unknown }).graceful;
  despawns.push({ owner: t.owner, actor: t.actor, lifecycleUid: t.lifecycleUid, graceful });
  return { name: `${t.owner}.${t.actor}`, stopped: true, graceful: graceful !== false };
};

const defs: EpCommandDef[] = [
  { command: "spawn", contract: COMPILED.spawn, handler: spawnHandler },
  { command: "despawn", contract: COMPILED.despawn, handler: despawnHandler },
];
const serve = serveEndpoint(nc, SPACE, grant, defs, { public: true }, {
  resolveTarget: (t) => {
    const m = mappings.get(`${t.owner}.${t.actor}`);
    // A despawned seat keeps no current mapping: the target check answers `expired`, which the
    // suite folds into the same tolerated not-found (the agent is gone either way).
    return m !== undefined && !gone.has(m.lifecycleUid) ? m : undefined;
  },
});

const mk = (runId: string): MeshHandler => new MeshHandler(
  nc, kv, js, jsm,
  { space: SPACE, endpoint: EP, runId, caller: CALLER, instanceId: "i".repeat(26), epoch: 1, holder: HOLDER, defaultCheckpointTimeout: "1h" },
  new EpfSettleWatcher(js, jsm, SPACE, 3_000),
  () => Date.now(),
);
/** A step context as the interpreter hands it over, with the suite's hand on the cancel signal. */
const stepCtx = (requestId: string, resume?: Record<string, unknown>) => {
  const listeners: ((reason: string) => void)[] = [];
  const signal = {
    cancelled: false, reason: undefined as string | undefined,
    onCancel(fn: (reason: string) => void) { listeners.push(fn); },
  };
  const bound: Record<string, unknown> = {};
  const ctx = {
    key: { scope: [], kind: "spawn", name: "", occurrence: 0 },
    requestId, attempt: 0, signal,
    ...(resume !== undefined ? { resume } : {}),
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
/** A drive that FAILS as a graded cell rather than a process kill: a run whose program dies
 *  rethrows out of `startRun`, and an uncaught throw here would end the suite before the named
 *  cell prints — red without being an answer (the bare-call trap). */
const driven = (args: Parameters<typeof startRun>[2]) =>
  startRun(js, jsm, args).catch((e: unknown) => ({ status: "threw" as const, error: `${(e as Error)?.name}: ${(e as Error)?.message?.slice(0, 140)}` }));

/** The run's journal entries of one kind, in append order (pending first, settled after). */
const journalEntries = async (runId: string, kind: string): Promise<JournalEntry[]> => {
  const back = await replayRunJournal(js, jsm, SPACE, runId, newTakeoverId());
  return back.records
    .map((r) => r.record)
    .filter((r) => r.kind === "step")
    .map((r) => (r as { entry: unknown }).entry as JournalEntry)
    .filter((e) => e.kind === kind);
};

// ── 1) a driven program spawns end to end ─────────────────────────────────────────────────────
{
  console.log("• 1 — a driven program spawns end to end");
  const out = await withDeadline(driven({
    space: SPACE, endpoint: EP, kv, runId: "sp-1", lease: lease(),
    source: `const d = await spawn("builder");\nlog("spawned", d.agent);`,
    handler: mk("sp-1"),
  }), 30_000, "the spawning run");
  c("the run completes through the real acceptance and the real terminal", out?.status === "completed", JSON.stringify(out));
  const alloc = allocations[0];
  c("exactly one seat was allocated for exactly one submission",
    allocations.length === 1 && spawnInvokes.length === 1, { allocations: allocations.length, invokes: spawnInvokes.length });

  const entries = await journalEntries("sp-1", "spawn");
  const pending = entries.find((e) => e.state === "pending");
  // The bind is its own durable append: the LAST pending record carries the external state.
  const bound = entries.filter((e) => e.state === "pending").at(-1);
  const settled = entries.find((e) => e.state === "settled");
  const value = settled?.result as { agent?: string; persona?: string } | undefined;
  c("the settled entry records the handle: agent is the name#lifecycleUid composite",
    alloc !== undefined && settled?.status === "ok" && value?.agent === `${alloc.name}#${alloc.uid}`, value?.agent);
  c("the handle carries the persona the program named", value?.persona === "builder", value?.persona);
  c("the goal was bound under the step's own request id: the envelope id IS the goalId",
    pending !== undefined && alloc !== undefined && pending.requestId === alloc.goalId,
    { requestId: pending?.requestId, goalId: alloc?.goalId });
  c("the acceptance floor is bound as the entry's external state before the terminal wait",
    bound?.external?.goalId === bound?.requestId && bound?.external?.name === alloc?.name
      && bound?.external?.actor === alloc?.actor && bound?.external?.uid === alloc?.uid,
    JSON.stringify(bound?.external));
}

// ── 2) an idempotent resubmission is served, never re-allocated ───────────────────────────────
{
  console.log("• 2 — the same pinned id resubmitted is served, not re-allocated");
  const handler = mk("sp-2");
  const T = token("b");
  const first = await withDeadline(handler.spawn({ persona: "builder" }, stepCtx(T).ctx).then((v) => v, (e: unknown) => { console.log("  ! spawn rejected:", (e as Error)?.message?.slice(0, 90)); return undefined; }), 20_000, "the first submission");
  const before = allocations.length;
  const again = await withDeadline(handler.spawn({ persona: "builder" }, stepCtx(T).ctx).then((v) => v, (e: unknown) => { console.log("  ! spawn rejected:", (e as Error)?.message?.slice(0, 90)); return undefined; }), 20_000, "the resubmission");
  c("both submissions return the identical handle", first !== undefined && again?.agent === first.agent,
    { first: first?.agent, again: again?.agent });
  c("the far side saw two submissions and allocated once",
    spawnInvokes.filter((g) => g === T).length === 2 && allocations.length === before,
    { invokes: spawnInvokes.filter((g) => g === T).length, allocations: allocations.length - before });
}

// ── 3) a resume with the bound acceptance does not re-invoke ──────────────────────────────────
{
  console.log("• 3 — a resume with the bound acceptance re-attaches without re-invoking");
  const handler = mk("sp-3");
  const T = token("c");
  await withDeadline(handler.spawn({ persona: "builder" }, stepCtx(T).ctx).then((v) => v, (e: unknown) => { console.log("  ! spawn rejected:", (e as Error)?.message?.slice(0, 90)); return undefined; }), 20_000, "the first attempt");
  const invokesBefore = spawnInvokes.length;
  const resumed = await withDeadline(
    handler.spawn({ persona: "builder" }, stepCtx(T, { goalId: T }).ctx)
      .then((v) => v, (e: unknown) => { console.log("  ! spawn rejected:", (e as Error)?.message?.slice(0, 90)); return undefined; }),
    20_000, "the resumed attempt");
  c("the resumed attempt reads the recorded terminal and returns the same handle",
    resumed?.agent === allocations.find((a) => a.goalId === T)?.name + "#" + allocations.find((a) => a.goalId === T)?.uid,
    resumed?.agent);
  c("the resume sent NOTHING to the endpoint: the recorded acceptance is the submission",
    spawnInvokes.length === invokesBefore, { extra: spawnInvokes.length - invokesBefore });
}

// ── 4) a refusal at accept is the effect's own catchable failure ──────────────────────────────
{
  console.log("• 4 — a refusal at accept is catchable, and binds nothing");
  const before = allocations.length;
  const out = await withDeadline(driven({
    space: SPACE, endpoint: EP, kv, runId: "sp-4", lease: lease(),
    source: `try {\n  await spawn("missing");\n  log("reached", true);\n} catch (e) {\n  log("caught", e.code + ":" + e.kind);\n}`,
    handler: mk("sp-4"),
  }), 30_000, "the refused-spawn run");
  c("the program catches the refusal and the run completes", out?.status === "completed", JSON.stringify(out));
  const settled = (await journalEntries("sp-4", "spawn")).find((e) => e.state === "settled");
  c("the entry settles as the host declining the request: the catchable L4000, kind spawn (no agent existed to be down)",
    settled?.status === "failed" && settled?.error?.code === "L4000" && settled?.error?.kind === "spawn",
    JSON.stringify(settled?.error));
  const crowded = await withDeadline(driven({
    space: SPACE, endpoint: EP, kv, runId: "sp-4b", lease: lease(),
    source: `try {\n  await spawn("crowded");\n  log("reached", true);\n} catch (e) {\n  log("caught", e.code + ":" + e.kind);\n}`,
    handler: mk("sp-4b"),
  }), 30_000, "the capacity-refused run");
  const settledCrowded = (await journalEntries("sp-4b", "spawn")).find((e) => e.state === "settled");
  c("a seat-capacity refusal is the permit the run does not hold: L4001, kind spawn",
    crowded?.status === "completed" && settledCrowded?.status === "failed" && settledCrowded?.error?.code === "L4001" && settledCrowded?.error?.kind === "spawn",
    JSON.stringify({ run: crowded?.status, error: settledCrowded?.error }));
  c("a refuse-at-accept allocated no seat and bound no goal", allocations.length === before, allocations.length - before);
}

// ── 5) a failed terminal carries the manager's own reason ─────────────────────────────────────
{
  console.log("• 5 — a failed terminal is catchable and carries the recorded reason");
  OUTCOME.flaky = { state: "failed", error: "persona exploded" };
  const out = await withDeadline(driven({
    space: SPACE, endpoint: EP, kv, runId: "sp-5", lease: lease(),
    source: `try {\n  await spawn("flaky");\n  log("reached", true);\n} catch (e) {\n  log("caught", e.code);\n}`,
    handler: mk("sp-5"),
  }), 30_000, "the failed-spawn run");
  c("the program catches the failure and the run completes", out?.status === "completed", JSON.stringify(out));
  const settled = (await journalEntries("sp-5", "spawn")).find((e) => e.state === "settled");
  c("the failure is the catchable L4002",
    settled?.status === "failed" && settled?.error?.code === "L4002", JSON.stringify(settled?.error)?.slice(0, 90));
  c("and the message carries the terminal's recorded reason, not a generic line",
    settled?.error?.message.includes("persona exploded") === true, settled?.error?.message?.slice(0, 120));
}

// ── 6) a lost reply whose goal was accepted: the probe attaches ───────────────────────────────
{
  console.log("• 6 — a lost reply: the durable trace is the arbiter");
  // The submission "landed" — the goal is bound and accepted — but the endpoint cannot answer:
  // a fresh handler (no memoized resolve) meets a dead responder. Its invoke fails; the probe
  // finds the goal and proceeds to the terminal.
  const T = token("d");
  const ref: GoalRef = { endpoint: EP, caller: CALLER, goalId: T };
  await bindGoal(goalCtx, ref, "sha256:" + "e".repeat(64));
  await createGoal(goalCtx, ref, {
    fingerprint: "sha256:" + "e".repeat(64), command: "spawn",
    caller: { id: `${CALLER.owner}.${CALLER.actor}`, lifecycleUid: CALLER.uid },
    acceptedEpoch: EXEC_EPOCH, requestId: T, sourceSeq: 0, acceptedAt: Date.now(), readinessDeadlineMs: 30_000,
  });
  await commitGoalResult(goalCtx, {
    ref, now: Date.now(), cause: "complete", state: "succeeded",
    data: { name: "ghost-9", agent: "claude", id: "local.seat999", mode: "pty", lifecycleUid: "s".repeat(26) },
    committer: { instanceId: MGR_IID, epoch: EXEC_EPOCH },
  });
  await serve.stop(); // the responder is DOWN from here on
  const handler = mk("sp-6");
  const got = await withDeadline(handler.spawn({ persona: "ghost" }, stepCtx(T).ctx).then((v) => v, (e: unknown) => { console.log("  ! spawn rejected:", (e as Error)?.message?.slice(0, 90)); return undefined; }), 40_000, "the probe-attached spawn");
  c("the handler attaches to the accepted goal and returns its terminal's handle despite the dead responder",
    got?.agent === `ghost-9#${"s".repeat(26)}`, got?.agent);

  // The other half: no durable trace at all. The raised error is the infrastructure's, never a
  // fabricated L4002 — nothing was accepted, and saying "the spawn failed" would blame the program.
  const T2 = token("f");
  const e = await withDeadline(
    handler.spawn({ persona: "ghost" }, stepCtx(T2).ctx).then(() => null, (x: unknown) => x as Error),
    40_000, "the no-trace spawn");
  c("with no durable trace the invoke's own failure is raised",
    e !== null && e !== undefined && !(e instanceof EffectError), e === null ? "resolved" : e?.name);
}
console.log("  (restarting the suite endpoint for the discharge cells)");
const serve2 = serveEndpoint(nc, SPACE, grant, defs, { public: true }, {
  resolveTarget: (t) => {
    const m = mappings.get(`${t.owner}.${t.actor}`);
    return m !== undefined && !gone.has(m.lifecycleUid) ? m : undefined;
  },
});

// ── 7) cancellation mid-await, and the discharge that releases the seat ───────────────────────
{
  console.log("• 7 — a cancelled spawn's seat is released by the discharge");
  OUTCOME.racer = { state: "succeeded", delayMs: 2_500 };
  const handler = mk("sp-7");
  const T = token("g");
  const s = stepCtx(T);
  const attempt = handler.spawn({ persona: "racer" }, s.ctx);
  // Observed later; a rejection landing before the observer attaches must fail cells, not the process.
  attempt.catch(() => undefined);
  // Cancel once the acceptance is in: the branch lost its race while awaiting the terminal.
  let alloc: typeof allocations[number] | undefined;
  for (let i = 0; i < 100 && alloc === undefined; i += 1) { await wait(100); alloc = allocations.find((a) => a.goalId === T); }
  c("the acceptance landed before the cancel", alloc !== undefined);
  s.cancel("race lost");
  const e = await withDeadline(attempt.then(() => null, (x: unknown) => x as Error), 15_000, "the cancelled await");
  c("the await ends Cancelled within one poll", e instanceof Cancelled, e === null ? "resolved" : e?.name);

  // The world half: the seat exists (the terminal commits succeeded underneath the cancel), and
  // the discharge — handed the loser's entry exactly as the driver hands it — despawns it.
  const entry = {
    kind: "spawn", requestId: T, state: "pending",
    external: { goalId: T, name: alloc?.name, owner: alloc?.owner, actor: alloc?.actor, uid: alloc?.uid, readinessDeadlineMs: 30_000 },
  } as unknown as JournalEntry;
  await withDeadline(handler.discharge([entry]), 20_000, "the discharge");
  const hit = despawns.find((d) => d.lifecycleUid === alloc?.uid);
  c("the discharge despawned exactly the allocated incarnation",
    hit !== undefined && hit.owner === alloc?.owner && hit.actor === alloc?.actor, JSON.stringify(hit));
  c("gracefully — the seat exits clean, it is not a kill", hit?.graceful === true, hit?.graceful);

  // Idempotent: the durable backstop re-runs after a crash mid-sweep, and the seat is already gone.
  const count = despawns.length;
  const again = await withDeadline(handler.discharge([entry]).then(() => null, (x: unknown) => x as Error), 20_000, "the re-discharge");
  c("a second discharge tolerates the already-released seat", again === null, again?.message?.slice(0, 90));
  c("and releases nothing twice", despawns.length === count, despawns.length - count);
}

// ── 8) discharge with NO bound floor: the terminal's own identity is enough ───────────────────
{
  console.log("• 8 — a crash-before-bind loser is still released, from the terminal alone");
  OUTCOME.racer2 = { state: "succeeded" };
  const handler = mk("sp-8");
  const T = token("h");
  await withDeadline(handler.spawn({ persona: "racer2" }, stepCtx(T).ctx).then((v) => v, (e: unknown) => { console.log("  ! spawn rejected:", (e as Error)?.message?.slice(0, 90)); return undefined; }), 20_000, "the seat spawn");
  const alloc = allocations.find((a) => a.goalId === T);
  const bare = { kind: "spawn", requestId: T, state: "pending" } as unknown as JournalEntry;
  await withDeadline(handler.discharge([bare]), 20_000, "the floor-less discharge");
  c("the despawn target was derived from the succeeded terminal's own identity",
    despawns.some((d) => d.lifecycleUid === alloc?.uid && d.actor === alloc?.actor), JSON.stringify(despawns.at(-1)));

  // A loser whose submission never landed: no goal, nothing to release, nothing invented.
  const count = despawns.length;
  const ghost = { kind: "spawn", requestId: token("i"), state: "pending" } as unknown as JournalEntry;
  const e = await withDeadline(handler.discharge([ghost]).then(() => null, (x: unknown) => x as Error), 20_000, "the no-goal discharge");
  c("a never-accepted spawn discharges as a no-op", e === null && despawns.length === count,
    e === null ? despawns.length - count : e?.message?.slice(0, 90));
}

// ── 8b) an uncertain terminal: the bound floor is the ONLY identity, and it is enough ──────────
{
  console.log("• 8b — an uncertain seat is released from the bound acceptance floor");
  // A short accepted window: an uncertain settle is refused BEFORE the window elapses, so the
  // fake's verdict waits it out exactly as the real manager's readiness timer does.
  OUTCOME.hazy = { state: "uncertain", reason: "never joined presence", readinessMs: 1_000, delayMs: 1_300 };
  const handler = mk("sp-8b");
  const T = token("j");
  const e = await withDeadline(
    handler.spawn({ persona: "hazy" }, stepCtx(T).ctx).then(() => null, (x: unknown) => x as Error),
    20_000, "the uncertain spawn");
  c("an uncertain terminal is the catchable spawn failure, carrying the recorded reason",
    e instanceof EffectError && e.code === "L4002" && e.message.includes("never joined presence"),
    e === null ? "resolved" : `${e?.name}: ${e?.message?.slice(0, 90)}`);
  // The verdict left the PROCESS possibly alive, and its fact carries no identity — the entry's
  // bound acceptance floor is the only address the discharge has.
  const alloc = allocations.find((a) => a.goalId === T);
  const entry = {
    kind: "spawn", requestId: T, state: "pending",
    external: { goalId: T, name: alloc?.name, owner: alloc?.owner, actor: alloc?.actor, uid: alloc?.uid, readinessDeadlineMs: 30_000 },
  } as unknown as JournalEntry;
  await withDeadline(handler.discharge([entry]), 20_000, "the uncertain discharge");
  c("the discharge despawns the possibly-live seat by its bound floor",
    alloc !== undefined && despawns.some((d) => d.lifecycleUid === alloc.uid), JSON.stringify(despawns.at(-1)));
}

// ── 9) the real race: the driver's own discharge releases the losing branch's seat ────────────
{
  console.log("• 9 — a losing race branch's seat is released by the driver's own sweep");
  // The seat's terminal lands well after the fast branch wins, so the loser is cancelled while
  // still AWAITING its accepted spawn — the driver's sweep then has to wait the terminal out
  // before it can release the seat, which is exactly the §8.6.4 shape.
  OUTCOME.racer3 = { state: "succeeded", delayMs: 6_000 };
  const source = `
const out = await race({
  seat: async () => {
    const d = await spawn("racer3");
    return d.agent;
  },
  fast: async () => {
    await sleep("2s");
    return "fast";
  },
}, { name: "r" });
log("winner", out.index);
`;
  const pumpState = { over: false };
  const pump = (async () => { while (!pumpState.over) { await armPending(2); } })();
  let out;
  try {
    out = await withDeadline(driven({
      space: SPACE, endpoint: EP, kv, runId: "sp-9", lease: lease(),
      source, handler: mk("sp-9"),
    }), 60_000, "the racing run");
  } finally {
    pumpState.over = true;
    await pump;
  }
  c("the racing run completes", out?.status === "completed", JSON.stringify(out));
  const scope = (await journalEntries("sp-9", "race")).find((e) => e.state === "settled");
  const winner = ((scope?.result as { value?: { index?: unknown } } | undefined)?.value)?.index;
  c("the fast branch wins the race", winner === "fast", JSON.stringify(scope?.result)?.slice(0, 90));
  const alloc = allocations.find((a) => a.persona === "racer3");
  c("the loser's spawn was accepted before the cancel", alloc !== undefined, JSON.stringify(allocations.at(-1)));
  c("and the driver's completion sweep despawned its seat — nobody wrote a cleanup step",
    alloc !== undefined && despawns.some((d) => d.lifecycleUid === alloc.uid), JSON.stringify(despawns.at(-1)));
}

// ── 10) a migration hands a seat to the edited program under --adopt, and tears one down under --release ─
{
  console.log("• 10 — a migrated run adopts the seat its old program spawned, or releases it");
  // The recorded program spawns one seat and pauses. The edit drops that step and spawns the same
  // persona under a NEW name: without an override the seat is a leak (L5003); with `--adopt` the
  // edited program's spawn must receive the recorded seat instead of minting a second one.
  OUTCOME.keeper = { state: "succeeded" };
  // The recorded program parks on a mediated sleep the pump below expires; the edit drops the
  // sleep too, so the migrated program's only step is the spawn that must receive the seat.
  const LIVE = `const d = await spawn("keeper", { name: "old" });\nlog("seat", d.agent);\nawait sleep("12s", { name: "park" });`;
  const EDITED = `const d = await spawn("keeper", { name: "new" });\nlog("seat", d.agent);`;
  const pumpState = { over: false };
  const pump = (async () => { while (!pumpState.over) { await armPending(2); } })();
  const parked = driven({ space: SPACE, endpoint: EP, kv, runId: "sp-10", lease: lease(), source: LIVE, handler: mk("sp-10") });
  parked.catch(() => undefined);
  let alloc: typeof allocations[number] | undefined;
  for (let i = 0; i < 150 && alloc === undefined; i += 1) { await wait(100); alloc = allocations.find((a) => a.persona === "keeper"); }
  // The run parks on the sleep; the seat is up. Its journal is what the migration reads.
  let entries: JournalEntry[] = [];
  for (let i = 0; i < 100 && !entries.some((e) => e.kind === "sleep"); i += 1) {
    await wait(100);
    const back = await replayRunJournal(js, jsm, SPACE, "sp-10", newTakeoverId());
    entries = back.records.filter((r) => r.record.kind === "step").map((r) => (r as { record: { entry: unknown } }).record.entry as JournalEntry);
  }
  const seat = entries.find((e) => e.kind === "spawn" && e.state === "settled");
  const handle = (seat?.result as { agent?: string } | undefined)?.agent ?? "";
  c("the recorded program spawned a seat and parked", alloc !== undefined && handle === `${alloc.name}#${alloc.uid}`, { alloc, handle });
  const record = await readRunRecord(kv, EP, "sp-10");
  const pins = record!.spec.value.pins as unknown as Parameters<typeof migrateRun>[0]["pins"];
  const bare = await migrateRun({ endpoint: EP, runId: "sp-10", source: EDITED, entries, pins, kv, actor: "david", now: () => Date.now() });
  c("the edit orphans the spawn and is refused without an override",
    bare.admissible === false && bare.orphans.some((o) => o.step.includes("spawn:old") && o.code === "L5003"), bare.orphans);
  const report = await migrateRun({ endpoint: EP, runId: "sp-10", source: EDITED, entries, pins, kv, actor: "david", now: () => Date.now(), overrides: { adopt: [handle] } });
  c("--adopt <handle> makes it admissible", report.admissible === true, report.orphans);
  const committed = await commitMigration(kv, EP, report, "driver-10", { entries, handler: mk("sp-10x") });
  c("the migration is filed and applied", committed.created === true && committed.released.length === 0, committed);
  // The parked driver is superseded by the migrated program's driver: a resume under the edited
  // source, whose `spawn("keeper")` must receive the recorded seat.
  const invokesBefore = spawnInvokes.length;
  const allocBefore = allocations.length;
  const resumed = await withDeadline(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "sp-10", source: EDITED, lease: lease(), handler: mk("sp-10r"),
  }).catch((e: unknown) => ({ status: "threw" as const, error: String((e as Error)?.message).slice(0, 160) })), 60_000, "the migrated resume");
  const outcome = await withDeadline(parked, 60_000, "the superseded driver");
  c("the migrated program completes under its new driver, and the parked driver is released when its sleep ends",
    resumed?.status === "completed" && outcome?.status === "released", { outcome: outcome?.status, resumed: resumed?.status });
  const after = (await journalEntries("sp-10", "spawn"));
  const adoptedSpawn = after.find((e) => e.name === "new" && e.state === "settled");
  c("the edited program's spawn settled with the ADOPTED seat's handle, minting nothing",
    (adoptedSpawn?.result as { agent?: string } | undefined)?.agent === handle && spawnInvokes.length === invokesBefore && allocations.length === allocBefore,
    { got: (adoptedSpawn?.result as { agent?: string } | undefined)?.agent, want: handle, invokes: spawnInvokes.length - invokesBefore, allocs: allocations.length - allocBefore });
  const bound = after.filter((e) => e.name === "new" && e.state === "pending").at(-1);
  c("and bound the hand-over on its own entry: the seat's floor plus the step it was adopted from",
    bound?.external?.uid === alloc?.uid && typeof bound?.external?.adoptedFrom === "string" && (bound.external.adoptedFrom as string).includes("spawn:old"),
    JSON.stringify(bound?.external));

  // --release: the same edit, the seat torn down at commit through the run's own discharge.
  OUTCOME.leaver = { state: "succeeded" };
  const LIVE2 = `const d = await spawn("leaver", { name: "old" });\nawait sleep("12s", { name: "park" });`;
  const EDITED2 = `await sleep("12s", { name: "park" });`;
  const parked2 = driven({ space: SPACE, endpoint: EP, kv, runId: "sp-10b", lease: lease(), source: LIVE2, handler: mk("sp-10b") });
  parked2.catch(() => undefined);
  let alloc2: typeof allocations[number] | undefined;
  for (let i = 0; i < 150 && alloc2 === undefined; i += 1) { await wait(100); alloc2 = allocations.find((a) => a.persona === "leaver"); }
  let entries2: JournalEntry[] = [];
  for (let i = 0; i < 100 && !entries2.some((e) => e.kind === "sleep"); i += 1) {
    await wait(100);
    const back = await replayRunJournal(js, jsm, SPACE, "sp-10b", newTakeoverId());
    entries2 = back.records.filter((r) => r.record.kind === "step").map((r) => (r as { record: { entry: unknown } }).record.entry as JournalEntry);
  }
  const handle2 = `${alloc2?.name}#${alloc2?.uid}`;
  const pins2 = (await readRunRecord(kv, EP, "sp-10b"))!.spec.value.pins as unknown as Parameters<typeof migrateRun>[0]["pins"];
  const rel = await migrateRun({ endpoint: EP, runId: "sp-10b", source: EDITED2, entries: entries2, pins: pins2, kv, actor: "david", now: () => Date.now(), overrides: { release: [handle2] } });
  const before2 = despawns.length;
  const done2 = await commitMigration(kv, EP, rel, "driver-10b", { entries: entries2, handler: mk("sp-10b-commit") });
  c("committing a --release migration despawns the orphaned seat through the run's discharge, gracefully",
    done2.released.includes(handle2) && despawns.slice(before2).some((d) => d.lifecycleUid === alloc2?.uid && d.graceful === true),
    { released: done2.released, despawned: despawns.slice(before2) });
  await withDeadline(parked2, 60_000, "the released run's parked driver");
  pumpState.over = true;
  await pump;
}

await serve2.stop();
await Promise.allSettled(terminals);
await nc.drain().catch(() => undefined);
const EXPECTED_CELLS = 41;
const ran = ok + fail;
console.log(`mesh-spawn.smoke: ${ok} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
