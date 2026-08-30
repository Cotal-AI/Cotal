import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isReachable, seedChannelRegistry } from "@cotal-ai/core";

// #839: a startup/readiness failure must not return (and let the manager retire the seat's mesh
// credential) while the private Jcode daemon tree it launched is still executing. The fake bridge
// models the measured orphan shape: a setsid-detached daemon owning an MCP child, absent from
// servers.json, so the SDK's registry-keyed daemon stop has nothing to signal and only the
// connector's own lifecycle can prove the tree is gone.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function waitFor<T>(name: string, read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${name}`);
    await sleep(100);
  }
}
const alive = (pid: number): boolean => {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const after = stat.lastIndexOf(") ");
      if (after >= 0 && stat.slice(after + 2).startsWith("Z ")) return false;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // A signalled orphan can linger briefly as a zombie on macOS/BSD while launchd reaps it.
  // kill(pid, 0) still succeeds for that non-executing process, so use the same POSIX state
  // probe as the other process-lifecycle smokes rather than calling successful teardown alive.
  if (process.platform === "darwin" || process.platform.endsWith("bsd"))
    return !spawnSync("ps", ["-o", "stat=", "-p", String(pid)]).stdout.toString().trim().startsWith("Z");
  return true;
};

const root = mkdtempSync(join(tmpdir(), "cotal-jcode-lifecycle-"));
const port = await freePort();
const servers = `nats://127.0.0.1:${port}`;
const fake = fileURLToPath(new URL("./fake-jcode.mjs", import.meta.url));
const host = fileURLToPath(new URL("../src/host-main.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const shimDir = join(root, "bin");
const shim = join(shimDir, "jcode");
const nats = spawn("nats-server", ["-js", "-p", String(port), "-sd", join(root, "js")], { stdio: "ignore" });
let child: ChildProcess | undefined;
const foreignProcesses: ChildProcess[] = [];
let pass = 0;
const leaked: number[] = [];
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  if (!raw.endsWith("\n")) lines.pop();
  return lines.filter(Boolean).map((line) => JSON.parse(line) as T);
}
const entriesOf = (log: string): Array<{ ev: string; [key: string]: unknown }> =>
  readJsonLines(log);

interface HostRun {
  child: ChildProcess;
  log: string;
  stderr: () => string;
}
const baseEnv: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(baseEnv)) if (key.startsWith("COTAL_")) delete baseEnv[key];
const inheritedJcodeHome = join(root, "source-jcode");

function startHost(name: string, extra: NodeJS.ProcessEnv): HostRun {
  const log = join(root, `${name}.jsonl`);
  const run = spawn(tsx, [host], {
    cwd: root,
    env: {
      ...baseEnv,
      PATH: `${shimDir}:${baseEnv.PATH ?? ""}`,
      FAKE_JCODE_LOG: log,
      FAKE_JCODE_DAEMON: "1",
      JCODE_HOME: inheritedJcodeHome,
      COTAL_SPACE: "jcodelife",
      COTAL_NAME: name,
      COTAL_ID: name,
      COTAL_SERVERS: servers,
      COTAL_SUBSCRIBE: "team",
      COTAL_ALLOW_SUBSCRIBE: "team",
      COTAL_ALLOW_PUBLISH: "team",
      COTAL_JCODE_HOME: root,
      COTAL_JCODE_TUI: "0",
      COTAL_CONTROL_SOCKET: join(root, `${name}-control.sock`),
      COTAL_CONTROL_TOKEN: `${name}-control-token`,
      ...extra,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  run.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return { child: run, log, stderr: () => stderr };
}

try {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(shim, 0o755);
  mkdirSync(inheritedJcodeHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(inheritedJcodeHome, "auth.json"), "lifecycle-smoke-token", { mode: 0o600 });
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await sleep(50);
  await seedChannelRegistry({ servers, space: "jcodelife", file: { defaults: { replay: false }, channels: { team: { replay: false } } } });

  // --- Regression (#839): readiness failure with the daemon already running -------------------
  // The readiness turn is held open 2s so the instrument control can observe the tree ALIVE before
  // the refusal fires: a fixed connector refuses and tears down faster than the 100ms poll.
  const failing = startHost("lifefail", { FAKE_JCODE_FAIL_READINESS: "1", FAKE_JCODE_TURN_DELAY_MS: "2000" });
  child = failing.child;
  const daemonRecord = (await waitFor("private daemon", () =>
    entriesOf(failing.log).find((entry) => entry.ev === "daemon"),
  )) as { pid: number; mcp: number };
  leaked.push(daemonRecord.pid, daemonRecord.mcp);
  check(
    "private daemon and its MCP child are live before the failure (instrument control)",
    alive(daemonRecord.pid) && alive(daemonRecord.mcp),
    daemonRecord,
  );
  await Promise.race([once(failing.child, "exit"), sleep(30_000)]);
  check("connector returns non-zero on the readiness failure", failing.child.exitCode !== null && failing.child.exitCode !== 0, {
    code: failing.child.exitCode,
    stderr: failing.stderr(),
  });
  check("the failure names the readiness refusal, not an unrelated crash", /Jcode host startup failed/.test(failing.stderr()), failing.stderr());
  check(
    "startup failure stops the private daemon before the connector returns (#839)",
    !alive(daemonRecord.pid),
    { daemon: daemonRecord.pid, stillAlive: alive(daemonRecord.pid) },
  );
  check(
    "startup failure stops the daemon's MCP child before the connector returns (#839)",
    !alive(daemonRecord.mcp),
    { mcp: daemonRecord.mcp, stillAlive: alive(daemonRecord.mcp) },
  );

  // --- HIGH 1 red-first: the detached daemon writes BOTH PID sources after the first empty scan.
  // On this head stopPrivateTree returns on that empty pass before the delayed records arrive, so
  // the connector returns while the daemon and its MCP child are still alive.
  const late = startHost("lifelate", {
    FAKE_JCODE_FAIL_READINESS: "1",
    FAKE_JCODE_TURN_DELAY_MS: "2000",
    FAKE_JCODE_RECORD_AFTER_BRIDGE_EXIT: "1",
  });
  child = late.child;
  const lateDaemon = (await waitFor("late-record private daemon", () =>
    entriesOf(late.log).find((entry) => entry.ev === "daemon"),
  )) as { pid: number; mcp: number };
  leaked.push(lateDaemon.pid, lateDaemon.mcp);
  await Promise.race([once(late.child, "exit"), sleep(30_000)]);
  check("late-record startup failure returns non-zero", late.child.exitCode !== null && late.child.exitCode !== 0, {
    code: late.child.exitCode,
    stderr: late.stderr(),
  });
  await waitFor("late daemon records after connector exit", () =>
    entriesOf(late.log).find((entry) => entry.ev === "daemon_records_written" && entry.pid === lateDaemon.pid),
  );
  const lateEntries = entriesOf(late.log);
  const bridgeExit = lateEntries.findIndex((entry) => entry.ev === "bridge_exit_observed");
  const recordWrite = lateEntries.findIndex((entry) => entry.ev === "daemon_records_written" && entry.pid === lateDaemon.pid);
  check("late record is gated after bridge teardown and reaches both PID sources (instrument control)",
    bridgeExit >= 0 && recordWrite > bridgeExit,
    { daemon: lateDaemon.pid, mcp: lateDaemon.mcp, bridgeExit, recordWrite },
  );
  check(
    "late records are not orphaned after the connector returns (#HIGH-1)",
    !alive(lateDaemon.pid) && !alive(lateDaemon.mcp),
    { daemon: lateDaemon.pid, mcp: lateDaemon.mcp, daemonAlive: alive(lateDaemon.pid), mcpAlive: alive(lateDaemon.mcp) },
  );

  // --- HIGH 2 red-first: stale records must never kill an unrelated detached process tree. ---
  const failureForeign = spawn(process.execPath, [fake, "foreign"], { detached: true, stdio: "ignore", env: { ...baseEnv, FAKE_JCODE_LOG: join(root, "foreign-failure.jsonl") } });
  foreignProcesses.push(failureForeign);
  failureForeign.unref();
  const foreignRecord = (await waitFor("startup-failure foreign process", () =>
    entriesOf(join(root, "foreign-failure.jsonl")).find((entry) => entry.ev === "foreign"),
  )) as { pid: number; child: number };
  leaked.push(foreignRecord.pid, foreignRecord.child);
  check("foreign detached process and child live before poisoned teardown (instrument control)", alive(foreignRecord.pid) && alive(foreignRecord.child), foreignRecord);

  const staleFailure = startHost("lifestalefail", {
    FAKE_JCODE_FAIL_READINESS: "1",
    FAKE_JCODE_TURN_DELAY_MS: "2000",
    FAKE_JCODE_STALE_PID: String(foreignRecord.pid),
  });
  child = staleFailure.child;
  await Promise.race([once(staleFailure.child, "exit"), sleep(30_000)]);
  check("stale-record startup failure returns non-zero", staleFailure.child.exitCode !== null && staleFailure.child.exitCode !== 0, {
    code: staleFailure.child.exitCode,
    stderr: staleFailure.stderr(),
  });
  check(
    "stale foreign record never kills the unrelated process or child on startup failure (#HIGH-2)",
    alive(foreignRecord.pid) && alive(foreignRecord.child),
    { foreign: foreignRecord, parentAlive: alive(foreignRecord.pid), childAlive: alive(foreignRecord.child) },
  );

  const gracefulForeign = spawn(process.execPath, [fake, "foreign"], { detached: true, stdio: "ignore", env: { ...baseEnv, FAKE_JCODE_LOG: join(root, "foreign-graceful.jsonl") } });
  foreignProcesses.push(gracefulForeign);
  gracefulForeign.unref();
  const gracefulForeignRecord = (await waitFor("graceful foreign process", () =>
    entriesOf(join(root, "foreign-graceful.jsonl")).find((entry) => entry.ev === "foreign"),
  )) as { pid: number; child: number };
  leaked.push(gracefulForeignRecord.pid, gracefulForeignRecord.child);
  check("graceful foreign detached process and child live before poisoned teardown (instrument control)", alive(gracefulForeignRecord.pid) && alive(gracefulForeignRecord.child), gracefulForeignRecord);

  const staleGraceful = startHost("lifestalestop", { FAKE_JCODE_STALE_PID: String(gracefulForeignRecord.pid) });
  child = staleGraceful.child;
  await waitFor("stale graceful readiness", () =>
    entriesOf(staleGraceful.log).find(
      (entry) => entry.ev === "request" && (entry.frame as { req?: string; content?: string }).req === "send_message" && String((entry.frame as { content?: string }).content).includes("cotal_orientation"),
    ),
  );
  staleGraceful.child.kill("SIGTERM");
  await Promise.race([once(staleGraceful.child, "exit"), sleep(30_000)]);
  check("stale-record graceful host stop exits", staleGraceful.child.exitCode !== null, { code: staleGraceful.child.exitCode, stderr: staleGraceful.stderr() });
  check(
    "stale foreign record never kills the unrelated process or child on graceful shutdown (#HIGH-2)",
    alive(gracefulForeignRecord.pid) && alive(gracefulForeignRecord.child),
    { foreign: gracefulForeignRecord, parentAlive: alive(gracefulForeignRecord.pid), childAlive: alive(gracefulForeignRecord.child) },
  );

  // --- Control: a successful launch keeps the tree alive, and a graceful stop ends all of it ---
  const healthy = startHost("lifeok", {});
  child = healthy.child;
  const healthyDaemon = (await waitFor("healthy private daemon", () =>
    entriesOf(healthy.log).find((entry) => entry.ev === "daemon"),
  )) as { pid: number; mcp: number };
  leaked.push(healthyDaemon.pid, healthyDaemon.mcp);
  await waitFor("readiness turn", () =>
    entriesOf(healthy.log).find(
      (entry) =>
        entry.ev === "request" &&
        (entry.frame as { req?: string; content?: string }).req === "send_message" &&
        String((entry.frame as { content?: string }).content).includes("cotal_orientation"),
    ),
  );
  await sleep(500);
  check(
    "successful launch keeps the private tree alive and managed (control)",
    healthy.child.exitCode === null && alive(healthyDaemon.pid) && alive(healthyDaemon.mcp),
    healthyDaemon,
  );
  healthy.child.kill("SIGTERM");
  await Promise.race([once(healthy.child, "exit"), sleep(30_000)]);
  check("graceful stop exits cleanly", healthy.child.exitCode === 0, { code: healthy.child.exitCode, stderr: healthy.stderr() });
  check("graceful stop tears down the private daemon (#839)", !alive(healthyDaemon.pid), { daemon: healthyDaemon.pid });
  check("graceful stop tears down the daemon's MCP child (#839)", !alive(healthyDaemon.mcp), { mcp: healthyDaemon.mcp });

  console.log(`\nJCODE LIFECYCLE SMOKE PASSED (${pass} checks)`);
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  for (const foreign of foreignProcesses) {
    if (foreign.exitCode !== null) continue;
    try {
      process.kill(-foreign.pid!, "SIGKILL");
    } catch {
      foreign.kill("SIGKILL");
    }
  }
  // The cell must not itself orphan its fakes: exact recorded PIDs only, never a name sweep.
  for (const pid of leaked) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone — the fixed connector's normal outcome */
    }
  }
  nats.kill("SIGKILL");
  await sleep(100);
  rmSync(root, { recursive: true, force: true });
}
