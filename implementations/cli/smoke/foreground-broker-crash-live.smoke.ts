/** A prepared controller stack must propagate broker death to its external supervisor.
 * Uses the shipped CLI, private homes and native-command stand-ins, and retains all evidence.
 * No OS service is installed or controlled. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort, recordSmokeSandbox, assertSmokeSandboxDown, emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";
import { assertRecordIdentity, identityRecord, type ProcessIdentityRecord } from "@cotal-ai/workspace";

if (process.platform === "win32") skipSuite("POSIX broker signals do not apply on Windows");
const base = mkdtempSync(join(tmpdir(), "cotal-foreground-broker-crash-"));
const entry = resolve("bin/dist/cotal.js");
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const home = join(base, "home"), machine = join(base, "machine"), root = join(base, "project"), config = join(base, "config"), runtime = join(base, "runtime"), native = join(base, "native");
for (const path of [home, machine, root, config, runtime, native]) mkdirSync(path, { recursive: true, mode: 0o700 });
for (const command of ["systemctl", "loginctl", "launchctl", "schtasks"]) writeFileSync(join(native, command), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COTAL_|JCODE_|CLAUDE_|OPENAI_|ANTHROPIC_)/.test(key))), HOME: home, COTAL_HOME: machine, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, PATH: `${native}:${process.env.PATH}`, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" };
const sandbox = recordSmokeSandbox({ root, cotalHome: machine, xdgConfigHome: config });
let sequence = 0;
function cli(...args: string[]) {
  assertSmokeSandboxDown(sandbox, args, { cwd: root, env });
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  writeFileSync(join(base, `cli-${++sequence}.log`), JSON.stringify({ args, code: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2));
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
  return result.stdout;
}
let child: ChildProcess | undefined;
let output = "";
let broker: ProcessIdentityRecord | undefined;
let stopped = false;
async function until(test: () => boolean, label: string, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (test()) return; await sleep(50); }
  throw new Error(`${label}: ${output}`);
}
async function launch() {
  output = "";
  child = spawn(process.execPath, [entry, "up", "--foreground", "--space", "broker-crash"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  child.stderr!.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  await until(() => output.includes("Controller stack started") || output.includes("Controller stack already running") || child!.exitCode !== null, "foreground start did not settle");
  assert.equal(child.exitCode, null, output);
  const status = JSON.parse(cli("status", "--space", "broker-crash", "--json")) as { result: { services: { instances: { definition: string; observedProcess: string; pid: number }[] } } };
  const row = status.result.services.instances.find((item) => item.definition === "stack-broker" && item.observedProcess === "running");
  assert.ok(row);
  // Pin only the broker that the public status of this private stack names.
  const pin = identityRecord(row.pid);
  assert.ok("token" in pin);
  broker = pin;
}
function signalBroker(signal: NodeJS.Signals) {
  assert.ok(broker && assertRecordIdentity(broker).kind === "match", "only the broker started by this fixture is signalled");
  process.kill(broker.pid, signal);
}
console.log(`foreground-broker-crash evidence: ${base}`);
try {
  cli("space", "create", "broker-crash");
  const port = await freePort();
  cli("up", "--server", `nats://127.0.0.1:${port}`, "--space", "broker-crash");
  await launch();
  signalBroker("SIGSTOP");
  await sleep(2200);
  assert.equal(child!.exitCode, null, "a stalled broker is not reported dead");
  signalBroker("SIGCONT");
  signalBroker("SIGKILL");
  await until(() => child!.exitCode !== null, "broker death did not reach the OS-owned foreground launcher", 10_000);
  assert.equal(child!.exitCode, 5, "the external supervisor sees broker failure");
  assert.match(output, /broker exited unexpectedly/);
  writeFileSync(join(base, "crash.log"), output);
  assert.match(cli("meshes"), /broker-crash/, "crash retains the registration for repair");
  // The next OS invocation follows the recorded repair path, without an internal watchdog.
  await launch();
  cli("status", "--components", "--space", "broker-crash");
  cli("down", "--yes");
  stopped = true;
  await until(() => child!.exitCode !== null, "intentional down did not release foreground owner", 10_000);
  assert.equal(child!.exitCode, 0, "intentional down must not trigger Restart=on-failure");
  writeFileSync(join(base, "stop.log"), output);
} finally {
  if (broker && assertRecordIdentity(broker).kind === "match") {
    // Resume only our own broker if a failing assertion left it suspended.
    process.kill(broker.pid, "SIGCONT");
  }
  // Restore the broker first if a failed assertion left a live manager without its transport.
  if (!stopped) {
    cli("up", "--space", "broker-crash");
    cli("down", "--yes");
  }
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await until(() => child!.exitCode !== null || child!.signalCode !== null, "owned launcher did not end", 20_000);
  }
}
emitSentinel({ passed: 8, failed: 0 });
