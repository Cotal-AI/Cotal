/**
 * Seat checkpoints: the durable description of one preserved seat, sufficient to start it on
 * another host, plus the admission gates a destination runs before it launches anything.
 *
 * This is the machine-local half of `docs/design/session-recovery.md` sections 1.3 (steps 7 and 8),
 * 2.2 and 5.4. It lives in `@cotal-ai/workspace` because both the CLI (which cuts and admits) and
 * the manager (which owns the resume entry) depend on this package and never on each other.
 *
 * Two rules shape everything below. A checkpoint is content-addressed: every captured file is
 * recorded by path, byte size and sha256, and the record is written last, after the digests are
 * computed over the bytes that landed. And a checkpoint is non-secret by construction: it carries
 * credential REFERENCES (a path, and for the two credential files a digest) exactly as
 * `ManagerResumeIdentity` already does, never credential values, never the manager's own launch
 * material, and never a seat whose launch options could not be resolved.
 */
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { hardenPrivate } from "@cotal-ai/core";

export const SEAT_CHECKPOINT_FORMAT = "cotal-seat-checkpoint/v1" as const;
export const SEAT_CHECKPOINT_RECORD = "checkpoint.json";
/** The record is a bounded document like the resume document it carries, and for the same reason:
 *  a reader must be able to size its buffer before it trusts anything in the file. */
export const MAX_SEAT_CHECKPOINT_BYTES = 1024 * 1024;

/**
 * Where one cut's seat checkpoints live: `.cotal/maintenance/v<N>/checkpoints/<attempt>/<seat>/`.
 *
 * Scoped by the preservation attempt, not shared across cuts. The writer refuses a destination
 * that already exists, which is what makes a checkpoint immutable once sealed; without the attempt
 * in the path the second cut in a root would refuse on the first seat's leftover directory, and
 * deleting the old one to make room would destroy the artifact a rollback still needs.
 */
export function seatCheckpointDir(root: string, attemptId: string, version = 1): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/.test(attemptId))
    fail(`invalid preservation attempt id for a checkpoint path: ${JSON.stringify(attemptId)}`);
  return join(root, ".cotal", "maintenance", `v${version}`, "checkpoints", attemptId);
}

/** One captured file, addressed by its name inside the checkpoint directory. */
export interface SeatCheckpointFile {
  /** Basename within the checkpoint directory. Never a path, so a record cannot name a file
   *  outside the directory it was read from. */
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly kind: "bundle" | "index-diff" | "worktree-diff" | "untracked" | "session-store" | "session-pointer";
}

/** The repository half: a bundle anchored on a named base, plus the delta the bundle cannot carry. */
export interface SeatCheckpointRepository {
  /** Full object id. A destination refuses a bundle that does not contain this commit. */
  readonly base: string;
  /** The exact selection rule the untracked set was produced under. A destination that cannot
   *  reproduce this rule refuses rather than restoring a silently thinner tree. */
  readonly untrackedSelection: string;
  readonly bundle: SeatCheckpointFile;
  readonly indexDiff: SeatCheckpointFile;
  readonly worktreeDiff: SeatCheckpointFile;
  readonly untracked: SeatCheckpointFile;
}

/** The harness half: an opaque file set plus the session id it is expected to reopen. Cotal does
 *  not parse a transcript, so the store travels as bytes and nothing here interprets it. */
export interface SeatCheckpointSession {
  /** What `sessionContinuityClass` returned for this seat's connector. A destination refuses to
   *  promise more than the class allows. */
  readonly continuity: "exact" | "fork" | "fresh" | "drain-only";
  /** The harness-declared session id the store is expected to reopen, when the connector declares
   *  one. Absent for a class that does not reopen a session. */
  readonly sessionId?: string;
  /** The connector's session pointer file, captured beside the store. */
  readonly pointer?: SeatCheckpointFile;
  readonly store: readonly SeatCheckpointFile[];
}

/** The applied launch profile revision, so a destination can tell whether it is resuming the same
 *  intent rather than silently applying a newer profile to a recovered transcript. */
export interface SeatCheckpointProfile {
  readonly configSha256: string;
  readonly manifestSha256?: string;
  readonly hash?: string;
}

export interface SeatCheckpoint<Entry = unknown> {
  readonly format: typeof SEAT_CHECKPOINT_FORMAT;
  /** The manager's resume entry, unchanged and first. The checkpoint restates none of it. */
  readonly entry: Entry;
  readonly space: string;
  readonly name: string;
  readonly lifecycleUid: string;
  /** The per-seat writer generation this cut was taken at. A destination advances past it. */
  readonly generation: number;
  /** Absolute instant of the cut, compared against the destination's clock at gate 3. */
  readonly capturedAt: string;
  /** How long after `capturedAt` this checkpoint is admitted without an explicit override. A
   *  property of the deployment, stated here so a destination and an operator cannot disagree
   *  about what was promised. */
  readonly recencyHorizonMs: number;
  readonly profile: SeatCheckpointProfile;
  readonly repository: SeatCheckpointRepository;
  readonly session: SeatCheckpointSession;
}

/** Thrown by every refusal in this module. Each message names what the reader actually saw. */
export class SeatCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeatCheckpointError";
  }
}

function fail(message: string): never {
  throw new SeatCheckpointError(message);
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error) {
    // Windows cannot fsync a directory handle. A POSIX failure here is a durability failure.
    if (process.platform !== "win32") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertCapturedName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/.test(name) || name === SEAT_CHECKPOINT_RECORD)
    fail(`invalid checkpoint file name ${JSON.stringify(name)}`);
}

export interface SeatCheckpointWriter {
  readonly directory: string;
  /** Copy one file into the checkpoint, returning its content address. */
  captureFile(name: string, kind: SeatCheckpointFile["kind"], source: string): SeatCheckpointFile;
  /** Write the record. Last, after every digest above was computed over bytes that landed. */
  seal<Entry>(checkpoint: Omit<SeatCheckpoint<Entry>, "format">): SeatCheckpoint<Entry>;
  /** Remove an unsealed directory this writer exclusively created. */
  cleanup(): void;
}

/**
 * Open a checkpoint destination. The disposition is `createArtifactWriter`'s in
 * `implementations/cli/src/lib/backup-artifact.ts`: refuse a destination that already exists, and
 * harden the directory to 0700 before anything lands in it.
 */
export function createSeatCheckpointWriter(destination: string): SeatCheckpointWriter {
  const directory = resolve(destination);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      fail(`seat checkpoint destination already exists: ${directory}`);
    throw error;
  }
  try {
    hardenPrivate(directory, "dir");
    fsyncDirectory(dirname(directory));
  } catch (error) {
    // Exclusively created and still empty: a failed post-create step must not leak the directory
    // and block a same-destination retry.
    try { rmSync(directory, { recursive: true }); } catch { /* already absent */ }
    throw error;
  }
  let sealed = false;

  return {
    directory,
    captureFile(name, kind, source) {
      if (sealed) fail("seat checkpoint is already sealed");
      assertCapturedName(name);
      const from = resolve(source);
      const stat = lstatSync(from);
      if (!stat.isFile() || stat.isSymbolicLink())
        fail(`refusing to capture a non-regular or symlinked file: ${from}`);
      const bytes = readFileSync(from);
      const path = join(directory, name);
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
        // The digest must describe the bytes that LANDED, not the bytes we meant to write.
        if (fstatSync(fd).size !== bytes.byteLength)
          fail(`seat checkpoint size mismatch after writing ${name}`);
      } finally {
        closeSync(fd);
      }
      return {
        path: name,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        kind,
      };
    },
    seal<Entry>(checkpoint: Omit<SeatCheckpoint<Entry>, "format">): SeatCheckpoint<Entry> {
      if (sealed) fail("seat checkpoint is already sealed");
      const record: SeatCheckpoint<Entry> = { format: SEAT_CHECKPOINT_FORMAT, ...checkpoint };
      const data = `${JSON.stringify(record, null, 2)}\n`;
      if (Buffer.byteLength(data) > MAX_SEAT_CHECKPOINT_BYTES)
        fail(`seat checkpoint record exceeds ${MAX_SEAT_CHECKPOINT_BYTES} bytes`);
      // The record is the completion marker, so it appears atomically: durable bytes at a temp
      // name, then one rename. A crash can never leave a truncated checkpoint.json.
      const path = join(directory, SEAT_CHECKPOINT_RECORD);
      const tmp = join(directory, `${SEAT_CHECKPOINT_RECORD}.${process.pid}.${randomUUID()}.tmp`);
      const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        writeFileSync(fd, data);
        fsyncSync(fd);
        closeSync(fd);
      } catch (error) {
        try { closeSync(fd); } catch { /* already closed */ }
        try { rmSync(tmp); } catch { /* best effort for the exclusively-created temp */ }
        throw error;
      }
      renameSync(tmp, path);
      fsyncDirectory(directory);
      sealed = true;
      return record;
    },
    cleanup() {
      if (sealed) return;
      try { rmSync(directory, { recursive: true }); } catch { /* already absent */ }
      fsyncDirectory(dirname(directory));
    },
  };
}

function isCapturedFile(value: unknown): value is SeatCheckpointFile {
  const file = value as SeatCheckpointFile;
  return Boolean(file && typeof file === "object" &&
    typeof file.path === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/.test(file.path) &&
    Number.isInteger(file.size) && file.size >= 0 &&
    typeof file.sha256 === "string" && /^[0-9a-f]{64}$/.test(file.sha256));
}

/** Parse a checkpoint record, refusing anything a gate would otherwise have to guess about. */
export function parseSeatCheckpoint(value: unknown): SeatCheckpoint {
  const record = value as SeatCheckpoint;
  if (!record || typeof record !== "object" || Array.isArray(record))
    fail("seat checkpoint record is not an object");
  if (record.format !== SEAT_CHECKPOINT_FORMAT)
    fail(`seat checkpoint format is ${JSON.stringify(record.format)}, expected ${SEAT_CHECKPOINT_FORMAT}`);
  if (typeof record.space !== "string" || !record.space)
    fail("seat checkpoint record has no space");
  if (typeof record.name !== "string" || !record.name)
    fail("seat checkpoint record has no seat name");
  // The same token shape `resume.ts` enforces on every identity mode: the uid is recovered, never
  // minted, so a malformed one must not reach a launch.
  if (typeof record.lifecycleUid !== "string" || !/^[a-z0-9]{26,32}$/.test(record.lifecycleUid))
    fail(`seat checkpoint lifecycleUid is not a valid lifecycle token: ${JSON.stringify(record.lifecycleUid)}`);
  if (!Number.isInteger(record.generation) || record.generation < 0)
    fail(`seat checkpoint generation is not a non-negative integer: ${JSON.stringify(record.generation)}`);
  if (typeof record.recencyHorizonMs !== "number" || !Number.isFinite(record.recencyHorizonMs) || record.recencyHorizonMs <= 0)
    fail(`seat checkpoint recency horizon is not a positive duration: ${JSON.stringify(record.recencyHorizonMs)}`);
  // An unreadable capturedAt is refused with no override: a freshness gate that fails open is not
  // a gate.
  if (typeof record.capturedAt !== "string" || Number.isNaN(Date.parse(record.capturedAt)))
    fail(`seat checkpoint capturedAt is not a readable instant: ${JSON.stringify(record.capturedAt)}`);
  const session = record.session;
  if (!session || typeof session !== "object")
    fail("seat checkpoint record has no session block");
  if (!["exact", "fork", "fresh", "drain-only"].includes(session.continuity))
    fail(`seat checkpoint continuity class is unknown: ${JSON.stringify(session.continuity)}`);
  if (!Array.isArray(session.store) || !session.store.every(isCapturedFile))
    fail("seat checkpoint session store is not a list of captured files");
  if (session.pointer !== undefined && !isCapturedFile(session.pointer))
    fail("seat checkpoint session pointer is not a captured file");
  const repository = record.repository;
  if (!repository || typeof repository !== "object")
    fail("seat checkpoint record has no repository block");
  if (typeof repository.base !== "string" || !/^[0-9a-f]{40,64}$/.test(repository.base))
    fail(`seat checkpoint repository base is not a full object id: ${JSON.stringify(repository.base)}`);
  if (typeof repository.untrackedSelection !== "string" || !repository.untrackedSelection)
    fail("seat checkpoint repository does not state the untracked selection rule it was produced under");
  for (const key of ["bundle", "indexDiff", "worktreeDiff", "untracked"] as const) {
    if (!isCapturedFile(repository[key]))
      fail(`seat checkpoint repository.${key} is not a captured file`);
  }
  return record;
}

/** Every file a checkpoint names, in one list, so gate 1 cannot miss one by walking the shape. */
export function seatCheckpointFiles(record: SeatCheckpoint): readonly SeatCheckpointFile[] {
  return [
    record.repository.bundle,
    record.repository.indexDiff,
    record.repository.worktreeDiff,
    record.repository.untracked,
    ...(record.session.pointer ? [record.session.pointer] : []),
    ...record.session.store,
  ];
}

/** Read and parse the record itself, under the same discipline the resume document reader uses:
 *  no symlink, bounded read, and a re-stat after the read so a file that moved under us is a
 *  refusal rather than a value. */
export function readSeatCheckpoint(directory: string): SeatCheckpoint {
  const path = join(resolve(directory), SEAT_CHECKPOINT_RECORD);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") fail(`seat checkpoint record is missing: ${path}`);
    if (code === "ELOOP") fail(`seat checkpoint record must not be a symlink: ${path}`);
    fail(`seat checkpoint record cannot be inspected: ${path}`);
  }
  let text: string;
  try {
    const before = fstatSync(fd!, { bigint: true });
    if (!before.isFile())
      fail(`seat checkpoint record is not a regular file: ${path}`);
    if (before.size > BigInt(MAX_SEAT_CHECKPOINT_BYTES))
      fail(`seat checkpoint record exceeds ${MAX_SEAT_CHECKPOINT_BYTES} bytes: ${path}`);
    const buffer = Buffer.alloc(Number(before.size));
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd!, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd!, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
      fail(`seat checkpoint record changed while it was being read: ${path}`);
    text = buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd!);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`seat checkpoint record is not valid JSON: ${path} (${(error as Error).message})`);
  }
  return parseSeatCheckpoint(parsed);
}

/**
 * Gate 1, integrity. Every file the checkpoint names must be present, be a regular non-symlink
 * file, match its recorded byte size, and match its recorded sha256. The file is re-stat'd after
 * the read and a move is a refusal, which is the standard `readMaintenanceResumeDocument` holds
 * itself to. Failure here is a refusal and no other gate is consulted.
 */
export function assertSeatCheckpointIntegrity(directory: string, record: SeatCheckpoint): void {
  const root = resolve(directory);
  for (const file of seatCheckpointFiles(record)) {
    const path = join(root, file.path);
    const noFollow = constants.O_NOFOLLOW ?? 0;
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | noFollow);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") fail(`checkpoint integrity: ${file.path} is missing from ${root}`);
      if (code === "ELOOP") fail(`checkpoint integrity: ${file.path} is a symlink`);
      fail(`checkpoint integrity: ${file.path} cannot be inspected (${code})`);
    }
    try {
      const before = fstatSync(fd!, { bigint: true });
      if (!before.isFile()) fail(`checkpoint integrity: ${file.path} is not a regular file`);
      if (before.size !== BigInt(file.size))
        fail(`checkpoint integrity: ${file.path} is ${before.size} bytes, the record says ${file.size}`);
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(Math.min(file.size, 1024 * 1024) || 1);
      let read = 0;
      while (read < file.size) {
        const count = readSync(fd!, buffer, 0, Math.min(buffer.length, file.size - read), null);
        if (count === 0) break;
        hash.update(buffer.subarray(0, count));
        read += count;
      }
      const after = fstatSync(fd!, { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
        fail(`checkpoint integrity: ${file.path} changed while it was being read`);
      if (read !== file.size)
        fail(`checkpoint integrity: ${file.path} ended after ${read} of ${file.size} bytes`);
      const digest = hash.digest("hex");
      if (digest !== file.sha256)
        fail(`checkpoint integrity: ${file.path} hashes to ${digest}, the record says ${file.sha256}`);
    } finally {
      closeSync(fd!);
    }
  }
}

export interface SeatIdentityAdmission {
  /** The destination's own space. A checkpoint from another space is refused. */
  readonly space: string;
  /** Whether the recorded lifecycle uid belongs to a live incarnation here, judged by the caller
   *  from the same two sources `resumePreserved` uses: the manager-local retirement hold and the
   *  roster with the confirmed-predecessor exception. */
  readonly lifecycleUidIsLive: boolean;
  /** The destination's current profile revision for this seat, when it has one. */
  readonly profileConfigSha256?: string;
}

/**
 * Gate 2, identity. Authority, not usefulness: this gate has no override, which is the only reason
 * gate 3 may have one.
 */
export function assertSeatCheckpointIdentity(record: SeatCheckpoint, admission: SeatIdentityAdmission): void {
  if (record.space !== admission.space)
    fail(`checkpoint identity: record is for space ${JSON.stringify(record.space)}, this destination is ${JSON.stringify(admission.space)}`);
  if (admission.lifecycleUidIsLive)
    fail(`checkpoint identity: lifecycle ${record.lifecycleUid} is already live and this runtime cannot authoritatively adopt it`);
  const current = admission.profileConfigSha256;
  // No override. The checkpoint carries the recorded DIGEST, not the config bytes, so nothing here
  // could run the seat under the recorded revision even if an operator consented; the manager
  // re-digests the same file and refuses drift on its own. A flag that admitted here and was
  // refused there would be consent that changes no outcome, so the refusal names the remedy.
  if (current !== undefined && current !== record.profile.configSha256)
    fail(`checkpoint identity: this destination's profile revision is ${current}, the checkpoint was cut at ${record.profile.configSha256}; restore the launch config to its recorded revision, then resume`);
}

export interface SeatRecencyAdmission {
  /** The destination's clock reading. Passed in so the decision is testable and so a caller that
   *  does not trust its clock can refuse before it gets here. */
  readonly now: number;
  /** Explicit operator consent to admit a checkpoint past its horizon, because a stale checkpoint
   *  is sometimes the only checkpoint. Recorded by the caller when it is used. */
  readonly acceptStale?: boolean;
}

/** What gate 3 decided, so a caller can record an override that was actually exercised rather than
 *  one that was merely offered. */
export interface SeatRecencyVerdict {
  readonly ageMs: number;
  readonly admitted: "inside-horizon" | "override";
}

/**
 * Gate 3, recency. Whether the transcript and the tree are close enough to the world for the
 * resumed seat's next turn to be sensible. Refused by default outside the horizon, with all three
 * values in the message; an explicit operator flag overrides and the caller records that it did.
 */
export function admitSeatCheckpointRecency(record: SeatCheckpoint, admission: SeatRecencyAdmission): SeatRecencyVerdict {
  const capturedAt = Date.parse(record.capturedAt);
  if (Number.isNaN(capturedAt))
    fail(`checkpoint recency: capturedAt ${JSON.stringify(record.capturedAt)} is not a readable instant`);
  if (!Number.isFinite(admission.now))
    fail("checkpoint recency: the destination clock did not read as a finite instant");
  const ageMs = admission.now - capturedAt;
  if (ageMs <= record.recencyHorizonMs) return { ageMs, admitted: "inside-horizon" };
  if (!admission.acceptStale)
    fail(`checkpoint recency: captured at ${record.capturedAt}, this destination reads ${new Date(admission.now).toISOString()}, horizon is ${record.recencyHorizonMs}ms`);
  return { ageMs, admitted: "override" };
}
