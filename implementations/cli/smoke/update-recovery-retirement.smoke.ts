import "./update-isolation.js";
import strictAssert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStartToken } from "@cotal-ai/workspace";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert;
const root = mkdtempSync(join(tmpdir(), "update-recovery-retirement-"));
const fixture = join(import.meta.dirname, "update-recovery.fixture.ts");
const now = Date.now();
function cell(name: string) {
  const base = join(root, name);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))), HOME: join(base, "home"), COTAL_HOME: join(base, "cotal"), XDG_CONFIG_HOME: join(base, "config"), TMPDIR: join(base, "tmp"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_NO_UPDATE_CHECK: "1", RECOVERY_TEST_NOW: String(now) };
  for (const path of [env.HOME, env.COTAL_HOME, env.TMPDIR, join(env.XDG_CONFIG_HOME, "cotal"), join(base, "foreign/.update-snapshot-old")]) mkdirSync(path, { recursive: true, mode: 0o700 });
  const foreign = join(base, "foreign/.update-snapshot-old");
  writeFileSync(join(foreign, "untouched"), "foreign snapshot bytes\n");
  const record = { v: 1, previous: "0.13.1", target: "0.14.0", installed: "unknown", phase: "paused", snapshot: foreign, owner: { pid: 2147483647, start: "dead-start", nonce: "old-owner" }, reason: "interrupted update", recordedAt: "2026-11-12T00:00:00.000Z" };
  const receipt = join(env.COTAL_HOME, "update-recovery.json");
  const attempt = join(env.COTAL_HOME, "update-attempt.json");
  const observation = join(env.COTAL_HOME, "update-recovery-observed.json");
  const save = (value: unknown = record) => writeFileSync(receipt, JSON.stringify(value, null, 2) + "\n");
  save();
  writeFileSync(attempt, '{"failures":2,"result":"old attempt","next":0}\n');
  const run = (extra: Record<string, string> = {}, words = ["update", "--self"]) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", fixture, ...words], { env: { ...env, ...extra }, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(result.error, undefined);
    return { code: result.status, output: result.stdout + result.stderr };
  };
  const retained = () => readdirSync(env.COTAL_HOME).filter(name => name.startsWith("update-recovery-retained-"));
  return { env, record, receipt, attempt, observation, foreign, save, run, retained };
}

for (const automatic of [false, true]) {
  const c = cell(automatic ? "dead-auto" : "dead-manual");
  const before = [readFileSync(c.receipt), readFileSync(c.attempt)];
  const foreignBefore = readFileSync(join(c.foreign, "untouched"));
  const check = c.run({}, ["update", "--check"]);
  assert.equal(check.code, 0, check.output);
  assert.match(check.output, /retain these unusable records and continue/);
  assert.deepEqual(readFileSync(c.receipt), before[0], "check does not rewrite recovery");
  assert.equal(existsSync(c.observation), false, "check never starts observation");
  const result = c.run(automatic ? { COTAL_AUTO_UPDATE: "1" } : {});
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Retained unusable interrupted-update records in .*; continuing the update/);
  assert.match(result.output, /ordinary reconciliation completed/);
  assert.equal(c.retained().length, 1);
  const destination = join(c.env.COTAL_HOME, c.retained()[0]!);
  assert.deepEqual(readFileSync(join(destination, "update-recovery.json")), before[0]);
  assert.deepEqual(readFileSync(join(destination, "update-attempt.json")), before[1]);
  assert.deepEqual(readFileSync(join(c.foreign, "untouched")), foreignBefore);
  assert.deepEqual(readdirSync(c.foreign), ["untouched"]);
}

for (const lookupFails of [false, true]) {
  const c = cell(lookupFails ? "lookup-error" : "live");
  c.record.owner = { pid: process.pid, start: processStartToken(process.pid)!, nonce: "live-owner" };
  c.save();
  const before = [readFileSync(c.receipt), readFileSync(c.attempt)];
  const result = c.run(lookupFails ? { RECOVERY_TEST_LOOKUP_FAILURE: "1" } : {});
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, lookupFails ? /Cannot read update owner pid.*process identity access denied/ : new RegExp(`update is in progress in pid ${process.pid}`));
  assert.match(result.output, /Previous 0.13.1, target 0.14.0, recorded 2026-11-12/);
  assert.doesNotMatch(result.output, /OPERATION_UNKNOWN/);
  assert.deepEqual(readFileSync(c.receipt), before[0]);
  assert.deepEqual(readFileSync(c.attempt), before[1]);
  assert.equal(existsSync(c.observation), false);
  assert.deepEqual(c.retained(), []);
}

for (const failed of [false, true]) {
  const c = cell(failed ? "valid-restore-failure" : "valid-startup");
  const local = join(c.env.XDG_CONFIG_HOME, "cotal/.update-snapshot-valid");
  mkdirSync(join(local, "seed"), { recursive: true, mode: 0o700 });
  writeFileSync(join(local, "seed", "restored"), "original seed bytes");
  c.save({ ...c.record, phase: "replacing", snapshot: local });
  const result = c.run(failed ? { RECOVERY_TEST_RESTORE_FAIL: "1" } : { RECOVERY_TEST_STARTUP: "1" });
  if (failed) {
    assert.notEqual(result.code, 0, result.output);
    assert.equal(JSON.parse(readFileSync(c.receipt, "utf8")).phase, "paused");
    assert.equal(existsSync(local), true, "a valid snapshot with a failed restore is never retired");
  } else {
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /startup restored: true/);
    assert.equal(readFileSync(join(c.env.XDG_CONFIG_HOME, "cotal/seed/restored"), "utf8"), "original seed bytes");
  }
  assert.deepEqual(c.retained(), []);
}

for (const malformed of [false, true]) {
  const c = cell(malformed ? "malformed-owner" : "missing-owner");
  const { owner: _owner, ...unowned } = c.record;
  c.save(malformed ? { ...unowned, owner: { pid: "not-a-pid" } } : unowned);
  const before = readFileSync(c.receipt);
  const first = c.run();
  assert.equal(first.code, 2, first.output);
  assert.match(first.output, /3600 seconds remaining/);
  const observed = readFileSync(c.observation);
  assert.equal(JSON.parse(observed.toString()).firstObservedAt, now);
  const second = c.run({ RECOVERY_TEST_NOW: String(now + 1000) });
  assert.equal(second.code, 2, second.output);
  assert.match(second.output, /3599 seconds remaining/);
  assert.deepEqual(readFileSync(c.observation), observed, "refusal does not reset first observation");
  assert.deepEqual(readFileSync(c.receipt), before);
  const retired = c.run({ RECOVERY_TEST_NOW: String(now + 3600000) });
  assert.equal(retired.code, 0, retired.output);
  assert.deepEqual(readFileSync(join(c.env.COTAL_HOME, c.retained()[0]!, "update-recovery.json")), before);
  assert.deepEqual(readFileSync(join(c.env.COTAL_HOME, c.retained()[0]!, "update-recovery-observed.json")), observed);
}

{
  const c = cell("changed-record");
  const { owner: _owner, ...unowned } = c.record;
  c.save(unowned);
  assert.equal(c.run().code, 2);
  c.save({ ...unowned, reason: "different record" });
  const changed = c.run({ RECOVERY_TEST_NOW: String(now + 3600000) });
  assert.equal(changed.code, 2, changed.output);
  assert.equal(JSON.parse(readFileSync(c.observation, "utf8")).firstObservedAt, now + 3600000);
}

for (const shape of ["absent", "missing", "file", "symlink", "reused-owner"] as const) {
  const c = cell(shape);
  const local = join(c.env.XDG_CONFIG_HOME, "cotal/.update-snapshot-old");
  if (shape === "file") writeFileSync(local, "not a directory");
  if (shape === "symlink") symlinkSync(c.foreign, local);
  c.save({ ...c.record, snapshot: shape === "absent" ? undefined : shape === "reused-owner" ? c.foreign : local, ...(shape === "reused-owner" ? { owner: { ...c.record.owner, pid: process.pid, start: "prior-boot" } } : {}) });
  const result = c.run();
  assert.equal(result.code, 0, result.output);
  assert.equal(c.retained().length, 1);
}

{
  const c = cell("valid-snapshot");
  const local = join(c.env.XDG_CONFIG_HOME, "cotal/.update-snapshot-valid");
  mkdirSync(join(local, "seed"), { recursive: true, mode: 0o700 });
  writeFileSync(join(local, "seed", "restored"), "original seed bytes");
  c.save({ ...c.record, snapshot: local });
  const result = c.run();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Restored cotal-ai@0.13.1/);
  assert.equal(readFileSync(join(c.env.XDG_CONFIG_HOME, "cotal/seed/restored"), "utf8"), "original seed bytes");
  assert.equal(existsSync(local), false);
  assert.deepEqual(c.retained(), []);
}

emitSentinel({ passed: counted.cells(), failed: 0 });
