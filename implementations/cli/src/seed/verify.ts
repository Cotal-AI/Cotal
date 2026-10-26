import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { join, resolve, sep } from "node:path";
import { SEEDED_EXTENSIONS, extensionPackageDir, extensionsDir, type InstalledExtension } from "@cotal-ai/workspace";
import { seedStorePath, shippedSourceDir } from "./paths.js";

/**
 * Why `cotal update` still has to reinstall a seeded built-in that is recorded at this generation, or
 * undefined when its installed copy is proven to be the payload this binary ships.
 *
 * The proof is byte for byte, read from disk now: the shipped payload, the seed-store copy the
 * manifest spec names, and the installed package hold the same files with the same contents, the
 * installed package is a real directory inside the extensions prefix rather than a link out of it,
 * and the entry is the seeded one at this generation. Any doubt is a reason, and a reason runs the
 * ordinary reinstall; nothing here repairs, and nothing is skipped on a guess.
 */
export function seededInstallDiffers(name: string, generation: string, entry: InstalledExtension): string | undefined {
  const pkg = SEEDED_EXTENSIONS[name].pkg;
  const store = seedStorePath(generation, name);
  if (entry.source !== "seeded") return "the installed entry is operator-managed";
  if (entry.version !== generation) return `recorded at ${entry.version}, not ${generation}`;
  if (resolve(entry.spec) !== store) return `recorded spec ${entry.spec} is not this generation's store payload`;
  const installed = extensionPackageDir(pkg);
  let kind: ReturnType<typeof lstatSync>;
  try {
    kind = lstatSync(installed);
  } catch {
    return "not installed on disk";
  }
  if (kind.isSymbolicLink()) return "installed as a link, not a copy";
  if (!kind.isDirectory()) return "the installed path is not a directory";
  if (!realpathSync(installed).startsWith(realpathSync(extensionsDir()) + sep)) return "the installed copy resolves outside the extensions prefix";
  const shipped = shippedSourceDir(name);
  const files = payloadFiles(shipped);
  if (typeof files === "string") return `the shipped payload ${files}`;
  for (const [copy, label] of [[store, "the seed store copy"], [installed, "the installed copy"]] as const) {
    const have = payloadFiles(copy);
    if (typeof have === "string") return `${label} ${have}`;
    if (have.length !== files.length) return `${label} holds ${have.length} files, the shipped payload ${files.length}`;
    for (let i = 0; i < files.length; i++) {
      if (have[i] !== files[i]) return `${label} has ${have[i]} where the shipped payload has ${files[i]}`;
      if (!sameBytes(join(shipped, files[i]), join(copy, files[i]))) return `${label} differs at ${files[i]}`;
    }
  }
  return undefined;
}

/**
 * Why the extensions prefix is not the tree its lock records, or undefined when every recorded
 * package is on disk at its recorded version. This is the same comparison npm makes before it
 * decides a reinstall changes nothing, made once for the whole prefix rather than once per
 * built-in, so an update that skips a reinstall still leaves no missing or skewed dependency behind.
 */
export function prefixLockDiffers(): string | undefined {
  const prefix = extensionsDir();
  let lock: { packages?: Record<string, { version?: unknown; link?: unknown; optional?: unknown; os?: unknown; cpu?: unknown }> };
  try {
    lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8")) as typeof lock;
  } catch (e) {
    return `the prefix lock is unreadable: ${(e as Error).message}`;
  }
  if (!lock.packages || typeof lock.packages !== "object") return "the prefix lock records no packages";
  for (const [key, recorded] of Object.entries(lock.packages)) {
    if (key === "" || recorded.link === true) continue;
    if (typeof recorded.version !== "string") return `the prefix lock records no version for ${key}`;
    let actual: unknown;
    try {
      actual = (JSON.parse(readFileSync(join(prefix, key, "package.json"), "utf8")) as { version?: unknown }).version;
    } catch {
      // npm installs an optional package only on a platform its `os` and `cpu` lists admit; one the lock
      // records for another platform is absent by npm's own rule, not missing.
      if (recorded.optional === true && (excludesHost(recorded.os, process.platform) || excludesHost(recorded.cpu, process.arch))) continue;
      return `${key} is recorded in the prefix lock but not installed`;
    }
    if (actual !== recorded.version) return `${key} is ${String(actual)} on disk and ${recorded.version} in the prefix lock`;
  }
  return undefined;
}

/** The payload's regular files, sorted, relative to `root`, with nested `node_modules` and `.git`
 *  left out the way the stager leaves them out; or why the tree cannot be compared. */
function payloadFiles(root: string): string[] | string {
  const files: string[] = [];
  const walk = (dir: string, rel: string): string | undefined => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return `cannot be read at ${rel || "."}: ${(e as Error).message}`;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = join(rel, entry.name);
      if (entry.isSymbolicLink()) return `contains a link at ${path}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const problem = walk(join(dir, entry.name), path);
        if (problem) return problem;
      } else if (entry.isFile()) files.push(path);
      else return `contains a special file at ${path}`;
    }
    return undefined;
  };
  return walk(root, "") ?? files;
}

/** Whether a lock entry's `os` or `cpu` list, when it is one, leaves this host out. */
function excludesHost(list: unknown, value: string): boolean {
  return Array.isArray(list) && list.every((entry) => typeof entry === "string") && !list.includes(value);
}

function sameBytes(a: string, b: string): boolean {
  if (statSync(a).size !== statSync(b).size) return false;
  return readFileSync(a).equals(readFileSync(b));
}
