/**
 * LIVE e2e for `cotal up -f <manifest>` — the orchestration the hermetic manifest smoke can't reach:
 * a REAL fresh broker on an isolated port, channels seeded from the manifest, exactly ONE manager
 * (carrying the launch spec — a second supervise would race the singleton lease), the
 * refuse-on-reachable redirect to `spawn -f`, and `cotal down` teardown + transient-run cleanup.
 *
 * Open-mode manifest (no auth) so the registry is readable without minting creds. Channels-only
 * (agents: {}) so no real connector boots. Sandboxes COTAL_HOME + a temp project root; tears down via
 * `cotal down` and a port check — never pkill, so a co-running broker on :4222 is untouched.
 * Needs `nats-server` on PATH. Run: pnpm smoke:up-manifest:live
 */
import { spawnSync } from "node:child_process";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Ephemeral free ports + a per-run space: repeated or concurrent runs never collide on a fixed port
// nor contaminate each other's `supervise` scan (the old fixed 14311 / "upf-live" flaked locally).
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
const PORT = await freePort();
const DECOY_PORT = await freePort(); // the manifest declares this; --server overrides it to PORT
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = `upf-live-${process.pid}`;
const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");

const home = mkdtempSync(join(tmpdir(), "cotal-upf-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-upf-root-"));
const env = { ...process.env, COTAL_HOME: home };

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const cli = (...args: string[]) => spawnSync(TSX, [CLI, ...args], { cwd: root, env, encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port: number) =>
  new Promise<boolean>((res) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.setTimeout(400, () => { s.destroy(); res(false); });
  });

function down(): void {
  spawnSync(TSX, [CLI, "down"], { cwd: root, env, encoding: "utf8" });
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Command lines of every live `supervise` for OUR space (never other meshes' managers). */
const supervisors = () =>
  spawnSync("ps", ["ax", "-o", "command="], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((l) => l.includes(" supervise ") && l.includes(`--space ${SPACE}`));

const manifest = join(root, "mesh.yaml");
writeFileSync(
  manifest,
  `apiVersion: cotal/v1
kind: Mesh
space: ${SPACE}
agent: claude
broker: { servers: "nats://127.0.0.1:${DECOY_PORT}", auth: false }
channels:
  general: { description: Open coordination. }
  decisions: { description: The durable record. }
`,
);

let mgrPid = NaN;
try {
  // 1) fresh up -f with a --server OVERRIDE (the manifest declares the decoy port; the flag wins).
  const up = cli("up", "-f", manifest, "--server", SERVER);
  ok("up -f reports the mesh is up", up.stdout.includes(`mesh "${SPACE}" up`), up.stdout + up.stderr);
  ok("up -f reports seeded channels", /seeded 2 channel/.test(up.stdout), up.stdout);
  // Regression guard (checked BEFORE any settle sleep, while a lease-race loser would still be
  // alive): the launch rides THE one control-plane manager — two supervises here means the plain
  // manager and the launch manager are racing the singleton lease, so the agents' boot is a coin flip.
  ok("exactly ONE supervise was started for the space", supervisors().length === 1, supervisors());
  await sleep(1500);
  ok("broker bound the --server OVERRIDE port (not the manifest's)", await portOpen(PORT));
  ok("manifest's declared port was NOT used (override won)", !(await portOpen(DECOY_PORT)));
  mgrPid = Number(readFileSync(join(root, ".cotal", "manager.pid"), "utf8").trim());
  ok("the recorded manager is alive (not a lease-race loser)", Number.isFinite(mgrPid) && alive(mgrPid), mgrPid);
  const mgrCmd = spawnSync("ps", ["-p", String(mgrPid), "-o", "command="], { encoding: "utf8" }).stdout;
  ok("the recorded manager carries the launch spec", /--launch\b/.test(mgrCmd), mgrCmd);

  // 2) channels were really seeded into the registry (open mode → readable without creds).
  const { readChannelRegistry } = await import("@cotal-ai/core");
  const reg = await readChannelRegistry({ servers: SERVER, space: SPACE });
  ok("#general seeded with its description", reg.channels?.general?.description === "Open coordination.", reg.channels);
  ok("#decisions seeded", Boolean(reg.channels?.decisions), reg.channels);

  // 3) the launch spec was written 0600 under .cotal/run.
  const runDir = join(root, ".cotal", "run");
  const specs = existsSync(runDir) ? readdirSync(runDir).filter((f) => f.endsWith(".json")) : [];
  ok("a launch spec was written", specs.length === 1, specs);
  ok("launch spec is 0600", (statSync(join(runDir, specs[0])).mode & 0o777) === 0o600);

  // 4) up -f again, broker still running → refuse + redirect to spawn -f (never re-seed as fresh).
  const again = cli("up", "-f", manifest, "--server", SERVER);
  ok("up -f refuses when a broker is already reachable", /already has a broker/.test(again.stderr), again.stderr + again.stdout);
  ok("...and redirects to spawn -f", /spawn -f/.test(again.stderr), again.stderr);

  // 5) down tears the mesh down + clears the run dir — including the manager (nothing orphaned).
  //    `cotal down` now awaits real exit; keep a backstop poll keyed on the EXACT manager pid
  //    (precise — a name scan can be contaminated by an unrelated run) in case of a slow CI reap.
  down();
  let torn = false;
  for (let i = 0; i < 60 && !torn; i++) {
    torn = !alive(mgrPid) && !(await portOpen(PORT));
    if (!torn) await sleep(500);
  }
  ok("broker + manager are gone after down (no orphaned supervise)", torn, { mgrAlive: alive(mgrPid), portOpen: await portOpen(PORT), supervisors: supervisors() });
  ok("transient run dir cleaned by down", !existsSync(runDir));

  console.log(`\nUP-MANIFEST LIVE SMOKE OK ✅ (${pass} checks)`);
} finally {
  down();
  // Belt-and-suspenders: if down somehow didn't reap the manager, don't leave an orphan behind.
  if (Number.isFinite(mgrPid) && alive(mgrPid)) { try { process.kill(mgrPid, "SIGKILL"); } catch { /* already gone */ } }
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
