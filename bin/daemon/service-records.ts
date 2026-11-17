import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spaceFromSegment, spaceSegment } from "@cotal-ai/workspace";
import { checkDir } from "./endpoint.js";

/** Remove only a stopped machine service's private records, never its Manager or the lifetime lock.
 *  The caller must hold the space's operation queue or the daemon's lifetime exclusion. */
export function removeServiceRecords(home: string, space: string): string[] {
  const root = join(home, "daemon");
  const dir = join(root, spaceSegment(space));
  if (!lstatSync(root, { throwIfNoEntry: false })) return [];
  checkDir(root);
  if (!lstatSync(dir, { throwIfNoEntry: false })) return [];
  checkDir(dir);
  const removed: string[] = [];
  // Forget resume first. A partial removal must not automatically reconnect after a restart.
  for (const name of ["service-connect.json", "service-store", "register-request.json", "service-identity.json"]) {
    const path = join(dir, name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (name === "service-store") checkDir(path);
    else if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`cannot remove machine service record ${path}: expected a regular file`);
    rmSync(path, { recursive: name === "service-store" });
    removed.push(`${spaceSegment(space)}/${name}`);
  }
  return removed;
}

/** Remove every space's service records after daemon shutdown, under its lifetime exclusion. */
export function removeAllServiceRecords(home: string): string[] {
  const root = join(home, "daemon");
  if (!lstatSync(root, { throwIfNoEntry: false })) return [];
  checkDir(root);
  return readdirSync(root).flatMap((entry) => {
    const space = spaceFromSegment(entry);
    return space === undefined ? [] : removeServiceRecords(home, space);
  });
}
