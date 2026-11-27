import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hostPackageDir, pluginManifest, resolveExtensionEntry } from "@cotal-ai/workspace";

/** Generate a declaration from an author's built package. This runs the factory intentionally. */
export async function generateExtensionManifest(directory = "."): Promise<void> {
  const dir = resolve(directory);
  const file = join(dir, "package.json");
  const old = readFileSync(file, "utf8");
  const pkg = JSON.parse(old);
  if (!pkg || typeof pkg.name !== "string" || typeof pkg.version !== "string")
    throw new Error("the plugin package.json must declare a name and version");
  const entry = resolveExtensionEntry(dir, { version: pkg.version, main: pkg.main, exports: pkg.exports });
  const { default: factory } = await import(pathToFileURL(entry).href);
  if (typeof factory !== "function") throw new Error("the plugin entry must export a default factory");
  const coreVersion = pkg.dependencies?.["@cotal-ai/core"] === undefined
    ? JSON.parse(readFileSync(join(hostPackageDir("@cotal-ai/core"), "package.json"), "utf8")).version as string
    : undefined;
  pkg.cotal = await pluginManifest(factory, { coreVersion });
  const rendered = `${JSON.stringify(pkg, null, 2)}\n`;
  if (rendered !== old) writeFileSync(file, rendered);
}
