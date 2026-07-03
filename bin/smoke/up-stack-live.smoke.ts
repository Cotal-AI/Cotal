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
const WT = resolve(import.meta.dirname, "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");

const home = mkdtempSync(join(tmpdir(), "cotal-upstack-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-upstack-root-"));
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
const portOpen = () =>
  new Promise<boolean>((res) => {
    const s = createConnection({ host: "127.0.0.1", port: PORT }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.setTimeout(400, () => { s.destroy(); res(false); });
  });

const pids: number[] = [];
try {
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

  // 3) down stops the whole stack, symmetric with up.
  const down = cli("down");
  ok("down exits 0", down.status === 0, down.stdout + down.stderr);
  await sleep(1200);
  ok("all pid files removed by down", (["nats.pid", "delivery.pid", "manager.pid"] as const).every((f) => !existsSync(join(root, ".cotal", f))));
  ok("all three processes are dead", pids.every((p) => !alive(p)), pids);
  ok("broker port is closed", !(await portOpen()));

  console.log(`\nUP-STACK LIVE SMOKE OK ✅ (${pass} checks)`);
} finally {
  spawnSync(TSX, [CLI, "down"], { cwd: root, env, encoding: "utf8" });
  for (const p of pids) if (alive(p)) { try { process.kill(p, "SIGTERM"); } catch { /* gone */ } }
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
