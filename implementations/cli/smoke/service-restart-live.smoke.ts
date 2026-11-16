/** Exercise the shipped unit entry with a recording user-manager stand-in. No host unit is used.
 * The OS restart policy is checked separately from a live re-entry after SIGKILL during startup.
 * All private state and logs are retained. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { renderSystemdServiceUnit, systemdServiceUnitName } from "../src/lib/service-systemd-unit.js";
import { serviceDefinitionStore } from "../src/lib/service-definitions.js";
import { reserveStoppedServiceInstance } from "../src/lib/service-stopped-allocation.js";
import { processServiceHost, serviceInstanceStore } from "../src/lib/service-instances.js";
import { serviceSupervisorStore } from "../src/lib/service-supervision.js";
import { seedGeneration } from "../src/seed/paths.js";
import { emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("the owned systemd unit entry requires Linux");
const base = mkdtempSync(join(tmpdir(), "cotal-service-restart-"));
const entry = resolve("bin/dist/cotal.js");
const home = join(base, "home"), config = join(base, "config"), machine = join(base, "machine"), root = join(base, "project"), native = join(base, "native"), runtime = join(base, "runtime");
for (const path of [home, config, machine, root, native, runtime]) mkdirSync(path, { recursive: true, mode: 0o700 });
const stateFile = join(base, "native-state.json");
const calls = join(base, "native-calls.log");
writeFileSync(stateFile, JSON.stringify({ enabled: false, pid: 0, invocation: "" }));
const fixture = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), statePath = ${JSON.stringify(stateFile)};
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args)+'\\n');
const state = JSON.parse(fs.readFileSync(statePath,'utf8'));
if (args.join(' ')==='--user show-environment') { console.log(${JSON.stringify(`HOME=${home}\nXDG_CONFIG_HOME=${config}`)}); process.exit(0); }
if (args.includes('daemon-reload')) process.exit(0);
if (args.includes('enable')) { state.enabled = true; fs.writeFileSync(statePath, JSON.stringify(state)); process.exit(0); }
if (args.includes('stop')) { process.kill(state.pid,'SIGTERM'); state.pid = 0; fs.writeFileSync(statePath,JSON.stringify(state)); process.exit(0); }
if (!args.includes('show')) process.exit(99);
const unit = args.find(a=>/^cotal-[a-f0-9]{64}[.]service$/.test(a));
if (!unit) process.exit(98);
const values={Id:unit,LoadState:'loaded',ActiveState:state.pid?'active':'inactive',SubState:state.pid?'running':'dead',UnitFileState:state.enabled?'enabled':'disabled',MainPID:String(state.pid),InvocationID:state.invocation,FragmentPath:${JSON.stringify(join(config, "systemd/user"))}+'/'+unit,NeedDaemonReload:'no',DropInPaths:''};
for (const [key,value] of Object.entries(values)) console.log(key+'='+value);
`;
writeFileSync(join(native, "systemctl"), fixture, { mode: 0o700 });
for (const command of ["loginctl", "launchctl", "schtasks"]) writeFileSync(join(native, command), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(COTAL_|JCODE_|CLAUDE_|OPENAI_|ANTHROPIC_)/.test(key))), HOME: home, COTAL_HOME: machine, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, PATH: `${native}:${process.env.PATH}`, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", NO_COLOR: "1" };
let sequence = 0;
function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  writeFileSync(join(base, `cli-${++sequence}.log`), JSON.stringify({ args, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }, null, 2));
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout) as { result: { instanceId: string; unit: string; unitPath: string; privateHome: string } };
}
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(test: () => boolean, label: string) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { if (test()) return; await sleep(25); }
  throw new Error(label);
}
const records = () => serviceInstanceStore("restart").read(installed.instanceId)!.record.value;
let installed: { instanceId: string; unit: string; unitPath: string; privateHome: string };
let child: ChildProcess | undefined;
let output = "";
async function launch() {
  const invocation = randomBytes(16).toString("hex");
  child = spawn(process.execPath, [entry, "__service-unit", "--control-home", machine, "--space", "restart", "--definition", "worker", "--instance", installed.instanceId], { cwd: root, env: { ...env, XDG_CONFIG_HOME: join(installed.privateHome, "config"), INVOCATION_ID: invocation }, stdio: ["ignore", "pipe", "pipe"] });
  assert.ok(child.pid);
  writeFileSync(stateFile, JSON.stringify({ enabled: true, pid: child.pid, invocation }));
  child.stdout!.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  child.stderr!.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  return child;
}
async function end(signal: NodeJS.Signals) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = new Promise<void>((done) => child!.once("exit", () => done()));
  child.kill(signal);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("owned unit child did not exit")), 10_000); })]);
  } finally { clearTimeout(timer); }
}
console.log(`service-restart evidence: ${base}`);
try {
  cli("space", "create", "restart", "--json");
  const executable = join(base, "worker");
  writeFileSync(executable, `#!${process.execPath}\nconsole.log('WORKER_READY');setInterval(()=>{},1000);\n`, { mode: 0o700 });
  cli("service", "add", "worker", "--exec", executable, "--json");
  // A source checkout cannot seed an installed connector store. Establish the unit's private
  // fixture explicitly, then use the unchanged shipped entry and all its ownership checks.
  process.env.COTAL_HOME = machine;
  process.env.XDG_CONFIG_HOME = config;
  const definition = serviceDefinitionStore("restart").read("worker")!;
  const instance = reserveStoppedServiceInstance(definition);
  const unitName = systemdServiceUnitName("restart", "worker", instance.name);
  const privateHome = join(config, "systemd/user/cotal-service", unitName.slice(0, -8));
  const policy = renderSystemdServiceUnit({ space: "restart", definition: "worker", instanceId: instance.name, controlHome: machine, workingDirectory: root, environmentFile: join(privateHome, "environment"), cli: [process.execPath, entry] });
  const unitPath = join(config, "systemd/user", policy.unit);
  installed = { instanceId: instance.name, privateHome: join(config, "systemd/user/cotal-service", policy.unit.slice(0, -8)), unit: policy.unit, unitPath };
  const seed = join(installed.privateHome, "config/cotal/seed");
  mkdirSync(seed, { recursive: true, mode: 0o700 });
  writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: seedGeneration(), writtenBy: entry }), { mode: 0o600 });
  writeFileSync(unitPath, policy.bytes, { mode: 0o600 });
  const host = processServiceHost();
  serviceSupervisorStore("restart").commit(instance.name, undefined, { schemaVersion: 1, space: "restart", instanceId: instance.name, definition: "worker", definitionRevision: definition.record.revision, machine: host.machine, uid: host.uid!, mechanism: "systemd-user", unit: policy.unit, unitPath, unitSha256: policy.sha256, privateHome: installed.privateHome, seededGeneration: seedGeneration(), installedAt: new Date().toISOString() });
  const source = readFileSync(unitPath, "utf8");
  await launch();
  await until(() => output.includes("WORKER_READY") || child!.exitCode !== null, "initial native entry did not run");
  assert.match(output, /WORKER_READY/, "positive control: the shipped unit entry executes the real worker");
  await end("SIGKILL");
  // No CLI readiness caller settles this automatic/boot invocation. Its process is proven dead.
  const before = records();
  writeFileSync(join(base, "record-before.json"), JSON.stringify(before, null, 2));
  output = "";
  await launch();
  await until(() => output.includes("WORKER_READY") || child!.exitCode !== null, "replacement entry did not settle");
  writeFileSync(join(base, "replacement.log"), output);
  assert.match(output, /WORKER_READY/, "a new native invocation replaces the exact dead startup incarnation without a CLI readiness caller");
  assert.match(source, /^Restart=on-failure$/m, "installed units restart failures rather than remaining dead");
  assert.match(source, /^RestartSec=5s$/m, "native restarts have a bounded retry interval");
  const replacement = records();
  assert.notEqual(replacement.launchRequestId, before.launchRequestId, "the replacement gets its own launch request");
  assert.notEqual(replacement.supervisorInvocationId, before.supervisorInvocationId, "the replacement is bound to the new OS invocation");
  // Keep the fixture's event loop running so it reaps the worker while the CLI verifies exit.
  const stopper = spawn(process.execPath, [entry, "service", "stop", "worker", "--yes", "--json"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stoppedOutput = "";
  stopper.stdout!.on("data", (bytes: Buffer) => { stoppedOutput += bytes.toString(); });
  stopper.stderr!.on("data", (bytes: Buffer) => { stoppedOutput += bytes.toString(); });
  const stopCode = await new Promise<number | null>((done) => stopper.once("close", done));
  writeFileSync(join(base, "stop.log"), stoppedOutput);
  assert.equal(stopCode, 0, stoppedOutput);
  await until(() => child!.exitCode !== null || child!.signalCode !== null, "the public native stop did not end the restarted process");
  assert.equal(records().state, "stopped", "a restarted unit remains controllable without a readiness caller");
  const instances = serviceInstanceStore("restart");
  for (const state of ["unknown", "stopping"] as const) {
    const row = instances.read(installed.instanceId)!;
    instances.commit(row.name, row, { ...row.record.value, state });
    output = "";
    await launch();
    await until(() => child!.exitCode !== null, `unresolved ${state} was not refused`);
    assert.doesNotMatch(output, /WORKER_READY/, `a dead ${state} attempt is not retried`);
    assert.match(output, /LIFECYCLE_BLOCKED/, `a dead ${state} attempt retains its refusal`);
  }
  console.log("PASS generated restart policy, real initial exec, SIGKILL re-entry and private native controls");
} finally {
  await end("SIGTERM");
  writeFileSync(join(base, "last-output.log"), output);
}
emitSentinel({ passed: 10, failed: 0 });
