import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
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
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
let pass = 0;
const leaked: number[] = [];
const check = (name: string, condition: boolean, actual?: unknown): void => {
  assert.ok(condition, `${name}${actual === undefined ? "" : ` — ${JSON.stringify(actual)}`}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const entriesOf = (log: string): Array<{ ev: string; [key: string]: unknown }> =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

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
  const failing = startHost("lifefail", { FAKE_JCODE_FAIL_READINESS: "1" });
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
