import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import type { DefaultPackageManager } from "@earendil-works/pi-coding-agent";

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

function isStandaloneCopy(path: string, resolveDirectory: (path: string) => string | undefined): boolean {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return hasStandaloneSignature(path);
    if (!stat.isDirectory()) return false;
    const entry = resolveDirectory(path);
    return entry?.startsWith("file:") === true && hasStandaloneSignature(fileURLToPath(entry));
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    // Pi still owns errors for resources it cannot load.
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return false;
    throw error;
  }
}

export function requireSpawnDiscovery(): void {
  if (!Reflect.get(globalThis, INSTALLED))
    throw new Error("pi connector: cannot filter duplicate Cotal extensions; spawn requires npm-installed Pi running on Node");
}

// Called by the loader facade. Keep Pi's package and trust resolution untouched, including reloads.
export function filterDiscoveries(Native: typeof DefaultPackageManager, packageManagerUrl: string): typeof DefaultPackageManager {
  const loaderUrl = new URL("extensions/loader.js", packageManagerUrl);
  type Resolver = { esmResolve(path: string, options: { try: true }): string | undefined };
  let jiti: Resolver | undefined;
  const resolveDirectory = (path: string): string | undefined => {
    // Local packages can reach the loader as directories. Use the host's Jiti resolution without
    // running the factory or assuming index.js wins over the package's declared entry.
    jiti ??= nodeModule.createRequire(loaderUrl)("jiti").createJiti(loaderUrl.href, { fsCache: false }) as Resolver;
    return jiti.esmResolve(path, { try: true });
  };
  Reflect.set(globalThis, INSTALLED, true);
  return class extends Native {
    override async resolve(...args: Parameters<DefaultPackageManager["resolve"]>) {
      const paths = await super.resolve(...args);
      return { ...paths, extensions: paths.extensions.filter((entry) => !entry.enabled || !isStandaloneCopy(entry.path, resolveDirectory)) };
    }
  };
}

function isPiResourceLoader(url: string | undefined): boolean {
  if (!url?.startsWith("file:") || !url.endsWith("/dist/core/resource-loader.js")) return false;
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", url), "utf8")).name === "@earendil-works/pi-coding-agent";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function installDiscoveryFilter(): void {
  if (typeof nodeModule.registerHooks !== "function") return;
  const facade = new URL("?package-manager", import.meta.url).href;
  let native: string;
  // Pi's CLI has no per-extension exclude flag. Adapt only its resource loader's package manager
  // import, then unregister the hook so it cannot affect extension imports or other modules.
  const hook = nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolution = nextResolve(specifier, context);
      if (specifier !== "./package-manager.js" || !isPiResourceLoader(context.parentURL)) return resolution;
      native = resolution.url;
      return { url: facade, shortCircuit: true };
    },
    load(url, context, nextLoad) {
      if (url !== facade) return nextLoad(url, context);
      hook.deregister();
      const source = `export * from ${JSON.stringify(native)};
import { DefaultPackageManager as Native } from ${JSON.stringify(native)};
import { filterDiscoveries } from ${JSON.stringify(import.meta.url)};
export const DefaultPackageManager = filterDiscoveries(Native, ${JSON.stringify(native)});`;
      return { format: "module", shortCircuit: true, source };
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
