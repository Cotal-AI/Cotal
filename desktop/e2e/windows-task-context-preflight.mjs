import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { taskStageScript } from "./windows-task-stage-script.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The diagnostic uses the shipped principal, with no triggers or automatic retries. */
export function contextTaskDefinition(source, { sid, node, args, cwd }) {
  const principal = /`    <Principal id="Author"><UserId>\$\{sid\}<\/UserId><LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege<\/RunLevel><\/Principal>`/.exec(source);
  assert.ok(principal, "review the diagnostic when the shipped task principal changes");
  assert.match(sid, /^S-1-[0-9]+(?:-[0-9]+)+$/);
  for (const value of [node, cwd]) assert.match(value, /^(?:[A-Za-z]:\\|\\\\)/);
  const quote = value => {
    assert.ok(value && !/["%\r\n]/.test(value), "task arguments must not be expanded or split");
    return /[ \t]/.test(value) ? `"${value}${"\\".repeat(/\\*$/.exec(value)[0].length)}"` : value;
  };
  const argumentsText = args.map(quote).join(" ");
  const text = `<?xml version="1.0" encoding="UTF-16"?><Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Principals><Principal id="Author"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><Enabled>true</Enabled><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT12M</ExecutionTimeLimit><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><Priority>4</Priority></Settings><Actions Context="Author"><Exec><Command>${xml(node)}</Command><Arguments>${xml(argumentsText)}</Arguments><WorkingDirectory>${xml(cwd)}</WorkingDirectory></Exec></Actions></Task>`;
  return { bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]), argumentsText };
}

/** Validate only fixed identity fields, never treat an unreadable query as absence. */
export function matchesContextTask(task, expected) {
  return task?.present === true && task.actions === 1 && task.execute === expected.execute && task.arguments === expected.arguments && task.workingDirectory === expected.workingDirectory && task.userId === expected.userId && task.logonType === 3 && task.runLevel === 0 && Number.isSafeInteger(task.instances) && task.instances >= 0;
}

async function main() {
  assert.equal(process.platform, "win32");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.ok(process.env.RUNNER_TEMP && process.env.SystemRoot);
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const ownerPath = join(process.env.RUNNER_TEMP, "windows-task-context-owner.json");
  const output = join(process.env.RUNNER_TEMP, "desktop-windows-task-context");
  mkdirSync(output, { recursive: true });
  const native = (file, args, env = process.env, timeout = 30_000) => {
    const r = spawnSync(file, args, { env, encoding: "utf8", windowsHide: true, timeout, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    assert.ok(!r.error && !r.signal && r.status === 0, "owned context fixture operation did not confirm success; not retried");
    return r.stdout;
  };
  const system = file => join(process.env.SystemRoot, "System32", file);
  const inspect = owner => {
    const { script } = taskStageScript(readFileSync(join(repo, "bin/daemon/install-win32.ts"), "utf8"));
    const raw = native(system("WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { ...process.env, COTAL_DAEMON_TASK: owner.unit, COTAL_DAEMON_TASK_INSTANCES: "1" }, 180_000);
    const task = JSON.parse(raw.replace(/^\uFEFF/, "").trim());
    assert.ok(matchesContextTask(task, owner.expected), "the registered context task must match its receipt before a native action");
    return task;
  };
  const validateOwner = owner => {
    const temp = realpathSync(process.env.RUNNER_TEMP);
    assert.equal(realpathSync(owner.root), owner.root);
    assert.ok(owner.root.startsWith(temp + "\\"));
    assert.equal(owner.daemonHome, join(owner.root, "daemon"));
    assert.equal(owner.unitPath, join(owner.daemonHome, "service-task.xml"));
    assert.equal(owner.receiptPath, join(owner.daemonHome, "service-unit.json"));
    assert.equal(hash(readFileSync(owner.receiptPath)), owner.receiptSha256);
    assert.equal(hash(readFileSync(owner.unitPath)), owner.unitSha256);
    for (const item of owner.sources) assert.equal(hash(readFileSync(item.path)), item.sha256, "context experiment source changed");
  };
  if (process.argv[2] === "cleanup") {
    writeFileSync(join(output, "cleanup.json"), JSON.stringify({ removed: false, outcome: "cleanup-outstanding", owner: "this GitHub-hosted job", releaseCondition: "runner disposal" }));
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    validateOwner(owner);
    const r = spawnSync(process.execPath, [join(repo, "bin/dist/cotal.js"), "daemon", "uninstall", "--daemon-home", owner.daemonHome, "--yes", "--json"], { env: { ...process.env, ...owner.dirs, COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_TELEMETRY: "off" }, encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 128 * 1024 });
    let body;
    try { body = JSON.parse(r.stdout); } catch { /* Unknown cleanup stays retained for runner disposal. */ }
    const removed = !r.error && !r.signal && r.status === 0 && body?.result?.state === "removed" && !existsSync(owner.receiptPath) && !existsSync(owner.unitPath);
    writeFileSync(join(output, "cleanup.json"), JSON.stringify({ removed, status: r.status, outcome: removed ? "removed" : "cleanup-outstanding", ...(!removed ? { owner: "this GitHub-hosted job", releaseCondition: "runner disposal" } : {}) }));
    assert.ok(removed, "ordinary guarded uninstall must remove the context fixture before the scenario");
    return;
  }
  assert.equal(process.argv[2], "measure");
  assert.ok(!existsSync(ownerPath), "never adopt or overwrite another context fixture");
  const root = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP, "cotal-task-context-")));
  const sid = native(system("whoami.exe"), ["/user", "/fo", "csv", "/nh"]).trim().split(",").pop()?.replace(/^"|"$/g, "").trim();
  assert.match(sid, /^S-1-[0-9]+(?:-[0-9]+)+$/);
  native(system("icacls.exe"), [root, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"]);
  const dirs = {};
  for (const [key, leaf] of Object.entries({ HOME: "home", USERPROFILE: "home", APPDATA: "roaming", LOCALAPPDATA: "local", TEMP: "tmp", TMP: "tmp", COTAL_HOME: "machine", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", XDG_CACHE_HOME: "cache", XDG_RUNTIME_DIR: "rt" })) {
    dirs[key] = join(root, leaf); mkdirSync(dirs[key], { recursive: true });
  }
  const daemonHome = join(root, "daemon"); mkdirSync(daemonHome);
  const unit = `cotal-daemon-${hash(daemonHome).slice(0, 16)}-${sid}`;
  const unitPath = join(daemonHome, "service-task.xml"), receiptPath = join(daemonHome, "service-unit.json");
  const modulePath = join(repo, "desktop/e2e/windows-task-context-measure.mjs");
  const sourcePath = join(repo, "bin/daemon/install-win32.ts"), rustSourcePath = join(repo, "desktop/src-tauri/src/lib.rs");
  const configPath = join(root, "config.json"), taskOutput = join(root, "scheduled-task.json"), harnessOutput = join(root, "harness.json");
  const definition = contextTaskDefinition(readFileSync(sourcePath, "utf8"), { sid, node: process.execPath, args: ["--max-semi-space-size=1", modulePath, "run", configPath, "scheduled-task", taskOutput], cwd: root });
  const expected = { execute: process.execPath, arguments: definition.argumentsText, workingDirectory: root, userId: sid };
  writeFileSync(configPath, JSON.stringify({ sourcePath, rustSourcePath, unit, expected, cwd: root }), { flag: "wx", mode: 0o600 });
  writeFileSync(unitPath, definition.bytes, { flag: "wx" });
  writeFileSync(receiptPath, JSON.stringify({ v: 1, mechanism: "scheduled-task", unit, unitPath, unitSha256: hash(definition.bytes), installedAt: new Date().toISOString(), daemonHome }), { flag: "wx" });
  const sources = [configPath, modulePath, sourcePath, rustSourcePath, join(repo, "desktop/e2e/windows-task-stage-script.mjs")].map(path => ({ path, sha256: hash(readFileSync(path)) }));
  const owner = { root, daemonHome, unit, unitPath, receiptPath, receiptSha256: hash(readFileSync(receiptPath)), unitSha256: hash(definition.bytes), expected, sources, dirs };
  writeFileSync(ownerPath, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  native(system("schtasks.exe"), ["/Create", "/XML", unitPath, "/TN", unit]);
  validateOwner(owner);
  assert.equal(inspect(owner).instances, 0, "only the exact idle owned task may be run");
  native(system("schtasks.exe"), ["/Run", "/TN", unit]);
  const deadline = Date.now() + 11 * 60_000;
  let rows;
  while (Date.now() < deadline) {
    if (existsSync(taskOutput)) {
      try { rows = JSON.parse(readFileSync(taskOutput, "utf8")); } catch { /* A partial incremental write is not completion. */ }
      if (Array.isArray(rows)) writeFileSync(join(output, "scheduled-task.json"), JSON.stringify(rows, null, 2));
      if (Array.isArray(rows) && rows.length === 3) break;
    }
    await delay(500);
  }
  assert.ok(Array.isArray(rows) && rows.length === 3, "scheduled task measurements did not complete; cleanup remains receipt-guarded");
  validateOwner(owner);
  let idle = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (inspect(owner).instances === 0) { idle = true; break; }
    await delay(500);
  }
  assert.ok(idle, "scheduled diagnostic process exit must be confirmed before comparison");
  try {
    native(process.execPath, ["--max-semi-space-size=1", modulePath, "run", configPath, "harness", harnessOutput], process.env, 11 * 60_000);
  } finally {
    if (existsSync(harnessOutput)) {
      let partial;
      try { partial = JSON.parse(readFileSync(harnessOutput, "utf8")); } catch { /* Incomplete writes are not promoted to measurement evidence. */ }
      if (Array.isArray(partial)) writeFileSync(join(output, "harness.json"), JSON.stringify(partial, null, 2), { flag: "wx" });
    }
  }
  const harnessRows = JSON.parse(readFileSync(harnessOutput, "utf8"));
  assert.equal(harnessRows.length, 3);
  const { renderContextTable } = await import("./windows-task-context-measure.mjs");
  const table = renderContextTable([...rows, ...harnessRows]);
  writeFileSync(join(output, "comparison.md"), table, { flag: "wx" });
  console.log(table);
  writeFileSync(join(output, "scope.json"), JSON.stringify({ principal: "same current SID / InteractiveToken / LeastPrivilege as shipped task", order: "scheduled-task three variants, then harness three variants; warmed, not cold-controlled", strippedEnvironment: "shipped desktop daemon_env_key allowlist plus DO_NOT_TRACK=1, not a claim to reproduce PATH refresh, native launcher or all daemon initialization", bounds: "180s per native read, 11min per context, PT12M task limit", ownership: "own receipt and exact source/action/principal before Run; stock guarded uninstall afterward", output: "environment names and only USERPROFILE/LOCALAPPDATA/TEMP/PSModulePath values" }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch {
    // Native exception objects can contain argv, environment or unapproved paths.
    console.error("Windows task context diagnostic failed; owned fixture and fixed receipts retained for guarded cleanup or runner disposal");
    process.exitCode = 1;
  }
}
