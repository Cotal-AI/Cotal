import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { appUpdateNotice, renderAppUpdate, type AppUpdate } from "../src/app-update";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

for (const [state, automatic, expected] of [
  [{ phase: "unconfigured" }, true, "This build cannot update itself. Use the installer to update Cotal."],
  [{ phase: "idle" }, true, "Updates have not been checked yet."],
  [{ phase: "checking" }, true, "Checking for desktop updates…"],
  [{ phase: "current" }, true, "You are up to date."],
  [{ phase: "available", version: "0.165.0" }, false, "Version 0.165.0 is available. Automatic updates are off."],
  [{ phase: "downloading", version: "0.165.0", downloaded: 25, total: 100 }, true, "Downloading Cotal 0.165.0 (25%)…"],
  [{ phase: "ready", version: "0.165.0" }, true, "Cotal 0.165.0 is downloaded and verified. Waiting to install safely."],
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
