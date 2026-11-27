import { lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { processGroupMembers, protectedLocalDirectory, recoveryProcessStartToken } from "@cotal-ai/workspace";

const npmCacheName = /^cotal-update-npm-[a-zA-Z0-9]{6}$/;
const reconcileCacheName = /^cotal-update-reconcile-[a-zA-Z0-9]{6}$/;
const updateScratchName = /^cotal-update-[a-zA-Z0-9]{6}$/;

function privateDirectory(info: Stats, uid: number | undefined): boolean {
  return info.isDirectory() && info.uid === uid && (info.mode & 0o077) === 0;
}

/** Resolve `env`'s npm cache when it is a recorded Linux reconciliation cache owned by this account. */
export function recordedReconcileCache(env: NodeJS.ProcessEnv): string | undefined {
  if (process.platform !== "linux") return undefined;
  let cache: string | undefined;
  for (const [key, value] of Object.entries(env)) if (/^npm_config_cache$/i.test(key)) cache = value;
  if (!cache || !reconcileCacheName.test(basename(cache))) return undefined;
  const scratchName = basename(dirname(cache));
  if (!updateScratchName.test(scratchName)) return undefined;
  let parent: string;
  try { parent = realpathSync(dirname(dirname(cache))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const resolved = join(parent, scratchName, basename(cache));
  const outer = lstatSync(dirname(resolved), { throwIfNoEntry: false });
  const inner = outer ? lstatSync(resolved, { throwIfNoEntry: false }) : undefined;
  const owner = inner ? lstatSync(join(resolved, ".owner"), { throwIfNoEntry: false }) : undefined;
  if (!owner) return undefined;
  const uid = process.getuid?.();
  if (!privateDirectory(outer!, uid) || !privateDirectory(inner!, uid))
    throw new Error("reconciliation cache directory is not private");
  protectedLocalDirectory(resolved, "the update cache");
  if (!owner.isFile() || owner.uid !== uid || owner.size > 256 || (owner.mode & 0o077) !== 0)
    throw new Error("reconciliation cache owner record is invalid");
  return resolved;
}

/** Record a detached worker process group in a private reconciliation cache before npm starts. */
export function writeReconcileCacheWorker(cache: string, pid: number): void {
  const file = join(cache, `.worker-${pid}`);
  try {
    writeFileSync(file, "", { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = lstatSync(file);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.size !== 0 || (info.mode & 0o077) !== 0) throw error;
  }
}

function idleCacheTree(directory: string, cutoff: number, uid?: number): boolean {
  return readdirSync(directory).every(name => {
    const path = join(directory, name);
    const info = lstatSync(path);
    return info.mtimeMs < cutoff && (uid === undefined || (info.uid === uid && (info.mode & 0o022) === 0)) &&
      (info.isDirectory() ? idleCacheTree(path, cutoff, uid) : info.isFile());
  });
}

function idleNpmCache(path: string, cutoff: number, uid: number | undefined): boolean {
  const info = lstatSync(path);
  return uid !== undefined && info.isDirectory() && info.uid === uid && (info.mode & 0o022) === 0 &&
    info.mtimeMs < cutoff && readdirSync(path).every(name =>
      (name === "content-v2" || name === "index-v5" || name === "tmp") && lstatSync(join(path, name)).isDirectory()) &&
    idleCacheTree(path, cutoff, uid);
}

function removeExpiredCompileScratch(scratch: string, mtimeMs: number, removeReconcileCache: (path: string, cutoff: number) => boolean): boolean {
  const cutoff = Date.now() - 60 * 60_000;
  if (mtimeMs >= cutoff) return false;
  const entries = readdirSync(scratch);
  const compile = "node-compile-cache";
  if (!entries.includes(compile) || entries.length > 2) return false;
  const cache = join(scratch, compile);
  const info = lstatSync(cache);
  if (!info.isDirectory() || info.mtimeMs >= cutoff || !idleCacheTree(cache, cutoff)) return false;

  const npm = entries.find(name => name !== compile);
  if (npm !== undefined) {
    if (process.platform !== "linux" || !reconcileCacheName.test(npm)) return false;
    const reconcile = join(scratch, npm);
    if (lstatSync(reconcile).mtimeMs >= cutoff || !removeReconcileCache(reconcile, cutoff)) return false;
  }
  rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
  rmdirSync(scratch);
  return true;
}

/** Reclaim caches whose recorded workers have exited, and idle compile scratch. */
export function collectUpdateCaches(parent: string): void {
  const recorded = process.platform === "linux" || process.platform === "darwin";
  try { parent = realpathSync(parent); }
  catch { return; }
  const uid = process.getuid?.();
  const deadOwner = (cache: string): boolean => {
    const file = join(cache, ".owner");
    const info = lstatSync(file);
    if (!info.isFile() || info.uid !== uid || info.size > 256 || (info.mode & 0o077) !== 0) return false;
    const owner = /^([1-9]\d*)\n([^\r\n]+)\n$/.exec(readFileSync(file, "utf8"));
    const pid = Number(owner?.[1]);
    return !!owner && Number.isSafeInteger(pid) && pid > 1 && recoveryProcessStartToken(pid) !== owner[2];
  };
  const absentGroup = (pid: number): boolean => {
    if (!Number.isSafeInteger(pid) || pid < 2) return false;
    try {
      process.kill(-pid, 0);
      if (process.platform !== "linux") return false;
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return /^[ZX] /.test(stat.slice(stat.lastIndexOf(") ") + 2)) && processGroupMembers(pid).length === 0;
    }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  function removeReconcileCache(cache: string, cutoff: number): boolean {
    if (!privateDirectory(lstatSync(cache), uid)) return false;
    protectedLocalDirectory(cache, "the update cache");
    const files = readdirSync(cache);
    const workers = files.filter(name => /^\.worker-[1-9]\d*$/.test(name));
    if (!files.includes(".owner") || !workers.length ||
        files.some(name => name !== ".owner" && name !== "_cacache" && !/^\.worker-[1-9]\d*$/.test(name)) ||
        !deadOwner(cache)) return false;
    for (const worker of workers) {
      const info = lstatSync(join(cache, worker));
      if (!info.isFile() || info.uid !== uid || info.size !== 0 || (info.mode & 0o077) !== 0 ||
          !absentGroup(Number(worker.slice(".worker-".length)))) return false;
    }
    if (files.includes("_cacache")) {
      const npmCache = join(cache, "_cacache");
      if (!idleNpmCache(npmCache, cutoff, uid)) return false;
      rmSync(npmCache, { recursive: true, force: true, maxRetries: 3 });
    }
    for (const worker of workers) rmSync(join(cache, worker), { force: true });
    rmSync(join(cache, ".owner"), { force: true });
    rmdirSync(cache);
    return true;
  }
  function sweep(directory: string): boolean {
    let collected = false;
    for (const name of readdirSync(directory)) {
      const staged = process.platform === "linux" && npmCacheName.test(name);
      if (!staged && !/^cotal-release-check-[a-zA-Z0-9]{6}$/.test(name)) continue;
      const cache = join(directory, name);
      try {
        if (!privateDirectory(lstatSync(cache), uid)) continue;
        protectedLocalDirectory(cache, "the update cache");
        if (!deadOwner(cache)) continue;
        const workers = readdirSync(cache).filter(name => name.startsWith(".worker-"));
        if (staged && workers.length !== 1) continue;
        if (workers.every(worker => {
          const match = /^\.worker-([1-9]\d*)$/.exec(worker);
          return !!match && absentGroup(Number(match[1]));
        })) {
          rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
          collected ||= workers.length > 0;
        }
      } catch { /* Unprovable or already collected scratch is left alone. */ }
    }
    return collected;
  }
  try {
    if (recorded) sweep(parent);
    for (const name of readdirSync(parent)) {
      if (!updateScratchName.test(name)) continue;
      const scratch = join(parent, name);
      try {
        const info = lstatSync(scratch);
        if (!info.isDirectory() || (uid !== undefined && !privateDirectory(info, uid))) continue;
        protectedLocalDirectory(scratch, "the update cache");
        if (removeExpiredCompileScratch(scratch, info.mtimeMs, removeReconcileCache)) continue;
        if (recorded && sweep(scratch) && readdirSync(scratch).every(name => name === "node-compile-cache"))
          rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
      }
      catch { /* Another command can retire its scratch during the scan. */ }
    }
  } catch { /* Temporary storage cleanup is best effort. */ }
}
