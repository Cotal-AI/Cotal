import { lstatSync, opendirSync, realpathSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { assertSocketPathFits } from "./protocol.js";
import { isSeatId, RECORD_VERSION } from "./record.js";
import { validSharedGeneration } from "./shared-controller-claim.js";
import { darwinSharedIdentity, validDarwinBirth, validDarwinBoot, validDarwinPid, type DarwinSharedIdentity } from "./shared-identity-darwin.js";
import type { ProcessObservation } from "./shared-platform.js";
import { readPrivateRecord, SHARED_MULTIPLEX_VERSION, sharedHostRecord, sharedSeatRecord, type SharedSeatRecord } from "./shared-record.js";

const hostLabel = /^ai\.cotal\.pty\.[a-f0-9]{32}$/;
const token = /^[a-f0-9]{64}$/;
const inventoryLimit = 4096;
const recordLimit = 64 * 1024;

export interface DarwinGenerationAddress {
  readonly scope: string;
  readonly socket: string;
}

export interface DarwinRecordedHost extends DarwinGenerationAddress {
  readonly identity: DarwinSharedIdentity;
  readonly protocol: typeof SHARED_MULTIPLEX_VERSION;
  readonly token: string;
}

type SeatObservation = { state: "recorded"; record: Readonly<Omit<SharedSeatRecord, "artifacts" | "artifactRoot">>; child: DarwinSharedIdentity; lifetime: ProcessObservation } |
  { state: "unknown" };

export type DarwinGenerationObservation = {
  generation: string;
  state: "recorded";
  host: DarwinRecordedHost;
  lifetime: ProcessObservation;
  seats: ReadonlyMap<string, SeatObservation>;
} | { generation: string; state: "unknown" };

export type DarwinLineageObservation = { state: "sampled"; generations: readonly DarwinGenerationObservation[] } | { state: "unknown" };

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid Darwin PTY record");
  return value as Record<string, unknown>;
}

function privateDirectory(path: string, uid: number): BigIntStats {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.uid !== BigInt(uid) || (stat.mode & 0o777n) !== 0o700n || realpathSync.native(path) !== path)
    throw new Error("invalid Darwin PTY directory");
  return stat;
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function list(path: string, consume: () => void): string[] {
  const dir = opendirSync(path);
  const names: string[] = [];
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      consume();
      names.push(entry.name);
    }
  } finally { dir.closeSync(); }
  return names.sort();
}

function hostRecord(raw: unknown, address: DarwinGenerationAddress, uid: number): DarwinRecordedHost {
  const row = object(raw), version = SHARED_MULTIPLEX_VERSION;
  assertSocketPathFits(address.socket, "darwin");
  if (row.version !== version || row.protocol !== version || row.scope !== address.scope || !hostLabel.test(address.scope) ||
      !isAbsolute(address.socket) || resolve(address.socket) !== address.socket || address.socket.includes("\0") ||
      basename(address.socket) !== `p-${address.scope.slice(-32)}.sock` || !validDarwinPid(row.pid) || !validDarwinBirth(row.start) ||
      !validDarwinBoot(row.bootId) || typeof row.token !== "string" || !token.test(row.token)) throw new Error("invalid Darwin PTY host record");
  return { ...address, protocol: version, token: row.token, identity: { pid: row.pid, start: row.start, bootId: row.bootId, uid } };
}

function scanSeat(root: string, id: string, host: DarwinRecordedHost): SeatObservation {
  try {
    const path = sharedSeatRecord(root, id), directory = dirname(path);
    const { uid, pid, start, bootId } = host.identity;
    const before = privateDirectory(directory, uid);
    const row = object(readPrivateRecord(path, recordLimit));
    if (row.version !== RECORD_VERSION || row.protocol !== host.protocol || row.id !== id || row.scope !== host.scope ||
        row.socket !== host.socket || row.custodianPid !== pid || row.custodianStart !== start || row.bootId !== bootId ||
        !validDarwinPid(row.childPid) || row.childPid === pid || !validDarwinBirth(row.childStart) ||
        typeof row.name !== "string" || !row.name || typeof row.token !== "string" || !token.test(row.token) ||
        !unchanged(before, privateDirectory(directory, uid))) return { state: "unknown" };
    const child = { pid: row.childPid, start: row.childStart, bootId, uid };
    const record = { version: RECORD_VERSION, protocol: host.protocol, scope: host.scope, id, name: row.name, socket: host.socket,
      token: row.token, custodianPid: pid, custodianStart: start, childPid: child.pid, childStart: child.start, bootId };
    return { state: "recorded", record, child, lifetime: darwinSharedIdentity.observe(child) };
  } catch { return { state: "unknown" }; }
}

function scanGeneration(root: string, generation: string, uid: number, address: DarwinGenerationAddress, consume: () => void): DarwinGenerationObservation {
  const before = privateDirectory(root, uid);
  const names = list(root, consume);
  if (names.some(name => name !== "host.json" && name !== "host.lock" && !isSeatId(name))) return { generation, state: "unknown" };
  const path = sharedHostRecord(root);
  const host = hostRecord(readPrivateRecord(path, 1024), address, uid);
  const seats = new Map(names.filter(isSeatId).map(id => [id, scanSeat(root, id, host)]));
  if (!unchanged(before, privateDirectory(root, uid)) ||
      JSON.stringify(host) !== JSON.stringify(hostRecord(readPrivateRecord(path, 1024), address, uid))) return { generation, state: "unknown" };
  return { generation, state: "recorded", host, lifetime: darwinSharedIdentity.observe(host.identity), seats };
}

/** Sample one already-derived lineage. This does not verify a launchd job, authenticate a peer,
 * establish an admission fence, prove absence, or grant stop or collection authority. */
export function sampleDarwinLineage(lineage: string, addressFor: (generation: string) => DarwinGenerationAddress): DarwinLineageObservation {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || !uid || !/^[a-f0-9]{32}$/.test(basename(lineage))) return { state: "unknown" };
  let remaining = inventoryLimit;
  const consume = () => { if (--remaining < 0) throw new Error("Darwin PTY inventory exceeds its bound"); };
  try {
    const before = privateDirectory(lineage, uid);
    const names = list(lineage, consume);
    const generations: DarwinGenerationObservation[] = [];
    const seenScopes = new Set<string>();
    for (const generation of names) {
      if (generation === "controller.json" || generation === "controller.lock") continue;
      if (!validSharedGeneration(generation)) return { state: "unknown" };
      try {
        const address = addressFor(generation);
        if (seenScopes.has(address.scope)) return { state: "unknown" };
        seenScopes.add(address.scope);
        generations.push(scanGeneration(join(lineage, generation), generation, uid, address, consume));
      } catch { generations.push({ generation, state: "unknown" }); }
      if (remaining < 0) return { state: "unknown" };
    }
    return unchanged(before, privateDirectory(lineage, uid)) ? { state: "sampled", generations } : { state: "unknown" };
  } catch { return { state: "unknown" }; }
}
