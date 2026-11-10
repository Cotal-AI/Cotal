/** Real stock nats-server file logging and rotation through controller and manifest launches. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { freePort, recordSmokeSandbox, assertSmokeSandboxDown, emitSentinel } from "@cotal-ai/smoke-kit";
import { assertScratchHeld } from "../../../bin/smoke/_scratch.js";
import { readStackJournal } from "../src/lib/stack-journal.js";
import { openBrokerLog } from "../src/commands/up.js";
import { spawnBroker } from "../src/lib/broker-spawn.js";

const binary = process.env.COTAL_BROKER_LOG_NATS;
assert.ok(binary, "set COTAL_BROKER_LOG_NATS to the copied nats-server 2.15.1 binary");
const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
assert.equal(version.status, 0, version.stderr);
assert.match(version.stdout, /v2\.15\.1\b/, `expected nats-server 2.15.1 at ${binary}`);

const wt = resolve(import.meta.dirname, "../../..");
const cli = join(wt, "bin/cotal.ts");
const tsx = join(wt, "node_modules/.bin/tsx");
// Every case creates its own .cotal before a CLI call, so an ancestor cannot capture it.
const scratch = mkdtempSync(join(tmpdir(), "cotal-broker-logrot-"));
let checks = 0;
const check = (name: string, condition: boolean, detail?: unknown) => {
  assert.ok(condition, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  checks++;
  console.log(`PASS ${name}`);
};
for (const mask of [0o022, 0o002, 0o077, 0o777]) {
  const previous = process.umask(mask);
  try {
    const child = spawnBroker(process.execPath, ["-e", "console.log(process.umask().toString(8))"], { stdio: ["ignore", "pipe", "inherit"] });
    check("broker spawn restores caller umask immediately", process.umask() === mask);
    let output = "";
    child.stdout!.setEncoding("utf8").on("data", (data: string) => { output += data; });
    const [code] = await once(child, "close");
    check("broker child inherits private umask without relaxing stricter bits", code === 0 && output.trim() === (mask | 0o077).toString(8), output);
    assert.throws(() => spawnBroker("", [], {}));
    check("synchronous spawn refusal restores caller umask", process.umask() === mask);
  } finally { process.umask(previous); }
}

async function runCase(mode: "open" | "auth", manifest = false) {
  const label = `${mode}-${manifest ? "manifest" : "controller"}`;
  const caseRoot = join(scratch, label);
  const root = join(caseRoot, "root");
  const home = join(caseRoot, "home");
  const xdg = join(caseRoot, "xdg");
  const runtime = join(caseRoot, "runtime");
  const bin = join(caseRoot, "bin");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, ".cotal"), { mode: 0o700 });
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bin, { mode: 0o700 });
  mkdirSync(runtime, { mode: 0o700 });
  assertScratchHeld(root, "broker logging live fixture");
  const shim = join(bin, "nats-server");
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(binary)} "$@"\n`, { mode: 0o700 });
  chmodSync(shim, 0o700);
  const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
  Object.assign(env, { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg, XDG_RUNTIME_DIR: runtime, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" });
  const port = await freePort();
  const server = `nats://127.0.0.1:${port}`;
  const logFile = join(root, "logs", "broker.log");
  const priorUmask = process.umask(0o022);
  const cliRun = (...args: string[]) => {
    const options = { cwd: root, env, encoding: "utf8" as const, timeout: 120_000 };
    assertSmokeSandboxDown(sandbox, args, options);
    return spawnSync(tsx, [cli, ...args], options);
  };
  const portOpen = () => new Promise<boolean>((done) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => { socket.destroy(); done(true); });
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => { socket.destroy(); done(false); });
  });
  const logs = () => readdirSync(dirname(logFile)).filter((name) => name === "broker.log" || name.startsWith("broker.log.")).sort();
  const checkPrivateLogs = (stage: string) => {
    const modes = logs().map((name) => ({ name, mode: statSync(join(dirname(logFile), name)).mode & 0o777 }));
    check(`${label} ${stage}: active and rotated logs are 0600 under umask 0022`, modes.length > 0 && modes.every(({ mode }) => mode === 0o600), modes);
  };
  const connectBad = () => new Promise<void>((done) => {
    let settled = false;
    const finish = () => { if (settled) return; settled = true; done(); };
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.write("BAD\r\n");
      setTimeout(() => { socket.destroy(); finish(); }, 10);
    });
    socket.once("error", finish);
    socket.once("close", finish);
    socket.setTimeout(1000, () => { socket.destroy(); finish(); });
  });

  try {
    const startupDiagnostics = join(root, ".cotal", "nats-startup.log");
    writeFileSync(startupDiagnostics, "prior diagnostics", { mode: 0o644 });
    const startupFd = openBrokerLog(startupDiagnostics);
    closeSync(startupFd);
    check("startup diagnostics are hardened to 0600", (statSync(startupDiagnostics).mode & 0o777) === 0o600);
    check("native and startup diagnostic paths are separate", startupDiagnostics !== logFile);
    const prepared = cliRun("space", "create", "logrot", "--root", root);
    check("space preparation succeeds", prepared.status === 0, { stdout: prepared.stdout, stderr: prepared.stderr });
    const file = join(root, "cotal.yaml");
    if (manifest) writeFileSync(file, `apiVersion: cotal/v1\nkind: Mesh\nspace: logrot\nbroker:\n  auth: ${mode !== "open"}\n  servers: ${server}\n  logFile: ${JSON.stringify(logFile)}\n  logfileSizeLimit: 2048\n  logfileMaxNum: 3\nchannels: {}\nagents: {}\n`);
    const restartArgs = manifest ? ["-f", file] : [];
    const first = cliRun("up", "--no-manager", ...(manifest ? restartArgs : ["--root", root, ...(mode === "open" ? ["--open"] : []), "--server", server, "--log-file", logFile, "--logfile-size-limit", "2048", "--logfile-max-num", "3"]));
    check(`${label} startup succeeds with native log options`, first.status === 0, { stdout: first.stdout, stderr: first.stderr });
    check("startup serves the requested port", await portOpen());
    check(`generated ${mode} config contains all native logging directives`, (() => {
      const text = readFileSync(join(root, mode === "open" ? ".cotal/server-open.conf" : ".cotal/auth/server.conf"), "utf8");
      return text.includes(`log_file: ${JSON.stringify(logFile)}`) && text.includes("logfile_size_limit: 2048") && text.includes("logfile_max_num: 3");
    })());
    checkPrivateLogs("startup");
    const firstJournal = readStackJournal(root)?.journal;
    if (manifest) check("manifest exercises the legacy launcher without a controller journal", firstJournal === undefined);
    else check("controller journal persists all logging choices", firstJournal?.broker?.logFile === logFile && firstJournal.broker.logfileSizeLimit === 2048 && firstJournal.broker.logfileMaxNum === 3);

    const stopped = cliRun("down", "--yes");
    check("first stop succeeds", stopped.status === 0, { stdout: stopped.stdout, stderr: stopped.stderr });
    check("native log is private after the broker stops", (statSync(logFile).mode & 0o777) === 0o600);
    check("first stop closes the broker port", !(await portOpen()));
    const restarted = cliRun("up", "--no-manager", ...restartArgs);
    check("restart reuses logging options", restarted.status === 0, { stdout: restarted.stdout, stderr: restarted.stderr });
    check("restart serves the requested port", await portOpen());

    for (let i = 0; i < 300; i++) await connectBad();
    const rotated = logs();
    check("300 local connects leave exactly three stock log files", rotated.length === 3, rotated);
    checkPrivateLogs("post-startup rotations");
    const stoppedAgain = cliRun("down", "--yes");
    check("second stop succeeds", stoppedAgain.status === 0, { stdout: stoppedAgain.stdout, stderr: stoppedAgain.stderr });
    check("second stop closes the broker port", !(await portOpen()));

    for (const name of logs()) rmSync(join(dirname(logFile), name));
    writeFileSync(logFile, Buffer.alloc(4096, 120), { mode: 0o600 });
    const oversizedRestart = cliRun("up", "--no-manager", ...restartArgs);
    check("restart with a pre-existing oversized native log succeeds", oversizedRestart.status === 0, { stdout: oversizedRestart.stdout, stderr: oversizedRestart.stderr });
    const startupRotated = logs();
    check("pre-existing oversized native log rotates at startup", startupRotated.length === 3 && startupRotated.filter((name) => name !== "broker.log").length === 2, startupRotated);
    checkPrivateLogs("oversized-log startup rotations");
    const finalStop = cliRun("down", "--yes");
    check("final stop succeeds", finalStop.status === 0, { stdout: finalStop.stdout, stderr: finalStop.stderr });
    console.log(`broker-logging-live ${label}: OK (rotation_count=${rotated.length}; startup_rotation_count=${startupRotated.length})`);
  } finally {
    const cleanup = cliRun("down", "--yes");
    if (cleanup.status !== 0 && await portOpen()) console.error(cleanup.stderr);
    process.umask(priorUmask);
    check("cleanup closes the broker port", !(await portOpen()));
  }
}
await runCase("open");
await runCase("auth");
await runCase("open", true);
console.log(`retained broker logging fixtures: ${scratch}`);
emitSentinel({ passed: checks, failed: 0 });
