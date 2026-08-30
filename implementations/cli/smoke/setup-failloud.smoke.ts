/**
 * Fail-loud smoke for guided setup's connector discovery and its connector-owned setup seam (no
 * NATS). Both boundaries are driven through the SHIPPED functions `cotal setup` itself calls.
 *
 * Discovery: a genuinely REMOVED connector (absent from the manifest) simply leaves the setup
 * surface; a PRESENT-but-broken one (in the manifest, but broken/missing on disk) must fail loud
 * with the real repair diagnostic, never be silently dropped or misreported as a removal.
 *
 * Setup seam: a connector that declares no provider yields no step (setup narrates it as ready);
 * a connector that DECLARES a provider which cannot be materialized fails loud, because the base
 * CLI never substitutes a built-in harness implementation.
 *
 * Run: pnpm smoke:setup-failloud
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Connector } from "@cotal-ai/core";
import { setInstalledExtensionsEnabled } from "../src/ext-loader.js";
import { connectorSetupStep, setupConnectorSurface } from "../src/commands/setup.js";

const tmp = mkdtempSync(join(import.meta.dirname, ".setup-failloud-"));
process.env.XDG_CONFIG_HOME = tmp;
setInstalledExtensionsEnabled(true); // published-binary posture: an unregistered connector materializes from the manifest

const manifestPath = join(tmp, "cotal", "extensions", "extensions.json");
mkdirSync(join(tmp, "cotal", "extensions"), { recursive: true });
const writeManifest = (extensions: unknown[]) => writeFileSync(manifestPath, JSON.stringify({ extensions }));
const launch = () => ({ command: "true", args: [] });

try {
  // Removed: absent from the manifest means absent from the surface setup derives membership from.
  writeManifest([]);
  assert.deepEqual(await setupConnectorSurface(), [], "a removed connector must leave the setup surface");

  // Broken-present: a connector this CLI has never heard of IS in the manifest but has no package on
  // disk. The same discovery boundary guided setup uses must propagate the real repair diagnostic
  // rather than dropping the connector or reporting a deliberate removal.
  writeManifest([
    { pkg: "@example/connector-unfamiliar", version: "9.9.9", spec: ".", provides: [{ kind: "connector", name: "unfamiliar" }], commands: [] },
  ]);
  await assert.rejects(setupConnectorSurface(), /is in the manifest but not installed/, "a broken-present unfamiliar connector must fail loud");

  // A healthy connector that declares no setup provider owns no setup: no step, no crash.
  writeManifest([]);
  const bare: Connector = { kind: "connector", name: "failloud-bare", buildLaunch: launch };
  assert.equal(await connectorSetupStep(bare, "connector"), null, "a connector declaring no provider yields no setup step");

  // A DECLARED provider that cannot be materialized is a loud registry error, never a silent skip
  // and never a built-in harness fallback.
  const phantom: Connector = {
    kind: "connector",
    name: "failloud-phantom",
    setup: { kind: "connector-setup", name: "failloud-phantom" },
    buildLaunch: launch,
  };
  await assert.rejects(
    connectorSetupStep(phantom, "connector"),
    /no installed extension provides connector-setup/,
    "a declared-but-unresolvable setup provider must fail loud",
  );

  console.log("setup-failloud.smoke: all assertions passed");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
