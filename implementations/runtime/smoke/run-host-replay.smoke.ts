/**
 * A hosted drive's own journal reads, on the real planes: one takeover id, many readers.
 *
 * A drive reads its journal through one replay durable named after its takeover, at every effect
 * and at every poll of a parked pause. Each block below drives the manager's `RunHost` over the
 * split the manager uses (a driver connection and a separate mediator connection, both under the
 * lease's takeover id), with a `parallel` of three `ask` steps whose answers land within the same
 * second, and checks that no branch fails:
 *
 *   1. while `RunHost.status` reads the drive's own takeover id on the driver's connection, which
 *      is the reader the per-durable serialisation in `replayRunJournal` exists for;
 *   2. while another reader takes records off that durable, so one of the drive's step reads loses
 *      a round and has to replay again.
 *
 * Then the retry's bound (3): a step read replays at most three times, still fails with the race
 * when every round is lost, and raises any other failure on its first read. And the one driver-side read before activation that is not
 * `activateRun` (4): the diagnostic for a journal with no run record replays again the same way.
 *
 * The other reader in 2-4 is a second connection that pulls one record off the drive's durable
 * right after the drive creates it, which is the state `consumers.add` hands a replay when someone
 * else already holds the name.
 *
 * Core is imported from its built output by path. That is the file the runtime's own
 * `@cotal-ai/core` resolves to, so the suite and the drive share one copy of core, and a change to
 * core's source is seen here only after `pnpm --filter @cotal-ai/core build`.
 *
 * Run: pnpm smoke:runtime-run-host-replay   (needs nats-server on PATH)
 */
import { spawn as spawnProc } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  createEndpointStreams,
  createSpaceStreams,
  openRecordsBucket,
  readCheckpointSpec,
  replayRunJournal,
  newTakeoverId,
  activateRun,
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
  admissionBucket,
  createRunAdmission,
  readRunAdmission,
  runDriverCaller,
  chatSubject,
  runJournalConsumerConfig,
  wfjStreamName,
  RunJournalReplayRaced,
  EpEnvelopeError,
  type EpCommandDef,
  type EpServeContext,
  type Presence,
  type RunHostOutcome,
  type RunHostPlanes,
  type RunStatusView,
} from "../../../packages/core/dist/index.js";
import { journalEntryKeyString, type JournalEntry } from "@cotal-ai/lang";
import { cotalLangRunHost } from "../src/run-host.js";
import { resolveCheckpoint } from "../src/resolve-checkpoint.js";
import { createRunScopeAuthority } from "../src/run-scope-authority.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const SPACE = "hostreplay";
const EP = "manager";
const MGR_IID = "m".repeat(26);
const CHANNEL = "panel";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); }
};
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
const SERVERS = `nats://127.0.0.1:${PORT}`;
const sd = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}hostreplay-`));
const broker = spawnProc("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
teardownOnSignal(broker, sd);
const done = () => {
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(sd, { recursive: true, force: true });
};
process.on("exit", done);
let up = false;
for (let i = 0; i < 60 && !up; i += 1) { up = await isReachable(SERVERS); if (!up) await wait(100); }
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

const nc = await connect({ servers: SERVERS });
const js = jetstream(nc);
const jsm = await jetstreamManager(nc);
await createEndpointStreams(jsm, new Kvm(nc), SPACE);
await createSpaceStreams(jsm, SPACE);
const kv = await openRecordsBucket(nc, SPACE);
const presenceKv = await new Kvm(nc).create(presenceBucket(SPACE));

/** One connection's planes, the shape `RunHost` takes. */
const planesOn = async (): Promise<RunHostPlanes> => {
  const conn = await connect({ servers: SERVERS });
  return { nc: conn, js: jetstream(conn), jsm: await jetstreamManager(conn), kv: await openRecordsBucket(conn, SPACE), space: SPACE };
};
const driver = await planesOn();
const mediator = await planesOn();
const rival = await planesOn();

// ── the suite-served manager-shaped endpoint (spawn + turn) ────────────────────────────────────
// An ask addresses a seat this run spawned and is told to it over the turn relay, so the suite
// serves the manager's shape for both: spawn registers the seat and commits its terminal, and turn
// accepts the relay.
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
  urn: "ai.cotal.test.hostreplay", revision: 1, attributes: [], events: [],
  commands: [
    { name: "spawn", class: "ephemeral" as const, targeted: false, capability: "manager.spawn", inputDigest: COMPILED.spawn.input.closureDigest, outputDigest: COMPILED.spawn.output.closureDigest },
    { name: "turn", class: "ephemeral" as const, targeted: true, modes: ["owner", "any"], capability: "manager.lifecycle", inputDigest: COMPILED.turn.input.closureDigest, outputDigest: COMPILED.turn.output.closureDigest },
  ],
};
const MANIFEST = { v: 1 as const, root: contractDigest(DOCUMENT), members: [] as string[] };
const CLOSURE_DIGEST = contractDigest(MANIFEST);

const store = await contractStoreContext(nc, SPACE);
const artifactIndex = new Map<string, unknown>();
{
  const values: unknown[] = [];
  for (const source of [SPAWN_INPUT, SPAWN_OUTPUT, TURN_INPUT, TURN_OUTPUT])
    values.push(source, { v: 1, root: contractDigest(source), members: [] });
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
const serveAuthority = { authorize: (endpoint: string, owner: string) => ({ authorized: endpoint === EP && owner === "local", revision: 0 }) };
const barrier = endpointRegistrationBarrier(authKv, SPACE, { endpoint: EP, instanceId: MGR_IID, opId: MGR_IID });
await registerServiceInstance(kv, {
  space: SPACE,
  spec: { endpoint: EP, owner: "local", clusterDigests: [CLOSURE_DIGEST], protocol: { v: 1 } },
  instanceId: MGR_IID, registrant: { owner: "local" }, authority: serveAuthority, barrier, readClusterArtifact,
});
const observed = await fence.observe();
if (observed === null) throw new Error("the suite endpoint's issuance gate vanished after registration");
const EXEC_EPOCH = observed.processEpoch;
const grant = await authorizeServeGrant(kv, {
  space: SPACE, endpoint: EP, instanceId: MGR_IID, epoch: EXEC_EPOCH,
  holder: { owner: "local" }, authority: serveAuthority, readProcessEpoch: () => EXEC_EPOCH, readClusterArtifact,
});

const goalCtx = await actionContext(nc, SPACE);
const spawnAccepts = new Map<string, Record<string, unknown>>();
const turnAccepts = new Map<string, Record<string, unknown>>();
const mappings = new Map<string, { lifecycleUid: string; mappingRevision: number }>();
const terminals: Promise<void>[] = [];
let seat = 0;

/** Replay an accepted submission verbatim, or refuse a different one under the same goal id. */
const priorAcceptance = (accepted: Map<string, Record<string, unknown>>, goalId: string, fingerprint: string) => {
  const prior = accepted.get(goalId);
  if (prior !== undefined && prior.fingerprint !== fingerprint)
    throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted under a different submission (SPEC 13.6)`);
  return prior;
};

const spawnHandler = async (ctx: EpServeContext): Promise<unknown> => {
  const persona = String((ctx.request.args as Record<string, unknown> | undefined)?.name);
  const goalId = ctx.request.id;
  const { fingerprint } = submissionFingerprint(ctx.request as unknown, ctx.subject);
  const prior = priorAcceptance(spawnAccepts, goalId, fingerprint);
  if (prior !== undefined) return prior;
  const ref = goalRefOf(ctx.subject, goalId);
  if (!(await bindGoal(goalCtx, ref, fingerprint)).bound)
    throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already bound (SPEC 13.6)`);
  await createGoal(goalCtx, ref, {
    fingerprint, command: "spawn",
    caller: { id: `${ctx.subject.caller.owner}.${ctx.subject.caller.actor}`, lifecycleUid: ctx.subject.caller.uid },
    acceptedEpoch: EXEC_EPOCH, requestId: goalId, sourceSeq: 0, acceptedAt: Date.now(), readinessDeadlineMs: 30_000,
  });
  seat += 1;
  const name = `${persona}-${seat}`;
  const actor = `seat${seat}`;
  const uid = `s${String(seat).padStart(25, "0")}`;
  mappings.set(`local.${actor}`, { lifecycleUid: uid, mappingRevision: 1 });
  const acceptance = {
    name, owner: "local", actor, uid, goalId, fingerprint, readinessDeadlineMs: 30_000,
    executor: { lifecycleUid: MGR_IID, epoch: EXEC_EPOCH },
  };
  spawnAccepts.set(goalId, acceptance);
  terminals.push((async () => {
    const row: Presence = { card: { id: `local.${actor}`, name, kind: "agent" }, lifecycleUid: uid, status: "idle", ts: Date.now() };
    await presenceKv.put(`local.${actor}`, JSON.stringify(row));
    await commitGoalResult(goalCtx, { ref, now: Date.now(), cause: "complete", state: "succeeded", data: { name, agent: "stub", id: `local.${actor}`, mode: "pty", lifecycleUid: uid }, committer: { instanceId: MGR_IID, epoch: EXEC_EPOCH } });
  })().catch((e) => { console.log("  ! fake spawn terminal failed:", (e as Error).message); }));
  return acceptance;
};

const turnHandler = async (ctx: EpServeContext): Promise<unknown> => {
  const args = (ctx.request.args ?? {}) as Record<string, unknown>;
  const goalId = ctx.request.id;
  const t = ctx.request.target as { owner: string; actor: string; lifecycleUid: string };
  const { fingerprint } = submissionFingerprint(ctx.request as unknown, ctx.subject);
  const prior = priorAcceptance(turnAccepts, goalId, fingerprint);
  if (prior !== undefined) return prior;
  const ref = goalRefOf(ctx.subject, goalId);
  if (!(await bindGoal(goalCtx, ref, fingerprint)).bound)
    throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already bound (SPEC 13.6)`);
  const deadlineMs = Number(args.deadlineMs);
  await createGoal(goalCtx, ref, {
    fingerprint, command: "turn",
    caller: { id: `${ctx.subject.caller.owner}.${ctx.subject.caller.actor}`, lifecycleUid: ctx.subject.caller.uid },
    acceptedEpoch: EXEC_EPOCH, requestId: goalId, sourceSeq: 0, acceptedAt: Date.now(), readinessDeadlineMs: deadlineMs,
    target: { owner: t.owner, actor: t.actor, lifecycleUid: t.lifecycleUid, mappingRevision: 1 },
  });
  const acceptance = {
    name: `${t.owner}.${t.actor}`, owner: t.owner, actor: t.actor, uid: t.lifecycleUid, goalId, fingerprint,
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

// ── the hosted drive ───────────────────────────────────────────────────────────────────────────
const admissions = await new Kvm(nc).open(admissionBucket(SPACE));
/** Admit a run the way the manager does before it launches a drive (SPEC 14.8). */
const admit = async (runId: string) => {
  const caller = runDriverCaller(runId);
  await createRunAdmission(admissions, {
    version: 1, space: SPACE, endpoint: EP, runId, instanceId: MGR_IID, caller,
    ceiling: {
      publish: { allow: { mode: "patterns", patterns: [chatSubject(SPACE, caller.owner, caller.actor, CHANNEL)] }, deny: [] },
      subscribe: { allow: { mode: "patterns", patterns: [chatSubject(SPACE, "*", "*", CHANNEL)] }, deny: [] },
    },
    provenance: { kind: "operator", by: "run-host-replay.smoke", reason: "suite admission" },
    admittedAt: Date.now(),
  });
  return await readRunAdmission(mediator.jsm, SPACE, EP, runId);
};

/** Launch a drive through the manager's run host, holder and lease shaped as the manager's are. */
const host = async (runId: string, mode: "new" | "existing", source: string) => {
  const takeoverId = newTakeoverId();
  const holder = `manager.${takeoverId}`;
  const lease = { holder, epoch: 1, fencingToken: 1, takeoverId };
  const drive = cotalLangRunHost.drive(driver, {
    mode, endpoint: EP, runId, source, lease, holder: { id: holder, lifecycleUid: "u_hostreplay" },
    instanceId: MGR_IID, epoch: 1, defaultCheckpointTimeout: "1h", admission: await admit(runId),
  }, mediator);
  let finished = false;
  const outcome = drive.done.then((o) => { finished = true; return o; });
  return { lease, outcome, finished: () => finished, durable: String(runJournalConsumerConfig(SPACE, runId, takeoverId).durable_name) };
};

const PANEL = `const dev = await spawn("dev");
const rev = await spawn("rev");
const qa = await spawn("qa");
const got = await parallel({
  dev: () => ask(dev, { name: "dev-verdict", schema: { verdict: "string" } }),
  rev: () => ask(rev, { name: "rev-verdict", schema: { verdict: "string" } }),
  qa: () => ask(qa, { name: "qa-verdict", schema: { verdict: "string" } }),
}, { name: "panel" });
log("verdicts", got.dev.verdict, got.rev.verdict, got.qa.verdict);`;

/** The run's ask entries, last record per key, read under a takeover id of the suite's own. */
const askEntries = async (runId: string): Promise<JournalEntry[]> => {
  const back = await replayRunJournal(js, jsm, SPACE, runId, newTakeoverId());
  const last = new Map<string, JournalEntry>();
  for (const { record } of back.records) {
    if (record.kind !== "step") continue;
    const e = record.entry as JournalEntry;
    if (e.kind === "ask") last.set(journalEntryKeyString(e), e);
  }
  return [...last.values()];
};

/** All three asks parked, each on a pause record an answer can land on. */
const parkedPanel = async (runId: string): Promise<JournalEntry[]> => {
  const until = Date.now() + 20_000;
  for (;;) {
    const open = (await askEntries(runId)).filter((e) => e.state === "pending");
    if (open.length === 3) {
      const minted = await Promise.all(open.map((e) => readCheckpointSpec(kv, { endpoint: EP, token: String(e.external?.askToken) })));
      if (minted.every((s) => s !== undefined)) return open;
    }
    if (Date.now() > until) {
      console.log(`  ! run ${runId} parked ${open.length} of 3 asks`);
      return open;
    }
    await wait(100);
  }
};

/** Answer every parked ask at once through the run driver's answer door; the elapsed wall time. */
const answerPanel = async (runId: string, open: readonly JournalEntry[]): Promise<{ ms: number; answers: string[] }> => {
  const at = Date.now();
  const answers = await Promise.all(open.map((e) =>
    resolveCheckpoint({ kv, js, jsm, space: SPACE, endpoint: EP },
      { runId, stepKey: journalEntryKeyString(e), by: "reviewer", value: { verdict: `${e.name}-ok` }, now: Date.now() })
      .then(() => "ok", (err: unknown) => `${(err as Error).name}: ${(err as Error).message.slice(0, 120)}`)));
  return { ms: Date.now() - at, answers };
};

/** Every branch settled ok and the run completed: what "no branch fails" means on the record. */
const panelHeld = async (runId: string, out: RunHostOutcome | undefined) => {
  const settled = (await askEntries(runId)).filter((e) => e.state === "settled");
  const branches = settled.map((e) => `${e.name}:${e.status}${e.error ? ` ${e.error.code} ${e.error.message.slice(0, 120)}` : ""}`);
  return {
    held: out?.status === "completed" && settled.length === 3 && settled.every((e) => e.status === "ok"),
    detail: { outcome: out, branches },
  };
};

/**
 * Another reader on one replay durable. For the next `n` creations of that name through `target`,
 * a second connection takes one record off the consumer before the create's answer is returned,
 * so the replay is handed a consumer that has already delivered to someone else. Two creations
 * are one lost round: the replay removes the first and remakes it, and refuses the second.
 *
 * `refuse` is the control: the next creation of that name fails outright, with an error that is
 * not the race.
 */
const rivalOn = (target: JetStreamManager) => {
  let durable = "";
  let owed = 0;
  let refusal: Error | undefined;
  const add = target.consumers.add.bind(target.consumers);
  target.consumers.add = async (stream, cfg) => {
    if (refusal !== undefined && cfg.durable_name === durable) {
      const refused = refusal;
      refusal = undefined;
      throw refused;
    }
    const created = await add(stream, cfg);
    if (owed === 0 || stream !== wfjStreamName(SPACE) || cfg.durable_name !== durable) return created;
    owed -= 1;
    const consumer = await rival.js.consumers.get(stream, durable);
    for await (const m of await consumer.fetch({ max_messages: 1, expires: 2_000 })) {
      m.ack();
      break;
    }
    return await target.consumers.info(stream, durable);
  };
  return {
    plant(name: string, creations: number): void { durable = name; owed = creations; },
    refuse(name: string, error: Error): void { durable = name; refusal = error; },
    get owed(): number { return owed; },
    get refusing(): boolean { return refusal !== undefined; },
  };
};
const onMediator = rivalOn(mediator.jsm);
const onDriver = rivalOn(driver.jsm);

try {
// ── 1) three asks settle in one second while `status` reads the drive's own takeover id ───────
{
  console.log("• 1: a parallel of three asks, with the drive's takeover id also read by status");
  const runId = "panel-shared";
  const drive = await host(runId, "new", PANEL);
  const open = await parkedPanel(runId);
  // Two readers of the drive's own durable on the DRIVER's connection, back to back until the run
  // ends: every settle read the drive makes in that time has a status read beside it.
  const views: Array<RunStatusView | string | undefined> = [];
  // A drive that never finishes would leave this loop spinning against a closed connection after
  // the finally below, so the readers stop on their own well after withDeadline has reported.
  const readUntil = Date.now() + 30_000;
  const readers = Promise.all([0, 1].map(async () => {
    while (!drive.finished() && Date.now() < readUntil) {
      views.push(await cotalLangRunHost.status(driver, { endpoint: EP, runId, takeoverId: drive.lease.takeoverId })
        .catch((e: unknown) => `${(e as Error).name}: ${(e as Error).message.slice(0, 100)}`));
    }
  }));
  const answered = await answerPanel(runId, open);
  c("the three answers landed within the same second", open.length === 3 && answered.ms < 1_000 && answered.answers.every((a) => a === "ok"), answered);
  const out = await withDeadline(drive.outcome, 30_000, "the shared-id panel");
  await withDeadline(readers, 30_000, "the status readers");
  const panel = await panelHeld(runId, out);
  c("no branch fails while status reads the drive's own takeover id", panel.held, panel.detail);
  const rows = views.map((v) => (typeof v === "object" ? v.journal : undefined));
  const broken = views.filter((v, i) => typeof v !== "object" || rows[i]!.length === 0 || rows[i]![0]!.kind !== "activation");
  c("and every one of those status reads returned the run from its activation, none torn and none empty",
    views.length > 0 && broken.length === 0, { reads: views.length, broken: broken.slice(0, 3) });
  const lengths = rows.map((r) => r?.length ?? 0);
  c("the status reads spanned the settle: the first saw the asks parked and a later one saw them answered",
    lengths.length > 1 && Math.max(...lengths) > lengths[0]!, { first: lengths[0], last: lengths.at(-1), max: Math.max(...lengths) });
}

// ── 2) three asks settle in one second while a step read loses a round ───────────────────────
{
  console.log("• 2: a parallel of three asks, with one of the drive's step reads losing a round");
  const runId = "panel-raced";
  const drive = await host(runId, "new", PANEL);
  const open = await parkedPanel(runId);
  onMediator.plant(drive.durable, 2);
  const answered = await answerPanel(runId, open);
  c("the three answers landed within the same second, again", open.length === 3 && answered.ms < 1_000 && answered.answers.every((a) => a === "ok"), answered);
  const out = await withDeadline(drive.outcome, 30_000, "the raced panel");
  c("the other reader really took a round off the drive's durable", onMediator.owed === 0, { owed: onMediator.owed });
  onMediator.plant("", 0);
  const panel = await panelHeld(runId, out);
  c("no branch fails when one of the drive's step reads loses a round to another reader", panel.held, panel.detail);

  // ── 3) the bound, on the same run and lease: the reader a step's authority check rides ─────
  console.log("• 3: a step read replays at most three times");
  const authority = createRunScopeAuthority(mediator, runId, drive.lease);
  onMediator.plant(drive.durable, 4);
  const twice = await authority.journal().then((entries) => entries.length, (e: unknown) => `${(e as Error).name}: ${(e as Error).message.slice(0, 100)}`);
  c("a step read that loses two rounds replays a third time and reads the run",
    typeof twice === "number" && twice > 0 && onMediator.owed === 0, { got: twice, owed: onMediator.owed });
  onMediator.plant(drive.durable, 7);
  const lost = await authority.journal().then((entries) => `read ${entries.length}`, (e: unknown) => e);
  c("a step read that loses every round fails with the race after three replays, not a fourth",
    lost instanceof RunJournalReplayRaced && onMediator.owed === 1,
    { got: lost instanceof Error ? `${lost.name}: ${lost.message.slice(0, 100)}` : lost, owed: onMediator.owed });
  onMediator.plant("", 0);
  const refusal = new Error("the broker refused this consumer create");
  onMediator.refuse(drive.durable, refusal);
  const refused = await authority.journal().then((entries) => `read ${entries.length}`, (e: unknown) => e);
  c("a step read that fails for any other reason raises that failure without replaying again",
    refused === refusal && !onMediator.refusing,
    { got: refused instanceof Error ? `${refused.name}: ${refused.message.slice(0, 100)}` : refused });
}

// ── 4) the no-record diagnostic replays again after a lost round ──────────────────────────────
{
  console.log("• 4: a journal with no run record is still named after a lost round");
  const runId = "unpinned";
  // Activated and never pinned: the window between a driver winning a run and writing its spec.
  await activateRun(js, jsm, {
    space: SPACE, runId, holder: "manager.first", fencingToken: 1, epoch: 1,
    takeoverId: newTakeoverId(), at: Date.now(), expect: "new",
  });
  // The plant is armed for the durable the resume's lease will name, before the drive starts.
  const takeoverId = newTakeoverId();
  onDriver.plant(String(runJournalConsumerConfig(SPACE, runId, takeoverId).durable_name), 2);
  const admission = await admit(runId);
  const drive = cotalLangRunHost.drive(driver, {
    mode: "existing", endpoint: EP, runId, source: PANEL,
    lease: { holder: `manager.${takeoverId}`, epoch: 2, fencingToken: 2, takeoverId },
    holder: { id: `manager.${takeoverId}`, lifecycleUid: "u_hostreplay" },
    instanceId: MGR_IID, epoch: 2, defaultCheckpointTimeout: "1h", admission,
  }, mediator);
  const out = await withDeadline(drive.done, 15_000, "the unpinned resume");
  c("the resume's diagnostic read really lost a round", onDriver.owed === 0, { owed: onDriver.owed });
  onDriver.plant("", 0);
  c("and it still releases the run naming a journal that was activated and never pinned",
    out?.status === "released" && out.reason.message.includes("has a journal but no record"), out);
}
} finally {
  await Promise.allSettled(terminals);
  await serve.stop().catch(() => { /* teardown */ });
  for (const p of [driver, mediator, rival]) await p.nc.close();
  await nc.close();
}

const EXPECTED_CELLS = 12;
const ran = ok + fail;
console.log(`run-host-replay.smoke: ${ok} passed, ${fail} failed`);
if (ran !== EXPECTED_CELLS) {
  console.log(`SUITE INCOMPLETE: ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
  done();
  process.exit(1);
}
done();
process.exit(fail === 0 ? 0 : 1);
