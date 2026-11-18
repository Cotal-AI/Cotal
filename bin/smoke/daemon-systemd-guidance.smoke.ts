/** Exercise Linux service prerequisites through the built CLI with private homes and native stand-ins. */
import strictAssert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { killAndAwaitExit, skipSuite } from "@cotal-ai/smoke-kit";
import { countedAssert, emitSentinel } from "./sentinel.mjs";

if (process.platform !== "linux") skipSuite("Linux systemd prerequisite guidance");
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repo, "bin/dist/cotal.js");
const root = mkdtempSync(join(tmpdir(), "dsg-"));
const home = join(root, "home"), config = join(root, "config"), runtime = join(root, "run");
const native = join(root, "native"), missing = join(root, "missing"), nativeLog = join(root, "native.log");
for (const dir of [home, config, runtime, native, missing]) mkdirSync(dir, { mode: 0o700 });
const env: NodeJS.ProcessEnv = {
  PATH: native, HOME: home, USER: "smoke", LOGNAME: "smoke", XDG_CONFIG_HOME: config,
  XDG_RUNTIME_DIR: runtime, COTAL_HOME: join(home, "cotal"), TMPDIR: root,
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_ALLOW_CHECKOUT_SEED: "1", COTAL_TELEMETRY: "off",
  DO_NOT_TRACK: "1", NO_COLOR: "1", COTAL_NO_UPDATE_CHECK: "1",
};
for (const tool of ["systemctl", "loginctl", "launchctl", "schtasks"]) {
  writeFileSync(join(native, tool), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(nativeLog)}, ${JSON.stringify(tool)}+' '+args.join(' ')+'\\n');
if (${JSON.stringify(tool)} === 'systemctl' && args.join(' ') === '--user show-environment') {
  if (process.env.SMOKE_BUS_DOWN === '1') process.exit(1);
  console.log(${JSON.stringify(`HOME=${home}\nXDG_CONFIG_HOME=${config}`)});
} else if (${JSON.stringify(tool)} === 'loginctl' && args[0] === 'show-user') console.log('Linger=yes');
else process.exit(99);
`, { mode: 0o700 });
}
// Only host-presence observations are controlled. All CLI routing, plans and subprocesses are real.
const preload = join(root, "platform.mjs");
writeFileSync(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const exists = fs.existsSync, lstat = fs.lstatSync;
fs.existsSync = function(path) {
  if (path === '/run/systemd/system') return process.env.SMOKE_SYSTEMD !== 'absent';
  return exists(path);
};
fs.lstatSync = function(path, ...args) {
  if (process.env.SMOKE_RUNTIME === 'absent' && path === '/run/user/'+process.geteuid())
    throw Object.assign(new Error('runtime absent'), {code:'ENOENT'});
  return lstat(path, ...args);
};
process.execArgv = [];
syncBuiltinESMExports();
`);
function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 20_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const text = `${result.stdout}${result.stderr}`;
  console.log(`${args.join(" ")}: exit ${result.status}\n${text}`);
  return { code: result.status, text };
}
const calls = () => existsSync(nativeLog) ? readFileSync(nativeLog, "utf8") : "";
const control = run(["daemon", "install", "--dry-run"]);
assert.equal(control.code, 0);
assert.match(control.text, /Would install/);
assert.match(control.text, /Nothing was written, enabled or started/);
assert.equal(existsSync(join(config, "systemd/user/cotal-daemon.service")), false);
const busDown = run(["daemon", "install", "--dry-run"], { SMOKE_BUS_DOWN: "1" });
assert.equal(busDown.code, 2);
assert.match(busDown.text, /DEPENDENCY_UNAVAILABLE/);
assert.match(busDown.text, /logged-in session/);
console.log("PASS supported systemd and unavailable user-bus controls");

assert.equal(run(["space", "create", "sample", "--root", root]).code, 0);
const definition = join(root, "service.json");
writeFileSync(definition, JSON.stringify({ schemaVersion: 1, space: "sample", launch: {
  type: "process", executable: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"], cwd: root,
}, readiness: { type: "process", timeoutMs: 5000 } }));
assert.equal(run(["service", "add", "probe", "--file", definition, "--space", "sample"]).code, 0);
const serviceControl = run(["service", "install", "probe", "--space", "sample", "--dry-run", "--json"]);
assert.equal(serviceControl.code, 4);
assert.equal(JSON.parse(serviceControl.text).result.wouldAllocateStoppedInstance, true);
const serviceBusDown = run(["service", "install", "probe", "--space", "sample", "--dry-run"], { SMOKE_BUS_DOWN: "1" });
assert.equal(serviceBusDown.code, 2);
assert.match(serviceBusDown.text, /DEPENDENCY_UNAVAILABLE/);
assert.match(serviceBusDown.text, /logged-in session/);

for (const overrides of [{ PATH: missing }, { SMOKE_SYSTEMD: "absent" }]) {
  for (const runtimePresent of [true, false]) {
    const settings = { ...overrides, ...(runtimePresent ? {} : { XDG_RUNTIME_DIR: undefined, SMOKE_RUNTIME: "absent" }) };
    const before = calls();
    for (const args of [["install", "--dry-run"], ["install"], ["setup", "--space", "sample"], ["setup"], ["setup", "--idp", "example.invalid"]]) {
      for (const json of [false, true]) {
        const result = run(["daemon", ...args, ...(json ? ["--json"] : [])], settings);
        assert.equal(result.code, 2);
        assert.match(result.text, /requires systemd/);
        assert.match(result.text, /cotal daemon serve/);
        assert.match(result.text, /OpenRC user service, runit or s6/);
        assert.match(result.text, /cotal update --self/);
        assert.doesNotMatch(result.text, /logged-in session|NO_RUNTIME_DIR/);
        if (json) assert.equal(JSON.parse(result.text).error.code, "UNSUPPORTED");
      }
    }
    for (const args of [["--auto", "on"], ["--auto"]]) {
      const auto = run(["update", ...args], { ...settings, COTAL_NO_UPDATE_CHECK: undefined });
      assert.equal(auto.code, 0);
      assert.match(auto.text, /Automatic updates: on/);
      assert.match(auto.text, /requires systemd/);
      assert.match(auto.text, /cotal daemon serve/);
      assert.match(auto.text, /cotal update --self/);
      assert.doesNotMatch(auto.text, /cotal daemon install/);
      assert.match(auto.text, /\nThe Linux background service requires systemd/);
      assert.match(auto.text, /\. Run `cotal daemon serve`/);
    }
    for (const apply of [false, true]) {
      for (const json of [false, true]) {
        const service = run(["service", "install", "probe", "--space", "sample", ...(apply ? [] : ["--dry-run"]), ...(json ? ["--json"] : [])], settings);
        assert.equal(service.code, 2);
        assert.match(service.text, /requires systemd/);
        assert.match(service.text, /own supervisor/);
        assert.doesNotMatch(service.text, /logged-in session|cotal daemon serve/);
        if (json) assert.equal(JSON.parse(service.text).error.code, "UNSUPPORTED");
      }
    }
    const off = run(["update", "--auto", "off"], { ...settings, COTAL_NO_UPDATE_CHECK: undefined });
    assert.equal(off.code, 0);
    assert.equal(off.text.trim(), "Automatic updates: off");
    assert.equal(calls(), before, "unsupported service requests never invoke native tools");
    assert.equal(existsSync(join(config, "systemd/user/cotal-daemon.service")), false);
    assert.equal(existsSync(join(env.COTAL_HOME!, "daemon/service-unit.json")), false);
  }
}
const inventory = run(["service", "--space", "sample", "--json"]);
assert.deepEqual(JSON.parse(inventory.text).result.instances, []);
const noRuntime = run(["daemon", "status", "--json"], { XDG_RUNTIME_DIR: undefined, SMOKE_RUNTIME: "absent" });
assert.equal(noRuntime.code, 2);
const refusal = JSON.parse(noRuntime.text);
assert.equal(refusal.error.cause.code, "NO_RUNTIME_DIR");
assert.match(refusal.error.remedy, /systemd-logind or pam_rundir/);
assert.match(refusal.error.remedy, /0700/);
assert.match(refusal.error.remedy, /XDG_RUNTIME_DIR/);
console.log("PASS runtime directory refusal explains creation and private permissions");

const beforeServe = calls();
const child = spawn(process.execPath, ["--import", preload, cli, "daemon", "serve"], {
  cwd: root, env: { ...env, PATH: missing, SMOKE_SYSTEMD: "absent" }, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout!.on("data", chunk => { output += chunk; });
child.stderr!.on("data", chunk => { output += chunk; });
child.on("error", error => { output += error.message; });
try {
  const deadline = Date.now() + 20_000;
  while (!output.includes("daemon ready at ") && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(output, /daemon ready at /);
  const status = run(["daemon", "status", "--json"], { PATH: missing, SMOKE_SYSTEMD: "absent" });
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.text).result.state, "ready");
  assert.equal(calls(), beforeServe, "foreground serve and status do not need systemd tools");
} finally { await killAndAwaitExit(child, "SIGTERM", 10_000); }
assert.notEqual(child.exitCode, null);
console.log("PASS foreground daemon serves without systemd and exits cleanly");

// A retained receipt must not turn an unsupported operation into a claim that no unit exists.
const unitPath = join(config, "systemd/user/cotal-daemon.service");
const receiptPath = join(env.COTAL_HOME!, "daemon/service-unit.json");
const unitBytes = "[Unit]\nDescription=private recorded-unit guidance probe\n";
mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
writeFileSync(unitPath, unitBytes, { mode: 0o600 });
const receiptBytes = JSON.stringify({ v: 1, mechanism: "systemd-user", unit: "cotal-daemon.service",
  unitPath, unitSha256: createHash("sha256").update(unitBytes).digest("hex"), installedAt: new Date().toISOString() });
writeFileSync(receiptPath, receiptBytes, { mode: 0o600 });
const removalControl = run(["daemon", "uninstall", "--dry-run", "--json"]);
assert.equal(removalControl.code, 0);
assert.equal(JSON.parse(removalControl.text).result.state, "would-remove");
const beforeRecorded = calls();
for (const overrides of [{ PATH: missing }, { SMOKE_SYSTEMD: "absent" }]) {
  for (const args of [["uninstall", "--dry-run"], ["uninstall", "--yes"], ["start"]]) {
    for (const json of [false, true]) {
      const result = run(["daemon", ...args, ...(json ? ["--json"] : [])], overrides);
      assert.equal(result.code, 2);
      assert.match(result.text, /requires systemd/);
      assert.match(result.text, /environment running systemd with systemctl on PATH/);
      assert.match(result.text, /same operating-system user/);
      assert.doesNotMatch(result.text, /Cotal did not install|logged-in session/);
      if (json) assert.equal(JSON.parse(result.text).error.code, "UNSUPPORTED");
      assert.equal(readFileSync(unitPath, "utf8"), unitBytes);
      assert.equal(readFileSync(receiptPath, "utf8"), receiptBytes);
      assert.equal(calls(), beforeRecorded, "unsupported recorded-unit operations never invoke native tools");
    }
  }
}
console.log("PASS recorded-unit operations explain restoring systemd access without denying the installation");
emitSentinel({ passed: counted.cells(), failed: 0 });
