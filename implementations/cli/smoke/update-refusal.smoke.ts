/** Update keeps recovery guidance and suggests an upgrade only after successful reconciliation. */
import "./update-isolation.js";
import rawAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { CommandFailure } from "@cotal-ai/workspace";
import { executeUpdate, updateRuntime, type UpdateRuntime } from "../src/commands/update.js";

const counted = countedAssert(rawAssert);
const assert: typeof rawAssert = counted.assert;
const cells = counted.cells;

for (const [self, latest] of [[false, "0.13.2"], [true, "0.13.2"], [true, "0.13.1"]] as const) {
  for (const outcome of ["classified", "error", "legacy", "ready"] as const) {
    const out: string[] = [], err: string[] = [], effects: string[] = [];
    const remedy = "list agents with cotal ps, stop each with cotal stop <name>, then rerun the same update command";
    const rt: UpdateRuntime = {
      ...updateRuntime,
      env: {},
      version: () => "0.13.1",
      checkout: () => false,
      reportRunningManager: async () => {
        if (outcome === "classified") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "running agents block update", { remedy });
        if (outcome === "error") throw new Error("status did not answer");
        return outcome === "legacy" ? "legacy" : "none";
      },
      reconcile: async () => { effects.push("reconcile"); },
      refreshConnectors: async () => [],
      extensions: () => [],
      claimUpdatePass: () => () => {},
      npm: (args) => {
        assert.equal(args[0], "view", "refused updates never request installation");
        return { status: 0, stdout: JSON.stringify(latest), stderr: "" };
      },
      out: (text) => { out.push(text); },
      err: (text) => { err.push(text); },
    };
    // A successful global install is outside this rendering test. Its positive control is the
    // ordinary reconcile (including --self at the current version), which must keep the Next step.
    if (outcome === "ready" && self && latest !== "0.13.1") continue;
    assert.equal(await executeUpdate(self, rt), outcome === "ready" ? 0 : 1);
    if (outcome === "ready") {
      assert.deepEqual(effects, ["reconcile"]);
      assert.ok(out.join("\n").includes(latest === "0.13.2" ? "cotal update --self" : "cotal status"));
      assert.deepEqual(err, []);
    } else {
      assert.deepEqual(effects, [], "continuity refusal leaves installation untouched");
      assert.ok(!out.join("\n").includes("cotal update --self"), "a refused update has no unusable upgrade suggestion");
      if (!self || latest === "0.13.1") assert.ok(out.join("\n").includes("CLI version"), "version information remains available");
      if (outcome === "classified") assert.equal(err[0], `✗ running manager continuity check: running agents block update\n\nNext\n  ${remedy}`);
      if (outcome === "error") assert.equal(err[0], "✗ running manager continuity check: status did not answer");
    }
  }
}
console.log("update-refusal.smoke: classified, unclassified, legacy and successful reports passed");

// The real bound-child entry must adopt before any reconcile effects, and cannot hide denial.
for (const denied of [false, true]) {
  const effects: string[] = [], errors: string[] = [];
  const rt: UpdateRuntime = {
    ...updateRuntime,
    env: { COTAL_UPDATE_TARGET_VERSION: "0.13.1", COTAL_UPDATE_PARENT: "123", COTAL_AUTO_UPDATE: "1" },
    parentPid: 123,
    version: () => "0.13.1",
    adoptUpdateChild: async () => { effects.push("adopt"); if (denied) throw new Error("scope denied"); },
    reconcile: async () => { effects.push("reconcile"); },
    reportRunningManager: async () => "none",
    refreshConnectors: async () => [],
    extensions: () => [],
    claimUpdatePass: () => () => {},
    waitForInstalledGeneration: async () => { effects.push("wait"); },
    npm: () => { throw new Error("unexpected npm call"); },
    out: () => {},
    err: text => { errors.push(text); },
  };
  assert.equal(await executeUpdate(false, rt), denied ? 1 : 0);
  assert.equal(effects[0], "adopt");
  if (denied) {
    assert.deepEqual(effects, ["adopt"]);
    assert.match(errors.join("\n"), /scope denied.*package replacement already occurred.*parent may retry or restore/);
  } else assert.ok(effects.includes("reconcile"));
}
emitSentinel({ passed: cells(), failed: 0 });
