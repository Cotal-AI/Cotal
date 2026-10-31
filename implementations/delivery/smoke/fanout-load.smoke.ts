/**
 * Delivery fan-out LOAD harness — what one channel message costs the delivery daemon, per member.
 * Default measurements report aggregate counts; optional verification checks recipient coverage.
 *
 * Boots a private operator-mode nats-server serving one space (one data account under one broker
 * operator, the hosted shape), starts the REAL hosted delivery service (`startDeliveryService`, the
 * entry a hosted composition runs, with its injected store holding the delivery, membership-rw and
 * membership-observer creds) in its own process, provisions M members through core's own onboarding
 * step (`provisionAgent`), and brings them up as real `CotalEndpoint`s configured the way
 * connector-core's `MeshAgent` configures them. Every member self-joins the channel durably at
 * connect, as a seat does, so the channel is a `durable` channel (the default class) with M members.
 * One member then posts on the channel at `--rate` messages a second for `--seconds`.
 * `--sublist-cache on|off` controls the native broker cache, default on. Posts reuse one
 * sender/channel subject; this workload does not measure controlled subject churn.
 *
 * Every post costs the daemon a Plane-3 fan-out: the writer reads it off CHAT, scans the members
 * registry, and writes one copy per eligible member into the mixed inbox; the trusted reader then
 * re-authorizes each copy and transfers it into the member's DLV store, which the member pumps and
 * acks. Members ack every durable copy on receipt, as a seat that surfaced it would.
 * Durable redelivery remains legal and can still occur.
 *
 * What it reports: messages posted, the daemon's CPU per message and per message per member, how
 * far behind the daemon is when posting stops and how long it takes to catch up (a daemon that
 * cannot keep up shows as a backlog that grows with the run, not as an error), the broker's CPU and
 * its bytes written to disk per message, per-stream copies per message, and the durable delivery
 * latency the members observed (post to durable copy, on one host clock).
 *
 * Members and the poster run in CHILD PROCESSES, and the daemon in its own, so the daemon's CPU is
 * read from /proc without the members' work in it. Credentials reach a child over IPC, never argv.
 *
 * `--verify-delivery` retains acknowledged publish IDs and each member's durable IDs, then
 * checks coverage separately for every recipient (and no self-delivery to the poster). Missing or
 * unconfirmed IDs, failed members, publish errors or endpoint errors at the sample make the run
 * exit nonzero. A publish timeout has unknown outcome; an unconfirmed ID is not proof of foreign
 * traffic. Missing IDs describe the sample cutoff, not permanent loss or future redeliveries.
 * Repeated durable copies are reported, not rejected: the transport is at-least-once. This does
 * not check live delivery, payload integrity or ordering. The extra O(posts × members) memory and
 * callback work make this a separate correctness workload, not a comparable performance sample.
 *
 * `--ram` adds the RAM cost of what a post leaves behind. The broker's live heap is read from its
 * pprof endpoint after a forced GC before the posts and after the drain, so the difference per
 * stored INBOX or DLV copy is what a retained copy costs the broker in memory, split by the site
 * that allocated it (the message store's index and cache, the duplicate window's message ids). No
 * space credential may purge or reconfigure INBOX or DLV, so the run reads them as shipped. The
 * daemon reports V8's view of its memory and a heap snapshot summarised by class.
 *
 * Run (needs nats-server 2.15.1 on PATH or NATS_SERVER_BIN):
 *   pnpm -C implementations/delivery smoke:fanout-load --members 50 --rate 10 --seconds 30
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getHeapSpaceStatistics, writeHeapSnapshot } from "node:v8";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  CotalEndpoint, chatStream, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, dlvStream, inboxStream,
  isReachable, mintCreds, mintLifecycleUid, mintMembershipObserverCreds, newIdentity, provisionAgent, serverConfig,
  setupSpaceStreams, dialerFor, standaloneConnectOpts, type CotalMessage, type SecretStore,
} from "@cotal-ai/core";
import { deliveryCredsKey, membershipObserverCredsKey, membershipRwCredsKey } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, brokerHeap, heapSnapshotTop, killAndAwaitExit, procMem, teardownOnSignal, type BrokerHeap } from "@cotal-ai/smoke-kit";
import { startDeliveryService } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { deliveryCoverage } from "./_delivery-coverage.js";

// ---------------------------------------------------------------------------------------------
// shared shapes
// ---------------------------------------------------------------------------------------------

/** One provisioned member. Carries its credential, so it travels over IPC only. */
interface MemberSpec { id: string; name: string; uid: string; creds: string }
interface MemberJob { kind: "members"; servers: string; space: string; members: MemberSpec[]; concurrency: number; verifyDelivery: boolean; posterId: string }
interface DaemonJob {
  kind: "daemon"; servers: string; space: string; accountPub: string; stateDir: string;
  /** The hosted store's three entries, keyed as the daemon reads them. */
  secrets: Record<string, string>;
}
interface MemberCoverage extends ReturnType<typeof deliveryCoverage> { member: string }
/** What a member child reports. Latencies are post-to-durable-copy, in ms. */
interface MemberSample { coverage?: MemberCoverage[]; up: number; failed: number; live: number; durable: number; durableLatencies: number[]; posted: number; postErrors: number; errors: number; firstErrors: string[] }

// Scrub any ambient COTAL_* before anything is handed to a child. Whatever runs this harness may
// itself be a managed agent session, and its COTAL_SERVERS / credential variables name a LIVE mesh.
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];

const CHANNEL = "general";
const ROLE = "default";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** About the size of a short agent post: the text a seat sends on a channel is a sentence or two. */
const POST_TEXT = "status: ".padEnd(480, "lorem ipsum dolor sit amet ");
const MAX_LATENCY_SAMPLES = 50_000;

/** Nearest-rank percentile over an unsorted sample array. 0 samples reports NaN, never a 0 that
 *  would read as a fast run. */
function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

const ipcSend = (m: unknown): Promise<void> => new Promise((r) => { process.send!(m, () => r()); });
const nextJob = <T>(): Promise<T> => new Promise((r) => process.once("message", (m) => r(m as T)));

// ---------------------------------------------------------------------------------------------
// member child: real endpoints configured as MeshAgent configures one; the first may post
// ---------------------------------------------------------------------------------------------

async function runMembers(job: MemberJob): Promise<void> {
  const eps: CotalEndpoint[] = [];
  let up = 0, failed = 0, live = 0, durable = 0, posted = 0, postErrors = 0, errors = 0;
  const durableLatencies: number[] = [];
  const received = job.verifyDelivery ? new Map(job.members.map((s) => [s.id, new Map<string, number>()])) : undefined;
  const postedIds: string[] = [];
  const firstErrors: string[] = [];
  const note = (e: Error) => { errors++; if (firstErrors.length < 5) firstErrors.push(e.message.slice(0, 200)); };
  const queue = [...job.members];
  await Promise.all(Array.from({ length: job.concurrency }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      // MeshAgent's construction (extensions/connector-core/src/agent.ts), minus the bearer, TLS and
      // file-derived fields a static-creds seat leaves unset.
      const ep = new CotalEndpoint({
        space: job.space, servers: job.servers, creds: s.creds, lifecycleUid: s.uid, channels: [CHANNEL],
        card: { id: s.id, name: s.name, role: ROLE, kind: "agent", meta: { connector: "claude-code", model: "claude-opus-5-5", host: "seat-host", cwd: "/home/user/project" } },
      });
      const receivedIds = received?.get(s.id);
      ep.on("error", note);
      ep.on("warning", note);
      ep.on("message", (m: CotalMessage, d: { durable: boolean; ack(): void }) => {
        if (d.durable) {
          durable++;
          if (receivedIds) receivedIds.set(m.id, (receivedIds.get(m.id) ?? 0) + 1);
          if (durableLatencies.length < MAX_LATENCY_SAMPLES) durableLatencies.push(Date.now() - m.ts);
          // A seat acks a durable copy once it has surfaced it; this one surfaces it on receipt.
          d.ack();
        } else live++;
      });
      try { await ep.start(); eps.push(ep); up++; } catch (e) { failed++; note(e as Error); }
    }
  }));
  await ipcSend({ allUp: true, up, failed, firstErrors });

  for (;;) {
    const cmd = await nextJob<{ cmd: "post"; rate: number; seconds: number } | { cmd: "reset" } | { cmd: "sample"; postedIds?: string[] } | { cmd: "stop" }>();
    if (cmd.cmd === "stop") break;
    if (cmd.cmd === "reset") { live = 0; durable = 0; durableLatencies.length = 0; for (const ids of received?.values() ?? []) ids.clear(); await ipcSend({ reset: true }); continue; }
    if (cmd.cmd === "post") {
      // Offer posts on a fixed schedule; a slow publish ack must not slow the OFFERED rate.
      const poster = eps[0];
      const total = Math.round(cmd.rate * cmd.seconds);
      const t0 = performance.now();
      const inflight = new Set<Promise<void>>();
      let issued = 0;
      while (issued < total) {
        const due = Math.min(total, Math.floor(((performance.now() - t0) / 1000) * cmd.rate) + 1);
        while (issued < due) {
          issued++;
          const p = poster.multicast(`${POST_TEXT} #${issued}`, { channel: CHANNEL }).then((m) => { posted++; if (job.verifyDelivery) postedIds.push(m.id); }, (e: Error) => { postErrors++; note(e); }).finally(() => inflight.delete(p));
          inflight.add(p);
        }
        await wait(5);
      }
      await Promise.allSettled([...inflight]);
      await ipcSend({ posted: { posted, postErrors, ms: performance.now() - t0, ...(job.verifyDelivery ? { postedIds } : {}) } });
      continue;
    }
    let coverage: MemberCoverage[] | undefined;
    if (received) {
      if (!cmd.postedIds) throw new Error("delivery verification requires acknowledged publish IDs");
      coverage = job.members.map((s) => ({ member: s.name, ...deliveryCoverage(s.id === job.posterId ? [] : cmd.postedIds!, received.get(s.id)!) }));
    }
    await ipcSend({ sample: { up, failed, live, durable, durableLatencies, posted, postErrors, errors, firstErrors, ...(coverage ? { coverage } : {}) } satisfies MemberSample });
  }
  await Promise.all(eps.map((ep) => ep.stop().catch(() => {})));
  await ipcSend({ stopped: true });
}

// ---------------------------------------------------------------------------------------------
// daemon child: the real hosted delivery service
// ---------------------------------------------------------------------------------------------

class MemoryStore implements SecretStore {
  readonly values = new Map<string, string>();
  constructor(readonly identity: { kind: "injected"; coordinate: string }) {}
  async get(k: string) { return this.values.get(k); }
  async put(k: string, v: string) { this.values.set(k, v); }
  async create(k: string, v: string) { if (this.values.has(k)) return false; this.values.set(k, v); return true; }
  async delete(k: string) { this.values.delete(k); }
}

async function runDaemon(job: DaemonJob): Promise<void> {
  const store = new MemoryStore({ kind: "injected", coordinate: `memory:${job.space}` });
  for (const [k, v] of Object.entries(job.secrets)) await store.put(k, v);
  const handle = await startDeliveryService({
    context: { accountPublicKey: job.accountPub, lifecycleUid: `fanout-load-${job.space}` },
    space: job.space, servers: job.servers, store, storeIdentity: store.identity, stateDir: job.stateDir,
  });
  await ipcSend({ ready: (await handle.readiness()).state });
  for (;;) {
    const cmd = await nextJob<{ cmd: "stop" } | { cmd: "sample" } | { cmd: "snapshot"; path: string }>();
    if (cmd.cmd === "stop") break;
    if (cmd.cmd === "snapshot") { (globalThis as { gc?: () => void }).gc?.(); await ipcSend({ snapshot: writeHeapSnapshot(cmd.path) }); continue; }
    const m = process.memoryUsage();
    const code = getHeapSpaceStatistics().filter((x) => x.space_name.startsWith("code")).reduce((a, x) => a + x.space_used_size, 0);
    await ipcSend({ sample: { heapUsedMb: m.heapUsed / 1048576, heapTotalMb: m.heapTotal / 1048576, externalMb: m.external / 1048576, codeMb: code / 1048576 } });
  }
  await handle.close().catch(() => {});
  await ipcSend({ stopped: true });
}

if (process.argv[2] === "child") {
  const job = await nextJob<MemberJob | DaemonJob>();
  if (job.kind === "members") await runMembers(job);
  else await runDaemon(job);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string): string => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) return argv[i + 1];
  if (dflt === undefined) throw new Error(`fanout-load: --${name} is required`);
  return dflt;
};
const num = (name: string, dflt?: string): number => {
  const v = Number(flag(name, dflt));
  if (!Number.isFinite(v)) throw new Error(`fanout-load: --${name} must be a number`);
  return v;
};

const MEMBERS = Math.max(2, num("members", "10"));
const RATE = num("rate", "5");
const SECONDS = num("seconds", "30");
/** How long the daemon gets, after posting stops, to empty its backlog before the run is cut. */
const DRAIN_S = num("drain", "120");
const MEMBER_PROCS = Math.max(1, Math.min(availableParallelism() * 2, num("member-procs", String(Math.min(availableParallelism(), Math.ceil(MEMBERS / 100))))));
const NATS_BIN = process.env.NATS_SERVER_BIN ?? "nats-server";
const SUBLIST_CACHE = flag("sublist-cache", argv.includes("--sublist-cache") ? undefined : "on");
if (SUBLIST_CACHE !== "on" && SUBLIST_CACHE !== "off")
  throw new Error("fanout-load: --sublist-cache must be on or off");
const RAM = argv.includes("--ram");
const VERIFY_DELIVERY = argv.includes("--verify-delivery");
/** Seconds to wait after the drain before reading the broker's retained heap. */
const RAM_WAIT_S = num("ram-wait", "30");

const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd: import.meta.dirname }).trim();
const SHA = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: REPO }).trim();
const EXPECT_SERVER = "2.15.1";
const serverVersion = (() => {
  const v = execFileSync(NATS_BIN, ["--version"], { encoding: "utf8" }).trim();
  return (/\d+\.\d+\.\d+/.exec(v) ?? ["unknown"])[0];
})();
if (serverVersion !== EXPECT_SERVER)
  throw new Error(`fanout-load: this harness measures nats-server ${EXPECT_SERVER}; ${NATS_BIN} is ${serverVersion}. Set NATS_SERVER_BIN.`);

// ---- /proc sampling ----------------------------------------------------------------------------
const CLK_TCK = 100; // Linux x86_64; this harness is Linux-only, like the rest of the load path.
const procCpuMs = (pid: number): number => {
  const s = readFileSync(`/proc/${pid}/stat`, "utf8");
  const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
  return ((Number(f[11]) + Number(f[12])) / CLK_TCK) * 1000; // utime + stime
};
const procRssMb = (pid: number): number => {
  const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
  return m ? Number(m[1]) / 1024 : NaN;
};
/** Bytes this process caused to be written to the storage layer: JetStream's file store, here. */
const procWriteBytes = (pid: number): number => Number(/write_bytes:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/io`, "utf8"))![1]);

// ---- broker -------------------------------------------------------------------------------------
const PORT = await pickFreePort();
const MON_PORT = await pickFreePort();
const PROF_PORT = RAM ? await pickFreePort() : 0;
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `fanout-${randomUUID().slice(0, 8)}`;
const brokerAuth = await createBrokerAuth(`fanout-load-${space}`);
const account = await createSpaceAccountAuth(brokerAuth, space);
const auth = composeSpaceAuth(brokerAuth, account);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(brokerAuth, [account], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }) + `\ndisable_sublist_cache: ${SUBLIST_CACHE === "off"}\nhttp: 127.0.0.1:${MON_PORT}\n` + (RAM ? `prof_port: ${PROF_PORT}\n` : ""));
const srv = spawn(NATS_BIN, ["-c", join(dir, "server.conf")], { stdio: ["ignore", "ignore", "pipe"] });
const releaseBroker = teardownOnSignal(srv, dir);
let brokerPartial = "";
const brokerWarnings: string[] = [];
srv.stderr!.setEncoding("utf8");
srv.stderr!.on("data", (d: string) => {
  const lines = (brokerPartial + d).split("\n");
  brokerPartial = lines.pop() ?? "";
  for (const l of lines) if (/\[(WRN|ERR|FTL)\]/.test(l)) { if (brokerWarnings.length < 2000) brokerWarnings.push(l); if (brokerWarnings.length <= 5) console.error(`  broker: ${l}`); }
});

interface StreamDetail { name: string; state: { messages: number; bytes: number; last_seq: number }; consumer_detail?: Array<{ name: string; num_pending: number; num_ack_pending: number }> }
const streams = async (): Promise<Map<string, StreamDetail>> => {
  const j = (await (await fetch(`http://127.0.0.1:${MON_PORT}/jsz?accounts=true&streams=true&consumers=true`)).json()) as { account_details?: Array<{ stream_detail?: StreamDetail[] }> };
  const out = new Map<string, StreamDetail>();
  for (const a of j.account_details ?? []) for (const s of a.stream_detail ?? []) out.set(s.name, s);
  return out;
};
/** The daemon's own backlog: what its fan-out writer and trusted reader have not yet taken. */
const backlog = (m: Map<string, StreamDetail>): { fanout: number; reader: number } => {
  const pending = (stream: string, durable: string) => {
    const c = m.get(stream)?.consumer_detail?.find((x) => x.name === durable);
    return c ? c.num_pending + c.num_ack_pending : NaN;
  };
  return { fanout: pending(chatStream(space), "fanout"), reader: pending(inboxStream(space), "reader") };
};

const children: ChildProcess[] = [];
let stopping = false;
let abort!: (e: Error) => void;
const aborted = new Promise<never>((_, reject) => { abort = reject; });
aborted.catch(() => {});
/** Rejects the moment any child dies before it was told to stop, so a dead daemon or member process
 *  fails the run instead of leaving it waiting on a report that will never come. */
const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, aborted]);
const startChild = (job: MemberJob | DaemonJob): ChildProcess => {
  const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, "child"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...cleanEnv, DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off" },
  });
  children.push(child);
  child.on("exit", (code, signal) => { if (!stopping) abort(new Error(`${job.kind} child ${child.pid} exited (${code ?? signal}) mid-run`)); });
  child.send(job);
  return child;
};
type Cmd = { cmd: "post"; rate: number; seconds: number } | { cmd: "reset" } | { cmd: "sample"; postedIds?: string[] } | { cmd: "snapshot"; path: string } | { cmd: "stop" };
const ask = (child: ChildProcess, cmd: Cmd | undefined, key: string): Promise<Record<string, unknown>> => guard(new Promise((resolve) => {
  const on = (m: Record<string, unknown>) => { if (key in m) { child.off("message", on); resolve(m); } };
  child.on("message", on);
  if (cmd) child.send(cmd);
}));

const rows: Array<[string, string]> = [];
const row = (k: string, v: string | number) => rows.push([k, typeof v === "number" ? (Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)) : v]);
const n2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");

try {
  let up = false;
  for (let i = 0; i < 100; i++) { if (srv.exitCode !== null) break; if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server ${serverVersion} did not come up on ${PORT}`);

  // ---- space, daemon, members ------------------------------------------------------------------
  const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
  // The window INBOX and DLV keep message ids for, as shipped: the RAM profile reports it beside the cost.
  const dupWindowS = RAM && await (async () => {
    const nc = await dialerFor(SERVERS)({ servers: SERVERS, ...standaloneConnectOpts({ creds: provCreds, tls: false }) });
    try { return (await (await jetstreamManager(nc)).streams.info(inboxStream(space))).config.duplicate_window / 1e9; } finally { await nc.drain(); }
  })();
  const composition = { injected: true as const };
  const daemon = startChild({
    kind: "daemon", servers: SERVERS, space, accountPub: account.account.pub, stateDir: join(dir, "delivery-state"),
    secrets: {
      [deliveryCredsKey(space, composition)]: await mintCreds(auth, newIdentity(), "delivery"),
      [membershipRwCredsKey(space, composition)]: await mintCreds(auth, newIdentity(), "membership-rw"),
      [membershipObserverCredsKey(space, composition)]: await mintMembershipObserverCreds(auth, newIdentity()),
    },
  });
  const ready = await ask(daemon, undefined, "ready");
  if (ready.ready !== "ready") throw new Error(`delivery service reported ${String(ready.ready)}, not ready`);

  const prov = new CotalEndpoint({ space, servers: SERVERS, creds: provCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  prov.on("error", () => {});
  await prov.start();
  const members: MemberSpec[] = [];
  for (let i = 0; i < MEMBERS; i++) {
    const identity = newIdentity();
    const uid = mintLifecycleUid();
    const creds = await provisionAgent(prov, auth, identity, { subscribe: [CHANNEL], allowSubscribe: [CHANNEL], allowPublish: [CHANNEL], role: ROLE, lifecycleUid: uid });
    members.push({ id: identity.id, name: `member-${i}`, uid, creds });
  }
  await prov.stop();

  // The poster is member 0, alone in the first child, so its own publish work is not mixed into
  // another member process's figures and the others are spread evenly.
  const kids: ChildProcess[] = [];
  const groups: MemberSpec[][] = [members.slice(0, 1)];
  const rest = members.slice(1);
  const per = Math.ceil(rest.length / MEMBER_PROCS);
  for (let p = 0; p < MEMBER_PROCS; p++) if (rest.slice(p * per, (p + 1) * per).length) groups.push(rest.slice(p * per, (p + 1) * per));
  const ups = await Promise.all(groups.map((g) => {
    const kid = startChild({ kind: "members", servers: SERVERS, space, members: g, concurrency: 8, verifyDelivery: VERIFY_DELIVERY, posterId: members[0].id });
    kids.push(kid);
    return ask(kid, undefined, "allUp");
  }));
  const membersUp = ups.reduce((a, m) => a + (m.up as number), 0);
  const membersFailed = ups.reduce((a, m) => a + (m.failed as number), 0);
  if (membersUp < MEMBERS) console.error(`  ! ${membersFailed} member(s) failed to start: ${ups.flatMap((m) => m.firstErrors as string[]).slice(0, 3).join(" | ")}`);
  const poster = kids[0];

  // Settle (boot self-joins, backfills), then a quiet baseline for the daemon's idle CPU.
  await wait(5000);
  await Promise.all(kids.map((k) => ask(k, { cmd: "reset" }, "reset")));
  const idle0 = procCpuMs(daemon.pid!);
  await wait(5000);
  const daemonIdleCoresMs = (procCpuMs(daemon.pid!) - idle0) / 5000;

  // ---- the measured run ---------------------------------------------------------------------------
  const heap0: BrokerHeap | undefined = RAM ? await brokerHeap(`http://127.0.0.1:${PROF_PORT}`) : undefined;
  const s0 = await streams();
  const d0 = procCpuMs(daemon.pid!), b0 = procCpuMs(srv.pid!), w0 = procWriteBytes(srv.pid!), rss0 = procRssMb(srv.pid!);
  const k0 = kids.map((k) => procCpuMs(k.pid!));
  const t0 = performance.now();
  const postReport = (await ask(poster, { cmd: "post", rate: RATE, seconds: SECONDS }, "posted")).posted as { posted: number; postErrors: number; ms: number; postedIds?: string[] };
  const postS = (performance.now() - t0) / 1000;
  const atStop = backlog(await streams());
  // Drain: the daemon's work is done when both its durables have nothing pending.
  let drainedAt: number | undefined;
  let last = atStop;
  const drainUntil = performance.now() + DRAIN_S * 1000;
  while (performance.now() < drainUntil) {
    last = backlog(await streams());
    if (last.fanout === 0 && last.reader === 0) { drainedAt = performance.now(); break; }
    await wait(250);
  }
  const endS = ((drainedAt ?? performance.now()) - t0) / 1000;
  const daemonCpuMs = procCpuMs(daemon.pid!) - d0 - daemonIdleCoresMs * endS * 1000;
  const brokerCpuMs = procCpuMs(srv.pid!) - b0;
  const writeBytes = procWriteBytes(srv.pid!) - w0;
  const memberCpuMs = kids.reduce((a, k, i) => a + procCpuMs(k.pid!) - k0[i], 0);
  // Let the final DLV copies reach the members without adding this tail to the CPU window.
  await wait(1000);
  const s1 = await streams();
  const samples = (await Promise.all(kids.map((k) => ask(k, { cmd: "sample", ...(VERIFY_DELIVERY ? { postedIds: postReport.postedIds } : {}) }, "sample")))).map((m) => m.sample as MemberSample);

  const posted = postReport.posted;
  const recipients = membersUp - 1; // the fan-out never backstops the sender's own post
  const durableGot = samples.reduce((a, s) => a + s.durable, 0);
  const liveGot = samples.reduce((a, s) => a + s.live, 0);
  const lat = samples.flatMap((s) => s.durableLatencies);
  const copies = (name: string) => (s1.get(name)?.state.last_seq ?? 0) - (s0.get(name)?.state.last_seq ?? 0);

  row("git sha", SHA);
  row("nats-server", `${serverVersion} (${NATS_BIN})`);
  row("subscription cache", SUBLIST_CACHE);
  row("delivery ID verification", VERIFY_DELIVERY ? "on (extra tracking overhead)" : "off (aggregate counts only)");
  row("host", `${availableParallelism()} cores, ${(totalmem() / 1073741824).toFixed(1)} GB`);
  row("shape", `1 space, durable channel #${CHANNEL}, ${membersUp} members up (${membersFailed} failed), ${kids.length} member process(es)`);
  row("offered", `${RATE} posts/s for ${SECONDS}s by one member`);
  rows.push(["", ""]);
  row("posts accepted / publish errors", `${posted} / ${postReport.postErrors}`);
  row("achieved post rate (/s)", posted / (postReport.ms / 1000));
  row("daemon backlog when posting stopped (fanout / reader)", `${atStop.fanout} / ${atStop.reader}`);
  row("daemon caught up", drainedAt ? `yes, ${(endS - postS).toFixed(1)}s after posting stopped` : `NO: still ${last.fanout} / ${last.reader} after ${DRAIN_S}s`);
  row("daemon throughput (posts fanned out /s)", drainedAt ? posted / endS : NaN);
  row("durable copies delivered / expected", `${durableGot} / ${posted * recipients}`);
  row("live copies delivered", liveGot);
  if (VERIFY_DELIVERY) {
    const coverage = samples.flatMap((s) => s.coverage ?? []);
    const passed = posted > 0 && postReport.postedIds?.length === posted && coverage.length === MEMBERS && membersFailed === 0 && postReport.postErrors === 0
      && samples.every((s) => s.errors === 0) && coverage.every((s) => s.missing === 0 && s.unexpected === 0);
    row("durable recipient coverage", passed ? "PASS" : "FAIL");
    row("members checked / configured", `${coverage.length} / ${MEMBERS}`);
    for (const s of coverage) row(`  ${s.member} distinct/expected/missing/unconfirmed/repeated`, `${s.distinct} / ${s.expected} / ${s.missing} / ${s.unexpected} / ${s.repeated}`);
    if (!passed) process.exitCode = 1;
  }
  row("durable latency p50 / p95 / p99 (ms)", `${n2(pct(lat, 50))} / ${n2(pct(lat, 95))} / ${n2(pct(lat, 99))}`);
  rows.push(["", ""]);
  row("daemon idle CPU (cores)", daemonIdleCoresMs);
  row("daemon CPU over run, idle removed (cores)", daemonCpuMs / 1000 / endS);
  row("daemon CPU per post (ms)", daemonCpuMs / posted);
  row("daemon CPU per post per member (ms)", daemonCpuMs / posted / recipients);
  row("daemon RSS (MB)", procRssMb(daemon.pid!));
  row("broker CPU (cores)", brokerCpuMs / 1000 / endS);
  row("broker CPU per post per member (ms)", brokerCpuMs / posted / recipients);
  row("broker RSS before / after run (MB)", `${n2(rss0)} / ${n2(procRssMb(srv.pid!))}`);
  row("member processes CPU (cores)", memberCpuMs / 1000 / endS);
  rows.push(["", ""]);
  row("CHAT / INBOX / DLV copies per post", `${n2(copies(chatStream(space)) / posted)} / ${n2(copies(inboxStream(space)) / posted)} / ${n2(copies(dlvStream(space)) / posted)}`);
  row("broker bytes written to disk per post", writeBytes / posted);
  row("broker bytes written per post per member", writeBytes / posted / recipients);
  row("JetStream bytes held after drain (CHAT / INBOX / DLV)", `${s1.get(chatStream(space))?.state.bytes ?? 0} / ${s1.get(inboxStream(space))?.state.bytes ?? 0} / ${s1.get(dlvStream(space))?.state.bytes ?? 0}`);
  row("member endpoint errors and warnings", samples.reduce((a, s) => a + s.errors, 0));
  for (const e of samples.flatMap((s) => s.firstErrors).slice(0, 3)) row("  member error", e);
  row("broker warnings/errors logged", brokerWarnings.length);

  const w = Math.max(...rows.map(([k]) => k.length));
  console.log(`\n${"=".repeat(w + 34)}`);
  for (const [k, v] of rows) console.log(k === "" ? "" : `${k.padEnd(w)}  ${v}`);
  console.log(`${"=".repeat(w + 34)}\n`);

  if (RAM && heap0) {
    // ---- RAM profile: what the run's stored copies cost the broker, and the daemon -------------
    // The message store keeps recently written blocks cached for a while after the last write; the
    // retained cost is what is left once that has expired, not the burst's working set.
    await wait(RAM_WAIT_S * 1000);
    const prof = `http://127.0.0.1:${PROF_PORT}`;
    const heap1 = await brokerHeap(prof);
    const stored = (m: Map<string, StreamDetail>) => [inboxStream(space), dlvStream(space)].reduce((a, n) => a + (m.get(n)?.state.messages ?? 0), 0);
    const storedCopies = stored(s1) - stored(s0);
    const rss1 = procMem(srv.pid!);
    const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "n/a");
    const perCopyB = (mb: number) => (storedCopies > 0 ? ((mb * 1048576) / storedCopies).toFixed(0) : "n/a");
    console.log(`RAM profile: ${storedCopies} INBOX + DLV copies stored by the run, duplicate window ${dupWindowS}s (shipped)\n`);
    console.log("| broker | before posts | after drain |");
    console.log("|---|---|---|");
    console.log(`| live heap MB | ${f1(heap0.heapAllocMb)} | ${f1(heap1.heapAllocMb)} |`);
    console.log(`| RSS MB | ${f1(rss0)} | ${f1(rss1.rssMb)} |`);
    for (const p of ["streams", "consumers", "connections", "other"] as const)
      console.log(`| ${p} part of live heap MB | ${f1(heap0.heapByPart[p])} | ${f1(heap1.heapByPart[p])} |`);
    console.log("");
    console.log(`live heap per stored copy: ${perCopyB(heap1.heapAllocMb - heap0.heapAllocMb)} B`);
    const delta = new Map<string, number>();
    for (const t of heap1.sites) delta.set(t.site, (delta.get(t.site) ?? 0) + t.mb);
    for (const t of heap0.sites) delta.set(t.site, (delta.get(t.site) ?? 0) - t.mb);
    console.log("\nTop broker allocation sites grown by the run (live heap after the drain minus before the posts):\n");
    for (const [site, mb] of [...delta].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`- ${site}: ${f1(mb)} MB, ${perCopyB(mb)} B per stored copy`);

    const dm = procMem(daemon.pid!);
    const dv = (await ask(daemon, { cmd: "sample" }, "sample")).sample as { heapUsedMb: number; heapTotalMb: number; externalMb: number; codeMb: number };
    console.log(`\ndelivery daemon (1 space, ${membersUp} members): RSS ${f1(dm.rssMb)} MB, PSS ${f1(dm.pssMb)} MB, USS ${f1(dm.ussMb)} MB; JS heap used ${f1(dv.heapUsedMb)} of ${f1(dv.heapTotalMb)} MB, external ${f1(dv.externalMb)} MB, compiled code ${f1(dv.codeMb)} MB`);
    const file = (await ask(daemon, { cmd: "snapshot", path: join(dir, "daemon.heapsnapshot") }, "snapshot")).snapshot as string;
    const top = heapSnapshotTop(file, 3);
    rmSync(file, { force: true });
    console.log(`delivery daemon heap snapshot: ${f1(top.totalBytes / 1048576)} MB of objects; top classes by self size: ${top.top.map((t) => `${t.name} ${f1(t.bytes / 1048576)} MB (${t.count})`).join(", ")}`);
    console.log(`  script source ${f1(top.sources.bytes / 1048576)} MB in ${top.sources.scripts} scripts; largest by package: ${top.sources.byPackage.map((t) => `${t.name} ${f1(t.bytes / 1048576)} MB`).join(", ")}\n`);
  }

  stopping = true;
  await Promise.all([...kids, daemon].map((c) => ask(c, { cmd: "stop" }, "stopped").catch(() => undefined)));
} catch (e) {
  console.error("  ✗ fanout-load threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  stopping = true;
  for (const c of children) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
  // A broker killed without waiting can still be writing its store after the dir is removed, and
  // recreate it: wait for the exit first.
  await killAndAwaitExit(srv, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
  await new Promise<void>((r) => { process.stdout.write("", () => r()); });
  process.exit(process.exitCode ?? 0);
}
