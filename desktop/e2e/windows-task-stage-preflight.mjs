import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measureTaskStages } from "./windows-task-stage-measure.mjs";

assert.equal(process.platform, "win32");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.ok(process.env.RUNNER_TEMP);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ownerPath = join(process.env.RUNNER_TEMP, "windows-task-stage-owner.json");
const output = join(process.env.RUNNER_TEMP, "desktop-windows-task-stages");
mkdirSync(output, { recursive: true });
const native = (file, args, env = process.env) => {
  const result = spawnSync(join(process.env.SystemRoot, "System32", file), args, { env, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  assert.ok(!result.error && !result.signal && result.status === 0, `${file} fixture operation must confirm success, never retry or force it`);
  return result.stdout;
};
const hash = value => createHash("sha256").update(value).digest("hex");
if (process.argv[2] === "cleanup") {
  writeFileSync(join(output, "cleanup.json"), JSON.stringify({ removed: false, outcome: existsSync(ownerPath) ? "cleanup-outstanding" : "setup-unknown", reason: "preflight-or-build-failed", owner: "this GitHub-hosted job", releaseCondition: "runner disposal" }));
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  assert.equal(realpathSync(owner.daemonHome), owner.daemonHome);
  assert.ok(owner.daemonHome.startsWith(realpathSync(process.env.RUNNER_TEMP) + "\\"));
  assert.equal(hash(readFileSync(owner.receiptPath)), owner.receiptSha256);
  const result = spawnSync(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", "uninstall", "--daemon-home", owner.daemonHome, "--yes", "--json"], { env: { ...process.env, ...owner.dirs, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" }, encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 128 * 1024 });
  let body;
  try { body = JSON.parse(result.stdout); } catch { /* Unknown removal is retained for runner disposal. */ }
  const removed = !result.error && !result.signal && result.status === 0 && body?.result?.state === "removed" && !existsSync(owner.receiptPath) && !existsSync(owner.unitPath);
  writeFileSync(join(output, "cleanup.json"), JSON.stringify({ status: result.status, signal: result.signal, outcome: removed ? "removed" : "cleanup-outstanding", stockOutcome: ["ok", "refused", "failed", "unknown"].includes(body?.outcome) ? body.outcome : "unknown", code: ["CONFLICT", "TARGET_NOT_FOUND", "TARGET_UNAVAILABLE", "DEPENDENCY_UNAVAILABLE", "PERMISSION_DENIED", "OPERATION_UNKNOWN"].includes(body?.error?.code) ? body.error.code : null, removed, ...(!removed ? { reason: "guarded-uninstall-not-confirmed", owner: "this GitHub-hosted job", releaseCondition: "runner disposal" } : {}) }));
  assert.ok(removed, "ordinary receipt-guarded uninstall must remove the diagnostic task before the scenario");
} else {
  assert.equal(process.argv[2], "measure");
  assert.ok(!existsSync(ownerPath), "never adopt or overwrite another preflight fixture");
  const root = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP, "cotal-task-stage-")));
  const sid = native("whoami.exe", ["/user", "/fo", "csv", "/nh"]).trim().split(",").pop()?.replace(/^"|"$/g, "").trim();
  assert.match(sid, /^S-1-[0-9]+(?:-[0-9]+)+$/);
  native("icacls.exe", [root, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]);
  const dirs = {};
  for (const [key, leaf] of Object.entries({ HOME: "home", USERPROFILE: "home", APPDATA: "roaming", LOCALAPPDATA: "local", TEMP: "tmp", TMP: "tmp", COTAL_HOME: "machine", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache", XDG_RUNTIME_DIR: "rt" })) {
    dirs[key] = join(root, leaf); mkdirSync(dirs[key], { recursive: true });
  }
  const env = { ...process.env, ...dirs, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" };
  const daemonHome = join(root, "daemon");
  mkdirSync(daemonHome);
  const unit = `cotal-daemon-${hash(daemonHome).slice(0, 16)}-${sid}`;
  const unitPath = join(daemonHome, "service-task.xml");
  const receiptPath = join(daemonHome, "service-unit.json");
  const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  // Dormant task: no trigger, never /Run, no daemon or arbitrary child process is launched.
  const text = `<?xml version="1.0" encoding="UTF-16"?><Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Principals><Principal id="Author"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><Enabled>true</Enabled><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>${xml(join(process.env.SystemRoot, "System32", "cmd.exe"))}</Command><Arguments>/d /c exit 0</Arguments><WorkingDirectory>${xml(daemonHome)}</WorkingDirectory></Exec></Actions></Task>`;
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  writeFileSync(unitPath, bytes, { flag: "wx" });
  writeFileSync(receiptPath, JSON.stringify({ v: 1, mechanism: "scheduled-task", unit, unitPath, unitSha256: hash(bytes), installedAt: new Date().toISOString(), daemonHome }), { flag: "wx" });
  writeFileSync(ownerPath, JSON.stringify({ daemonHome, receiptPath, unitPath, receiptSha256: hash(readFileSync(receiptPath)), dirs }), { flag: "wx", mode: 0o600 });
  native("schtasks.exe", ["/Create", "/XML", unitPath, "/TN", unit], env); // No /F: name collision refuses.
  const sourcePath = join(repo, "bin/daemon/install-win32.ts");
  const expected = { execute: join(process.env.SystemRoot, "System32", "cmd.exe"), arguments: "/d /c exit 0", workingDirectory: daemonHome, userId: sid };
  const enabled = measureTaskStages({ sourcePath, receiptPath, output: join(output, "enabled.json"), phase: "enabled", env, expected });
  const lastEnabled = enabled.at(-1);
  assert.ok(lastEnabled?.status === 0 && lastEnabled.task?.identityMatches && lastEnabled.task.enabled === true && lastEnabled.task.instances === 0, "last observation must confirm the exact dormant owned task before disable");
  assert.equal(hash(readFileSync(unitPath)), hash(bytes), "owned fixture source unchanged before disable");
  native("schtasks.exe", ["/Change", "/TN", unit, "/DISABLE"], env);
  const disabled = measureTaskStages({ sourcePath, receiptPath, output: join(output, "disabled.json"), phase: "disabled", env, expected });
  const stages = ["import-module", "enumerate-all", "principal-translate", "com-create", "com-connect", "com-get-task", "com-get-instances", "query-named"];
  const rows = [...enabled, ...disabled].map(row => `| ${row.phase} ${row.sample} | ${row.temperature} | ${row.approximateStartupMs ?? "unknown"} | ${stages.map(stage => stage === "principal-translate" && row.principalTranslate !== "completed" ? row.principalTranslate : row.durations.find(d => d.stage === stage)?.elapsedMs ?? "incomplete").join(" | ")} | ${row.code ?? row.status ?? "unknown"} |`);
  const table = ["# Standalone READ_TASK stages", "", "Milliseconds per stage. Startup is a wall-clock estimate. Named comparison is warmed and shares each sample's 180s bound.", "", `| Sample | Temperature | Startup | ${stages.join(" | ")} | Exit/code |`, `| ${Array(stages.length + 4).fill("---").join(" | ")} |`, ...rows, ""].join("\n");
  writeFileSync(join(output, "stages.md"), table);
  console.log(table);
  writeFileSync(join(output, "summary.json"), JSON.stringify({ scope: "separate dormant receipt-owned task before unchanged scenario", firstSample: "cold-first-harness-controlled-powershell-after-checkout", coldLimit: "checkout, runner and image internals are not observed", registration: "schtasks.exe; no harness-controlled PowerShell before first sample", namedComparison: "after shipped script in same warmed process and 180s budget", warming: "preflight warms PowerShell and scheduler before original scenario", samples: [...enabled, ...disabled] }, null, 2));
}
