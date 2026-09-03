/**
 * `ask` on the real planes: a schema-checked pause the addressed agent answers.
 *
 * Each attempt is one checkpoint-plane pause answered through the run driver's own
 * `resolveCheckpoint` — the door `cotal run answer` uses — so every driven block here answers
 * through the REAL answer path, stepKey in, current attempt's token out. The handler-side §6.5
 * contract is the load-bearing surface: the shorthand is enforced (L4022 for a schema it cannot
 * read), a non-conforming answer costs one attempt and its refusal reason is bound onto the entry
 * for the answerer to read, attempts default to ONE (spec, not the design's three), exhaustion is
 * the catchable L4006, and so is the one absolute deadline for the whole ask elapsing (its kind
 * is `ask-deadline`): no conforming record within the budget, whichever budget ran out.
 *
 * Recovery is the same derivation story as every other pause: attempt N's token derives from the
 * step's request id, the CURRENT attempt rides the entry's external state as `askToken`, a resume
 * re-enters the attempt in flight (re-judging a settle that landed just before the crash), and a
 * cancelled ask's armed attempt is the one the discharge ends.
 *
 * Run: pnpm smoke:runtime-mesh-ask   (needs nats-server on PATH)
 */
import { createHash } from "node:crypto";
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
  readCheckpointSpec,
  readCheckpointSettle,
  recordCheckpointAnswer,
  checkpointAnswerId,
  resumeCheckpoint,
  replayRunJournal,
  newTakeoverId,
  presenceBucket,
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
  goalRefOf,
  submissionFingerprint,
  EpEnvelopeError,
  type CheckpointRef,
  type EpCaller,
  type EpCommandDef,
  type EpServeContext,
  type Presence,
} from "@cotal-ai/core";
import { Cancelled, journalEntryKeyString, type JournalEntry } from "@cotal-ai/lang";
import { MeshHandler, EpfSettleWatcher, startRun, resolveCheckpoint, outstandingPauseTokens } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const SPACE = "meshask";
const EP = "manager";
const MGR_IID = "m".repeat(26);
const HOLDER = { id: "manager", lifecycleUid: "u_meshask" };
const CALLER: EpCaller = { owner: "local", actor: "wf_meshask", uid: "a".repeat(26) };

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
const sd = mkdtempSync(join(tmpdir(), "cotal-meshask-"));
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
// The liveness registry a spawn's readiness reads; a row lives until deleted.
const presenceKv = await new Kvm(nc).create(presenceBucket(SPACE));

// ── the suite-served manager-shaped goal endpoint (spawn + turn) ───────────────────────────────
// An ask is TOLD to its agent over the turn relay, so the suite serves the manager's shape for
// spawn (the roster registration, the seat's address) and turn (the relay's accept), records every
// relay it is handed, and can refuse one at accept the way the real manager refuses a gone seat.
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
  urn: "ai.cotal.test.askmgr", revision: 1, attributes: [], events: [],
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

/** Every relay the endpoint was handed, as submitted: the ask's payload is what the seat reads. */
const turnInvokes: Array<{ goalId: string; payload: string; deadlineMs: number; target: { owner: string; actor: string; lifecycleUid: string } }> = [];
const turnAccepts = new Map<string, Record<string, unknown>>();
/** Cell knob: refuse the next relay at accept, the way the real manager refuses a gone seat. */
let refuseNextTurn: EpEnvelopeError | undefined;

const turnHandler = async (ctx: EpServeContext): Promise<unknown> => {
  const args = (ctx.request.args ?? {}) as Record<string, unknown>;
  const goalId = ctx.request.id;
  const t = ctx.request.target as { owner: string; actor: string; lifecycleUid: string };
  turnInvokes.push({ goalId, payload: String(args.payload), deadlineMs: Number(args.deadlineMs), target: { owner: t.owner, actor: t.actor, lifecycleUid: t.lifecycleUid } });
  const { fingerprint } = submissionFingerprint(ctx.request as unknown, ctx.subject);
  const prior = turnAccepts.get(goalId);
  if (prior !== undefined) {
    if (prior.fingerprint !== fingerprint) throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted under a different submission (SPEC 13.6)`);
    return prior;
  }
  if (refuseNextTurn !== undefined) {
    const refusal = refuseNextTurn;
    refuseNextTurn = undefined;
    throw refusal;
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
  return acceptance;
};

const defs: EpCommandDef[] = [
  { command: "spawn", contract: COMPILED.spawn, handler: spawnHandler },
  { command: "turn", contract: COMPILED.turn, handler: turnHandler },
];
const serve = serveEndpoint(nc, SPACE, grant, defs, { public: true }, {
  resolveTarget: (t) => mappings.get(`${t.owner}.${t.actor}`),
});

// The timer pump, for the expiry block (an ask attempt's deadline rides the mediated timer plane).
await jsm.consumers.add(eptReqStreamName(SPACE), timerWriterConsumerConfig(SPACE, { ackWaitMs: 5_000 }));
const writerC = await js.consumers.get(eptReqStreamName(SPACE), timerWriterDurable(SPACE));
const wctx = await timerWriterContext(nc, SPACE);
const armPending = async (expect = 4): Promise<void> => {
  for await (const m of await writerC.fetch({ max_messages: expect, expires: 1_200 })) {
    await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
    m.ack();
  }
};

const mk = (runId: string): MeshHandler => new MeshHandler(
  nc, kv, js, jsm,
  { space: SPACE, endpoint: EP, runId, caller: CALLER, instanceId: "i".repeat(26), epoch: 1, holder: HOLDER, defaultCheckpointTimeout: "1h" },
  new EpfSettleWatcher(js, jsm, SPACE, 3_000),
  () => Date.now(),
);
const stepCtx = (requestId: string, resume?: Record<string, unknown>) => {
  const listeners: ((reason: string) => void)[] = [];
  const signal = {
    cancelled: false, reason: undefined as string | undefined,
    onCancel(fn: (reason: string) => void) { listeners.push(fn); },
  };
  const bound: Record<string, unknown> = {};
  const ctx = {
    key: { scope: [], kind: "ask", name: "size", occurrence: 0 },
    requestId, attempt: 0, signal,
    ...(resume !== undefined ? { resume } : {}),
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
const driven = (args: Parameters<typeof startRun>[2]) =>
  startRun(js, jsm, args).catch((e: unknown) => ({ status: "threw" as const, error: `${(e as Error)?.name}: ${(e as Error)?.message?.slice(0, 140)}` }));

/** The run's ask entries, last record per key, in append order. */
const askEntries = async (runId: string): Promise<JournalEntry[]> => {
  const back = await replayRunJournal(js, jsm, SPACE, runId, newTakeoverId());
  const last = new Map<string, JournalEntry>();
  for (const r of back.records) {
    if (r.record.kind !== "step") continue;
    const e = (r.record as { entry: unknown }).entry as JournalEntry;
    if (e.kind === "ask") last.set(journalEntryKeyString(e), e);
  }
  return [...last.values()];
};

/** Wait until the run's ask entry is pending AT the given attempt, then return it. */
const openAskAt = async (runId: string, attempt: number, patienceMs = 15_000): Promise<JournalEntry | undefined> => {
  const until = Date.now() + patienceMs;
  for (;;) {
    for (const e of await askEntries(runId)) {
      const at = typeof e.external?.attempt === "number" ? e.external.attempt : 1;
      if (e.state === "pending" && at === attempt) return e;
    }
    if (Date.now() > until) return undefined;
    await wait(150);
  }
};

/** Answer the run's open ask through the run driver's OWN door, retrying the mint-in-flight
 *  window (the bind lands before the pause's record does). A failure is LOGGED, never thrown:
 *  an unanswerable ask must fail the block's named cells, not kill the process before they
 *  print (the bare-call trap). */
const answerRun = async (runId: string, attempt: number, value: unknown, by = "dev-1"): Promise<void> => {
  const entry = await openAskAt(runId, attempt);
  if (entry === undefined) {
    console.log(`  ! answer failed: run ${runId} has no open ask at attempt ${attempt}`);
    return;
  }
  const stepKey = journalEntryKeyString(entry);
  for (let i = 0; ; i += 1) {
    try {
      await resolveCheckpoint({ kv, js, jsm, space: SPACE, endpoint: EP }, { runId, stepKey, by, value, now: Date.now() });
      return;
    } catch (e) {
      if (i >= 40) {
        console.log(`  ! answer failed: ${(e as Error)?.message?.slice(0, 120)}`);
        return;
      }
      await wait(150);
    }
  }
};

/** Answer one attempt token directly — the handler-level door, same primitives the resolver uses.
 *  A failure is LOGGED, never thrown: the block's named cells are the verdict, and a mutant that
 *  never opens the pause must not kill the process before they print (the bare-call trap). */
const answerToken = async (tok: unknown, value: unknown, by = "dev-1"): Promise<void> => {
  if (typeof tok !== "string") {
    console.log(`  ! answer failed: no pause token to answer (${String(tok)})`);
    return;
  }
  const ref: CheckpointRef = { endpoint: EP, token: tok };
  for (let i = 0; ; i += 1) {
    const spec = await readCheckpointSpec(kv, ref);
    if (spec !== undefined) {
      const answerId = checkpointAnswerId({ token: tok, by, value });
      await recordCheckpointAnswer(kv, EP, { v: 1, token: tok, answerId, value, by, at: Date.now() });
      await resumeCheckpoint(kv, js, jsm, SPACE, { ref, presenter: spec.holder, now: Date.now(), answerId })
        .catch((e: unknown) => { console.log(`  ! answer failed: ${(e as Error)?.message?.slice(0, 120)}`); });
      return;
    }
    if (i >= 60) {
      console.log(`  ! answer failed: no pause record ever appeared for ${tok}`);
      return;
    }
    await wait(150);
  }
};

/** Grade a rejection as a value rather than a process kill (the bare-call trap). */
const safe = (p: Promise<unknown>): Promise<unknown> =>
  p.catch((e: unknown) => ({ threw: true, name: (e as Error)?.name, code: (e as { code?: string })?.code, kind: (e as { kind?: string })?.kind, message: (e as Error)?.message ?? String(e) }));
/** Spawn one seat through the handler under test, so the roster registration is the real path. */
const spawnSeat = async (handler: MeshHandler, tag: string, persona = "dev"): Promise<{ agent: string; persona: string }> => {
  const got = await withDeadline(safe(handler.spawn({ persona }, stepCtx(token(tag)).ctx)), 20_000, `the ${persona} spawn`);
  if (got !== undefined && typeof (got as { agent?: unknown }).agent === "string") return got as { agent: string; persona: string };
  console.log("  ! spawn did not yield a handle:", JSON.stringify(got));
  return { agent: `unspawned#${"z".repeat(26)}`, persona };
};
/** The settled spawn entry a recovering run would read for this handle: what `adopted` seeds. */
const spawnEntryFor = (runId: string, handle: { agent: string; persona: string }): JournalEntry => {
  const alloc = allocations.find((a) => `${a.name}#${a.uid}` === handle.agent);
  if (alloc === undefined) throw new Error(`no allocation for ${handle.agent}`);
  return {
    v: 1, seq: 1, run: runId, scope: "", kind: "spawn", name: alloc.persona, occurrence: 0,
    inputHash: "sha256:0", requestId: alloc.goalId, state: "settled", status: "ok",
    result: handle,
    external: { goalId: alloc.goalId, name: alloc.name, owner: alloc.owner, actor: alloc.actor, uid: alloc.uid },
  } as unknown as JournalEntry;
};
/** The relay the endpoint was handed for one attempt token, parsed. */
const relayOf = (tok: unknown): { invoke?: (typeof turnInvokes)[number]; ask?: Record<string, unknown>; run?: unknown; step?: unknown; count: number } => {
  const mine = turnInvokes.filter((i) => i.goalId === tok);
  const invoke = mine[0];
  if (invoke === undefined) return { count: 0 };
  const p = JSON.parse(invoke.payload) as { ask?: Record<string, unknown>; run?: unknown; step?: unknown };
  return { invoke, ask: p.ask, run: p.run, step: p.step, count: mine.length };
};

// ── 1) a driven ask end to end, answered through the run driver's door ─────────────────────────
{
  console.log("• 1 — a driven ask is answered through resolveCheckpoint and returns the record");
  const drv = driven({
    space: SPACE, endpoint: EP, kv, runId: "ak-1", lease: lease(),
    source: `const a = await spawn("dev");\nconst v = await ask(a, { name: "size", schema: { estimate: "number" } });\nlog("got", v.estimate);`,
    handler: mk("ak-1"),
  });
  await answerRun("ak-1", 1, { estimate: 3, note: "t-shirt" });
  const out = await withDeadline(drv, 30_000, "the asking run");
  c("the run completes", (out as { status?: string } | undefined)?.status === "completed", JSON.stringify(out));
  const entry = (await askEntries("ak-1")).find((e) => e.state === "settled");
  const value = entry?.result as { estimate?: unknown; note?: unknown } | undefined;
  c("the settled entry records the whole answered record, extra fields included",
    entry?.status === "ok" && value?.estimate === 3 && value?.note === "t-shirt", JSON.stringify(entry?.result));
  const pending = (await (async () => {
    const back = await replayRunJournal(js, jsm, SPACE, "ak-1", newTakeoverId());
    return back.records.filter((r) => r.record.kind === "step")
      .map((r) => (r.record as { entry: unknown }).entry as JournalEntry)
      .filter((e) => e.kind === "ask" && e.state === "pending");
  })()).at(-1);
  c("attempt 1 is bound with its own request id as the pause token, and the one absolute deadline",
    pending?.external?.attempt === 1 && pending?.external?.askToken === pending?.requestId
      && typeof pending?.external?.deadlineAt === "number",
    JSON.stringify(pending?.external));
  const relay = relayOf(pending?.external?.askToken);
  c("the agent was TOLD: the attempt rode the turn relay under its own token, pinned to the spawned seat's incarnation",
    relay.count === 1 && relay.invoke?.target.lifecycleUid === allocations[0]?.uid && relay.run === "ak-1" && String(relay.step).includes("ask:size"),
    JSON.stringify({ count: relay.count, target: relay.invoke?.target, run: relay.run, step: relay.step }));
  c("the relayed payload carries the ask itself: token, schema, attempt 1 of 1 and the one absolute deadline",
    relay.ask?.token === pending?.external?.askToken && JSON.stringify(relay.ask?.schema) === JSON.stringify({ estimate: "number" })
      && relay.ask?.attempt === 1 && relay.ask?.attempts === 1 && relay.ask?.deadlineAt === pending?.external?.deadlineAt && relay.ask?.refused === undefined,
    JSON.stringify(relay.ask));
}

// ── 2) a non-conforming answer costs one attempt, and the refusal is bound for the answerer ────
{
  console.log("• 2 — a refused answer re-asks with the validation error on the entry");
  const drv = driven({
    space: SPACE, endpoint: EP, kv, runId: "ak-2", lease: lease(),
    source: `const a = await spawn("dev");\nconst v = await ask(a, { name: "size", schema: { estimate: "number", tags: "array" }, attempts: 2 });\nlog("got", v.estimate);`,
    handler: mk("ak-2"),
  });
  await answerRun("ak-2", 1, { estimate: "big", tags: [] });
  const second = await openAskAt("ak-2", 2);
  c("a second attempt opens under a DERIVED token, not the request id",
    typeof second?.external?.askToken === "string" && second.external.askToken !== second.requestId,
    JSON.stringify(second?.external));
  c("the refusal names the field and the kind it wants, judged by the same check that refused it",
    typeof second?.external?.refused === "string" && second.external.refused.includes('"estimate" wants number'),
    second?.external?.refused);
  const relay2 = relayOf(second?.external?.askToken);
  c("attempt 2 is relayed under its derived token, and the seat is told why its last answer was refused",
    relay2.count === 1 && relay2.ask?.attempt === 2 && relay2.ask?.attempts === 2
      && typeof relay2.ask?.refused === "string" && String(relay2.ask?.refused).includes('"estimate" wants number'),
    JSON.stringify(relay2.ask));
  await answerRun("ak-2", 2, { estimate: 7, tags: ["s"] });
  const out = await withDeadline(drv, 30_000, "the re-asked run");
  c("the conforming second answer completes the run", (out as { status?: string } | undefined)?.status === "completed", JSON.stringify(out));
  const entry = (await askEntries("ak-2")).find((e) => e.state === "settled");
  c("the entry settles ok on the second attempt's answer",
    entry?.status === "ok" && (entry?.result as { estimate?: unknown } | undefined)?.estimate === 7,
    JSON.stringify(entry?.result));
}

// ── 3) attempts default to ONE (spec), and exhaustion is the catchable L4006 ───────────────────
{
  console.log("• 3 — the default is one attempt, and exhaustion is L4006");
  const drv = driven({
    space: SPACE, endpoint: EP, kv, runId: "ak-3", lease: lease(),
    source: `const a = await spawn("dev");\ntry {\n  await ask(a, { name: "size", schema: { estimate: "number" } });\n  log("reached", true);\n} catch (e) {\n  log("caught", e.code);\n}`,
    handler: mk("ak-3"),
  });
  await answerRun("ak-3", 1, { estimate: "big" });
  const out = await withDeadline(drv, 15_000, "the exhausted ask run");
  const entries = await askEntries("ak-3");
  const attempts = entries.map((e) => (typeof e.external?.attempt === "number" ? e.external.attempt : 1));
  c("the default is one attempt: no second pause was opened",
    (out as { status?: string } | undefined)?.status === "completed" && Math.max(...attempts, 1) === 1,
    { out: JSON.stringify(out), attempts });
  if ((out as { status?: string } | undefined)?.status !== "completed") {
    // A mutant that widened the default leaves the run parked on attempt 2 — drain it so nothing
    // floats past this block, then let the cells above stand as the verdict.
    await answerRun("ak-3", 2, { estimate: 1 }).catch(() => undefined);
    await answerRun("ak-3", 3, { estimate: 1 }).catch(() => undefined);
    await withDeadline(drv, 30_000, "the drained mutant run");
  }
  const settled = entries.find((e) => e.state === "settled");
  c("the entry settles as the ask effect's own catchable L4006",
    settled?.status === "failed" && settled?.error?.code === "L4006" && settled?.error?.kind === "ask-nonconforming",
    JSON.stringify(settled?.error)?.slice(0, 120));
  c("and the failure carries the last refusal, so the record says WHY nothing conformed",
    settled?.error?.message?.includes('"estimate" wants number') === true, settled?.error?.message?.slice(0, 160));
}

// ── 4) a schema the shorthand cannot read is refused loudly, before any pause exists ───────────
{
  console.log("• 4 — an unreadable schema is L4022, with nothing armed");
  const out = await withDeadline(driven({
    space: SPACE, endpoint: EP, kv, runId: "ak-4", lease: lease(),
    source: `const a = await spawn("dev");\ntry {\n  await ask(a, { name: "size", schema: { estimate: "float" } });\n  log("reached", true);\n} catch (e) {\n  log("caught", e.code);\n}`,
    handler: mk("ak-4"),
  }), 30_000, "the unreadable-schema run");
  c("the program catches the refusal and the run completes", (out as { status?: string } | undefined)?.status === "completed", JSON.stringify(out));
  const settled = (await askEntries("ak-4")).find((e) => e.state === "settled");
  c("the entry settles as L4022 before anything was bound or armed",
    settled?.status === "failed" && settled?.error?.code === "L4022" && settled?.external === undefined,
    JSON.stringify({ error: settled?.error?.code, external: settled?.external }));
  c("and nothing was relayed: the seat is never asked for a record no schema can judge",
    relayOf(settled?.requestId).count === 0, turnInvokes.filter((i) => i.goalId === settled?.requestId).length);
}

// ── 5) the one absolute deadline elapsing is L4006 ─────────────────────────────────────────────
{
  console.log("• 5 — an unanswered ask expires at its deadline as L4006 (kind ask-deadline)");
  const drv = driven({
    space: SPACE, endpoint: EP, kv, runId: "ak-5", lease: lease(),
    source: `const a = await spawn("dev");\ntry {\n  await ask(a, { name: "size", schema: { estimate: "number" }, deadline: "2s" });\n  log("reached", true);\n} catch (e) {\n  log("caught", e.code);\n}`,
    handler: mk("ak-5"),
  });
  // Every earlier block's answered pause also queued a schedule request; drain the backlog so
  // THIS mint is armed too, then sweep once more for a mint that landed after the first window.
  await armPending(10);
  await armPending(2);
  const out = await withDeadline(drv, 30_000, "the expiring run");
  c("the run completes with the deadline caught", (out as { status?: string } | undefined)?.status === "completed", JSON.stringify(out));
  const settled = (await askEntries("ak-5")).find((e) => e.state === "settled");
  c("the entry settles as the deadline-elapsed L4006, kind ask-deadline",
    settled?.status === "failed" && settled?.error?.code === "L4006" && settled?.error?.kind === "ask-deadline",
    JSON.stringify(settled?.error)?.slice(0, 120));
}

// ── 6) recovery: a resume re-enters the attempt in flight ──────────────────────────────────────
{
  console.log("• 6 — a resume re-attaches, and a settle from before the crash is re-judged");
  // (a) parked attempt 1, crash, resume, answer: the resumed handler returns the record.
  const T = token("c");
  const h1 = mk("ak-6");
  const a6 = await spawnSeat(h1, "6a");
  const s1 = stepCtx(T);
  const first = h1.ask({ agent: a6, schema: { estimate: "number" } } as never, s1.ctx);
  first.catch(() => undefined);
  for (let i = 0; i < 100 && s1.bound.askToken === undefined; i += 1) await wait(100);
  c("attempt 1 is bound before its pause is armed", s1.bound.attempt === 1 && s1.bound.askToken === T, JSON.stringify(s1.bound));
  for (let i = 0; i < 100 && relayOf(T).count === 0; i += 1) await wait(100);
  // The rebuilt handler reads its roster from the journal, as a recovering run does.
  const h2 = mk("ak-6");
  await h2.adopted([spawnEntryFor("ak-6", a6)]);
  const s2 = stepCtx(T, { ...s1.bound });
  const resumed = h2.ask({ agent: a6, schema: { estimate: "number" } } as never, s2.ctx);
  resumed.catch(() => undefined);
  await answerToken(T, { estimate: 11 });
  const got = await withDeadline(resumed.then((v) => v, () => undefined), 20_000, "the resumed ask");
  c("the resumed ask reads the answer and returns the record",
    (got as { estimate?: unknown } | undefined)?.estimate === 11, JSON.stringify(got));
  c("the resumed attempt did not re-bind: the recorded attempt is the input",
    Object.keys(s2.bound).length === 0, JSON.stringify(s2.bound));
  c("the resume re-told the seat nothing: the relay is idempotent by the attempt's own goal id",
    relayOf(T).count === 1, relayOf(T).count);

  // (b) the crash landed AFTER a non-conforming settle, BEFORE the next attempt was bound: the
  // resume re-reads the durable settle, judges it identically, and opens attempt 2.
  const T2 = token("d");
  const h3 = mk("ak-6b");
  const a6b = await spawnSeat(h3, "6b");
  const s3 = stepCtx(T2);
  const parked = h3.ask({ agent: a6b, schema: { estimate: "number" }, attempts: 2 } as never, s3.ctx);
  parked.catch(() => undefined);
  for (let i = 0; i < 100 && s3.bound.askToken === undefined; i += 1) await wait(100);
  await answerToken(T2, { estimate: "big" });
  for (let i = 0; i < 100 && s3.bound.attempt !== 2; i += 1) await wait(100);
  c("the live path re-asked on the refused answer", s3.bound.attempt === 2, JSON.stringify(s3.bound));
  for (let i = 0; i < 100 && relayOf(s3.bound.askToken).count === 0; i += 1) await wait(100);
  // The crash: resume from the RECORDED FIRST attempt (the bind of attempt 2 never landed).
  const h4 = mk("ak-6b");
  await h4.adopted([spawnEntryFor("ak-6b", a6b)]);
  const s4 = stepCtx(T2, { attempt: 1, askToken: T2, deadlineAt: s3.bound.deadlineAt as number });
  const rejudged = h4.ask({ agent: a6b, schema: { estimate: "number" }, attempts: 2 } as never, s4.ctx);
  rejudged.catch(() => undefined);
  for (let i = 0; i < 100 && s4.bound.attempt !== 2; i += 1) await wait(100);
  c("the resume re-judges the recorded settle and opens attempt 2 under the same derived token",
    s4.bound.attempt === 2 && s4.bound.askToken === s3.bound.askToken
      && typeof s4.bound.refused === "string" && (s4.bound.refused as string).includes('"estimate" wants number'),
    JSON.stringify(s4.bound));
  c("attempt 2 was relayed exactly once, by the live path: the re-judging resume found its goal and told the seat nothing twice",
    relayOf(s3.bound.askToken).count === 1, relayOf(s3.bound.askToken).count);
  await answerToken(s4.bound.askToken, { estimate: 21 });
  const v2 = await withDeadline(rejudged.then((v) => v, () => undefined), 20_000, "the re-judged ask");
  c("the re-judged ask completes on attempt 2's conforming answer",
    (v2 as { estimate?: unknown } | undefined)?.estimate === 21, JSON.stringify(v2));

  // (c) the crash landed AFTER attempt 2 was bound, BEFORE its relay. The bind is where the refusal
  // is written down, so a resume that read the attempt and the deadline off the entry but not the
  // refusal re-asked the seat with no reason its last answer failed, which is the only thing the
  // re-ask has to say.
  const T3 = token("d3");
  const h5 = mk("ak-6c");
  const a6c = await spawnSeat(h5, "6c");
  const attempt2 = createHash("sha256").update(`${T3}:ask-attempt-2`, "utf8").digest("base64url").slice(0, 43);
  const s5 = stepCtx(T3, {
    attempt: 2, askToken: attempt2, deadlineAt: Date.now() + 600_000,
    refused: 'the reply\'s "estimate" wants number',
  });
  const h6 = mk("ak-6c");
  await h6.adopted([spawnEntryFor("ak-6c", a6c)]);
  const rerelayed = h6.ask({ agent: a6c, schema: { estimate: "number" }, attempts: 2 } as never, s5.ctx);
  rerelayed.catch(() => undefined);
  for (let i = 0; i < 100 && relayOf(attempt2).count === 0; i += 1) await wait(100);
  const relay5 = relayOf(attempt2);
  c("a resume whose relay never landed re-tells the seat WITH the refusal the entry recorded",
    relay5.ask?.attempt === 2 && typeof relay5.ask?.refused === "string"
      && String(relay5.ask?.refused).includes('"estimate" wants number'),
    JSON.stringify(relay5.ask));
  await answerToken(attempt2, { estimate: 31 });
  const v3 = await withDeadline(rerelayed.then((v) => v, () => undefined), 20_000, "the re-relayed ask");
  c("and it completes on that attempt's conforming answer",
    (v3 as { estimate?: unknown } | undefined)?.estimate === 31, JSON.stringify(v3));
  await parked.then(() => undefined, () => undefined);
}

// ── 7) a cancelled ask's CURRENT attempt is the pause the discharge ends ───────────────────────
{
  console.log("• 7 — the discharge ends the attempt that is actually armed");
  const T = token("e");
  const h = mk("ak-7");
  const a7 = await spawnSeat(h, "7");
  const s = stepCtx(T);
  const attempt = h.ask({ agent: a7, schema: { estimate: "number" }, attempts: 2, deadline: "10m" } as never, s.ctx);
  attempt.catch(() => undefined);
  for (let i = 0; i < 100 && s.bound.askToken === undefined; i += 1) await wait(100);
  await answerToken(T, { estimate: "big" }); // attempt 1 settles non-conforming; attempt 2 arms
  for (let i = 0; i < 100 && s.bound.attempt !== 2; i += 1) await wait(100);
  const second = s.bound.askToken as string;
  s.cancel("race lost");
  const e = await withDeadline(attempt.then(() => null, (x: unknown) => x as Error), 15_000, "the cancelled ask");
  c("the cancelled await ends Cancelled within one poll", e instanceof Cancelled, e === null ? "resolved" : (e as Error)?.name);
  const entry = {
    kind: "ask", requestId: T, state: "pending",
    external: { attempt: 2, askToken: second, deadlineAt: s.bound.deadlineAt },
  } as unknown as JournalEntry;
  await withDeadline(h.discharge([entry]), 20_000, "the discharge");
  const settled = await readCheckpointSettle(jsm, SPACE, { endpoint: EP, token: second });
  c("the discharge settled the CURRENT attempt's pause, so its timer cannot fire into the run",
    settled !== undefined, settled);
}

// ── 8) the adoption re-arm inventory addresses the attempt in flight ───────────────────────────
{
  console.log("• 8 — outstandingPauseTokens reads the current attempt off the entry");
  const bare = { kind: "ask", requestId: token("f"), state: "pending" } as unknown as JournalEntry;
  const bound = {
    kind: "ask", requestId: token("f"), state: "pending",
    external: { attempt: 2, askToken: token("g"), deadlineAt: 1 },
  } as unknown as JournalEntry;
  c("a crash before the first bind re-arms attempt 1, the request id itself",
    outstandingPauseTokens([bare]).join() === token("f"), outstandingPauseTokens([bare]));
  c("a bound entry re-arms the CURRENT attempt's derived token",
    outstandingPauseTokens([bound]).join() === token("g"), outstandingPauseTokens([bound]));
}

// ── 9) an ask addresses an agent this run spawned: anything else refuses before a pause exists ─
{
  console.log("• 9 — an ask outside the run's roster refuses loudly, with nothing bound, armed or relayed");
  const h = mk("ak-9");
  const s = stepCtx(token("g"));
  const before = turnInvokes.length;
  const got = await withDeadline(safe(h.ask({ agent: { agent: `ghost#${"g".repeat(26)}`, persona: "dev" }, schema: { estimate: "number" } } as never, s.ctx)), 10_000, "the roster refusal");
  c("the refusal names the roster and reaches no endpoint",
    (got as { threw?: boolean })?.threw === true && String((got as { message?: string })?.message).includes("roster") && turnInvokes.length === before,
    JSON.stringify(got));
  c("nothing was bound: no attempt opened for an agent the run cannot tell", Object.keys(s.bound).length === 0, JSON.stringify(s.bound));
}

// ── 10) a seat the endpoint reports gone at the relay's accept is the agent-down L4002 ────────
{
  console.log("• 10 — the relay refused as expired: the agent is down, L4002");
  const h = mk("ak-10");
  const a10 = await spawnSeat(h, "10");
  refuseNextTurn = new EpEnvelopeError("expired", `the target incarnation ${a10.agent} is gone from presence`);
  const got = await withDeadline(safe(h.ask({ agent: a10, schema: { estimate: "number" } } as never, stepCtx(token("h")).ctx)), 15_000, "the gone-seat ask");
  c("the ask fails as the catchable agent-down L4002, carrying the endpoint's reason",
    (got as { code?: string })?.code === "L4002" && String((got as { message?: string })?.message).includes("gone from presence"),
    JSON.stringify(got));
}

await Promise.allSettled(terminals);
await serve.stop().catch(() => { /* teardown */ });
const EXPECTED_CELLS = 35;
const ran = ok + fail;
console.log(`mesh-ask.smoke: ${ok} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  await nc.close();
  done();
  process.exit(1);
}
await nc.close();
done();
process.exit(fail === 0 ? 0 : 1);
