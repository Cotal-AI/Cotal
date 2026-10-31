/** Real stock nats-server file logging and rotation through the controller-owned stack. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { chmodSync, closeSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { freePort, recordSmokeSandbox, assertSmokeSandboxDown, emitSentinel } from "@cotal-ai/smoke-kit";
import { assertScratchHeld, makeScratch } from "../../../bin/smoke/_scratch.js";
import { readStackJournal } from "../src/lib/stack-journal.js";
import { openBrokerLog } from "../src/commands/up.js";

const binary = process.env.COTAL_BROKER_LOG_NATS;
assert.ok(binary, "set COTAL_BROKER_LOG_NATS to the copied nats-server 2.15.1 binary");
const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
assert.equal(version.status, 0, version.stderr);
assert.match(version.stdout, /v2\.15\.1\b/, `expected nats-server 2.15.1 at ${binary}`);

const wt = resolve(import.meta.dirname, "../../..");
const cli = join(wt, "bin/cotal.ts");
const tsx = join(wt, "node_modules/.bin/tsx");
const scratch = makeScratch("cotal-broker-logrot-");
const root = join(scratch, "root");
const home = join(scratch, "home");
const xdg = join(scratch, "xdg");
const bin = join(scratch, "bin");
mkdirSync(root, { recursive: true, mode: 0o700 });
mkdirSync(join(root, ".cotal"), { mode: 0o700 });
chmodSync(join(root, ".cotal"), 0o700);
mkdirSync(home, { mode: 0o700 });
mkdirSync(bin, { mode: 0o700 });
assertScratchHeld(root, "broker logging live fixture");
const shim = join(bin, "nats-server");
writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(binary)} "$@"\n`, { mode: 0o700 });
chmodSync(shim, 0o700);
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: xdg });
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, USERPROFILE: home, COTAL_HOME: home, XDG_CONFIG_HOME: xdg, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" });
const port = await freePort();
const server = `nats://127.0.0.1:${port}`;
const logFile = join(root, "logs", "broker.log");
const priorUmask = process.umask(0o077);
let checks = 0;
const check = (name: string, condition: boolean, detail?: unknown) => {
  assert.ok(condition, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  checks++;
  console.log(`PASS ${name}`);
};
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
  check("startup diagnostics are hardened to 0600", (statSync(startupDiagnostics).mode & 0o777) === 0o600, (statSync(startupDiagnostics).mode & 0o777).toString(8));
  check("native and startup diagnostic paths are separate", startupDiagnostics !== logFile, { startupDiagnostics, logFile });
  const prepared = cliRun("space", "create", "logrot", "--root", root);
  check("space preparation succeeds", prepared.status === 0, { stdout: prepared.stdout, stderr: prepared.stderr });
  const first = cliRun("up", "--root", root, "--open", "--no-manager", "--server", server, "--log-file", logFile, "--logfile-size-limit", "2048", "--logfile-max-num", "3");
  check("fresh default startup succeeds with native log options", first.status === 0, { stdout: first.stdout, stderr: first.stderr });
  check("fresh default startup serves the requested port", await portOpen());
  check("generated open config contains all native logging directives", (() => {
    const text = readFileSync(join(root, ".cotal/server-open.conf"), "utf8");
    return text.includes(`log_file: ${JSON.stringify(logFile)}`) && text.includes("logfile_size_limit: 2048") && text.includes("logfile_max_num: 3");
  })());
  const firstJournal = readStackJournal(root)?.journal;
  check("controller journal persists all logging choices", firstJournal?.broker?.logFile === logFile && firstJournal.broker.logfileSizeLimit === 2048 && firstJournal.broker.logfileMaxNum === 3, { root, journal: firstJournal ?? null });

  const stopped = cliRun("down", "--yes");
  check("first stop succeeds", stopped.status === 0, { stdout: stopped.stdout, stderr: stopped.stderr });
  check("native log is private after the broker stops", (statSync(logFile).mode & 0o777) === 0o600, (statSync(logFile).mode & 0o777).toString(8));
  check("first stop closes the broker port", !(await portOpen()));
  const restarted = cliRun("up", "--no-manager");
  check("bare restart reuses persisted logging options", restarted.status === 0, { stdout: restarted.stdout, stderr: restarted.stderr });
  check("bare restart serves the requested port", await portOpen());

  for (let i = 0; i < 300; i++) await connectBad();
  const rotated = logs();
  check("300 local connects leave exactly three stock log files", rotated.length === 3, rotated);
  const stoppedAgain = cliRun("down", "--yes");
  check("second stop succeeds", stoppedAgain.status === 0, { stdout: stoppedAgain.stdout, stderr: stoppedAgain.stderr });

  for (const name of logs()) rmSync(join(dirname(logFile), name));
  writeFileSync(logFile, Buffer.alloc(4096, 120), { mode: 0o600 });
  const oversizedRestart = cliRun("up", "--no-manager");
  check("restart with a pre-existing oversized native log succeeds", oversizedRestart.status === 0, { stdout: oversizedRestart.stdout, stderr: oversizedRestart.stderr });
  const startupRotated = logs();
  check("pre-existing oversized native log rotates at startup", startupRotated.length === 3 && startupRotated.filter((name) => name !== "broker.log").length === 2, startupRotated);
  const finalStop = cliRun("down", "--yes");
  check("final stop succeeds", finalStop.status === 0, { stdout: finalStop.stdout, stderr: finalStop.stderr });
  console.log(`broker-logging-live smoke: OK (${checks} checks; rotation_count=${rotated.length}; startup_rotation_count=${startupRotated.length})`);
} finally {
  const cleanup = cliRun("down", "--yes");
  if (cleanup.status !== 0 && await portOpen()) console.error(cleanup.stderr);
  process.umask(priorUmask);
  rmSync(scratch, { recursive: true, force: true });
}
emitSentinel({ passed: checks, failed: 0 });
