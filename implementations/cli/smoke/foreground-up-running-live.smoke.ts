/** `cotal up --foreground` against a stack that is already running must refuse. The refresh path
 * starts nothing in this terminal, so it cannot keep the stack's lifetime here. It used to print
 * `✓ already running` and exit 0, and a service unit that relies on `--foreground` then treated
 * that exit as the stack ending. When another project requests the same address, the refusal
 * names its local registration. Uses a private home/root and an allocated loopback port,
 * starts no agents, and retains the sandbox and logs.
 * Run: pnpm smoke:foreground-up-running:live */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dialerFor, drainAndClose, membershipStoreDefinition } from "@cotal-ai/core";
import { StorageType } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { foregroundCliProbe } from "./_foreground-cli-probe.js";
import { assertSmokeSandboxDown, emitSentinel, freePort, recordSmokeSandbox } from "@cotal-ai/smoke-kit";

const wt = resolve(import.meta.dirname, "../../..");
const cliEntry = join(wt, "bin/cotal.ts");
const tsx = import.meta.resolve("tsx");
const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal-foreground-running-")));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COTAL_|CLAUDE_|ANTHROPIC_|OPENAI_|JCODE_)/i.test(k)));
let passed = 0;

function portOpen(port: number): Promise<boolean> {
  return new Promise((r) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (value: boolean) => { socket.destroy(); r(value); };
    socket.once("connect", () => done(true)); socket.once("error", () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}

const home = join(base, "home"), mesh = join(base, "mesh");
for (const p of [home, mesh, join(mesh, ".cotal"), join(home, "xdg"), join(home, "runtime"), join(home, "machine")]) mkdirSync(p, { recursive: true, mode: 0o700 });
const sandbox = recordSmokeSandbox({ root: mesh, cotalHome: join(home, "machine"), xdgConfigHome: join(home, "xdg") });
const port = await freePort(); assert.notEqual(port, 4222);
const space = "foreground-running";
const env = { ...cleanEnv, HOME: home, COTAL_HOME: join(home, "machine"), XDG_CONFIG_HOME: join(home, "xdg"), XDG_RUNTIME_DIR: join(home, "runtime"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" };
const server = `nats://127.0.0.1:${port}`;
const stack = ["--server", server, "--space", space, "--open", "--no-manager"];
const logs: Record<string, { code: number | null; out: string; err: string }> = {};
console.log(`foreground-up-running retained evidence: ${base}`);
try {
  logs.detached = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["up", "--detach", ...stack]);
  assert.equal(logs.detached.code, 0, `the detached stack starts: ${logs.detached.err}`); passed++;
  assert.equal(await portOpen(port), true, "the detached broker listens"); passed++;

  const downHelp = logs.downHelp = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["help", "down"]);
  assert.equal(downHelp.code, 0, downHelp.err); passed++;
  assert.match(downHelp.out.replace(/\s+/g, " "), /cotal down --dry-run inspect the stack without stopping anything/); passed++;
  assert.match(downHelp.out.replace(/\s+/g, " "), /Options .*--dry-run bare: inspect local records only\. For a running legacy stack, this is partial \(exit 4\), not a stop plan/); passed++;
  assertSmokeSandboxDown(sandbox, ["down", "--dry-run"], { cwd: mesh, env });
  const dryRun = logs.dryRun = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--dry-run"]);
  assert.equal(dryRun.code, 4, dryRun.out + dryRun.err); passed++;
  assert.match(dryRun.out, /Whole-stack local inspection/); passed++;
  assert.match(dryRun.out, /not a stop plan/); passed++;
  assert.equal(await portOpen(port), true, "the dry run leaves the running broker alone"); passed++;

  const wrongSpace = "other-legacy-space";
  const message = `--space "${wrongSpace}" does not match the space "${space}" recorded in this folder; nothing was stopped`;
  const remedy = `locate the project root for space "${wrongSpace}" before retrying`;
  for (const format of ["--json", "--plain", "default"]) {
    const args = ["down", "--space", wrongSpace, ...(format === "default" ? [] : [format])];
    assertSmokeSandboxDown(sandbox, args, { cwd: mesh, env });
    const wrong = logs[`wrong-space-${format}`] = await foregroundCliProbe(cliEntry, tsx, mesh, env, args);
    assert.equal(wrong.code, 2, wrong.out + wrong.err);
    if (format === "--json") {
      assert.equal(wrong.err, "");
      const report = JSON.parse(wrong.out);
      assert.equal(report.outcome, "refused");
      assert.deepEqual(report.error, { code: "UNSUPPORTED", message, remedy });
    } else {
      assert.equal(wrong.out, "");
      assert.match(wrong.err, /Code:\s+UNSUPPORTED\n/);
      assert.ok(wrong.err.includes(`  ${message}\n`) && wrong.err.includes(`Next\n  ${remedy}\n`), wrong.err);
    }
    assert.equal(await portOpen(port), true, `the ${format} refusal leaves the running broker alone`); passed++;
  }

  logs.foreground = await foregroundCliProbe(cliEntry, tsx, base, env, ["up", "--foreground", "--root", mesh, ...stack]);
  assert.equal(logs.foreground.code, 2, `foreground up over a running stack must not succeed: ${logs.foreground.out}`); passed++;
  assert.match(logs.foreground.err, /already running .* can't keep it in this terminal/, "the refusal names the running stack"); passed++;
  assert.ok(logs.foreground.err.includes("LIFECYCLE_BLOCKED") && logs.foreground.err.includes(mesh) && logs.foreground.err.includes("down --yes`") && logs.foreground.err.includes("retry the original foreground command unchanged"), logs.foreground.err); passed++;
  assert.doesNotMatch(logs.foreground.out, /already running at/, "no success line is printed over the refusal"); passed++;
  assert.equal(await portOpen(port), true, "the refusal leaves the running broker alone"); passed++;

  for (const [folder, spaceFlag] of [["explicit-project", ["--space", "explicit-project"]], ["inferred-project", []]] as const) {
    const project = join(base, folder);
    mkdirSync(join(project, ".cotal"), { recursive: true, mode: 0o700 });
    const collision = logs[folder] = await foregroundCliProbe(cliEntry, tsx, project, env, ["up", "--foreground", "--server", server, ...spaceFlag]);
    assert.equal(collision.code, 1, `an occupied explicit address must be refused: ${collision.err}`); passed++;
    assert.ok(collision.err.includes(`address registered to mesh "${space}" (${mesh})`), collision.err); passed++;
    assert.ok(collision.err.includes(`to run "${folder}"`), collision.err); passed++;
  }
  assert.equal(await portOpen(port), true, "both collision refusals leave the registered broker listening"); passed++;

  const manualHome = join(base, "manual-home"), manualRoot = join(manualHome, "project");
  const manualCaller = join(base, "manual-caller");
  for (const project of [manualRoot, manualCaller]) mkdirSync(join(project, ".cotal"), { recursive: true, mode: 0o700 });
  const manualEnv = { ...env, COTAL_HOME: manualHome };
  logs.add = await foregroundCliProbe(cliEntry, tsx, manualRoot, manualEnv, ["space", "add", "manual-registration", "--server", server, "--root", manualRoot, "--mode", "open", "--force"]);
  assert.equal(logs.add.code, 0, logs.add.err); passed++;
  logs.manual = await foregroundCliProbe(cliEntry, tsx, manualCaller, manualEnv, ["up", "--foreground", "--server", server, "--space", "other-project"]);
  assert.equal(logs.manual.code, 1, logs.manual.err); passed++;
  assert.match(logs.manual.err, /already in use by a broker not started here/); passed++;
  logs.manualForeground = await foregroundCliProbe(cliEntry, tsx, manualRoot, manualEnv, ["up", "--foreground", "--server", server, "--space", "manual-registration", "--open"]);
  assert.equal(logs.manualForeground.code, 2, logs.manualForeground.err); passed++;
  assert.match(logs.manualForeground.err, /stop the broker with the launcher that started it/); passed++;
  assert.doesNotMatch(logs.manualForeground.err, /cotal down/); passed++;
  const nc = await dialerFor(server)({ servers: server });
  try {
    await new Kvm(nc).create(membershipStoreDefinition("manual-registration").bucket, { history: 1, storage: StorageType.File });
    const migration = logs.manualMigration = await foregroundCliProbe(cliEntry, tsx, manualRoot, manualEnv, ["up", "--detach", "--server", server, "--space", "manual-registration", "--open"]);
    assert.equal(migration.code, 2, migration.err);
    assert.match(migration.err, /legacy File-backed membership store/);
    assert.match(migration.err, /stop the broker with the launcher that started it/);
    assert.doesNotMatch(migration.err, /cotal down/); passed++;
  } finally { await drainAndClose(nc); }
  console.log("PASS foreground-up-running");
} finally {
  try {
    if (await portOpen(port)) {
      assertSmokeSandboxDown(sandbox, ["down", "--yes"], { cwd: mesh, env });
      logs.down = await foregroundCliProbe(cliEntry, tsx, mesh, env, ["down", "--yes"]);
    }
  } finally {
    for (const [name, log] of Object.entries(logs)) writeFileSync(join(base, `${name}.json`), JSON.stringify(log), { mode: 0o600 });
  }
}
assert.equal(await portOpen(port), false, "cleanup stopped the broker"); passed++;
console.log(`foreground-up-running: ${passed} passed, 0 failed`);
emitSentinel({ cells: passed, passed, failed: 0 });
