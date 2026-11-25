import { accessSync, constants, statSync } from "node:fs";
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
