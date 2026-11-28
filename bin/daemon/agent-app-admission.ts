import { closeSync, constants, openSync } from "node:fs";
import { join } from "node:path";
import { lockExclusiveNb } from "@cotal-ai/seat";
import { CommandFailure } from "@cotal-ai/workspace";
import { ensureStateDir, type DaemonPaths } from "./endpoint.js";

/** Serialize app changes and desktop service handoff across processes. Startup itself does not
 * take this lock, since the handoff caller waits for a ready service while holding it. */
export async function withAppMutation<T>(paths: DaemonPaths, run: () => Promise<T>): Promise<T> {
  ensureStateDir(paths);
  const fd = openSync(join(paths.state, "agent-app.lock"), constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    if (!lockExclusiveNb(fd)) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "Wait for the current change to finish, then try again.");
    return await run();
  } finally { closeSync(fd); }
}

/** Whether another change holds the agent-app admission gate right now. Takes and releases it at once. */
export function appMutationBusy(paths: DaemonPaths): boolean {
  ensureStateDir(paths);
  const fd = openSync(join(paths.state, "agent-app.lock"), constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { return !lockExclusiveNb(fd); } finally { closeSync(fd); }
}
