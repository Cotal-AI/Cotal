/**
 * Regression for #964: a stack stop leaves managed agents running unless `--with-agents`.
 * Run: pnpm smoke:manager-stop-reap
 *
 * The incident: one stop signal to the stack took six live seats with it. `Manager.stop()` on
 * the normal active path now detaches those seats (no handle.stop, no deprovision). The old
 * reap is `stop({ withAgents: true })`, which `cotal down --with-agents` drives by stopping
 * each seat and then signalling the manager.
 *
 * This suite drives a real `Manager` over a real authed broker with a real co-located delivery
 * daemon (a direct `deliver` run, never `up`), and a real managed seat spawned through the
 * real CLI spawn command.
 *
 * What runs here:
 *   SPARE phase: manager up, one live managed seat (pidfile), then a plain `mgr.stop()`.
 *   The seat's process stays alive and its minted creds file stays. The managed table is empty.
 *   REAP phase: a fresh manager, a second seat, `mgr.stop({ withAgents: true })`. The process
 *   is dead and the creds file is gone.
 *
 * NAMED GAPS (deliberate, not oversights):
 *   - The CLI `down` surface itself is not driven here: this host must never run `cotal down`
 *     (or `up`). Flag refusals for `--with-agents` live in the hermetic down-target smoke.
 *   - The preservation arm (`stopRetainedAgentsOnExit`) is not driven.
 *   - The broker-side footprint (dm_/dlv_ durables, ACL row) is not asserted; the on-disk creds
 *     file is the asserted deprovision observable.
 *   - A PTY child may still die when the manager *process* exits and the PTY master closes.
 *     This suite keeps the Manager object after a sparing stop so that in-process GC is not
 *     what is being measured.
 *
 * Throwaway everything: own authed nats-server on an OS-assigned free port (ONE space),
 * sandboxed COTAL_HOME, scratch workspace root, kills only PIDs it spawned or that its own
 * children wrote to pidfiles. No live stack is touched. Needs nats-server on PATH.
 * Run: pnpm smoke:manager-stop-reap
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Seat-env hygiene BEFORE any cotal import: whatever runs this suite may itself be a managed
// session whose COTAL_* names a live mesh; nothing may leak into the rig or its children.
const home = mkdtempSync(join(tmpdir(), "cotal-964-home-"));
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = join(home, "xdg");
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };

const { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } = await import("@cotal-ai/smoke-kit");
const { createSpaceAuth, mintConnectionEvictorCreds, mintCreds, mintMembershipObserverCreds, newIdentity, parseCommandArgs, probeConnect, registry, serverConfig, setupSpaceStreams } = await import("@cotal-ai/core");
const { DELIVERY_CREDS_KIND, MEMBERSHIP_RW_CREDS_KIND, authDir, recordMesh, saveSpaceAuth, spaceSegment } = await import("@cotal-ai/workspace");
await import("@cotal-ai/cli"); // registers the CLI commands (spawn/stop) into the registry
const { Manager } = await import("@cotal-ai/manager");
import type { Command, Connector, LaunchOpts } from "@cotal-ai/core";
const TSX = join(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");

let pass = 0;
let fail = 0;
/** Every cell runs and the banner always prints: `mutation-proof` treats a run that never reached
 *  its completion marker as INCONCLUSIVE rather than a kill, so a fail-fast suite turns a clean
 *  red cell into "stopped early". */
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return; }
  fail++;
  console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
};
/** A rig cell: everything after it measures the wrong world once it is false, so it throws. */
const must = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL (rig): ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
/** Cells that ran, before the count cell itself: 6 must + 10 ok. A throw lands in the catch as a
 *  counted failure, so a partial run can never print the OK banner. */
const EXPECTED_CELLS = 17;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(150);
  }
  return cond();
};
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};
const pidOf = (file: string): number | undefined => {
  try { return Number(readFileSync(file, "utf8").trim()) || undefined; } catch { return undefined; }
};

const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "reap964";
const BIN = join(import.meta.dirname, "..", "cotal.ts");
const REPO = join(import.meta.dirname, "..", "..");

const base = mkdtempSync(join(tmpdir(), "cotal-964-"));
const root = join(base, "root");
const pidDir = join(base, "pids");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
mkdirSync(pidDir, { recursive: true });
writeFileSync(join(root, ".cotal", "agents", "probe.md"), "---\nname: probe\nrole: worker\nsubscribe: []\n---\nA supervised seat that exists to be reaped.\n");

/** The seat: a REAL mesh endpoint authenticating with the creds the MANAGER minted (content, not
 *  path - the endpoint takes creds bytes), joining presence so the detached spawn's readiness
 *  resolves. It writes its pid FIRST, so liveness is observable even if the join fails. */
const CHILD = [
  "const{pathToFileURL}=require('node:url');const fs=require('fs');",
  "fs.writeFileSync(process.env.PIDFILE,String(process.pid));",
  "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
  "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:process.env.COTAL_SERVERS,",
  "creds:process.env.COTAL_CREDS_PATH?fs.readFileSync(process.env.COTAL_CREDS_PATH,'utf8'):undefined,",
  "lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,registerPresence:true,",
  "watchPresence:false,card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
  "ep.on('error',()=>{});await ep.start();setInterval(()=>{},1000);});",
].join("");
const coreDist = join(REPO, "packages", "core", "dist", "index.js");
const optsByName = new Map<string, LaunchOpts>();
const seatCon: Connector = {
  kind: "connector",
  name: "seatcon",
  requires: ["node"],
  buildLaunch: (o) => {
    optsByName.set(o.name, o);
    return {
      command: "node",
      args: ["-e", CHILD],
      env: {
        PATH: process.env.PATH ?? "",
        CORE_DIST: coreDist,
        PIDFILE: join(pidDir, `${o.name}.pid`),
        COTAL_SPACE: o.space,
        COTAL_SERVERS: o.servers ?? "",
        COTAL_CREDS_PATH: o.creds ?? "",
        COTAL_ID: o.id ?? "",
        COTAL_LIFECYCLE_UID: o.lifecycleUid ?? "",
        COTAL_NAME: o.name,
      },
    };
  },
};
registry.register(seatCon);

const cmd = (name: string): Command => {
  const c = registry.all<Command>("command").find((x) => x.name === name);
  if (!c) throw new Error(`command ${name} not registered`);
  return c;
};
/** Spawn a seat through the REAL CLI spawn command, in-process, standing in the workspace root
 *  (the command resolves auth from the cwd root, exactly as an operator's shell would). */
const spawnSeat = async (name: string): Promise<void> => {
  const prev = process.cwd();
  process.chdir(root);
  try {
    await cmd("spawn").run(parseCommandArgs(cmd("spawn"), ["probe", "--detach", "--agent", "seatcon", "--space", SPACE, "--name", name]));
  } finally {
    process.chdir(prev);
  }
};
const kids: ChildProcess[] = [];

let releaseBroker: (() => void) | undefined;
let brokerProc: ChildProcess | undefined;
let brokerStore: string | undefined;
let daemon: ChildProcess | undefined;
const daemonSink = { out: "", exited: false };
let mgr1: InstanceType<typeof Manager> | undefined;
let mgr2: InstanceType<typeof Manager> | undefined;

console.log("\n── #964: a stack stop leaves managed agents running ─────────────\n");
try {
  // ── the rig: one authed broker, one provisioned space ─────────────────────────────────────────
  const auth = await createSpaceAuth(SPACE);
  saveSpaceAuth(authDir(root), auth);
  brokerStore = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}964-js-`));
  const conf = join(base, "server.conf");
  writeFileSync(conf, serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: brokerStore, host: "127.0.0.1" }));
  brokerProc = spawnProc("nats-server", ["-c", conf], { stdio: "ignore" });
  releaseBroker = teardownOnSignal(brokerProc, brokerStore);
  let serving = false;
  for (let i = 0; i < 80; i++) {
    const p = await probeConnect(SERVER, { timeoutMs: 400 });
    if (p.ok || p.reason === "auth-required") { serving = true; break; }
    await sleep(100);
  }
  must("the authed broker is serving", serving, { server: SERVER });
  await setupSpaceStreams({ servers: SERVER, space: SPACE, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  recordMesh({ space: SPACE, server: SERVER, root, mode: "auth", ts: new Date().toISOString() });

  // The REAL delivery daemon, co-located with the broker as in a live stack (a direct daemon run,
  // never `up`): on an auth mesh the manager's deprovision/re-registration verify-evicts through
  // the daemon's ctl.delivery-admin rail, so without it the reap's footprint half never completes.
  const obs = await mintMembershipObserverCreds(auth, newIdentity());
  const evict = await mintConnectionEvictorCreds(auth, newIdentity());
  const seg = join(root, ".cotal", spaceSegment(SPACE));
  mkdirSync(seg, { recursive: true });
  const daemonFiles: Record<string, string> = {
    [DELIVERY_CREDS_KIND]: await mintCreds(auth, newIdentity(), "delivery"),
    [MEMBERSHIP_RW_CREDS_KIND]: await mintCreds(auth, newIdentity(), "membership-rw"),
    "membership-observer.creds": obs,
    "connection-evictor.creds": evict,
    "membership.json": JSON.stringify({ accountId: auth.account.pub }),
  };
  for (const [kind, bytes] of Object.entries(daemonFiles)) writeFileSync(join(seg, kind), bytes, { mode: 0o600 });
  daemon = spawnProc(TSX, [BIN, "deliver", "--space", SPACE, "--server", SERVER, "--creds", join(seg, DELIVERY_CREDS_KIND)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...cleanEnv, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1" },
  });
  daemon.stdout!.on("data", (b: Buffer) => { daemonSink.out += b.toString(); });
  daemon.stderr!.on("data", (b: Buffer) => { daemonSink.out += b.toString(); });
  daemon.on("exit", () => { daemonSink.exited = true; });
  // Both readiness signals, not just the first: the manager's start() runs a renewal pass whose
  // adoption needs the daemon's membership feed - a pass that beats the feed leaves the daemon on
  // its pre-renewal principal and the control phase then addresses a rail nobody serves.
  must(
    "the delivery daemon is up with its membership feed (the liveness oracle the deprovision path evicts through)",
    (await until(() => daemonSink.out.includes("delivery daemon up"), 60_000)) &&
      (await until(() => daemonSink.out.includes("membership feed up"), 15_000)) &&
      !daemonSink.exited,
    daemonSink.out.slice(-500),
  );

  // ── SPARE phase: one live seat, then a plain stack stop ──────────────────────────────────────
  mgr1 = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: root });
  await mgr1.start();
  await spawnSeat("seatA");
  must("seat A spawned through the manager (the throwaway connector built its launch)", optsByName.has("seatA"));
  const pidA = await until(() => pidOf(join(pidDir, "seatA.pid")) !== undefined, 15_000) ? pidOf(join(pidDir, "seatA.pid"))! : undefined;
  must("seat A's child process is live (pidfile written, PID answers)", pidA !== undefined && alive(pidA), { pidA });
  const credsA = optsByName.get("seatA")?.creds;
  ok("seat A's minted creds file exists on disk (the footprint a deprovision removes)", credsA !== undefined && existsSync(credsA), { credsA });
  await sleep(1500);
  ok("instrument: seat A is still live after a settle window (its death below would be stop-caused, not self-inflicted)", pidA !== undefined && alive(pidA));

  let stopError: string | undefined;
  try {
    await mgr1.stop();
  } catch (e) {
    stopError = (e as Error).message;
  }
  ok("a plain Manager.stop() proceeds against a live managed seat", stopError === undefined, { stopError });
  ok("default stop empties the managed table", (mgr1 as unknown as { agents: Map<string, unknown> }).agents.size === 0);
  ok("#964: a plain Manager.stop() leaves the live managed seat running", pidA !== undefined && alive(pidA), { pidA });
  ok("#964: a spared seat is not deprovisioned (its minted creds file remains)", credsA !== undefined && existsSync(credsA), { credsA });

  // ── REAP phase: a fresh manager, a second seat, stop({ withAgents: true }) ────────────────────
  mgr2 = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: root });
  await mgr2.start();
  must("a fresh manager starts over the same root (reap phase)", true);
  await spawnSeat("seatB");
  const pidB = await until(() => pidOf(join(pidDir, "seatB.pid")) !== undefined, 15_000) ? pidOf(join(pidDir, "seatB.pid"))! : undefined;
  must("seat B is live under the fresh manager", pidB !== undefined && alive(pidB) && optsByName.has("seatB"), { pidB });
  const credsB = optsByName.get("seatB")?.creds;
  ok("seat B's creds file exists before the explicit reap", credsB !== undefined && existsSync(credsB), { credsB });
  let reapError: string | undefined;
  try {
    await mgr2.stop({ withAgents: true });
  } catch (e) {
    reapError = (e as Error).message;
  }
  mgr2 = undefined;
  ok("stop({ withAgents: true }) proceeds", reapError === undefined, { reapError });
  const bReaped =
    pidB !== undefined && (await until(() => !alive(pidB), 10_000)) &&
    credsB !== undefined && (await until(() => !existsSync(credsB), 10_000));
  ok("#964: stop({ withAgents: true }) reaps the seat (process dead, creds gone)", bReaped, { pidB, credsB });
  ok("#964: the spared seat A is still live after the other manager's reap", pidA !== undefined && alive(pidA), { pidA });

  ok("every cell ran (silently skipped cells must not read as green)", pass + fail === EXPECTED_CELLS - 1, { pass, fail, expected: EXPECTED_CELLS - 1 });
} catch (e) {
  fail++;
  console.log(`  ✗ scenario threw: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  for (const m of [mgr1, mgr2]) {
    try { if (m) await m.stop(); } catch { /* teardown only */ }
  }
  // Backstop for seats the managers no longer track: only PIDs OUR children wrote to OUR pidfiles.
  for (const seat of ["seatA", "seatB"]) {
    const pid = pidOf(join(pidDir, `${seat}.pid`));
    if (pid !== undefined && alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
  for (const k of kids) { try { k.kill("SIGKILL"); } catch { /* already gone */ } }
  if (daemon) await killAndAwaitExit(daemon, "SIGKILL");
  if (brokerProc) await killAndAwaitExit(brokerProc, "SIGKILL");
  for (const d of [base, home, brokerStore]) if (d) rmSync(d, { recursive: true, force: true });
  releaseBroker?.();
}

if (fail > 0) {
  console.log(`\nMANAGER-STOP-REAPS-AGENTS SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
  process.exitCode = 1;
} else {
  console.log(`\nMANAGER-STOP-REAPS-AGENTS SMOKE OK ✅  (${pass} passed, ${fail} failed)`);
}
