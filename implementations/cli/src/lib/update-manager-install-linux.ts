import { readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { assertRecordIdentity, type ProcessIdentityRecord } from "@cotal-ai/workspace";

const ptyPackage = `@lydell/node-pty-linux-${process.arch}`;
const ptyFile = `prebuilds/linux-${process.arch}/pty.node`;
const bundledPty = `/node_modules/${ptyPackage}/${ptyFile}`;
const npmEntry = "/lib/node_modules/cotal-ai/dist/cotal.js";

const within = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};

/** The npm prefix of a retained generation package, or none when the path is not one. */
function generationPrefix(packageRoot: string): string | undefined {
  const marker = `${sep}lib${sep}.cotal-generations${sep}`;
  const at = packageRoot.lastIndexOf(marker);
  if (at < 0) return undefined;
  const rest = packageRoot.slice(at + marker.length).split(sep);
  if (rest.length !== 2 || !/^[a-f0-9]{32}$/.test(rest[0]!) || rest[1] !== "cotal-ai") return undefined;
  return packageRoot.slice(0, at);
}

/** Resolve without importing the Manager or loading its addon into the updater. */
function managerPty(entry: string): string | undefined {
  for (const modules of createRequire(entry).resolve.paths("@cotal-ai/manager") ?? []) {
    try {
      const manager = realpathSync(join(modules, "@cotal-ai/manager"));
      const pty = createRequire(join(manager, "package.json")).resolve("@lydell/node-pty");
      for (const base of createRequire(pty).resolve.paths(ptyPackage) ?? []) {
        try { return realpathSync(join(base, ptyPackage, ptyFile)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
  }
  return undefined;
}

/** A missing JS entry leaves no mapping. Require a live native dependency from a complete,
 * separate npm package at the former launch location or its renamed prefix. A retained
 * generation is that prefix plus `lib/.cotal-generations/<32 hex>/cotal-ai`. An arbitrary
 * mapped module, a shared runtime or an empty file list does not establish separation. */
export function managerOutsideInstall(pin: ProcessIdentityRecord | { pid: number }, argv: readonly string[], ownEntry: string, env: Record<string, string>): boolean {
  if (!("token" in pin) || env.NODE_OPTIONS || env.NODE_PATH) return false;
  const verb = argv.findIndex(arg => ["supervise", "__daemon-manager", "__service-manager", "__machine-manager"].includes(arg));
  const launch = argv[verb - 1];
  if (!launch || !isAbsolute(launch) || !launch.endsWith(npmEntry) ||
      argv.slice(1, verb - 1).some(arg => arg !== "--max-semi-space-size=1")) return false;
  try {
    const proc = `/proc/${pin.pid}`;
    if (readlinkSync(`${proc}/ns/mnt`) !== readlinkSync("/proc/self/ns/mnt")) return false;
    const root = statSync(`${proc}/root`, { bigint: true }), ours = statSync("/", { bigint: true });
    if (root.dev !== ours.dev || root.ino !== ours.ino) return false;
    const ownRoot = dirname(dirname(ownEntry));
    const ownPrefix = generationPrefix(ownRoot);
    const ownStore = ownPrefix === undefined
      ? join(dirname(dirname(ownRoot)), ".cotal-generations")
      : join(ownPrefix, "lib", ".cotal-generations");
    const ownPty = managerPty(ownEntry);
    if (!ownPty) return false;
    const native = statSync(ownPty, { bigint: true });
    const isOwn = (path: string) => within(ownRoot, path) || within(ownStore, path) || path === ownPty;
    if (isOwn(launch)) return false;
    const executable = statSync(`${proc}/exe`, { bigint: true }), node = statSync("/proc/self/exe", { bigint: true });
    if (executable.dev !== node.dev || executable.ino !== node.ino) return false;
    const references = [readlinkSync(`${proc}/exe`), readlinkSync(`${proc}/cwd`)];
    for (const fd of readdirSync(`${proc}/fd`)) {
      try { references.push(readlinkSync(`${proc}/fd/${fd}`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (references.some(path => isAbsolute(path) && isOwn(path.replace(/ \(deleted\)$/, "")))) return false;
    let foreign = false;
    for (const line of readFileSync(`${proc}/maps`, "utf8").trimEnd().split("\n")) {
      const map = /^[\da-f]+-[\da-f]+\s+([rwxps-]{4})\s+[\da-f]+\s+([\da-f]+):([\da-f]+)\s+(\d+)[ \t]*(.*)$/.exec(line);
      if (!map) return false;
      const [, permissions, major, minor, ino, name] = map;
      if (!name?.startsWith("/")) continue;
      // procfs escapes newlines indistinguishably from a literal backslash sequence.
      if (name.includes("\\012")) return false;
      const path = name.replace(/ \(deleted\)$/, "");
      const dev = (BigInt(`0x${major}`) & 0xfffn) << 8n | (BigInt(`0x${major}`) & ~0xfffn) << 32n |
        (BigInt(`0x${minor}`) & 0xffn) | (BigInt(`0x${minor}`) & ~0xffn) << 12n;
      if (isOwn(path) || dev === native.dev && BigInt(ino!) === native.ino) return false;
      if (!permissions!.includes("x") || path !== name || !path.endsWith(bundledPty)) continue;
      const packageRoot = path.slice(0, -bundledPty.length);
      const foreignEntry = join(packageRoot, "dist/cotal.js");
      const launchPrefix = launch.slice(0, -npmEntry.length);
      const mappedPrefix = foreignEntry.endsWith(npmEntry) ? foreignEntry.slice(0, -npmEntry.length) : generationPrefix(packageRoot);
      if (!mappedPrefix || isOwn(foreignEntry)) continue;
      const movedLaunch = mappedPrefix !== launchPrefix && dirname(mappedPrefix) === dirname(launchPrefix);
      if (mappedPrefix !== launchPrefix && !movedLaunch) continue;
      if (movedLaunch) {
        // A surviving launch prefix can be checked directly. Do not infer a rename past it.
        try { statSync(launchPrefix); return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
      }
      const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
      if (pkg.name !== "cotal-ai" || pkg.bin?.cotal !== "./dist/cotal.js" || realpathSync(foreignEntry) !== foreignEntry || managerPty(foreignEntry) !== path) continue;
      const mapped = statSync(path, { bigint: true });
      foreign ||= mapped.dev === dev && mapped.ino === BigInt(ino!);
    }
    return foreign && assertRecordIdentity(pin).kind === "match";
  } catch { return false; }
}
