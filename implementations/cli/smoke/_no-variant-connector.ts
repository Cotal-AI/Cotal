/**
 * A third-party connector that takes no model variant, for the cells that prove the CLI's
 * unsupported-variant remedy. Every shipped connector takes a variant, so this fixture is the only
 * harness left that refuses one. It is installed into a suite's extension prefix as a package that
 * peer-depends on core, as `cotal ext add` would leave it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The harness name the fixture registers. */
export const NO_VARIANT_HARNESS = "novariant";

const PKG = "cotal-smoke-novariant";
const VERSION = "1.0.0";

/** Write the fixture package under `prefix` and return its row for the prefix's `extensions.json`. */
export function installNoVariantConnector(prefix: string): Record<string, unknown> {
  const dir = join(prefix, "node_modules", PKG);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: PKG, version: VERSION, type: "module", main: "index.js", peerDependencies: { "@cotal-ai/core": "*" } }));
  writeFileSync(join(dir, "index.js"), `import { registry } from "@cotal-ai/core";
registry.register({
  kind: "connector",
  name: ${JSON.stringify(NO_VARIANT_HARNESS)},
  requires: ["node"],
  supportsLaunchValidation: true,
  buildLaunch(opts) {
    if (opts.variant) throw new Error("${NO_VARIANT_HARNESS} connector: model variants are not supported");
    return { command: process.execPath, args: ["-e", ""], env: {} };
  },
});
`);
  return { pkg: PKG, version: VERSION, commands: [], provides: [{ kind: "connector", name: NO_VARIANT_HARNESS }], connectors: [{ name: NO_VARIANT_HARNESS, requires: ["node"], eventPlane: false, setup: null }] };
}
