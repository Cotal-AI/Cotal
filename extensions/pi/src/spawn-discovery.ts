import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { registerHooks } from "node:module";
import type { DefaultPackageManager } from "@earendil-works/pi-coding-agent";

const RESOURCE_LOADER = "/dist/core/resource-loader.js";
const PACKAGE_MANAGER = "./package-manager.js";
const PRELOAD = `--import=${import.meta.url}`;
const BUNDLE_HEADER = "import { createRequire as __cotalCreateRequire }";
const STANDALONE_MARKER = "/* @cotal-ai/pi standalone */ ";
const READY = Symbol.for("cotal.pi.spawn-discovery");

function isPiResourceLoader(url: string | undefined): boolean {
  if (!url?.startsWith("file:") || !url.endsWith(RESOURCE_LOADER)) return false;
  try {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", url), "utf8"));
    return manifest.name === "@earendil-works/pi-coding-agent";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isStandaloneCopy(path: string): boolean {
  if (!path.endsWith(".js") && !path.endsWith(".mjs")) return false;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    // Let Pi report a vanished or unreadable resource through its normal loader.
    if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return false;
    const header = Buffer.alloc(STANDALONE_MARKER.length + BUNDLE_HEADER.length);
    const bytes = header.toString("utf8", 0, readSync(fd, header, 0, header.length, 0));
    if (bytes.startsWith(STANDALONE_MARKER + BUNDLE_HEADER)) return true;
    if (!bytes.startsWith(BUNDLE_HEADER)) return false;
    // Older releases have no marker. Their factory and export are near the end of the bundle.
    const tail = Buffer.alloc(64 * 1024);
    const read = readSync(fd, tail, 0, tail.length, Math.max(0, stat.size - tail.length));
    const source = tail.toString("utf8", 0, read);
    return /Symbol\.for\(["']cotal\.pi\.runtimes["']\)/.test(source) &&
      /\bexport\s*\{\s*cotalMesh\s+as\s+default\s*\}/.test(source);
  } finally {
    closeSync(fd);
  }
}

export function requireDiscoveryFilter(): void {
  if (!Reflect.get(globalThis, READY))
    throw new Error("pi connector: cannot isolate standalone extension discovery; use the supported npm-installed Pi host");
}

export function withStandaloneFilter(manager: typeof DefaultPackageManager): typeof DefaultPackageManager {
  Reflect.set(globalThis, READY, true);
  return class extends manager {
    override async resolve(...args: Parameters<DefaultPackageManager["resolve"]>) {
      const paths = await super.resolve(...args);
      return { ...paths, extensions: paths.extensions.filter((entry) => !entry.enabled || !isStandaloneCopy(entry.path)) };
    }
  };
}

function installDiscoveryFilter(): void {
  const adapter = new URL("?adapter", import.meta.url).href;
  let packageManager: string;
  // Pi's CLI has no path filter. Substitute a subclass only for its resource loader,
  // before the native trust and discovery passes. Other consumers keep Pi's own class.
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== PACKAGE_MANAGER || !isPiResourceLoader(context.parentURL)) return nextResolve(specifier, context);
      packageManager = nextResolve(specifier, context).url;
      return { url: adapter, shortCircuit: true };
    },
    load(url, context, nextLoad) {
      if (url !== adapter) return nextLoad(url, context);
      hook.deregister();
      return {
        format: "module", shortCircuit: true,
        source: `import { DefaultPackageManager as Native } from ${JSON.stringify(packageManager)};
import { withStandaloneFilter } from ${JSON.stringify(import.meta.url)};
export const DefaultPackageManager = withStandaloneFilter(Native);`,
      };
    },
  });
}

const options = process.env.NODE_OPTIONS;
if (options === PRELOAD || options?.startsWith(`${PRELOAD} `)) {
  const forwarded = options.slice(PRELOAD.length + 1);
  if (forwarded) process.env.NODE_OPTIONS = forwarded;
  else delete process.env.NODE_OPTIONS;
  installDiscoveryFilter();
}
