import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { countedAssert, skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux" && process.platform !== "darwin") skipSuite("staged npm execution update requires POSIX");
if (process.getuid?.() === 0) skipSuite("unwritable install requires an unprivileged account");
process.umask(0o077);
const counted = countedAssert(assert);
const check: typeof assert = counted.assert;
const repo = resolve(import.meta.dirname, "../..");
const root = mkdtempSync(join(tmpdir(), "update-self-refusal-"));
const prefix = join(root, "prefix with 'quote");
const installed = join(prefix, "lib/node_modules/cotal-ai");
mkdirSync(installed, { recursive: true });
cpSync(join(repo, "bin/dist"), join(installed, "dist"), { recursive: true });
cpSync(join(repo, "bin/package.json"), join(installed, "package.json"));
symlinkSync(join(repo, "bin/node_modules"), join(installed, "node_modules"));
const home = join(root, "home"), config = join(root, "config"), cotal = join(root, "cotal"), runtime = join(root, "runtime");
for (const path of [home, config, cotal, runtime]) mkdirSync(path, { mode: 0o700 });
const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_")));
const env = { ...clean, HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, COTAL_HOME: cotal, COTAL_NO_UPDATE_CHECK: "1", DO_NOT_TRACK: "1", NO_COLOR: "1" };
const run = () => spawnSync(process.execPath, [join(installed, "dist/cotal.js"), "update", "--self"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
const packageBefore = readFileSync(join(installed, "package.json"), "utf8");
chmodSync(installed, 0o555); chmodSync(join(installed, "dist"), 0o555); chmodSync(join(prefix, "lib"), 0o555);
try {
  const refused = run();
  writeFileSync(join(root, "unwritable.stderr.log"), refused.stderr ?? "");
  check.equal(refused.status, 2, refused.stderr);
  check.match(refused.stderr, /Request refused/);
  check.match(refused.stderr, /installation is not writable/);
  check.match(refused.stderr, /no changes were made/);
  check.match(refused.stderr, /have an administrator run: sudo npm install -g --prefix .*cotal-ai@latest/);
  check.match(refused.stderr, /then run `cotal update` as your normal account, without sudo/);
  const command = refused.stderr.match(/have an administrator run: (.*?); then run `cotal update`/)?.[1];
  check.ok(command, refused.stderr);
  const argumentsOnly = spawnSync("sh", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], { env, encoding: "utf8", timeout: 10_000 });
  check.equal(argumentsOnly.status, 0, argumentsOnly.stderr);
  check.deepEqual(argumentsOnly.stdout.trimEnd().split("\n"), ["sudo", "npm", "install", "-g", "--prefix", prefix, "cotal-ai@latest"]);
  check.doesNotMatch(refused.stderr, /Outcome unconfirmed|OPERATION_UNKNOWN/);
  check.equal(existsSync(join(prefix, "lib/.cotal-generations")), false);
  check.equal(readFileSync(join(installed, "package.json"), "utf8"), packageBefore);
  // On Linux the daemon of this installation runs the same updater when a newer release is due. It
  // records the refusal sentence once, counts no failed attempt and schedules no retry.
  if (process.platform === "linux") {
    const sentence = refused.stderr.match(/This installation cannot update itself from this account: .*; no changes were made/)?.[0];
    check.ok(sentence, refused.stderr);
    const attemptPath = join(cotal, "update-attempt.json");
    writeFileSync(attemptPath, JSON.stringify({ version: "99.0.0", failures: 1, result: "due", next: 0 }));
    writeFileSync(join(cotal, "update-check.json"), JSON.stringify({ v: 1, latest: "99.0.0", attemptedAt: Date.now(), checkedAt: Date.now(), firstSeenAt: Date.now() - 3_601_000 }));
    for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];
    Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, COTAL_HOME: cotal, DO_NOT_TRACK: "1", NO_COLOR: "1" });
    const { automaticUpdates } = await import(pathToFileURL(join(installed, "dist/daemon/auto-update.js")).href) as typeof import("../daemon/auto-update.js");
    const reports: string[] = [];
    const daemon = automaticUpdates({ version: "0.0.1", eligible: () => true, prepare: async () => {}, abort: async () => {}, report: line => reports.push(line) });
    try {
      const deadline = Date.now() + 60_000;
      while (!reports.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 500));
      check.deepEqual(reports, [sentence], "the daemon reports the updater's refusal sentence once");
      const attempt = JSON.parse(readFileSync(attemptPath, "utf8"));
      check.equal(attempt.result, sentence);
      check.equal(attempt.failures, 1, "a refusal before any change is not a failed attempt");
      check.equal(attempt.next, Number.MAX_SAFE_INTEGER, "no retry is scheduled");
      check.equal(daemon.status().nextAttempt, undefined);
      check.equal(daemon.status().lastResult, sentence);
      await new Promise(resolve => setTimeout(resolve, 31_000));
      check.equal(reports.length, 1, "the next scheduler tick starts no updater");
      check.equal(daemon.updating(), false);
    } finally { await daemon.close(); }
  }
  check.equal(existsSync(join(prefix, "lib/.cotal-generations")), false);
  chmodSync(installed, 0o755);
  writeFileSync(join(installed, "desktop-runtime.json"), "{}");
  const desktop = run();
  writeFileSync(join(root, "desktop.stderr.log"), desktop.stderr ?? "");
  check.equal(desktop.status, 2, desktop.stderr);
  check.match(desktop.stderr, /UNSUPPORTED/);
  check.match(desktop.stderr, /no npm self-update was attempted/);
  check.equal(existsSync(join(prefix, "lib/.cotal-generations")), false);
  console.log(`Retained installed-entry evidence: ${root}`);
  console.log(`COTAL_SMOKE_SENTINEL cells=${counted.cells()} passed=${counted.cells()} failed=0`);
} finally {
  chmodSync(installed, 0o755); chmodSync(join(installed, "dist"), 0o755); chmodSync(join(prefix, "lib"), 0o755);
}
