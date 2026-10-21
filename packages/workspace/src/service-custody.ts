import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { writeSecretFileCreateOnly } from "@cotal-ai/core";
import { canonicalLocalProcessPath, type LocalProcessContext } from "./local-process.js";
import { CommandFailure } from "./output.js";
import { identityPinPath, identityRecord, removePidPair, verifyIdentityPin, writePidPair } from "./pid.js";
import { protectedLocalDirectory, readLocalRecordSource } from "./protected-records.js";

/** Native child custody, not a launcher placeholder or adoption. Every existing slot refuses;
 *  this path never reclaims legacy records. Native initialization follows only after the claim. */
export function claimServicePid(context: LocalProcessContext, template: string): () => void {
  const self = identityRecord(process.pid);
  if (process.platform !== "linux" || !("token" in self)) throw new CommandFailure("refused", "UNSUPPORTED", "native service custody requires a Linux process creation identity; no PID-only record was published");
  const path = canonicalLocalProcessPath(template, context);
  protectedLocalDirectory(dirname(path));
  try { writeSecretFileCreateOnly(path, String(self.pid)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", "the native service PID slot is already held; no daemon or legacy record was adopted or reclaimed");
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "native service custody publication was not confirmed; any original claim was retained");
  }
  // Reuse the native pair publisher. An incomplete publication stays as custody evidence.
  try {
    writePidPair(path, self.pid);
    chmodSync(path, 0o600);
    chmodSync(identityPinPath(path), 0o600);
  } catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "native service PID/pin publication was not confirmed; its claim was retained, without native initialization"); }
  return () => {
    const bytes = readLocalRecordSource(path, 128, true);
    if (bytes === undefined) return;
    const current = verifyIdentityPin(path);
    if (current.kind !== "match" || current.record.pid !== self.pid || current.record.token !== self.token) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native service PID custody changed; no successor record was removed");
    removePidPair(path, String(self.pid));
  };
}
