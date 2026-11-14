import { accessSync, closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CommandFailure } from "./output.js";

export const LOCAL_INPUT_LIMIT = 256 * 1024;

/** How local records are protected: POSIX descriptor/owner/mode checks or the existing Windows ACL model. */
export type LocalRecordAccess = "posix" | "windows-acl";

/** This platform's existing local-record protection model, or undefined when required POSIX primitives are unavailable. */
export function localRecordAccess(platform: NodeJS.Platform = process.platform): LocalRecordAccess | undefined {
  if (platform === "win32") return "windows-acl";
  return process.getuid !== undefined && constants.O_NOFOLLOW !== undefined && constants.O_NONBLOCK !== undefined ? "posix" : undefined;
}

/** Require the existing protection model, never substituting weaker access. */
export function requireLocalRecordAccess(): LocalRecordAccess {
  const access = localRecordAccess();
  if (!access) throw new CommandFailure("refused", "UNSUPPORTED", "protected workstation file access is not available on this platform in this author preview; no weaker file access was substituted");
  return access;
}

/** The first folder on the way to `path` that this account may not search, or undefined when all are searchable. */
export function unsearchableFolder(path: string): string | undefined {
  const folders: string[] = [];
  for (let dir = dirname(resolve(path)); ; dir = dirname(dir)) {
    folders.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  for (const dir of folders) {
    try { accessSync(dir, constants.X_OK); } catch { return dir; }
  }
  return undefined;
}

/** `path` as one POSIX shell word, quoted when a shell would split or expand it. */
export const shellPath = (path: string) => /^[A-Za-z0-9_./+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;

/** Establish a regular descriptor, then read only bounded bytes. POSIX opens nonblocking and
 *  without following a link, and checks a private file's owner and mode; Windows does neither. */
export function readLocalRecordSource(path: string, limit = LOCAL_INPUT_LIMIT, privateFile = false): Buffer | undefined {
  const access = requireLocalRecordAccess();
  const posix = access === "posix";
  let fd: number;
  try { fd = openSync(path, posix ? constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK : constants.O_RDONLY); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "EACCES" || code === "EPERM") {
      const folder = unsearchableFolder(path);
      throw new CommandFailure("refused", "PERMISSION_DENIED", folder ? `${folder} cannot be read by this account (${code}), so ${path} was not read` : `${path} cannot be read by this account (${code})`, { target: { path, ...(folder ? { folder } : {}) }, remedy: folder ? `make it readable by you, for example with chmod u+rx ${shellPath(folder)}` : `make it readable by you, for example with chmod u+r ${shellPath(path)}` });
    }
    throw new CommandFailure("refused", "PERMISSION_DENIED", posix ? `the local record source ${path} could not be opened without following links` : `the local record source ${path} could not be opened`, { target: { path } });
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new CommandFailure("refused", "SCHEMA_INVALID", "local record input must be a regular file", { target: { path } });
    if (privateFile && posix && (before.uid !== process.getuid!() || (before.mode & 0o077) !== 0)) throw new CommandFailure("refused", "PERMISSION_DENIED", `the saved local record ${path} is not owned and private`, { target: { path } });
    if (before.size > limit) throw new CommandFailure("refused", "SCHEMA_INVALID", "local record input exceeds its byte limit", { target: { path } });
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    const after = fstatSync(fd);
    if (length > limit) throw new CommandFailure("refused", "SCHEMA_INVALID", "local record input exceeds its byte limit", { target: { path } });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new CommandFailure("refused", "CONFLICT", "the local record source changed while it was read", { target: { path } });
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
