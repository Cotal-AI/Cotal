import "./update-isolation.js";
import strictAssert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionsManifestPath, homeCotalDir, processStartToken } from "@cotal-ai/workspace";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { readUpdatePending, type UpdatePending } from "../src/lib/update-pending.js";
import { reconcileChildPath, reconcileCursorPath, reconcileRecoveryPath } from "../src/seed/paths.js";
import { acquireReconcileLock } from "../src/seed/lock.js";
import { update, updateRuntime } from "../src/commands/update.js";

const counted = countedAssert(strictAssert);
const assert: typeof strictAssert = counted.assert as typeof strictAssert;
const roots = [process.env.HOME!, process.env.COTAL_HOME!, process.env.XDG_CONFIG_HOME!];
const manifest = extensionsManifestPath();
const receipt = join(homeCotalDir(), "update-recovery.json");
mkdirSync(join(process.env.XDG_CONFIG_HOME!, "cotal", "extensions"), { recursive: true, mode: 0o700 });

function hashes(): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) { result[file] = "directory"; walk(file); }
      else result[file] = createHash("sha256").update(readFileSync(file)).digest("hex");
    }
  }
  for (const root of roots) walk(root);
  return result;
}

function read(): UpdatePending {
  const before = hashes();
  const result = readUpdatePending("0.164.0");
  assert.deepEqual(hashes(), before, "diagnostic creates no files and changes no file hashes");
  if (result.kind !== "none") assert.match(result.instruction, result.kind === "seed-active" ? /Wait.*cotal update --check/ : result.kind === "seed" || result.kind === "unreadable" && result.source === "seed" ? /cotal ext seed/ : /cotal update --self/);
  return result;
}

assert.deepEqual(read(), { kind: "none" }, "fresh metadata does not imply pending seeding");
writeFileSync(manifest, JSON.stringify({ extensions: [{ pkg: "third-party", version: "0.1.0", spec: "third-party@0.1.0", commands: [] }] }));
assert.deepEqual(read(), { kind: "none" }, "third-party skew is not a pending first-party update");
writeFileSync(manifest, JSON.stringify({ extensions: [{ pkg: "@cotal-ai/tmux", version: "0.161.1", spec: "@cotal-ai/tmux@0.161.1", commands: [] }] }));
const skew = read();
assert.equal(skew.kind, "version-mismatch");
if (skew.kind === "version-mismatch") assert.deepEqual(skew.extensions, [{ package: "@cotal-ai/tmux", version: "0.161.1" }]);
const recovery = { v: 1, previous: "0.161.1", target: "0.164.0", installed: "0.164.0", phase: "replacing", reason: "replacement pending", recordedAt: "2026-11-13T12:00:00.000Z" };
writeFileSync(receipt, JSON.stringify(recovery));
const pending = read();
assert.equal(pending.kind, "receipt", "receipt takes precedence over inventory skew");
if (pending.kind === "receipt") assert.deepEqual(pending.recovery, recovery);
writeFileSync(receipt, "{broken");
const unreadable = read();
assert.equal(unreadable.kind, "unreadable", "corrupt receipt is not absent metadata");
if (unreadable.kind === "unreadable") {
  assert.equal(unreadable.source, "receipt");
  assert.ok(unreadable.error.length > 0);
}
rmSync(receipt);

const cursorPath = reconcileCursorPath();
const recoveryPath = reconcileRecoveryPath();
mkdirSync(join(cursorPath, ".."), { recursive: true, mode: 0o700 });
writeFileSync(manifest, JSON.stringify({ extensions: [{ pkg: "@cotal-ai/tmux", version: "0.164.0", spec: "@cotal-ai/tmux@0.164.0", commands: [] }] }));
assert.equal(read().kind, "none", "matching inventory is complete without a seed journal");

async function report(json: boolean, active = false, remedy = /cotal ext seed --repair/): Promise<string> {
  let stdout = "", stderr = "";
  const out = process.stdout.write, err = process.stderr.write, code = process.exitCode;
  const before = hashes();
  process.stdout.write = ((chunk: string) => ((stdout += chunk), true)) as typeof out;
  process.stderr.write = ((chunk: string) => ((stderr += chunk), true)) as typeof err;
  try {
    await update({ values: { check: true, ...(json ? { json: true } : { plain: true }) }, positionals: [], raw: [] }, {
      ...updateRuntime,
      version: () => "0.164.0",
      extensions: () => [],
      npm: args => {
        assert.equal(args[0], "view", "check only queries the registry, never installs");
        return { status: 0, stdout: '"0.164.0"', stderr: "" };
      },
      reconcile: async () => { assert.fail("check never reconciles"); },
      refreshConnectors: async () => { assert.fail("check never refreshes connectors"); },
    });
    assert.equal(process.exitCode, active ? 0 : 4, "live seeding is informational, pending or unreadable repair is partial");
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    process.exitCode = code;
  }
  assert.deepEqual(hashes(), before, "check leaves seed journals, package metadata and file set unchanged");
  if (json) assert.equal(stderr, "", "JSON is a single envelope");
  else {
    assert.match(stdout, /Reconciliation/);
    assert.match(stdout + stderr, active ? /Wait.*cotal update --check/ : remedy);
    if (active) assert.doesNotMatch(stdout + stderr, /ext seed --repair/);
  }
  return stdout;
}

for (const cursor of [
  { nonce: "interrupted", package: "claude", phase: "copy" },
  { nonce: "failed", package: "opencode", phase: "add", failed: "npm install failed" },
]) {
  writeFileSync(cursorPath, JSON.stringify(cursor));
  const pending = read();
  assert.equal(pending.kind, "seed", "cursor is pending despite matching versions");
  if (pending.kind === "seed") assert.deepEqual(pending.cursor, cursor);
  const output = JSON.parse(await report(true));
  assert.equal(output.outcome, "partial");
  assert.equal(output.completeness, "partial");
  assert.equal(output.error.code, "OPERATION_PARTIAL");
  assert.match(output.error.remedy, /cotal ext seed --repair/);
  assert.equal(output.result.reconciliation.kind, "seed");
  assert.equal(output.result.installationChanged, false);
  assert.equal(output.result.processesRestarted, false);
  assert.deepEqual(output.warnings.map((warning: { code: string }) => warning.code), ["SEED_RECONCILIATION_PENDING"]);
  const plain = await report(false);
  if (cursor.failed) {
    assert.match(plain, /npm install failed - fix that, then run/);
    assert.match(output.error.remedy, /npm install failed - fix that, then run/);
  }
}

const childPath = reconcileChildPath();
const held = acquireReconcileLock();
try {
  const active = read();
  assert.equal(active.kind, "seed-active", "a live reconcile lock means wait, even with an old failed cursor");
  if (active.kind === "seed-active") assert.doesNotMatch(active.instruction, /ext seed --repair/);
  const output = JSON.parse(await report(true, true));
  assert.equal(output.outcome, "ok");
  assert.equal(output.completeness, "complete");
  assert.equal(output.result.reconciliation.kind, "seed-active");
  assert.deepEqual(output.warnings, []);
  await report(false, true);
  rmSync(cursorPath);
  writeFileSync(recoveryPath, JSON.stringify({ rebuildFromDisk: true }));
  assert.equal(read().kind, "seed-active", "live custody also covers a cursorless maintenance obligation");
  rmSync(recoveryPath);
} finally {
  held.release();
}
writeFileSync(cursorPath, JSON.stringify({ nonce: "child", package: "claude", phase: "add" }));
writeFileSync(childPath, JSON.stringify({ state: "live", parentPid: process.pid, childPid: process.pid, childStart: processStartToken(process.pid), nonce: "child", ts: Date.now() }));
assert.equal(read().kind, "seed-active", "a live seed child still means wait after its parent lock is gone");
assert.equal(JSON.parse(await report(true, true)).result.reconciliation.kind, "seed-active");
await report(false, true);
writeFileSync(childPath, JSON.stringify({ state: "live", parentPid: process.pid, childPid: process.pid, childStart: "not-this-process", nonce: "child", ts: Date.now() }));
assert.equal(read().kind, "seed", "a recycled child identity does not hide interrupted repair");
writeFileSync(childPath, JSON.stringify({ state: "pending", parentPid: process.pid, nonce: "child", ts: 0 }));
const stale = read();
assert.equal(stale.kind, "seed");
if (stale.kind === "seed") assert.match(stale.instruction, /cotal ext seed` to resume/);
assert.match(JSON.parse(await report(true)).error.remedy, /cotal ext seed` to resume/);
await report(false, false, /cotal ext seed` to resume/);
writeFileSync(childPath, "{broken");
const ambiguous = read();
assert.equal(ambiguous.kind, "seed");
const markerRemedy = /if no cotal process is running, remove it, then run `cotal ext seed --repair`/;
if (ambiguous.kind === "seed") {
  assert.ok(ambiguous.instruction.includes(childPath), "the remedy identifies only the ambiguous child marker");
  assert.match(ambiguous.instruction, markerRemedy);
}
const ambiguousReport = JSON.parse(await report(true));
assert.match(ambiguousReport.warnings[0].message, markerRemedy);
assert.match(ambiguousReport.error.remedy, markerRemedy);
assert.match((await report(false)).replace(/\s+/g, " "), markerRemedy);
rmSync(childPath);

writeFileSync(receipt, JSON.stringify(recovery));
assert.equal(read().kind, "receipt", "update recovery retains precedence over seed repair");
rmSync(receipt);
rmSync(cursorPath);
writeFileSync(recoveryPath, JSON.stringify({ repairAllSeeded: true }));
const obligation = read();
assert.equal(obligation.kind, "seed", "maintenance obligation survives without a cursor");
if (obligation.kind === "seed") assert.deepEqual(obligation.recovery, { repairAllSeeded: true });
assert.equal(JSON.parse(await report(true)).result.reconciliation.kind, "seed");
rmSync(recoveryPath);

for (const path of [cursorPath, recoveryPath]) {
  for (const contents of ["{broken", "{}", "null", "[]"]) {
    writeFileSync(path, contents);
    const pending = read();
    assert.equal(pending.kind, "unreadable", "invalid seed journal never means no reconciliation");
    if (pending.kind === "unreadable") assert.equal(pending.source, "seed");
    const output = JSON.parse(await report(true));
    assert.equal(output.result.reconciliation.source, "seed");
    assert.deepEqual(output.warnings.map((warning: { code: string }) => warning.code), ["RECONCILIATION_UNREADABLE"]);
    assert.match(output.error.remedy, /cotal ext seed --repair/);
    rmSync(path);
  }
}
assert.equal(read().kind, "none", "clearing the seed journals restores the healthy metadata report");
emitSentinel({ passed: counted.cells(), failed: 0 });
