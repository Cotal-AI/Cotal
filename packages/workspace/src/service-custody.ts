import { dirname } from "node:path";
import { writeSecretFileCreateOnly } from "@cotal-ai/core";
import { canonicalLocalProcessPath, type LocalProcessContext } from "./local-process.js";
import { CommandFailure } from "./output.js";
import { identityRecord, readPidfile, removePidPair, verifyIdentityPin, writePidPair } from "./pid.js";
import { protectedLocalDirectory, readLocalRecordSource } from "./protected-records.js";

/** Native child custody, not a launcher placeholder or adoption. A slot whose holder's pid has
 *  exited is stale: it is cleared once and the claim retried, so a holder that crashed or was killed
 *  does not lock the service out (#7343). Every other existing slot refuses, and a record that may
 *  still front a live process, legacy or not, is never adopted or reclaimed. Native initialization
 *  follows only after the claim. */
export function claimServicePid(context: LocalProcessContext, template: string): () => void {
  const self = identityRecord(process.pid);
  if ((process.platform !== "linux" && process.platform !== "darwin" && process.platform !== "win32") || !("token" in self)) throw new CommandFailure("refused", "UNSUPPORTED", "native service custody requires a Linux, macOS or Windows process creation identity; no PID-only record was published");
  const path = canonicalLocalProcessPath(template, context);
  protectedLocalDirectory(dirname(path));
  const claim = (reclaim: boolean): void => {
    try { writeSecretFileCreateOnly(path, String(self.pid)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "native service custody publication was not confirmed; any original claim was retained");
      if (reclaim && clearDeadHolder(path)) return claim(false);
      throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the native service PID slot ${path} is already held; no daemon or legacy record was adopted or reclaimed`);
    }
  };
  claim(true);
  // Reuse the native pair publisher, which creates both records 0o600. An incomplete publication
  // stays as custody evidence.
  try {
    writePidPair(path, self.pid);
  } catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "native service PID/pin publication was not confirmed; its claim was retained, without native initialization"); }
  return () => {
    const bytes = readLocalRecordSource(path, 128, true);
    if (bytes === undefined) return;
    const current = verifyIdentityPin(path);
    if (current.kind !== "match" || current.record.pid !== self.pid || current.record.token !== self.token) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native service PID custody changed; no successor record was removed");
    removePidPair(path, String(self.pid));
  };
}

/** Clear the slot when its holder is proven gone (`gone` or a start-token `mismatch` on a reused
 *  PID, which proves the recorded process has exited). The record is read before it is judged and
 *  removed only while it still reads the same, under the lock its publisher holds, so a successor
 *  that claimed the slot meanwhile is left whole and the retried claim refuses. A record that cannot
 *  be read or judged is left for the refusal. */
function clearDeadHolder(path: string): boolean {
  let recorded: string | undefined;
  let verdict: ReturnType<typeof verifyIdentityPin>;
  try {
    recorded = readPidfile(path);
    verdict = verifyIdentityPin(path);
  } catch { return false; }
  if (!recorded || (verdict.kind !== "gone" && verdict.kind !== "mismatch")) return false;
  removePidPair(path, recorded);
  return true;
}
