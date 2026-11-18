/** Printed maintenance and space-creation steps work from the folder that receives them. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { readMaintenanceJournal } from "@cotal-ai/workspace";
import { assertScratchHeld } from "../../../bin/smoke/_scratch.js";
import { shellWord } from "../src/lib/endpoint-errors.js";

const scratch = mkdtempSync(join(tmpdir(), "cotal-next-step-root-"));
const root = join(scratch, "project 'quoted' folder");
const other = join(scratch, "invoking-folder");
const fresh = join(scratch, "fresh-folder");
const home = join(scratch, "home");
const config = join(scratch, "config");
const runtime = join(scratch, "runtime");
for (const dir of [root, other, fresh, home, config, runtime]) mkdirSync(dir, { mode: 0o700 });
// Anchor both command folders before any CLI call, even under a Cotal operator's home.
mkdirSync(join(other, ".cotal"), { mode: 0o700 });
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: config });
const worktree = resolve(import.meta.dirname, "../../..");
const cli = join(worktree, "bin/cotal.ts");
const tsx = join(worktree, "node_modules/.bin/tsx");
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: config, XDG_RUNTIME_DIR: runtime, TMPDIR: scratch, TMP: scratch, TEMP: scratch, COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" });
const observations: Array<{ label: string; status: number | null; stdout: string; stderr: string }> = [];
let passed = 0, failed = 0, running = false;
function check(name: string, condition: boolean) {
  if (condition) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.error(`FAIL ${name}`); }
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
  assert.equal(result.status, 0, `${label}: ${result.stderr}\n${result.stdout}`);
  check(label, true);
  return result;
}
try {
  assertScratchHeld(root, "root-aware next-step fixture");
  const server = `nats://127.0.0.1:${await freePort()}`;
  running = true;
  must("start real mesh", root, "up", "--detach", "--open", "--space", "next_step_root", "--server", server);
  const inventory = must("list occupied root", root, "space", "--plain");
  check("occupied-root hint names an explicit new folder", inventory.stdout.includes("cotal space create <name> --root <dir>") && !inventory.stdout.includes("Prepare another local space in this folder"));
  const conflict = run("create in occupied root refuses", root, "space", "create", "second");
  check("existing root still refuses another space", conflict.status === 2 && conflict.stderr.includes("CONFLICT"));
  must("explicit-folder creation succeeds from occupied root", root, "space", "create", "second", "--root", fresh);
  must("preserve real mesh", root, "down", "--preserve-state");
  running = false;
  const artifact = join(root, "backup");
  must("create real full backup", root, "backup", "create", artifact);
  running = true;
  const restored = must("restore from another folder", other, "up", "--restore", artifact, "--root", root, "--detach");
  const journal = readMaintenanceJournal(root);
  assert(journal && "restore" in journal && journal.state === "active");
  const attempt = journal.restore.attemptId;
  const next = restored.stdout.split("\n").find((line) => line.startsWith("next: "));
  assert(next, "restore printed its next step");
  const printed = next.match(/`([^`]*cotal backup cleanup-fallback[^`]*)`/)?.[1];
  assert(printed, "restore printed a cleanup command");
  const suffix = printed.endsWith(" --discard-history") ? " --discard-history" : "";
  const bare = `cotal backup cleanup-fallback ${attempt} --yes${suffix}`;
  const scoped = `cd ${shellWord(root)} && ${bare}`;
  // Accept only these fixture-derived commands before executing the printed shell structure.
  assert(printed === bare || printed === scoped, "printed command matches this fixture only");
  check("restore cleanup command carries its project root", printed === scoped);
  const bin = join(scratch, "bin");
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(join(bin, "cotal"), `#!/bin/sh\nexec ${shellWord(tsx)} ${shellWord(cli)} "$@"\n`, { mode: 0o700 });
  const preview = spawnSync("/bin/sh", ["-c", printed.replace(" --yes", " --dry-run")], { cwd: other, env: { ...env, PATH: `${bin}:${env.PATH}` }, encoding: "utf8", timeout: 240_000 });
  observations.push({ label: "printed cleanup preview from invoking folder", status: preview.status, stdout: preview.stdout, stderr: preview.stderr });
  assert.ifError(preview.error);
  check("printed cleanup preview works from invoking folder", preview.status === 0 && preview.stdout.includes(attempt));
  must("positive control preview inside project", root, "backup", "cleanup-fallback", attempt, "--dry-run");
  const journalPath = join(root, ".cotal/maintenance/v1/journal.json");
  const before = readFileSync(journalPath, "utf8");
  const wrong = run("wrong-root cleanup refusal", other, "backup", "cleanup-fallback", attempt, "--dry-run");
  check("wrong root refuses without assuming completed cleanup", wrong.status === 2 && wrong.stderr.includes("TARGET_NOT_FOUND") && !wrong.stderr.includes("finds nothing to do") && wrong.stderr.includes("original project folder"));
  check("previews and wrong-root refusal preserve active journal", readFileSync(journalPath, "utf8") === before && readMaintenanceJournal(root)?.state === "active");
  must("stop restored mesh", root, "down", "--yes");
  running = false;
} finally {
  if (running) {
    const stopped = run("stop owned mesh after failure", root, "down", "--yes");
    check("owned mesh stopped after failure", stopped.status === 0);
  }
  writeFileSync(join(scratch, "commands.json"), `${JSON.stringify(observations, null, 2)}\n`, { mode: 0o600 });
  console.log(`NEXT STEP ROOT: ${passed} passed, ${failed} failed`);
  console.log(`Retained evidence: ${scratch}`);
}
if (failed) process.exitCode = 1;
