/**
 * REGRESSION for #964: default manager stop spares managed agents and explicit stop reaps them - pnpm smoke:manager-stop-reap
 *
 * The incident: one stop signal to the stack took six live seats with it, several holding
 * uncommitted work, and the logs read as a deliberate teardown. The mechanism is
 * `Manager.stop()`: its normal active path now releases detachable local custody and
 * leaves agents running. Explicit `stop({ withAgents: true })` is the previous reap.
 *
 * This suite drives the SHIPPED owner of that behavior - a real `Manager` over a real authed
 * broker with a real co-located delivery daemon (a direct `deliver` run, never `up`; on an auth
 * mesh the deprovision path verify-evicts through it), a real managed seat spawned through the
 * real CLI spawn command - and pins today's defective semantics as explicitly-labeled
 * "#964 unfixed:" expectations that are GREEN today.
 *
 * THE CONTRACT WITH THE FUTURE FIX (read this before touching the labeled cells): the accepted
 * direction for #964 is a three-mode `down` (bare = spare agents, `--with-agents` = today,
 * `--preserve-state` = capture-and-restore). When that lands, the "#964 unfixed:" cells below
 * MUST NOT stay silently green:
 *   - if `Manager.stop()` itself learns a sparing default, they go RED and the fix PR flips
 *     them into assertions that the seat SURVIVES a bare stack stop;
 *   - if instead `stop()` grows an explicit mode parameter and bare `down` passes the sparing
 *     choice, the fix PR must RELABEL these cells as the destructive mode's explicit spelling
 *     (`stop({withAgents: true})` or equivalent) and add the sparing path as new green cells.
 *   Either way this file changes in the fix PR; a fix that leaves it untouched is incomplete.
 * This file now asserts the accepted three-mode contract: a plain `stop()` spares, and
 * `stop({ withAgents: true })` reaps.
 *
 * What runs here:
 *   SPARE phase: manager up, one live managed seat, then a plain `mgr.stop()`. The seat
 *   process and minted creds remain.
 *   REAP phase: a second manager on a separate root, `stop({ withAgents: true })`. That
 *   seat is dead and its creds are gone, while the independently spared seat remains.
 *   A failed run then prints the delivery daemon's state before teardown kills it: exited (code and
 *   signal) or still running, read again after the rail request so a death during it shows, what one
 *   fresh request on its ctl.delivery-admin rail returns, and its output tail. A rail timeout alone
 *   reads the same for a dead, a stalled and a slow daemon (#1226).
 *
 * NAMED GAPS (deliberate, not oversights):
 *   - The CLI `down` surface itself is not driven here: this host must never run `cotal down`
 *     (or `up`), including against a throwaway root - the #964 architecture review restricts
 *     local validation to shipped handlers and in-process manager seams, which is what this is.
 *   - The preservation arm (`stopRetainedAgentsOnExit`) is not driven: it is only reachable
 *     through preservation state no shipped public path sets in this rig, and hand-poking
 *     private state would prove nothing about the shipped owner.
 *   - The broker-side footprint (dm_/dlv_ durables, ACL row) is not asserted; the on-disk creds
 *     file is the asserted deprovision observable.
 *
 * Throwaway everything: own authed nats-server on an OS-assigned free port (ONE space is all the rig
 * needs; the artifact Object Store reserves nothing, so the count is not a capacity choice), sandboxed COTAL_HOME,
 * scratch workspace root, kills only PIDs it spawned or that its own children wrote to pidfiles.
 * No live stack is touched, no `cotal up`/`down` anywhere. Needs nats-server on PATH.
 * Run: pnpm smoke:manager-stop-reap
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeScratch } from "./_scratch.js";

// Seat-env hygiene BEFORE any cotal import: whatever runs this suite may itself be a managed
// session whose COTAL_* names a live mesh; nothing may leak into the rig or its children.
const scratch = makeScratch("cotal-964-scratch-");
const home = mkdtempSync(join(scratch, "home-"));
for (const k of Object.keys(process.env)) if (k.startsWith("COTAL_")) delete process.env[k];
process.env.COTAL_HOME = home;
process.env.XDG_CONFIG_HOME = join(home, "xdg");
const cleanEnv: NodeJS.ProcessEnv = { ...process.env };

const { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } = await import("@cotal-ai/smoke-kit");
const { CotalEndpoint, createSpaceAuth, mintConnectionEvictorCreds, mintCreds, mintMembershipObserverCreds, newIdentity, parseCommandArgs, probeConnect, registry, serverConfig, setupSpaceStreams } = await import("@cotal-ai/core");
const { DELIVERY_CREDS_KIND, MEMBERSHIP_RW_CREDS_KIND, authDir, recordMesh, saveSpaceAuth, spaceSegment, workspaceSecretStore } = await import("@cotal-ai/workspace");
await import("@cotal-ai/cli"); // registers the CLI commands (spawn/stop) into the registry
const { Manager } = await import("@cotal-ai/manager");
import type { Command, Connector, LaunchOpts, SpaceAuth } from "@cotal-ai/core";
import { freePort } from "@cotal-ai/smoke-kit";
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
/** Seventeen scenario cells run before the final count cell. A throw lands in the catch as a
 * counted failure, so a partial run can never print the OK banner. */
const EXPECTED_CELLS = 18;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(150);
  }
  return cond();
};
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

const base = mkdtempSync(join(scratch, `${SMOKE_BROKER_TOKEN}rig-`));
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
    await cmd("spawn").run(parseCommandArgs(cmd("spawn"), ["probe", "--detach", "--no-events", "--agent", "seatcon", "--space", SPACE, "--name", name]));
  } finally {
    process.chdir(prev);
  }
};
const kids: ChildProcess[] = [];
/** The deliberate despawn control runs the REAL binary as a subprocess: the in-process `stop`
 *  command exits the whole process on failure, which would kill the suite. */
const cliStop = (name: string): Promise<{ code: number | null; out: string }> =>
  new Promise((resolve, reject) => {
    const p = spawnProc(TSX, [BIN, "stop", "--name", name, "--space", SPACE], {
      cwd: root,
      env: { ...cleanEnv, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    kids.push(p);
    let out = "";
    p.stdout?.on("data", (b: Buffer) => void (out += b.toString()));
    p.stderr?.on("data", (b: Buffer) => void (out += b.toString()));
    p.on("error", reject);
    p.on("exit", (code) => resolve({ code, out }));
  });

let releaseBroker: (() => void) | undefined;
let brokerProc: ChildProcess | undefined;
let brokerStore: string | undefined;
let daemon: ChildProcess | undefined;
const daemonSink = { out: "", exited: false, exit: "" };
let spaceAuth: SpaceAuth | undefined;
let mgr1: InstanceType<typeof Manager> | undefined;
let mgr2: InstanceType<typeof Manager> | undefined;
/** The delivery daemon's state when a run fails (#1226). The process state separates dead from
 *  alive, and it is read before and after the probe, so a daemon that dies while the probe waits
 *  does not read as a live one that timed out. One fresh request on its rail, with the scoped
 *  one-shot credential the shipped verify-evict path uses, separates a daemon that answers now (it
 *  was slow) from one that still does not (it is stalled); "no responders" means nothing serves the rail. */
const daemonState = async (): Promise<string> => {
  const d = daemon;
  if (!d) return "never started";
  const procNow = () => daemonSink.exited ? `exited (${daemonSink.exit})` : `running (pid ${d.pid})`;
  const asked = procNow();
  let rail = "not asked (no space auth)";
  if (spaceAuth) {
    const id = newIdentity();
    let probe: InstanceType<typeof CotalEndpoint> | undefined;
    const t0 = Date.now();
    try {
      probe = new CotalEndpoint({
        space: SPACE, servers: SERVER, creds: await mintCreds(spaceAuth, id, "endpoint-evictor", { expiresInSeconds: 60 }),
        card: { id: id.id, name: "reap964-rail-probe", kind: "endpoint" },
        channels: [], consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
      });
      probe.on("error", () => {});
      await probe.start();
      const r = await probe.requestDeliveryAdmin("reloadStoreIdentity", {}, 15_000);
      rail = `answered after ${Date.now() - t0}ms (${r.ok ? "ok" : `refused: ${r.error}`})`;
    } catch (e) {
      rail = `${e instanceof Error ? e.message : String(e)} after ${Date.now() - t0}ms`;
    } finally {
      await probe?.stop().catch(() => {});
    }
  }
  const after = procNow();
  const proc = after === asked ? after : `${asked} when asked, then ${after} during the ask`;
  return `${proc}; ctl.delivery-admin rail asked again: ${rail}; output tail: ${JSON.stringify(daemonSink.out.slice(-600))}`;
};

console.log("\n── #964: default stop spares, explicit stop reaps ─────────────\n");
try {
  console.log("manager-stop-reap: first-line");
  // ── the rig: one authed broker, one provisioned space ─────────────────────────────────────────
  const auth = await createSpaceAuth(SPACE);
  spaceAuth = auth;
  saveSpaceAuth(authDir(root), auth);
  brokerStore = mkdtempSync(join(scratch, `${SMOKE_BROKER_TOKEN}964-js-`));
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
  // Both managers deliberately use different runtime/workspace roots, but credential renewal and
  // the one delivery daemon must share ONE signing/credential authority. #1447 now challenges this
  // identity at start and renewal time, so make the intended composition explicit instead of
  // letting mgr2 silently derive a second filesystem store from rootB.
  const sharedSecretStore = workspaceSecretStore(root);

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
  daemon.on("exit", (code, signal) => { daemonSink.exited = true; daemonSink.exit = `code ${code}, signal ${signal}`; });
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

  // ── SPARE phase: one live seat, then a plain manager stop ─────────────────────────────────────
  mgr1 = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: root, secretStore: sharedSecretStore });
  await mgr1.start();
  await spawnSeat("seatA");
  must("seat A spawned through the manager (the throwaway connector built its launch)", optsByName.has("seatA"));
  const pidA = await until(() => pidOf(join(pidDir, "seatA.pid")) !== undefined, 15_000) ? pidOf(join(pidDir, "seatA.pid"))! : undefined;
  must("seat A's child process is live (pidfile written, PID answers)", pidA !== undefined && alive(pidA), { pidA });
  const credsA = optsByName.get("seatA")?.creds;
  ok("seat A's minted creds file exists on disk (the footprint a deprovision removes)", credsA !== undefined && existsSync(credsA), { credsA });
  await sleep(1500);
  ok("instrument: seat A is still live after a settle window", pidA !== undefined && alive(pidA));

  let stopError: string | undefined;
  console.log("manager-stop-reap: before-mgr1-stop");
  try {
    await mgr1.stop();
  } catch (e) {
    stopError = (e as Error).message;
  }
  console.log("manager-stop-reap: manager-stop-returned");
  ok("plain Manager.stop() succeeds against a detachable live seat", stopError === undefined, { stopError });
  ok("#964: default stop leaves the managed child running", pidA !== undefined && alive(pidA), { pidA });
  ok("#964: default stop retains the minted credential", credsA !== undefined && existsSync(credsA), { credsA });
  ok("#964: default stop drops the old manager table", (mgr1 as unknown as { agents: Map<string, unknown> }).agents.size === 0);

  // ── REAP phase: a second manager owns a separate root and deliberately reaps its seat ─────────
  const rootB = join(base, "rootB");
  mkdirSync(join(rootB, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(rootB, ".cotal", "agents", "probe.md"), "---\nname: probe\nrole: worker\nsubscribe: []\n---\nA supervised seat that exists to be reaped.\n");
  saveSpaceAuth(authDir(rootB), auth);
  recordMesh({ space: SPACE, server: SERVER, root: rootB, mode: "auth", ts: new Date().toISOString() });
  mgr2 = new Manager({ space: SPACE, servers: SERVER, runtime: "pty", workspaceRoot: rootB, secretStore: sharedSecretStore });
  await mgr2.start();
  must("a second manager starts on a separate root", true);
  const prev = process.cwd();
  process.chdir(rootB);
  try {
    await cmd("spawn").run(parseCommandArgs(cmd("spawn"), ["probe", "--detach", "--no-events", "--agent", "seatcon", "--space", SPACE, "--name", "seatB"]));
  } finally {
    process.chdir(prev);
  }
  const pidB = await until(() => pidOf(join(pidDir, "seatB.pid")) !== undefined, 15_000) ? pidOf(join(pidDir, "seatB.pid"))! : undefined;
  must("seat B is live under the second manager", pidB !== undefined && alive(pidB) && optsByName.has("seatB"), { pidB });
  const credsB = optsByName.get("seatB")?.creds;
  ok("seat B's creds file exists before explicit reap", credsB !== undefined && existsSync(credsB), { credsB });
  let reapError: string | undefined;
  try {
    await mgr2.stop({ withAgents: true });
  } catch (e) {
    reapError = (e as Error).message;
  }
  mgr2 = undefined;
  ok("stop({ withAgents: true }) succeeds", reapError === undefined, { reapError });
  ok("#964: explicit stop kills the managed child", pidB !== undefined && (await until(() => !alive(pidB), 10_000)), { pidB });
  ok("#964: explicit stop deprovisions the minted credential", credsB !== undefined && (await until(() => !existsSync(credsB), 10_000)), { credsB });
  ok("#964: explicit reap does not kill the independently spared child", pidA !== undefined && alive(pidA), { pidA });

  ok("every cell ran (silently skipped cells must not read as green)", pass + fail === EXPECTED_CELLS - 1, { pass, fail, expected: EXPECTED_CELLS - 1 });
} catch (e) {
  fail++;
  console.log(`  ✗ scenario threw: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  if (fail > 0) console.log(`  delivery daemon at failure: ${await daemonState()}`);
  for (const m of [mgr1, mgr2]) {
    try { if (m) await m.stop({ withAgents: true }); } catch { /* teardown only */ }
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
  rmSync(scratch, { recursive: true, force: true });
  releaseBroker?.();
  console.log("manager-stop-reap: finally-complete");
}

if (fail > 0) {
  console.log(`\nMANAGER-STOP-POLICY SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
  process.exitCode = 1;
} else {
  console.log(`\nMANAGER-STOP-POLICY SMOKE OK ✅  (${pass} passed, ${fail} failed)`);
}
