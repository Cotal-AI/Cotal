/** Opt-in lifecycle of a real per-user service on disposable GitHub-hosted macOS/Windows runners.
 * Uses the built CLI and its ownership checks. Never signs in, connects, or force-removes a job.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

if (process.env.COTAL_TEST_REAL_SERVICE !== "1" || process.env.GITHUB_ACTIONS !== "true"
  || process.env.RUNNER_ENVIRONMENT !== "github-hosted"
  || !["darwin", "win32"].includes(process.platform) || !process.env.RUNNER_TEMP) {
  console.error("REFUSED: real daemon service tests require explicit opt-in on a disposable GitHub-hosted macOS/Windows runner.");
  process.exit(2);
}

const { mkSecretDir } = await import("@cotal-ai/core");
const { daemonPathsFor } = await import("../dist/daemon/endpoint.js");
const cli = fileURLToPath(new URL("../dist/cotal.js", import.meta.url));
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
    outcome: body?.outcome, code: body?.error?.code, nativeCode: body?.error?.cause?.code };
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

async function verifyRemoved() {
  check("receipt removed", !existsSync(receipt));
  check("service source removed", !existsSync(plan.unitPath));
  // The shipped plan reads the exact native job and refuses anything except absence. An arbitrary
  // nonzero schtasks exit is not evidence of absence, and launchctl display text is not authority.
  const absent = ok("install", "--dry-run");
  check("native supervisor confirms the same isolated name is absent", absent.state === "would-install"
    && absent.unit === plan.unit && absent.sha256 === plan.sha256);
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
      : /^cotal-daemon-[a-f0-9]{16}-S-1-/.test(plan.unit) && plan.mechanism === "scheduled-task"));
  installAttempted = true;
  const installed = ok("install");
  check("install confirms the planned service", installed.state === "installed" && installed.unit === plan.unit);
  const recorded = JSON.parse(readFileSync(receipt, "utf8"));
  check("receipt records the planned source and home", recorded.unit === plan.unit
    && recorded.unitSha256 === plan.sha256 && recorded.unitPath === plan.unitPath && recorded.daemonHome === home);
  const first = (await statusUntil(true)).body.result;
  check("installed service answers with a PID and start time", Number.isInteger(first.pid) && first.pid > 0 && typeof first.startedAt === "string");
  ok("start");
  const second = (await statusUntil(true)).body.result;
  check("start preserves the running instance", second.pid === first.pid && second.startedAt === first.startedAt);
  uninstallAttempted = true;
  const removed = ok("uninstall", "--yes");
  check("uninstall confirms the planned service", removed.state === "removed" && removed.unit === plan.unit);
  await verifyRemoved();
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
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
  report.passed = report.checks.filter(c => c.passed).length;
  report.failed = report.checks.filter(c => !c.passed).length;
  writeFileSync(join(process.env.RUNNER_TEMP, "daemon-service-result.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(report));
}
