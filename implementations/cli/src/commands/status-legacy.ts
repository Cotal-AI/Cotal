import { statSync } from "node:fs";
import { join } from "node:path";
import { brokerUrlKey, canonicalRoot, NATS_PIDFILE, recordedRuntimeSpaces, resolveRuntimeSpace, spaceKey, type MeshTarget } from "@cotal-ai/workspace";
import { managerLogPath } from "../lib/manager-proc.js";

/** The local registration supplies the space of an open broker with no space-scoped pidfiles.
 * Named runtime records take precedence, and a different address supplies no local evidence. */
export function statusRuntimeSpace(root: string, target?: MeshTarget): string {
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
