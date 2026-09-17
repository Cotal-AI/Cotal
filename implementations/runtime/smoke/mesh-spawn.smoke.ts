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
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  resolveService,
  replayRunJournal,
  readRunRecord,
  newTakeoverId,
  EpEnvelopeError,
  type EpCommandDef,
  type ResolvedService,
  type EpServeContext,
  type EpCaller,
  type GoalRef,
} from "@cotal-ai/core";
import { Cancelled, EffectError, type JournalEntry } from "@cotal-ai/lang";
import { MeshHandler, EpfSettleWatcher, startRun, driveRun, migrateRun, commitMigration, canonicalCwd } from "../src/index.js";
// Package imports, not sibling source paths: this package's typecheck pins rootDir to its own tree,
// so a source import from another package fails TS6059. The fixture entries that mutate core or
// lang source therefore rebuild that package before the suite runs and after the restore.
import { runMediatorGrants, PLACEMENT_COMMANDS } from "@cotal-ai/core";
import { PRIMITIVES } from "@cotal-ai/lang";
import { pickFreePort } from "./_free-port.js";

const SPACE = "meshspawn";
const EP = "manager";
const MGR_IID = "m".repeat(26);
/** #1616: a host-local cwd is only meaningful against a named instance. This is the suite manager. */
const PLACE = { endpoint: EP, instanceId: MGR_IID } as const;
const HOLDER = { id: "manager", lifecycleUid: "u_meshspawn" };
const CALLER: EpCaller = { owner: "local", actor: "wf_meshspawn", uid: "a".repeat(26) };

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withDeadline = async <T>(p: Promise<T>, ms: number, what: string): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); });
  try {
    // A rejection is a named failure, never an escape: a mutant that makes the handler throw must
    // red the cell that called it, not kill the process before the completion marker prints.
    const got = await Promise.race([
      p.then((v) => ({ v })).catch((e: unknown) => ({ threw: `${(e as Error)?.name}: ${(e as Error)?.message?.slice(0, 200)}` })),
      late,
    ]);
    if (got === undefined) { fail++; console.log(`  ✗ FAIL: ${what} did not end within ${ms}ms`); return undefined; }
    if ("threw" in got) { fail++; console.log(`  ✗ FAIL: ${what} threw`, got.threw); return undefined; }
    return got.v;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

// ── broker + planes ────────────────────────────────────────────────────────────────────────────
const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-meshspawn-"));
const managerRoot = join(sd, "manager-root");
const preparedRoot = join(sd, "prepared-writer");
const makeRepo = (dir: string, marker: string): string => {
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "mesh-spawn@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "mesh-spawn smoke"], { cwd: dir });
  writeFileSync(join(dir, "marker"), marker);
  execFileSync("git", ["add", "marker"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", marker], { cwd: dir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
};
const managerHead = makeRepo(managerRoot, "manager");
const preparedHead = makeRepo(preparedRoot, "prepared");
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
    cwd: { type: "string" },
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

/** #1616 item 5, PHASE A. The serving manager answers about ITS OWN filesystem: the caller cannot,
 *  and a caller that guesses is the fail-open path this command replaces. */
const RESOLVE_CWD_INPUT = {
  type: "object", additionalProperties: false, required: ["cwd"],
  properties: { cwd: { type: "string", minLength: 1 } },
} as const;
const RESOLVE_CWD_OUTPUT = {
  type: "object", additionalProperties: false, required: ["cwd", "host"],
  properties: { cwd: { type: "string" }, host: { type: "string" } },
} as const;

const cc = (root: unknown) => compileContract({ root: root as Record<string, unknown> });
const COMPILED = {
  spawn: { input: cc(SPAWN_INPUT), output: cc(SPAWN_OUTPUT) },
  despawn: { input: cc(DESPAWN_INPUT), output: cc(DESPAWN_OUTPUT) },
  "resolve-cwd": { input: cc(RESOLVE_CWD_INPUT), output: cc(RESOLVE_CWD_OUTPUT) },
};
const DOCUMENT = {
  urn: "ai.cotal.test.spawnmgr", revision: 1, attributes: [], events: [],
  commands: [
    { name: "spawn", class: "ephemeral" as const, targeted: false, capability: "manager.spawn", inputDigest: COMPILED.spawn.input.closureDigest, outputDigest: COMPILED.spawn.output.closureDigest },
    { name: "despawn", class: "ephemeral" as const, targeted: true, modes: ["owner", "any"], capability: "manager.lifecycle", inputDigest: COMPILED.despawn.input.closureDigest, outputDigest: COMPILED.despawn.output.closureDigest },
    { name: "resolve-cwd", class: "ephemeral" as const, targeted: false, capability: "manager.spawn", inputDigest: COMPILED["resolve-cwd"].input.closureDigest, outputDigest: COMPILED["resolve-cwd"].output.closureDigest },
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
  for (const source of [SPAWN_INPUT, SPAWN_OUTPUT, DESPAWN_INPUT, DESPAWN_OUTPUT, RESOLVE_CWD_INPUT, RESOLVE_CWD_OUTPUT]) {
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
const placements: Array<{ goalId: string; cwd: string; head: string }> = [];
/** #1616 item 5: what phase A was ASKED and what this host ANSWERED, and the cwd phase B then
 *  dispatched. The pair is how a cell tells "the manager stated the canonical form" apart from
 *  "the caller guessed it and happened to be on the same box". */
const resolves: Array<{ asked: string; answered: string | null }> = [];
const dispatchedCwds: string[] = [];
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
  if (args.cwd !== undefined &&
      (typeof args.cwd !== "string" || !existsSync(args.cwd) || !statSync(args.cwd).isDirectory()))
    throw new EpEnvelopeError("failed-precondition", `cwd is not an existing directory: ${JSON.stringify(args.cwd)}`);
  if (typeof args.cwd === "string") dispatchedCwds.push(args.cwd);
  if (persona === "placed") {
    const observed = join(sd, `placement-${goalId}.json`);
    const child = spawnProc(process.execPath, ["-e", `const {execFileSync}=require('node:child_process');const {writeFileSync}=require('node:fs');writeFileSync(${JSON.stringify(observed)},JSON.stringify({cwd:process.cwd(),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()}))`], {
      cwd: typeof args.cwd === "string" ? args.cwd : managerRoot,
      stdio: "ignore",
    });
    const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    if (exit !== 0) throw new EpEnvelopeError("failed-precondition", `placement probe exited ${String(exit)}`);
    const actual = JSON.parse(readFileSync(observed, "utf8")) as { cwd: string; head: string };
    placements.push({ goalId, ...actual });
  }
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

/** #1616 item 5, the phase-A responder. It is the manager side on purpose: `canonicalCwd` runs
 *  against THIS process's filesystem, which is the one the child will be launched on. A path that
 *  does not resolve here is refused here; there is no form of it the caller may still dispatch. */
const resolveCwdHandler = (ctx: EpServeContext): unknown => {
  const asked = String(((ctx.request.args ?? {}) as { cwd?: unknown }).cwd);
  let answered: string;
  try {
    answered = canonicalCwd(asked);
  } catch (e) {
    resolves.push({ asked, answered: null });
    throw new EpEnvelopeError("failed-precondition", `cwd does not resolve on this host: ${JSON.stringify(asked)} (${(e as Error).message})`);
  }
  resolves.push({ asked, answered });
  return { cwd: answered, host: "mesh-spawn-smoke-host" };
};

const defs: EpCommandDef[] = [
  { command: "spawn", contract: COMPILED.spawn, handler: spawnHandler },
  { command: "despawn", contract: COMPILED.despawn, handler: despawnHandler },
  { command: "resolve-cwd", contract: COMPILED["resolve-cwd"], handler: resolveCwdHandler },
];
const serve = serveEndpoint(nc, SPACE, grant, defs, { public: true }, {
  resolveTarget: (t) => {
    const m = mappings.get(`${t.owner}.${t.actor}`);
    // A despawned seat keeps no current mapping: the target check answers `expired`, which the
    // suite folds into the same tolerated not-found (the agent is gone either way).
    return m !== undefined && !gone.has(m.lifecycleUid) ? m : undefined;
  },
});

/**
 * A SECOND (or third) live instance of the same endpoint, served from this process under its own
 * identity and its own host label. #1616's matrix needs more than one manager to say anything at
 * all about pinning: with a single instance serving, a route that ignores the target reaches the
 * same place as a route that honours it, and a broken pin is indistinguishable from a working one.
 *
 * It serves `resolve-cwd` and `spawn` only — the two commands a placed spawn uses. Its books are
 * its own, which is what lets a cell say WHICH manager answered rather than only that one did.
 */
interface ExtraManager {
  readonly instanceId: string;
  readonly host: string;
  /** Phase-A asks this instance answered, in order. */
  readonly resolves: Array<{ asked: string; answered: string | null }>;
  /** Phase-B submissions this instance accepted, by goalId. */
  readonly invokes: string[];
  stop(): Promise<void>;
}
const extraManager = async (instanceId: string, host: string): Promise<ExtraManager> => {
  const gate = serveIssuanceGateKv(authKv, SPACE, { endpoint: EP, instanceId });
  await provisionEndpointGateOpen(authKv, { endpoint: EP, instanceId, principal: "local.mgr" });
  await registerServiceInstance(kv, {
    space: SPACE,
    spec: { endpoint: EP, owner: "local", clusterDigests: [CLOSURE_DIGEST], protocol: { v: 1 } },
    instanceId, registrant: { owner: "local" },
    authority,
    barrier: endpointRegistrationBarrier(authKv, SPACE, { endpoint: EP, instanceId, opId: instanceId }),
    readClusterArtifact,
  });
  const seen = await gate.observe();
  if (seen === null) throw new Error(`the extra instance ${instanceId} lost its issuance gate after registration`);
  const epoch = seen.processEpoch;
  const g = await authorizeServeGrant(kv, {
    space: SPACE, endpoint: EP, instanceId, epoch,
    holder: { owner: "local" }, authority, readProcessEpoch: () => epoch, readClusterArtifact,
  });
  const resolvesHere: Array<{ asked: string; answered: string | null }> = [];
  const invokesHere: string[] = [];
  const resolveHere = (ctx: EpServeContext): unknown => {
    const asked = String(((ctx.request.args ?? {}) as { cwd?: unknown }).cwd);
    let answered: string;
    try {
      answered = canonicalCwd(asked);
    } catch (err) {
      resolvesHere.push({ asked, answered: null });
      throw new EpEnvelopeError("failed-precondition", `cwd does not resolve on ${host}: ${JSON.stringify(asked)} (${(err as Error).message})`);
    }
    resolvesHere.push({ asked, answered });
    return { cwd: answered, host };
  };
  const spawnHere = async (ctx: EpServeContext): Promise<unknown> => {
    const args = (ctx.request.args ?? {}) as Record<string, unknown>;
    const goalId = ctx.request.id;
    invokesHere.push(goalId);
    const { fingerprint } = submissionFingerprint(ctx.request as unknown, ctx.subject);
    if (args.cwd !== undefined && (typeof args.cwd !== "string" || !existsSync(args.cwd) || !statSync(args.cwd).isDirectory()))
      throw new EpEnvelopeError("failed-precondition", `cwd is not an existing directory: ${JSON.stringify(args.cwd)}`);
    const ref = goalRefOf(ctx.subject, goalId);
    const b = await bindGoal(goalCtx, ref, fingerprint);
    if (!b.bound) throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already bound (SPEC 13.6)`);
    await createGoal(goalCtx, ref, {
      fingerprint, command: "spawn",
      caller: { id: `${ctx.subject.caller.owner}.${ctx.subject.caller.actor}`, lifecycleUid: ctx.subject.caller.uid },
      acceptedEpoch: epoch, requestId: goalId, sourceSeq: 0, acceptedAt: Date.now(), readinessDeadlineMs: 30_000,
    });
    seat += 1;
    const actor = `seat${seat}`;
    const uid = `s${String(seat).padStart(25, "0")}`;
    const name = `${String(args.name)}-${seat}`;
    mappings.set(`local.${actor}`, { lifecycleUid: uid, mappingRevision: 1 });
    terminals.push((async () => {
      await commitGoalResult(goalCtx, {
        ref, now: Date.now(), cause: "complete", state: "succeeded",
        data: { name, agent: "claude", id: `local.${actor}`, mode: "pty", lifecycleUid: uid },
        committer: { instanceId, epoch },
      });
    })().catch((err) => { console.log(`  ! ${host} terminal commit failed:`, (err as Error).message); }));
    return {
      name, owner: "local", actor, uid, goalId, fingerprint, readinessDeadlineMs: 30_000,
      executor: { lifecycleUid: instanceId, epoch },
    };
  };
  // Every granted ephemeral command needs a def or `serveEndpoint` refuses the table (SPEC 13.9),
  // so `despawn` rides the suite's shared handler and the shared seat mappings with it.
  const handle = serveEndpoint(nc, SPACE, g, [
    { command: "spawn", contract: COMPILED.spawn, handler: spawnHere },
    { command: "despawn", contract: COMPILED.despawn, handler: despawnHandler },
    { command: "resolve-cwd", contract: COMPILED["resolve-cwd"], handler: resolveHere },
  ] as EpCommandDef[], { public: true }, {
    resolveTarget: (t) => {
      const m = mappings.get(`${t.owner}.${t.actor}`);
      return m !== undefined && !gone.has(m.lifecycleUid) ? m : undefined;
    },
  });
  return { instanceId, host, resolves: resolvesHere, invokes: invokesHere, stop: () => handle.stop() };
};

/** The DRIVER's own instance id: the process running the program, never the one serving `manager`. */
const DRIVER_IID = "i".repeat(26);
/** A CLI-held run, shaped like `cliHolder()` in run-command.ts: a holder that is not a manager. */
const CLI_IID = "c".repeat(26);
const CLI_HOLDER = { id: "cli-run-3f9ab210", lifecycleUid: "u_cli_meshspawn" };
const mkAs = (runId: string, holder: { id: string; lifecycleUid: string }, instanceId: string): MeshHandler => new MeshHandler(
  nc, kv, js, jsm,
  { space: SPACE, endpoint: EP, runId, caller: CALLER, instanceId, epoch: 1, holder, defaultCheckpointTimeout: "1h" },
  new EpfSettleWatcher(jsm, SPACE, 3_000),
  () => Date.now(),
);
const mk = (runId: string): MeshHandler => mkAs(runId, HOLDER, DRIVER_IID);
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
    // REPLACES, because the real journal does: `bind` writes `{ ...entry, external }`, so a second
    // bind drops every fact the first one held rather than merging over it. Merging here made the
    // harness kinder than the journal and let a dropped re-statement read as green.
    bind: async (facts: Record<string, unknown>) => {
      for (const k of Object.keys(bound)) delete bound[k];
      Object.assign(bound, facts);
    },
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

// ── 3b) explicit placement launches in the prepared repository and resumes in place ───────────
{
  console.log("• 3b — explicit cwd places the child and is recovered, not repeated");
  const T = token("p");
  const handler = mk("sp-3b");
  const firstCtx = stepCtx(T);
  const first = await withDeadline(handler.spawn({ persona: "placed", cwd: preparedRoot, placement: PLACE }, firstCtx.ctx), 20_000, "the placed spawn");
  const placed = placements.find((p) => p.goalId === T);
  c("the child process cwd is the prepared clone, distinct from the manager root",
    first !== undefined && placed !== undefined && realpathSync(placed.cwd) === realpathSync(preparedRoot)
      && realpathSync(placed.cwd) !== realpathSync(managerRoot),
    { placed, managerRoot });
  c("the child repository head is the requested prepared revision, not the manager revision",
    placed?.head === preparedHead && placed.head !== managerHead,
    { placed: placed?.head, preparedHead, managerHead });
  const invokesBefore = spawnInvokes.length;
  const launchesBefore = placements.length;
  const resumed = await withDeadline(handler.spawn({ persona: "placed", cwd: preparedRoot, placement: PLACE }, stepCtx(T, firstCtx.bound).ctx), 20_000, "the placed resume");
  c("resume returns the same lifecycle without another submission or child process",
    resumed?.agent === first?.agent && spawnInvokes.length === invokesBefore && placements.length === launchesBefore,
    { first: first?.agent, resumed: resumed?.agent, invokes: spawnInvokes.length - invokesBefore, launches: placements.length - launchesBefore });
}

// ── 3c) malformed and missing placement refuse before allocation, never falling back ──────────
{
  console.log("• 3c — bad cwd values refuse without fallback");
  const handler = mk("sp-3c");
  const invokesBefore = spawnInvokes.length;
  const allocationsBefore = allocations.length;
  const launchesBefore = placements.length;
  const malformed = await handler.spawn({ persona: "placed", cwd: "relative/writer", placement: PLACE }, stepCtx(token("v")).ctx)
    .then(() => undefined, (e: unknown) => e as EffectError);
  c("a malformed cwd is an explicit catchable refusal before manager submission",
    malformed instanceof EffectError && malformed.code === "L4000" && /absolute directory/.test(malformed.message), malformed?.message);
  const absent = join(sd, "does-not-exist");
  const missing = await handler.spawn({ persona: "placed", cwd: absent, placement: PLACE }, stepCtx(token("x")).ctx)
    .then(() => undefined, (e: unknown) => e as EffectError);
  // #1616 item 5, THE FAILURE DIRECTION. Killed by M25 "an unresolvable cwd falls back to the raw
  // string": with the fallback restored the refusal never happens here, the submission goes out
  // carrying the caller's guess, and the count cell below moves off zero.
  c("a cwd the target cannot resolve is refused L4000 by the target's own resolution, with no raw-path fallback",
    missing instanceof EffectError && missing.code === "L4000"
      && /was not resolved by manager instance/.test(missing.message)
      && resolves.at(-1)?.asked === absent && resolves.at(-1)?.answered === null, missing?.message);
  // ZERO submissions now, where the pre-phase-A code submitted one and let the manager refuse it:
  // an unresolvable path never reaches a spawn submission at all. The non-zero control for this
  // same counter is the aliased placed spawn in §1, which asserts `+ 1` on the identical reader.
  c("neither bad path leaves a fallback seat, partial allocation, or child",
    spawnInvokes.length === invokesBefore && allocations.length === allocationsBefore && placements.length === launchesBefore,
    { invokes: spawnInvokes.length - invokesBefore, allocations: allocations.length - allocationsBefore, launches: placements.length - launchesBefore });
}

// ── 3d) #1616 THE AFFINITY GATE: a host-local cwd needs an explicit, pinned target ────────────
{
  console.log("• 3d — a cwd with no target refuses; a placed spawn is pinned to the named instance");
  const handler = mk("sp-3d");
  const invokesBefore = spawnInvokes.length;
  const allocationsBefore = allocations.length;
  const launchesBefore = placements.length;
  // ITEM 2. Killed by M18 "the affinity gate is disarmed": with the gate removed this request rides
  // the class queue, is accepted, allocates and launches a child — so both halves of this cell fail.
  const untargeted = await handler.spawn({ persona: "placed", cwd: preparedRoot }, stepCtx(token("g")).ctx)
    .then(() => undefined, (e: unknown) => e as EffectError);
  c("a cwd with no placement target refuses before any describe, allocation or child, with no anycast fallback",
    untargeted instanceof EffectError && untargeted.code === "L4000"
      && /no placement target/.test(untargeted.message)
      && spawnInvokes.length === invokesBefore && allocations.length === allocationsBefore
      && placements.length === launchesBefore,
    { msg: untargeted?.message, invokes: spawnInvokes.length - invokesBefore,
      allocations: allocations.length - allocationsBefore, launches: placements.length - launchesBefore });
  // ITEM 3, dispatch half. Killed by M19 "pinned dispatch falls back to the class handle": with the
  // instanceId dropped from the resolve, this WRONG instance id resolves through the class `one`
  // queue that the real manager still answers, the spawn SUCCEEDS and a child launches.
  const wrongBefore = placements.length;
  const wrong = await withDeadline(
    handler.spawn({ persona: "placed", cwd: preparedRoot, placement: { endpoint: EP, instanceId: "w".repeat(26) } },
      stepCtx(token("w")).ctx).then(() => null, (x: unknown) => x as Error),
    30_000, "the wrong-instance placed spawn");
  c("a placed spawn pinned to a wrong instance refuses and never falls back to the class queue",
    wrong !== null && wrong !== undefined && placements.length === wrongBefore,
    { err: wrong === null ? "resolved" : String((wrong as Error)?.message ?? wrong).slice(0, 140),
      launches: placements.length - wrongBefore });
  // ITEM 3, identity half, THE TABLE'S HALF ONLY. This reads `PRIMITIVES.spawn`, so it grades the
  // TABLE: that the option is declared and declared hashed. It is deliberately NOT the cell any
  // mutant of the projection names, because it cannot be: deleting the projection in `perform.ts`
  // leaves this assertion evaluating to `true`, measured. The BEHAVIOUR that the table describes is
  // graded by the live retargeted replay in row 5 of 3e below, and that is what the re-anchored
  // M20 reddens. Two cells, because the table and the projection are two things that can disagree.
  c("the placement target is hashed into the step identity beside cwd, so a retarget diverges",
    PRIMITIVES.spawn.hashedOptions.includes("placement") && PRIMITIVES.spawn.hashedOptions.includes("cwd")
      && PRIMITIVES.spawn.options.includes("placement"),
    { hashed: PRIMITIVES.spawn.hashedOptions });
  // ITEM 5, PHASE A. Killed by M24 "the driver dispatches req.cwd without asking the host": phase A
  // never runs, so `resolves` does not grow and the manager receives the caller's ALIAS instead of
  // the realpath it would have stated. The two halves are the whole point of A2 — the alias is what
  // the host was ASKED, the realpath is what the host ANSWERED and what phase B then dispatched, so
  // the canonical form is demonstrably the target's statement and not the caller's guess.
  const aliasLink = join(mkdtempSync(join(realpathSync(tmpdir()), "sp-alias-")), "prepared");
  execFileSync("ln", ["-s", preparedRoot, aliasLink]);
  const realPrepared = realpathSync(preparedRoot);
  const resolvesBefore = resolves.length;
  const aliasInvokesBefore = spawnInvokes.length;
  const aliased = await withDeadline(
    handler.spawn({ persona: "placed", cwd: aliasLink, placement: PLACE }, stepCtx(token("y")).ctx)
      .then((v) => v, (e: unknown) => { console.log("  ! aliased placed spawn rejected:", (e as Error)?.message?.slice(0, 120)); return undefined; }),
    30_000, "the aliased placed spawn");
  c("phase A asks the SERVING host and phase B dispatches that host's answer, so an alias reaches the manager as its realpath",
    aliased !== undefined && resolves.length === resolvesBefore + 1
      && resolves.at(-1)?.asked === aliasLink && resolves.at(-1)?.answered === realPrepared
      && dispatchedCwds.at(-1) === realPrepared && aliasLink !== realPrepared
      && spawnInvokes.length === aliasInvokesBefore + 1,
    { asked: resolves.at(-1)?.asked, answered: resolves.at(-1)?.answered, dispatched: dispatchedCwds.at(-1),
      resolved: resolves.length - resolvesBefore, invokes: spawnInvokes.length - aliasInvokesBefore });
  // The resolution is PERSISTED, not just used: a resume reads the directory the host stated rather
  // than re-asking a target that may have moved. Killed by M26 "the acceptance bind drops the
  // resolution", which is the wholesale-replace bug `journal.bind` makes easy to write.
  const aliasCtx = stepCtx(token("z"));
  await withDeadline(
    handler.spawn({ persona: "placed", cwd: aliasLink, placement: PLACE }, aliasCtx.ctx)
      .then((v) => v, () => undefined), 30_000, "the second aliased placed spawn");
  const boundRes = aliasCtx.bound.resolution as { cwd?: unknown; endpoint?: unknown; instanceId?: unknown; host?: unknown } | undefined;
  c("the step journal keeps the canonical directory beside the identity that stated it",
    boundRes?.cwd === realPrepared && boundRes.endpoint === EP && boundRes.instanceId === MGR_IID
      && boundRes.host === "mesh-spawn-smoke-host",
    { bound: boundRes });
  rmSync(aliasLink, { force: true });
}

// ── 3e) #1616 THE ACCEPTANCE MATRIX (design record line 106) ──────────────────────
// The five rows the record asks for that the wrong-instance cell in 3d does not reach: whose
// identity resolves a placement, two managers that are BOTH up, an instance that is gone, an
// instance that was replaced at the same host, and a replay whose target was edited. Every row
// here runs against live serving instances; none of them reads a table.
{
  console.log("• 3e — the acceptance matrix: identities, two live managers, unavailable vs replaced, replay");
  OUTCOME.roamer = { state: "succeeded" };

  // ROW 1 — DISTINCT CLI HOLDER AND MANAGER IDENTITIES.
  // The run is held by a CLI-shaped holder on its own instance id; the manager that serves the
  // endpoint is a third identity. The resolution has to name the instance that ANSWERED, read off
  // the attributed reply, not the caller that asked — otherwise a driver on a different filesystem
  // signs its own guess with the manager's name. Killed by M27 "the resolution records the
  // driver's own instance id" (`instanceId: this.binding.instanceId` in `resolveCwd`).
  const cliHandler = mkAs("sp-3e1", CLI_HOLDER, CLI_IID);
  const idCtx = stepCtx(token("A"));
  const held = await withDeadline(
    cliHandler.spawn({ persona: "roamer", cwd: preparedRoot, placement: PLACE }, idCtx.ctx)
      .then((v) => v, (e: unknown) => { console.log("  ! the CLI-held placed spawn rejected:", (e as Error)?.message?.slice(0, 120)); return undefined; }),
    30_000, "the CLI-held placed spawn");
  const heldRes = idCtx.bound.resolution as { cwd?: unknown; endpoint?: unknown; instanceId?: unknown; host?: unknown } | undefined;
  const heldGoal = allocations.find((a) => a.name === held?.agent?.split("#")[0])?.goalId;
  c("a CLI-held run places onto a manager that is a different identity in every field, and the resolution names the MANAGER that answered",
    held !== undefined && CLI_IID !== MGR_IID && CLI_HOLDER.lifecycleUid !== HOLDER.lifecycleUid
      && heldRes?.instanceId === MGR_IID && heldRes.endpoint === EP && heldRes.host === "mesh-spawn-smoke-host"
      && acceptances.get(heldGoal ?? "")?.executor !== undefined
      && (acceptances.get(heldGoal ?? "")?.executor as { lifecycleUid?: string } | undefined)?.lifecycleUid === MGR_IID,
    { cli: CLI_IID, driverHolder: CLI_HOLDER.lifecycleUid, resolution: heldRes,
      executor: acceptances.get(heldGoal ?? "")?.executor });

  // ROW 2 — TWO AVAILABLE MANAGERS, DETERMINISTIC PINNING.
  // Both instances serve the same endpoint at the same time, so "it worked" no longer implies "it
  // went where it was told". ONE handler places three seats A → B → A and every one of them must
  // resolve and submit on the instance it named, in that order, with the other instance's books
  // untouched each time. Killed by M28 "the pinned service handle is memoized across spawns"
  // (`this.managerService ??= resolveService(..., { instanceId })`): the B-pinned spawn then reuses
  // A's handle, B's books stay empty and this cell reddens on the first re-pin, deterministically.
  const MGR_B = await extraManager("b".repeat(26), "mesh-spawn-smoke-host-b");
  const PLACE_B = { endpoint: EP, instanceId: MGR_B.instanceId } as const;
  const twoHandler = mkAs("sp-3e2", CLI_HOLDER, CLI_IID);
  const trail: Array<{ pinned: string; aResolves: number; bResolves: number; aInvokes: number; bInvokes: number; answered: unknown }> = [];
  for (const [tag, place, want] of [["B1", PLACE, MGR_IID], ["B2", PLACE_B, MGR_B.instanceId], ["B3", PLACE, MGR_IID]] as const) {
    const a0 = resolves.length, b0 = MGR_B.resolves.length, ai0 = spawnInvokes.length, bi0 = MGR_B.invokes.length;
    const ctx = stepCtx(token(tag[0] === "B" ? tag[1] : tag[0]));
    await withDeadline(
      twoHandler.spawn({ persona: "roamer", cwd: preparedRoot, placement: place }, ctx.ctx)
        .then((v) => v, (e: unknown) => { console.log(`  ! the ${want} placed spawn rejected:`, (e as Error)?.message?.slice(0, 120)); return undefined; }),
      30_000, `the placed spawn pinned to ${want.slice(0, 4)}`);
    trail.push({
      pinned: want, aResolves: resolves.length - a0, bResolves: MGR_B.resolves.length - b0,
      aInvokes: spawnInvokes.length - ai0, bInvokes: MGR_B.invokes.length - bi0,
      answered: (ctx.bound.resolution as { instanceId?: unknown; host?: unknown } | undefined),
    });
  }
  const wentTo = (row: typeof trail[number], mine: number, theirs: number): boolean =>
    row.aResolves === mine && row.aInvokes === mine && row.bResolves === theirs && row.bInvokes === theirs;
  c("with two managers serving at once, each placed spawn resolves AND submits on the instance it named, in both directions and back again",
    trail.length === 3
      && wentTo(trail[0]!, 1, 0) && wentTo(trail[1]!, 0, 1) && wentTo(trail[2]!, 1, 0)
      && (trail[0]!.answered as { host?: unknown } | undefined)?.host === "mesh-spawn-smoke-host"
      && (trail[1]!.answered as { host?: unknown } | undefined)?.host === MGR_B.host
      && (trail[2]!.answered as { host?: unknown } | undefined)?.host === "mesh-spawn-smoke-host",
    trail);

  // ROW 3 — THE PINNED INSTANCE IS UNAVAILABLE.
  // B was demonstrably up one cell ago (row 2 is this row's positive control: the same two readers
  // that must stay at zero here were +1 there). It is now down, while A is still up and still
  // serving the class rail. The pin must refuse, and must not quietly become A. Killed by M29 "a
  // pinned resolve that fails falls back to the class handle"
  // (`resolveService(..., { instanceId }).catch(() => this.manager())`): the request then lands on
  // A, succeeds, and both halves of this cell fail.
  await MGR_B.stop();
  const downA0 = resolves.length, downAi0 = spawnInvokes.length, downAlloc0 = allocations.length;
  const down = await withDeadline(
    twoHandler.spawn({ persona: "roamer", cwd: preparedRoot, placement: PLACE_B }, stepCtx(token("D")).ctx)
      .then(() => null, (e: unknown) => e as Error),
    45_000, "the spawn pinned to a stopped instance");
  c("a placed spawn pinned to an instance that is no longer serving refuses, and never retargets the manager that is still up",
    down !== null && down !== undefined
      && resolves.length === downA0 && spawnInvokes.length === downAi0 && allocations.length === downAlloc0,
    { err: down === null ? "resolved" : String((down as Error)?.message ?? down).slice(0, 140),
      aResolves: resolves.length - downA0, aInvokes: spawnInvokes.length - downAi0, aAllocs: allocations.length - downAlloc0 });

  // ROW 4 — THE PINNED INSTANCE WAS REPLACED.
  // Not the same row as row 3. Here somebody IS serving at B's host label — a successor instance,
  // the shape a restarted manager takes — and the old pin still must not reach it, because the pin
  // names an identity and not a host. Killed by the same M29, which makes the stale pin fall
  // through to whichever instance answers the class rail.
  const MGR_C = await extraManager("d".repeat(26), MGR_B.host);
  const repA0 = resolves.length, repAi0 = spawnInvokes.length, repC0 = MGR_C.invokes.length;
  const stale = await withDeadline(
    twoHandler.spawn({ persona: "roamer", cwd: preparedRoot, placement: PLACE_B }, stepCtx(token("E")).ctx)
      .then(() => null, (e: unknown) => e as Error),
    45_000, "the spawn pinned to a replaced instance");
  c("a placed spawn pinned to a REPLACED instance refuses and never reaches the successor serving that same host",
    stale !== null && stale !== undefined
      && MGR_C.resolves.length === 0 && MGR_C.invokes.length === repC0
      && resolves.length === repA0 && spawnInvokes.length === repAi0,
    { err: stale === null ? "resolved" : String((stale as Error)?.message ?? stale).slice(0, 140),
      successorResolves: MGR_C.resolves.length, successorInvokes: MGR_C.invokes.length - repC0 });
  // The positive control for the row above: the successor was reachable AT THAT MOMENT, so the
  // refusal was about the identity in the pin and not about the host being unusable. Without this
  // cell, a successor that simply never came up would score the row green.
  const freshCtx = stepCtx(token("F"));
  const fresh = await withDeadline(
    twoHandler.spawn({ persona: "roamer", cwd: preparedRoot, placement: { endpoint: EP, instanceId: MGR_C.instanceId } }, freshCtx.ctx)
      .then((v) => v, (e: unknown) => { console.log("  ! the successor-pinned spawn rejected:", (e as Error)?.message?.slice(0, 120)); return undefined; }),
    30_000, "the successor-pinned placed spawn");
  c("and the successor was live at that moment: pinned by its OWN id the same spawn succeeds on it",
    fresh !== undefined && MGR_C.resolves.length === 1 && MGR_C.invokes.length === repC0 + 1
      && (freshCtx.bound.resolution as { instanceId?: unknown; host?: unknown } | undefined)?.instanceId === MGR_C.instanceId
      && (freshCtx.bound.resolution as { host?: unknown } | undefined)?.host === MGR_B.host,
    { agent: fresh?.agent, resolution: freshCtx.bound.resolution, successorInvokes: MGR_C.invokes.length - repC0 });

  // ROW 5 — A TARGET EDIT ON AN ACTUAL REPLAY.
  // Not the static `hashedOptions` check in 3d: a real run is driven, its spawn settles on A, and
  // the SAME run id is then re-driven from a source whose only edit is the placement instance id.
  // The interpreter's journal lookup must call that divergence rather than replay A's recorded
  // resolution under B's name. Killed by M20 "the placement target is dropped from the step-identity
  // PROJECTION", which deletes the `placement` spread from the spawn projection in
  // `packages/lang/src/perform.ts`: the two hashes then match, the recorded entry replays, and
  // nothing diverges. The mutant used to remove `"placement"` from `hashedOptions` in
  // `primitives.ts` instead and name the STATIC cell in 3d, which reads that same array back — one
  // metadata array graded against itself, able to pass while this replay was broken.
  const place5 = (iid: string) => `{ endpoint: ${JSON.stringify(EP)}, instanceId: ${JSON.stringify(iid)} }`;
  const prog5 = (iid: string) => `const d = await spawn("roamer", { name: "pinned", cwd: ${JSON.stringify(preparedRoot)}, placement: ${place5(iid)} });\nlog("seat", d.agent);\nawait sleep("8s", { name: "park" });`;
  const parked = driven({ space: SPACE, endpoint: EP, kv, runId: "sp-3e", lease: lease(), source: prog5(MGR_IID), handler: mk("sp-3e") });
  parked.catch(() => undefined);
  let recorded: JournalEntry[] = [];
  for (let i = 0; i < 200 && !recorded.some((e) => e.state === "settled"); i += 1) {
    await wait(100);
    recorded = await journalEntries("sp-3e", "spawn");
  }
  const settled5 = recorded.find((e) => e.state === "settled");
  c("the recorded program placed its seat on the first manager and parked, so there is a real entry to replay",
    settled5?.status === "ok" && settled5.name === "pinned"
      && (recorded.filter((e) => e.state === "pending").at(-1)?.external?.resolution as { instanceId?: unknown } | undefined)?.instanceId === MGR_IID,
    { status: settled5?.status, name: settled5?.name, entries: recorded.length });
  const bInvokesBefore = MGR_C.invokes.length;
  const retarget = await withDeadline(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "sp-3e", source: prog5(MGR_C.instanceId), lease: lease(), handler: mk("sp-3e"),
  }).then(() => undefined, (e: unknown) => e as Error), 60_000, "the retargeted replay");
  const dmsg = String((retarget as Error | undefined)?.message ?? "");
  const rec5 = /recorded\s+(sha256:[0-9a-f]+)/.exec(dmsg)?.[1];
  const prg5 = /program\s+(sha256:[0-9a-f]+)/.exec(dmsg)?.[1];
  c("a replay whose ONLY edit is the placement instance id diverges at the recorded spawn step, with two different input hashes and nothing dispatched to the new target",
    retarget !== undefined && /INPUT CHANGED/.test(dmsg) && /spawn:pinned/.test(dmsg)
      && rec5 !== undefined && prg5 !== undefined && rec5 !== prg5
      && MGR_C.invokes.length === bInvokesBefore,
    { name: (retarget as Error | undefined)?.name, recorded: rec5, program: prg5,
      dispatched: MGR_C.invokes.length - bInvokesBefore, msg: dmsg.slice(0, 160) });

  // Both extra instances go down before the suite's later sections, which stop the ONE endpoint
  // they know about and then assert that nobody answers.
  await MGR_C.stop();
}

// ── 3f) an unpinned spawn survives the class-queue split (#1638) ──────────────────────────────
{
  console.log("• 3f — an unpinned spawn survives a not-executed bind refusal");
  // A run resolves the manager on the CLASS rail and binds the incarnation that answered its
  // describe. The invoke is a second, independent trip through the same anycast queue, so with two
  // managers up it routinely reaches the other member, which refuses BEFORE dispatching (SPEC 13.2:
  // `not-executed`, no effect of the command exists). Raised as L4000 that refusal ends the run and
  // consumes its id, which is the composition #1638 reports: honest per command, destructive per run.

  // THE SPLIT FORCED, NOT AWAITED. Which member wins the queue is the run's luck, so an arm that
  // waits for a split can decline to grade. The handler's memoized class handle is rewritten to bind
  // an incarnation nothing is serving, the same device the manager's describe-split probe uses, so
  // every responder is the wrong one and the refusal is guaranteed. Only one instance is serving
  // here, so the re-issue's re-resolve can land nowhere else: the arm is deterministic on both tips,
  // red before the repair and green after it.
  const UNSERVED_IID = "z".repeat(26);
  const forced = mk("sp-3f");
  const real = await resolveService(nc, SPACE, EP, CALLER);
  (forced as unknown as { managerService?: Promise<ResolvedService> }).managerService =
    Promise.resolve({ ...real, responder: { instanceId: UNSERVED_IID, epoch: real.responder.epoch } });
  // Read back through the handler, not the local literal: this is what proves the memo the handler
  // will actually send from was rewritten, rather than a copy. If it is ever false the cells below
  // are measuring an unforced spawn.
  const armed = await (forced as unknown as { managerService: Promise<ResolvedService> }).managerService;
  c("the forced arm is installed: the handler's class handle binds an incarnation nothing serves",
    armed.responder.instanceId === UNSERVED_IID && UNSERVED_IID !== MGR_IID,
    { bound: armed.responder.instanceId, serving: MGR_IID });
  const fAlloc0 = allocations.length, fInvoke0 = spawnInvokes.length;
  const repaired = await withDeadline(
    forced.spawn({ persona: "builder" }, stepCtx(token("q")).ctx)
      .then((v) => v, (e: unknown) => { console.log("  ! the unpinned spawn rejected:", (e as Error)?.message?.slice(0, 170)); return undefined; }),
    45_000, "the unpinned spawn under a guaranteed bind refusal");
  c("an unpinned spawn refused as not-executed is re-issued and returns a handle, instead of failing the run",
    repaired !== undefined, { agent: repaired?.agent });
  // The refusal states that nothing ran, so a re-issue is a FIRST attempt and must leave exactly one
  // seat. A repair that duplicated the effect would be worse than the failure it replaces, and the
  // refused attempt reached no handler at all, so the far side must have seen ONE submission.
  c("the repair submitted once and allocated one seat: a re-issue after a not-executed refusal is not a second attempt",
    allocations.length === fAlloc0 + 1 && spawnInvokes.length === fInvoke0 + 1,
    { allocations: allocations.length - fAlloc0, submissions: spawnInvokes.length - fInvoke0 });

  // THE NATURAL FACE, through the ordinary entry point. The arm above proves the repair answers a
  // bind this suite installed; this one proves the class rail produces that bind on its own, with
  // two live instances and nothing rewritten. Every attempt gets its own handler, so every attempt
  // pays its own describe and draws the queue afresh.
  const MGR_D = await extraManager("e".repeat(26), "mesh-spawn-smoke-host-d");
  const N = 12;
  const nA0 = spawnInvokes.length, nD0 = MGR_D.invokes.length;
  let served = 0, rejected = 0;
  for (let i = 0; i < N; i += 1) {
    const v = await withDeadline(
      mk(`sp-3f-${i}`).spawn({ persona: "builder" }, stepCtx(token(`q${i}`)).ctx)
        .then((x) => x, () => undefined),
      45_000, `the unpinned spawn ${i}`);
    if (v !== undefined) served += 1; else rejected += 1;
  }
  const submissions = (spawnInvokes.length - nA0) + (MGR_D.invokes.length - nD0);
  console.log(`     ${N} unpinned spawns, two managers serving: ${served} returned a handle, ${rejected} did not; ${spawnInvokes.length - nA0} landed on A, ${MGR_D.invokes.length - nD0} on B`);
  // CONSERVATION, which holds on any correct tip: a refusal that says nothing ran must have
  // submitted nothing, and a handle must be backed by one submission. It is the guard the repair
  // must not break; the split rate printed above is what the repair moves.
  c("with two managers serving, every unpinned spawn is accounted for: one submission per handle returned, and a refused attempt submits nothing",
    served + rejected === N && submissions === served,
    { served, rejected, submissions, N });
  // The positive control for the row above: without it a tip where the queue happened to send all
  // twelve to one member would score it green while proving nothing about a multi-instance space.
  c("and the class queue really did spread across both members, so the split condition was present rather than assumed",
    spawnInvokes.length > nA0 && MGR_D.invokes.length > nD0,
    { a: spawnInvokes.length - nA0, b: MGR_D.invokes.length - nD0 });
  await MGR_D.stop();
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
  const allocationsBeforeUnavailable = allocations.length;
  const placementsBeforeUnavailable = placements.length;
  const e = await withDeadline(
    handler.spawn({ persona: "ghost", cwd: preparedRoot, placement: PLACE }, stepCtx(T2).ctx).then(() => null, (x: unknown) => x as Error),
    40_000, "the no-trace spawn");
  c("an unavailable manager raises the invoke's own explicit failure for a cwd request",
    e !== null && e !== undefined && !(e instanceof EffectError), e === null ? "resolved" : e?.name);
  c("the unavailable-manager refusal leaves no fallback allocation or placement child",
    allocations.length === allocationsBeforeUnavailable && placements.length === placementsBeforeUnavailable,
    { allocations: allocations.length - allocationsBeforeUnavailable, placements: placements.length - placementsBeforeUnavailable });
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
  // source, whose `spawn("keeper")` must receive the recorded seat. The new handler
  // is still bound to sp-10; its run id cannot be renamed to label a second process.
  const invokesBefore = spawnInvokes.length;
  const allocBefore = allocations.length;
  const resumed = await withDeadline(driveRun(js, jsm, {
    space: SPACE, endpoint: EP, kv, runId: "sp-10", source: EDITED, lease: lease(), handler: mk("sp-10"),
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
  // A CRASH AFTER THE BIND, BEFORE THE SETTLE. The successor step re-enters with the bound state
  // and nothing else: the migration's hand-over is spent (the bound `adoptedFrom` says so), so a
  // resume that did not read the bound goal as its own would mint a second seat for a persona it
  // was already handed one for. The bound goal is the orphaned spawn's, and that is the one it reads.
  const invokesBeforeResume = spawnInvokes.length;
  const reentered = await withDeadline(
    mk("sp-10z").spawn({ persona: "keeper" }, stepCtx(bound?.requestId ?? "", bound?.external as Record<string, unknown>).ctx)
      .then((v) => v, (e: unknown) => ({ agent: `threw: ${String((e as Error)?.message).slice(0, 120)}` })),
    20_000, "the adopted spawn's resume");
  c("a resume of the adopted spawn after its bind re-reads the adopted goal and submits nothing",
    reentered?.agent === handle && spawnInvokes.length === invokesBeforeResume, { got: reentered?.agent, want: handle, invokes: spawnInvokes.length - invokesBeforeResume });
  // AND ITS DISCHARGE RELEASES THE SEAT. A cancelled adopted spawn holds a seat whose goal was never
  // minted under this step's request id; the discharge despawns by the goal the entry bound.
  const despawnsBefore = despawns.length;
  await withDeadline(mk("sp-10d").discharge([bound!]).then(() => "ok", (e: unknown) => `threw: ${String((e as Error)?.message).slice(0, 120)}`), 30_000, "the adopted spawn's discharge");
  c("a cancelled adopted spawn's discharge despawns the seat it holds, by the bound goal",
    despawns.slice(despawnsBefore).some((d) => d.lifecycleUid === alloc?.uid), { despawned: despawns.slice(despawnsBefore), want: alloc?.uid });

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

// ---------------------------------------------------------------------------------------------
// #1616 item B — TARGET-BOUND MEDIATOR AUTHORIZATION, and item C — alias normalization.
// Pure over the grant builder and the normalizer: no broker reach is needed to prove the SHAPE of
// what would be minted, and shape is exactly what the design bounds.
{
  const GSPACE = "grant-space";
  const GTAKE = newTakeoverId();
  const legacy = runMediatorGrants(GSPACE, { endpoint: EP, runId: "sp-g1", takeoverId: GTAKE, instanceId: "abcdefghijklmnopqrstuvwxyz", epoch: 1 }, "01234567890123456789012");
  const pinned = runMediatorGrants(GSPACE, { endpoint: EP, runId: "sp-g1", takeoverId: GTAKE, instanceId: "abcdefghijklmnopqrstuvwxyz", epoch: 1, placement: { instanceId: "zyxwvutsrqponmlkjihgfedcba" } }, "01234567890123456789012");
  const added = pinned.publish.filter((r) => !legacy.publish.includes(r));
  const instRows = added.filter((r) => r.includes(".inst."));
  // Item B, grant present: naming a target mints the inst rail for EXACTLY describe, resolve-cwd
  // and spawn on the one validated instance. Killed by M8 (removes `resolve-cwd` from the set).
  c("an explicit placement target mints the instance rail for exactly describe, resolve-cwd and spawn",
    added.length === 3 && instRows.length === 3
      && PLACEMENT_COMMANDS.every((cmd) => instRows.some((r) => r.includes(`.inst.${EP}.zyxwvutsrqponmlkjihgfedcba.${cmd}.`))),
    { added });
  // Item B, reach bounded: no class-anycast row, no wildcard instance, no second instance, and the
  // legacy cwd-omitted profile is byte-identical. Killed by M9 (restores the class `one` route).
  c("placement reach adds no anycast fallback, no wildcard and no second instance, and legacy grants are unchanged",
    added.every((r) => r.includes(".inst.") && !r.includes(".one.") && !r.includes(".all.")
      && !r.includes(".inst.*") && !r.includes("abcdefghijklmnopqrstuvwxyz"))
      && legacy.publish.filter((r) => r.includes(".inst.")).length === 0,
    { added, legacyInst: legacy.publish.filter((r) => r.includes(".inst.")) });
  // Item C, proof item 5: two physical aliases of ONE clone collapse to a single identity, and the
  // canonical form is the REALPATH — what the child's own process.cwd() reports. This is the rule
  // the phase-A responder applies ON THE SERVING HOST (see resolveCwdHandler); the driver no longer
  // calls it. Killed by M10.
  const aliasReal = mkdtempSync(join(realpathSync(tmpdir()), "sp-alias-"));
  const aliasLink = join(mkdtempSync(join(realpathSync(tmpdir()), "sp-link-")), "clone");
  execFileSync("ln", ["-s", aliasReal, aliasLink]);
  c("a symlinked clone and its realpath normalize to one identity, canonical form is the realpath",
    canonicalCwd(aliasLink) === canonicalCwd(aliasReal) && canonicalCwd(aliasLink) === aliasReal
      && aliasLink !== aliasReal,
    { link: aliasLink, real: aliasReal, canonical: canonicalCwd(aliasLink) });
  rmSync(aliasReal, { recursive: true, force: true });
  rmSync(aliasLink, { force: true });
}

await serve2.stop();
await Promise.allSettled(terminals);
await nc.drain().catch(() => undefined);
const EXPECTED_CELLS = 70;
const ran = ok + fail;
console.log(`mesh-spawn.smoke: ${ok} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  process.exit(1);
}
process.exit(fail === 0 ? 0 : 1);
