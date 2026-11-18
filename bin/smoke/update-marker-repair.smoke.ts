import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { countedAssert, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("global marker repair census requires Linux");
process.umask(0o077);
const counted = countedAssert(assert);
const check: typeof assert = counted.assert;
const repo = resolve(import.meta.dirname, "../..");
const root = mkdtempSync(join(tmpdir(), "update-marker-repair-"));
const native = join(root, "native");
mkdirSync(native, { mode: 0o700 });
for (const command of ["busctl", "systemctl", "loginctl", "launchctl", "schtasks"]) {
  writeFileSync(join(native, command), `#!${process.execPath}\nconst fs = require('node:fs'); fs.appendFileSync(process.env.REPAIR_TEST_NATIVE_LOG, ${JSON.stringify(command + "\n")}); ${command === "busctl" ? "if (process.env.REPAIR_TEST_BUS_PID) { console.log('u ' + process.env.REPAIR_TEST_BUS_PID); process.exit(0); }" : ""} process.exit(99);\n`, { mode: 0o700 });
}
const helper = join(root, "environment.mjs");
// Control only census inputs and unrelated update work. The shipped dispatcher, composed repair,
// marker validation, global writer and retention all run unchanged. Live acceptance uses a private
// PID namespace separately, since a shared CI account must not be required to exit its processes.
writeFileSync(helper, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync, list = fs.readdirSync, stat = fs.statSync, link = fs.readlinkSync;
fs.readdirSync = (path, ...args) => path === '/proc' ? [String(process.pid), '1', ...(process.env.REPAIR_TEST_WRITER ? [process.env.REPAIR_TEST_WRITER] : [])] : list(path, ...args);
fs.readFileSync = (path, ...args) => {
  if (path === '/proc/' + process.pid + '/stat' || path === '/proc/1/stat') {
    if (process.env.REPAIR_TEST_UNREADABLE && path === '/proc/1/stat') throw Object.assign(new Error('fixture process identity denied'), { code: 'EACCES' });
    const text = read('/proc/' + process.pid + '/stat', 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\\s+/);
    fields[1] = path === '/proc/1/stat' ? '0' : '1';
    return (path === '/proc/1/stat' ? '1' : process.pid) + ' (fixture) ' + fields.join(' ');
  }
  return read(path, ...args);
};
fs.statSync = (path, ...args) => stat(path === '/proc/1' ? '/proc/' + process.pid : path, ...args);
fs.readlinkSync = (path, ...args) => path === '/proc/1/exe' ? process.execPath : link(path, ...args);
syncBuiltinESMExports();
const { updateRuntime } = await import(${JSON.stringify(pathToFileURL(join(repo, "implementations/cli/dist/commands/update.js")).href)});
Object.assign(updateRuntime, {
  installPrefix: () => process.env.REPAIR_TEST_PREFIX,
  checkout: () => true,
  isCurrent: () => false,
  reconcile: async () => console.log('fixture reconciliation completed'),
  refreshConnectors: async () => [],
  extensions: () => [],
  reportRunningManager: async () => 'none',
  npm: () => ({ status: 0, stdout: JSON.stringify(updateRuntime.version()), stderr: '' }),
});
`);
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && key !== "NODE_OPTIONS" && key !== "DBUS_SESSION_BUS_ADDRESS"));
const writer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
const writerExit = new Promise(resolveExit => writer.once("exit", resolveExit));
try {
  for (const scenario of ["idle", "live-owner", "live-writer", "invalid-marker", "unreadable-ancestor", "advertised-bus", "runtime-bus", "unavailable-bus"] as const) {
    const base = join(root, scenario), prefix = join(base, "prefix"), global = join(prefix, "lib/node_modules");
    const home = join(base, "home"), config = join(base, "config"), runtime = join(base, "runtime"), cotal = join(base, "cotal");
    for (const path of [join(base, ".cotal"), global, home, config, runtime, cotal]) mkdirSync(path, { recursive: true, mode: 0o700 });
    const nativeLog = join(base, "native.log");
    const withBus = scenario === "advertised-bus" || scenario === "runtime-bus";
    if (scenario === "runtime-bus") writeFileSync(join(runtime, "bus"), "fixture bus endpoint");
    const marker = join(global, ".cotal-update-child");
    const bytes = JSON.stringify({ phase: "ambiguous", owner: scenario === "live-owner" ? process.pid : 2147483647, nonce: scenario === "invalid-marker" ? "invalid" : "a".repeat(24), operation: "global reconcile", reason: "reconcile child terminated by SIGKILL" });
    writeFileSync(marker, bytes, { mode: 0o600 });
    const result = spawnSync(process.execPath, [join(repo, "bin/dist/cotal.js"), "update", "--self"], {
      cwd: base,
      env: { ...clean, HOME: home, COTAL_HOME: cotal, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", COTAL_NO_UPDATE_CHECK: "1", PATH: `${native}:${process.env.PATH}`, NODE_OPTIONS: `--import=${pathToFileURL(helper).href}`, REPAIR_TEST_PREFIX: prefix, REPAIR_TEST_NATIVE_LOG: nativeLog, ...(withBus ? { REPAIR_TEST_BUS_PID: String(writer.pid), REPAIR_TEST_WRITER: String(writer.pid) } : {}), ...(scenario === "advertised-bus" ? { DBUS_SESSION_BUS_ADDRESS: "unix:path=/fixture-bus" } : {}), ...(scenario === "live-writer" ? { REPAIR_TEST_WRITER: String(writer.pid) } : {}), ...(scenario === "unreadable-ancestor" ? { REPAIR_TEST_UNREADABLE: "1" } : {}), ...(scenario === "unavailable-bus" ? { DBUS_SESSION_BUS_ADDRESS: "unix:path=/absent-fixture-bus" } : {}) },
      encoding: "utf8", timeout: 30_000,
    });
    writeFileSync(join(base, "stdout.log"), result.stdout ?? "");
    writeFileSync(join(base, "stderr.log"), result.stderr ?? "");
    if (scenario === "idle" || withBus) {
      check.equal(result.status, 0, result.stdout + result.stderr);
      check.match(result.stdout, /Retaining the interrupted update marker/);
      check.match(result.stdout, /fixture reconciliation completed/);
      check.equal(existsSync(marker), false);
      const retained = readdirSync(global).filter(name => name.startsWith(".cotal-update-child.retained-"));
      check.equal(retained.length, 1);
      check.equal(readFileSync(join(global, retained[0]!), "utf8"), bytes);
    } else {
      check.equal(result.status, 3, result.stdout + result.stderr);
      check.match(result.stderr, scenario === "live-owner" ? /owner is still running/ : scenario === "live-writer" ? /waiting for process .* to exit/ : scenario === "invalid-marker" ? /marker is invalid/ : scenario === "unreadable-ancestor" ? /fixture process identity denied/ : /busctl/);
      check.equal(readFileSync(marker, "utf8"), bytes);
      check.equal(readdirSync(global).some(name => name.startsWith(".cotal-update-child.retained-")), false);
    }
    check.equal(existsSync(nativeLog), withBus || scenario === "unavailable-bus", "only an advertised user bus requires native authentication");
    if (existsSync(nativeLog)) check.equal(readFileSync(nativeLog, "utf8"), "busctl\n", "repair never controls a service without an installation receipt");
    console.log(`PASS ${scenario}`);
  }
} finally {
  writer.kill("SIGTERM");
  await writerExit;
}
console.log(`Retained update-marker evidence: ${root}`);
console.log(`COTAL_SMOKE_SENTINEL cells=${counted.cells()} passed=${counted.cells()} failed=0`);
