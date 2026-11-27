import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { globalConfigDir } from "@cotal-ai/core";
import { logicalExecutionEntry } from "@cotal-ai/workspace";

function ownInstallKey(): string | undefined {
  const logical = logicalExecutionEntry();
  if (!logical) return undefined;
  const root = dirname(dirname(logical));
  if (basename(root) === "bin" && (existsSync(join(dirname(root), "implementations")) || existsSync(join(dirname(root), "pnpm-workspace.yaml")))) return undefined;
  if (existsSync(join(root, "desktop-runtime.json"))) return undefined;
  const normalized = logical.replace(/([/\\]pnpm[/\\]dlx[/\\][^/\\]+[/\\])[^/\\]+(?=[/\\]node_modules[/\\])/, "$1*");
  return createHash("sha256").update(normalized).digest("hex");
}

function holdsExtensionStages(dir: string, base: string): boolean {
  if (dir === base) return true;
  const rel = relative(base, dir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
  const parts = rel.split(sep);
  return parts.length === 5 && parts[0] === "installs" && parts[2] === "sets" &&
    (parts[4] === ".retired-cotal" || /^cotal(?:-[a-f0-9]{16})?$/.test(parts[4]!));
}

/** Run an npm spawn with 022 added to the process umask, keeping any stricter bits, then put the
 *  previous umask back as soon as the spawn call returns. The child takes its umask when it is
 *  created. Under a umask of 0002, npm makes group-writable directories, files and bin targets,
 *  and its own `--umask` setting leaves package directories and bin targets group-writable. */
export function withInstallUmask<T>(spawn: () => T): T {
  const previous = process.umask(0o022);
  process.umask(previous | 0o022);
  try {
    return spawn();
  } finally {
    process.umask(previous);
  }
}

/** Remove group and other write from every folder and file under `root` this account owns, without
 *  following a link, and return how many changed; a missing `root` changes nothing. Unpublished
 *  `.extensions.stage-*` directories at the config root and under retained version sets keep their
 *  modes and are not entered so stage cleanup can test their origin, and other installations'
 *  retained trees under `installs/` are left alone. An installer from
 *  before its 022 umask, or a seed run before its npm children got one, left Cotal's install or its
 *  config folder group-writable under a umask of 0002, and a folder another account can write makes
 *  the protected-path rule refuse what is under it, such as the runtime Node selected as a handler or
 *  a seeded extension. */
export function repairInstallModes(root: string, onError?: (error: NodeJS.ErrnoException) => void): number {
  if (process.platform === "win32") return 0;
  const normalize = (p: string): string => isAbsolute(p) ? resolve(p) : p;
  const rootBase = normalize(root);
  const configRaw = globalConfigDir();
  const configBases = new Set<string>([normalize(configRaw)]);
  try { configBases.add(realpathSync.native(configRaw)); } catch {}
  const stageBases = new Set<string>([rootBase, ...configBases]);
  const installKey = ownInstallKey();
  let realRoot: string | undefined;
  try { realRoot = realpathSync.native(root); } catch {}
  let changed = 0;
  const walk = (path: string): void => {
    let stat;
    try {
      stat = lstatSync(path, { throwIfNoEntry: false });
    } catch (error) {
      if (onError) { onError(error as NodeJS.ErrnoException); return; }
      throw error;
    }
    if (!stat || stat.isSymbolicLink() || stat.uid !== process.getuid!()) return;
    if ((stat.mode & 0o022) !== 0 && (stat.isDirectory() || stat.isFile())) {
      try {
        chmodSync(path, stat.mode & 0o7755);
        changed++;
      } catch (error) {
        if (onError) onError(error as NodeJS.ErrnoException);
        else throw error;
      }
    }
    if (stat.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(path);
      } catch (error) {
        if (onError) { onError(error as NodeJS.ErrnoException); return; }
        throw error;
      }
      const dir = normalize(path);
      const sub = relative(rootBase, dir);
      const realDir = realRoot ? (sub ? join(realRoot, sub) : realRoot) : undefined;
      const skipStages = [...stageBases].some(base => holdsExtensionStages(dir, base) || (realDir !== undefined && holdsExtensionStages(realDir, base)));
      const skipForeignInstalls = installKey !== undefined && [...configBases].some(base =>
        dir === join(base, "installs") || realDir === join(base, "installs"));
      for (const name of names) {
        if (skipStages && name.startsWith(".extensions.stage-")) continue;
        if (skipForeignInstalls && name !== installKey) continue;
        walk(join(path, name));
      }
    }
  };
  walk(root);
  return changed;
}
