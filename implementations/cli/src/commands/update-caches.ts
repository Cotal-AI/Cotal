import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { processGroupMembers, protectedLocalDirectory, recoveryProcessStartToken } from "@cotal-ai/workspace";

/** Only caches with recorded custody can be reclaimed. A worker cannot open its cache before its
 * process group is recorded, and the owner cannot start new workers after it exits. */
export function collectUpdateCaches(parent: string): void {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  try { parent = realpathSync(parent); }
  catch { return; }
  const uid = process.getuid!();
  const privateDirectory = (path: string) => {
    const info = lstatSync(path);
    return info.isDirectory() && info.uid === uid && (info.mode & 0o077) === 0;
  };
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
  function sweep(directory: string): boolean {
    let collected = false;
    for (const name of readdirSync(directory)) {
      const staged = process.platform === "linux" && /^cotal-update-npm-[a-zA-Z0-9]{6}$/.test(name);
      if (!staged && !/^cotal-release-check-[a-zA-Z0-9]{6}$/.test(name)) continue;
      const cache = join(directory, name);
      try {
        if (!privateDirectory(cache)) continue;
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
    sweep(parent);
    for (const name of readdirSync(parent)) {
      if (!/^cotal-update-[a-zA-Z0-9]{6}$/.test(name)) continue;
      const scratch = join(parent, name);
      try {
        if (!privateDirectory(scratch)) continue;
        protectedLocalDirectory(scratch, "the update cache");
        if (sweep(scratch) && readdirSync(scratch).every(name => name === "node-compile-cache"))
          rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
      }
      catch { /* Another command can retire its scratch during the scan. */ }
    }
  } catch { /* Temporary storage cleanup is best effort. */ }
}
