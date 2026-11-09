/** The process record a foreground `up` writes while it holds a controller stack's lifetime. The
 *  holding process removes its own record as it exits. A whole-stack stop removes one whose process
 *  is gone, such as a holder that was killed, and leaves one that still runs or cannot be read. */
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { writeSecretFileAtomic } from "@cotal-ai/core";
import { assertRecordIdentity, formatRecord, identityRecord, parseRecord } from "@cotal-ai/workspace";

/** Where a foreground `up` records the process that holds its stack's lifetime. */
const foregroundHoldPath = (root: string): string => join(root, ".cotal", "stack-foreground.hold");

/** The process of another foreground `up` that holds `root`'s stack, while that exact process runs. */
export function foregroundHolder(root: string): number | undefined {
  let raw: string;
  try { raw = readFileSync(foregroundHoldPath(root), "utf8"); } catch { return undefined; }
  const read = parseRecord(raw);
  if (read.kind !== "record" || read.record.pid === process.pid) return undefined;
  return assertRecordIdentity(read.record).kind === "match" ? read.record.pid : undefined;
}

/** Record this process as the foreground holder of `root`'s stack. A host that cannot pin a process
 *  start records nothing, so no later `up` refuses on a pid that may have been reused. */
export function claimForegroundHold(root: string): void {
  const record = identityRecord(process.pid);
  if ("token" in record) writeSecretFileAtomic(foregroundHoldPath(root), `${formatRecord(record)}\n`);
}

/** Remove this process's foreground hold record, and leave one another process wrote. */
export function releaseForegroundHold(root: string): void {
  try {
    const read = parseRecord(readFileSync(foregroundHoldPath(root), "utf8"));
    if (read.kind === "record" && read.record.pid === process.pid) unlinkSync(foregroundHoldPath(root));
  } catch { /* nothing recorded */ }
}

/** Remove a foreground hold whose recorded process is gone, and leave one that still runs or cannot
 *  be read. A whole-stack stop calls this: the holding process removes its own record as it exits,
 *  and a holder that was killed does not. */
export function releaseDeadForegroundHold(root: string): boolean {
  const path = foregroundHoldPath(root);
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return false; }
  const read = parseRecord(raw);
  if (read.kind !== "record" || assertRecordIdentity(read.record).kind !== "gone") return false;
  try { unlinkSync(path); } catch { return false; }
  return true;
}
