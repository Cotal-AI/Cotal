import strictAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "./sentinel.mjs";
const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { recoveryProcessStartToken } from "@cotal-ai/workspace";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "autoupd-notice-"));
const home = join(root, "home");
mkdirSync(home, { mode: 0o700 });
mkdirSync(join(root, ".cotal"));
const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: join(root, "config"), XDG_RUNTIME_DIR: join(root, "runtime"), npm_config_prefix: join(root, "prefix"), npm_config_cache: join(root, "cache"), npm_config_registry: "http://127.0.0.1:1", COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off", DO_NOT_TRACK: "1", CI: "", CONTINUOUS_INTEGRATION: "", BUILD_NUMBER: "" };
writeFileSync(join(home, "update-check.json"), JSON.stringify({ v: 1, latest: "99.0.0", checkedAt: Date.now(), attemptedAt: Date.now(), firstSeenAt: Date.now() }));
const entry = join(repo, "bin/dist/cotal.js");
function run(args: string[], terminal = false, extra: Record<string, string> = {}, status = 0): string {
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} ${args.map(arg => JSON.stringify(arg)).join(" ")}`;
  const result = terminal ? spawnSync("script", ["-qec", command, "/dev/null"], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" }) : spawnSync(process.execPath, [entry, ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
  assert.equal(result.status, status, result.stdout + result.stderr);
  return result.stdout + result.stderr;
}

function recoveryDuringStartup(): void {
  const recoveryHome = join(root, "recovery-home");
  mkdirSync(recoveryHome, { mode: 0o700 });
  writeFileSync(join(recoveryHome, "update-check.json"), JSON.stringify({ v: 1, attemptedAt: Date.now(), checkedAt: Date.now() }));
  const record = {
    v: 1, previous: "1.0.0", target: "2.0.0", installed: "2.0.0", phase: "paused", reason: "test interruption", recordedAt: new Date().toISOString(),
  };
  const recoveryFile = join(recoveryHome, "update-recovery.json");
  writeFileSync(recoveryFile, JSON.stringify(record));
  const hook = join(root, "fail-surface.mjs");
  writeFileSync(hook, `export async function resolve(specifier, context, next) {
  if (specifier === "@cotal-ai/cli" && context.parentURL?.endsWith("/bin/dist/run.js")) throw new Error("test surface import failed");
  return next(specifier, context);
}\n`);
  const preload = join(root, "register.mjs");
  writeFileSync(preload, `import { register } from "node:module"; register(${JSON.stringify(pathToFileURL(hook).href)});\n`);
  const recoveryEnv = { COTAL_HOME: recoveryHome };
  const failedImportEnv = { ...recoveryEnv, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  const repair = /Cotal update needs repair/g;
  assert.equal((run(["--no-color", "docs"], true, recoveryEnv).match(repair) ?? []).length, 1, "working surface control prints recovery guidance");
  const failed = run(["--no-color", "docs"], true, failedImportEnv, 1);
  const help = run(["--no-color", "docs", "--help"], true, failedImportEnv, 1);
  assert.match(failed, /test surface import failed/);
  assert.match(help, /test surface import failed/);
  assert.doesNotMatch(help, repair);
  assert.equal((failed.match(repair) ?? []).length, 1, "surface import failure must still print recovery guidance");

  const start = recoveryProcessStartToken(process.pid);
  assert.ok(start, "the smoke process must have a start token");
  writeFileSync(recoveryFile, JSON.stringify({ ...record, phase: "replacing", owner: { pid: process.pid, start, nonce: "smoke" } }));
  const active = new RegExp(`An update is in progress in pid ${process.pid}\\. Wait for it to finish\\.`, "g");
  const activeFailed = run(["--no-color", "docs"], true, failedImportEnv, 1);
  assert.match(activeFailed, /test surface import failed/);
  assert.equal((activeFailed.match(active) ?? []).length, 1, "surface import failure must still report a live update");
  assert.doesNotMatch(run(["--no-color", "docs", "--help"], true, failedImportEnv, 1), active);
}
assert.match(run(["update", "--auto", "off"]), /Automatic updates: off/);
assert.match(run(["update", "--auto"]), /Automatic updates: off/);
if (process.platform === "win32") assert.doesNotMatch(run(["update", "--auto"]), /Automatic installation is unavailable on Windows/);
assert.match(run(["--version"], true), /Cotal update available: .* -> 99\.0\.0/);
for (const args of [[], ["--no-color"], ["--no-color", "--help"], ["-h"], ["help"], ["--no-color", "help", "docs"], ["docs", "--help"], ["--", "service", "status", "-h"]]) {
  assert.doesNotMatch(run(args, true), /Cotal update available:/, args.join(" ") || "bare entry");
}
const literal = run(["--no-color", "docs", "--", "--help"], true, {}, 1);
assert.match(literal, /no docs page "--help"/);
assert.match(literal, /Cotal update available: .* -> 99\.0\.0/);
const coldHome = join(root, "cold-home");
assert.match(run(["--no-color", "--help"], true, { COTAL_HOME: coldHome }), /cotal - lateral agent coordination over NATS/);
const bareHome = join(root, "bare-home");
mkdirSync(bareHome, { mode: 0o700 });
assert.match(run([], true, { COTAL_HOME: bareHome }), /Start here/);
await delay(1500);
assert.equal(existsSync(coldHome), false, "interactive help must not create update state");
assert.equal(existsSync(join(bareHome, "update-check.json")), false, "the interactive entry screen must not create an update cache");
assert.doesNotMatch(run(["--version"]), /Cotal update available:/);
assert.doesNotMatch(run(["version", "--json"], true), /Cotal update available:/);
assert.doesNotMatch(run(["config", "--plain"], true), /Cotal update available:/);
assert.doesNotMatch(run(["--version"], true, { CI: "1" }), /Cotal update available:/);
assert.doesNotMatch(run(["--version"], true, { COTAL_NO_UPDATE_CHECK: "1" }), /Cotal update available:/);
assert.match(run(["update", "--notify", "off"]), /Update notices: off/);
assert.doesNotMatch(run(["--version"], true), /Cotal update available:/);
assert.match(run(["update", "--notify", "on"]), /Update notices: on/);
assert.equal((run(["--version"], true).match(/Cotal update available:/g) ?? []).length, 1);
recoveryDuringStartup();
emitSentinel({ passed: counted.cells(), failed: 0 });
