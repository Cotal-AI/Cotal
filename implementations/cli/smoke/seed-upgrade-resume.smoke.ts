/**
 * Issue #1336: a completed v0.33.1 seed store has no interruption marker, but a newer generation can
 * leave the shared reconcile cursor if its upgrade refresh is interrupted before the final stamp
 * commit. The current manager must resume that exact upgrade safely and reach readiness. A cursor
 * whose stamp already names the current generation is not upgrade-attributable and must still stop.
 *
 * Broker-only fixture. It never runs `cotal up` or `cotal down`, and every home/config/root is isolated.
 * Run: pnpm smoke:seed-upgrade-resume
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const repo = join(import.meta.dirname, "..", "..", "..");
const cli = join(repo, "bin", "dist", "cotal.js");
if (!existsSync(cli)) throw new Error(`built CLI missing at ${cli}`);

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalXdg = process.env.XDG_CONFIG_HOME;
const originalCotalHome = process.env.COTAL_HOME;
const originalAllowCheckoutSeed = process.env.COTAL_ALLOW_CHECKOUT_SEED;
const originalNoColor = process.env.NO_COLOR;
const originalCotal = new Map(
  Object.entries(process.env).filter(([key]) => key.startsWith("COTAL_")),
);
const ambient: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(ambient)) if (key.startsWith("COTAL_")) delete ambient[key];

const base = mkdtempSync(join(tmpdir(), "cotal-seed-upgrade-resume-"));
const home = join(base, "home");
const xdg = join(base, "xdg");
const cotalHome = join(base, "cotal-home");
const root = join(base, "workspace");
const npmPrefix = join(base, "old-prefix");
const brokerStore = join(base, "jetstream");
for (const path of [home, xdg, cotalHome, root, npmPrefix, brokerStore]) mkdirSync(path, { recursive: true });
mkdirSync(join(root, ".cotal"), { recursive: true });

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = xdg;
process.env.COTAL_HOME = cotalHome;
process.env.COTAL_ALLOW_CHECKOUT_SEED = "1";
process.env.NO_COLOR = "1";
for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_") && !["COTAL_HOME", "COTAL_ALLOW_CHECKOUT_SEED"].includes(key)) delete process.env[key];

const { probeConnect, setupSpaceStreams } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const socket = createServer();
  socket.on("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const port = (socket.address() as AddressInfo).port;
    socket.close(() => resolve(port));
  });
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number | undefined): boolean => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const stop = async (child: ChildProcess | undefined): Promise<void> => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    wait(5_000).then(() => { if (alive(child.pid)) child.kill("SIGKILL"); }),
  ]);
};
const childEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...ambient,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: xdg,
  COTAL_HOME: cotalHome,
  COTAL_ALLOW_CHECKOUT_SEED: "1",
  NO_COLOR: "1",
  ...extra,
});
const seedDir = join(xdg, "cotal", "seed");
const cursorPath = join(seedDir, "reconcile.cursor.json");
const stampPath = join(seedDir, "stamp.json");
const oldCli = join(npmPrefix, "node_modules", "cotal-ai", "dist", "cotal.js");
const currentGeneration = (JSON.parse(readFileSync(join(repo, "bin", "package.json"), "utf8")) as { version: string }).version;
const cursor = { nonce: "issue-1336-upgrade", package: "claude", phase: "add" } as const;

let broker: ChildProcess | undefined;
let manager: ChildProcess | undefined;
let pass = 0;
function check(name: string, condition: boolean, extra?: unknown): void {
  if (!condition) throw new Error(`FAIL: ${name}${extra === undefined ? "" : `\n${String(extra)}`}`);
  pass += 1;
  console.log(`  ✓ ${name}`);
}

try {
  const installed = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", npmPrefix, "cotal-ai@0.33.1"], {
    env: childEnv({ COTAL_ALLOW_CHECKOUT_SEED: undefined }),
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.equal(installed.status, 0, `install v0.33.1 failed:\n${installed.stdout}\n${installed.stderr}`);
  const oldSeed = spawnSync(process.execPath, [oldCli, "ext", "list"], {
    cwd: root,
    env: childEnv({ COTAL_ALLOW_CHECKOUT_SEED: undefined }),
    encoding: "utf8",
    timeout: 180_000,
  });
  assert.equal(oldSeed.status, 0, `v0.33.1 seed failed:\n${oldSeed.stdout}\n${oldSeed.stderr}`);
  check("v0.33.1 layout: a completed seed store has no reconcile cursor", !existsSync(cursorPath));
  check(
    "v0.33.1 layout: the committed legacy stamp names generation 0.33.1",
    (JSON.parse(readFileSync(stampPath, "utf8")) as { generation?: string }).generation === "0.33.1",
  );

  writeFileSync(cursorPath, `${JSON.stringify(cursor)}\n`);
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const space = "seed-upgrade-resume";
  broker = spawn("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", brokerStore], { stdio: "ignore" });
  let serving = false;
  for (let tries = 0; tries < 80 && !serving; tries++) {
    serving = (await probeConnect(server, { timeoutMs: 400 })).ok;
    if (!serving) await wait(100);
  }
  assert.ok(serving, "isolated broker did not become reachable");
  await setupSpaceStreams({ servers: server, space });
  recordMesh({ space, server, root, mode: "open", ts: new Date().toISOString(), origin: "manual" });

  let managerOutput = "";
  manager = spawn(process.execPath, [cli, "supervise", "--space", space, "--server", server, "--runtime", "pty"], {
    cwd: root,
    env: childEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  manager.stdout?.on("data", (chunk: Buffer | string) => { managerOutput += chunk.toString(); });
  manager.stderr?.on("data", (chunk: Buffer | string) => { managerOutput += chunk.toString(); });
  for (let tries = 0; tries < 900 && !managerOutput.includes("manager up"); tries++) {
    if (manager.exitCode !== null || manager.signalCode !== null) break;
    await wait(100);
  }
  check(
    "upgrade interruption: manager repairs the newer-generation cursor before reaching ready",
    managerOutput.includes("manager up") && !existsSync(cursorPath) && manager.exitCode === null,
    managerOutput.slice(-2_000),
  );
  check(
    "upgrade interruption: the repaired store commits the current generation",
    (JSON.parse(readFileSync(stampPath, "utf8")) as { generation?: string }).generation === currentGeneration,
  );
  await stop(manager);
  manager = undefined;

  writeFileSync(stampPath, `${JSON.stringify({ generation: currentGeneration })}\n`);
  writeFileSync(cursorPath, `${JSON.stringify({ ...cursor, nonce: "issue-1336-control" })}\n`);
  const interrupted = spawnSync(process.execPath, [cli, "supervise", "--space", space, "--server", server, "--runtime", "pty"], {
    cwd: root,
    env: childEnv(),
    encoding: "utf8",
    timeout: 30_000,
  });
  const interruptedOutput = `${interrupted.stdout ?? ""}${interrupted.stderr ?? ""}`;
  check(
    "actual interruption: a same-generation cursor still hard-stops the manager with exact state",
    interrupted.status !== 0 &&
      interruptedOutput.includes(`package \"claude\", phase add`) &&
      interruptedOutput.includes(`seed store generation ${currentGeneration}, running generation ${currentGeneration}`) &&
      existsSync(cursorPath),
    interruptedOutput,
  );
} finally {
  await stop(manager);
  await stop(broker);
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalCotalHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = originalCotalHome;
  if (originalAllowCheckoutSeed === undefined) delete process.env.COTAL_ALLOW_CHECKOUT_SEED; else process.env.COTAL_ALLOW_CHECKOUT_SEED = originalAllowCheckoutSeed;
  if (originalNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = originalNoColor;
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
  for (const [key, value] of originalCotal) process.env[key] = value;
  rmSync(base, { recursive: true, force: true });
}

console.log(`seed-upgrade-resume smoke: ${pass} passed, 0 failed`);
