/** Real CLI backup/restore refusal for an edited legacy resume document with a private endpoint.
 * The broker, preserved cut and artifact are real. Only the stopped fixture's records are adapted
 * to the supported legacy shape; no production validator or restore implementation is replaced.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertSmokeSandboxDown, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";
import { readMaintenanceJournal } from "@cotal-ai/workspace";
import { assertScratchHeld, makeScratch } from "../../../bin/smoke/_scratch.js";

const scratch = makeScratch("cotal-restore-redaction-");
const root = mkdtempSync(join(scratch, "root-"));
const home = mkdtempSync(join(scratch, "home-"));
const config = join(home, "xdg");
const sandbox = recordSmokeSandbox({ root, cotalHome: home, xdgConfigHome: config });
const worktree = resolve(import.meta.dirname, "../../..");
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
Object.assign(env, { HOME: home, COTAL_HOME: home, XDG_CONFIG_HOME: config, COTAL_SKIP_CONNECTOR_SEED: "1" });
const run = (...args: string[]) => {
  const options = { cwd: root, env, encoding: "utf8" as const, timeout: 240_000 };
  assertSmokeSandboxDown(sandbox, args, options);
  return spawnSync(join(worktree, "node_modules/.bin/tsx"), [join(worktree, "bin/cotal.ts"), ...args], options);
};
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
  must("bare endpoint restores real artifact", run("up", "--restore", artifact, "--detach", "--server", server, "--space", space));
  const listed = run("channel", "show", "preserved", "--space", space);
  must("restored registry is readable", listed);
  check("restored registry retains its channel", listed.stdout.includes("preserved"));
  must("stop restored fixture", run("down"));
  running = false;
  completed = true;
} finally {
  // A failed cleanup keeps its records; do not hide a remaining owned stack by deleting them.
  if (running) {
    const stopped = run("down");
    check("failure cleanup stops owned stack", stopped.status === 0);
  }
  writeFileSync(join(scratch, "refusals.json"), `${JSON.stringify(refusals, null, 2)}\n`, { mode: 0o600 });
  console.log(`RESTORE ENDPOINT REDACTION: ${passed} passed, ${failed} failed`);
  for (const row of refusals) console.log(`REFUSAL ${row.name}: exit=${row.status}, privateEndpointEchoed=${(row.stdout + row.stderr).includes("fixture-only-private-endpoint")}`);
  if (completed && failed === 0) {
    rmSync(scratch, { recursive: true });
    console.log("Private fixture removed after successful stop");
  } else console.log(`Retained private fixture: ${scratch}`);
}
if (failed) process.exitCode = 1;
