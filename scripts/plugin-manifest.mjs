import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const dir = process.cwd();
const file = resolve(dir, "package.json");
const old = readFileSync(file, "utf8");
const pkg = JSON.parse(old);
const { version: coreVersion } = JSON.parse(readFileSync(new URL("../packages/core/package.json", import.meta.url), "utf8"));
if (pkg.version !== coreVersion) throw new Error(`${pkg.name} and its bundled core must have the same version`);

const unregister = register();
try {
  const { pluginManifest } = await import("../packages/workspace/src/plugin-manifest.ts");
  const { default: factory } = await import(pathToFileURL(resolve(dir, "dist/index.js")).href);
  if (typeof factory !== "function") throw new Error(`${pkg.name} must export a plugin factory`);
  pkg.cotal = await pluginManifest(factory, { coreVersion });
  const next = `${JSON.stringify(pkg, null, 2)}\n`;
  if (next !== old) writeFileSync(file, next);
} finally {
  unregister();
}
