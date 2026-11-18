import "./update-isolation.js";
import strictAssert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionsManifestPath, homeCotalDir } from "@cotal-ai/workspace";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { readUpdatePending, type UpdatePending } from "../src/lib/update-pending.js";
import { reconcileCursorPath, reconcileRecoveryPath } from "../src/seed/paths.js";
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
  if (result.kind !== "none") assert.match(result.instruction, result.kind === "seed" || result.kind === "unreadable" && result.source === "seed" ? /cotal ext seed --repair/ : /cotal update --self/);
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

async function report(json: boolean): Promise<string> {
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
    assert.equal(process.exitCode, 4, "pending or unreadable seed metadata makes the check partial");
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    process.exitCode = code;
  }
  assert.deepEqual(hashes(), before, "check leaves seed journals, package metadata and file set unchanged");
  if (json) assert.equal(stderr, "", "JSON is a single envelope");
  else {
    assert.match(stdout, /Reconciliation/);
    assert.match(stdout + stderr, /cotal ext seed --repair/);
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
  await report(false);
}
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
