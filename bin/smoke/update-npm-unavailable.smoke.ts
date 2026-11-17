import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitSentinel } from "./sentinel.mjs";

const root = mkdtempSync(join(tmpdir(), "update-npm-unavailable-"));
const entry = join(import.meta.dirname, "../dist/cotal.js");
for (const name of ["home", "config", "runtime", "cotal", "tmp", "missing", "offline", "work/.cotal"]) {
  mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
}
for (const name of ["missing", "offline"]) {
  const node = join(root, name, process.platform === "win32" ? "node.exe" : "node");
  if (process.platform === "win32") copyFileSync(process.execPath, node);
  else symlinkSync(process.execPath, node);
}
const log = join(root, "npm.log");
if (process.platform === "win32") {
  writeFileSync(join(root, "offline/npm.cmd"), '@echo off\r\necho %*>>"%NPM_PROBE_LOG%"\r\necho registry unreachable 1>&2\r\nexit /b 1\r\n');
} else {
  writeFileSync(join(root, "offline/npm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NPM_PROBE_LOG"\nprintf "registry unreachable\\n" >&2\nexit 1\n', { mode: 0o755 });
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !key.toLowerCase().startsWith("npm_config_") && key.toLowerCase() !== "path"));
Object.assign(env, {
  HOME: join(root, "home"), USERPROFILE: join(root, "home"), COTAL_HOME: join(root, "cotal"),
  XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "runtime"),
  APPDATA: join(root, "config"), LOCALAPPDATA: join(root, "config"), TMPDIR: join(root, "tmp"),
  TEMP: join(root, "tmp"), TMP: join(root, "tmp"),
  COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", NO_COLOR: "1", NPM_PROBE_LOG: log,
});
function run(scenario: "missing" | "offline", ...flags: string[]) {
  const result = spawnSync(process.execPath, [entry, "update", ...flags], {
    cwd: join(root, "work"), env: { ...env, PATH: join(root, scenario) }, encoding: "utf8", timeout: 30_000,
  });
  assert.ifError(result.error);
  return { ...result, output: result.stdout + result.stderr };
}
let cells = 0;
for (const scenario of ["missing", "offline"] as const) {
  const missing = scenario === "missing";
  const self = run(scenario, "--self");
  assert.equal(self.status, missing ? 1 : 0, self.output);
  if (missing) {
    assert.match(self.output, /npm .*not (?:on|found on) PATH/);
    assert.match(self.output, /Install npm or add it to this command's PATH/);
    assert.doesNotMatch(self.output, /registry cannot be reached/);
  } else assert.match(self.output, /The registry cannot be reached; nothing was changed\./);
  cells++;
  for (const flags of [[], ["--plain"], ["--json"]]) {
    const check = run(scenario, "--check", ...flags);
    assert.equal(check.status, 4, check.output);
    if (flags.includes("--json")) {
      assert.equal(check.stderr, "");
      const report = JSON.parse(check.stdout);
      assert.equal(report.outcome, "partial");
      assert.equal(report.result.latest, null);
      assert.equal(report.result.updateAvailable, null);
      assert.equal(report.result.installationChanged, false);
      assert.equal(report.result.processesRestarted, false);
      assert.deepEqual(report.warnings.map((warning: { code: string }) => warning.code), [missing ? "NPM_UNAVAILABLE" : "LATEST_VERSION_UNAVAILABLE"]);
      assert.match(report.error.remedy, missing ? /Install npm or add it to this command's PATH/ : /Check registry access/);
    } else {
      assert.match(check.output, missing ? /npm .*not (?:on|found on) PATH/ : /The registry did not return a valid latest version/);
      assert.match(check.output, missing ? /Install npm or add it to this command's PATH/ : /Check registry access/);
      if (missing) assert.doesNotMatch(check.output, /Check registry access|The registry did not return/);
    }
    cells++;
  }
  if (missing) assert.equal(existsSync(log), false, "missing npm ran no registry command");
}
const invocations = readFileSync(log, "utf8").trim().split(/\r?\n/);
assert.equal(invocations.length, 4, "the positive control started npm once per command");
assert.ok(invocations.every(line => line.startsWith("view cotal-ai@latest version --json")));
assert.deepEqual(readdirSync(join(root, "tmp")), [], "all disposable npm caches were removed");
assert.equal(existsSync(join(root, "config/cotal/extensions")), false, "checks and failed self-updates installed no extensions");
console.log(`Update npm availability: ${cells} shipped-entry cells passed. Evidence retained at ${root}`);
emitSentinel({ passed: cells, failed: 0 });
