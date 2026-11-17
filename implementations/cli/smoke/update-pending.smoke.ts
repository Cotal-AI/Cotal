import "./update-isolation.js";
import strictAssert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extensionsManifestPath, homeCotalDir } from "@cotal-ai/workspace";
import { countedAssert, emitSentinel } from "../../../bin/smoke/sentinel.mjs";
import { readUpdatePending, type UpdatePending } from "../src/lib/update-pending.js";

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
  if (result.kind === "receipt" || result.kind === "unreadable" && result.source !== "seed-store") assert.match(result.instruction, /cotal update --self/);
  return result;
}

assert.deepEqual(read(), { kind: "none" }, "fresh metadata does not imply pending seeding");
writeFileSync(manifest, JSON.stringify({ extensions: [{ pkg: "third-party", version: "0.1.0", spec: "third-party@0.1.0", commands: [] }] }));
assert.deepEqual(read(), { kind: "none" }, "third-party skew is not a pending first-party update");
writeFileSync(manifest, JSON.stringify({ extensions: [{ pkg: "@cotal-ai/tmux", version: "0.161.1", spec: "@cotal-ai/tmux@0.161.1", commands: [] }] }));
const skew = read();
assert.equal(skew.kind, "version-mismatch");
if (skew.kind === "version-mismatch") {
  assert.deepEqual(skew.extensions, [{ package: "@cotal-ai/tmux", version: "0.161.1" }]);
  assert.equal(skew.instruction, "Reconciliation pending: Run `cotal update` to reconcile this configuration home with the installed CLI.");
}
const seed = join(process.env.XDG_CONFIG_HOME!, "cotal", "seed");
mkdirSync(seed, { mode: 0o700 });
const stamp = join(seed, "stamp.json");
writeFileSync(stamp, JSON.stringify({ generation: "0.165.0" }));
const ahead = read();
assert.equal(ahead.kind, "version-mismatch");
if (ahead.kind === "version-mismatch") {
  assert.match(ahead.instruction, /Use a CLI at 0\.165\.0 or newer/);
  assert.doesNotMatch(ahead.instruction, /cotal update/);
}
writeFileSync(stamp, "{broken");
const badStamp = read();
assert.equal(badStamp.kind, "unreadable");
if (badStamp.kind === "unreadable") assert.equal(badStamp.source, "seed-store");
writeFileSync(stamp, JSON.stringify({ generation: "not-a-version" }));
assert.equal(read().kind, "unreadable", "invalid generation is not treated as an absent stamp");
writeFileSync(stamp, JSON.stringify({ generation: "0.165.0" }));
const recovery = { v: 1, previous: "0.161.1", target: "0.164.0", installed: "0.164.0", phase: "replacing", reason: "replacement pending", recordedAt: "2026-11-13T12:00:00.000Z" };
writeFileSync(receipt, JSON.stringify(recovery));
const pending = read();
assert.equal(pending.kind, "receipt", "receipt takes precedence over inventory skew and a newer seed store");
if (pending.kind === "receipt") assert.deepEqual(pending.recovery, recovery);
writeFileSync(receipt, "{broken");
const unreadable = read();
assert.equal(unreadable.kind, "unreadable", "corrupt receipt is not absent metadata");
if (unreadable.kind === "unreadable") {
  assert.equal(unreadable.source, "receipt");
  assert.ok(unreadable.error.length > 0);
}
emitSentinel({ passed: counted.cells(), failed: 0 });
