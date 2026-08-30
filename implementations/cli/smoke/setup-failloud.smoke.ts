/**
 * Fail-loud smoke for `cotal setup`'s claude-plugin step (no NATS). A genuinely REMOVED connector
 * (absent from the manifest) skips the plugin with a re-add hint; a PRESENT-but-broken connector (in
 * the manifest, but broken/missing on disk) must fail loud through runSteps, never be misreported as a
 * deliberate removal. Run: pnpm smoke:setup-failloud
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setInstalledExtensionsEnabled } from "../src/ext-loader.js";
import { setupConnectorSurface } from "../src/commands/setup.js";

const tmp = mkdtempSync(join(import.meta.dirname, ".setup-failloud-"));
process.env.XDG_CONFIG_HOME = tmp;
setInstalledExtensionsEnabled(true); // published-binary posture: an unregistered connector materializes from the manifest

const manifestPath = join(tmp, "cotal", "extensions", "extensions.json");
mkdirSync(join(tmp, "cotal", "extensions"), { recursive: true });
const writeManifest = (extensions: unknown[]) => writeFileSync(manifestPath, JSON.stringify({ extensions }));

try {
  // Removed: absent from the manifest means absent from setup's connector surface.
  writeManifest([]);
  assert.deepEqual(await setupConnectorSurface(), [], "a removed connector must leave the setup surface");

  // Broken-present: an unfamiliar connector IS in the manifest but has no package on disk -> the same
  // discovery boundary guided setup uses must fail loud rather than silently dropping it.
  writeManifest([
    { pkg: "@example/connector-unfamiliar", version: "9.9.9", spec: ".", provides: [{ kind: "connector", name: "unfamiliar" }], commands: [] },
  ]);
  await assert.rejects(setupConnectorSurface(), /is in the manifest but not installed/, "a broken-present unfamiliar connector must fail loud");

  console.log("setup-failloud.smoke: all assertions passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
