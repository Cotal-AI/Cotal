import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createWindowsPrivateDir, windowsUserSid } from "./host.js";
import { acquireWindowsCustodyLock, checkWindowsCustodyRoot, makeWindowsCustodyDirectory, withWindowsCustodyLock } from "./shared-files-win32.js";
import { readWindowsPrivateRecord, writeWindowsPrivateRecord } from "./shared-record-win32-io.js";

export const WINDOWS_SEAT_STORE = "CotalSeatHost";
const AMBIGUOUS_WINDOWS_ENTRY = /[<>:"/\\|?*\x00-\x1f]|[ .]$|^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:[ .]|$)/i;

/** The same generation and Manager lineage address the task, pipe and local host records. */
export function deriveWindowsSeatSlot(store: string, installation: string, sid: string, space: string, generation: string) {
  if (!space || space.includes("\0") || !/^[a-f0-9]{64}$/.test(generation)) throw new Error("unknown Windows PTY lineage or generation");
  const lineageKey = [installation, sid, space];
  const key = createHash("sha256").update(JSON.stringify([...lineageKey, generation])).digest("hex").slice(0, 32);
  const name = `cotal-pty-${key}-${sid}`;
  const directory = join(store, generation, "hosts");
  const lineage = join(store, "lineages", createHash("sha256").update(JSON.stringify(lineageKey)).digest("hex").slice(0, 32));
  return { key, name, sid, generation, lineage, installation, space, root: join(directory, key), pipe: `\\\\.\\pipe\\${name}` };
}

export function windowsSeatSlot(installation: string, space: string, generation: string) {
  const address = windowsSeatStoreAddress(installation);
  checkWindowsCustodyRoot(address.parent);
  return deriveWindowsSeatSlot(prepareStore(address.root), address.installation, windowsUserSid(), space, generation);
}

/** The retained store is separate from the entire desktop install/census root. */
export function windowsSeatStoreAddress(installation: string) {
  const local = process.env.LOCALAPPDATA;
  if (!local || !/^[a-z]:\\/i.test(local)) throw new Error("Windows local application data directory is unavailable");
  const parent = resolve(local);
  const root = join(parent, WINDOWS_SEAT_STORE);
  const install = realpathSync.native(installation);
  if (contains(install, root) || contains(root, install)) throw new Error("Windows PTY runtime store overlaps the installation");
  return { parent, root, installation: install.toLowerCase() };
}

/** A missing store or profile directory must be a missing entry under a physical directory. */
export function windowsSeatStorePresent(address: ReturnType<typeof windowsSeatStoreAddress>): boolean {
  let directory = address.parent, entry = address.root;
  let before = lstatSync(directory, { bigint: true, throwIfNoEntry: false });
  while (!before) {
    const ancestor = dirname(directory), name = basename(directory);
    if (ancestor === directory || AMBIGUOUS_WINDOWS_ENTRY.test(name))
      throw new Error("Windows PTY store parent is unknown");
    entry = directory;
    directory = ancestor;
    before = lstatSync(directory, { bigint: true, throwIfNoEntry: false });
  }
  if (!before.isDirectory() || before.ino === 0n || realpathSync.native(directory).toLowerCase() !== directory.toLowerCase())
    throw new Error("Windows PTY store parent is unknown");
  const found = lstatSync(entry, { throwIfNoEntry: false });
  const after = lstatSync(directory, { bigint: true });
  if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs ||
      realpathSync.native(directory).toLowerCase() !== directory.toLowerCase())
    throw new Error("Windows PTY store parent changed");
  if (!found) return false;
  if (entry !== address.root) throw new Error("Windows PTY store parent changed");
  checkWindowsCustodyRoot(address.parent);
  checkWindowsCustodyRoot(address.root);
  return true;
}

function prepareStore(root: string): string {
  createWindowsPrivateDir(root);
  checkWindowsCustodyRoot(root);
  return root;
}

export function windowsSeatStore(installation: string): string {
  const address = windowsSeatStoreAddress(installation);
  checkWindowsCustodyRoot(address.parent);
  return prepareStore(address.root);
}

export const WINDOWS_SEAT_STORE_LOCK = "store.lock";

/** Take the cross-lineage store fence, or prove no store exists without creating one. */
export function acquireWindowsSeatStoreFence(installation: string): (() => void) | undefined {
  const address = windowsSeatStoreAddress(installation);
  if (!windowsSeatStorePresent(address)) return undefined;
  return acquireWindowsCustodyLock(join(address.root, WINDOWS_SEAT_STORE_LOCK));
}

/** Publishers take the store fence before their per-slot or per-lineage locks. */
export function withWindowsSeatStoreFence<T>(slot: WindowsSeatSlot, action: () => T): T {
  const store = dirname(dirname(slot.lineage));
  return withWindowsCustodyLock(join(store, WINDOWS_SEAT_STORE_LOCK), action);
}

export const windowsLineageDescriptorPath = (lineage: string): string => join(lineage, "lineage.json");

export type WindowsSeatSlot = ReturnType<typeof windowsSeatSlot>;

/** Open the generation's private host state separately from its immutable runtime inventory. */
export function prepareWindowsSeatSlot(slot: WindowsSeatSlot): void {
  makeWindowsCustodyDirectory(dirname(slot.lineage));
  makeWindowsCustodyDirectory(slot.lineage);
  withWindowsCustodyLock(join(slot.lineage, "lineage.lock"), () => {
    const path = windowsLineageDescriptorPath(slot.lineage);
    const descriptor = { version: 1, installation: slot.installation, sid: slot.sid, space: slot.space };
    const current = readWindowsPrivateRecord(path, 8192);
    if (current.state === "absent") writeWindowsPrivateRecord(path, descriptor, 8192);
    else if (current.state !== "verified" || JSON.stringify(current.value) !== JSON.stringify(descriptor))
      throw new Error("Windows PTY lineage descriptor is unknown");
  });
  makeWindowsCustodyDirectory(dirname(slot.root));
  makeWindowsCustodyDirectory(slot.root);
}

function contains(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
