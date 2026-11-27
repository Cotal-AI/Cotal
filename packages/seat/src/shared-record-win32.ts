import { lstatSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SeatExit } from "./protocol.js";
import { assertSeatId, RECORD_VERSION, type SeatRecord } from "./record.js";
import { windowsWriterProof, type WindowsSharedIdentity } from "./shared-control-win32.js";
import { checkWindowsCustodyRoot, withWindowsCustodyLock } from "./shared-files-win32.js";
import type { VerifiedRead } from "./shared-managed-platform.js";
import type { HostRecords, SeatReservation } from "./shared-platform.js";
import { readWindowsPrivateRecord, writeWindowsPrivateRecord } from "./shared-record-win32-io.js";
import type { WindowsSeatSlot } from "./shared-slot-win32.js";

export { readWindowsPrivateRecord, writeWindowsPrivateRecord } from "./shared-record-win32-io.js";

export interface WindowsClaim extends WindowsSharedIdentity { version: 1; generation: string }
export interface WindowsHostRecord extends WindowsSharedIdentity { version: 2; protocol: 2; token: string }
export interface WindowsSeatRecord extends SeatRecord { protocol: 2; child: WindowsSharedIdentity }

const SMALL = 2048;
const unknown = { state: "unknown" } as const;
const absent = { state: "absent" } as const;
const verified = <T>(value: T): VerifiedRead<T> => ({ state: "verified", value });
const object = (row: unknown): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row);
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hostPath = (slot: WindowsSeatSlot) => join(slot.root, "host.json");
const claimPath = (slot: WindowsSeatSlot) => join(slot.lineage, "controller.json");
const seatDirectory = (slot: WindowsSeatSlot, id: string) => join(slot.root, assertSeatId(id));

function identity(row: unknown, sid: string): row is WindowsSharedIdentity {
  return object(row) && row.user === sid && typeof row.pid === "number" && Number.isInteger(row.pid) && row.pid > 1 && row.pid <= 0xffffffff &&
    typeof row.start === "string" && /^[1-9][0-9]{0,19}$/.test(row.start) && BigInt(row.start) <= 0xffffffffffffffffn &&
    typeof row.session === "number" && Number.isInteger(row.session) && row.session >= 0 && row.session <= 0x7fffffff;
}

function validHost(slot: WindowsSeatSlot, row: unknown): row is WindowsHostRecord {
  return object(row) && row.version === 2 && row.protocol === 2 && hex(row.token) && identity(row, slot.sid) && row.session > 0;
}

function sameHost(a: WindowsHostRecord, b: WindowsHostRecord): boolean {
  return a.token === b.token && windowsWriterProof.same(a, b);
}

function address(slot: WindowsSeatSlot) {
  return { key: slot.key, generation: slot.generation };
}

/** Structural custody proof. The caller must still verify native lifetime and task authority. */
export function readWindowsHost(slot: WindowsSeatSlot): VerifiedRead<WindowsHostRecord> {
  const result = readWindowsPrivateRecord(hostPath(slot), SMALL);
  if (result.state !== "verified") return result;
  const row = result.value;
  if (!object(row) || row.key !== slot.key || row.generation !== slot.generation || !validHost(slot, row)) return unknown;
  const { pid, start, user, session, token } = row;
  return verified({ version: 2, protocol: 2, pid, start, user, session, token });
}

/** The claim address is deliberately independent of the selected generation. */
export function readWindowsControllerClaim(slot: WindowsSeatSlot): VerifiedRead<WindowsClaim> {
  const result = readWindowsPrivateRecord(claimPath(slot), SMALL);
  if (result.state !== "verified") return result;
  const row = result.value;
  if (!object(row) || row.version !== 1 || row.lineage !== slot.lineage.toLowerCase() || !hex(row.generation) || !identity(row, slot.sid)) return unknown;
  const { pid, start, user, session, generation } = row;
  return verified({ version: 1, pid, start, user, session, generation });
}

/** Change the selection as the current claimant, or take over only after exact predecessor death. */
export function publishWindowsControllerClaim(slot: WindowsSeatSlot, generation?: string): boolean {
  if (generation !== undefined && !hex(generation)) return false;
  const current = windowsWriterProof.current();
  if (!identity(current, slot.sid)) return false;
  try {
    return withWindowsCustodyLock(join(slot.lineage, "controller.lock"), () => {
      const prior = readWindowsControllerClaim(slot);
      if (prior.state === "unknown") return false;
      const previous = prior.state === "verified" ? prior.value : undefined;
      const selected = generation ?? previous?.generation;
      if (selected === undefined) return false;
      if (previous && windowsWriterProof.same(previous, current)) {
        if (previous.generation === selected) return true;
      } else if (previous && windowsWriterProof.observe(previous) !== "gone") return false;
      const { pid, start, user, session } = current;
      writeWindowsPrivateRecord(claimPath(slot), { version: 1, pid, start, user, session, generation: selected,
        lineage: slot.lineage.toLowerCase() }, SMALL);
      return true;
    });
  } catch { return false; }
}

/** A missing reservation is meaningful only below a verified slot root. */
function readReservation(slot: WindowsSeatSlot, id: string): VerifiedRead<string> {
  try {
    const directory = seatDirectory(slot, id);
    checkWindowsCustodyRoot(slot.root);
    if (!lstatSync(directory, { throwIfNoEntry: false })) {
      checkWindowsCustodyRoot(slot.root);
      return absent;
    }
    checkWindowsCustodyRoot(directory);
    return verified(directory);
  } catch { return unknown; }
}

function seatBinding(slot: WindowsSeatSlot, id: string, host: WindowsHostRecord) {
  return { ...address(slot), protocol: 2, id, host };
}

function matchesBinding(slot: WindowsSeatSlot, id: string, host: WindowsHostRecord, row: Record<string, unknown>): boolean {
  return row.protocol === 2 && row.id === id && row.key === slot.key && row.generation === slot.generation &&
    validHost(slot, row.host) && validHost(slot, host) && sameHost(row.host, host);
}

function canonicalLocalPath(path: unknown): path is string {
  return typeof path === "string" && /^[a-z]:\\/i.test(path) && !/[:<>"|?*\x00-\x1f]/.test(path.slice(2)) &&
    resolve(path) === path;
}

function artifactShape(artifacts: unknown, root: unknown): artifacts is string[] {
  if (!Array.isArray(artifacts) || artifacts.length < 1 || artifacts.length > 64 || !canonicalLocalPath(root)) return false;
  const seen = new Set<string>();
  for (const dir of artifacts) {
    if (!canonicalLocalPath(dir) || dirname(dir) !== root || !/^cotal-[A-Za-z0-9_-]+$/.test(basename(dir)) || seen.has(dir.toLowerCase()))
      return false;
    seen.add(dir.toLowerCase());
  }
  return true;
}

/** Gate recursive cleanup on canonical, owner-private direct children of the private artifact root. */
export function windowsSeatArtifactsEligible(artifacts: unknown, root: unknown): boolean {
  if (artifacts === undefined || (Array.isArray(artifacts) && artifacts.length === 0)) return true;
  if (!artifactShape(artifacts, root) || typeof root !== "string") return false;
  try {
    checkWindowsCustodyRoot(root);
    for (const dir of artifacts) checkWindowsCustodyRoot(dir);
    return true;
  } catch { return false; }
}

function privateDirectoryIdentity(path: string): string {
  checkWindowsCustodyRoot(path);
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isDirectory() || stat.ino === 0n) throw new Error("Windows PTY artifact identity is unknown");
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

/** Pin the exact directories before launch. Cleanup is best effort and never follows an observed replacement. */
export function pinWindowsSeatArtifacts(artifacts: readonly string[] | undefined, root: string): (paths: readonly string[] | undefined) => void {
  const pinned = new Map<string, string>();
  let rootIdentity: string | undefined;
  if (artifacts?.length) {
    if (!artifactShape(artifacts, root)) throw new Error("Windows PTY artifact paths are unknown");
    rootIdentity = privateDirectoryIdentity(root);
    for (const path of artifacts) pinned.set(path, privateDirectoryIdentity(path));
  } else if (artifacts !== undefined && !Array.isArray(artifacts)) throw new Error("Windows PTY artifact paths are unknown");
  const checkRoot = () => {
    if (privateDirectoryIdentity(root) !== rootIdentity) throw new Error("Windows PTY artifact root changed");
  };
  const checkLeaf = (path: string) => {
    checkRoot();
    if (!lstatSync(path, { throwIfNoEntry: false })) { checkRoot(); return false; }
    if (privateDirectoryIdentity(path) !== pinned.get(path)) throw new Error("Windows PTY artifact directory changed");
    return true;
  };
  return paths => {
    if (paths === undefined || (Array.isArray(paths) && !paths.length)) return;
    if (!artifactShape(paths, root) || paths.some(path => !pinned.has(path))) throw new Error("Windows PTY artifact paths are not pinned");
    for (const path of paths) checkLeaf(path);
    // The private ACL is the mutation boundary. Node has no handle-relative recursive delete.
    for (const path of paths) if (checkLeaf(path)) rmSync(path, { recursive: true, force: false });
  };
}

function validSeat(slot: WindowsSeatSlot, id: string, host: WindowsHostRecord, row: unknown): row is SeatRecord {
  return object(row) && row.version === RECORD_VERSION && row.id === id && row.socket === slot.pipe && hex(row.token) &&
    typeof row.name === "string" && !!row.name && row.custodianPid === host.pid && row.custodianStart === host.start &&
    row.bootId === undefined && (row.artifacts === undefined ? row.artifactRoot === undefined : artifactShape(row.artifacts, row.artifactRoot));
}

export function readWindowsSeat(slot: WindowsSeatSlot, id: string, host: WindowsHostRecord): VerifiedRead<WindowsSeatRecord> {
  const reservation = readReservation(slot, id);
  if (reservation.state !== "verified") return reservation;
  const result = readWindowsPrivateRecord(join(reservation.value, "shared.json"));
  // An occupied reservation can be between prepare and publication.
  if (result.state !== "verified") return unknown;
  const row = result.value;
  if (!object(row) || !matchesBinding(slot, id, host, row) || !validSeat(slot, id, host, row.seat) || !identity(row.child, slot.sid) ||
      row.child.session !== host.session || row.child.pid !== row.seat.childPid || row.child.start !== row.seat.childStart) return unknown;
  return verified({ ...row.seat, protocol: 2, child: row.child });
}

function validExit(value: unknown): value is SeatExit {
  return object(value) && Object.keys(value).every(key => key === "code" || key === "signal" || key === "diagnostic") &&
    (value.code === undefined || Number.isSafeInteger(value.code)) && (value.signal === undefined || Number.isSafeInteger(value.signal)) &&
    (value.diagnostic === undefined || typeof value.diagnostic === "string");
}

export function readWindowsSeatExit(slot: WindowsSeatSlot, id: string, host: WindowsHostRecord): VerifiedRead<SeatExit> {
  const reservation = readReservation(slot, id);
  if (reservation.state !== "verified") return reservation;
  const result = readWindowsPrivateRecord(join(reservation.value, "exit.json"));
  if (result.state !== "verified") return result;
  const row = result.value, seat = readWindowsSeat(slot, id, host);
  return object(row) && matchesBinding(slot, id, host, row) && validExit(row.exit) && seat.state === "verified" &&
    identity(row.child, slot.sid) && windowsWriterProof.same(row.child, seat.value.child) ? verified(row.exit) : unknown;
}

export function windowsSeatWasRefused(slot: WindowsSeatSlot, id: string, host: WindowsHostRecord): VerifiedRead<true> {
  const reservation = readReservation(slot, id);
  if (reservation.state !== "verified") return reservation;
  const result = readWindowsPrivateRecord(join(reservation.value, "not-admitted.json"), SMALL);
  if (result.state !== "verified") return result;
  const row = result.value;
  return object(row) && matchesBinding(slot, id, host, row) &&
    readWindowsPrivateRecord(join(reservation.value, "shared.json")).state === "absent" &&
    readWindowsPrivateRecord(join(reservation.value, "exit.json")).state === "absent" ? verified(true) : unknown;
}

function createReservation(slot: WindowsSeatSlot, id: string, host: WindowsHostRecord, directory: string): SeatReservation {
  const recordPath = join(directory, "shared.json"), binding = seatBinding(slot, id, host);
  let child: WindowsSharedIdentity | undefined;
  let refused = false;
  return { directory, recordPath,
    publish(seat) {
      const candidate = { pid: seat.childPid, start: seat.childStart, user: host.user, session: host.session };
      if (refused || !validSeat(slot, id, host, seat) || !identity(candidate, slot.sid) || candidate.pid === host.pid ||
          (child ? !windowsWriterProof.same(child, candidate) : windowsWriterProof.observe(candidate) !== "live" ||
            !windowsSeatArtifactsEligible(seat.artifacts, seat.artifactRoot)))
        throw new Error("unknown Windows PTY seat identity");
      writeWindowsPrivateRecord(recordPath, { ...binding, child: candidate, seat });
      child = candidate;
    },
    refuse() {
      if (child || readWindowsPrivateRecord(recordPath).state !== "absent") throw new Error("Windows PTY reservation may have been admitted");
      writeWindowsPrivateRecord(join(directory, "not-admitted.json"), binding, SMALL);
      refused = true;
    },
    publishExit(exit) {
      if (!child || !validExit(exit)) throw new Error("unknown Windows PTY exit identity");
      writeWindowsPrivateRecord(join(directory, "exit.json"), { ...binding, child, exit });
    },
    appendLog() { /* Shared Windows hosts do not persist seat diagnostic logs. */ },
  };
}

/** The caller holds exclusive generation host custody while serving this factory. */
export function windowsHostRecords(slot: WindowsSeatSlot, host: WindowsHostRecord): HostRecords<WindowsClaim> {
  const current = windowsWriterProof.current();
  if (!validHost(slot, host) || !current || !windowsWriterProof.same(current, host)) throw new Error("unknown Windows PTY host identity");
  host = { ...host };
  return {
    readClaim() {
      const claim = readWindowsControllerClaim(slot);
      if (claim.state === "unknown") throw new Error("Windows PTY controller claim is unknown");
      return claim.state === "verified" ? claim.value : undefined;
    },
    acceptsLaunch(claim, generation): claim is WindowsClaim {
      return !!claim && generation === slot.generation && claim.generation === generation && windowsWriterProof.observe(claim) === "live";
    },
    reserve(id) {
      if (readReservation(slot, id).state !== "absent") return "unknown";
      try {
        const directory = seatDirectory(slot, id);
        mkdirSync(directory);
        checkWindowsCustodyRoot(directory);
        return createReservation(slot, id, host, directory);
      } catch { return "unknown"; }
    },
    launchState: id => readReservation(slot, id).state === "absent" ? "absent" : "unknown",
    publishHost() {
      const old = readWindowsHost(slot);
      if (old.state === "unknown" || (old.state === "verified" && windowsWriterProof.observe(old.value) !== "gone"))
        throw new Error("Windows PTY host record may still own custody");
      writeWindowsPrivateRecord(hostPath(slot), { ...host, ...address(slot) }, SMALL);
    },
    removeHost() {
      const old = readWindowsHost(slot);
      if (old.state === "absent") return;
      if (old.state !== "verified" || !sameHost(old.value, host)) throw new Error("Windows PTY host record changed");
      unlinkSync(hostPath(slot));
    },
  };
}
