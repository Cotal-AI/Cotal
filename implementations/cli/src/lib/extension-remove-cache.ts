import { existsSync, opendirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { readLocalRecordSource, resolveOnPath, type InstalledExtension } from "@cotal-ai/workspace";
import { seedWriterKind } from "../seed/paths.js";

interface LockedPackage {
  resolved?: string;
  dependencies?: Record<string, string>;
  optional?: boolean;
}

/** An offline removal can finish without fetching only when npm can reuse the retained packages.
 * Check the known empty-cache case without running uninstall against the live prefix. */
export function offlineRemovalNeedsCache(prefix: string, removing: string, extensions: readonly InstalledExtension[]): boolean {
  if (npmSetting("offline") !== "true" ||
      !extensions.some(({ pkg, source }) => pkg === removing && source !== "seeded") ||
      existsSync(join(prefix, "node_modules", removing)) || seedWriterKind() !== "released") return false;
  const seeded = extensions.filter(({ source }) => source === "seeded");
  if (!seeded.length) return false;
  try {
    const cache = npmCache(prefix);
    if (!cache || !emptyCache(cache)) return false;
    const lock = readLock(join(prefix, "package-lock.json"));
    const actual = readLock(join(prefix, "node_modules", ".package-lock.json"));
    return seeded.some(({ pkg }) => {
      const key = `node_modules/${pkg}`;
      const expected = lock[key];
      if (!expected?.resolved?.startsWith("file:")) return false;
      // A moved file dependency can still be installed but carry its former identity in npm's
      // actual-tree lock. npm can unpack the retained built-in's registry dependencies again.
      const recorded = actual[key]?.resolved;
      const moved = recorded?.startsWith("file:") && recorded !== expected.resolved;
      return Object.keys(expected.dependencies ?? {}).some((dep) => {
        if (!/^(?:@[\w.~-]+\/)?[\w-][\w.~-]*$/.test(dep)) return false;
        const nested = `${key}/node_modules/${dep}`;
        const path = lock[nested] ? nested : `node_modules/${dep}`;
        const entry = lock[path];
        return /^https?:/.test(entry?.resolved ?? "") && !entry?.optional &&
          (moved || !existsSync(join(prefix, path, "package.json")));
      });
    });
  } catch {
    // Failure to read npm's local evidence is not grounds for adding a removal refusal.
    return false;
  }
}

function readLock(path: string): Record<string, LockedPackage> {
  const source = readLocalRecordSource(path, 8 * 1024 * 1024);
  return source ? JSON.parse(source.toString("utf8")).packages ?? {} : {};
}

function npmSetting(key: string): string | undefined {
  return process.env[`npm_config_${key}`] ?? process.env[`NPM_CONFIG_${key.toUpperCase()}`];
}

/** Only rely on an explicit cache or an unoverridden POSIX default. Do not run npm to probe it. */
function npmCache(prefix: string): string | undefined {
  const configured = npmSetting("cache");
  if (configured !== undefined) return isAbsolute(configured) ? configured : undefined;
  if (process.platform === "win32") return undefined;
  const home = homedir();
  const npm = resolveOnPath("npm");
  if (!npm) return undefined;
  const global = npmSetting("globalconfig") ?? join(npmSetting("prefix") ?? dirname(dirname(npm)), "etc", "npmrc");
  for (const rc of [join(prefix, ".npmrc"), npmSetting("userconfig") ?? join(home, ".npmrc"), global, "/etc/npmrc"]) {
    if (!isAbsolute(rc)) return undefined;
    const source = readLocalRecordSource(rc);
    if (source && /^\s*(?:cache|prefix|globalconfig|userconfig)\s*=/im.test(source.toString("utf8"))) return undefined;
  }
  return join(home, ".npm");
}

function emptyCache(cache: string): boolean {
  try {
    const contents = opendirSync(join(cache, "_cacache", "content-v2"));
    try { return contents.readSync() === null; } finally { contents.closeSync(); }
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}
