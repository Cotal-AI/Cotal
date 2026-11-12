/** Built desktop install readiness with recording systemd tools, never the host service manager. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { skipSuite } from "@cotal-ai/smoke-kit";

if (process.platform !== "linux") skipSuite("daemon-desktop-install: Linux recording systemd fixture only");
const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const fixture = readFileSync(new URL("fixtures/daemon-systemd-tool.mjs", import.meta.url), "utf8");
const root = mkdtempSync(join(tmpdir(), "desktop-install-"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const operations = (file: string): string[] => existsSync(file)
  ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line: string) => (JSON.parse(line) as { operation: string }).operation)
  : [];
function isolated(name: string) {
  const dir = join(root, name);
  for (const leaf of ["home", "cotal", "config", "rt", "native", "cache", "data", "state"]) mkdirSync(join(dir, leaf), { recursive: true, mode: 0o700 });
  const calls = join(dir, "calls.jsonl");
  const context = join(dir, "context.json");
  writeFileSync(context, JSON.stringify({ home: join(dir, "home"), config: join(dir, "config"), calls, units: ["cotal-daemon.service"] }), { mode: 0o600 });
  for (const tool of ["systemctl", "loginctl"]) writeFileSync(join(dir, "native", tool), `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
  Object.assign(env, {
    HOME: join(dir, "home"), COTAL_HOME: join(dir, "cotal"), XDG_CONFIG_HOME: join(dir, "config"), XDG_RUNTIME_DIR: join(dir, "rt"),
    XDG_CACHE_HOME: join(dir, "cache"), XDG_DATA_HOME: join(dir, "data"), XDG_STATE_HOME: join(dir, "state"),
    PATH: `${join(dir, "native")}:/usr/local/bin:/usr/bin:/bin`, DAEMON_UNIT_FIXTURE: context, DO_NOT_TRACK: "1",
  });
  for (const profile of [".bash_profile", ".zprofile", ".profile"]) writeFileSync(join(dir, "home", profile), `export PATH=${JSON.stringify(env.PATH)}\n`, { mode: 0o600 });
  return { dir, env, calls, receipt: join(dir, "cotal", "daemon", "service-unit.json"), unit: join(dir, "config", "systemd", "user", "cotal-daemon.service") };
}
type Isolated = ReturnType<typeof isolated>;
interface Frame {
  v: number;
  event: string;
  ok: boolean;
  error?: { code: string; message: string; remedy?: string };
  result?: { installed: boolean; status: { state: string; pid: number } };
}
async function request(target: Isolated, op: string): Promise<Frame> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "daemon", "desktop"], { cwd: target.dir, env: target.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 35_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(signal, null, `desktop ${op} signal; ${stderr}`);
        assert.equal(code, 0, `desktop ${op} exit; ${stderr}`);
        const frame = JSON.parse(stdout.trim()) as Frame;
        assert.equal(frame.v, 1);
        assert.equal(frame.event, "result");
        console.log(`${op}: ${JSON.stringify(frame)}`);
        resolve(frame);
      } catch (error) { reject(error); }
    });
    child.stdin.end(`${JSON.stringify({ op })}\n`);
  });
}
function checkInstallation(target: Isolated): void {
  const receipt = JSON.parse(readFileSync(target.receipt, "utf8")) as { unit: string; unitPath: string; unitSha256: string };
  assert.equal(receipt.unit, "cotal-daemon.service");
  assert.equal(receipt.unitPath, target.unit);
  assert.equal(receipt.unitSha256, createHash("sha256").update(readFileSync(target.unit)).digest("hex"));
}

// A real account-shell failure must remain actionable before any service operation.
const shellFailure = isolated("shell-failure");
for (const profile of [".bash_profile", ".zprofile", ".profile"]) writeFileSync(join(shellFailure.dir, "home", profile), "exit 1\n", { mode: 0o600 });
const refusedPath = await request(shellFailure, "install");
assert.equal(refusedPath.ok, false);
assert.equal(refusedPath.error?.code, "DEPENDENCY_UNAVAILABLE");
assert.equal(refusedPath.error?.message, "the account's application PATH could not be read; no service was changed");
assert.equal(refusedPath.error?.remedy, "check that your login shell starts successfully, then choose Check again");
assert.deepEqual(operations(shellFailure.calls), [], "PATH refusal precedes service-manager calls");
assert.ok(!existsSync(shellFailure.receipt) && !existsSync(shellFailure.unit), "PATH refusal creates no installation");
console.log("install PATH refusal preserves its message/remedy without service effects");

// First prove that the real installed-service path can reach an answering foreground daemon.
const control = isolated("control");
const absent = await request(control, "status");
assert.equal(absent.error?.code, "NOT_RUNNING");
assert.equal(absent.error?.message, "The daemon is not running. Install its background service first.");
assert.ok(!existsSync(control.receipt));
const installing = request(control, "install");
// Observe rejection immediately even if a later setup assertion throws before we await it.
void installing.catch(() => {});
let daemon: ReturnType<typeof spawn> | undefined;
let daemonExit: Promise<void> | undefined;
try {
  const deadline = Date.now() + 10_000;
  while (!operations(control.calls).includes("start") && Date.now() < deadline) await sleep(50);
  assert.ok(operations(control.calls).includes("start"), "recording fixture received start");
  daemon = spawn(process.execPath, [cli, "daemon", "serve"], { cwd: control.dir, env: control.env, stdio: ["ignore", "ignore", "pipe"] });
  let diagnostics = "";
  daemon.stderr?.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
  daemonExit = new Promise<void>((resolve, reject) => { daemon!.once("error", reject); daemon!.once("close", () => resolve()); });
  const ready = await installing;
  assert.equal(ready.ok, true, diagnostics);
  assert.equal(ready.result?.installed, true);
  assert.equal(ready.result?.status.state, "ready");
  assert.equal(ready.result?.status.pid, daemon.pid);
  checkInstallation(control);
  const before = operations(control.calls);
  assert.deepEqual(before, ["directory-read", "linger-read", "daemon-reload", "enable", "start"]);
  const alreadyRunning = await request(control, "install");
  assert.equal(alreadyRunning.ok, true);
  assert.deepEqual(operations(control.calls).slice(before.length), ["directory-read"], "an answering installation receives no native start");
  console.log("positive control: fresh install and already-answering install passed");
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill("SIGTERM");
    const timer = setTimeout(() => daemon!.kill("SIGKILL"), 5_000);
    try { await daemonExit; } finally { clearTimeout(timer); }
  }
  await installing.catch(() => {});
}

// The same timeout classification applies after a fresh install and a recorded-service start.
for (const target of [isolated("timeout"), control]) {
  const before = operations(target.calls);
  const started = Date.now();
  const timedOut = await request(target, "install");
  assert.ok(Date.now() - started >= 15_000, "real readiness window elapsed");
  checkInstallation(target);
  assert.deepEqual(operations(target.calls).slice(before.length), target === control
    ? ["directory-read", "directory-read", "start"] : ["directory-read", "linger-read", "daemon-reload", "enable", "start"]);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error?.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(timedOut.error?.message, "The background service was installed and a start was requested, but the daemon did not answer within 15 seconds. Use cotal daemon status for diagnostics.");
  assert.ok(!JSON.stringify(timedOut).includes(target.dir), "fixed app guidance contains no private path");
  console.log(`${target === control ? "recorded start" : "fresh install"}: readiness timeout passed`);
}
console.log(`daemon-desktop-install: passed; isolated evidence retained at ${root}`);
