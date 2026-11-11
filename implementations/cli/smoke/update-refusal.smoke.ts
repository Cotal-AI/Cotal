/** Update keeps recovery guidance and suggests an upgrade only after successful reconciliation. */
import "./update-isolation.js";
import assert from "node:assert/strict";
import { CommandFailure } from "@cotal-ai/workspace";
import { executeUpdate, updateRuntime, type UpdateRuntime } from "../src/commands/update.js";

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
