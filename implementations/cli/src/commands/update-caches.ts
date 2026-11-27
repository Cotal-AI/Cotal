import { lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, type Stats } from "node:fs";
import { join } from "node:path";
import { processGroupMembers, protectedLocalDirectory, recoveryProcessStartToken } from "@cotal-ai/workspace";

const npmCacheName = /^cotal-update-npm-[a-zA-Z0-9]{6}$/;
const reconcileCacheName = /^cotal-update-reconcile-[a-zA-Z0-9]{6}$/;

function privateDirectory(info: Stats, uid: number | undefined): boolean {
  return info.isDirectory() && info.uid === uid && (info.mode & 0o077) === 0;
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
    const worker = files.find(name => /^\.worker-[1-9]\d*$/.test(name));
    if (!worker || files.some(name => name !== ".owner" && name !== worker && name !== "_cacache") ||
        !deadOwner(cache) || !absentGroup(Number(worker.slice(".worker-".length)))) return false;
    const info = lstatSync(join(cache, worker));
    if (!info.isFile() || info.uid !== uid || info.size !== 0 || (info.mode & 0o077) !== 0) return false;
    if (files.includes("_cacache") && !idleNpmCache(join(cache, "_cacache"), cutoff, uid)) return false;
    rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
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
      if (!/^cotal-update-[a-zA-Z0-9]{6}$/.test(name)) continue;
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
