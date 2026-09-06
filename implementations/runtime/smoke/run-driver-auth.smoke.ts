/**
 * The `run-driver` profile (SPEC 14.6) driving a run on an ENFORCING broker.
 *
 * Every other suite for the runtime runs on an open broker, so it proves what the handler does and
 * nothing about what a credential permits. `cotal run` used to connect as `admin`, and on an authed
 * mesh that was a driver that could not read its own run record: the first cell below is that
 * reproduction, kept so the profile's reason for existing stays measured rather than remembered.
 *
 * The driver now writes only its run's journal and records. A separate trusted host performs
 * effects and leader reads through run-bound methods. This suite exercises those methods through
 * real workflows, then probes the raw driver connection for cross-run access. It also appends a
 * copied foreign checkpoint token to the driver's own journal and verifies host rejection.
 *
 * Run: pnpm smoke:runtime-run-driver-auth   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import {
  isReachable,
  createSpaceAuth,
  serverConfig,
  setupSpaceStreams,
  mintCreds,
  newIdentity,
  mintLifecycleUid,
  standaloneConnectOpts,
  openRecordsBucket,
  openChannelRegistry,
  readRunProgram,
  replayRunJournal,
  walkKvEntries,
  liveKvEntries,
  newTakeoverId,
  runDriverCaller,
  timerWriterContext,
  timerWriterConsumerConfig,
  timerWriterDurable,
  armCheckpointTimer,
  eptReqStreamName,
  eptSubject,
  chatSubject,
  recordsKvStreamName,
  wfjStreamName,
  wfjSubject,
  DEV_OWNER,
  type CotalMessage,
} from "@cotal-ai/core";
import { MeshHandler, EpfSettleWatcher, startRun, driveRun } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { Cancelled, parseDuration } from "@cotal-ai/lang";
import { createRunScopeAuthority, RunScopeDenied, WaitReceipts } from "../src/run-scope-authority.js";
import { createRunWaitHost } from "../src/run-wait-host.js";
import { createRunPauseHost } from "../src/run-pause-host.js";
import { createRunRecordHost, runRecordView } from "../src/run-record-host.js";
import { createRunEffectHost } from "../src/run-effect-host.js";

const S = "rdauth";
const EP = "manager";
const IID = "i".repeat(26);
const EPOCH = 2;
const RUN_A = "run-a";
const RUN_B = "run-b";
const TK_A = newTakeoverId();
const CHANNEL = "build";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const denied = (e: unknown): boolean => /permissions? violation/i.test(String((e as Error)?.message));
const short = (e: unknown): string => `${(e as Error)?.name}: ${String((e as Error)?.message).slice(0, 110)}`;

/** A cell whose claim is "this ENDS" must fail as a RED, not as a suite that stops. */
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

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "cotal-rdauth-"));
const auth = await createSpaceAuth(S);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const broker = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const conns: NatsConnection[] = [];
const done = () => {
  for (const nc of conns) { try { nc.close(); } catch { /* closing */ } }
  try { broker.kill("SIGKILL"); } catch { /* already gone */ }
  rmSync(dir, { recursive: true, force: true });
};
process.on("exit", done);

let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
  up = await isReachable(SERVERS, { creds: await mintCreds(auth, newIdentity(), "probe") }).catch(() => false);
  if (!up) await wait(100);
}
if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
await setupSpaceStreams({ servers: SERVERS, space: S, creds: await mintCreds(auth, newIdentity(), "provisioner") });

const open = async (creds: string): Promise<NatsConnection> => {
  const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  conns.push(nc);
  return nc;
};
/** The same split the manager uses: raw driver connection plus host-only mediation. */
const driver = async (runId: string, takeoverId: string, epoch = EPOCH, holder = "manager", fencingToken = 1) => {
  const pin = { endpoint: EP, runId, takeoverId, instanceId: IID, epoch };
  const nc = await open(await mintCreds(auth, newIdentity(), "run-driver", { runDriver: pin }));
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const rawKv = await openRecordsBucket(nc, S);
  const hostNc = await open(await mintCreds(auth, newIdentity(), "run-mediator", { runMediator: pin }));
  const hostPlanes = { nc: hostNc, js: jetstream(hostNc), jsm: await jetstreamManager(hostNc), kv: await openRecordsBucket(hostNc, S), space: S };
  const authority = createRunScopeAuthority(hostPlanes, runId, { holder, epoch, fencingToken, takeoverId });
  const handler = { ...createRunEffectHost(hostPlanes, {
    space: S, endpoint: EP, runId, caller: runDriverCaller(runId), instanceId: IID, epoch,
    holder: { id: holder, lifecycleUid: "u_rdauth" }, defaultCheckpointTimeout: "1h",
  }, authority) };
  const kv = runRecordView(rawKv, createRunRecordHost(hostPlanes, EP, runId), S);
  return { nc, js, jsm, kv, rawKv, hostPlanes, handler };
};
const lease = (takeoverId: string, fencingToken: number) => ({ holder: "manager", epoch: EPOCH, fencingToken, takeoverId });

// The timer writer the delivery daemon hosts on a live mesh, on the daemon's own credential: the
// sleep below is a real schedule the broker fires, not a clock the suite advances.
{
  const nc = await open(await mintCreds(auth, newIdentity(), "delivery"));
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  await jsm.consumers.add(eptReqStreamName(S), timerWriterConsumerConfig(S, { ackWaitMs: 5_000 }));
  const writerC = await js.consumers.get(eptReqStreamName(S), timerWriterDurable(S));
  const wctx = await timerWriterContext(nc, S);
  void (async () => {
    for (;;) {
      if (nc.isClosed()) return;
      try {
        for await (const m of await writerC.fetch({ max_messages: 4, expires: 1_000 })) {
          await armCheckpointTimer(wctx, { subject: m.subject, headers: m.headers, data: m.data });
          m.ack();
        }
      } catch { return; }
    }
  })();
}

// An agent on the channel the program waits on, minted as `cotal spawn` would mint it.
const ann = newIdentity();
const annNc = await open(await mintCreds(auth, ann, "agent", { allowPublish: [CHANNEL], allowSubscribe: [CHANNEL], lifecycleUid: mintLifecycleUid() }));
const say = async (text: string) => {
  const msg: CotalMessage = {
    id: `m-${Date.now()}`, ts: Date.now(), space: S,
    from: { id: ann.id, name: "ann" }, channel: CHANNEL, parts: [{ kind: "text", text }],
  };
  await jetstream(annNc).publish(chatSubject(S, DEV_OWNER, ann.id, CHANNEL), new TextEncoder().encode(JSON.stringify(msg)));
};

const PROGRAM = `
await sleep("1s", { name: "nap" });
const m = await wait(message(channel("${CHANNEL}")), { name: "heard", timeout: "30s" });
log("heard", m.from.name);
`;

try {
// ── 1) the reproduction: the profile the CLI used to drive as cannot drive at all ──────────────
{
  const nc = await open(await mintCreds(auth, newIdentity(), "admin"));
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const kv = await openRecordsBucket(nc, S);
  const handler = new MeshHandler(
    nc, kv, js, jsm,
    { space: S, endpoint: EP, runId: "run-admin", caller: runDriverCaller("run-admin"), instanceId: IID, epoch: EPOCH, holder: { id: "cli", lifecycleUid: "u_rdauth" }, defaultCheckpointTimeout: "1h" },
    new EpfSettleWatcher(jsm, S, 1_000),
    () => Date.now(),
  );
  const got = await withDeadline(
    startRun(js, jsm, { space: S, endpoint: EP, runId: "run-admin", source: "return 1", kv, lease: lease(newTakeoverId(), 1), handler })
      .then((o) => ({ o }), (e: unknown) => ({ e })),
    10_000, "the admin attempt");
  c("an `admin` credential cannot drive even `return 1`: the run record read is refused by the broker",
    got !== undefined && "e" in got && denied(got.e), got && ("e" in got ? short(got.e) : got.o));
  await nc.close();
}

// ── 2) the run-driver credential drives a program across every plane its rows name ───────────
const A = await driver(RUN_A, TK_A);
{
  const driven = startRun(A.js, A.jsm, { space: S, endpoint: EP, runId: RUN_A, source: PROGRAM, kv: A.kv, lease: lease(TK_A, 1), handler: A.handler });
  // The wait arms after the sleep's real second has passed and its fire has been taken.
  await wait(4_000);
  await say("the build is green");
  const out = await withDeadline(driven.then((o) => ({ o }), (e: unknown) => ({ e })), 30_000, "the driven run");
  const entries = out !== undefined && "o" in out && out.o.status === "completed" ? out.o.result.journal.entries() : [];
  const heard = entries.find((e) => e.kind === "wait" && e.state === "settled");
  const slept = entries.find((e) => e.kind === "sleep" && e.state === "settled");
  c("a narrow driver completes the program through host-mediated sleep and channel wait",
    out !== undefined && "o" in out && out.o.status === "completed" && slept !== undefined
      && (heard?.result as CotalMessage | undefined)?.from?.name === "ann",
    out && ("e" in out ? short(out.e) : JSON.stringify({ status: out.o.status, kinds: entries.map((e) => `${e.kind}:${e.state}`) })));
  const program = await readRunProgram(A.kv, EP, RUN_A);
  c("and the program record was pinned beside the run record, verbatim", program?.source === PROGRAM, program);
  console.log("• 2 — the profile drove a program end to end");
}

// ── 3) enumeration is a consumer-free walk, because the profile has no consumer verb here ────
{
  const operatorNc = await open(await mintCreds(auth, newIdentity(), "run-operator", { runOperator: { endpoint: EP, takeoverId: newTakeoverId() } }));
  const operatorKv = await openRecordsBucket(operatorNc, S);
  const specs = await walkKvEntries(operatorKv, "run.*.*.spec").then((es) => es.map((e) => e.key), (e: unknown) => short(e));
  c("the operator `ps` walk lists the run over its STREAM.MSG.GET row",
    Array.isArray(specs) && specs.length === 1 && specs[0] === `run.${EP}.${RUN_A}.spec`, specs);
  const scan = await liveKvEntries(operatorKv, "run.>").then(() => "allowed", (e: unknown) => (denied(e) ? "denied" : short(e)));
  c("the consumer-backed pass is REFUSED on the same handle: the walk is the read, not a shortcut past a grant",
    scan === "denied", scan);
  const bare = await A.jsm.consumers.add(recordsKvStreamName(S), { filter_subject: `$KV.cotal_records_${S}.>` })
    .then(() => "allowed", (e: unknown) => (denied(e) ? "denied" : short(e)));
  c("nor may it create any consumer on the records store, named or bare", bare === "denied", bare);
}

// ── 4) one run, one takeover attempt, one set of timer coordinates ──────────────────────────
{
  const specB = await A.rawKv.put(`run.${EP}.${RUN_B}.spec`, new TextEncoder().encode("{}"), { previousSeq: 0 })
    .then(() => "allowed", (e: unknown) => denied(e) ? "denied" : short(e));
  c("run A's credential cannot write run B's record", specB === "denied", specB);
  const otherTk = await replayRunJournal(A.js, A.jsm, S, RUN_A, newTakeoverId())
    .then(() => "allowed", (e: unknown) => (denied(e) ? "denied" : short(e)));
  c("a second takeover attempt is a second credential: this one is refused a replay durable it was not minted for", otherTk === "denied", otherTk);
  const laterEpoch = await A.hostPlanes.js.publish(eptSubject(S, EP, IID, EPOCH + 1, "cnRlc3Rfc2xlZXBfdG9rZW5fMDAwMQ", "schedule"), new Uint8Array(0))
    .then(() => "allowed", (e: unknown) => (denied(e) ? "denied" : short(e)));
  c("a schedule request under any other epoch is refused: the timer coordinates are this attempt's own", laterEpoch === "denied", laterEpoch);
  const chat = await A.js.publish(chatSubject(S, DEV_OWNER, "wf", CHANNEL), new Uint8Array(0))
    .then(() => "allowed", (e: unknown) => (denied(e) ? "denied" : short(e)));
  c("the driver cannot speak on a channel: agents speak, the run only listens", chat === "denied", chat);
  const wfj = await A.jsm.streams.getMessage(wfjStreamName(S), { last_by_subj: wfjSubject(S, RUN_A) })
    .then(() => "allowed", (e: unknown) => (denied(e) ? "denied" : short(e)));
  c("and it holds no read of the journal stream at large, only its own filtered replay durable", wfj === "denied", wfj);
}

// ── 5) a takeover is minted for its own attempt and resumes the same run ────────────────────
{
  const TK_2 = newTakeoverId();
  const B = await driver(RUN_A, TK_2);
  const replay = await replayRunJournal(B.js, B.jsm, S, RUN_A, TK_2).then((r) => r.records.length, (e: unknown) => short(e));
  c("a credential minted for the next takeover attempt replays run A's journal through its own durable",
    typeof replay === "number" && replay > 2, replay);
  const program = await readRunProgram(B.kv, EP, RUN_A);
  c("and reads the recorded program back, so a resume needs no file handed to it", program?.source === PROGRAM, program?.source?.slice(0, 40));
}

// The wait mediator reads the real pending journal before each operation.
{
  const runId = "run-host-controls";
  const takeover = newTakeoverId();
  const H = await driver(runId, takeover);
  const authority = createRunScopeAuthority(H.hostPlanes, runId, lease(takeover, 1));
  const host = createRunWaitHost(H.hostPlanes, authority);
  const refused = async (action: () => Promise<unknown>) => action().then(() => false, (e) => e instanceof RunScopeDenied);
  H.handler.wait = async (_req, ctx) => {
    await ctx.bind({ waitChannel: CHANNEL });
    await host.open(ctx.requestId, CHANNEL);
    c("the host refuses a wait request absent from its own pending journal",
      await refused(() => host.open("foreign-request", CHANNEL)));
    c("the host refuses a channel different from the recorded wait channel",
      await refused(() => host.open(ctx.requestId, "private")));
    await say("mediated answer");
    const messages = await host.fetch(ctx.requestId);
    c("the host fetch returns a real message and an opaque receipt", messages.length === 1, messages.length);
    const message = messages[0]!;
    c("the host refuses a sequence before the wait has bound its match",
      await refused(() => host.messageAt(ctx.requestId, message.sequence)));
    await ctx.bind({ waitChannel: CHANNEL, chatSeq: message.sequence });
    const saved = await host.messageAt(ctx.requestId, message.sequence);
    c("the host rereads the bound message without exposing a stream reader",
      Buffer.from(saved).equals(Buffer.from(message.data)));
    const fake = JSON.parse(JSON.stringify(message.receipt));
    const forged = await host.ack(ctx.requestId, fake).then(() => "allowed", (e: Error) => e.message);
    c("a serialized copy of a receipt cannot acknowledge a delivery", forged.includes("no live delivery"), forged);
    await host.ack(ctx.requestId, message.receipt);
    await H.hostPlanes.nc.flush();
    const pending = (await H.hostPlanes.jsm.consumers.info(`CHAT_${S}`, `wfw_${ctx.requestId}`)).num_ack_pending;
    c("the live receipt commits the broker acknowledgement", pending === 0, pending);
    const duplicate = await host.ack(ctx.requestId, message.receipt).then(() => "allowed", (e: Error) => e.message);
    c("a receipt can acknowledge only once", duplicate.includes("no live delivery"), duplicate);
    await host.close(ctx.requestId);
    return JSON.parse(new TextDecoder().decode(message.data));
  };
  const source = `await wait(message(channel("${CHANNEL}")), { name: "mediated" });`;
  const out = await startRun(H.js, H.jsm, {
    space: S, endpoint: EP, runId, source,
    kv: runRecordView(H.kv, createRunRecordHost(H.hostPlanes, EP, runId), S),
    lease: lease(takeover, 1), handler: H.handler,
  });
  c("a workflow completes through the typed wait host", out.status === "completed", out.status);
  if (out.status !== "completed") throw new Error("the mediated wait control did not complete");
  const waited = out.result.journal.entries().find((entry) => entry.kind === "wait")!;
  c("a settled wait cannot be opened again through the host",
    await refused(() => host.open(waited.requestId!, CHANNEL)));
  c("the host derives an empty rearm set after the wait settles", (await authority.rearmTokens()).length === 0);
  const nextTakeover = newTakeoverId();
  const successor = await driver(runId, nextTakeover, EPOCH + 1, "successor", 2);
  const nextLease = { holder: "successor", epoch: EPOCH + 1, fencingToken: 2, takeoverId: nextTakeover };
  const resumed = await driveRun(successor.js, successor.jsm, {
    space: S, endpoint: EP, runId, source,
    kv: runRecordView(successor.kv, createRunRecordHost(successor.hostPlanes, EP, runId), S),
    lease: nextLease, handler: successor.handler,
  });
  c("a fresh driver activates the recorded run at the next epoch", resumed.status === "completed", resumed.status);
  const oldHost = await host.messageAt(waited.requestId!, waited.external!.chatSeq as number)
    .then(() => "allowed", (e: Error) => e.message);
  c("the previous host refuses operations after the next activation", oldHost.includes("superseded host"), oldHost);
  const nextAuthority = createRunScopeAuthority(successor.hostPlanes, runId, nextLease);
  const nextHost = createRunWaitHost(successor.hostPlanes, nextAuthority);
  const recovered = await nextHost.messageAt(waited.requestId!, waited.external!.chatSeq as number);
  c("the current host can recover the same recorded match", recovered.length > 0);

  const vault = new WaitReceipts();
  let acknowledgements = 0;
  const receipt = vault.issue("first", () => { acknowledgements++; });
  const wrongWait = await vault.ack("second", receipt).then(() => "allowed", (e: Error) => e.message);
  c("a live receipt is bound to the wait that fetched it", wrongWait.includes("no live delivery") && acknowledgements === 0, wrongWait);
  await vault.ack("first", receipt);
  c("a wrong-wait refusal does not consume the rightful receipt", acknowledgements === 1, acknowledgements);
  const closed = vault.issue("first", () => { acknowledgements++; });
  vault.close("first");
  const afterClose = await vault.ack("first", closed).then(() => "allowed", (e: Error) => e.message);
  c("closing a wait invalidates its remaining receipts", afterClose.includes("no live delivery") && acknowledgements === 1, afterClose);
}

// A real race leaves a settled loser under a parent cancellation obligation.
{
  const runId = "run-cleanup-controls";
  const takeover = newTakeoverId();
  const H = await driver(runId, takeover);
  const authority = createRunScopeAuthority(H.hostPlanes, runId, lease(takeover, 1));
  const pauses = createRunPauseHost(H.hostPlanes, {
    endpoint: EP, instanceId: IID, epoch: EPOCH, holder: { id: "manager", lifecycleUid: "u_rdauth" },
  }, authority);
  let fired = 0;
  H.handler.sleep = async (req, ctx) => {
    await pauses.arm(ctx.requestId, Date.now() + parseDuration(req.duration));
    for (;;) {
      if (ctx.signal.cancelled) {
        await pauses.claim(ctx.requestId);
        throw new Cancelled(ctx.signal.reason ?? "cancelled");
      }
      if (await pauses.takeFire(ctx.requestId)) fired++;
      if (await pauses.readSettle(ctx.requestId)) return null;
      await wait(250);
    }
  };
  const discharge = H.handler.discharge.bind(H.handler);
  let observed = false;
  H.handler.discharge = async (entries) => {
    const owed = await authority.cleanupEntries();
    const loser = owed.find((entry) => entry.kind === "sleep" && entry.state === "settled");
    c("a settled race parent authorizes cleanup of its settled losing sleep", loser !== undefined, owed.map((e) => `${e.kind}:${e.state}`));
    if (loser?.requestId === undefined) throw new Error("the race did not produce the settled cleanup control");
    observed = true;
    const claim = await authority.pause(loser.requestId, "claim");
    c("claim is authorized by the parent's outstanding cancellation", claim.requestId === loser.requestId);
    await pauses.claim(loser.requestId);
    const mint = await authority.pause(loser.requestId, "mint").then(() => "allowed", (e) => e instanceof RunScopeDenied ? "denied" : short(e));
    c("cancellation cleanup cannot authorize another mint", mint === "denied", mint);
    c("adoption's rearm set excludes cancelled loser tokens", !(await authority.rearmTokens()).includes(loser.requestId));
    await discharge(entries);
  };
  const source = `await race({
    fast: async () => { await sleep("1s", { name: "fast" }); },
    slow: async () => { await sleep("30s", { name: "slow" }); }
  }, { name: "choose" });`;
  const out = await startRun(H.js, H.jsm, { space: S, endpoint: EP, runId, source, kv: H.kv, lease: lease(takeover, 1), handler: H.handler });
  c("the race completes through the checked cleanup path", observed && out.status === "completed", out.status);
  c("the typed pause host handles a real broker timer fire", fired > 0, fired);
  c("recording issued=true removes the cleanup authority", (await authority.cleanupEntries()).length === 0);
  const foreignPause = await pauses.arm("foreign-token", Date.now() + 30_000)
    .then(() => "allowed", (e) => e instanceof RunScopeDenied ? "denied" : short(e));
  c("the pause host refuses a token absent from its own journal", foreignPause === "denied", foreignPause);
}

// A valid own-run step must not turn a forged bound plan into foreign registry authority.
{
  const runId = "run-conclave-forgery";
  const takeover = newTakeoverId();
  const H = await driver(runId, takeover);
  const channels = await openChannelRegistry(H.hostPlanes.nc, S);
  const foreign = "existing-room";
  const value = new TextEncoder().encode(JSON.stringify({ description: "leave this room unchanged" }));
  await channels.put(foreign, value);
  const openConclave = H.handler.openConclave;
  let bound = false;
  let refusal = "";
  H.handler.openConclave = async (req, ctx) => {
    await ctx.bind({ channel: foreign, registered: true, members: [] });
    bound = true;
    try { return await openConclave(req, ctx); }
    catch (error) { refusal = (error as Error).message; throw error; }
  };
  await startRun(H.js, H.jsm, {
    space: S, endpoint: EP, runId,
    source: 'try { await conclave([], async (room) => { log("room", room.channel); }, { name: "room" }); } catch (e) { log("rejected", true); }',
    kv: H.kv, lease: lease(takeover, 1), handler: H.handler,
  });
  c("the forged conclave plan was written through a live step binding", bound);
  c("the host rejects forged ownership of an existing channel", refusal.includes("recorded conclave"), refusal);
  const after = await channels.get(foreign);
  c("a forged conclave plan leaves the existing channel unchanged",
    after?.operation === "PUT" && Buffer.from(after.value).equals(Buffer.from(value)), after?.operation);
}

// Cross-run controls use resources created through run B's own connection.
{
  const takeover = newTakeoverId();
  const B = await driver(RUN_B, takeover);
  const source = 'await sleep("1s", { name: "foreign" });';
  const out = await startRun(B.js, B.jsm, {
    space: S, endpoint: EP, runId: RUN_B, source, kv: B.kv,
    lease: lease(takeover, 1), handler: B.handler,
  });
  c("the foreign-read control is a completed second run", out.status === "completed", out.status);
  const foreignProgram = await readRunProgram(B.kv, EP, RUN_B);
  c("run B can read its own recorded program", foreignProgram?.source === source, foreignProgram);
  const records = createRunRecordHost(A.hostPlanes, EP, RUN_A);
  const own = await records.read(`program.${EP}.${RUN_A}`);
  c("the record host returns its own program through a leader read",
    own !== undefined && JSON.parse(new TextDecoder().decode(own.value)).source === PROGRAM);
  const crossRead = await records.read(`program.${EP}.${RUN_B}`)
    .then(() => "allowed", (e) => e instanceof RunScopeDenied ? "denied" : short(e));
  c("the record host refuses another run's existing program", crossRead === "denied", crossRead);
  const view = runRecordView(A.kv, records, S);
  c("core program readers work through the mediated record view", (await readRunProgram(view, EP, RUN_A))?.source === PROGRAM);
  const viewRead = await readRunProgram(view, EP, RUN_B)
    .then(() => "allowed", (e) => e instanceof RunScopeDenied ? "denied" : short(e));
  c("core program readers cannot bypass the view's run boundary", viewRead === "denied", viewRead);
  const crossList = await records.list(`program.${EP}.>`)
    .then(() => "allowed", (e) => e instanceof RunScopeDenied ? "denied" : short(e));
  c("the record host refuses an endpoint-wide record walk", crossList === "denied", crossList);
  c("the record host permits an empty own-run notice walk", (await records.list(`notice.${EP}.${RUN_A}.>`)).length === 0);
  const read = await readRunProgram(A.rawKv, EP, RUN_B)
    .then(() => "allowed", (e: unknown) => denied(e) ? "denied" : short(e));
  c("run A cannot read run B's program through its records connection", read === "denied", read);

  const sleep = out.status === "completed" ? out.result.journal.entries().find((e) => e.kind === "sleep") : undefined;
  if (sleep?.requestId === undefined) throw new Error("run B produced no checkpoint token for the write control");
  const foreignKey = `cp.${EP}.${sleep.requestId}.spec`;
  const stored = await B.hostPlanes.kv.get(foreignKey);
  c("the foreign checkpoint key exists before the write probe", stored !== null, stored?.revision);
  const write = await A.rawKv.update(foreignKey, stored!.value, stored!.revision)
    .then(() => "allowed", (e: unknown) => denied(e) ? "denied" : short(e));
  c("run A cannot update another run's checkpoint key", write === "denied", write);

  const durable = "wfw_foreign_run_b";
  await B.hostPlanes.jsm.consumers.add(`CHAT_${S}`, {
    durable_name: durable, filter_subject: chatSubject(S, "*", "*", CHANNEL),
    ack_policy: "explicit" as never, deliver_policy: "new" as never,
  });
  c("the foreign wait durable exists before the delete probe",
    (await B.hostPlanes.jsm.consumers.info(`CHAT_${S}`, durable)).name === durable);
  const remove = await A.jsm.consumers.delete(`CHAT_${S}`, durable)
    .then(() => "allowed", (e: unknown) => denied(e) ? "denied" : short(e));
  c("run A cannot delete run B's wait durable", remove === "denied", remove);

  const before = await replayRunJournal(A.hostPlanes.js, A.hostPlanes.jsm, S, RUN_A, TK_A);
  const nextEntrySeq = Math.max(...before.records.flatMap(({ record }) => record.kind === "step" ? [(record.entry as { seq: number }).seq] : [-1])) + 1;
  const copied = {
    v: 1, seq: nextEntrySeq, run: RUN_A, scope: "", kind: "sleep", name: "copied-pause", occurrence: 0,
    inputHash: sleep.inputHash, requestId: sleep.requestId, state: "pending", startedAt: Date.now(),
  };
  await A.js.publish(wfjSubject(S, RUN_A), new TextEncoder().encode(JSON.stringify({
    v: 1, kind: "step", run: RUN_A, n: before.records.length, at: Date.now(), entry: copied,
  })));
  const after = await replayRunJournal(A.hostPlanes.js, A.hostPlanes.jsm, S, RUN_A, TK_A);
  c("the foreign token was appended to the attacker's own broker journal",
    after.records.some(({ record }) => record.kind === "step" && (record.entry as { requestId?: string }).requestId === sleep.requestId));
  const authority = createRunScopeAuthority(A.hostPlanes, RUN_A, lease(TK_A, 1));
  const pauses = createRunPauseHost(A.hostPlanes, {
    endpoint: EP, instanceId: IID, epoch: EPOCH, holder: { id: "manager", lifecycleUid: "u_rdauth" },
  }, authority);
  const copiedRead = await pauses.readSettle(sleep.requestId)
    .then(() => "allowed", (e) => e instanceof RunScopeDenied ? "denied" : short(e));
  c("copying a foreign token into the driver's own journal grants no host access", copiedRead === "denied", copiedRead);

}

// Exercise the executable's dispatcher and error renderer without running seed installation.
{
  const credsFile = join(dir, "single-driver.creds");
  const programFile = join(dir, "raw-local.cotal.js");
  writeFileSync(credsFile, await mintCreds(auth, newIdentity(), "run-driver", {
    runDriver: { endpoint: EP, runId: "run-raw-cli", takeoverId: newTakeoverId(), instanceId: IID, epoch: EPOCH },
  }), { mode: 0o600 });
  writeFileSync(programFile, 'log("local");');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
  env.HOME = dir;
  env.XDG_CONFIG_HOME = join(dir, "config");
  const entry = join(dir, "run-cli.mts");
  writeFileSync(entry, `
    import ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
    import { registry } from ${JSON.stringify(import.meta.resolve("@cotal-ai/core"))};
    import { runCli } from ${JSON.stringify(new URL("../../cli/src/command.ts", import.meta.url).href)};
    await runCli(registry, process.argv.slice(2));
  `);
  const result = spawnSync(process.execPath, [
    "--import", import.meta.resolve("tsx"), entry,
    "run", "start", "--local", "--server", SERVERS, "--space", S, "--creds", credsFile, "--file", programFile,
  ], { cwd: dir, env, encoding: "utf8", timeout: 30_000 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  c("a single-credential local CLI attempt reaches the named refusal", result.status === 1 && output.includes("single --creds"), output.slice(-1200));
  c("the local credential refusal gives a concrete next command", output.includes("omit --creds") && output.includes("cotal run start --local --space"), output.slice(-1200));
  c("the local credential refusal renders without a stack trace", !/^\s+at /m.test(output) && result.status === 1, output.slice(-1200));
}
} catch (error) {
  fail++;
  console.log("  ✗ FAIL: the scenario threw before completing", error);
}

console.log(`run-driver-auth.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
