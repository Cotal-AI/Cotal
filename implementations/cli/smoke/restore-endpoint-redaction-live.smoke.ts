/** Real CLI backup/restore refusal for an edited legacy resume document with a private endpoint.
 * The broker, preserved cut and artifact are real. Only the stopped fixture's records are adapted
 * to the supported legacy shape; no production validator or restore implementation is replaced.
 * The successful control restores in the foreground from another folder and runs its cleanup step.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { readMaintenanceJournal, resolveOnPath, shellPath } from "@cotal-ai/workspace";
import { assertScratchHeld, makeScratch } from "../../../bin/smoke/_scratch.js";

const scratch = makeScratch("cotal-restore-redaction-");
const root = mkdtempSync(join(scratch, "project 'quoted' root-"));
const home = mkdtempSync(join(scratch, "home-"));
const invokingFolder = join(scratch, "invoking-folder");
mkdirSync(join(invokingFolder, ".cotal"), { recursive: true, mode: 0o700 });
const config = join(home, "xdg");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: config });
const worktree = resolve(import.meta.dirname, "../../..");
const tsx = join(worktree, "node_modules/.bin/tsx");
const cli = join(worktree, "bin/cotal.ts");
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: config, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" });
const launcher = resolveOnPath("cotal", env) ? "cotal" : "pnpm cotal";
const shell = [
  'cotal() { "$TEST_TSX" "$TEST_CLI" "$@"; }',
  'pnpm() { [ "$1" = cotal ] || return 1; shift; cotal "$@"; }',
  "",
].join("\n");
const runFrom = (cwd: string, ...args: string[]) => {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 240_000 };
  assertSmokeSandboxDown(sandbox, args, options);
  return spawnSync(tsx, [cli, ...args], options);
};
const run = (...args: string[]) => runFrom(root, ...args);
let passed = 0, failed = 0;
const refusals: Array<{ name: string; status: number | null; stdout: string; stderr: string }> = [];
function check(name: string, condition: boolean) {
  if (condition) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.error(`FAIL ${name}`); }
}
function must(name: string, result: ReturnType<typeof run>) {
  assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
  check(name, true);
}
const journalPath = join(root, ".cotal/maintenance/v1/journal.json");
const resumePath = join(root, ".cotal/maintenance/v1/resume.json");
let originalJournal: string | undefined, originalResume: string | undefined;
let running = false, completed = false;
let foreground: ChildProcess | undefined;
try {
  mkdirSync(join(root, ".cotal"), { recursive: true });
  assertScratchHeld(root, "restore endpoint fixture");
  const server = `nats://127.0.0.1:${await freePort()}`;
  const space = "restore_redaction";
  const artifact = join(root, "registry-backup");
  running = true;
  must("ordinary boot", run("up", "--detach", "--open", "--server", server, "--space", space));
  must("registry write before preservation", run("channel", "set", "preserved", "--desc", "survives", "--space", space));
  must("preserve real stopped cut", run("down", "--preserve-state"));
  running = false;
  must("create real registry artifact", run("backup", "create", artifact, "--only", "registry"));
  originalJournal = readFileSync(journalPath, "utf8");
  originalResume = readFileSync(resumePath, "utf8");
  const original = JSON.parse(originalJournal);
  assert.equal(original.state, "ready");
  const source = lstatSync(original.source.path, { bigint: true });
  // A current controller cut takes its endpoint from the validated cut. Older cuts instead read
  // resume.launch.server. Model that persisted input, retaining the real stopped store/artifact.
  const legacy = structuredClone(original);
  legacy.cut.launch.custody = "legacy";
  delete legacy.cut.launch.controller;
  delete legacy.cutCompletion.controllerStops;
  const canary = "fixture-only-private-endpoint";
  const inputs = [
    ["token", server.replace("//", `//${canary}@`)],
    ["password", server.replace("//", `//fixture:${canary}@`)],
    ["query", `${server}?token=${canary}`],
  ];
  for (const [label, endpoint] of inputs) {
    for (const json of [false, true]) {
      const name = `${label} ${json ? "JSON" : "text"}`;
      const resume = JSON.parse(originalResume);
      resume.launch.server = endpoint;
      const bytes = `${JSON.stringify(resume, null, 2)}\n`;
      const record = structuredClone(legacy);
      record.resume.bytes = Buffer.byteLength(bytes);
      record.resume.sha256 = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(resumePath, bytes, { mode: 0o600 });
      const journalBytes = `${JSON.stringify(record, null, 2)}\n`;
      writeFileSync(journalPath, journalBytes, { mode: 0o600 });
      assert.equal(readMaintenanceJournal(root)?.state, "ready", "shipped reader accepts the legacy fixture");
      check(`${name}: valid legacy ready record`, true);
      const result = run("up", "--restore", artifact, "--detach", "--space", space, ...(json ? ["--json"] : []));
      const output = result.stdout + result.stderr;
      refusals.push({ name, status: result.status, stdout: result.stdout, stderr: result.stderr });
      check(`${name}: restore refuses`, result.status !== null && result.status !== 0);
      check(`${name}: reaches endpoint refusal`, output.includes("restore listener endpoint is not canonicalizable"));
      check(`${name}: output omits private endpoint`, !output.includes(canary));
      check(`${name}: ready journal unchanged`, readFileSync(journalPath, "utf8") === journalBytes);
      const after = lstatSync(original.source.path, { bigint: true });
      check(`${name}: preserved store inode unchanged`, after.dev === source.dev && after.ino === source.ino);
    }
  }
  writeFileSync(resumePath, originalResume);
  writeFileSync(journalPath, originalJournal);
  const flag = run("up", "--restore", artifact, "--detach", "--server", inputs[0]![1]!, "--space", space);
  check("CLI flag still refuses userinfo before restore", flag.status === 1 && /must not embed credentials/.test(flag.stdout + flag.stderr));
  check("CLI flag refusal omits private endpoint", !(flag.stdout + flag.stderr).includes(canary));
  running = true;
  const child = foreground = spawn(tsx, [cli, "up", "--foreground", "--restore", artifact, "--root", root, "--server", server, "--space", space], {
    cwd: invokingFolder, env, stdio: ["ignore", "pipe", "pipe"], timeout: 240_000,
  });
  let stdout = "", stderr = "";
  const exited = new Promise<number | null>((done) => {
    child.once("close", done);
    child.once("error", (error) => { stderr += String(error); done(null); });
  });
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const deadline = Date.now() + 120_000;
  const cleanupCommand = () => stdout.match(/^next: .*?`([^`]*backup cleanup-fallback [^`]+)`/m)?.[1];
  while (!cleanupCommand() && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(100);
  }
  const command = cleanupCommand();
  assert.ok(command, `foreground restore did not print a cleanup command while running\n${stdout}\n${stderr}`);
  const active = readMaintenanceJournal(root);
  assert.ok(active?.state === "active");
  const attempt = active.restore.attemptId;
  assert.ok(stdout.includes(`restored the backup registry as restore attempt ${attempt}`), stdout);
  const prefix = `cd ${shellPath(root)} && ${launcher} backup cleanup-fallback ${attempt}`;
  assert.ok(command === `${prefix} --yes --discard-history`, stdout);
  check("the foreground receipt and previous-store warning name the project", stdout.includes(`\`${prefix}\` deletes it only with --discard-history`));
  const before = readFileSync(journalPath, "utf8");
  const preview = spawnSync("sh", ["-c", shell + command.replace(/ --yes --discard-history$/, " --dry-run --discard-history")], {
    cwd: invokingFolder, env: { ...env, TEST_TSX: tsx, TEST_CLI: cli }, encoding: "utf8", timeout: 240_000,
  });
  must("copied cleanup preview runs from the invoking folder", preview);
  check("the preview finds the active restore", /Recorded state:\s+active/.test(preview.stdout) && preview.stdout.includes(attempt));
  check("previews keep the active journal and previous store", readFileSync(journalPath, "utf8") === before && !!active.restore.previousSource && lstatSync(active.restore.previousSource.identity.path).isDirectory());
  const listed = run("channel", "show", "preserved", "--space", space);
  must("restored registry is readable", listed);
  check("restored registry retains its channel", listed.stdout.includes("preserved"));
  must("stop restored fixture", run("down", "--yes"));
  running = false;
  assert.equal(await exited, 0, `${stdout}\n${stderr}`);
  foreground = undefined;
  const wrongRoot = runFrom(invokingFolder, "backup", "cleanup-fallback", attempt, "--dry-run");
  check("bare cleanup refuses at the wrong root", wrongRoot.status === 2 && wrongRoot.stderr.includes("TARGET_NOT_FOUND"));
  check("wrong-root refusal points to the original project without claiming cleanup completed", wrongRoot.stderr.includes("original project folder") && !wrongRoot.stderr.includes("finds nothing to do"));
  const cleanup = spawnSync("sh", ["-c", shell + command], {
    cwd: invokingFolder, env: { ...env, TEST_TSX: tsx, TEST_CLI: cli }, encoding: "utf8", timeout: 240_000,
  });
  must("copied cleanup retires the restore from the invoking folder", cleanup);
  const status = run("status", "--space", space, "--plain");
  must("status after copied cleanup", status);
  check("status no longer shows Maintenance", !/^Maintenance$/m.test(status.stdout));
  completed = true;
} finally {
  // A failed cleanup keeps its records; do not hide a remaining owned stack by deleting them.
  if (running) {
    const stopped = run("down", "--yes");
    check("failure cleanup stops owned stack", stopped.status === 0);
  }
  foreground?.kill("SIGTERM");
  writeFileSync(join(scratch, "refusals.json"), `${JSON.stringify(refusals, null, 2)}\n`, { mode: 0o600 });
  console.log(`RESTORE ENDPOINT REDACTION: ${passed} passed, ${failed} failed`);
  for (const row of refusals) console.log(`REFUSAL ${row.name}: exit=${row.status}, privateEndpointEchoed=${(row.stdout + row.stderr).includes("fixture-only-private-endpoint")}`);
  if (completed && failed === 0) {
    rmSync(scratch, { recursive: true });
    console.log("Private fixture removed after successful stop");
  } else console.log(`Retained private fixture: ${scratch}`);
}
if (failed) process.exitCode = 1;
