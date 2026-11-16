import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { appUpdateNotice, renderAppUpdate, appliedUpdateSummary, type AppUpdate, type AppUpdateReceipt } from "../src/app-update";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

for (const [state, automatic, expected] of [
  [{ phase: "unconfigured" }, true, "This build cannot update itself. Use the installer to update Cotal."],
  [{ phase: "idle" }, true, "Updates have not been checked yet."],
  [{ phase: "checking" }, true, "Checking for desktop updates…"],
  [{ phase: "current" }, true, "You are up to date."],
  [{ phase: "available", version: "0.165.0" }, false, "Version 0.165.0 is available. Automatic updates are off."],
  [{ phase: "downloading", version: "0.165.0", downloaded: 25, total: 100 }, true, "Downloading Cotal 0.165.0 (25%)…"],
  [{ phase: "ready", version: "0.165.0" }, true, "Cotal 0.165.0 is downloaded and verified. Restart to update, or close the window to update automatically."],
  [{ phase: "available", version: "0.165.0", reason: "An app operation is still running. The update will wait." }, true, "Version 0.165.0 is available. An app operation is still running. The update will wait."],
  [{ phase: "preparing" }, true, "The newest release is still being prepared."],
  [{ phase: "failed", reason: "Signature verification failed" }, true, "Desktop update failed: Signature verification failed. It will retry at the next check."],
] satisfies [AppUpdate, boolean, string][]) {
  test(`real update component renders ${state.phase}${automatic ? "" : " with auto off"}`, () => {
    const dom = new JSDOM('<p aria-live="polite"></p>');
    try {
      const node = dom.window.document.querySelector("p")!;
      renderAppUpdate(node, state, automatic);
      assert.equal(node.textContent, expected);
      assert.equal(node.dataset.updateState, state.phase);
      assert.equal(node.getAttribute("aria-live"), "polite");
      const text = node.firstChild;
      renderAppUpdate(node, state, automatic);
      assert.equal(node.firstChild, text, "unchanged status does not replace its live-region text");
    } finally { dom.window.close(); }
  });
}
test("publication gaps cannot turn a registry-only version into a main-view notice", () => {
  assert.equal(appUpdateNotice({ phase: "preparing" }), undefined);
  assert.equal(appUpdateNotice({ phase: "preparing", version: "0.165.0" }), "0.165.0");
  assert.equal(appUpdateNotice({ phase: "preparing", version: "0.165.0" }, "0.165.0"), undefined);
  assert.equal(appUpdateNotice({ phase: "failed", reason: "Interrupted download" }), undefined);
});

test("Updated requires target service, readable agents and ready Manager inventory", () => {
  const receipt: AppUpdateReceipt = { schema: 1, from: "0.164.8", target: "0.164.9", phase: "installed", reopen: true };
  const ready = { state: "ready", version: "0.164.9", agents: [], managers: [{ state: "answering", instanceId: "fixture", connectors: [{ state: "available" }] }] };
  assert.equal(appliedUpdateSummary(receipt, "0.164.9", ready), "Updated to Cotal 0.164.9.");
  assert.match(appliedUpdateSummary(receipt, "0.164.9", undefined)!, /Waiting for the background service/);
  assert.match(appliedUpdateSummary(receipt, "0.164.8", ready)!, /has not been confirmed/);
  assert.match(appliedUpdateSummary(receipt, "0.164.9", { ...ready, version: "0.164.8", generation: { waiting: "1 seat(s) in team" } })!, /waiting: 1 seat\(s\) in team/);
  assert.match(appliedUpdateSummary(receipt, "0.164.9", { ...ready, agents: [{ state: "unreadable", space: "team" }] })!, /readable agent inventory/);
  assert.match(appliedUpdateSummary(receipt, "0.164.9", { ...ready, managers: [{ state: "starting" }] })!, /agent applications to be ready/);
  assert.match(appliedUpdateSummary({ ...receipt, phase: "failed", reason: "Permission denied" }, "0.164.8", ready)!, /Permission denied/);
});
