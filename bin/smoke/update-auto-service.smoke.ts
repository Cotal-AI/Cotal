/** Exercise update preferences through the shipped CLI without touching the host supervisor. */
import strictAssert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { daemonPaths } from "../daemon/endpoint.js";
import { renderDaemonUnit, unitReceiptFile } from "../daemon/install.js";
import { countedAssert, emitSentinel } from "./sentinel.mjs";

if (process.platform !== "linux") skipSuite("automatic update service guidance: Linux only");
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repo, "bin/dist/cotal.js");
const root = mkdtempSync(join(tmpdir(), "uas-"));
const home = join(root, "home"), config = join(root, "config"), runtime = join(root, "run"), native = join(root, "native");
for (const dir of [home, config, runtime, native, join(root, "tmp")]) mkdirSync(dir, { mode: 0o700 });
const nativeLog = join(root, "native.log");
const env: NodeJS.ProcessEnv = {
  PATH: `${native}:${process.env.PATH}`, HOME: home, USER: "smoke", LOGNAME: "smoke",
  XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: join(root, "data"),
  XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"),
  COTAL_HOME: home, TMPDIR: join(root, "tmp"), COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_SKIP_CONNECTOR_SEED: "1",
  COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1",
};
for (const tool of ["systemctl", "loginctl", "launchctl", "schtasks"]) {
  writeFileSync(join(native, tool), `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(nativeLog)}, JSON.stringify({tool:${JSON.stringify(tool)},args})+'\\n');\nif (${JSON.stringify(tool)} === 'systemctl' && args.join(' ') === '--user show-environment') { console.log(${JSON.stringify(`HOME=${home}\nXDG_CONFIG_HOME=${config}`)}); } else { process.exit(99); }\n`, { mode: 0o700 });
}
const version = JSON.parse(readFileSync(join(repo, "bin/package.json"), "utf8")).version as string;
const seed = join(config, "cotal/seed");
mkdirSync(seed, { recursive: true, mode: 0o700 });
for (const file of ["authority.json", "authority.bak.json"]) writeFileSync(join(seed, file), JSON.stringify({ everSeeded: ["claude", "opencode", "codex", "hermes", "jcode", "pi", "web"] }), { mode: 0o600 });
writeFileSync(join(seed, "witness.json"), JSON.stringify({ initialized: true, firstGeneration: version }), { mode: 0o600 });
writeFileSync(join(seed, "stamp.json"), JSON.stringify({ generation: version }), { mode: 0o600 });
function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 15_000 });
  assert.ifError(result.error);
  return { code: result.status, text: `${result.stdout}${result.stderr}`.trim() };
}
function preference(args: string[], overrides?: NodeJS.ProcessEnv): string {
  const result = run(["update", ...args], overrides);
  assert.equal(result.code, 0, result.text);
  console.log(`${args.join(" ")}: ${result.text}`);
  return result.text;
}
const saved = () => JSON.parse(readFileSync(join(home, "update-settings.json"), "utf8"));

// Positive controls precede the regression assertion, including on the unchanged implementation.
assert.equal(preference(["--auto", "off"]), "Automatic updates: off");
assert.equal(preference(["--auto"]), "Automatic updates: off");
assert.equal(saved().auto, false);
assert.equal(preference(["--notify", "on"]), "Update notices: on");
assert.equal(existsSync(nativeLog), false);
console.log("PASS off/read and notify preserve preferences without native service calls");
const enabled = preference(["--auto", "on"]);
const read = preference(["--auto"]);
assert.equal(saved().auto, true);
const absent = run(["daemon", "status", "--json"]);
assert.equal(absent.code, 2, absent.text);
assert.match(absent.text, /NOT_RUNNING/);
console.log("OBSERVED no daemon endpoint, saved auto=true, and successful preference write/read");
for (const text of [enabled, read]) {
  assert.match(text, /^Automatic updates: on\n/);
  assert.match(text, /cotal daemon install/, "missing schedule must name the installation command");
}
assert.equal(existsSync(nativeLog), false, "missing daemon guidance must not call a service manager");
assert.match(preference(["--auto"], { XDG_RUNTIME_DIR: undefined }), /cotal daemon install/);
assert.equal(preference(["--auto"], { COTAL_NO_UPDATE_CHECK: "1" }), "Automatic updates: on (disabled by COTAL_NO_UPDATE_CHECK=1)");

let child: ChildProcess | undefined;
async function stop() {
  if (child) { await killAndAwaitExit(child); child = undefined; }
}
async function start(owned: boolean) {
  child = spawn(process.execPath, [cli, "daemon", "serve"], { cwd: root, env: { ...env, ...(owned ? { COTAL_DAEMON_NATIVE_SERVICE: "1" } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", chunk => { output += String(chunk); });
  child.stderr!.on("data", chunk => { output += String(chunk); });
  for (let i = 0; i < 100; i++) {
    if (output.includes("daemon ready at") && output.includes(`native ownership ${owned ? "owned: verified" : "not-owned: marker-absent"}`)) return;
    if (child.exitCode !== null) throw new Error(`daemon exited: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`daemon not ready: ${output}`);
}
try {
  await start(false);
  assert.equal(JSON.parse(run(["daemon", "status", "--json"]).text).result.update.automatic, false);
  assert.match(preference(["--auto"]), /cotal daemon install/, "foreground daemon cannot own the unattended schedule");
  await stop();
  // Render a receipt and unit only. No install, start or registration command is invoked.
  const originalEnv = { ...process.env }, argv = process.argv, execArgv = process.execArgv;
  try {
    Object.assign(process.env, env);
    process.argv = [process.execPath, cli];
    process.execArgv = [];
    const unit = renderDaemonUnit(join(config, "systemd/user"), undefined);
    mkdirSync(dirname(unit.unitPath), { recursive: true, mode: 0o700 });
    writeFileSync(unit.unitPath, unit.bytes, { mode: 0o600 });
    const receipt = unitReceiptFile(daemonPaths(env, home));
    mkdirSync(dirname(receipt), { recursive: true, mode: 0o700 });
    writeFileSync(receipt, JSON.stringify({ v: 1, mechanism: "systemd-user", unit: unit.unit, unitPath: unit.unitPath, unitSha256: unit.sha256, installedAt: new Date().toISOString() }), { mode: 0o600 });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    process.argv = argv; process.execArgv = execArgv;
  }
  await start(true);
  const status = JSON.parse(run(["daemon", "status", "--json"]).text).result.update;
  assert.equal(status.automatic, true);
  assert.equal(typeof status.nextAttempt, "string");
  assert.equal(preference(["--auto", "on"]), "Automatic updates: on");
  assert.equal(preference(["--auto"]), "Automatic updates: on");
  await stop();
  writeFileSync(join(home, "update-attempt.json"), "{unreadable", { mode: 0o600 });
  await start(true);
  const paused = JSON.parse(run(["daemon", "status", "--json"]).text).result.update;
  assert.equal(paused.automatic, true, "eligibility alone does not prove an active schedule");
  assert.equal(paused.nextAttempt, undefined);
  assert.equal(paused.lastResult, "automatic updates paused: unreadable attempt record");
  for (const args of [["--auto", "on"], ["--auto"]]) {
    const text = preference(args);
    assert.match(text, /^Automatic updates: on\nThe daemon is not scheduling automatic installation\./);
    assert.match(text, /cotal daemon status/);
    assert.equal(saved().auto, true);
  }
  console.log("PASS unreadable attempt record retains inactive-schedule advice despite automatic eligibility");
  assert.equal(preference(["--auto", "off"]), "Automatic updates: off");
  assert.equal(saved().auto, false);
  const calls = readFileSync(nativeLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.tool === "systemctl" && call.args.join(" ") === "--user show-environment"), "only read-only ownership observation is allowed");
  console.log("PASS only an active verified native schedule suppresses advisory, and no native mutation occurred");
} finally { await stop(); }
emitSentinel({ passed: counted.cells(), failed: 0 });
