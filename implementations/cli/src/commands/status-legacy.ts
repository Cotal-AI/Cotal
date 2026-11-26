import { statSync } from "node:fs";
import { join } from "node:path";
import { brokerUrlKey, canonicalRoot, NATS_PIDFILE, recordedRuntimeSpaces, resolveRuntimeSpace, spaceKey, type MeshTarget } from "@cotal-ai/workspace";
import { managerLogPath } from "../lib/manager-proc.js";

/** With no space-scoped pidfiles, a verified open stack or the local registration can name the
 * open space. A target at a different address supplies no local evidence. */
export function statusRuntimeSpace(root: string, target?: MeshTarget, verifiedOpenSpace?: string): string {
  if (verifiedOpenSpace !== undefined && recordedRuntimeSpaces(root).length === 0) return verifiedOpenSpace;
  if (target?.mode === "open" && target.origin === "up" && canonicalRoot(target.root) === canonicalRoot(root)
    && (target.source !== "flag-server" && target.source !== "flag-space-override"
      || target.recordedServer !== undefined && brokerUrlKey(target.recordedServer) === brokerUrlKey(target.server))
    && recordedRuntimeSpaces(root).length === 0) return target.space;
  return resolveRuntimeSpace(root);
}

/** Whether this legacy broker start had a manager that has exited, rather than omitting it. */
export function legacyManagerStopped(root: string, space: string, id: string | undefined): boolean {
  if (id === undefined) return false;
  let brokerMtime: bigint;
  try { brokerMtime = statSync(join(root, ".cotal", NATS_PIDFILE), { bigint: true }).mtimeNs; }
  catch { return false; }
  for (const path of [managerLogPath(space, root), join(root, ".cotal", `manager-execution.${spaceKey(space)}.${id}.json`)]) {
    try { if (statSync(path, { bigint: true }).mtimeNs >= brokerMtime) return true; }
    catch { /* absent or unreadable candidate */ }
  }
  return false;
}
