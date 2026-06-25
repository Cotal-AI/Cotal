/**
 * LIVE e2e for the MANAGER SINGLETON LEASE — the guarantee that exactly one manager serves a space.
 * The hermetic smokes can't reach this: it needs a real broker + two real `supervise` processes racing
 * for the same space. Asserts: (1) the manager `up` starts ACQUIRES the per-space lease and answers
 * control, (2) a SECOND `supervise` on that space REFUSES to start (fail loud, non-zero) instead of
 * becoming a co-manager that queue-splits control, (3) the incumbent is undisturbed by the refusal.
 *
 * Open mode so no creds are needed (auth-mode manager + lease is covered by smoke:control-auth).
 * Sandboxes COTAL_HOME + a temp root; tears down via `cotal down` (never pkill). Needs `nats-server`
 * on PATH. Run: pnpm smoke:manager-singleton:live
 */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 14322; // distinct from the other live smokes' fixed ports
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "singleton-live";
const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");

const home = mkdtempSync(join(tmpdir(), "cotal-singleton-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-singleton-root-"));
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
const reachable = (r: { stdout: string; stderr: string }) => !/no responders|no manager reachable/i.test(r.stdout + r.stderr);

const base = join(root, "base.yaml");
writeFileSync(base, `apiVersion: cotal/v1
kind: Mesh
space: ${SPACE}
agent: claude
broker: { servers: "${SERVER}", auth: false }
channels:
  lobby: { description: "base" }
`);

try {
  // 0) up → broker + manager A, which must ACQUIRE the per-space singleton lease to serve.
  const up = cli("up", "-f", base, "--server", SERVER);
  ok("mesh up (manager A started)", /mesh "singleton-live" up/.test(up.stdout), up.stdout + up.stderr);
  await sleep(2000);
  ok("broker bound", await portOpen(PORT));

  // 1) manager A answers control — i.e. it acquired the lease (a crash on acquire would 'no responders').
  ok("manager A answers control (holds the lease)", reachable(cli("ps", "--space", SPACE, "--server", SERVER)));

  // 2) a SECOND supervise on the same space must REFUSE — the singleton point. It blocks if it (wrongly)
  //    starts, so cap it: a correct refusal exits fast non-zero; a wrong success is SIGTERM'd at the cap.
  const b = spawnSync(TSX, [CLI, "supervise", "--space", SPACE, "--server", SERVER, "--runtime", "pty"], {
    cwd: root, env, encoding: "utf8", timeout: 12_000,
  });
  const bOut = (b.stdout ?? "") + (b.stderr ?? "");
  ok("second manager REFUSES (exited, not timed-out)", b.status !== null && b.signal !== "SIGTERM", { status: b.status, signal: b.signal });
  ok("...non-zero", b.status !== 0, b.status);
  ok("...with a clear 'already serves' message", /already serves space/.test(bOut), bOut);

  // 3) the refusal didn't disturb the incumbent — A is still the one manager serving the space.
  ok("manager A still serving after the refusal", reachable(cli("ps", "--space", SPACE, "--server", SERVER)));

  console.log(`\nMANAGER-SINGLETON LIVE SMOKE OK ✅ (${pass} checks)`);
} finally {
  cli("down");
  await sleep(500);
  // Belt-and-suspenders: `down` should stop the broker; if it didn't, free the port SURGICALLY (by
  // port, never a broad pkill — a co-running broker on another port is untouched).
  if (await portOpen(PORT)) spawnSync("sh", ["-c", `lsof -tnP -iTCP:${PORT} -sTCP:LISTEN | xargs -r kill`]);
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
