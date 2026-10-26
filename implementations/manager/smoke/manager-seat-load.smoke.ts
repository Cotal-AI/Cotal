/**
 * Manager LOAD harness — what one live seat costs the manager daemon. Capacity, not correctness.
 *
 * Boots a JWT-auth broker and the real delivery daemon (`_boot-broker.ts`, `_boot-delivery.ts`),
 * then runs the REAL `Manager` (pty runtime, the default) in its own process and has it spawn seats
 * through `startAgent`, the same call `cotal spawn` and `cotal_spawn` reach. Every spawn is the
 * product's: the slot reserve and activation saga, `provisionAgent`, the cred file, the pty child,
 * and the presence race that resolves the seat as started.
 *
 * The seats are STUBS, never model processes. The stub connector's launch is a shell that hands its
 * launch env (every `COTAL_*` the manager stamped, including `COTAL_MANAGER_INSTANCE` and the
 * accepted-row token) to a shared seat host and then sleeps, so the manager supervises one real
 * child process per seat in its own pty. The seat host builds each seat exactly as a connector does,
 * `configFromEnv` then `MeshAgent`, so every seat registers presence, binds its durables and arms
 * the turn relay against this manager. One Node process holds every seat; a Node process per seat
 * would cost the field more memory than the manager under test.
 *
 * It spawns in steps (`--steps 10,25,50`) and, at each step, lets the seats settle and then reads
 * the manager process's CPU and RSS over an idle window, so the per-seat slope comes from one
 * manager process rather than across runs. It also reports the manager's CPU per spawn. The
 * manager's own ceiling is `MAX_AGENTS` (50) per manager; a step above it is refused by design and
 * the refusal is reported, not hidden.
 *
 * Run (needs nats-server on PATH):
 *   pnpm -C implementations/manager smoke:manager-seat-load --steps 10,25,50 --seconds 60
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createSpaceAuth, mintCreds, newIdentity, registry, setupSpaceStreams,
  type Connector, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { MeshAgent, configFromEnv } from "@cotal-ai/connector-core";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

// Scrub any ambient COTAL_* before anything is handed to a child. Whatever runs this harness may
// itself be a managed agent session, and its COTAL_SERVERS / credential variables name a LIVE mesh.
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];

const CHANNEL = "general";
const ROLE = "default";
const CONNECTOR = "load-stub";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ipcSend = (m: unknown): Promise<void> => new Promise((r) => { process.send!(m, () => r()); });
const nextCmd = <T>(): Promise<T> => new Promise((r) => process.once("message", (m) => r(m as T)));

interface ManagerJob { kind: "manager"; space: string; servers: string; workspaceRoot: string; seatDir: string; stubToken: string }
interface SeatsJob { kind: "seats"; seatDir: string }
type Job = ManagerJob | SeatsJob;

/** The stub seat: hand every COTAL_* the manager stamped to the seat host, then idle. The sleep
 *  carries a per-run token so the run's own children, and only those, can be swept at the end. */
const stubScript = (token: string) =>
  `umask 077; f="$SEAT_HOST_DIR/$COTAL_ID"; env | grep '^COTAL_' > "$f.tmp" && mv "$f.tmp" "$f.seat"; exec sleep 99999.${token}`;

// ---------------------------------------------------------------------------------------------
// manager child: the real Manager, spawning through startAgent
// ---------------------------------------------------------------------------------------------

async function runManager(job: ManagerJob): Promise<void> {
  const { Manager } = await import("../src/manager.js");
  const stub: Connector = {
    kind: "connector", name: CONNECTOR, requires: ["sh"],
    // The fields a stock connector forwards from LaunchOpts (extensions/connector-claude-code), as
    // COTAL_* env. The manager adds COTAL_MANAGER_INSTANCE itself after buildLaunch.
    buildLaunch: (o: LaunchOpts): LaunchSpec => ({
      command: "sh", args: ["-c", stubScript(job.stubToken)],
      env: {
        PATH: process.env.PATH ?? "", SEAT_HOST_DIR: job.seatDir,
        COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers), COTAL_NAME: o.name,
        ...(o.id ? { COTAL_ID: o.id } : {}), ...(o.role ? { COTAL_ROLE: o.role } : {}),
        ...(o.creds ? { COTAL_CREDS: o.creds } : {}), ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
        ...(o.acceptedToken ? { COTAL_ACCEPTED_TOKEN: o.acceptedToken } : {}),
        ...(o.subscribe ? { COTAL_SUBSCRIBE: o.subscribe.join(",") } : {}),
        ...(o.allowSubscribe ? { COTAL_ALLOW_SUBSCRIBE: o.allowSubscribe.join(",") } : {}),
        ...(o.allowPublish ? { COTAL_ALLOW_PUBLISH: o.allowPublish.join(",") } : {}),
      },
    }),
  };
  registry.register(stub);
  const mgr = new Manager({ space: job.space, servers: job.servers, runtime: "pty", workspaceRoot: job.workspaceRoot });
  await mgr.start();
  await ipcSend({ ready: true });
  for (;;) {
    const cmd = await nextCmd<{ cmd: "spawn"; from: number; to: number } | { cmd: "sample" } | { cmd: "stop" }>();
    if (cmd.cmd === "stop") {
      await Promise.race([mgr.stop().catch(() => {}), wait(30_000)]);
      await ipcSend({ stopped: true });
      return;
    }
    if (cmd.cmd === "sample") {
      const u = process.cpuUsage();
      await ipcSend({ sample: { cpuMs: (u.user + u.system) / 1000, rssMb: process.memoryUsage().rss / 1048576, heapMb: process.memoryUsage().heapUsed / 1048576 } });
      continue;
    }
    let ok = 0;
    const refusals: string[] = [];
    const spawnMs: number[] = [];
    const cpu0 = process.cpuUsage();
    for (let i = cmd.from; i < cmd.to; i++) {
      const t0 = performance.now();
      const r = await mgr.startAgent({ name: `seat${i}`, agent: CONNECTOR, cwd: job.workspaceRoot, events: false });
      spawnMs.push(performance.now() - t0);
      if (r.ok) ok++;
      else if (refusals.length < 5) refusals.push(String(r.error).slice(0, 200));
    }
    const cpu = process.cpuUsage(cpu0);
    await ipcSend({ spawned: { ok, failed: cmd.to - cmd.from - ok, refusals, spawnMs, cpuMs: (cpu.user + cpu.system) / 1000 } });
  }
}

// ---------------------------------------------------------------------------------------------
// seat host child: every stub seat's session, built as a connector builds one
// ---------------------------------------------------------------------------------------------

async function runSeats(job: SeatsJob): Promise<void> {
  const seats = new Map<string, MeshAgent>();
  let failed = 0;
  const firstErrors: string[] = [];
  let stopping = false;
  const scan = async () => {
    for (const f of readdirSync(job.seatDir)) {
      if (!f.endsWith(".seat")) continue;
      const path = join(job.seatDir, f);
      const env: NodeJS.ProcessEnv = {};
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
      }
      renameSync(path, `${path}.taken`);
      try {
        const agent = new MeshAgent(configFromEnv(env), env, { withholdProcessCwd: true });
        agent.on("error", () => {});
        seats.set(f, agent);
        void agent.start().catch((e: Error) => { failed++; if (firstErrors.length < 5) firstErrors.push(e.message.slice(0, 200)); });
      } catch (e) {
        failed++;
        if (firstErrors.length < 5) firstErrors.push((e as Error).message.slice(0, 200));
      }
    }
  };
  const poll = setInterval(() => { if (!stopping) void scan(); }, 100);
  await ipcSend({ ready: true });
  for (;;) {
    const cmd = await nextCmd<{ cmd: "sample" } | { cmd: "stop" }>();
    if (cmd.cmd === "stop") break;
    const u = process.cpuUsage();
    await ipcSend({ sample: { seats: seats.size, connected: [...seats.values()].filter((a) => a.connected).length, failed, firstErrors, cpuMs: (u.user + u.system) / 1000, rssMb: process.memoryUsage().rss / 1048576 } });
  }
  stopping = true;
  clearInterval(poll);
  await Promise.all([...seats.values()].map((a) => Promise.race([a.stop().catch(() => {}), wait(5000)])));
  await ipcSend({ stopped: true });
}

if (process.argv[2] === "child") {
  const job = await nextCmd<Job>();
  if (job.kind === "manager") await runManager(job);
  else await runSeats(job);
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------
// orchestrator
// ---------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string, dflt?: string): string => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) return argv[i + 1];
  if (dflt === undefined) throw new Error(`manager-seat-load: --${name} is required`);
  return dflt;
};
const STEPS = flag("steps", "10,25,50").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
const SECONDS = Number(flag("seconds", "60"));
const SETTLE_S = Number(flag("settle", "20"));
const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd: import.meta.dirname }).trim();
const SHA = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: REPO }).trim();

const CLK_TCK = 100; // Linux x86_64; this harness is Linux-only, like the rest of the load path.
const procCpuMs = (pid: number): number => {
  const s = readFileSync(`/proc/${pid}/stat`, "utf8");
  const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
  return ((Number(f[11]) + Number(f[12])) / CLK_TCK) * 1000;
};
const procRssMb = (pid: number): number => {
  const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
  return m ? Number(m[1]) / 1024 : NaN;
};
/** The manager's own pty children: every live process whose parent is the manager. */
const childCount = (pid: number): number => {
  try { return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).length; }
  catch { return NaN; }
};

const tag = randomUUID().slice(0, 8);
const stubToken = String(Date.now() % 1_000_000).padStart(6, "0");
const space = `mgrload-${tag}`;
const dir = mkdtempSync(join(tmpdir(), "mgr-seat-load-"));
const workspaceRoot = join(dir, "ws");
const seatDir = join(dir, "seats");
const home = join(dir, "home");
const seatRoot = mkdtempSync(join(tmpdir(), "s"));
for (const d of [join(workspaceRoot, ".cotal", "agents"), seatDir, home]) mkdirSync(d, { recursive: true });
const maxSeats = STEPS[STEPS.length - 1];
for (let i = 0; i < maxSeats; i++)
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `seat${i}.md`), `---\nname: seat${i}\nrole: ${ROLE}\nsubscribe: [${CHANNEL}]\nallowSubscribe: [${CHANNEL}]\nallowPublish: [${CHANNEL}]\n---\n`);

const auth = await createSpaceAuth(space);
saveSpaceAuth(authDir(workspaceRoot), auth); // the FS composition the manager's start() reads
const broker = await bootBroker(auth, { monitor: true });
// `bootBroker` does not expose its pid; the newest nats-server right after it returns is this one
// (the field runs no other broker while a harness runs).
const brokerPid = Number(execFileSync("sh", ["-c", "pgrep -n -x nats-server || true"], { encoding: "utf8" }).trim()) || undefined;

const children: ChildProcess[] = [];
let stopping = false;
let abort!: (e: Error) => void;
const aborted = new Promise<never>((_, reject) => { abort = reject; });
aborted.catch(() => {});
const guard = <T>(p: Promise<T>): Promise<T> => Promise.race([p, aborted]);
const startChild = (job: Job, env: NodeJS.ProcessEnv): ChildProcess => {
  const child = spawn(process.execPath, [...process.execArgv, import.meta.filename, "child"], { stdio: ["ignore", "inherit", "inherit", "ipc"], env });
  children.push(child);
  child.on("exit", (code, signal) => { if (!stopping) abort(new Error(`${job.kind} child ${child.pid} exited (${code ?? signal}) mid-run`)); });
  child.send(job);
  return child;
};
type Cmd = { cmd: "spawn"; from: number; to: number } | { cmd: "sample" } | { cmd: "stop" };
const ask = (child: ChildProcess, cmd: Cmd | undefined, key: string): Promise<Record<string, unknown>> => guard(new Promise((resolve) => {
  const on = (m: Record<string, unknown>) => { if (key in m) { child.off("message", on); resolve(m); } };
  child.on("message", on);
  if (cmd) child.send(cmd);
}));

const table: string[][] = [];
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(workspaceRoot).identity });

  const childEnv = { ...cleanEnv, DO_NOT_TRACK: "1", COTAL_TELEMETRY: "off", COTAL_HOME: home, COTAL_SEAT_ROOT: seatRoot };
  const seatHost = startChild({ kind: "seats", seatDir }, childEnv);
  await ask(seatHost, undefined, "ready");
  const manager = startChild({ kind: "manager", space, servers: broker.servers, workspaceRoot, seatDir, stubToken }, childEnv);
  await ask(manager, undefined, "ready");

  const measure = async (seatsNow: number, spawn?: { ok: number; failed: number; refusals: string[]; spawnMs: number[]; cpuMs: number }) => {
    await wait(SETTLE_S * 1000);
    const m0 = procCpuMs(manager.pid!), h0 = procCpuMs(seatHost.pid!), b0 = brokerPid ? procCpuMs(brokerPid) : NaN;
    const t0 = performance.now();
    await wait(SECONDS * 1000);
    const s = (performance.now() - t0) / 1000;
    const mgrCores = (procCpuMs(manager.pid!) - m0) / 1000 / s;
    const host = (await ask(seatHost, { cmd: "sample" }, "sample")).sample as { seats: number; connected: number; failed: number; firstErrors: string[]; rssMb: number };
    const spawnMs = spawn?.spawnMs.slice().sort((a, b) => a - b) ?? [];
    table.push([
      String(seatsNow),
      `${host.connected} / ${childCount(manager.pid!)}`,
      (mgrCores * 1000).toFixed(2),
      procRssMb(manager.pid!).toFixed(1),
      spawn ? `${spawn.ok} / ${spawn.failed}` : "",
      spawn && spawn.ok ? (spawn.cpuMs / spawn.ok).toFixed(0) : "",
      spawnMs.length ? `${spawnMs[Math.floor(spawnMs.length / 2)].toFixed(0)} / ${spawnMs[spawnMs.length - 1].toFixed(0)}` : "",
      (((procCpuMs(seatHost.pid!) - h0) / 1000 / s) * 1000).toFixed(2),
      host.rssMb.toFixed(0),
      brokerPid ? (((procCpuMs(brokerPid) - b0) / 1000 / s) * 1000).toFixed(2) : "n/a",
    ]);
    console.error(`  … step ${seatsNow}: manager ${(mgrCores * 1000).toFixed(2)} millicores, RSS ${procRssMb(manager.pid!).toFixed(1)} MB, ${host.connected} seats connected`);
    if (spawn?.refusals.length) for (const r of spawn.refusals) console.error(`    refusal: ${r}`);
    if (host.firstErrors.length) for (const e of host.firstErrors) console.error(`    seat error: ${e}`);
  };

  await measure(0);
  let have = 0;
  for (const step of STEPS) {
    const r = (await ask(manager, { cmd: "spawn", from: have, to: step }, "spawned")).spawned as { ok: number; failed: number; refusals: string[]; spawnMs: number[]; cpuMs: number };
    have = step;
    await measure(step, r);
  }

  const head = ["seats requested", "seats connected / manager children", "manager millicores", "manager RSS MB", "spawned ok / refused", "manager CPU ms per spawn", "spawn wall p50 / max ms", "seat host millicores", "seat host RSS MB", "broker millicores"];
  console.log(`\nmanager-seat-load  git ${SHA}  host ${availableParallelism()} cores, ${(totalmem() / 1073741824).toFixed(1)} GB  idle window ${SECONDS}s after ${SETTLE_S}s settle\n`);
  console.log(`| ${head.join(" | ")} |`);
  console.log(`|${head.map(() => "---").join("|")}|`);
  for (const r of table) console.log(`| ${r.join(" | ")} |`);
  console.log("");

  stopping = true;
  await ask(manager, { cmd: "stop" }, "stopped").catch(() => undefined);
  await ask(seatHost, { cmd: "stop" }, "stopped").catch(() => undefined);
} catch (e) {
  console.error("  ✗ manager-seat-load threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  stopping = true;
  for (const c of children) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
  // The pty children outlive a killed manager; this run's carry its token and nothing else does.
  try { execFileSync("pkill", ["-f", `sleep 99999.${stubToken}`]); } catch { /* none left */ }
  await delivery?.stop().catch(() => {});
  await broker.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(seatRoot, { recursive: true, force: true });
  await new Promise<void>((r) => { process.stdout.write("", () => r()); });
  process.exit(process.exitCode ?? 0);
}
