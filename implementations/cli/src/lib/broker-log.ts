import { closeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openPrivateAppend } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";
import { shellWord } from "./endpoint-errors.js";

/**
 * Open a broker log with {@link openPrivateAppend}: created `0600` whatever the umask,
 * never through a symlink, and an earlier log this user owns set to `0600`. A symlink, a log another
 * user owns or a name that is not a regular file is refused and left unchanged.
 */
export function openBrokerLog(path: string): number {
  try {
    return openPrivateAppend(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    throw new CommandFailure("refused", "PERMISSION_DENIED", `no broker was started: ${(error as Error).message}`,
      { target: { path }, remedy: `remove ${shellWord(path)} or replace it with a regular file you own, then repeat the same startup command` });
  }
}

export function prepareForegroundBrokerLog(path: string | undefined): void {
  if (path === undefined) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openBrokerLog(path));
}
