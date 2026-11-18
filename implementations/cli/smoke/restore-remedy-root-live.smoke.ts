/** Restore refusals and backup receipts retain the project root in every recovery command. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { acquireMaintenanceLock, codeSpan, prepareAlternateRestore, readMaintenanceJournal, releaseMaintenanceLock, shellPath } from "@cotal-ai/workspace";

const scratch = mkdtempSync(join(tmpdir(), "cotal-restore-remedy-"));
const root = join(scratch, "project 'quoted' $dollar");
const other = join(scratch, "other");
const home = join(scratch, "home");
const config = join(scratch, "config");
const runtime = join(scratch, "runtime");
const bin = join(scratch, "bin");
for (const dir of [root, other, home, config, runtime, bin]) mkdirSync(dir, { mode: 0o700 });
mkdirSync(join(other, ".cotal"), { mode: 0o700 });
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: config });
const tree = resolve(import.meta.dirname, "../../..");
const tsx = join(tree, "node_modules/.bin/tsx");
const cli = join(tree, "bin/cotal.ts");
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, TMPDIR: scratch, TMP: scratch, TEMP: scratch, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1", PATH: `${bin}:${env.PATH}` });
writeFileSync(join(bin, "cotal"), `#!/bin/sh\nexec ${shellPath(tsx)} ${shellPath(cli)} "$@"\n`, { mode: 0o700 });
const observations: Array<{ label: string; status: number | null; stdout: string; stderr: string }> = [];
let passed = 0, failed = 0, running = false;
function check(label: string, condition: boolean) {
  if (condition) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.error(`FAIL ${label}`); }
}
function run(label: string, cwd: string, ...args: string[]) {
  const options = { cwd, env, encoding: "utf8" as const, timeout: 240_000 };
  assertSmokeSandboxDown(sandbox, args, options);
  const result = spawnSync(tsx, [cli, ...args], options);
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
function preview(label: string, text: string, command: string) {
  const scoped = `cd ${shellPath(root)} && ${command}`;
  const printed = text.includes(codeSpan(scoped)) || text.includes(scoped) ? scoped : command;
  check(`${label}: printed command names the project`, printed === scoped);
  // Execute only a command derived from this fixture, never arbitrary diagnostic text.
  assert(text.includes(printed), `${label}: expected command is present`);
  const result = spawnSync("/bin/sh", ["-c", printed.replace(" --yes", "") + " --dry-run"], { cwd: other, env, encoding: "utf8", timeout: 240_000 });
  observations.push({ label: `${label}: printed preview`, status: result.status, stdout: result.stdout, stderr: result.stderr });
  assert.ifError(result.error);
  check(`${label}: printed preview works from the invoking folder`, result.status === 0 && (result.stdout.includes("active") || result.stdout.includes("restore-ready")));
}
try {
  const space = "restore_remedy_root";
  const server = `nats://127.0.0.1:${await freePort()}`;
  running = true;
  must("start real mesh", root, "up", "--detach", "--open", "--space", space, "--server", server);
  must("preserve real cut", root, "down", "--preserve-state");
  running = false;
  const artifact = join(root, "registry-backup");
  must("create real registry artifact", root, "backup", "create", artifact, "--only", "registry");
  // Only the interrupted claim is constructed. Its source store and preserved cut are real,
  // and ordinary up and recovery below enter through the shipped CLI.
  const staleAttempt = `restore-${randomUUID()}`;
  const lock = acquireMaintenanceLock(root);
  try {
    prepareAlternateRestore(lock, { attemptId: staleAttempt, targetPath: join(root, "stale-target"), selection: "registry", claim: { deadline: new Date(1).toISOString(), coordinator: { pid: 2_147_483_647, host: hostname(), startedAt: new Date(0).toISOString(), id: "dead-fixture-coordinator" } } });
  } finally { releaseMaintenanceLock(lock); }
  const stale = run("ordinary up refuses stale restore from another folder", other, "up", "--root", root, "--detach", "--json");
  const staleFailure = JSON.parse(stale.stdout) as { error?: { code?: string; remedy?: string } };
  check("stale-ready refusal reaches its recovery boundary", stale.status === 2 && staleFailure.error?.code === "LIFECYCLE_BLOCKED" && stale.stdout.includes("stopped before it committed"));
  preview("stale-ready remedy", staleFailure.error?.remedy ?? "", `cotal backup recover ${staleAttempt} --yes`);
  must("explicit recovery returns real cut to ready", root, "backup", "recover", staleAttempt, "--yes");
  assert.equal(readMaintenanceJournal(root)?.state, "ready");
  running = true;
  const restored = must("backup restore human receipt", root, "backup", "restore", artifact, "--plain");
  const journal = readMaintenanceJournal(root);
  assert(journal && "restore" in journal && journal.state === "active");
  const attempt = journal.restore.attemptId;
  preview("backup restore receipt", restored.stdout, `cotal backup cleanup-fallback ${attempt}`);
  const status = must("status of restored registry", root, "status", "--space", space);
  check("status consent assertion includes root-scoped command", status.stdout.includes(codeSpan(`cd ${shellPath(root)} && cotal backup cleanup-fallback ${attempt} --yes --discard-history`)) && status.stdout.includes("the only copy of the"));
  const manifest = join(other, "team.yaml");
  writeFileSync(manifest, `apiVersion: cotal/v1\nkind: Mesh\nspace: ${space}\nbroker:\n  servers: ${server}\n  auth: false\nchannels:\n  general:\n    subscribe: []\n`, { mode: 0o600 });
  const before = readFileSync(join(root, ".cotal/maintenance/v1/journal.json"), "utf8");
  for (const state of ["running", "stopped"] as const) {
    if (state === "stopped") { must("stop restored mesh", root, "down", "--yes"); running = false; }
    const refusal = run(`${state} manifest start from another folder`, other, "up", "-f", manifest, "--root", root);
    check(`${state} manifest start refuses without changing journal`, refusal.status === 2 && refusal.stderr.includes(state === "running" ? "CONFLICT" : "LIFECYCLE_BLOCKED") && readFileSync(join(root, ".cotal/maintenance/v1/journal.json"), "utf8") === before);
    preview(`${state} manifest remedy`, refusal.stderr, `cotal backup cleanup-fallback ${attempt} --yes --discard-history`);
  }
} finally {
  if (running) {
    const stopped = run("stop owned stack on failure", root, "down", "--yes");
    check("owned stack stopped on failure", stopped.status === 0);
  }
  writeFileSync(join(scratch, "commands.json"), `${JSON.stringify(observations, null, 2)}\n`, { mode: 0o600 });
  console.log(`Retained evidence: ${scratch}`);
  emitSentinel({ passed, failed });
}
if (failed) process.exitCode = 1;
