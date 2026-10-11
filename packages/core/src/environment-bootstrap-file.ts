import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync,
  realpathSync, unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const MAX_BOOTSTRAP_FILE_BYTES = 64 * 1024;

/** Take a Linux manager-only bootstrap file once, before decoding or opening any plane.
 * A held private directory pins every file operation. Unlink and directory sync precede reading.
 * The file must be current-effective-UID owned, mode0600, regular and singly linked; its parent
 * must have the same owner and mode0700. Symlinks/FIFOs refuse without following or blocking.
 * This is file custody, not document authentication, broker verification or manager bootstrap.
 * A process sharing the manager's privileged UID remains trusted. Refusals expose no path/bytes. */
export function takeEnvironmentManagerBootstrapFile(path: string): string {
  if (process.platform !== "linux" || process.geteuid === undefined)
    throw new Error("environment bootstrap file custody requires Linux");
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path)
    throw new Error("environment bootstrap file path must be canonical and absolute");
  const parent = dirname(path);
  let directory: number;
  try {
    if (realpathSync(parent) !== parent) throw new Error("noncanonical parent");
    directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch { throw new Error("environment bootstrap parent cannot be opened privately"); }
  try {
    const custody = fstatSync(directory);
    if (!custody.isDirectory() || custody.uid !== process.geteuid() || (custody.mode & 0o7777) !== 0o700)
      throw new Error("environment bootstrap parent must be current-UID owned and mode0700");
    // Linux descriptor-relative access keeps an ancestor rename from changing the deletion target.
    const held = `/proc/self/fd/${directory}/${basename(path)}`;
    let fd: number;
    try { fd = openSync(held, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch {
      let entry;
      try { entry = lstatSync(held); } catch {}
      if (entry && !entry.isDirectory()) {
        try { unlinkSync(held); fsyncSync(directory); }
        catch { throw new Error("environment bootstrap refused file could not be removed"); }
      }
      throw new Error("environment bootstrap file cannot be opened as a regular file");
    }
    try {
      const st = fstatSync(fd);
      if (st.isDirectory()) throw new Error("environment bootstrap file path is a directory");
      try { unlinkSync(held); fsyncSync(directory); }
      catch { throw new Error("environment bootstrap file could not be consumed"); }
      if (!st.isFile() || st.uid !== process.geteuid() || (st.mode & 0o7777) !== 0o600 || st.nlink !== 1 || fstatSync(fd).nlink !== 0)
        throw new Error("environment bootstrap file must be current-UID owned, mode0600, regular and singly linked");
      if (st.size < 1 || st.size > MAX_BOOTSTRAP_FILE_BYTES)
        throw new Error("environment bootstrap file is empty or exceeds its size limit");
      const bytes = Buffer.alloc(MAX_BOOTSTRAP_FILE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = readSync(fd, bytes, length, bytes.length - length, null);
        if (read === 0) break;
        length += read;
      }
      if (length < 1 || length > MAX_BOOTSTRAP_FILE_BYTES)
        throw new Error("environment bootstrap file is empty or exceeds its size limit");
      try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)); }
      catch { throw new Error("environment bootstrap file is not UTF-8"); }
    } finally { closeSync(fd); }
  } finally { closeSync(directory); }
}
