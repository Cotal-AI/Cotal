import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";

const MARKER = "/* @cotal-ai/pi standalone */";
const LEGACY_HEADER = "import { createRequire as __cotalCreateRequire } from 'node:module';";
const INSTALLED = Symbol.for("cotal.pi.spawn-discovery");

function hasStandaloneSignature(path: string): boolean {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return false;
    const header = Buffer.alloc(Buffer.byteLength(`\uFEFF${MARKER} ${LEGACY_HEADER}`));
    const source = header.toString("utf8", 0, readSync(fd, header, 0, header.length, 0)).replace(/^\uFEFF/, "");
    if (source.startsWith(`${MARKER} ${LEGACY_HEADER}`)) return true;
    if (!source.startsWith(LEGACY_HEADER)) return false;
    // Released copies without the marker have these two identifiers near the end of the bundle.
    const tail = Buffer.alloc(64 * 1024);
    const end = tail.toString("utf8", 0, readSync(fd, tail, 0, tail.length, Math.max(0, stat.size - tail.length)));
    return end.includes('Symbol.for("cotal.pi.runtimes")') && /\bexport\s*\{\s*cotalMesh\s+as\s+default\s*\}/.test(end);
  } finally {
    closeSync(fd);
  }
}

function isStandaloneCopy(url: string | undefined): boolean {
  if (!url?.startsWith("file:")) return false;
  try {
    return hasStandaloneSignature(fileURLToPath(url));
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    // Pi still owns errors for resources it cannot load.
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return false;
    throw error;
  }
}

export function requireSpawnDiscovery(): void {
  if (!Reflect.get(globalThis, INSTALLED))
    throw new Error("pi connector: cannot filter duplicate Cotal extensions; use a compatible npm-installed Pi on Node (for example Pi 0.79.10)");
}

interface ExtensionLoader {
  esmResolve(path: string, options: { try: true }): string | undefined;
  import(path: string, options?: { default?: boolean }): Promise<unknown>;
}

// Pi has already applied trust and path normalization when it asks Jiti for a factory.
// Use that same Jiti instance to resolve directories. Do not evaluate a duplicate bundle.
export function wrapExtensionLoader(createJiti: (...args: unknown[]) => ExtensionLoader): typeof createJiti {
  return (...args) => {
    const loader = createJiti(...args);
    const load = loader.import.bind(loader);
    loader.import = (path, options) => {
      if (options?.default && isAbsolute(path)) {
        Reflect.set(globalThis, INSTALLED, true);
        if (isStandaloneCopy(loader.esmResolve(path, { try: true }))) return Promise.resolve(() => {});
      }
      return load(path, options);
    };
    return loader;
  };
}

function piLoaderImport(specifier: string, parent: string | undefined): boolean {
  if (!parent?.startsWith("file:")) return false;
  const unpacked = specifier === "jiti/static" && parent.endsWith("/dist/core/extensions/loader.js");
  const bundled = (specifier === "jiti" || /^\.\/jiti-(?:static-)?loader-[\w-]+\.js$/.test(specifier)) &&
    /\/dist\/bundle\/chunks\/[^/]+\.js$/.test(parent);
  if (!unpacked && !bundled) return false;
  try {
    return JSON.parse(readFileSync(new URL("../../../package.json", parent), "utf8")).name === "@earendil-works/pi-coding-agent";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function facadeSource(native: string, format: "commonjs" | "module"): string {
  if (format === "commonjs") return `const native = require(${JSON.stringify(fileURLToPath(native))});
const { wrapExtensionLoader } = require(${JSON.stringify(fileURLToPath(import.meta.url))});
module.exports = { createJiti: wrapExtensionLoader(native.createJiti) };`;
  return `import { createJiti as native } from ${JSON.stringify(native)};
import { wrapExtensionLoader } from ${JSON.stringify(import.meta.url)};
export const createJiti = wrapExtensionLoader(native);`;
}

function installDiscoveryFilter(): void {
  if (typeof nodeModule.registerHooks !== "function") return;
  const facades = new Map<string, { native: string; format: "commonjs" | "module" }>();
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolution = nextResolve(specifier, context);
      if (!piLoaderImport(specifier, context.parentURL)) return resolution;
      const format = resolution.url.endsWith(".cjs") ? "commonjs" : "module";
      const url = `${resolution.url}.cotal.${format === "commonjs" ? "cjs" : "mjs"}`;
      facades.set(url, { native: resolution.url, format });
      return { url, format, shortCircuit: true };
    },
    load(url, context, nextLoad) {
      const facade = facades.get(url);
      if (!facade) return nextLoad(url, context);
      return { format: facade.format, shortCircuit: true, source: facadeSource(facade.native, facade.format) };
    },
  });
}

const ownOption = `--import=${import.meta.url}`;
const nodeOptions = process.env.NODE_OPTIONS;
if (nodeOptions === ownOption || nodeOptions?.startsWith(`${ownOption} `)) {
  const remaining = nodeOptions.slice(ownOption.length + 1);
  if (remaining) process.env.NODE_OPTIONS = remaining;
  else delete process.env.NODE_OPTIONS;
  installDiscoveryFilter();
}
