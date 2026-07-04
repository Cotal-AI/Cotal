/**
 * LIVE e2e for `cotal up --detach` — the stage-2b claim the docs make ("start the mesh + delivery
 * daemon + manager") exercised as REAL usage: the actual binary as subprocesses, a real JWT-authed
 * broker on an isolated port, and the control plane answering a real `cotal ps`.
 *
 *  1. `up --detach` (auth default) brings up ALL THREE: nats-server, delivery daemon, manager —
 *     pid files written, processes alive, the delivery-aware marker bound to the manager pid.
 *  2. a real `cotal ps` is ANSWERED by the detached manager (control plane reachable, creds minted
 *     from this folder's auth — the exact "spawn --detach works right after up" promise).
 *  3. `cotal down` stops all three: pid files gone, processes dead, port closed.
 *
 * Sandboxes COTAL_HOME + a temp project root; tears down via `cotal down` + own-pid SIGTERM only —
 * never pkill, so a co-running broker on :4222 is untouched. Needs `nats-server` on PATH.
 * Run: pnpm smoke:up-stack:live
 */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 14341; // unique across the live smokes (no back-to-back port collision)
const SERVER = `nats://127.0.0.1:${PORT}`;
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

const pids: number[] = [];
let startedOccupant = false;
try {
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
  const autoEntry = JSON.parse(readFileSync(join(home, "meshes", `${encodeURIComponent("auto")}.json`), "utf8")) as { server: string };
  ok("auto-port mesh is not recorded on the default server", autoEntry.server !== DEFAULT_SERVER, autoEntry);
  ok("auto-port mesh broker is reachable", await portOpenAt(Number(new URL(autoEntry.server).port)), autoEntry);
  cliIn(autoRoot, "down");
  if (startedOccupant) cliIn(occupantRoot, "down");

  // 1) the full stack comes up from ONE command, JWT-authed by default.
  const up = cli("up", "--detach", "--server", SERVER);
  ok("up --detach exits 0", up.status === 0, up.stdout + up.stderr);
  ok("up --detach reports the background mesh", /mesh running in the background/.test(up.stdout), up.stdout);
  for (const [file, label] of [["nats.pid", "nats-server"], ["delivery.pid", "delivery daemon"], ["manager.pid", "manager"]] as const) {
    const pid = pidOf(file);
    pids.push(pid);
    ok(`${label} is up (${file} + alive)`, Number.isFinite(pid) && alive(pid), pid);
  }
  ok("delivery-aware marker is bound to the manager pid", pidOf("manager.delivery-aware") === pidOf("manager.pid"));
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

  console.log(`\nUP-STACK LIVE SMOKE OK ✅ (${pass} checks)`);
} finally {
  spawnSync(TSX, [CLI, "down"], { cwd: root, env, encoding: "utf8" });
  spawnSync(TSX, [CLI, "down"], { cwd: autoRoot, env, encoding: "utf8" });
  if (startedOccupant) spawnSync(TSX, [CLI, "down"], { cwd: occupantRoot, env, encoding: "utf8" });
  for (const p of pids) if (alive(p)) { try { process.kill(p, "SIGTERM"); } catch { /* gone */ } }
  rmSync(home, { recursive: true, force: true });
  for (const d of [root, autoRoot, occupantRoot]) rmSync(d, { recursive: true, force: true });
}
