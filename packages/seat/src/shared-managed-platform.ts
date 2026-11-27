import { resolve } from "node:path";
import type { ExactIdentity, ProcessObservation, VerifiedHost } from "./shared-platform.js";
import { readSharedHost, readSharedSeat, recordedProcess, sharedScopeMatches, SHARED_MULTIPLEX_VERSION, type SharedHostRecord, type SharedSeatRecord } from "./shared-record.js";

export interface LinuxSharedProcess extends ExactIdentity { bootId: string }

export interface LinuxSharedAuthority {
  platform: "linux";
  root: string;
  scope: string;
}

export type SharedGenerationIdentity = VerifiedHost<LinuxSharedProcess, LinuxSharedAuthority>;

export interface SharedSeatIdentity<Host = SharedGenerationIdentity, Child extends ExactIdentity = LinuxSharedProcess> {
  host: Host;
  id: string;
  child: Child;
}

export type VerifiedRead<T> = { state: "verified"; value: T } | { state: "absent" } | { state: "unknown" };

export type SharedGenerationView<Host = SharedGenerationIdentity, Seat = SharedSeatIdentity> = VerifiedRead<{
  host: Host;
  /** Only named reservations were observed. This is never an inventory of all occupied seats. */
  seats: ReadonlyMap<string, VerifiedRead<Seat>>;
}>;

export function observeLinuxSharedProcess({ pid, start, bootId }: LinuxSharedProcess): ProcessObservation {
  return recordedProcess(pid, start, bootId) ?? "unknown";
}

function sameProcess(a: LinuxSharedProcess, b: LinuxSharedProcess): boolean {
  return a.pid === b.pid && a.start === b.start && a.bootId === b.bootId;
}

export function generationIdentity(root: string, record: SharedHostRecord): SharedGenerationIdentity {
  const { pid, start, bootId, protocol, token, scope } = record;
  return { identity: { pid, start, bootId }, authority: { platform: "linux", root, scope }, protocol, token };
}

export function sameGeneration(a: SharedGenerationIdentity, b: SharedGenerationIdentity): boolean {
  return a.authority.platform === b.authority.platform && a.authority.root === b.authority.root &&
    a.authority.scope === b.authority.scope && sameProcess(a.identity, b.identity) && a.protocol === b.protocol && a.token === b.token;
}

export function readManagedHost(root: string): VerifiedRead<SharedHostRecord> {
  try {
    const host = readSharedHost(root);
    const life = observeLinuxSharedProcess(host);
    if (life === "gone") return { state: "absent" };
    if (life !== "live" || host.protocol !== SHARED_MULTIPLEX_VERSION || !sharedScopeMatches(host.pid, host.scope, host.protocol))
      return { state: "unknown" };
    return { state: "verified", value: host };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown" };
  }
}

export function readSeatInHost(root: string, id: string, host: SharedHostRecord): VerifiedRead<SharedSeatRecord> {
  try {
    const seat = readSharedSeat(root, id);
    if (seat.protocol !== host.protocol || seat.custodianPid !== host.pid || seat.custodianStart !== host.start ||
        seat.bootId !== host.bootId || seat.scope !== host.scope) return { state: "unknown" };
    return { state: "verified", value: seat };
  } catch {
    // Even ENOENT need not prove absence: a reservation may not have a committed row yet.
    return { state: "unknown" };
  }
}

export function childIdentity(row: SharedSeatRecord): LinuxSharedProcess | undefined {
  return row.childStart === undefined ? undefined : { pid: row.childPid, start: row.childStart, bootId: row.bootId };
}

export function matchesSeatPin(pin: SharedSeatIdentity, host: SharedGenerationIdentity, row: SharedSeatRecord): boolean {
  const child = childIdentity(row);
  return pin.id === row.id && sameGeneration(pin.host, host) && child !== undefined && sameProcess(pin.child, child);
}

/** Read-only observation of one multiplexed generation. No claim, connection, or bootstrap. */
export function readSharedGeneration(root: string, seatIds: readonly string[] = []): SharedGenerationView {
  root = resolve(root);
  const observation = readManagedHost(root);
  if (observation.state !== "verified") return observation;
  const host = generationIdentity(root, observation.value);
  const seats = new Map<string, VerifiedRead<SharedSeatIdentity>>();
  for (const id of seatIds) {
    const seat = readSeatInHost(root, id, observation.value);
    const child = seat.state === "verified" ? childIdentity(seat.value) : undefined;
    seats.set(id, child && observeLinuxSharedProcess(child) === "live"
      ? { state: "verified", value: { host, id, child } }
      : { state: "unknown" });
  }
  const current = readManagedHost(root);
  if (current.state !== "verified" || !sameGeneration(host, generationIdentity(root, current.value))) return { state: "unknown" };
  return { state: "verified", value: { host, seats } };
}
