import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mkSecretDir } from "../../packages/core/dist/index.js";

assert.equal(process.platform, "win32");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");

const root = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP, "cotal-slow-install-")));
mkSecretDir(root);
const home = join(root, "daemon");
mkSecretDir(home);
const preload = join(root, "delay-task-read.cjs");
const receipt = join(home, "service-unit.json");
const cli = resolve("bin/dist/cotal.js");
writeFileSync(preload, String.raw`
const childProcess = require("node:child_process");
const spawn = childProcess.spawnSync;
let injected = false;
childProcess.spawnSync = (file, args, options) => {
  const encoded = args.indexOf("-EncodedCommand");
  if (!injected && /\\powershell\.exe$/i.test(file) && encoded !== -1 && options.env?.COTAL_DAEMON_TASK) {
    const script = Buffer.from(args[encoded + 1], "base64").toString("utf16le");
    if (script.includes("Import-Module ScheduledTasks") && script.includes("Get-ScheduledTask")) {
      injected = true;
      args = [...args];
      args[encoded + 1] = Buffer.from("Start-Sleep -Seconds 40\n" + script, "utf16le").toString("base64");
      const start = Date.now();
      const result = spawn(file, args, options);
      process.stderr.write("READ_TASK: elapsed=" + (Date.now() - start) + "ms status=" + result.status + " error=" + (result.error?.code ?? "none") + "\n");
      if (result.error?.code === "ETIMEDOUT") {
        const replayStart = Date.now();
        const replay = spawn(file, args, { ...options, timeout: 120_000 });
        process.stderr.write("READ_TASK uninterrupted probe: elapsed=" + (Date.now() - replayStart) + "ms status=" + replay.status + " error=" + (replay.error?.code ?? "none") + "\n");
      }
      return result;
    }
  }
  return spawn(file, args, options);
};
require("node:module").syncBuiltinESMExports();
`);

function call(verb, flags = [], slow = false) {
  const args = [...(slow ? ["--require", preload] : []), cli, "daemon", verb, "--daemon-home", home, "--json", ...flags];
  const start = Date.now();
  const child = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 190_000, windowsHide: true });
  console.log(JSON.stringify({ verb, flags, slow, elapsedMs: Date.now() - start, status: child.status, stdout: child.stdout, stderr: child.stderr }));
  assert.ifError(child.error);
  return { exit: child.status, body: JSON.parse(child.stdout), diagnostic: child.stderr };
}

try {
  const plan = call("install", ["--dry-run"]);
  assert.equal(plan.exit, 0);
  assert.equal(plan.body.result.state, "would-install");
  const install = call("install", [], true);
  assert.match(install.diagnostic, /READ_TASK: elapsed=\d+ms/);
  if (install.exit !== 0) {
    assert.equal(install.exit, 2);
    assert.equal(install.body.error.code, "DEPENDENCY_UNAVAILABLE");
    assert.match(install.body.error.message, /powershell\.exe timed out after 30 s/i);
    assert.match(install.diagnostic, /READ_TASK uninterrupted probe: elapsed=[4-9]\d{4}ms status=0 error=none/);
    assert.equal(existsSync(receipt), false);
    assert.equal(call("install", ["--dry-run"]).exit, 0, "the task remained absent after refusal");
    throw new Error("Reproduced: the CLI refused the slow but successful Task Scheduler read at 30 seconds");
  }
  assert.match(install.diagnostic, /READ_TASK: elapsed=[4-9]\d{4}ms status=0 error=none/);
  assert.equal(install.body.result.state, "installed");
  assert.equal(install.body.result.unit, plan.body.result.unit);
  const deadline = Date.now() + 30_000;
  do {
    const status = call("status");
    if (status.exit === 0 && status.body.result.state === "ready") break;
    assert.ok(Date.now() < deadline, "installed daemon did not reach ready");
    await delay(500);
  } while (true);
} finally {
  if (existsSync(receipt)) {
    assert.equal(call("uninstall", ["--yes"]).exit, 0);
    assert.equal(existsSync(receipt), false);
    assert.equal(call("install", ["--dry-run"]).exit, 0, "the task was removed");
  }
  rmSync(root, { recursive: true });
}
