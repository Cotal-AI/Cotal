import { createHash } from "node:crypto";
import { lstatSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { windowsUserSid } from "./host.js";
import { windowsWriterProof } from "./shared-control-win32.js";
import { checkWindowsCustodyRoot, makeWindowsCustodyDirectory, withWindowsCustodyLock } from "./shared-files-win32.js";
import type { VerifiedRead } from "./shared-managed-platform.js";
import { isSeatId, seatId as nonce } from "./record.js";
import { readWindowsHost, readWindowsPrivateRecord, readWindowsSeat, readWindowsSeatExit, windowsSeatWasRefused, writeWindowsPrivateRecord, type WindowsHostRecord } from "./shared-record-win32.js";
import { deriveWindowsSeatSlot, windowsSeatStoreAddress, windowsSeatStorePresent, type WindowsSeatSlot } from "./shared-slot-win32.js";

export type WindowsAliasHoldState = "clear" | "held" | "unknown";
export interface WindowsAliasHold {
  /** The caller must know no launch frame for this reservation was sent. */
  releaseUnsent(): boolean;
  /** The caller must prove exact host death or authenticated ordered absence before calling. */
  releaseAbsent(): boolean;
  releaseRefused(): boolean;
  releaseExited(): boolean;
}
interface AliasRow { version: 1; alias: string; nonce: string; slot: WindowsSeatSlot; host: WindowsHostRecord; id: string }
const BOUND = 8192;
const unknown = { state: "unknown" } as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function addressAlias(alias: string): string {
  if (typeof alias !== "string" || !alias || alias.length > 512 || /[\x00-\x1f]/.test(alias)) throw new Error("invalid Windows PTY alias");
  return hash(alias.toLowerCase());
}

function aliasPath(lineage: string, alias: string) { return join(lineage, "aliases", `${addressAlias(alias)}.json`); }

function readAlias(path: string, alias: string, lineage: string, sid: string): VerifiedRead<AliasRow> {
  const found = readWindowsPrivateRecord(path, BOUND);
  if (found.state !== "verified") return found;
  const row = found.value;
  if (!object(row) || row.version !== 1 || typeof row.alias !== "string" || row.alias.toLowerCase() !== alias.toLowerCase() ||
      typeof row.nonce !== "string" || !isSeatId(row.nonce) || typeof row.id !== "string" || !isSeatId(row.id) ||
      !object(row.slot) || !object(row.host)) return unknown;
  const { slot, host } = row;
  if (slot.lineage !== lineage || slot.sid !== sid || typeof slot.key !== "string" || !/^[a-f0-9]{32}$/.test(slot.key) ||
      typeof slot.generation !== "string" || !/^[a-f0-9]{64}$/.test(slot.generation) ||
      typeof slot.name !== "string" || typeof slot.pipe !== "string" ||
      slot.root !== join(dirname(dirname(lineage)), slot.generation, "hosts", slot.key) ||
      host.user !== sid || host.version !== 2 || host.protocol !== 2 || typeof host.token !== "string" || !/^[a-f0-9]{64}$/.test(host.token) ||
      typeof host.pid !== "number" || !Number.isInteger(host.pid) || host.pid <= 1 || host.pid > 0xffffffff ||
      typeof host.start !== "string" || !/^[1-9][0-9]{0,19}$/.test(host.start) || BigInt(host.start) > 0xffffffffffffffffn ||
      typeof host.session !== "number" || !Number.isInteger(host.session) || host.session < 1 || host.session > 0x7fffffff) return unknown;
  return { state: "verified", value: row as unknown as AliasRow };
}

function terminal(row: AliasRow, kind?: "refused" | "exited"): boolean {
  const { slot, id, host } = row;
  return (kind !== "exited" && windowsSeatWasRefused(slot, id, host).state === "verified") ||
    (kind !== "refused" && readWindowsSeatExit(slot, id, host).state === "verified");
}

/** Census callers first verify the lineage descriptor and validate the containing directory. */
export function inspectWindowsAliasRecord(path: string, anchor: WindowsSeatSlot): WindowsAliasHoldState {
  const found = readWindowsPrivateRecord(path, BOUND);
  if (found.state !== "verified" || !object(found.value) || typeof found.value.alias !== "string") return "unknown";
  const row = readAlias(path, found.value.alias, anchor.lineage, anchor.sid);
  if (row.state !== "verified" || `${addressAlias(row.value.alias)}.json` !== basename(path)) return "unknown";
  const expected = deriveWindowsSeatSlot(dirname(dirname(anchor.lineage)), anchor.installation, anchor.sid, anchor.space, row.value.slot.generation);
  if (expected.key !== row.value.slot.key || expected.root !== row.value.slot.root || expected.name !== row.value.slot.name || expected.pipe !== row.value.slot.pipe) return "unknown";
  return terminal(row.value) ? "clear" : "held";
}

function privateChild(parent: string, path: string): boolean {
  if (!lstatSync(path, { throwIfNoEntry: false })) { checkWindowsCustodyRoot(parent); return false; }
  checkWindowsCustodyRoot(path);
  return true;
}

/** Read-only. A missing path below unverified custody is not evidence the name is free. */
export function inspectWindowsAliasHold(installation: string, space: string, alias: string): WindowsAliasHoldState {
  try {
    addressAlias(alias);
    const address = windowsSeatStoreAddress(installation);
    if (!windowsSeatStorePresent(address)) return "clear";
    const { root: store, installation: install } = address;
    const anchor = deriveWindowsSeatSlot(store, install, windowsUserSid(), space, "0".repeat(64));
    const { lineage, sid } = anchor, lineages = dirname(lineage);
    const path = aliasPath(lineage, alias), aliases = dirname(path);
    for (const [base, dir] of [[store, lineages], [lineages, lineage], [lineage, aliases]]) {
      if (!privateChild(base, dir)) return "clear";
    }
    const row = readAlias(path, alias, lineage, sid);
    if (row.state === "unknown") return "unknown";
    if (row.state === "absent") return "clear";
    if (row.value.slot.key !== deriveWindowsSeatSlot(store, install, sid, space, row.value.slot.generation).key) return "unknown";
    return terminal(row.value) ? "clear" : "held";
  } catch { return "unknown"; }
}

/** Install the hold before dispatch; no process/transport failure can erase it. */
export function reserveWindowsAliasHold(slot: WindowsSeatSlot, alias: string, host: WindowsHostRecord, id: string): WindowsAliasHold | undefined {
  try {
    if (!isSeatId(id)) return undefined;
    const path = aliasPath(slot.lineage, alias), dir = dirname(path), lock = join(dir, "aliases.lock");
    makeWindowsCustodyDirectory(dir);
    const row: AliasRow = { version: 1, alias, nonce: nonce(), slot: { ...slot }, host: { ...host }, id };
    const installed = withWindowsCustodyLock(lock, () => {
      const old = readAlias(path, alias, slot.lineage, slot.sid), current = readWindowsHost(slot);
      if (old.state === "unknown" || (old.state === "verified" && !terminal(old.value)) || current.state !== "verified" ||
          current.value.token !== host.token || !windowsWriterProof.same(current.value, host) || windowsWriterProof.observe(host) !== "live" ||
          readWindowsSeat(slot, id, host).state !== "absent") return false;
      writeWindowsPrivateRecord(path, row, BOUND);
      return true;
    });
    if (!installed) return undefined;
    const release = (kind: "unsent" | "refused" | "exited") => {
      try {
        return withWindowsCustodyLock(lock, () => {
          const current = readAlias(path, alias, slot.lineage, slot.sid);
          if (current.state !== "verified" || current.value.nonce !== row.nonce) return false;
          if (kind === "unsent" ? readWindowsSeat(slot, id, host).state !== "absent" : !terminal(row, kind)) return false;
          unlinkSync(path);
          return true;
        });
      } catch { return false; }
    };
    const releaseAbsent = () => release("unsent");
    return { releaseUnsent: releaseAbsent, releaseAbsent, releaseRefused: () => release("refused"), releaseExited: () => release("exited") };
  } catch { return undefined; }
}
