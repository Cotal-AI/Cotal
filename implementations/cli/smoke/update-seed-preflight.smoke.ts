import "./update-isolation.js";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { executeUpdate, updateRuntime, type UpdateRuntime } from "../src/commands/update.js";
import { reconcileCursorPath, reconcileRecoveryPath, SEED_BUILTINS, seedDir } from "../src/seed/paths.js";
import { assertReadableSeedState } from "../src/seed/reconcile.js";

mkdirSync(seedDir(), { mode: 0o700 });
writeFileSync(reconcileCursorPath(), "{");
for (const self of [true, false]) {
  const effects: string[] = [], errors: string[] = [];
  const rt: UpdateRuntime = {
    ...updateRuntime, env: {}, version: () => "0.13.1",
    reportRunningManager: async () => "none",
    reconcile: async () => { effects.push("reconcile"); },
    refreshConnectors: async () => [], extensions: () => [], claimUpdatePass: () => () => {},
    npm: args => {
      if (args[0] === "view" && args[1] === "cotal-ai@latest") return { status: 0, stdout: '"0.13.2"', stderr: "" };
      effects.push("registry or install");
      return { status: 1, stdout: "", stderr: "unexpected registry work" };
    },
    out: () => {}, err: line => { errors.push(line); },
  };
  assert.equal(await executeUpdate(self, rt), 1);
  assert.deepEqual(effects, [], "corrupt cursor refuses before closure downloads, installation or connector writes");
  assert.match(errors.join("\n"), /corrupt seed state.*reconcile.cursor.json/);
  assert.equal(readFileSync(reconcileCursorPath(), "utf8"), "{", "preflight preserves corrupt evidence");
}
// Valid interrupted work remains recoverable and is not classified as a refusal.
writeFileSync(reconcileCursorPath(), JSON.stringify({ nonce: "prior", package: SEED_BUILTINS[0], phase: "add", failed: "interrupted" }));
writeFileSync(reconcileRecoveryPath(), JSON.stringify({ repairAllSeeded: true }));
assert.doesNotThrow(assertReadableSeedState);
const validCursor = readFileSync(reconcileCursorPath(), "utf8");
assert.equal(readFileSync(reconcileRecoveryPath(), "utf8"), '{"repairAllSeeded":true}');
writeFileSync(reconcileRecoveryPath(), "{}");
assert.throws(assertReadableSeedState, /corrupt recovery journal/);
assert.equal(readFileSync(reconcileCursorPath(), "utf8"), validCursor);
assert.equal(readFileSync(reconcileRecoveryPath(), "utf8"), "{}");
console.log("update seed preflight: corrupt journals refused, valid recovery preserved");
