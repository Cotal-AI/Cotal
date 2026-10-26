/**
 * Idle-seat LOAD harness — what one connected, idle seat costs the broker. Capacity, not correctness.
 *
 * Boots a private operator-mode nats-server serving S spaces, one data account each under one
 * broker operator (the hosted shape), provisions every seat through core's own onboarding step
 * (`provisionAgent`: the DM, DLV and role TASK durables, the read-ACL row and a scoped credential,
 * the step the manager runs at spawn), binds the delivery daemon's Plane-3 for every space, and then
 * brings up N seats as real `CotalEndpoint`s configured the way connector-core's `MeshAgent`
 * configures them: one boot channel, consume on, presence registered and read on demand (not
 * watched, AGENT-979), channel registry watched, the endpoint's own default heartbeat and TTL. Nothing on the wire is hand-rolled, so the
 * subscriptions, consumers, presence puts and pull keep-alives the broker serves are the product's.
 *
 * What it reports, once every seat is up and has settled: broker CPU and RSS per seat, broker
 * messages and bytes in and out per seat per minute, subscriptions and JetStream consumers per seat,
 * the delivery daemon's and the seat processes' own CPU and RSS, whole-box CPU and memory, and how
 * fresh each seat's roster is (the age of every peer's last heartbeat as each seat sees it). A broker
 * that cannot keep up shows first as heartbeats arriving late, so the roster age is the saturation
 * signal, read from the seats rather than inferred from CPU.
 *
 * `--space-size K` puts K seats in each space (default: all N in one). Presence is a per-space KV
 * that every seat in the space watches, so one heartbeat is delivered to every member: the cost of a
 * seat depends on the size of its space, and the two shapes are measured separately rather than
 * averaged. `--heartbeat-ms` overrides the endpoint's heartbeat; a run with a heartbeat far past the
 * window is the no-heartbeat control, and the difference between the two runs is the heartbeat cost.
 *
 * What a real seat has that this one does not: the turn-notice subscription a MANAGER-launched seat
 * arms (one core subscription, no traffic while idle), the connector's local consumer lock (a file,
 * not the broker), and the auth callout at connect (seats here present static scoped creds; the
 * callout's cost is per connect, measured by `implementations/auth/smoke/callout-load.smoke.ts`, and
 * the permissions it mints come from the same builder). The delivery daemon here is its Plane-3
 * binding composed from core exactly as `runDelivery` binds it (same endpoint options, lease, and
 * `startPlane3`), without the CLI runner and membership feed around it.
 *
 * `--watch-presence false` builds every seat without the presence watch (it still registers and
 * heartbeats), so the difference against a default run is what the per-seat watch costs;
 * `--watch-channels false` does the same for the channel-registry watch.
 *
 * `--ram` adds the RAM profile. The broker's live heap and goroutines are read from its pprof
 * endpoint after a forced GC at each step of the build-up (empty, message streams, KV buckets and
 * registries, provisioned durables, delivery daemons, seats), so each step's delta is that part's
 * memory; the final heap is also split by the functions that allocated it (consumers, streams,
 * connections) with its top allocation sites. The delivery daemon and seat processes report V8's
 * view of their memory and write a heap snapshot after the window, summarised by class. Every
 * process is also read as RSS, PSS and USS (`procMem`), because the RSS of many Node processes
 * double-counts the `node` binary they share.
 *
 * Seats run in CHILD PROCESSES (`--seat-procs`), never in this process, so the broker's CPU and the
 * seats' CPU stay separately readable from /proc. Credentials reach a child over IPC, never argv.
 *
 * Run (needs nats-server 2.15.1 on PATH or NATS_SERVER_BIN, and an fd limit above 2N):
 *   ulimit -n 65536; pnpm -C packages/core smoke:seat-idle-load --seats 500 --space-size 10 [--ram]
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getHeapSpaceStatistics, writeHeapSnapshot } from "node:v8";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  CotalEndpoint, LEASE_TTL_MS, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable,
  lastKvEntries, mintCreds, mintLifecycleUid, newIdentity, provisionAgent, serverConfig, setupSpaceStreams,
  type SpaceAuth,
} from "../src/index.js";
import { spaceMessageStreamConfigs, standaloneConnectOpts } from "../src/streams.js";
import { dialerFor } from "../src/endpoint.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, brokerHeap, heapSnapshotTop, procMem, teardownOnSignal, type BrokerHeap, type BrokerPart } from "@cotal-ai/smoke-kit";

// ---------------------------------------------------------------------------------------------
// shared shapes
// ---------------------------------------------------------------------------------------------

/** One provisioned seat. Carries its credential, so it travels over IPC only. */
interface SeatSpec { space: string; id: string; name: string; uid: string; creds: string }
/** One space's delivery daemon. Carries its credential, so it travels over IPC only. */
interface DaemonSpec { space: string; id: string; creds: string }
interface SeatJob { kind: "seats"; servers: string; seats: SeatSpec[]; heartbeatMs?: number; watchPresence: boolean; watchChannels: boolean; concurrency: number }
interface DaemonJob { kind: "daemons"; servers: string; daemons: DaemonSpec[] }
/** V8's view of a child's memory, in MB: the JS heap in use and what V8 holds for it, memory
 *  outside the heap (Buffers, ArrayBuffers), and compiled code. */
interface NodeMem { heapUsedMb: number; heapTotalMb: number; externalMb: number; arrayBuffersMb: number; codeMb: number }
type ChildCmd = { cmd: "sample" | "readcost" | "stop" } | { cmd: "snapshot"; path: string };
/** What a seat child reports when asked to sample. `ages` are the ages (ms) of every same-space
 *  peer's last heartbeat as each seat's roster holds it; `missing` counts peers a seat's roster
 *  should hold and does not. */
interface SeatSample { up: number; failed: number; errors: number; ages: number[]; missing: number; stale: number; cpuMs: number; rssMb: number; mem: NodeMem }
/** What one on-demand roster read costs, from one seat per space: its latency, and the records and
 *  bytes the broker sends for it (subject + value of every record, not counting framing). */
interface ReadCost { ms: number[]; msgs: number[]; bytes: number[] }

// Scrub any ambient COTAL_* before anything is handed to a child. Whatever runs this harness may
// itself be a managed agent session, and its COTAL_SERVERS / credential variables name a LIVE mesh.
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];

const CHANNEL = "general";
/** The role every seat holds. A role gives the seat the shared TASK queue durable it pumps, as a
 *  real seat's persona role does. */
const ROLE = "default";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Nearest-rank percentile over an unsorted sample array. 0 samples reports NaN, never a 0 that
 *  would read as a fast run. */
function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

const ipcSend = (m: unknown): Promise<void> => new Promise((r) => { process.send!(m, () => r()); });
const MB = 1048576;
const nodeMem = (): NodeMem => {
  const m = process.memoryUsage();
  const code = getHeapSpaceStatistics().filter((s) => s.space_name.startsWith("code")).reduce((a, s) => a + s.space_used_size, 0);
  return { heapUsedMb: m.heapUsed / MB, heapTotalMb: m.heapTotal / MB, externalMb: m.external / MB, arrayBuffersMb: m.arrayBuffers / MB, codeMb: code / MB };
};
/** Write a heap snapshot where the orchestrator asked, after a full GC when one is exposed. */
const snapshot = (path: string): string => { (globalThis as { gc?: () => void }).gc?.(); return writeHeapSnapshot(path); };
const nextJob = <T>(): Promise<T> => new Promise((r) => process.once("message", (m) => r(m as T)));

// ---------------------------------------------------------------------------------------------
// seat child: N real endpoints, configured as MeshAgent configures one
// ---------------------------------------------------------------------------------------------

async function runSeats(job: SeatJob): Promise<void> {
  const cpu0 = process.cpuUsage();
  const eps: Array<{ ep: CotalEndpoint; space: string }> = [];
  const bySpace = new Map<string, number>();
  for (const s of job.seats) bySpace.set(s.space, (bySpace.get(s.space) ?? 0) + 1);
  let up = 0, failed = 0, errors = 0;
  const firstErrors: string[] = [];
  const note = (e: Error) => { errors++; if (firstErrors.length < 5) firstErrors.push(e.message.slice(0, 200)); };
  const queue = [...job.seats];
  const startOne = async (s: SeatSpec) => {
    // MeshAgent's construction (extensions/connector-core/src/agent.ts), minus the bearer, TLS and
    // file-derived fields a static-creds seat leaves unset. `meta` carries what buildMeta stamps.
    const ep = new CotalEndpoint({
      space: s.space,
      servers: job.servers,
      creds: s.creds,
      lifecycleUid: s.uid,
      channels: [CHANNEL],
      card: { id: s.id, name: s.name, role: ROLE, kind: "agent", meta: { connector: "claude-code", model: "claude-opus-5-5", host: "seat-host", cwd: "/home/user/project" } },
      // MeshAgent reads the roster on demand instead of watching it (AGENT-979); the job's
      // default says so, and the RAM profile can switch the watches on to price them.
      watchPresence: job.watchPresence,
      watchChannels: job.watchChannels,
      ...(job.heartbeatMs !== undefined ? { heartbeatMs: job.heartbeatMs } : {}),
    });
    ep.on("error", note);
    ep.on("warning", note);
    try { await ep.start(); eps.push({ ep, space: s.space }); up++; }
    catch (e) { failed++; note(e as Error); }
    if ((up + failed) % 100 === 0) await ipcSend({ progress: up + failed });
  };
  await Promise.all(Array.from({ length: job.concurrency }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) await startOne(s);
  }));
  await ipcSend({ allUp: true, up, failed, firstErrors });

  // Seats hold no roster now, so freshness is what an on-demand read returns, read by ONE seat per
  // space (the first this process holds): every seat reading would add K² messages to the window.
  const readers = new Map<string, CotalEndpoint>();
  for (const { ep, space } of eps) if (!readers.has(space)) readers.set(space, ep);
  for (;;) {
    const cmd = await nextJob<ChildCmd>();
    if (cmd.cmd === "stop") break;
    if (cmd.cmd === "snapshot") { await ipcSend({ snapshot: snapshot(cmd.path) }); continue; }
    if (cmd.cmd === "readcost") {
      const cost: ReadCost = { ms: [], msgs: [], bytes: [] };
      for (const ep of [...readers.values()].slice(0, 20)) {
        for (let i = 0; i < 5; i++) {
          const t = performance.now();
          await ep.readPresence();
          cost.ms.push(performance.now() - t);
        }
        const entries = await lastKvEntries((ep as unknown as { kv: Parameters<typeof lastKvEntries>[0] }).kv);
        cost.msgs.push(entries.length);
        cost.bytes.push(entries.reduce((a, e) => a + e.value.length + `$KV.${e.bucket}.${e.key}`.length, 0));
      }
      await ipcSend({ readcost: cost });
      continue;
    }
    const now = Date.now();
    const ages: number[] = [];
    let missing = 0, stale = 0;
    for (const [space, ep] of readers) {
      let roster;
      try { roster = await ep.readPresence(); } catch (e) { stale++; note(e as Error); continue; }
      const peers = roster.filter((p) => p.card.kind === "agent" && p.card.id !== ep.card.id && p.status !== "offline");
      for (const p of peers) ages.push(now - p.ts);
      missing += Math.max(0, (bySpace.get(space) ?? 1) - 1 - peers.length);
    }
    const cpu = process.cpuUsage(cpu0);
    // Every seat's view, but never more ages than one IPC message should carry.
    const step = Math.max(1, Math.ceil(ages.length / 200_000));
    await ipcSend({ sample: { up, failed, errors, ages: ages.filter((_, i) => i % step === 0), missing, stale, cpuMs: (cpu.user + cpu.system) / 1000, rssMb: process.memoryUsage().rss / MB, mem: nodeMem() } satisfies SeatSample });
  }
  await Promise.all(eps.map(({ ep }) => ep.stop().catch(() => {})));
  await ipcSend({ stopped: true });
}

// ---------------------------------------------------------------------------------------------
// delivery child: every space's Plane-3, bound as runDelivery binds it
// ---------------------------------------------------------------------------------------------

async function runDaemons(job: DaemonJob): Promise<void> {
  const eps: CotalEndpoint[] = [];
  const renewals: ReturnType<typeof setInterval>[] = [];
  for (const d of job.daemons) {
    // implementations/delivery/src/delivery.ts: the same endpoint options the daemon runs with.
    const ep = new CotalEndpoint({
      space: d.space, servers: job.servers, creds: d.creds,
      channels: [], consume: false, watchPresence: true, registerPresence: false,
      card: { id: d.id, name: "delivery", role: "delivery", kind: "endpoint" },
      transportPingIntervalMs: 2500, transportMaxPingOut: 2,
    });
    ep.on("error", () => {});
    await ep.start();
    const leased = await ep.acquireDeliveryLease(0);
    await ep.startPlane3((owner, lifecycleUid) => ep.aclForOwner(owner, lifecycleUid));
    let revision: number | undefined = await ep.markDeliveryLeaseReady(0, leased);
    // Renewed at half the TTL, as the shipped daemon renews it; a lost renew stops renewing.
    renewals.push(setInterval(() => {
      if (revision === undefined) return;
      ep.renewDeliveryLease(0, revision).then((next) => { revision = next; }, () => { revision = undefined; });
    }, Math.floor(LEASE_TTL_MS / 2)));
    eps.push(ep);
  }
  await ipcSend({ ready: true });
  for (;;) {
    const cmd = await nextJob<ChildCmd>();
    if (cmd.cmd === "stop") break;
    if (cmd.cmd === "snapshot") await ipcSend({ snapshot: snapshot(cmd.path) });
    else await ipcSend({ sample: { mem: nodeMem() } });
  }
  for (const r of renewals) clearInterval(r);
  await Promise.all(eps.map((ep) => ep.stop().catch(() => {})));
  await ipcSend({ stopped: true });
}

if (process.argv[2] === "child") {
  const job = await nextJob<SeatJob | DaemonJob>();
  if (job.kind === "seats") await runSeats(job);
  else await runDaemons(job);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string): string => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) return argv[i + 1];
  if (dflt === undefined) throw new Error(`seat-idle-load: --${name} is required`);
  return dflt;
};
const num = (name: string, dflt?: string): number => {
  const v = Number(flag(name, dflt));
  if (!Number.isFinite(v)) throw new Error(`seat-idle-load: --${name} must be a number`);
  return v;
};

const SEATS = num("seats", "100");
const SPACE_SIZE = Math.max(1, Math.min(SEATS, num("space-size", String(SEATS))));
const SPACES = Math.ceil(SEATS / SPACE_SIZE);
/** Seat processes. Default one per 500 seats, at most one per core. */
const SEAT_PROCS = Math.max(1, Math.min(availableParallelism() * 2, num("seat-procs", String(Math.min(availableParallelism(), Math.ceil(SEATS / 500))))));
/** Seat starts in flight per seat process. */
const CONCURRENCY = num("concurrency", "8");
const SETTLE_S = num("settle", "20");
const SECONDS = num("seconds", "60");
const HEARTBEAT = flag("heartbeat-ms", ""); // empty: the endpoint's own default
const WATCH_PRESENCE = flag("watch-presence", "true") !== "false";
const WATCH_CHANNELS = flag("watch-channels", "true") !== "false";
const RAM = argv.includes("--ram");
const NATS_BIN = process.env.NATS_SERVER_BIN ?? "nats-server";

const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd: import.meta.dirname }).trim();
const SHA = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: REPO }).trim();
const EXPECT_SERVER = "2.15.1";
const serverVersion = (() => {
  const v = execFileSync(NATS_BIN, ["--version"], { encoding: "utf8" }).trim();
  return (/\d+\.\d+\.\d+/.exec(v) ?? ["unknown"])[0];
})();
if (serverVersion !== EXPECT_SERVER)
  throw new Error(`seat-idle-load: this harness measures nats-server ${EXPECT_SERVER}; ${NATS_BIN} is ${serverVersion}. Set NATS_SERVER_BIN.`);

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
/** Whole-box busy and total jiffies, so "the box saturated" is read off the box. */
const boxCpu = (): { busy: number; total: number } => {
  const f = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = f[3] + f[4]; // idle + iowait
  const total = f.reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
};
const memAvailableMb = (): number => Number(/MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"))![1]) / 1024;

// ---- broker -------------------------------------------------------------------------------------
const PORT = await pickFreePort();
const MON_PORT = await pickFreePort();
const PROF_PORT = RAM ? await pickFreePort() : 0;
const SERVERS = `nats://127.0.0.1:${PORT}`;
const tag = randomUUID().slice(0, 6);
const brokerAuth = await createBrokerAuth(`seat-idle-load-${tag}`);
const spaceNames = Array.from({ length: SPACES }, (_, i) => `idle-${tag}-${i}`);
const accounts = await Promise.all(spaceNames.map((s) => createSpaceAccountAuth(brokerAuth, s)));
const auths: SpaceAuth[] = accounts.map((a) => composeSpaceAuth(brokerAuth, a));
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(brokerAuth, accounts, { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }) + `\nhttp: 127.0.0.1:${MON_PORT}\n` + (RAM ? `prof_port: ${PROF_PORT}\n` : ""));
const srv = spawn(NATS_BIN, ["-c", join(dir, "server.conf")], { stdio: ["ignore", "ignore", "pipe"] });
const releaseBroker = teardownOnSignal(srv, dir);
// The broker's warnings and errors are part of the result (an fd limit, a slow consumer, a refused
// JetStream asset); its info lines are not.
let brokerPartial = "";
const brokerWarnings: string[] = [];
srv.stderr!.setEncoding("utf8");
srv.stderr!.on("data", (d: string) => {
  const lines = (brokerPartial + d).split("\n");
  brokerPartial = lines.pop() ?? "";
  for (const l of lines) if (/\[(WRN|ERR|FTL)\]/.test(l)) { if (brokerWarnings.length < 2000) brokerWarnings.push(l); if (brokerWarnings.length <= 5) console.error(`  broker: ${l}`); }
});

const monitor = async <T = Record<string, number>>(path: string): Promise<T> => (await (await fetch(`http://127.0.0.1:${MON_PORT}${path}`)).json()) as T;
interface Jsz { streams: number; consumers: number; messages: number; bytes: number; memory: number; storage: number; api: { total: number; errors: number } }

const children: ChildProcess[] = [];
/** Rejects the moment any child dies before it was told to stop, so a dead daemon or seat process
 *  fails the run instead of leaving it waiting on a report that will never come. */
let stopping = false;
let abort!: (e: Error) => void;
const aborted = new Promise<never>((_, reject) => { abort = reject; });
aborted.catch(() => {});
const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, aborted]);
/** Start a child and hand it its job over IPC. `onMessage` sees every message it sends. */
const startChild = (job: SeatJob | DaemonJob, onMessage: (m: Record<string, unknown>) => void): ChildProcess => {
  const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, "child"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...cleanEnv, DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off" },
  });
  children.push(child);
  child.on("exit", (code, signal) => { if (!stopping) abort(new Error(`${job.kind} child ${child.pid} exited (${code ?? signal}) mid-run`)); });
  child.on("message", (m) => onMessage(m as Record<string, unknown>));
  child.send(job);
  return child;
};
const ask = (child: ChildProcess, cmd: ChildCmd, key: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const on = (m: Record<string, unknown>) => { if (key in m) { child.off("message", on); resolve(m); } };
  child.on("message", on);
  child.once("exit", (c) => reject(new Error(`child ${child.pid} exited ${c} before answering ${key}`)));
  child.send(cmd);
});

const rows: Array<[string, string]> = [];
const row = (k: string, v: string | number) => rows.push([k, typeof v === "number" ? (Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)) : v]);
const n2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
/** A spread of a few hundred thousand samples overflows the call stack. */
const maxOf = (xs: number[]) => xs.reduce((a, b) => (b > a ? b : a), -Infinity);

try {
  let up = false;
  for (let i = 0; i < 100; i++) { if (srv.exitCode !== null) break; if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server ${serverVersion} did not come up on ${PORT}`);

  // The empty broker, so every per-seat figure can also be stated all-in: a seat's share of its
  // space's streams, buckets and daemon, not only its own connection.
  await wait(500);
  const boot = { rss: procRssMb(srv.pid!), jsz: await monitor<Jsz>("/jsz") };
  /** The broker at each step of the build-up, read only under --ram. */
  const steps: Array<{ step: string; rssMb: number; heap: BrokerHeap; jsz: Jsz; varz: Record<string, number> }> = [];
  const step = async (name: string) => {
    if (!RAM) return;
    const heap = await brokerHeap(`http://127.0.0.1:${PROF_PORT}`);
    steps.push({ step: name, rssMb: procMem(srv.pid!).rssMb, heap, jsz: await monitor<Jsz>("/jsz"), varz: await monitor("/varz") });
  };
  await step("empty broker");

  // ---- per space: streams, provisioner, seats' footprints, delivery creds ----------------------
  // In three passes over the spaces, so the broker can be read between them: the message streams,
  // then the rest of the space's assets (KV buckets, registries, the object store), then the seats'
  // durables and ACL rows. `setupSpaceStreams` re-adds the message streams idempotently.
  const tSetup = performance.now();
  const seats: SeatSpec[] = [];
  const daemons: DaemonSpec[] = [];
  const provCredsOf: string[] = [];
  for (let s = 0; s < SPACES; s++) {
    provCredsOf.push(await mintCreds(auths[s], newIdentity(), "provisioner"));
    // Dialled as `setupSpaceStreams` dials, so the provisioner's scoped inbox prefix applies.
    const nc = await dialerFor(SERVERS)({ servers: SERVERS, ...standaloneConnectOpts({ creds: provCredsOf[s], tls: false }) });
    const jsm = await jetstreamManager(nc);
    for (const definition of spaceMessageStreamConfigs(spaceNames[s])) await jsm.streams.add(definition);
    await nc.drain();
  }
  await step("+ message streams");
  for (let s = 0; s < SPACES; s++) await setupSpaceStreams({ servers: SERVERS, space: spaceNames[s], creds: provCredsOf[s] });
  await step("+ KV buckets, registries, object store");
  for (let s = 0; s < SPACES; s++) {
    const space = spaceNames[s], auth = auths[s];
    const provCreds = provCredsOf[s];
    const prov = new CotalEndpoint({ space, servers: SERVERS, creds: provCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, watchChannels: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
    prov.on("error", () => {});
    await prov.start();
    const here = Math.min(SPACE_SIZE, SEATS - s * SPACE_SIZE);
    for (let i = 0; i < here; i++) {
      const identity = newIdentity();
      const uid = mintLifecycleUid();
      const creds = await provisionAgent(prov, auth, identity, { subscribe: [CHANNEL], allowSubscribe: [CHANNEL], allowPublish: [CHANNEL], role: ROLE, lifecycleUid: uid });
      seats.push({ space, id: identity.id, name: `seat-${s}-${i}`, uid, creds });
    }
    await prov.stop();
    const daemonId = newIdentity();
    daemons.push({ space, id: daemonId.id, creds: await mintCreds(auth, daemonId, "delivery") });
    if ((s + 1) % Math.max(1, Math.floor(SPACES / 10)) === 0) console.error(`  … ${s + 1}/${SPACES} spaces provisioned (${((performance.now() - tSetup) / 1000).toFixed(0)}s)`);
  }
  const setupS = (performance.now() - tSetup) / 1000;
  await step("+ seat durables and ACL rows");

  // ---- delivery daemons -------------------------------------------------------------------------
  let daemonReady!: () => void;
  const daemonUp = new Promise<void>((r) => { daemonReady = r; });
  const daemon = startChild({ kind: "daemons", servers: SERVERS, daemons }, (m) => { if (m.ready) daemonReady(); });
  await guard(daemonUp);
  console.error(`  … ${SPACES} delivery daemon(s) ready`);
  await wait(2000);
  const base = { rss: procRssMb(srv.pid!), varz: await monitor("/varz"), jsz: await monitor<Jsz>("/jsz") };
  await step("+ delivery daemons");

  // ---- seats ------------------------------------------------------------------------------------
  const perProc = Math.ceil(seats.length / SEAT_PROCS);
  const seatKids: ChildProcess[] = [];
  const allUp: Array<Promise<Record<string, unknown>>> = [];
  const brokerRamp0 = procCpuMs(srv.pid!);
  const tRamp = performance.now();
  const started = new Map<number, number>();
  for (let p = 0; p < SEAT_PROCS; p++) {
    const mine = seats.slice(p * perProc, (p + 1) * perProc);
    if (!mine.length) continue;
    let done!: (m: Record<string, unknown>) => void;
    allUp.push(new Promise((r) => { done = r; }));
    seatKids.push(startChild({ kind: "seats", servers: SERVERS, seats: mine, watchPresence: WATCH_PRESENCE, watchChannels: WATCH_CHANNELS, concurrency: CONCURRENCY, ...(HEARTBEAT ? { heartbeatMs: Number(HEARTBEAT) } : {}) }, (m) => {
      if (typeof m.progress === "number") {
        started.set(p, m.progress);
        console.error(`  … ${[...started.values()].reduce((a, b) => a + b, 0)}/${seats.length} seats started (${((performance.now() - tRamp) / 1000).toFixed(0)}s)`);
      }
      if (m.allUp) done(m);
    }));
  }
  const upReports = await guard(Promise.all(allUp));
  const rampS = (performance.now() - tRamp) / 1000;
  const brokerRampMs = procCpuMs(srv.pid!) - brokerRamp0;
  const seatsUp = upReports.reduce((a, m) => a + (m.up as number), 0);
  const seatsFailed = upReports.reduce((a, m) => a + (m.failed as number), 0);
  const startErrors = upReports.flatMap((m) => m.firstErrors as string[]).slice(0, 5);

  // ---- settle, then the measured idle window ------------------------------------------------------
  await wait(SETTLE_S * 1000);
  await step("+ seats (settled)");
  const v0 = await monitor("/varz"), j0 = await monitor<Jsz>("/jsz");
  const b0 = procCpuMs(srv.pid!), d0 = procCpuMs(daemon.pid!), s0 = seatKids.map((c) => procCpuMs(c.pid!));
  const box0 = boxCpu();
  const t0 = performance.now();
  // Sample the rosters mid-window too, so a run that is degrading shows it, not just its end.
  await wait((SECONDS * 1000) / 2);
  const mid = (await guard(Promise.all(seatKids.map((c) => ask(c, { cmd: "sample" }, "sample"))))).map((m) => m.sample as SeatSample);
  await wait((SECONDS * 1000) / 2);
  const winS = (performance.now() - t0) / 1000;
  const brokerCpuMs = procCpuMs(srv.pid!) - b0, daemonCpuMs = procCpuMs(daemon.pid!) - d0;
  const seatCpuMs = seatKids.reduce((a, c, i) => a + procCpuMs(c.pid!) - s0[i], 0);
  const box1 = boxCpu();
  const v1 = await monitor("/varz"), j1 = await monitor<Jsz>("/jsz");
  const end = (await guard(Promise.all(seatKids.map((c) => ask(c, { cmd: "sample" }, "sample"))))).map((m) => m.sample as SeatSample);
  // After every counter above was read, so the reads cost nothing in the measured window.
  const reads = (await guard(Promise.all(seatKids.map((c) => ask(c, { cmd: "readcost" }, "readcost"))))).map((m) => m.readcost as ReadCost);
  const brokerRss = procRssMb(srv.pid!), daemonRss = procRssMb(daemon.pid!);
  const seatRss = seatKids.reduce((a, c) => a + procRssMb(c.pid!), 0);
  const memAvail = memAvailableMb();
  const memAt = RAM ? { broker: procMem(srv.pid!), daemon: procMem(daemon.pid!), seats: seatKids.map((c) => procMem(c.pid!)) } : undefined;

  const N = seatsUp || 1;
  const perMin = (x: number) => (x / winS) * 60 / N;
  const agesEnd = end.flatMap((s) => s.ages), agesMid = mid.flatMap((s) => s.ages);
  const perSpace = new Map<string, number>();
  for (const s of seats) perSpace.set(s.space, (perSpace.get(s.space) ?? 0) + 1);
  // One reader per space now, so a space contributes its K - 1 peers once, not K(K - 1).
  const expectedPeers = [...perSpace.values()].reduce((a, n) => a + (n - 1), 0);
  const missingEnd = end.reduce((a, s) => a + s.missing, 0), staleEnd = end.reduce((a, s) => a + s.stale, 0);

  row("git sha", SHA);
  row("nats-server", `${serverVersion} (${NATS_BIN})`);
  row("host", `${availableParallelism()} cores, ${(totalmem() / 1073741824).toFixed(1)} GB`);
  row("shape", `${SEATS} seats in ${SPACES} space(s) of ${SPACE_SIZE}, ${seatKids.length} seat process(es), heartbeat ${HEARTBEAT ? `${HEARTBEAT}ms (override)` : "endpoint default"}, presence watch ${WATCH_PRESENCE ? "on" : "OFF"}, channel registry watch ${WATCH_CHANNELS ? "on" : "OFF"}`);
  row("setup (spaces + provisioning) (s)", setupS);
  row("seats up / failed", `${seatsUp} / ${seatsFailed}`);
  for (const e of startErrors) row("  start error", e);
  row("ramp (s)", rampS);
  row("ramp rate (seats/s)", seatsUp / rampS);
  row("broker CPU per seat start (ms)", brokerRampMs / N);
  row("idle window (s)", `${winS.toFixed(1)} after ${SETTLE_S}s settle`);
  rows.push(["", ""]);
  row("broker CPU (cores)", brokerCpuMs / 1000 / winS);
  row("broker CPU per seat (millicores)", (brokerCpuMs / winS) / N);
  row("broker RSS (MB)", brokerRss);
  row("broker RSS empty / provisioned, before seats (MB)", `${n2(boot.rss)} / ${n2(base.rss)}`);
  row("broker RSS per seat, connection only (MB)", (brokerRss - base.rss) / N);
  row("broker RSS per seat, all-in (MB)", (brokerRss - boot.rss) / N);
  row("seats per broker core (at this load)", N / (brokerCpuMs / 1000 / winS));
  row("seats per broker GB (all-in)", N / ((brokerRss - boot.rss) / 1024));
  row("broker connections", v1.connections ?? 0);
  row("broker subscriptions per seat", ((v1.subscriptions ?? 0) - (base.varz.subscriptions ?? 0)) / N);
  row("JetStream consumers per seat, provisioned / at connect", `${n2((base.jsz.consumers - boot.jsz.consumers) / N)} / ${n2((j1.consumers - base.jsz.consumers) / N)}`);
  row("JetStream streams", j1.streams);
  row("JetStream storage (MB)", j1.storage / 1048576);
  row("JetStream memory (MB)", j1.memory / 1048576);
  row("broker msgs in per seat per min", perMin((v1.in_msgs ?? 0) - (v0.in_msgs ?? 0)));
  row("broker msgs out per seat per min", perMin((v1.out_msgs ?? 0) - (v0.out_msgs ?? 0)));
  row("broker bytes in per seat per min", perMin((v1.in_bytes ?? 0) - (v0.in_bytes ?? 0)));
  row("broker bytes out per seat per min", perMin((v1.out_bytes ?? 0) - (v0.out_bytes ?? 0)));
  row("JetStream API calls per seat per min", perMin(j1.api.total - j0.api.total));
  row("JetStream API errors in window", j1.api.errors - j0.api.errors);
  row("broker slow_consumers", v1.slow_consumers ?? 0);
  row("broker warnings/errors logged", brokerWarnings.length);
  rows.push(["", ""]);
  row("delivery daemon CPU (cores)", daemonCpuMs / 1000 / winS);
  row("delivery daemon RSS (MB)", daemonRss);
  row("seat processes CPU (cores)", seatCpuMs / 1000 / winS);
  row("seat CPU per seat (millicores)", (seatCpuMs / winS) / N);
  row("seat processes RSS (MB)", seatRss);
  row("seat RSS per seat (MB)", seatRss / N);
  row("box CPU busy (cores of " + availableParallelism() + ")", ((box1.busy - box0.busy) / (box1.total - box0.total)) * availableParallelism());
  row("box MemAvailable (MB)", memAvail);
  rows.push(["", ""]);
  row("peer heartbeat age mid-window p50 / p99 / max (ms)", `${n2(pct(agesMid, 50))} / ${n2(pct(agesMid, 99))} / ${n2(maxOf(agesMid))}`);
  row("peer heartbeat age at end p50 / p99 / max (ms)", `${n2(pct(agesEnd, 50))} / ${n2(pct(agesEnd, 99))} / ${n2(maxOf(agesEnd))}`);
  row("roster entries missing at end", `${missingEnd} of ${expectedPeers}`);
  row("roster reads that failed (one reader per space)", staleEnd);
  const readMs = reads.flatMap((r) => r.ms), readMsgs = reads.flatMap((r) => r.msgs), readBytes = reads.flatMap((r) => r.bytes);
  row("one roster read: records sent (median)", pct(readMsgs, 50));
  row("one roster read: subject+value bytes sent (median)", pct(readBytes, 50));
  row("one roster read: latency p50 / p99 (ms)", `${n2(pct(readMs, 50))} / ${n2(pct(readMs, 99))} (${readMs.length} reads)`);
  row("endpoint errors and warnings (all seats)", end.reduce((a, s) => a + s.errors, 0));

  const w = Math.max(...rows.map(([k]) => k.length));
  console.log(`\n${"=".repeat(w + 34)}`);
  for (const [k, v] of rows) console.log(k === "" ? "" : `${k.padEnd(w)}  ${v}`);
  console.log(`${"=".repeat(w + 34)}\n`);

  if (RAM && memAt) {
    // ---- RAM profile ----------------------------------------------------------------------------
    const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "n/a");
    const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "n/a");
    console.log(`RAM profile: ${SEATS} seats in ${SPACES} space(s) of ${SPACE_SIZE}, presence watch ${WATCH_PRESENCE ? "on" : "OFF"}, channel registry watch ${WATCH_CHANNELS ? "on" : "OFF"}\n`);
    console.log("Broker, step by step (live heap after a forced GC; each delta is that step's memory):\n");
    console.log("| step | RSS MB | live heap MB | Δ live heap MB | goroutine stacks MB | goroutines | streams | consumers | connections | subscriptions |");
    console.log("|---|---|---|---|---|---|---|---|---|---|");
    steps.forEach((st, i) => {
      const prev = steps[i - 1];
      console.log(`| ${st.step} | ${f1(st.rssMb)} | ${f1(st.heap.heapAllocMb)} | ${prev ? f1(st.heap.heapAllocMb - prev.heap.heapAllocMb) : ""} | ${f1(st.heap.stackInuseMb)} | ${st.heap.goroutines} | ${st.jsz.streams} | ${st.jsz.consumers} | ${st.varz.connections ?? 0} | ${st.varz.subscriptions ?? 0} |`);
    });
    const last = steps[steps.length - 1], before = steps.find((st) => st.step === "+ delivery daemons") ?? steps[0];
    const parts = Object.keys(last.heap.heapByPart) as BrokerPart[];
    console.log("\nBroker live heap and goroutines by part, at the end and per seat (the part comes from the functions on each allocation's stack):\n");
    console.log("| part | live heap MB | per seat KB (all-in) | seats' share per seat KB | goroutines |");
    console.log("|---|---|---|---|---|");
    for (const p of parts)
      console.log(`| ${p} | ${f1(last.heap.heapByPart[p])} | ${f1((last.heap.heapByPart[p] / N) * 1024)} | ${f1(((last.heap.heapByPart[p] - before.heap.heapByPart[p]) / N) * 1024)} | ${last.heap.goroutinesByPart[p]} |`);
    const headroom = last.rssMb - last.heap.heapInuseMb - last.heap.stackInuseMb;
    console.log(`| goroutine stacks | ${f1(last.heap.stackInuseMb)} | ${f1((last.heap.stackInuseMb / N) * 1024)} | ${f1(((last.heap.stackInuseMb - before.heap.stackInuseMb) / N) * 1024)} | ${last.heap.goroutines} |`);
    console.log(`| heap spans not live (GC headroom, fragmentation) | ${f1(last.heap.heapInuseMb - last.heap.heapAllocMb)} | | | |`);
    console.log(`| RSS beyond heap and stacks (runtime, freed-not-returned pages, binary) | ${f1(headroom)} | | | |`);
    console.log("\nTop broker allocation sites (live heap at the end):\n");
    for (const t of last.heap.topSites) console.log(`- ${t.site} (${t.part}): ${f1(t.mb)} MB, ${f1((t.mb / N) * 1024)} KB per seat`);

    // JetStream assets by kind, and every connection's queued outbound bytes.
    interface StreamDetail { name: string; state: { messages: number; bytes: number; num_subjects?: number; consumer_count: number }; consumer_detail?: Array<{ config?: { durable_name?: string } }> }
    const jd = await monitor<{ account_details?: Array<{ stream_detail?: StreamDetail[] }> }>("/jsz?accounts=true&streams=true&consumers=true&config=true");
    const kinds = new Map<string, { streams: number; durable: number; ephemeral: number; msgs: number; bytes: number; subjects: number }>();
    for (const a of jd.account_details ?? []) for (const sd of a.stream_detail ?? []) {
      const kind = sd.name.startsWith("KV_") ? "KV bucket" : sd.name.startsWith("OBJ_") ? "object store" : sd.name.replace(/_.*/, "");
      const k = kinds.get(kind) ?? { streams: 0, durable: 0, ephemeral: 0, msgs: 0, bytes: 0, subjects: 0 };
      k.streams++; k.msgs += sd.state.messages; k.bytes += sd.state.bytes; k.subjects += sd.state.num_subjects ?? 0;
      for (const c of sd.consumer_detail ?? []) { if (c.config?.durable_name) k.durable++; else k.ephemeral++; }
      kinds.set(kind, k);
    }
    console.log("\nJetStream assets by kind (all spaces):\n");
    console.log("| kind | streams | durable consumers | ephemeral consumers | messages | MB stored | subjects |");
    console.log("|---|---|---|---|---|---|---|");
    for (const [kind, k] of [...kinds].sort((a, b) => b[1].durable + b[1].ephemeral - (a[1].durable + a[1].ephemeral)))
      console.log(`| ${kind} | ${k.streams} | ${k.durable} | ${k.ephemeral} | ${k.msgs} | ${f3(k.bytes / MB)} | ${k.subjects} |`);
    const cz = await monitor<{ connections?: Array<{ pending_bytes?: number; subscriptions?: number }> }>("/connz?limit=100000");
    const conns = cz.connections ?? [];
    console.log(`\nconnections ${conns.length}, outbound bytes queued ${conns.reduce((a, c) => a + (c.pending_bytes ?? 0), 0)}, subscriptions per connection ${f1(conns.reduce((a, c) => a + (c.subscriptions ?? 0), 0) / Math.max(1, conns.length))}`);

    // Node processes: from outside (RSS, PSS, USS) and from V8, then a heap snapshot of each kind.
    const daemonMem = ((await guard(ask(daemon, { cmd: "sample" }, "sample"))).sample as { mem: NodeMem }).mem;
    const seatUss = memAt.seats.reduce((a, m) => a + m.ussMb, 0), seatPss = memAt.seats.reduce((a, m) => a + m.pssMb, 0);
    const seatHeap = end.reduce((a, x) => a + x.mem.heapUsedMb, 0), seatExt = end.reduce((a, x) => a + x.mem.externalMb, 0);
    console.log("\nProcesses at the end of the window:\n");
    console.log("| process | RSS MB | PSS MB | USS MB | JS heap used MB | external MB | per seat USS KB |");
    console.log("|---|---|---|---|---|---|---|");
    console.log(`| broker | ${f1(memAt.broker.rssMb)} | ${f1(memAt.broker.pssMb)} | ${f1(memAt.broker.ussMb)} | | | ${f1((memAt.broker.ussMb / N) * 1024)} |`);
    console.log(`| delivery daemon (${SPACES} space(s)) | ${f1(memAt.daemon.rssMb)} | ${f1(memAt.daemon.pssMb)} | ${f1(memAt.daemon.ussMb)} | ${f1(daemonMem.heapUsedMb)} | ${f1(daemonMem.externalMb)} | ${f1((memAt.daemon.ussMb / N) * 1024)} |`);
    console.log(`| seat processes (${seatKids.length}) | ${f1(memAt.seats.reduce((a, m) => a + m.rssMb, 0))} | ${f1(seatPss)} | ${f1(seatUss)} | ${f1(seatHeap)} | ${f1(seatExt)} | ${f1((seatUss / N) * 1024)} |`);
    const snaps: Array<[string, ChildProcess]> = [["delivery daemon", daemon], [`seat process 1 (${Math.min(perProc, seats.length)} seats)`, seatKids[0]]];
    for (const [label, child] of snaps) {
      const file = ((await guard(ask(child, { cmd: "snapshot", path: join(dir, `${child.pid}.heapsnapshot`) }, "snapshot"))).snapshot as string);
      const top = heapSnapshotTop(file, 3);
      rmSync(file, { force: true });
      console.log(`\n${label} heap snapshot: ${f1(top.totalBytes / MB)} MB of objects; top classes by self size:`);
      for (const t of top.top) console.log(`- ${t.name}: ${f1(t.bytes / MB)} MB in ${t.count} objects`);
      console.log(`- script source ${f1(top.sources.bytes / MB)} MB in ${top.sources.scripts} scripts; largest by package: ${top.sources.byPackage.map((t) => `${t.name} ${f1(t.bytes / MB)} MB`).join(", ")}`);
    }
    console.log("");
  }

  stopping = true;
  await Promise.all([...seatKids, daemon].map((c) => ask(c, { cmd: "stop" }, "stopped").catch(() => undefined)));
} catch (e) {
  console.error("  ✗ seat-idle-load threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  stopping = true;
  for (const c of children) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
  await new Promise<void>((r) => { process.stdout.write("", () => r()); });
  process.exit(process.exitCode ?? 0);
}
