import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "autoupd-notice-"));
const home = join(root, "home");
mkdirSync(home, { mode: 0o700 });
mkdirSync(join(root, ".cotal"));
const env = { ...process.env, HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: join(root, "config"), npm_config_prefix: join(root, "prefix"), npm_config_cache: join(root, "cache"), npm_config_registry: "http://127.0.0.1:1", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", CI: "" };
delete env.COTAL_NO_UPDATE_CHECK;
writeFileSync(join(home, "update-check.json"), JSON.stringify({ v: 1, latest: "99.0.0", checkedAt: Date.now(), attemptedAt: Date.now(), firstSeenAt: Date.now() }));
const entry = join(repo, "bin/dist/cotal.js");
function run(args: string[], terminal = false, extra: Record<string, string> = {}): string {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} ${args.map(arg => JSON.stringify(arg)).join(" ")}`;
  const result = terminal ? spawnSync("script", ["-qec", command, "/dev/null"], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" }) : spawnSync(process.execPath, [entry, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout + result.stderr;
}
assert.match(run(["update", "--auto", "off"]), /Automatic updates: off/);
assert.match(run(["update", "--auto"]), /Automatic updates: off/);
assert.match(run(["--version"], true), /Cotal update available: .* -> 99\.0\.0/);
assert.doesNotMatch(run(["--version"]), /Cotal update available:/);
assert.doesNotMatch(run(["version", "--json"], true), /Cotal update available:/);
assert.doesNotMatch(run(["--version"], true, { CI: "1" }), /Cotal update available:/);
assert.doesNotMatch(run(["--version"], true, { COTAL_NO_UPDATE_CHECK: "1" }), /Cotal update available:/);
assert.match(run(["update", "--notify", "off"]), /Update notices: off/);
assert.doesNotMatch(run(["--version"], true), /Cotal update available:/);
assert.match(run(["update", "--notify", "on"]), /Update notices: on/);
assert.equal((run(["--version"], true).match(/Cotal update available:/g) ?? []).length, 1);
console.log("PASS real CLI terminal notice, once per command, independent persisted settings, JSON/non-TTY/CI/environment suppression");
