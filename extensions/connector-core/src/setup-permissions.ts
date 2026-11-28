import { accessSync, constants, lstatSync, statSync } from "node:fs";
import { dirname } from "node:path";

export function isConfigPermissionError(error: unknown): boolean {
  return ["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "");
}

/** A writable parent does not authorize replacing a read-only user file by rename. */
export function isConfigProtected(path: string): boolean {
  try {
    const info = statSync(path, { throwIfNoEntry: false });
    if (info && (info.mode & 0o200) === 0) return true;
    if (info) accessSync(path, constants.W_OK);
    const parent = dirname(path);
    if (statSync(parent, { throwIfNoEntry: false })) accessSync(parent, constants.W_OK | constants.X_OK);
    return false;
  } catch (error) {
    if (isConfigPermissionError(error)) return true;
    throw error;
  }
}

/** Whether an existing directory cannot be entered and modified by this account, or is an unresolvable link, ignoring its parent. */
export function isDirectoryProtected(path: string): boolean {
  try {
    const link = lstatSync(path, { throwIfNoEntry: false });
    if (!link) return false;
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info) return true;
    if (!info.isDirectory()) return false;
    accessSync(path, constants.W_OK | constants.X_OK);
    return false;
  } catch (error) {
    if (isConfigPermissionError(error) || (error as NodeJS.ErrnoException).code === "ELOOP") return true;
    throw error;
  }
}
