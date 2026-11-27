import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parsePid, processGroupMembers, protectedLocalDirectory, recoveryProcessStartToken } from "@cotal-ai/workspace";

const npmCacheName = /^cotal-update-npm-[a-zA-Z0-9]{6}$/;
const reconcileCacheName = /^cotal-update-reconcile-[a-zA-Z0-9]{6}$/;
const updateScratchName = /^cotal-update-[a-zA-Z0-9]{6}$/;
const workerName = /^\.worker-[1-9]\d*$/;

function privateDirectory(info: Stats, uid: number | undefined): boolean {
  return info.isDirectory() && info.uid === uid && (info.mode & 0o077) === 0;
}

/** Read `npm_config_cache` with npm's `loadEnv` rule: case-insensitive, skipping empty values, last key wins. */
export function npmConfiguredCache(env: NodeJS.ProcessEnv): string | undefined {
  let cache: string | undefined;
  for (const [key, value] of Object.entries(env))
    if (/^npm_config_cache$/i.test(key) && value) cache = value;
  return cache;
}

/** Resolve `cache` when it names an update reconciliation cache directory. Never throws. */
export function reconciliationCachePath(cache: string | undefined): string | undefined {
  if (!cache) return undefined;
  const resolved = resolve(cache);
  if (!reconcileCacheName.test(basename(resolved)) || !updateScratchName.test(basename(dirname(resolved))))
    return undefined;
  try { return join(realpathSync(dirname(dirname(resolved))), basename(dirname(resolved)), basename(resolved)); }
  catch { return resolved; }
}

function insideReconcileCache(target: string, cache: string): boolean {
  const clean = target.replace(/ \(deleted\)$/, "");
  return clean === cache || clean.startsWith(`${cache}${sep}`);
}

function processZombie(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return /^[ZX] /.test(stat.slice(stat.lastIndexOf(") ") + 2));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH";
  }
}

function nonDumpableDaemon(pid: number, uid: number, cacheBirthMs: number | undefined): boolean {
  try {
    if (lstatSync(`/proc/${pid}/environ`).uid !== uid) return true;
    const procFields = readFileSync(`/proc/${pid}/status`, "utf8");
    if (uid !== 0 && /^Cap(?:Prm|Eff):\t0*[1-9a-f]/mi.test(procFields)) return true;
    if (cacheBirthMs === undefined) return false;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const after = stat.lastIndexOf(") ");
    if (after < 0) return false;
    const startTicks = Number(stat.slice(after + 2).trim().split(/\s+/)[19]);
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
    return Number.isSafeInteger(startTicks) && Number.isSafeInteger(btime) && startTicks >= 0 &&
      (btime + (startTicks + 1) / 100) * 1000 < cacheBirthMs - 5000;
  } catch { return false; }
}

function processHoldsReconcileCache(cache: string, uid: number | undefined, cacheBirthMs: number | undefined): boolean {
  if (uid === undefined) return true;
  let entries: string[];
  try { entries = readdirSync("/proc"); }
  catch { return true; }
  for (const entry of entries) {
    const pid = parsePid(entry);
    if (pid === undefined || pid === process.pid) continue;
    let procInfo: Stats;
    try { procInfo = lstatSync(`/proc/${pid}`); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ESRCH") continue;
      return true;
    }
    if (procInfo.uid !== uid) continue;
    try {
      const raw = readFileSync(`/proc/${pid}/environ`, "utf8");
      const env: NodeJS.ProcessEnv = {};
      for (const item of raw.split("\0")) {
        const eq = item.indexOf("=");
        if (eq > 0) env[item.slice(0, eq)] = item.slice(eq + 1);
      }
      const configured = npmConfiguredCache(env);
      if (configured) {
        const resolved = reconciliationCachePath(configured) ?? resolve(configured);
        if (insideReconcileCache(resolved, cache)) return true;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" && nonDumpableDaemon(pid, uid, cacheBirthMs)) continue;
      if (!processZombie(pid)) return true;
      continue;
    }
    try {
      if (insideReconcileCache(readlinkSync(`/proc/${pid}/cwd`), cache)) return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" && nonDumpableDaemon(pid, uid, cacheBirthMs)) continue;
      if (!processZombie(pid)) return true;
      continue;
    }
    let fds: string[];
    try { fds = readdirSync(`/proc/${pid}/fd`); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" && nonDumpableDaemon(pid, uid, cacheBirthMs)) continue;
      if (!processZombie(pid)) return true;
      continue;
    }
    for (const fd of fds) {
      try {
        if (insideReconcileCache(readlinkSync(`/proc/${pid}/fd/${fd}`), cache)) return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ESRCH") return true;
      }
    }
  }
  return false;
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
    const cacheInfo = lstatSync(cache);
    if (!privateDirectory(cacheInfo, uid)) return false;
    protectedLocalDirectory(cache, "the update cache");
    const files = readdirSync(cache);
    const workers = files.filter(name => workerName.test(name));
    const hasOwner = files.includes(".owner");
    const hasData = files.includes("_cacache");
    if (files.some(name => name !== ".owner" && name !== "_cacache" && !workerName.test(name)) ||
        workers.length > 1 || (hasData && (!hasOwner || workers.length !== 1)) ||
        (workers.length === 1 && !hasOwner) || (hasOwner && !deadOwner(cache))) return false;
    if (workers.length === 1) {
      const worker = workers[0]!;
      const info = lstatSync(join(cache, worker));
      if (!info.isFile() || info.uid !== uid || info.size !== 0 || (info.mode & 0o077) !== 0 ||
          !absentGroup(Number(worker.slice(".worker-".length)))) return false;
    }
    const birthMs = cacheInfo.birthtimeMs > 0 ? cacheInfo.birthtimeMs : undefined;
    if (processHoldsReconcileCache(cache, uid, birthMs)) return false;
    if (hasData) {
      const npmCache = join(cache, "_cacache");
      if (!idleNpmCache(npmCache, cutoff, uid)) return false;
      rmSync(npmCache, { recursive: true, force: true, maxRetries: 3 });
    }
    if (workers.length === 1) rmSync(join(cache, workers[0]!), { force: true });
    if (hasOwner) rmSync(join(cache, ".owner"), { force: true });
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
