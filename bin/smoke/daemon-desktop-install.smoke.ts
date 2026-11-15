/** Built desktop install readiness with recording systemd tools, never the host service manager. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { peerCredentials } from "@cotal-ai/seat";
import { skipSuite } from "@cotal-ai/smoke-kit";
import { filterDesktopApplicationPath, windowsApplicationPath } from "../daemon/desktop-path.js";
import { daemonPaths } from "../daemon/endpoint.js";
import { excludeLifetime } from "../daemon/lifetime.js";
import { serveDaemon } from "../daemon/server.js";

if (process.platform !== "linux") skipSuite("daemon-desktop-install: Linux recording systemd fixture only");
const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
const nativeEntry = fileURLToPath(new URL("../dist/daemon-native.js", import.meta.url));
const fixture = readFileSync(new URL("fixtures/daemon-systemd-tool.mjs", import.meta.url), "utf8");
const root = mkdtempSync(join(tmpdir(), "desktop-install-"));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const operations = (file: string): string[] => existsSync(file)
  ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line: string) => (JSON.parse(line) as { operation: string }).operation)
  : [];
function isolated(name: string, runNativeOnStart = false) {
  const dir = join(root, name);
  for (const leaf of ["home", "cotal", "cotal/daemon", "config", "rt", "native", "cache", "data", "state"]) mkdirSync(join(dir, leaf), { recursive: true, mode: 0o700 });
  const calls = join(dir, "calls.jsonl");
  const context = join(dir, "context.json");
  writeFileSync(context, JSON.stringify({
    home: join(dir, "home"),
    config: join(dir, "config"),
    cotal: join(dir, "cotal"),
    rt: join(dir, "rt"),
    calls,
    ...(runNativeOnStart ? { nativeEntry } : {}),
    units: ["cotal-daemon.service"],
  }), { mode: 0o600 });
  for (const tool of ["systemctl", "loginctl"]) writeFileSync(join(dir, "native", tool), `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_") && !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
  Object.assign(env, {
    HOME: join(dir, "home"), COTAL_HOME: join(dir, "cotal"), XDG_CONFIG_HOME: join(dir, "config"), XDG_RUNTIME_DIR: join(dir, "rt"),
    XDG_CACHE_HOME: join(dir, "cache"), XDG_DATA_HOME: join(dir, "data"), XDG_STATE_HOME: join(dir, "state"),
    PATH: `${join(dir, "native")}:/usr/local/bin:/usr/bin:/bin`, DAEMON_UNIT_FIXTURE: context, DO_NOT_TRACK: "1",
  });
  for (const profile of [".bash_profile", ".bashrc", ".zprofile", ".zshrc", ".profile"]) writeFileSync(join(dir, "home", profile), `export PATH=${JSON.stringify(env.PATH)}\n`, { mode: 0o600 });
  return { dir, env, calls, receipt: join(dir, "cotal", "daemon", "service-unit.json"), unit: join(dir, "config", "systemd", "user", "cotal-daemon.service") };
}
type Isolated = ReturnType<typeof isolated>;
interface Frame {
  v: number;
  event: string;
  ok?: boolean;
  line?: string;
  progress?: { step: string; outcome: string; detail: string };
  error?: { code: string; message: string; remedy?: string; native?: { code: string; detail?: unknown } };
  result?: { installed: boolean; status: { state: string; pid: number }; omittedRelativePathEntries?: string[] };
}
async function requestFrames(target: Isolated, body: string | Record<string, unknown>, timeoutMs = 35_000): Promise<Frame[]> {
  const payload = typeof body === "string" ? { op: body } : body;
  const label = String(payload.op);
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "daemon", "desktop"], { cwd: target.dir, env: target.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(signal, null, `desktop ${label} signal; ${stderr}`);
        assert.equal(code, 0, `desktop ${label} exit; ${stderr}`);
        const frames = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Frame);
        assert.ok(frames.length > 0 && frames.every((frame) => frame.v === 1));
        assert.equal(frames.at(-1)?.event, "result");
        console.log(`${label}: ${JSON.stringify(frames.at(-1))}`);
        resolve(frames);
      } catch (error) { reject(error); }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}
async function request(target: Isolated, body: string | Record<string, unknown>, timeoutMs = 35_000): Promise<Frame> {
  return (await requestFrames(target, body, timeoutMs)).at(-1)!;
}
function checkInstallation(target: Isolated): void {
  const receipt = JSON.parse(readFileSync(target.receipt, "utf8")) as { unit: string; unitPath: string; unitSha256: string };
  assert.equal(receipt.unit, "cotal-daemon.service");
  assert.equal(receipt.unitPath, target.unit);
  assert.equal(receipt.unitSha256, createHash("sha256").update(readFileSync(target.unit)).digest("hex"));
}

// A real account-shell failure must remain actionable before any service operation.
const shellFailure = isolated("shell-failure");
for (const profile of [".bash_profile", ".bashrc", ".zprofile", ".zshrc", ".profile"]) writeFileSync(join(shellFailure.dir, "home", profile), "exit 1\n", { mode: 0o600 });
const refusedPath = await request(shellFailure, "install");
assert.equal(refusedPath.ok, false);
assert.equal(refusedPath.error?.code, "DEPENDENCY_UNAVAILABLE");
assert.equal(refusedPath.error?.message, "the account's application PATH could not be read; no service was changed");
assert.equal(refusedPath.error?.remedy, "check that your login shell starts successfully, then choose Check again");
assert.deepEqual(operations(shellFailure.calls), [], "PATH refusal precedes service-manager calls");
assert.ok(!existsSync(shellFailure.receipt) && !existsSync(shellFailure.unit), "PATH refusal creates no installation");
console.log("install PATH refusal preserves its message/remedy without service effects");

// A Windows non-timeout PATH read refusal never mentions a login shell.
const winRoot = join(root, "win-system-root");
const winPsDir = join(winRoot, "System32", "WindowsPowerShell", "v1.0");
mkdirSync(winPsDir, { recursive: true, mode: 0o700 });
writeFileSync(join(winPsDir, "powershell.exe"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
const prevSystemRoot = process.env.SystemRoot;
process.env.SystemRoot = winRoot;
try {
  await assert.rejects(
    () => windowsApplicationPath(),
    (err: { code?: string; message?: string; remedy?: string }) => {
      assert.equal(err.code, "DEPENDENCY_UNAVAILABLE");
      assert.equal(err.message, "the account's application PATH could not be read; no service was changed");
      assert.equal(err.remedy, "choose Try again, or run cotal daemon install in a terminal for diagnostics");
      assert.ok(!String(err.remedy).includes("login shell"), "Windows remedy must not mention a login shell");
      return true;
    },
  );
} finally {
  if (prevSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = prevSystemRoot;
}
console.log("windowsApplicationPath non-timeout refusal omits login-shell wording");

// A slow PATH read that exceeds the 30-second bound reports a timeout and never blames the login shell.
const slowShell = isolated("slow-shell");
for (const profile of [".bash_profile", ".bashrc", ".zprofile", ".zshrc", ".profile"]) writeFileSync(join(slowShell.dir, "home", profile), "trap 'exit 143' TERM\nsleep 35 >/dev/null 2>&1 &\nwait\n", { mode: 0o600 });
const slowStart = Date.now();
const timedOutPath = await request(slowShell, "install", 45_000);
const slowElapsed = Date.now() - slowStart;
assert.ok(slowElapsed >= 29_000, `expected 30 s PATH read bound, got ${slowElapsed} ms`);
assert.equal(timedOutPath.ok, false);
assert.equal(timedOutPath.error?.code, "DEPENDENCY_UNAVAILABLE");
assert.equal(timedOutPath.error?.message, "reading the account's application PATH timed out after 30 seconds; no service was changed");
assert.equal(timedOutPath.error?.remedy, "wait a moment and choose Try again");
assert.ok(!String(timedOutPath.error?.remedy).includes("login shell"), "timeout remedy must not mention a login shell");
assert.deepEqual(operations(slowShell.calls), [], "PATH timeout precedes service-manager calls");
assert.ok(!existsSync(slowShell.receipt) && !existsSync(slowShell.unit), "PATH timeout creates no installation");
console.log("install PATH timeout enforces 30 s bound and reports timeout without login-shell wording");

// Filter keeps absolute entries and deduplicates left-out relative entries in login-shell order.
assert.deepEqual(
  filterDesktopApplicationPath("./node_modules/.bin:/usr/local/bin:./bin:./node_modules/.bin:/usr/bin", "/opt/cotal/bin"),
  { path: "/usr/local/bin:/usr/bin:/opt/cotal/bin", omittedRelativeEntries: ["./node_modules/.bin", "./bin"] },
);
assert.throws(() => filterDesktopApplicationPath("./node_modules/.bin", "relative/node"), /absolute, pinned PATH/);

// Terminal `cotal daemon install` keeps refusing when PATH contains a relative entry.
const relativePath = isolated("relative-path");
const relativeLoginPath = `./node_modules/.bin:./bin:./node_modules/.bin:${relativePath.env.PATH}`;
for (const profile of [".bash_profile", ".bashrc", ".zprofile", ".zshrc", ".profile"]) {
  writeFileSync(join(relativePath.dir, "home", profile), `export PATH=${JSON.stringify(relativeLoginPath)}\n`, { mode: 0o600 });
}
const terminalRefused = spawnSync(process.execPath, [cli, "daemon", "install", "--dry-run", "--json"], {
  cwd: relativePath.dir,
  env: { ...relativePath.env, PATH: relativeLoginPath },
  encoding: "utf8",
  timeout: 15_000,
});
assert.notEqual(terminalRefused.status, 0, "terminal install refuses a relative PATH entry");
const terminalEnvelope = JSON.parse(terminalRefused.stdout.trim()) as { outcome: string; error?: { code: string; message: string } };
assert.equal(terminalEnvelope.outcome, "refused");
assert.equal(terminalEnvelope.error?.code, "UNSUPPORTED");
assert.equal(terminalEnvelope.error?.message, "the daemon unit needs an absolute, pinned PATH; a relative or empty entry was not inherited");
assert.ok(!existsSync(relativePath.receipt) && !existsSync(relativePath.unit));
console.log("terminal install: relative PATH entry stays refused by design");

// App bridge install with a relative login-shell PATH entry leaves it out, names it in setup-progress,
// the install receipt and the result, and succeeds.
const relInstalling = requestFrames(relativePath, "install");
void relInstalling.catch(() => {});
let relDaemon: ReturnType<typeof spawn> | undefined;
let relDaemonExit: Promise<void> | undefined;
try {
  const deadline = Date.now() + 10_000;
  while (!operations(relativePath.calls).includes("start") && Date.now() < deadline) await sleep(50);
  assert.ok(operations(relativePath.calls).includes("start"), "relative-PATH install reached native start");
  relDaemon = spawn(process.execPath, [cli, "daemon", "serve"], { cwd: relativePath.dir, env: relativePath.env, stdio: ["ignore", "ignore", "pipe"] });
  relDaemonExit = new Promise<void>((resolve, reject) => { relDaemon!.once("error", reject); relDaemon!.once("close", () => resolve()); });
  const relFrames = await relInstalling;
  const progressFrame = relFrames.find((frame) => frame.event === "setup-progress");
  assert.deepEqual(progressFrame, {
    v: 1,
    event: "setup-progress",
    line: "service: left out relative PATH entries: ./node_modules/.bin, ./bin",
    progress: { step: "install", outcome: "running", detail: "left out relative PATH entries: ./node_modules/.bin, ./bin" },
  });
  const relReady = relFrames.at(-1)!;
  assert.equal(relReady.ok, true);
  assert.equal(relReady.result?.installed, true);
  assert.deepEqual(relReady.result?.omittedRelativePathEntries, ["./node_modules/.bin", "./bin"]);
  checkInstallation(relativePath);
  const recordedReceipt = JSON.parse(readFileSync(relativePath.receipt, "utf8")) as { omittedRelativePathEntries?: string[] };
  assert.deepEqual(recordedReceipt.omittedRelativePathEntries, ["./node_modules/.bin", "./bin"]);
  const unitSource = readFileSync(relativePath.unit, "utf8");
  assert.ok(!unitSource.includes("./node_modules/.bin") && !unitSource.includes("./bin"), "unit file pins only absolute PATH entries");
  // When an install or setup fails after dropping relative entries, the failure message also names them.
  writeFileSync(relativePath.unit, `${unitSource}\n# modified\n`, { mode: 0o600 });
  const failedWithOmitted = await request(relativePath, "install");
  assert.equal(failedWithOmitted.ok, false);
  assert.equal(failedWithOmitted.error?.code, "CONFLICT");
  assert.match(failedWithOmitted.error?.message ?? "", /Left out relative PATH entries: \.\/node_modules\/\.bin, \.\/bin\.$/);
  console.log("desktop bridge install: relative login-shell PATH entries left out and named in progress, receipt, result and failure");
} finally {
  if (relDaemon && relDaemon.exitCode === null && relDaemon.signalCode === null) {
    relDaemon.kill("SIGTERM");
    const timer = setTimeout(() => relDaemon!.kill("SIGKILL"), 5_000);
    try { await relDaemonExit; } finally { clearTimeout(timer); }
  }
  await relInstalling.catch(() => {});
}

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
  const answering = await request(control, "status");
  assert.equal(answering.ok, true, "status answers while the installed daemon runs");
  console.log("positive control: fresh install and already-answering install passed");
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill("SIGTERM");
    const timer = setTimeout(() => daemon!.kill("SIGKILL"), 5_000);
    try { await daemonExit; } finally { clearTimeout(timer); }
  }
  await installing.catch(() => {});
}

// An installed service whose daemon stopped is not a missing installation.
checkInstallation(control);
const beforeStatus = operations(control.calls);
const stopped = await request(control, "status");
assert.equal(stopped.error?.code, "NOT_RUNNING");
assert.equal(stopped.error?.message, "The background service is installed but stopped. Choose Start service to start it.");
assert.deepEqual(operations(control.calls).slice(beforeStatus.length), ["directory-read"], "a status request reads the installation and starts nothing");
console.log("installed and stopped: status names the stopped service, not a missing installation");

// Produce a real earlier-launch daemon.log on `control` before the install request starts, so its
// launch timestamp is strictly older than the install attempt and must not be reported.
const staleLock = excludeLifetime(join(control.dir, "cotal", "daemon", "daemon.lock"));
try {
  spawnSync(process.execPath, [nativeEntry, "daemon", "serve"], { cwd: control.dir, env: control.env, stdio: "ignore", timeout: 10_000 });
} finally {
  staleLock.release();
}
const staleLog = readFileSync(join(control.dir, "cotal", "daemon", "daemon.log"), "utf8");
assert.match(staleLog, /^daemon service launch \S+\ndaemon startup refused: /);
await sleep(10);

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
  assert.equal(timedOut.error?.native?.code, "NOT_ANSWERING");
  assert.equal(timedOut.error?.message, "Cotal asked the background service on this computer to start, and it did not answer within 15 seconds.");
  assert.equal(timedOut.error?.remedy, "choose Check status.");
  assert.ok(!JSON.stringify(timedOut).includes(target.dir), "fixed app guidance contains no private path or stale launch refusal");
  console.log(`${target === control ? "recorded start (stale log ignored)" : "fresh install"}: readiness timeout passed`);
}

// A refusal written during this install attempt is included with the "daemon startup refused:" prefix removed.
const refusedStart = isolated("refused-start", true);
const heldLock = excludeLifetime(join(refusedStart.dir, "cotal", "daemon", "daemon.lock"));
try {
  const started = Date.now();
  const timedOut = await request(refusedStart, "install");
  assert.ok(Date.now() - started >= 15_000, "real readiness window elapsed for refused start");
  checkInstallation(refusedStart);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error?.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(timedOut.error?.native?.code, "NOT_ANSWERING");
  assert.equal(
    timedOut.error?.message,
    `Cotal asked the background service on this computer to start, and it did not answer within 15 seconds. It refused to start: ${join(refusedStart.dir, "cotal", "daemon", "daemon.lock")} is held by a live process: this daemon is already being served. Nothing was changed`,
  );
  assert.equal(timedOut.error?.remedy, "choose Check status.");
  console.log("refused start: current-attempt daemon.log refusal included");
} finally {
  heldLock.release();
}

// Setup-path non-answer gets the 60-second app wording and attempt-scoped refusal, while an answering
// daemon on an older version does not carry NOT_ANSWERING. Both run over the real 60-second window.
const setupNonAnswerTarget = isolated("setup-not-answering", true);
const setupHeld = excludeLifetime(join(setupNonAnswerTarget.dir, "cotal", "daemon", "daemon.lock"));
const oldDaemon = await serveDaemon({
  paths: daemonPaths(control.env, join(control.dir, "cotal")),
  version: "0.0.0-old",
  peerUid: (sock) => peerCredentials(sock).uid,
});
try {
  const setupStarted = Date.now();
  const [setupTimedOut, oldVersionReply] = await Promise.all([
    request(setupNonAnswerTarget, { op: "setup", space: "team", idp: "https://cotal.cloud/api/auth" }, 90_000),
    request(control, { op: "setup", space: "team", idp: "https://cotal.cloud/api/auth" }, 90_000),
  ]);
  assert.ok(Date.now() - setupStarted >= 60_000, "real 60s setup readiness window elapsed");
  checkInstallation(setupNonAnswerTarget);
  assert.equal(setupTimedOut.ok, false);
  assert.equal(setupTimedOut.error?.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(setupTimedOut.error?.native?.code, "NOT_ANSWERING");
  assert.equal(
    setupTimedOut.error?.message,
    `Cotal asked the background service on this computer to start, and it did not answer within 60 seconds. It refused to start: ${join(setupNonAnswerTarget.dir, "cotal", "daemon", "daemon.lock")} is held by a live process: this daemon is already being served. Nothing was changed`,
  );
  assert.equal(setupTimedOut.error?.remedy, "choose Check status.");
  console.log("setup non-answer: real 60s window, app wording and current-attempt refusal included");

  assert.equal(oldVersionReply.ok, false);
  assert.equal(oldVersionReply.error?.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(oldVersionReply.error?.native, undefined, "an answering old daemon does not carry NOT_ANSWERING");
  assert.match(oldVersionReply.error?.message ?? "", /^the daemon did not answer .* within 60s of being started; nothing was registered$/);
  console.log("setup old-version answer: real 60s window, does not carry NOT_ANSWERING");
} finally {
  setupHeld.release();
  await oldDaemon.close();
}
console.log(`daemon-desktop-install: passed; isolated evidence retained at ${root}`);
