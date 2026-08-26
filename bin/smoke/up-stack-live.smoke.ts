/**
 * LIVE e2e for detached-by-default `cotal up` — the stage-2b claim the docs make ("start the mesh + delivery
 * daemon + manager") exercised as REAL usage: the actual binary as subprocesses, a real JWT-authed
 * broker on an isolated port, and the control plane answering a real `cotal ps`.
 *
 *  1. bare `up` (auth default) exits while bringing up ALL THREE: nats-server, delivery daemon, manager —
 *     pid files written, processes alive, the delivery-aware marker bound to the manager pid.
 *  2. a real `cotal ps` is ANSWERED by the detached manager (control plane reachable, creds minted
 *     from this folder's auth — the exact "spawn --detach works right after up" promise).
 *  2b. a refresh whose delivery launch LOSES the single-flight lease exits non-zero and says so,
 *     instead of reporting a healthy control plane over a child that is already dead (#837).
 *  3. `cotal down` stops all three: pid files gone, processes dead, port closed.
 *
 * Sandboxes COTAL_HOME + a temp project root; tears down via `cotal down` + own-pid SIGTERM only —
 * never pkill, so a co-running broker on :4222 is untouched. Needs `nats-server` on PATH.
 * Run: pnpm smoke:up-stack:live
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderDetachedSummary } from "../../implementations/cli/src/lib/up-report.js";

// Ephemeral OS-assigned port: no fixed-port collision across back-to-back / concurrent runs.
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "up-stack-live";
const DEFAULT_SERVER = "nats://127.0.0.1:4222";
const WT = resolve(import.meta.dirname, "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");

const home = mkdtempSync(join(tmpdir(), "cotal-upstack-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-upstack-root-"));
const autoRoot = mkdtempSync(join(tmpdir(), "cotal-upstack-auto-"));
const occupantRoot = mkdtempSync(join(tmpdir(), "cotal-upstack-occupant-"));
const env = { ...process.env, COTAL_HOME: home };

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const cli = (...args: string[]) => spawnSync(TSX, [CLI, ...args], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
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
const portOpenAt = (port: number) =>
  new Promise<boolean>((res) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.setTimeout(400, () => { s.destroy(); res(false); });
  });
const portOpen = () => portOpenAt(PORT);
const cliIn = (cwd: string, ...args: string[]) => spawnSync(TSX, [CLI, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
const matchingPids = () => {
  if (process.platform === "win32") {
    const out = execFileSync("wmic", ["process", "get", "ProcessId,CommandLine", "/format:csv"], { encoding: "utf8" });
    return out.split(/\r?\n/).filter((line) => line.includes(root) || line.includes(autoRoot) || line.includes(occupantRoot))
      .map((line) => Number(line.trim().split(",").at(-1))).filter(Number.isFinite);
  }
  const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return out.split("\n").filter((line) => line.includes(root) || line.includes(autoRoot) || line.includes(occupantRoot))
    .map((line) => Number(/^\s*(\d+)/.exec(line)?.[1])).filter(Number.isFinite);
};

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

  // Named cells for the #864 mutations must be the FIRST record/detach-dependent checks. An earlier
  // `readFileSync` of a mesh record throws ENOENT (WRONG-RED) if persist is skipped, and a status-only
  // detach cell stays green when spawnSync SIGTERM's a foreground `up` whose exit handler still exits 0.
  // 1) the full stack comes up from ONE command, JWT-authed by default.
  const recPath = join(home, "meshes", `space.${Buffer.from(SPACE).toString("hex")}.json`);
  const up = cli("up", "--space", SPACE, "--server", SERVER);
  const recorded = existsSync(recPath)
    ? JSON.parse(readFileSync(recPath, "utf8")) as { origin?: string; root?: string }
    : undefined;
  ok(
    "up persists a self-hosted mesh record at provision time",
    recorded?.origin === "self-hosted" && recorded.root !== undefined && realpathSync(recorded.root) === realpathSync(root),
    recorded ?? recPath,
  );
  ok(
    "bare up exits 0 while the stack remains alive (detached by default)",
    up.status === 0
      && /running in the background: nats-server \(pid \d+\)/.test(plain(up.stdout))
      && !/Press Ctrl-C to stop/.test(plain(up.stdout + up.stderr)),
    up.stdout + up.stderr,
  );
  ok(
    "auth up reports the exact running component set",
    /^✓ running in the background: nats-server \(pid \d+\), delivery daemon, manager - stop with: cotal down$/m.test(plain(up.stdout)),
    up.stdout,
  );
  ok("old generic background wording is absent", !/mesh running in the background/.test(up.stdout), up.stdout);
  for (const [file, label] of [["nats.pid", "nats-server"], ["delivery.pid", "delivery daemon"], ["manager.pid", "manager"]] as const) {
    const pid = pidOf(file);
    pids.push(pid);
    ok(`${label} is up (${file} + alive)`, Number.isFinite(pid) && alive(pid), pid);
  }
  ok("delivery-aware marker is bound to the manager pid", pidOf("manager.delivery-aware") === pidOf("manager.pid"));
  ok("auth material was provisioned (.cotal/auth)", existsSync(join(root, ".cotal", "auth")));
  // After spawnSync returns, the invoker is gone. If the stack were still that process's children,
  // they would be dead. Also pin parentage: a detached nats-server is not a child of this suite.
  const natsPid = pidOf("nats.pid");
  if (process.platform === "win32") {
    const csv = execFileSync("wmic", ["process", "where", `ProcessId=${natsPid}`, "get", "ParentProcessId", "/format:csv"], { encoding: "utf8" });
    const ppid = Number(csv.trim().split(/\r?\n/).at(-1)?.split(",").at(-1));
    ok("detached nats-server is not a child of this suite", Number.isFinite(ppid) && ppid !== process.pid, { natsPid, ppid, suite: process.pid });
  } else {
    const ppid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(natsPid)], { encoding: "utf8" }).trim());
    ok("detached nats-server is not a child of this suite", Number.isFinite(ppid) && ppid !== process.pid, { natsPid, ppid, suite: process.pid });
  }

  // Default-port collision: `up` without an explicit `--server` should allocate a free port and
  // record it, not fail with "use --server ...:<port>". After the named persist/detach cells so a
  // skipped record cannot throw ENOENT here and grade WRONG-RED. If the developer already has a
  // real :4222 broker, leave it alone; otherwise start a sandbox occupant and tear it down below.
  if (!(await portOpenAt(4222))) {
    const occupant = cliIn(occupantRoot, "up", "--detach", "--open");
    ok("default-port occupant starts for auto-port regression", occupant.status === 0, occupant.stdout + occupant.stderr);
    startedOccupant = true;
  }
  const auto = cliIn(autoRoot, "up", "--detach", "--open", "--space", "auto");
  ok("up --detach auto-selects a free port when :4222 is occupied", auto.status === 0, auto.stdout + auto.stderr);
  const autoRecPath = join(home, "meshes", "space.6175746f.json");
  const autoEntry = existsSync(autoRecPath)
    ? JSON.parse(readFileSync(autoRecPath, "utf8")) as { server: string }
    : undefined;
  ok("auto-port mesh is not recorded on the default server", autoEntry !== undefined && autoEntry.server !== DEFAULT_SERVER, autoEntry ?? autoRecPath);
  ok("auto-port mesh broker is reachable", autoEntry !== undefined && await portOpenAt(Number(new URL(autoEntry.server).port)), autoEntry);
  cliIn(autoRoot, "down");
  if (startedOccupant) cliIn(occupantRoot, "down");

  // 2) the manager ANSWERS a real `cotal ps` — no pre-arranged creds, resolved from the folder's
  //    auth + the sandboxed mesh registry, exactly as an operator would run it. Retried while the
  //    detached manager finishes booting (tsx compile + broker connect).
  let answered = false;
  let last = { stdout: "", stderr: "" };
  for (let i = 0; i < 15 && !answered; i++) {
    const r = cli("ps", "--space", SPACE);
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
  const deliveryPidFile = join(root, ".cotal", "delivery.pid");
  const liveDelivery = readFileSync(deliveryPidFile, "utf8");
  rmSync(deliveryPidFile);
  const lost = cli("up", "--space", SPACE, "--server", SERVER);
  const lostOut = plain(lost.stdout + lost.stderr);
  ok("a refresh whose delivery launch loses the single-flight lease exits non-zero", lost.status !== 0, lostOut);
  ok("the refresh says the daemon it started exited without becoming ready", /exited without becoming ready/.test(lostOut), lostOut);
  ok("the daemon that HOLDS the lease is left running", alive(Number(liveDelivery.trim())), liveDelivery);
  // The losing launch overwrote the record with its own (dead) pid; put back the one `down` needs to
  // stop the daemon that is actually serving.
  writeFileSync(deliveryPidFile, liveDelivery);

  // 3) down stops the whole stack, symmetric with up. Poll: the SIGTERM'd manager/daemon shut
  //    down gracefully, which can take a few seconds on slow CI.
  const down = cli("down");
  ok("down exits 0", down.status === 0, down.stdout + down.stderr);
  let dead = false;
  for (let i = 0; i < 24 && !dead; i++) {
    await sleep(500);
    dead = pids.every((p) => !alive(p)) && !(await portOpen());
  }
  ok("all pid files removed by down", (["nats.pid", "delivery.pid", "manager.pid"] as const).every((f) => !existsSync(join(root, ".cotal", f))));
  ok("all three processes are dead + broker port closed", dead, pids.filter(alive));
  const offlineList = cli("meshes");
  ok("a stopped self-hosted mesh remains listed offline", offlineList.status === 0 && new RegExp(`${SPACE}.*self-hosted.*offline`).test(plain(offlineList.stdout)), offlineList.stdout + offlineList.stderr);
  const offlineUse = cli("ps", "--space", SPACE);
  ok("dead self-hosted target names its root and restart command", offlineUse.status !== 0 && plain(offlineUse.stdout + offlineUse.stderr).includes(`mesh "${SPACE}" is recorded at ${realpathSync(root)} but not running - run \`cotal up\` there to restart`), offlineUse.stdout + offlineUse.stderr);

  // Open mode in the SAME root retains static-auth files from the prior boot. Reporting follows the
  // effective live mode, not stale on-disk auth material: broker + manager, never delivery/auth-service.
  ok("static auth material remains before the open-mode reporting check", existsSync(join(root, ".cotal", "auth")));
  const open = cli("up", "--open", "--space", SPACE, "--server", SERVER);
  ok("open bare up exits 0", open.status === 0, open.stdout + open.stderr);
  ok(
    "open up reports the exact running component set",
    /^✓ running in the background: nats-server \(pid \d+\), manager - stop with: cotal down$/m.test(plain(open.stdout)),
    open.stdout,
  );
  ok("open summary omits auth-only components", !/running in the background:.*(?:delivery daemon|user-auth service)/.test(open.stdout), open.stdout);
  const openDown = cli("down");
  ok("open down exits 0", openDown.status === 0, openDown.stdout + openDown.stderr);

  console.log(`\nUP-STACK LIVE SMOKE OK ✅ (${pass} checks)`);
} finally {
  spawnSync(TSX, [CLI, "down"], { cwd: root, env, encoding: "utf8" });
  spawnSync(TSX, [CLI, "down"], { cwd: autoRoot, env, encoding: "utf8" });
  if (startedOccupant) spawnSync(TSX, [CLI, "down"], { cwd: occupantRoot, env, encoding: "utf8" });
  for (const p of pids) if (alive(p)) { try { process.kill(p, "SIGTERM"); } catch { /* gone */ } }
  for (const p of matchingPids()) { try { process.kill(p, "SIGTERM"); } catch { /* gone */ } }
  await sleep(500);
  const survivors = matchingPids();
  if (survivors.length > 0) throw new Error(`FAIL: up-stack teardown left matching processes — ${survivors.join(", ")}`);
  rmSync(home, { recursive: true, force: true });
  for (const d of [root, autoRoot, occupantRoot]) rmSync(d, { recursive: true, force: true });
}
