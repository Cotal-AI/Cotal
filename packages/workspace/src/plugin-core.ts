import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { MIN_PLUGIN_CORE } from "@cotal-ai/core";
import { hostPackageDir, type InstalledExtensionPackage } from "./extensions.js";
import { comparePeerVersions } from "./import-diagnosis.js";
import type { PluginDeclaration } from "./plugin-manifest.js";

function packageVersion(file: string): string {
  const { version } = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
  if (typeof version !== "string" || comparePeerVersions(version, version) !== 0)
    throw new Error("core package metadata has no valid version");
  return version;
}

/** Verify the bundled or resolved core without importing the plugin. */
export function checkPluginCore(pkg: string, meta: InstalledExtensionPackage, declaration: PluginDeclaration, entry: string, hostCore = packageVersion(join(hostPackageDir("@cotal-ai/core"), "package.json"))): void {
  if (hostCore === "0.0.0" || hostCore.startsWith("0.0.0-")) return;
  if (pkg.startsWith("@cotal-ai/")) {
    if (meta.version !== hostCore || declaration.core !== hostCore)
      throw new Error(`plugin ${pkg}@${meta.version} bundles core ${declaration.core ?? "not declared"}, this CLI uses ${hostCore}; run \`cotal update --self\``);
    return;
  }
  let pluginCore = declaration.core;
  if (pluginCore === undefined && meta.dependencies?.["@cotal-ai/core"] === undefined) return;
  if (pluginCore === undefined) {
    try { pluginCore = packageVersion(createRequire(entry).resolve("@cotal-ai/core/package.json")); }
    catch (error) { throw new Error(`plugin ${pkg} has no readable core version; run \`cotal ext add ${pkg}@latest\``, { cause: error }); }
  }
  const older = comparePeerVersions(pluginCore, MIN_PLUGIN_CORE);
  const newer = comparePeerVersions(pluginCore, hostCore);
  // A development build of contract 1 can validate against its own core before the cut is stamped.
  const floorApplies = (comparePeerVersions(hostCore, MIN_PLUGIN_CORE) ?? 0) >= 0;
  if (older === undefined || newer === undefined || (floorApplies && older < 0))
    throw new Error(`plugin ${pkg} uses unsupported core ${pluginCore}; run \`cotal ext add ${pkg}@latest\``);
  if (newer > 0)
    throw new Error(`plugin ${pkg} uses newer core ${pluginCore}, this CLI uses ${hostCore}; run \`cotal update --self\``);
}
