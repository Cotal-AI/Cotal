/**
 * LIVE e2e for `cotal up --detach` — the stage-2b claim the docs make ("start the mesh + delivery
 * daemon + manager") exercised as REAL usage: the actual binary as subprocesses, a real JWT-authed
 * broker on an isolated port, and the control plane answering a real `cotal ps`.
 *
 *  1. `up --detach` (auth default) brings up ALL THREE: nats-server, delivery daemon, manager —
 *     pid files written, processes alive, the delivery-aware marker bound to the manager pid.
 *  2. a real `cotal ps` is ANSWERED by the detached manager (control plane reachable, creds minted
 *     from this folder's auth — the exact "spawn --detach works right after up" promise).
 *  2b. a refresh whose delivery launch LOSES the single-flight lease exits non-zero and says so,
 *     instead of reporting a healthy control plane over a child that is already dead (#837).
 *  3. `cotal down` stops all three: pid files gone, processes dead, port closed.
 *  4. #1307: Ctrl-C on a FOREGROUND `up` follows the same sparing rule as bare `down`. One managed
 *     seat (a shim `claude` on PATH: a real core-dist endpoint that joins presence and stays alive)
 *     survives the SIGINT, the manager and broker are gone, the spared block is printed with the
 *     reap route, and the process exits within a bounded time.
 *
 * Sandboxes COTAL_HOME + a temp project root; tears down via `cotal down` + own-pid SIGTERM only —
 * never pkill, so a co-running broker on :4222 is untouched. Needs `nats-server` on PATH.
 * Run: pnpm smoke:up-stack:live
 */
import { spawn as spawnProc, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderDetachedSummary } from "../../implementations/cli/src/lib/up-report.js";
import { assertSmokeSandboxDown, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { DEFAULT_SPACE } from "@cotal-ai/core";
import { canonicalLocalProcessPath, DELIVERY_PIDFILE, MANAGER_DELIVERY_AWARE_MARKER, MANAGER_LOGFILE, MANAGER_PIDFILE, MANAGER_SPARE_CAPABILITY } from "@cotal-ai/workspace";

// Ephemeral OS-assigned port: no fixed-port collision across back-to-back / concurrent runs.
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const DEFAULT_SERVER = "nats://127.0.0.1:4222";
const WT = resolve(import.meta.dirname, "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");

const home = mkdtempSync(join(tmpdir(), "cotal-upstack-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-upstack-root-"));
const autoRoot = mkdtempSync(join(tmpdir(), "cotal-upstack-auto-"));
const occupantRoot = mkdtempSync(join(tmpdir(), "cotal-upstack-occupant-"));
const warningRoot = mkdtempSync(join(tmpdir(), "cotal-upstack-warning-"));
const fakeBin = mkdtempSync(join(tmpdir(), "cotal-upstack-bin-"));
const configDir = join(home, "xdg");
const anchors = new Map([
  [root, recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: configDir })],
  [autoRoot, recordSmokeSandbox({ root: autoRoot, cotalHome: home, xdgConfigHome: configDir })],
  [occupantRoot, recordSmokeSandbox({ root: occupantRoot, cotalHome: home, xdgConfigHome: configDir })],
  [warningRoot, recordSmokeSandbox({ root: warningRoot, cotalHome: home, xdgConfigHome: configDir })],
]);
const env = { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: configDir, COTAL_SKIP_CONNECTOR_SEED: "1" };

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const cliIn = (cwd: string, ...args: string[]) => {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchors.get(cwd), args, options);
  return spawnSync(TSX, [CLI, ...args], options);
};
const cliInEnv = (cwd: string, extraEnv: NodeJS.ProcessEnv, ...args: string[]) => {
  const options = { cwd, env: { ...env, ...extraEnv }, encoding: "utf8" as const, timeout: 120_000 };
  assertSmokeSandboxDown(anchors.get(cwd), args, options);
  return spawnSync(TSX, [CLI, ...args], options);
};
const cli = (...args: string[]) => cliIn(root, ...args);
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidOf = (file: string) => Number(readFileSync(join(root, ".cotal", file), "utf8").trim());
// The runtime records are per-space now, so their names come from the SHIPPED expansion rather than
// a literal. This suite ups without `--space`, which is the default space.
const record = (template: string) => canonicalLocalProcessPath(template, { root, space: DEFAULT_SPACE });
const recordName = (template: string) => record(template).slice(join(root, ".cotal").length + 1);
const portOpenAt = (port: number) =>
  new Promise<boolean>((res) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.setTimeout(400, () => { s.destroy(); res(false); });
  });
const portOpen = () => portOpenAt(PORT);

const pids: number[] = [];
let startedOccupant = false;
try {
  ok("detached summary omits unavailable mode-dependent components", renderDetachedSummary({
    pid: 42,
    delivery: false,
    authService: false,
    manager: false,
  }) === "✓ running in the background: nats-server (pid 42) - stop with: cotal down");
  ok("detached summary reports partial component availability independently", renderDetachedSummary({
    pid: 42,
    delivery: true,
    authService: false,
    manager: false,
  }) === "✓ running in the background: nats-server (pid 42), delivery daemon - stop with: cotal down");

  // Default-port collision: `up` without an explicit `--server` should allocate a free port and
  // record it, not fail with "use --server ...:<port>". If the developer already has a real :4222
  // broker, leave it alone; otherwise start a sandbox occupant and tear it down below.
  if (!(await portOpenAt(4222))) {
    const occupant = cliIn(occupantRoot, "up", "--detach", "--open");
    ok("default-port occupant starts for auto-port regression", occupant.status === 0, occupant.stdout + occupant.stderr);
    startedOccupant = true;
  }
  const auto = cliIn(autoRoot, "up", "--detach", "--open", "--space", "auto");
  ok("up --detach auto-selects a free port when :4222 is occupied", auto.status === 0, auto.stdout + auto.stderr);
  const autoEntry = JSON.parse(readFileSync(join(home, "meshes", "space.6175746f.json"), "utf8")) as { server: string };
  ok("auto-port mesh is not recorded on the default server", autoEntry.server !== DEFAULT_SERVER, autoEntry);
  ok("auto-port mesh broker is reachable", await portOpenAt(Number(new URL(autoEntry.server).port)), autoEntry);
  cliIn(autoRoot, "down");
  if (startedOccupant) cliIn(occupantRoot, "down");

  const fakeSystemctl = join(fakeBin, "systemctl");
  writeFileSync(fakeSystemctl, "#!/bin/sh\nprintf '%s\\n' 'Type=oneshot' 'RemainAfterExit=yes' 'Id=cotal-warning.service' 'InvocationID=warning-smoke'\n");
  chmodSync(fakeSystemctl, 0o755);
  const warned = cliInEnv(warningRoot, {
    INVOCATION_ID: "warning-smoke",
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
  }, "up", "--detach", "--open", "--space", "warning");
  const warnedOutput = plain(warned.stdout + warned.stderr);
  ok("up --detach keeps starting under the false-green unit shape", warned.status === 0, warnedOutput);
  ok("up --detach warns about the exact systemd unit", warnedOutput.includes("cotal-warning.service is Type=oneshot with RemainAfterExit=yes"), warnedOutput);
  ok("up --detach warning names the operator guide section", warnedOutput.includes("Supervising the detached stack"), warnedOutput);
  cliIn(warningRoot, "down");

  // 1) the full stack comes up from ONE command, JWT-authed by default.
  const up = cli("up", "--detach", "--server", SERVER);
  ok("up --detach exits 0", up.status === 0, up.stdout + up.stderr);
  ok(
    "auth up reports the exact running component set",
    /^✓ running in the background: nats-server \(pid \d+\), delivery daemon, manager - stop with: cotal down$/m.test(plain(up.stdout)),
    up.stdout,
  );
  ok("old generic background wording is absent", !/mesh running in the background/.test(up.stdout), up.stdout);
  for (const [file, label] of [["nats.pid", "nats-server"], [recordName(DELIVERY_PIDFILE), "delivery daemon"], [recordName(MANAGER_PIDFILE), "manager"]] as const) {
    const pid = pidOf(file);
    pids.push(pid);
    ok(`${label} is up (${file} + alive)`, Number.isFinite(pid) && alive(pid), pid);
  }
  ok("delivery-aware marker is bound to the manager pid", pidOf(recordName(MANAGER_DELIVERY_AWARE_MARKER)) === pidOf(recordName(MANAGER_PIDFILE)));
  ok("auth material was provisioned (.cotal/auth)", existsSync(join(root, ".cotal", "auth")));

  // 2) the manager ANSWERS a real `cotal ps` — no pre-arranged creds, resolved from the folder's
  //    auth + the sandboxed mesh registry, exactly as an operator would run it. Retried while the
  //    detached manager finishes booting (tsx compile + broker connect).
  let answered = false;
  let last = { stdout: "", stderr: "" };
  for (let i = 0; i < 15 && !answered; i++) {
    const r = cli("ps");
    last = { stdout: r.stdout, stderr: r.stderr };
    answered = r.status === 0 && /no managed agents/.test(r.stdout);
    if (!answered) await sleep(2000);
  }
  ok("cotal ps is answered by the detached manager", answered, last);

  // 2b) #837: a delivery launch that LOSES the single-flight lease is not a healthy control plane.
  //     Drop the pidfile - the operator-visible shape of a lost record - while the real daemon keeps
  //     running and keeps renewing its READY lease. The refresh sees no daemon, starts a second one,
  //     and that one loses the CAS and exits. `up` used to wait for ANY ready lease, find the FIRST
  //     daemon's, and report a healthy control plane over a child that was already dead.
  //     A LIVE holder rather than a SIGKILLed one's expiring record: the same code path, with no
  //     dependence on how much of the bucket TTL is left by the time the refresh reaches its CAS.
  const deliveryPidFile = record(DELIVERY_PIDFILE);
  const liveDelivery = readFileSync(deliveryPidFile, "utf8");
  const deliveryIdentityFile = `${deliveryPidFile}.identity`;
  const liveDeliveryIdentity = readFileSync(deliveryIdentityFile, "utf8");
  rmSync(deliveryPidFile);
  rmSync(deliveryIdentityFile);
  const lost = cli("up", "--server", SERVER);
  const lostOut = plain(lost.stdout + lost.stderr);
  ok("a refresh whose delivery launch loses the single-flight lease exits non-zero", lost.status !== 0, lostOut);
  ok("the refresh says the daemon it started exited without becoming ready", /exited without becoming ready/.test(lostOut), lostOut);
  ok("the daemon that HOLDS the lease is left running", alive(Number(liveDelivery.trim())), liveDelivery);
  // The losing launch overwrote the record with its own (dead) pid; put back the one `down` needs to
  // stop the daemon that is actually serving.
  writeFileSync(deliveryPidFile, liveDelivery);
  writeFileSync(deliveryIdentityFile, liveDeliveryIdentity);

  // 2c) #1417: a refresh under --no-manager of a space whose manager is LIVE refuses rather than
  //     silently keeping or stopping it, naming the exact `cotal down manager` remedy the same way
  //     --runtime and --max-sessions refuse on a live manager.
  const refused = cli("up", "--server", SERVER, "--no-manager");
  const refusedOut = plain(refused.stdout + refused.stderr);
  ok("a --no-manager refresh against a live manager exits non-zero", refused.status !== 0, refusedOut);
  ok("the refusal names the `cotal down manager` remedy", /`cotal down manager` first, then `cotal up --no-manager`/.test(refusedOut), refusedOut);
  ok("the manager the refresh refused to touch is left running", alive(pidOf(recordName(MANAGER_PIDFILE))), recordName(MANAGER_PIDFILE));

  // 3) down stops the whole stack, symmetric with up. Poll: the SIGTERM'd manager/daemon shut
  //    down gracefully, which can take a few seconds on slow CI.
  const down = cli("down");
  ok("down exits 0", down.status === 0, down.stdout + down.stderr);
  let dead = false;
  for (let i = 0; i < 24 && !dead; i++) {
    await sleep(500);
    dead = pids.every((p) => !alive(p)) && !(await portOpen());
  }
  ok("all pid files removed by down", [join(root, ".cotal", "nats.pid"), record(DELIVERY_PIDFILE), record(MANAGER_PIDFILE)].every((f) => !existsSync(f)));
  ok("all three processes are dead + broker port closed", dead, pids.filter(alive));

  // Open mode in the SAME root retains static-auth files from the prior boot. Reporting follows the
  // effective live mode, not stale on-disk auth material: broker + manager, never delivery/auth-service.
  ok("static auth material remains before the open-mode reporting check", existsSync(join(root, ".cotal", "auth")));
  const open = cli("up", "--detach", "--open", "--server", SERVER);
  ok("open up --detach exits 0", open.status === 0, open.stdout + open.stderr);
  ok(
    "open up reports the exact running component set",
    /^✓ running in the background: nats-server \(pid \d+\), manager - stop with: cotal down$/m.test(plain(open.stdout)),
    open.stdout,
  );
  ok("open summary omits auth-only components", !/running in the background:.*(?:delivery daemon|user-auth service)/.test(open.stdout), open.stdout);
  const openDown = cli("down");
  ok("open down exits 0", openDown.status === 0, openDown.stdout + openDown.stderr);

  // 4) #1417 broker-only boot: `up --detach --no-manager` starts broker + delivery daemon (auth
  //    mode) and NO manager — no manager pidfile, no manager process, no stale slot to leave —
  //    while the broker and the delivery daemon answer; `down` then stops what actually ran.
  const brokerOnly = cli("up", "--detach", "--no-manager", "--server", SERVER);
  const brokerOnlyOut = plain(brokerOnly.stdout);
  ok("broker-only up --detach exits 0", brokerOnly.status === 0, brokerOnly.stdout + brokerOnly.stderr);
  ok(
    "broker-only up reports the exact running component set (no manager)",
    /^✓ running in the background: nats-server \(pid \d+\), delivery daemon - stop with: cotal down$/m.test(brokerOnlyOut),
    brokerOnly.stdout,
  );
  ok("broker-only boot writes no manager pidfile", !existsSync(record(MANAGER_PIDFILE)), record(MANAGER_PIDFILE));
  ok("broker-only boot writes no delivery-aware marker", !existsSync(record(MANAGER_DELIVERY_AWARE_MARKER)), record(MANAGER_DELIVERY_AWARE_MARKER));
  const boDeliveryPid = pidOf(recordName(DELIVERY_PIDFILE));
  pids.push(boDeliveryPid);
  ok("the delivery daemon is up and alive under the flag", Number.isFinite(boDeliveryPid) && alive(boDeliveryPid), boDeliveryPid);
  ok("the broker still answers under the flag", await portOpen());
  const brokerOnlyDown = cli("down");
  ok("broker-only down exits 0", brokerOnlyDown.status === 0, brokerOnlyDown.stdout + brokerOnlyDown.stderr);
  let boDead = false;
  for (let i = 0; i < 24 && !boDead; i++) {
    await sleep(500);
    boDead = !alive(boDeliveryPid) && !(await portOpen());
  }
  ok("broker-only down stops broker + delivery daemon", boDead, { boDeliveryPid });
  ok("broker-only down leaves no manager pidfile behind", !existsSync(record(MANAGER_PIDFILE)));

  // 4) #1307: Ctrl-C on a FOREGROUND up spares and reports the managed seat, exactly like bare
  //    down. The seat is a shim `claude` first on PATH (the manager resolves requires:["claude"]
  //    at boot): a real core-dist endpoint that joins presence under the manager-minted creds, so
  //    the detached spawn resolves readiness and ps lists it. Its env names ride the documented
  //    spawn.env allow-list (the seat env is otherwise stripped to the fixed OS boundary).
  const fgPort = await freePort();
  const fgServer = `nats://127.0.0.1:${fgPort}`;
  const fgBin = mkdtempSync(join(tmpdir(), "cotal-upstack-fgbin-"));
  const fgOut = mkdtempSync(join(tmpdir(), "cotal-upstack-fgout-"));
  const fgRoot = mkdtempSync(join(tmpdir(), "cotal-upstack-fgroot-"));
  anchors.set(fgRoot, recordSmokeSandbox({ root: fgRoot, cotalHome: home, xdgConfigHome: configDir }));
  const fgSeatPidFile = join(fgOut, "seat.pid");
  const coreDist = resolve(WT, "packages", "core", "dist", "index.js");
  const shimBody = join(fgOut, "claude-shim-body.js");
  // A REAL mesh endpoint as the seat: presence join is what makes the detached spawn's readiness
  // resolve (a bare keepalive rides the 30s backstop into an uncertain non-success).
  writeFileSync(shimBody, [
    "const fs=require('node:fs');const {pathToFileURL}=require('node:url');",
    "const p=process.env.COTAL_LAUNCH_MATERIAL;",
    "let m={};try{m=JSON.parse(fs.readFileSync(p,'utf8'))}catch{}",
    "fs.writeFileSync(process.env.PIDFILE,String(process.pid));",
    "import(pathToFileURL(process.env.CORE_DIST).href).then(async({CotalEndpoint})=>{",
    "const ep=new CotalEndpoint({space:process.env.COTAL_SPACE,servers:m.servers,",
    "creds:m.creds?fs.readFileSync(m.creds,'utf8'):undefined,",
    "lifecycleUid:process.env.COTAL_LIFECYCLE_UID||undefined,channels:[],consume:false,",
    "registerPresence:true,watchPresence:false,",
    "card:{id:process.env.COTAL_ID||undefined,name:process.env.COTAL_NAME,kind:'agent'}});",
    "ep.on('error',()=>{});await ep.start();setInterval(()=>{},1000);});",
  ].join(""));
  writeFileSync(join(fgBin, "claude"), "#!/usr/bin/env node\nrequire(process.env.SHIM_BODY);\n");
  chmodSync(join(fgBin, "claude"), 0o755);
  mkdirSync(join(fgRoot, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(fgRoot, ".cotal", "agents", "seat.md"), "---\nname: seat\nrole: worker\nsubscribe: []\nallowPublish: []\n---\nA supervised seat that exists to be spared.\n");
  writeFileSync(join(fgRoot, ".cotal", "config.json"), JSON.stringify({ spawn: { env: ["CORE_DIST", "PIDFILE", "SHIM_BODY"] } }));
  const fgEnv = {
    ...env, PATH: `${fgBin}:${process.env.PATH ?? ""}`,
    CORE_DIST: coreDist, PIDFILE: fgSeatPidFile, SHIM_BODY: shimBody,
  };
  let fgUp: ChildProcess | undefined;
  let fgSeatPid: number | undefined;
  let fgManagerPid: number | undefined;
  try {
    // The manager's spawn rail needs a connector inventory: seed the built-ins into this sandbox
    // config (the documented checkout opt-in), or boot reports "no connector available" and the
    // detached spawn finds no responder on the class rail.
    cliInEnv(fgRoot, { ...fgEnv, COTAL_ALLOW_CHECKOUT_SEED: "1" }, "ext", "seed", "--repair");
    fgUp = spawnProc(TSX, [CLI, "up", "--server", fgServer], { cwd: fgRoot, env: fgEnv, stdio: ["ignore", "pipe", "pipe"] });
    let fgOutText = "";
    fgUp.stdout?.on("data", (b: Buffer) => void (fgOutText += b.toString()));
    fgUp.stderr?.on("data", (b: Buffer) => void (fgOutText += b.toString()));
    const fgRecord = (template: string) => canonicalLocalProcessPath(template, { root: fgRoot, space: DEFAULT_SPACE });
    let managerUpSeen = false;
    for (let i = 0; i < 60 && !managerUpSeen; i++) {
      await sleep(1000);
      try { managerUpSeen = /✓ manager up/.test(readFileSync(fgRecord(MANAGER_LOGFILE), "utf8")); } catch { /* not yet */ }
    }
    ok("foreground up reached manager up (manager log)", managerUpSeen);
    fgManagerPid = Number(readFileSync(fgRecord(MANAGER_PIDFILE), "utf8").trim());
    ok("foreground manager is a live process", Number.isFinite(fgManagerPid) && alive(fgManagerPid), fgManagerPid);
    const spawnSeat = cliInEnv(fgRoot, fgEnv, "spawn", "seat", "--detach", "--no-events", "--name", "bard");
    ok("detached spawn of the shim seat succeeds", spawnSeat.status === 0 && /spawned .*bard/.test(plain(spawnSeat.stdout)), spawnSeat.stdout + spawnSeat.stderr);
    for (let i = 0; i < 50 && fgSeatPid === undefined; i++) {
      try { fgSeatPid = Number(readFileSync(fgSeatPidFile, "utf8").trim()) || undefined; } catch { /* not yet */ }
      if (fgSeatPid === undefined) await sleep(200);
    }
    ok("the seat is a live OS process", fgSeatPid !== undefined && alive(fgSeatPid), fgSeatPid);
    const fgPs = cliInEnv(fgRoot, fgEnv, "ps");
    ok("cotal ps lists the managed seat", /bard/.test(plain(fgPs.stdout)), fgPs.stdout + fgPs.stderr);

    // Ctrl-C. Bounded wait: the handler must finish its awaited teardown and end the process.
    fgUp.kill("SIGINT");
    const fgExited = await new Promise<boolean>((res) => {
      const timer = setTimeout(() => res(false), 45_000);
      fgUp?.once("exit", () => { clearTimeout(timer); res(true); });
    });
    ok("foreground up exits within a bounded time after SIGINT", fgExited);
    for (let i = 0; i < 20 && alive(fgManagerPid); i++) await sleep(500);
    ok("the manager is gone after Ctrl-C", !alive(fgManagerPid), fgManagerPid);
    ok("the broker is gone after Ctrl-C", !(await portOpenAt(fgPort)));
    ok("the seat SURVIVES the Ctrl-C teardown", fgSeatPid !== undefined && alive(fgSeatPid), fgSeatPid);
    ok("the spared report names the seat and the reap route",
      /left 1 managed agent running \(no longer managed\):/.test(plain(fgOutText)) &&
      /bard/.test(plain(fgOutText)) &&
      /to stop managed agents with the stack: cotal down --with-agents/.test(plain(fgOutText)),
      fgOutText);
  } finally {
    if (fgUp && alive(fgUp.pid ?? 0)) { try { fgUp.kill("SIGKILL"); } catch { /* gone */ } }
    if (fgSeatPid !== undefined && alive(fgSeatPid)) { try { process.kill(fgSeatPid, "SIGKILL"); } catch { /* gone */ } }
    cliIn(fgRoot, "down", "--with-agents");
    rmSync(fgBin, { recursive: true, force: true });
    rmSync(fgOut, { recursive: true, force: true });
    rmSync(fgRoot, { recursive: true, force: true });
  }

  // 4b) #1307 round 2: the spare-capability assert is the SIGNAL GATE. With the capability file
  //     removed (the shape of a manager that cannot prove it can detach), Ctrl-C must print the
  //     bare-stop refusal with the reap route, signal NOTHING (manager and broker stay alive, no
  //     spared report), release the latch, and leave the stack running; `cotal down --with-agents`
  //     from "another terminal" ends the run. The broker-exit handler then ends the up process.
  const rgPort = await freePort();
  const rgBin = mkdtempSync(join(tmpdir(), "cotal-upstack-rgbin-"));
  const rgOut = mkdtempSync(join(tmpdir(), "cotal-upstack-rgout-"));
  const rgRoot = mkdtempSync(join(tmpdir(), "cotal-upstack-rgroot-"));
  anchors.set(rgRoot, recordSmokeSandbox({ root: rgRoot, cotalHome: home, xdgConfigHome: configDir }));
  const rgEnv = {
    ...env, PATH: `${rgBin}:${process.env.PATH ?? ""}`,
    CORE_DIST: coreDist, PIDFILE: join(rgOut, "seat.pid"), SHIM_BODY: shimBody,
  };
  let rgUp: ChildProcess | undefined;
  try {
    cliInEnv(rgRoot, { ...rgEnv, COTAL_ALLOW_CHECKOUT_SEED: "1" }, "ext", "seed", "--repair");
    rgUp = spawnProc(TSX, [CLI, "up", "--server", `nats://127.0.0.1:${rgPort}`], { cwd: rgRoot, env: rgEnv, stdio: ["ignore", "pipe", "pipe"] });
    let rgOutText = "";
    rgUp.stdout?.on("data", (b: Buffer) => void (rgOutText += b.toString()));
    rgUp.stderr?.on("data", (b: Buffer) => void (rgOutText += b.toString()));
    const rgRecord = (template: string) => canonicalLocalProcessPath(template, { root: rgRoot, space: DEFAULT_SPACE });
    let rgManagerUp = false;
    for (let i = 0; i < 60 && !rgManagerUp; i++) {
      await sleep(1000);
      try { rgManagerUp = /✓ manager up/.test(readFileSync(rgRecord(MANAGER_LOGFILE), "utf8")); } catch { /* not yet */ }
    }
    ok("refusal rig: foreground up reached manager up", rgManagerUp);
    const rgManagerPid = Number(readFileSync(rgRecord(MANAGER_PIDFILE), "utf8").trim());
    // The shape under test: a pinned manager whose spare capability is NOT proven.
    rmSync(rgRecord(MANAGER_SPARE_CAPABILITY), { force: true });
    rgUp.kill("SIGINT");
    // The refusal path must return quickly; give the would-be teardown a moment to betray itself.
    await sleep(3000);
    ok("the refusal gate leaves the manager and broker running",
      alive(rgManagerPid) && (await portOpenAt(rgPort)) && rgUp !== undefined && alive(rgUp.pid ?? 0),
      { manager: rgManagerPid, managerAlive: alive(rgManagerPid), upAlive: rgUp ? alive(rgUp.pid ?? 0) : false });
    ok("the refusal names the bare-stop rule and the reap route",
      /refusing bare manager stop/.test(plain(rgOutText)) &&
      /cotal down --with-agents/.test(plain(rgOutText)),
      rgOutText);
    ok("no spared report is printed on the refusal path", !/left \d+ managed agent/.test(plain(rgOutText)), rgOutText);
    // The operator's route ends the run: down --with-agents, then up exits via the broker-exit path.
    cliInEnv(rgRoot, rgEnv, "down", "--with-agents");
    const rgExited = await new Promise<boolean>((res) => {
      const timer = setTimeout(() => res(false), 45_000);
      rgUp?.once("exit", () => { clearTimeout(timer); res(true); });
    });
    ok("up exits after the operator's cotal down --with-agents", rgExited);
    for (let i = 0; i < 20 && alive(rgManagerPid); i++) await sleep(500);
    ok("the refusal rig's manager is gone after down --with-agents", !alive(rgManagerPid), rgManagerPid);
  } finally {
    if (rgUp && alive(rgUp.pid ?? 0)) { try { rgUp.kill("SIGKILL"); } catch { /* gone */ } }
    cliIn(rgRoot, "down", "--with-agents");
    rmSync(rgBin, { recursive: true, force: true });
    rmSync(rgOut, { recursive: true, force: true });
    rmSync(rgRoot, { recursive: true, force: true });
  }

  console.log(`\nUP-STACK LIVE SMOKE OK ✅ (${pass} checks)`);
} finally {
  cliIn(root, "down");
  cliIn(autoRoot, "down");
  if (startedOccupant) cliIn(occupantRoot, "down");
  cliIn(warningRoot, "down");
  for (const p of pids) if (alive(p)) { try { process.kill(p, "SIGTERM"); } catch { /* gone */ } }
  rmSync(home, { recursive: true, force: true });
  for (const d of [root, autoRoot, occupantRoot, warningRoot, fakeBin]) rmSync(d, { recursive: true, force: true });
}
