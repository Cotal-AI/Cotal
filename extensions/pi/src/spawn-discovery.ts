import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import * as nodeModule from "node:module";
import type { DefaultPackageManager } from "@earendil-works/pi-coding-agent";

const MARKER = "/* @cotal-ai/pi standalone */";
const LEGACY_HEADER = "import { createRequire as __cotalCreateRequire } from 'node:module';";
const INSTALLED = Symbol.for("cotal.pi.spawn-discovery");

function isStandaloneCopy(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    // Pi still owns errors for resources it cannot load.
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return false;
    throw error;
  }
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
    return end.includes('Symbol.for("cotal.pi.runtimes")') && end.includes("export{cotalMesh as default}");
  } finally {
    closeSync(fd);
  }
}

export function requireSpawnDiscovery(): void {
  if (!Reflect.get(globalThis, INSTALLED))
    throw new Error("pi connector: cannot filter duplicate Cotal extensions; spawn requires npm-installed Pi running on Node");
}

// Called by the loader facade. Keep Pi's package and trust resolution untouched, including reloads.
export function filterDiscoveries(Native: typeof DefaultPackageManager): typeof DefaultPackageManager {
  Reflect.set(globalThis, INSTALLED, true);
  return class extends Native {
    override async resolve(...args: Parameters<DefaultPackageManager["resolve"]>) {
      const paths = await super.resolve(...args);
      return { ...paths, extensions: paths.extensions.filter((entry) => !entry.enabled || !isStandaloneCopy(entry.path)) };
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
export const DefaultPackageManager = filterDiscoveries(Native);`;
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
