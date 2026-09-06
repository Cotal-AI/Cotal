/**
 * The `run-driver` profile (SPEC 14.6) driving a run on an ENFORCING broker.
 *
 * Every other suite for the runtime runs on an open broker, so it proves what the handler does and
 * nothing about what a credential permits. `cotal run` used to connect as `admin`, and on an authed
 * mesh that was a driver that could not read its own run record: the first cell below is that
 * reproduction, kept so the profile's reason for existing stays measured rather than remembered.
 *
 * The second half is the profile itself, minted through `mintCreds` exactly as the manager will mint
 * it, driving a program that touches every plane the rows name: the journal, the run and program
 * records, a durable sleep (checkpoint records, the schedule request at its own coordinates, the fire
 * read, the settle fact), and a channel wait (the per-step durable, the message re-read). Then the
 * edges: the records enumeration is a consumer-free walk because the profile holds no consumer verb
 * on the records store, the credential is pinned to one run, one takeover attempt and one set of timer
 * coordinates, and it cannot speak on a channel or read the journal stream at large.
 *
 * Run: pnpm smoke:runtime-run-driver-auth   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
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
import { MeshHandler, EpfSettleWatcher, startRun } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

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
/** One driver's whole rig over ONE credential: the connection, its planes, its handler. */
const driver = async (runId: string, takeoverId: string, epoch = EPOCH) => {
  const id = newIdentity();
  const creds = await mintCreds(auth, id, "run-driver", { runDriver: { endpoint: EP, runId, takeoverId, instanceId: IID, epoch } });
  const nc = await open(creds);
  const js = jetstream(nc);
  const jsm = await jetstreamManager(nc);
  const kv = await openRecordsBucket(nc, S);
  const handler = new MeshHandler(
    nc, kv, js, jsm,
    { space: S, endpoint: EP, runId, caller: runDriverCaller(runId), instanceId: IID, epoch, holder: { id: "manager", lifecycleUid: "u_rdauth" }, defaultCheckpointTimeout: "1h" },
    new EpfSettleWatcher(jsm, S, 1_000),
    () => Date.now(),
  );
  return { nc, js, jsm, kv, handler };
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
  c("a run-driver credential drives the program to completion: journal, records, a fired sleep and a channel wait, all on its own rows",
    out !== undefined && "o" in out && out.o.status === "completed" && slept !== undefined
      && (heard?.result as CotalMessage | undefined)?.from?.name === "ann",
    out && ("e" in out ? short(out.e) : JSON.stringify({ status: out.o.status, kinds: entries.map((e) => `${e.kind}:${e.state}`) })));
  const program = await readRunProgram(A.kv, EP, RUN_A);
  c("and the program record was pinned beside the run record, verbatim", program?.source === PROGRAM, program);
  console.log("• 2 — the profile drove a program end to end");
}

// ── 3) enumeration is a consumer-free walk, because the profile has no consumer verb here ────
{
  const specs = await walkKvEntries(A.kv, "run.*.*.spec").then((es) => es.map((e) => e.key), (e: unknown) => short(e));
  c("the `ps` walk lists the run over the profile's own STREAM.MSG.GET row",
    Array.isArray(specs) && specs.length === 1 && specs[0] === `run.${EP}.${RUN_A}.spec`, specs);
  const scan = await liveKvEntries(A.kv, "run.>").then(() => "allowed", (e: unknown) => (denied(e) ? "denied" : short(e)));
  c("the consumer-backed pass is REFUSED on the same handle: the walk is the read, not a shortcut past a grant",
    scan === "denied", scan);
  const bare = await A.jsm.consumers.add(recordsKvStreamName(S), { filter_subject: `$KV.cotal_records_${S}.>` })
    .then(() => "allowed", (e: unknown) => (denied(e) ? "denied" : short(e)));
  c("nor may it create any consumer on the records store, named or bare", bare === "denied", bare);
}

// ── 4) one run, one takeover attempt, one set of timer coordinates ──────────────────────────
{
  const specB = await startRun(A.js, A.jsm, { space: S, endpoint: EP, runId: RUN_B, source: "return 2", kv: A.kv, lease: lease(TK_A, 1), handler: A.handler })
    .then((o) => JSON.stringify(o).slice(0, 80), (e: unknown) => (denied(e) ? "denied" : short(e)));
  c("run A's credential cannot start run B: B's record write is refused", specB === "denied", specB);
  const otherTk = await replayRunJournal(A.js, A.jsm, S, RUN_A, newTakeoverId())
    .then(() => "allowed", (e: unknown) => (denied(e) ? "denied" : short(e)));
  c("a second takeover attempt is a second credential: this one is refused a replay durable it was not minted for", otherTk === "denied", otherTk);
  const laterEpoch = await A.js.publish(eptSubject(S, EP, IID, EPOCH + 1, "cnRlc3Rfc2xlZXBfdG9rZW5fMDAwMQ", "schedule"), new Uint8Array(0))
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

console.log(`run-driver-auth.smoke: ${ok} passed, ${fail} failed`);
done();
process.exit(fail === 0 ? 0 : 1);
