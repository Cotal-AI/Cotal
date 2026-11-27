import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, statSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertProtectedEntry, protectedResolvedDirectory } from "./protected-records.js";

const manifestAt = (root: string): string => join(root, "extensions", "extensions.json");
const partsUnder = (root: string, path: string): string[] => {
  const child = relative(root, path);
  if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) throw new Error("manifest access path is outside the Cotal config");
  return child ? child.split(sep) : [];
};

type Entry = { path: string; name: string; stat: Stats };
const sameEntry = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;

/** Inspect the selected Cotal path from the top down, without following managed links. */
export function restoreManifestAccess(config: string, select: (prepare?: (path: string) => void) => string, search: boolean): boolean {
  const uid = process.getuid?.();
  const linux = process.platform === "linux";
  if (uid === undefined || constants.O_NOFOLLOW === undefined || (!linux && process.platform !== "darwin")) return false;
  if (search) {
    try { lstatSync(manifestAt(select())); return false; }
    catch (error) { if (!["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; }
  }
  const fds: number[] = [];
  const dirs = new Map<string, Entry | undefined>();
  const changed: Entry[] = [];
  let complete = false;
  const inspect = (dir: string, name: string, path: string, directory: boolean): Entry | undefined => {
    let location = join(dir, name), stat: Stats | undefined;
    if (linux) {
      // Linux O_PATH can pin an inode even when its owner has no read access.
      try {
        const fd = openSync(location, 0o10000000 | constants.O_NOFOLLOW);
        fds.push(fd);
        location = `/proc/self/fd/${fd}`;
        stat = fstatSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    } else stat = lstatSync(location, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.uid !== uid || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error("manifest access path is not an owned physical entry");
    assertProtectedEntry("the extensions manifest path", path, stat, { ancestor: directory });
    return { path, name: location, stat };
  };
  const chmod = (entry: Entry, mode: number): void => {
    if (!sameEntry(entry.stat, linux ? statSync(entry.name) : lstatSync(entry.name))) throw new Error("manifest access path changed");
    if (linux) chmodSync(entry.name, mode);
    // Darwin chmod -h uses a no-follow mode change even when the inode cannot be opened for I/O.
    else execFileSync("/bin/chmod", ["-h", mode.toString(8), entry.name], { stdio: "pipe", windowsHide: true });
  };
  const addBit = (entry: Entry, bit: number): void => {
    const mode = entry.stat.mode & 0o7777;
    if (mode & bit) return;
    // chmod can clear set-group-ID if the caller does not belong to the group.
    if ((mode & 0o2000) && !process.getgroups?.().includes(entry.stat.gid)) throw new Error("cannot preserve the entry mode");
    chmod(entry, mode | bit);
    changed.push(entry);
  };
  try {
    const parent = protectedResolvedDirectory(dirname(config), "the Cotal config folder");
    const directory = (path: string): Entry | undefined => {
      const parts = [basename(config), ...partsUnder(config, path)];
      let physical = parent, current = dirname(config), entry: Entry | undefined;
      for (const part of parts) {
        current = join(current, part);
        if (!dirs.has(current)) {
          const found = inspect(physical, part, current, true);
          if (found && search) addBit(found, constants.S_IXUSR);
          dirs.set(current, found);
        }
        entry = dirs.get(current);
        if (!entry) return;
        physical = entry.name;
      }
      return entry;
    };
    if (!directory(config)) return false;
    const manifest = resolve(manifestAt(select(search ? directory : undefined)));
    const dir = directory(dirname(manifest));
    if (!dir || (search && !changed.length)) return false;
    const file = inspect(dir.name, basename(manifest), manifest, false);
    if (!file || changed.some(entry => !manifest.startsWith(`${entry.path}${sep}`))) return false;
    addBit(file, constants.S_IRUSR);
    const readable = openSync(manifest, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    fds.push(readable);
    if (!sameEntry(file.stat, fstatSync(readable))) return false;
    complete = true;
    return changed.length !== 0;
  } catch {
    // The ordinary update path owns the refusal when access cannot be restored.
    return false;
  } finally {
    if (!complete) for (const entry of changed.reverse()) {
      try { chmod(entry, entry.stat.mode & 0o7777); }
      catch { /* Leave the original refusal to the updater even when rollback is not possible. */ }
    }
    for (const fd of fds.reverse()) closeSync(fd);
  }
}
