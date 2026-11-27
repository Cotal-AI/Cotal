import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { lockExclusiveNb, windowsDirSecurity, windowsUserSid } from "./host.js";

/** Like the Windows daemon directory boundary: trust the owner, SYSTEM and Administrators only.
 * The caller supplies the owner-private root. Never fix up an existing ACL on the custody path. */
export function checkWindowsCustodyPath(path: string, directory: boolean): void {
  const info = lstatSync(path);
  const security = windowsDirSecurity(path);
  const trusted = new Set([windowsUserSid(), "S-1-5-18", "S-1-5-32-544"]);
  if (security.reparse || security.directory !== directory || !(directory ? info.isDirectory() : info.isFile()) ||
      !security.owner || !trusted.has(security.owner) || !security.aces || security.aces.some(ace =>
        ace.type !== 1 && (ace.type !== 0 || !ace.sid || (ace.mask !== 0 && !trusted.has(ace.sid)))))
    throw new Error("unknown Windows PTY custody access list");
}

/** Refuse a path reached through aliases or reparse points, including an ancestor junction. */
export function checkWindowsCustodyRoot(root: string): void {
  root = resolve(root);
  if (!/^[a-z]:\\/i.test(root) || realpathSync.native(root).toLowerCase() !== root.toLowerCase())
    throw new Error("unknown Windows PTY custody directory");
  checkWindowsCustodyPath(root, true);
}

/** Create only inside an already verified root; inherit its private ACL and verify the result. */
export function makeWindowsCustodyDirectory(path: string): void {
  checkWindowsCustodyRoot(dirname(path));
  try { mkdirSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  checkWindowsCustodyRoot(path);
}

/** Serialize the observed task/record/start sequence. Death releases the file lock. */
export function withWindowsCustodyLock<T>(path: string, action: () => T): T {
  checkWindowsCustodyRoot(dirname(path));
  let fd: number;
  try { fd = openSync(path, "wx+"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    checkWindowsCustodyPath(path, false);
    fd = openSync(path, "r+");
  }
  try {
    checkWindowsCustodyPath(path, false);
    if (!fstatSync(fd).isFile() || !lockExclusiveNb(fd)) throw new Error("Windows PTY host start is already in progress");
    return action();
  } finally { closeSync(fd); }
}
