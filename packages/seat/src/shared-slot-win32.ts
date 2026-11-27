import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createWindowsPrivateDir, windowsUserSid } from "./host.js";
import { checkWindowsCustodyRoot, makeWindowsCustodyDirectory } from "./shared-files-win32.js";

export const WINDOWS_SEAT_STORE = "CotalSeatHost";

/** The same generation and Manager lineage address the task, pipe and local host records. */
export function windowsSeatSlot(installation: string, space: string, generation: string) {
  if (!space || space.includes("\0") || !/^[a-f0-9]{64}$/.test(generation)) throw new Error("unknown Windows PTY lineage or generation");
  const sid = windowsUserSid();
  const key = createHash("sha256").update(JSON.stringify([realpathSync.native(installation).toLowerCase(), sid, space, generation])).digest("hex").slice(0, 32);
  const name = `cotal-pty-${key}-${sid}`;
  const directory = join(windowsSeatStore(installation), generation, "hosts");
  return { key, name, sid, generation, root: join(directory, key), pipe: `\\\\.\\pipe\\${name}` };
}

/** The retained store is separate from the entire desktop install/census root. */
export function windowsSeatStore(installation: string): string {
  const local = process.env.LOCALAPPDATA;
  if (!local || !/^[a-z]:\\/i.test(local)) throw new Error("Windows local application data directory is unavailable");
  const parent = resolve(local);
  checkWindowsCustodyRoot(parent);
  const root = join(parent, WINDOWS_SEAT_STORE);
  const install = realpathSync.native(installation);
  if (contains(install, root) || contains(root, install)) throw new Error("Windows PTY runtime store overlaps the installation");
  createWindowsPrivateDir(root);
  checkWindowsCustodyRoot(root);
  return root;
}

export type WindowsSeatSlot = ReturnType<typeof windowsSeatSlot>;

/** Open the generation's private host state separately from its immutable runtime inventory. */
export function prepareWindowsSeatSlot(slot: WindowsSeatSlot): void {
  makeWindowsCustodyDirectory(dirname(slot.root));
  makeWindowsCustodyDirectory(slot.root);
}

function contains(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
