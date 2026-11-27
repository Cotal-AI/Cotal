import { accessSync, constants, lstatSync, readlinkSync, statSync } from "node:fs";
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

/** Whether an existing directory cannot be entered and modified by this account, ignoring its parent. */
export function isDirectoryProtected(path: string): boolean {
  try {
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info) return false;
    if ((info.mode & 0o200) === 0 || (info.mode & 0o100) === 0) return true;
    accessSync(path, constants.W_OK | constants.X_OK);
    return false;
  } catch (error) {
    if (isConfigPermissionError(error)) return true;
    throw error;
  }
}

/** Whether an existing file cannot be modified or removed by this account, ignoring its parent. */
export function isExistingPathProtected(path: string): boolean {
  try {
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info) return false;
    if ((info.mode & 0o200) === 0) return true;
    accessSync(path, constants.W_OK);
    return false;
  } catch (error) {
    if (isConfigPermissionError(error)) return true;
    throw error;
  }
}

/** The target text of `path` when `path` is a symbolic link whose target does not exist. */
export function danglingSymbolicLinkTarget(path: string): string | undefined {
  try {
    const link = lstatSync(path, { throwIfNoEntry: false });
    if (!link?.isSymbolicLink() || statSync(path, { throwIfNoEntry: false })) return undefined;
    return readlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
