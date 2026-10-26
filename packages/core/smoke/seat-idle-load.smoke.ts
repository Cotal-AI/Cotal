/**
 * Idle-seat LOAD harness — what one connected, idle seat costs the broker. Capacity, not correctness.
 *
 * Boots a private operator-mode nats-server serving S spaces, one data account each under one
 * broker operator (the hosted shape), provisions every seat through core's own onboarding step
 * (`provisionAgent`: the DM, DLV and role TASK durables, the read-ACL row and a scoped credential,
 * the step the manager runs at spawn), binds the delivery daemon's Plane-3 for every space, and then
 * brings up N seats as real `CotalEndpoint`s configured the way connector-core's `MeshAgent`
 * configures them: one boot channel, consume on, presence registered AND watched, channel registry
 * watched, the endpoint's own default heartbeat and TTL. Nothing on the wire is hand-rolled, so the
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
 * Seats run in CHILD PROCESSES (`--seat-procs`), never in this process, so the broker's CPU and the
 * seats' CPU stay separately readable from /proc. Credentials reach a child over IPC, never argv.
 *
 * Run (needs nats-server 2.15.1 on PATH or NATS_SERVER_BIN, and an fd limit above 2N):
 *   ulimit -n 65536; pnpm -C packages/core smoke:seat-idle-load --seats 500 --space-size 10
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CotalEndpoint, LEASE_TTL_MS, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, isReachable,
  mintCreds, mintLifecycleUid, newIdentity, provisionAgent, serverConfig, setupSpaceStreams,
  type SpaceAuth,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

// ---------------------------------------------------------------------------------------------
// shared shapes
// ---------------------------------------------------------------------------------------------

/** One provisioned seat. Carries its credential, so it travels over IPC only. */
interface SeatSpec { space: string; id: string; name: string; uid: string; creds: string }
/** One space's delivery daemon. Carries its credential, so it travels over IPC only. */
interface DaemonSpec { space: string; id: string; creds: string }
interface SeatJob { kind: "seats"; servers: string; seats: SeatSpec[]; heartbeatMs?: number; concurrency: number }
interface DaemonJob { kind: "daemons"; servers: string; daemons: DaemonSpec[] }
/** What a seat child reports when asked to sample. `ages` are the ages (ms) of every same-space
 *  peer's last heartbeat as each seat's roster holds it; `missing` counts peers a seat's roster
 *  should hold and does not. */
interface SeatSample { up: number; failed: number; errors: number; ages: number[]; missing: number; stale: number; cpuMs: number; rssMb: number }

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

  for (;;) {
    const cmd = await nextJob<{ cmd: "sample" | "stop" }>();
    if (cmd.cmd === "stop") break;
    const now = Date.now();
    const ages: number[] = [];
    let missing = 0, stale = 0;
    for (const { ep, space } of eps) {
      if (!ep.presenceView().fresh) stale++;
      const peers = ep.getRoster().filter((p) => p.card.kind === "agent" && p.card.id !== ep.card.id && p.status !== "offline");
      for (const p of peers) ages.push(now - p.ts);
      missing += Math.max(0, (bySpace.get(space) ?? 1) - 1 - peers.length);
    }
    const cpu = process.cpuUsage(cpu0);
    // Every seat's view, but never more ages than one IPC message should carry.
    const step = Math.max(1, Math.ceil(ages.length / 200_000));
    await ipcSend({ sample: { up, failed, errors, ages: ages.filter((_, i) => i % step === 0), missing, stale, cpuMs: (cpu.user + cpu.system) / 1000, rssMb: process.memoryUsage().rss / 1048576 } satisfies SeatSample });
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
  await nextJob<{ cmd: "stop" }>();
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
const SERVERS = `nats://127.0.0.1:${PORT}`;
const tag = randomUUID().slice(0, 6);
const brokerAuth = await createBrokerAuth(`seat-idle-load-${tag}`);
const spaceNames = Array.from({ length: SPACES }, (_, i) => `idle-${tag}-${i}`);
const accounts = await Promise.all(spaceNames.map((s) => createSpaceAccountAuth(brokerAuth, s)));
const auths: SpaceAuth[] = accounts.map((a) => composeSpaceAuth(brokerAuth, a));
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(brokerAuth, accounts, { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }) + `\nhttp: 127.0.0.1:${MON_PORT}\n`);
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
const ask = (child: ChildProcess, cmd: { cmd: "sample" | "stop" }, key: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
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

  // ---- per space: streams, provisioner, seats' footprints, delivery creds ----------------------
  const tSetup = performance.now();
  const seats: SeatSpec[] = [];
  const daemons: DaemonSpec[] = [];
  for (let s = 0; s < SPACES; s++) {
    const space = spaceNames[s], auth = auths[s];
    const provCreds = await mintCreds(auth, newIdentity(), "provisioner");
    await setupSpaceStreams({ servers: SERVERS, space, creds: provCreds });
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

  // ---- delivery daemons -------------------------------------------------------------------------
  let daemonReady!: () => void;
  const daemonUp = new Promise<void>((r) => { daemonReady = r; });
  const daemon = startChild({ kind: "daemons", servers: SERVERS, daemons }, (m) => { if (m.ready) daemonReady(); });
  await guard(daemonUp);
  console.error(`  … ${SPACES} delivery daemon(s) ready`);
  await wait(2000);
  const base = { rss: procRssMb(srv.pid!), varz: await monitor("/varz"), jsz: await monitor<Jsz>("/jsz") };

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
    seatKids.push(startChild({ kind: "seats", servers: SERVERS, seats: mine, concurrency: CONCURRENCY, ...(HEARTBEAT ? { heartbeatMs: Number(HEARTBEAT) } : {}) }, (m) => {
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
  const brokerRss = procRssMb(srv.pid!), daemonRss = procRssMb(daemon.pid!);
  const seatRss = seatKids.reduce((a, c) => a + procRssMb(c.pid!), 0);
  const memAvail = memAvailableMb();

  const N = seatsUp || 1;
  const perMin = (x: number) => (x / winS) * 60 / N;
  const agesEnd = end.flatMap((s) => s.ages), agesMid = mid.flatMap((s) => s.ages);
  const perSpace = new Map<string, number>();
  for (const s of seats) perSpace.set(s.space, (perSpace.get(s.space) ?? 0) + 1);
  const expectedPeers = [...perSpace.values()].reduce((a, n) => a + n * (n - 1), 0);
  const missingEnd = end.reduce((a, s) => a + s.missing, 0), staleEnd = end.reduce((a, s) => a + s.stale, 0);

  row("git sha", SHA);
  row("nats-server", `${serverVersion} (${NATS_BIN})`);
  row("host", `${availableParallelism()} cores, ${(totalmem() / 1073741824).toFixed(1)} GB`);
  row("shape", `${SEATS} seats in ${SPACES} space(s) of ${SPACE_SIZE}, ${seatKids.length} seat process(es), heartbeat ${HEARTBEAT ? `${HEARTBEAT}ms (override)` : "endpoint default"}`);
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
  row("seats whose presence view is not fresh", staleEnd);
  row("endpoint errors and warnings (all seats)", end.reduce((a, s) => a + s.errors, 0));

  const w = Math.max(...rows.map(([k]) => k.length));
  console.log(`\n${"=".repeat(w + 34)}`);
  for (const [k, v] of rows) console.log(k === "" ? "" : `${k.padEnd(w)}  ${v}`);
  console.log(`${"=".repeat(w + 34)}\n`);

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
