/**
 * A third-party connector that takes no model variant, for the cells that prove the CLI's
 * unsupported-variant remedy. Every shipped connector takes a variant, so this fixture is the only
 * harness left that refuses one.
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writePluginFixture } from "../../../scripts/plugin-fixture.mjs";

/** The harness name the fixture registers. */
export const NO_VARIANT_HARNESS = "novariant";

const PKG = "cotal-smoke-novariant";
const VERSION = "1.0.0";

/** Write the fixture package under `prefix` and return its row for the prefix's `extensions.json`. */
export function installNoVariantConnector(prefix: string): Record<string, unknown> {
  const dir = join(prefix, "node_modules", PKG);
  const connector = { kind: "connector", name: NO_VARIANT_HARNESS, requires: ["node"] };
  writePluginFixture(dir, {
    name: PKG, version: VERSION, provides: [connector],
    factorySource: `export default host => host.register({
  ...${JSON.stringify(connector)},
  supportsLaunchValidation: true,
  buildLaunch(opts) {
    if (opts.variant) throw new Error("${NO_VARIANT_HARNESS} connector: model variants are not supported");
    return { command: process.execPath, args: ["-e", ""], env: {} };
  },
});
`,
  });
  return {
    pkg: PKG, version: VERSION, installId: randomUUID(), commands: [],
    provides: [{ kind: connector.kind, name: connector.name, aliases: [] }],
    connectors: [{ name: connector.name, requires: connector.requires, eventPlane: false, prompts: false, askPermissions: false, reasoningEvents: false, setup: null }],
  };
}
