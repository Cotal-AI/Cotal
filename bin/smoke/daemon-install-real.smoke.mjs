/** Opt-in lifecycle of a real per-user service on disposable GitHub-hosted Linux/macOS/Windows runners.
 * Uses the built CLI and its ownership checks. Never signs in, connects, or force-removes a job.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.env.COTAL_TEST_REAL_SERVICE !== "1" || process.env.GITHUB_ACTIONS !== "true"
  || process.env.RUNNER_ENVIRONMENT !== "github-hosted"
  || !["linux", "darwin", "win32"].includes(process.platform) || !process.env.RUNNER_TEMP) {
  console.error("REFUSED: real daemon service tests require explicit opt-in on a disposable GitHub-hosted Linux/macOS/Windows runner.");
  process.exit(2);
}

const packageRoot = process.env.COTAL_TEST_PACKAGE_ROOT ? resolve(process.env.COTAL_TEST_PACKAGE_ROOT) : fileURLToPath(new URL("..", import.meta.url));
const cli = join(packageRoot, "dist", "cotal.js");
const installedImport = name => pathToFileURL(join(packageRoot, "dist", "daemon", name)).href;
const coreRoot = join(packageRoot, "node_modules", "@cotal-ai", "core");
const coreManifest = JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8"));
assert.equal(coreManifest.name, "@cotal-ai/core");
assert.equal(coreManifest.version, JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version);
const { mkSecretDir } = await import(pathToFileURL(join(coreRoot, "dist", "index.js")).href);
const { daemonPathsFor } = await import(installedImport("endpoint.js"));
assert.ok(existsSync(cli), "build the stock CLI first");
const root = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP, "cotal-service-")));
mkSecretDir(root);
const home = join(root, "daemon");
mkSecretDir(home);
const paths = daemonPathsFor(home);
const receipt = join(home, "service-unit.json");
const report = { platform: process.platform, checks: [], calls: [], cleanup: "not-needed" };
let plan;
let installAttempted = false;
let uninstallAttempted = false;
let uncertain = false;
let clean = false;

function check(name, condition) {
  report.checks.push({ name, passed: Boolean(condition) });
  assert.ok(condition, name);
}

function call(verb, ...flags) {
  const child = spawnSync(process.execPath, [cli, "daemon", verb, "--daemon-home", home, "--json", ...flags], {
    encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let body;
  try { body = JSON.parse(child.stdout); } catch { /* Recorded below without exposing raw native output. */ }
  const row = { verb, dryRun: flags.includes("--dry-run"), exit: child.status, signal: child.signal,
    outcome: body?.outcome, code: body?.error?.code, nativeCode: body?.error?.cause?.code,
    ...(body?.error ? { message: body.error.message, remedy: body.error.remedy } : {}) };
  report.calls.push(row);
  if (child.error || child.signal || child.status === null) {
    uncertain = true;
    throw new Error(`${verb}: command outcome unknown; retained for runner disposal`);
  }
  assert.equal(body?.schemaVersion, 1, `${verb}: expected CLI JSON envelope`);
  return { body, exit: child.status };
}

function ok(verb, ...flags) {
  const r = call(verb, ...flags);
  assert.equal(r.exit, 0, `${verb}: ${r.body.error?.code ?? r.body.outcome}`);
  assert.equal(r.body.outcome, "ok", `${verb}: expected confirmed success`);
  return r.body.result;
}

async function statusUntil(ready) {
  const deadline = Date.now() + 30_000;
  let r;
  do {
    r = call("status");
    if (ready ? r.exit === 0 && r.body.result?.state === "ready"
      : r.exit === 2 && r.body.error?.cause?.code === "NOT_RUNNING") return r;
    if (r.exit !== 0 && r.body.error?.cause?.code !== "NOT_RUNNING") break;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error(`status did not become ${ready ? "ready" : "NOT_RUNNING"}: ${r.body.error?.code ?? r.body.outcome}`);
}

/** Read only named systemd properties, never its process arguments or environment. */
function linuxUnit() {
  const child = spawnSync("/usr/bin/systemctl", ["--user", "show", plan.unit, "--all", "--no-pager",
    "--property=LoadState,ActiveState,FragmentPath,MainPID"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(!child.error && !child.signal && (child.status === 0 || child.status === 4), "systemd property lookup completed");
  const entries = child.stdout.trim().split("\n").map(line => {
    const at = line.indexOf("=");
    assert.ok(at > 0, "systemd returned property assignments");
    return [line.slice(0, at), line.slice(at + 1)];
  });
  assert.deepEqual(entries.map(([key]) => key).sort(), ["ActiveState", "FragmentPath", "LoadState", "MainPID"]);
  return Object.fromEntries(entries);
}

function linuxUnitAbsent() {
  const unit = linuxUnit();
  return unit.LoadState === "not-found" && unit.ActiveState === "inactive"
    && unit.FragmentPath === "" && unit.MainPID === "0";
}

async function verifyRemoved() {
  check("receipt removed", !existsSync(receipt));
  check("service source removed", !existsSync(plan.unitPath));
  // macOS/Windows plans read the native job. Linux's plan only renders the unit, so also require
  // systemd's explicit not-found state. An arbitrary nonzero native exit is never absence proof.
  const absent = ok("install", "--dry-run");
  check("native supervisor confirms the same isolated name is absent", absent.state === "would-install"
    && absent.unit === plan.unit && absent.sha256 === plan.sha256
    && (process.platform !== "linux" || linuxUnitAbsent()));
  await statusUntil(false);
  check("local endpoint refuses NOT_RUNNING", true);
  clean = true;
  report.cleanup = "verified-removed";
}

try {
  plan = ok("install", "--dry-run");
  check("plan isolates the daemon home and native service", plan.daemonHome === home
    && plan.state === "would-install" && (process.platform === "darwin"
      ? /^ai\.cotal\.daemon\.[a-f0-9]{16}$/.test(plan.unit) && plan.mechanism === "launchd-agent"
      : process.platform === "win32"
        ? /^cotal-daemon-[a-f0-9]{16}-S-1-/.test(plan.unit) && plan.mechanism === "scheduled-task"
        : /^cotal-daemon-[a-f0-9]{16}\.service$/.test(plan.unit) && plan.mechanism === "systemd-user"));
  if (process.platform === "linux") {
    check("systemd confirms the isolated unit is absent before install", !existsSync(plan.unitPath) && linuxUnitAbsent());
    check("Linux plan uses the prepared lingering user service", plan.lingerAlready === true
      && plan.restart === "always" && plan.wantedBy === "default.target");
  }
  installAttempted = true;
  const installed = ok("install");
  check("install confirms the planned service", installed.state === "installed" && installed.unit === plan.unit);
  const recorded = JSON.parse(readFileSync(receipt, "utf8"));
  check("receipt records the planned source and home", recorded.unit === plan.unit
    && recorded.unitSha256 === plan.sha256 && recorded.unitPath === plan.unitPath && recorded.daemonHome === home);
  const first = (await statusUntil(true)).body.result;
  check("installed service answers with a PID and start time", Number.isInteger(first.pid) && first.pid > 0 && typeof first.startedAt === "string");
  if (process.platform === "linux") {
    const unit = linuxUnit();
    check("systemd supervises the answering daemon from the recorded unit", unit.LoadState === "loaded"
      && unit.ActiveState === "active" && unit.FragmentPath === plan.unitPath && Number(unit.MainPID) === first.pid);
  }
  ok("start");
  const second = (await statusUntil(true)).body.result;
  check("start preserves the running instance", second.pid === first.pid && second.startedAt === first.startedAt);
  if (process.platform === "win32") {
    const seatRoot = join(packageRoot, "node_modules", "@cotal-ai", "seat");
    const seatManifest = JSON.parse(readFileSync(join(seatRoot, "package.json"), "utf8"));
    check("installed seat helper matches the installed CLI version", seatManifest.name === "@cotal-ai/seat"
      && seatManifest.version === JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version);
    const { processStartTime } = await import(pathToFileURL(join(seatRoot, "dist", "index.js")).href);
    const beforeBirth = processStartTime(second.pid);
    check("restart pins the old daemon's kernel birth", typeof beforeBirth === "string" && beforeBirth.length > 0);
    const sourceBefore = readFileSync(plan.unitPath);
    const receiptBefore = readFileSync(receipt);
    const script = `process.argv=[process.execPath,${JSON.stringify(cli)}]; process.execArgv=[]; const {restartInstalled}=await import(${JSON.stringify(installedImport("install.js"))}); const {daemonPathsFor}=await import(${JSON.stringify(installedImport("endpoint.js"))}); await restartInstalled(daemonPathsFor(${JSON.stringify(home)}),${JSON.stringify(home)});`;
    const restarted = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 240_000, maxBuffer: 256 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    report.calls.push({ verb: "restartInstalled", exit: restarted.status, signal: restarted.signal, stderr: (restarted.stderr ?? "").slice(0, 4096) });
    if (restarted.error || restarted.signal || restarted.status === null) uncertain = true;
    check("shipped installed restart completes", restarted.status === 0 && !restarted.error && !restarted.signal);
    const replacement = (await statusUntil(true)).body.result;
    const afterBirth = processStartTime(replacement.pid);
    check("restart replaces the old kernel lifetime", typeof afterBirth === "string"
      && (replacement.pid !== second.pid || afterBirth !== beforeBirth) && processStartTime(second.pid) !== beforeBirth);
    check("restart retains the exact task source and receipt", readFileSync(plan.unitPath).equals(sourceBefore) && readFileSync(receipt).equals(receiptBefore));
  }
  uninstallAttempted = true;
  const removed = ok("uninstall", "--yes");
  check("uninstall confirms the planned service", removed.state === "removed" && removed.unit === plan.unit);
  await verifyRemoved();
  if (process.platform === "win32") {
    // End only the just-installed, receipt-verified direct-Node task. This models a
    // daemon already ended by the operator without signalling a PID or foreign task.
    clean = false;
    uninstallAttempted = false;
    ok("install");
    await statusUntil(true);
    ok("uninstall", "--dry-run");
    const ended = spawnSync(join(process.env.SystemRoot, "System32", "schtasks.exe"), ["/End", "/TN", plan.unit], {
      encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    check("owned installed task can be ended before uninstall", ended.status === 0 && !ended.error && !ended.signal);
    await statusUntil(false);
    uninstallAttempted = true;
    check("installed stopped daemon uninstall succeeds", ok("uninstall", "--yes").state === "removed");
    await verifyRemoved();
    const delayed = spawnSync(process.execPath, [join(dirname(cli), "daemon-native.js"), "daemon", "serve", "--daemon-home", home], {
      encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    check("delayed native child after uninstall refuses", delayed.status !== null && delayed.status !== 0 && !delayed.error && !delayed.signal);
    await statusUntil(false);
    check("delayed native child published no endpoint or receipt", !existsSync(receipt));
  }
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
  if (process.platform === "win32" && installAttempted && plan) {
    // Filter before logging: /V also prints the task's process arguments and user environment.
    const task = spawnSync(join(process.env.SystemRoot, "System32", "schtasks.exe"),
      ["/Query", "/TN", plan.unit, "/V", "/FO", "LIST"], {
        encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    report.scheduledTask = { exit: task.status, signal: task.signal,
      summary: (task.stdout ?? "").split(/\r?\n/).filter(line => /^\s*(Status|Last Result|Last Run Time)\s*:/.test(line)),
      log: join(paths.state, "daemon.log") };
  }
  if (process.platform === "darwin" && installAttempted && existsSync(receipt)) {
    try {
      const { darwinLaunchdJob } = await import("@cotal-ai/seat");
      const observed = darwinLaunchdJob(plan.unit);
      const plist = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plan.unitPath], {
        encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024, stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(plist.status, 0, "read the owned plist as data");
      const expected = JSON.parse(plist.stdout);
      // Presence/equality only: native process arguments never enter logs or artifacts.
      report.launchd = { state: observed.state };
      if (observed.state === "loaded") {
        const job = observed.job;
        Object.assign(report.launchd, {
          labelMatches: job.label === expected.Label,
          programPresent: typeof job.program === "string",
          programMatches: job.program === expected.ProgramArguments?.[0],
          argumentsPresent: Array.isArray(job.programArguments),
          argumentsMatch: JSON.stringify(job.programArguments) === JSON.stringify(expected.ProgramArguments),
          workingDirectoryPresent: typeof job.workingDirectory === "string",
          workingDirectoryMatches: job.workingDirectory === expected.WorkingDirectory,
        });
      }
    } catch { report.launchd = { diagnostic: "unavailable" }; }
  }
} finally {
  if (installAttempted && !clean) {
    report.cleanup = "retained";
    // One native, receipt-guarded cleanup attempt after a completed failed install/start. Never
    // repeat an unknown mutation or bypass a refused uninstall with OS commands.
    if (!uncertain && !uninstallAttempted && existsSync(receipt)) {
      try {
        uninstallAttempted = true;
        ok("uninstall", "--yes");
        await verifyRemoved();
      } catch (error) { report.cleanupFailure = error.message; }
    }
  }
  if (!installAttempted || clean) {
    if (clean && paths.dir) rmSync(paths.dir, { recursive: true, force: true });
    rmSync(root, { recursive: true });
  } else report.retainedHome = home;
  report.outcome = process.exitCode ? "failed" : "passed";
  report.passed = report.checks.filter(c => c.passed).length;
  report.failed = report.checks.filter(c => !c.passed).length;
  writeFileSync(join(process.env.RUNNER_TEMP, "daemon-service-result.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(report));
}
