/** Interrupted restores and held claims keep recovery and history consent tied to the project. */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acquireMaintenanceLock, codeSpan, prepareAlternateRestore, readMaintenanceJournal, releaseMaintenanceLock, rollbackRestore, shellPath } from "@cotal-ai/workspace";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const scratch = mkdtempSync(join(tmpdir(), "cotal-interrupt-root-"));
const root = join(scratch, "project 'quoted' $dollar `literal`");
const other = join(scratch, "other");
const home = join(scratch, "home");
const config = join(scratch, "config");
const runtime = join(scratch, "runtime");
const bin = join(scratch, "bin");
for (const path of [root, other, home, config, runtime, bin]) mkdirSync(path, { mode: 0o700 });
mkdirSync(join(other, ".cotal"), { mode: 0o700 });
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: config });
const tree = resolve(import.meta.dirname, "../../..");
const cli = join(tree, "bin/dist/cotal.js");
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, TMPDIR: scratch, TMP: scratch, TEMP: scratch, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", PATH: `${bin}:${env.PATH}` });
writeFileSync(join(bin, "cotal"), `#!/bin/sh\nexec ${shellPath(process.execPath)} ${shellPath(cli)} "$@"\n`, { mode: 0o700 });
const observations: Array<{ label: string; status: number | null; stdout: string; stderr: string }> = [];
let passed = 0, failed = 0, running = false;
let child: ChildProcess | undefined;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
function check(label: string, condition: boolean) {
  if (condition) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.error(`FAIL ${label}`); }
}
function run(label: string, cwd: string, ...args: string[]) {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 240_000 };
  assertSmokeSandboxDown(sandbox, args, options);
  const result = spawnSync(process.execPath, [cli, ...args], options);
  observations.push({ label, status: result.status, stdout: result.stdout, stderr: result.stderr });
  assert.ifError(result.error);
  return result;
}
function must(label: string, cwd: string, ...args: string[]) {
  const result = run(label, cwd, ...args);
  assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}`);
  check(label, true);
  return result;
}
function scoped(label: string, text: string, command: string) {
  const expected = `cd ${shellPath(root)} && ${command}`;
  check(`${label}: quoted command targets the project`, text.includes(codeSpan(expected)) || text.includes(expected));
  return expected;
}
function preview(label: string, text: string, command: string) {
  const expected = scoped(label, text, command);
  // Do not execute arbitrary diagnostic text or destructive cleanup. Only this fixture's preview.
  const actual = text.includes(expected) ? expected : command;
  assert(text.includes(actual), `${label}: command absent`);
  const result = spawnSync("/bin/sh", ["-c", actual.replace(" --yes", "") + " --dry-run"], { cwd: other, env, encoding: "utf8", timeout: 240_000 });
  observations.push({ label: `${label} copied preview`, status: result.status, stdout: result.stdout, stderr: result.stderr });
  assert.ifError(result.error);
  check(`${label}: copied preview finds the attempt`, result.status === 0);
}
const journalPath = join(root, ".cotal/maintenance/v1/journal.json");
try {
  const server = `nats://127.0.0.1:${await freePort()}`;
  running = true;
  must("boot real private mesh", root, "up", "--detach", "--open", "--space", "interrupt_root", "--server", server);
  must("preserve real source", root, "down", "--preserve-state");
  running = false;
  const artifact = join(root, "registry-backup");
  must("create registry artifact", root, "backup", "create", artifact, "--only", "registry");
  for (const kind of ["live", "ambiguous"] as const) {
    const attempt = `restore-${randomUUID()}`;
    const coordinator = { pid: process.pid, host: kind === "live" ? hostname() : "unreachable-fixture-host", startedAt: new Date().toISOString(), id: `fixture-${kind}` };
    let lock = acquireMaintenanceLock(root);
    try { prepareAlternateRestore(lock, { attemptId: attempt, targetPath: join(root, `${kind}-target`), selection: "registry", claim: { coordinator, deadline: new Date(Date.now() + 600_000).toISOString() } }); }
    finally { releaseMaintenanceLock(lock); }
    const before = readFileSync(journalPath, "utf8");
    try {
      for (const command of [["up", "--root", root, "--detach", "--json"], ["up", "--root", root, "--restore", artifact, "--detach", "--json"]]) {
        const result = run(`${kind} ${command.includes("--restore") ? "restore" : "up"} refusal`, other, ...command);
        const report = JSON.parse(result.stdout) as { error?: { code?: string; remedy?: string; message?: string } };
        check(`${kind}: reaches held claim and preserves journal`, result.status === 2 && report.error?.code === "LIFECYCLE_BLOCKED" && (report.error.message ?? "").includes(kind === "live" ? "is still running" : "cannot be proven gone") && readFileSync(journalPath, "utf8") === before);
        scoped(`${kind} claim remedy`, report.error?.remedy ?? "", `cotal backup recover ${attempt} --yes`);
      }
    } finally {
      lock = acquireMaintenanceLock(root);
      try { rollbackRestore(lock, { asCoordinator: coordinator }); } finally { releaseMaintenanceLock(lock); }
    }
  }
  if (!process.argv.includes("--claims-only")) {
    // Freeze only our own CLI, outside its lock, while its real isolated broker is recorded.
    child = spawn(process.execPath, [cli, "up", "--restore", artifact, "--root", root, "--detach"], { cwd: other, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((done) => child!.once("exit", done));
    const pid = child.pid!;
    let interruptedAttempt: string | undefined;
    for (const deadline = Date.now() + 120_000; Date.now() < deadline; await sleep(5)) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`restore exited before signal boundary\n${stdout}\n${stderr}`);
      const journal = readMaintenanceJournal(root);
      if (journal?.state !== "restore-ready" || !journal.claim.owners.length || existsSync(join(root, ".cotal/maintenance/lock.json"))) continue;
      child.kill("SIGSTOP");
      if (existsSync(join(root, ".cotal/maintenance/lock.json"))) { child.kill("SIGCONT"); continue; }
      interruptedAttempt = journal.restore.attemptId;
      break;
    }
    assert(interruptedAttempt, "real restore reached unlocked restore-ready with broker owners");
    process.kill(-pid, "SIGINT");
    child.kill("SIGCONT");
    const status = await exited;
    observations.push({ label: "real SIGINT restore", status, stdout, stderr });
    child = undefined;
    check("real SIGINT exits 130 with pre-commit notice", status === 130 && stderr.includes("stopped before it committed"));
    const command = `cotal backup recover ${interruptedAttempt} --yes`;
    scoped("interrupt notice", stderr, command);
    // Watchdogs retire the interrupted attempt's own brokers. Wait for one read-only preview
    // to observe that transition, then execute the notice's copied preview once.
    let ready = false;
    for (let n = 0; n < 50; n++) {
      const probe = run("wait for interrupted owners to exit", root, "backup", "recover", interruptedAttempt, "--dry-run");
      if (probe.status === 0) { ready = true; break; }
      await sleep(200);
    }
    assert(ready, "interrupted owners exited before recovery");
    preview("interrupt notice", stderr, command);
    must("recover actual interrupted restore", root, "backup", "recover", interruptedAttempt, "--yes");
    running = true;
    const restored = must("registry restore from invoking folder", other, "up", "--restore", artifact, "--root", root, "--detach");
    const journal = readMaintenanceJournal(root);
    assert(journal && "restore" in journal && journal.state === "active");
    const note = restored.stdout.split("\n").find((line) => line.includes("holds the only copy of them."));
    assert(note, "registry restore prints previous-store note");
    preview("previous-store note", note, `cotal backup cleanup-fallback ${journal.restore.attemptId}`);
    const before = readFileSync(journalPath, "utf8");
    const refused = run("cleanup without history consent", root, "backup", "cleanup-fallback", journal.restore.attemptId, "--yes", "--json");
    check("history consent remains required and journal unchanged", refused.status === 1 && refused.stdout.includes("USAGE_INVALID") && readFileSync(journalPath, "utf8") === before);
    must("stop restored fixture", root, "down", "--yes");
    running = false;
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const owned = child;
    const exited = new Promise<void>((done) => owned.once("exit", () => done()));
    process.kill(-owned.pid!, "SIGINT");
    owned.kill("SIGCONT");
    await exited;
  }
  if (running) check("stop owned fixture after failure", run("failure stop", root, "down", "--yes").status === 0);
  writeFileSync(join(scratch, "commands.json"), `${JSON.stringify(observations, null, 2)}\n`, { mode: 0o600 });
  console.log(`Retained evidence: ${scratch}`);
  emitSentinel({ passed, failed });
}
if (failed) process.exitCode = 1;
