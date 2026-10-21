/**
 * Private-by-owner file/dir helpers — the one place secret material (creds, signing keys, the
 * transient MCP config) is written so it is readable ONLY by the current user.
 *
 * On POSIX mode 0o600 does this, set on the open file before the bytes land. On Windows the Unix
 * mode is a NO-OP — Node honors only the write bit — so a secret written that way inherits its
 * parent's ACL and can be world-readable (e.g. a `.cotal/auth` under a project on a permissive
 * path). The fix is to harden the NTFS ACL explicitly with the built-in `icacls` (no new
 * dependency). See {@link hardenPrivate}.
 */
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";

const isWin = process.platform === "win32";

/** Absolute path to a System32 tool — `icacls`/`whoami` are resolved from `%SystemRoot%` (not PATH)
 *  so a hijacked PATH can't substitute a malicious binary during the secret-hardening window. */
function sys32(exe: string): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return join(root, "System32", exe);
}

/** The current user's SID, for an `icacls` grant — parsed from `whoami /user /fo csv /nh`
 *  (`"machine\user","S-1-5-…"`). Cached: it never changes within a process. win32-only. */
let cachedSid: string | undefined;
function ownerSid(): string {
  if (cachedSid) return cachedSid;
  const out = execFileSync(sys32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  const sid = out.trim().split(",").pop()?.replace(/^"|"$/g, "").trim();
  if (!sid || !/^S-1-/.test(sid))
    throw new Error(`could not determine the current user's SID from \`whoami\` (got: ${out.trim()})`);
  cachedSid = sid;
  return sid;
}

/** Broad principals an ACL must never grant a secret: Everyone, Authenticated Users, Users. */
const BROAD_SIDS = ["S-1-1-0", "S-1-5-11", "S-1-5-32-545"] as const;

/**
 * Lock a file or directory down to the current user (+ SYSTEM + Administrators) only.
 *
 * POSIX: a file takes {@link openPrivate}'s rule, so a symlink, a non-regular file or another user's
 * file is refused with `EPERM` and left unchanged, and an owned file is set to 0o600 through the
 * descriptor. A directory is set to 0o700 with `chmod` by path, which follows a symlinked directory:
 * a symlinked `~/.cotal` or project `.cotal` is a working setup, so it is not refused.
 * win32: harden the NTFS ACL with `icacls`: `/inheritance:r` drops inherited ACEs; `/remove:g` drops
 * any pre-existing EXPLICIT broad grant (Everyone / Authenticated Users / Users) that `/grant:r`
 * alone would leave intact (e.g. on a pre-planted or pre-existing target); `/grant:r` then sets ONLY
 * the owner SID (`whoami /user`), SYSTEM (`S-1-5-18`), and Administrators (`S-1-5-32-544`). Removing
 * broad grants this way — rather than adding deny ACEs, which can catch the owner through group
 * membership — is the documented-safe pattern. Numeric SIDs are `*`-prefixed; the tools resolve from
 * `%SystemRoot%` and run shell-free. A directory grants `(OI)(CI)` so children inherit the private
 * ACE. FAIL-CLOSED: any `whoami`/`icacls` failure throws.
 */
export function hardenPrivate(path: string, kind: "file" | "dir"): void {
  if (!isWin) {
    if (kind === "file") closeSync(openPrivate(path, constants.O_RDONLY));
    else chmodSync(path, 0o700);
    return;
  }
  const perm = kind === "dir" ? "(OI)(CI)(F)" : "(F)";
  const removeBroad = BROAD_SIDS.flatMap((sid) => ["/remove:g", `*${sid}`]);
  const grant = (sid: string): string[] => ["/grant:r", `*${sid}:${perm}`];
  try {
    execFileSync(
      sys32("icacls.exe"),
      [
        path,
        "/inheritance:r",
        ...removeBroad,
        ...grant(ownerSid()),
        ...grant("S-1-5-18"),
        ...grant("S-1-5-32-544"),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (e) {
    throw new Error(
      `failed to harden ${kind} "${path}" to private via icacls: ${(e as Error).message.trim()}. ` +
        `Cotal will not leave a secret with a permissive ACL - ensure the path is on an NTFS volume and %SystemRoot%\\System32\\icacls.exe is available.`,
    );
  }
}

/** A refused private open. The name was left as it was. */
function notPrivate(path: string, why: string): NodeJS.ErrnoException {
  const refused: NodeJS.ErrnoException = new Error(`refusing to write "${path}": it ${why}; it was left unchanged`);
  refused.code = "EPERM";
  return refused;
}

/**
 * Open `path` for writing as this user's private file, mode 0o600 when the open creates it.
 *
 * POSIX: the open never follows a final symlink (`O_NOFOLLOW`) and never waits on a FIFO
 * (`O_NONBLOCK`). The opened inode must be a regular file this user owns; anything else is refused
 * with code `EPERM` and left unchanged. An owned file is then set to 0o600 through the descriptor,
 * which names no path, so a name swapped after the open cannot redirect the change.
 *
 * win32: POSIX owners, modes and `O_NOFOLLOW` are not that platform's protection model; its boundary
 * is the NTFS ACL (see {@link hardenPrivate}). So the open there takes mode 0o600 with no owner check.
 */
function openPrivate(path: string, flags: number): number {
  if (isWin) {
    const fd = openSync(path, flags, 0o600);
    try {
      fchmodSync(fd, 0o600);
    } catch (e) {
      closeSync(fd);
      throw e;
    }
    return fd;
  }
  let fd: number;
  try {
    fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw notPrivate(path, "is a symlink");
    throw e;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw notPrivate(path, "is not a regular file");
    if (info.uid !== process.getuid!()) throw notPrivate(path, `is owned by uid ${info.uid}, not this user`);
    fchmodSync(fd, 0o600);
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/**
 * Open a private log for appending under {@link openPrivate}'s rule: created 0o600, never through a
 * final symlink, refused unless it is this user's regular file, and an owned log set to 0o600. The
 * caller owns the returned descriptor.
 */
export function openPrivateAppend(path: string): number {
  return openPrivate(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND);
}

/**
 * Write a private secret file through {@link openPrivate}: mode 0o600 on the descriptor before the
 * bytes, whether or not the name already existed, and on POSIX a refusal for a final symlink, a
 * non-regular file or a file another user owns. Then {@link hardenPrivate} for the win32 ACL.
 * FAIL-CLOSED — if hardening throws, the hardening error propagates (the caller never proceeds as if
 * the secret were safe) and the just-written file is best-effort deleted so it isn't left readable.
 */
export function writeSecretFile(path: string, data: string | Buffer): void {
  writePrivate(path, data, false);
}

/**
 * Write an owner-private record in place under {@link openPrivate}'s rule, without the win32 ACL
 * step {@link writeSecretFile} adds: for a record that is not a secret, such as a pid identity pin
 * or a process marker. On POSIX a symlink, a non-regular file or a file another user owns is refused
 * with `EPERM` and left unchanged.
 */
export function writePrivateRecord(path: string, data: string | Buffer): void {
  writeBytes(path, data, false);
}

/**
 * Create an owner-private record that must not exist yet, under {@link openPrivate}'s rule with
 * `O_EXCL` and without the win32 ACL step: for a temporary that a rename then publishes. On POSIX any
 * existing name, a symlink included, fails with `EEXIST` and is left as it was.
 */
export function createPrivateRecord(path: string, data: string | Buffer): void {
  writeBytes(path, data, true);
}

/** {@link openPrivate}, then truncate and write the bytes; the descriptor is closed on every path. */
function writeBytes(path: string, data: string | Buffer, exclusive: boolean): void {
  // No O_TRUNC: a name openPrivate refuses keeps its bytes, so truncation waits until it passed.
  const fd = openPrivate(path, constants.O_WRONLY | constants.O_CREAT | (exclusive ? constants.O_EXCL : 0));
  try {
    ftruncateSync(fd);
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** The fail-closed write {@link writeSecretFile} documents, with exclusive create as a parameter so
 *  {@link writeSecretFileCreateOnlyRaw} can ask for `O_EXCL`. */
function writePrivate(path: string, data: string | Buffer, exclusive: boolean): void {
  writeBytes(path, data, exclusive);
  if (!isWin) return;
  try {
    hardenPrivate(path, "file");
  } catch (e) {
    try {
      unlinkSync(path); // best-effort cleanup; the hardening error below is what the caller sees
    } catch {
      /* ignore: surface the original hardening failure, not a secondary unlink error */
    }
    throw e;
  }
}

/**
 * Like {@link writeSecretFile} but ATOMIC: write a private temp sibling (same 0o600 + win32-ACL
 * hardening), then rename it over the target. `renameSync` is an atomic replace on POSIX and via
 * `MoveFileEx(REPLACE_EXISTING)` on Windows, so a concurrent reader never sees a torn/partial file and
 * a crash mid-write leaves the previous file intact. Use this for a read-modify-write of a shared secret
 * file (e.g. the IdP session cache). NB: this closes torn-file/partial-write hazards; a lost update
 * under two truly-concurrent writers to the same file is a rarer residual that would need file locking.
 */
export function writeSecretFileAtomic(path: string, data: string | Buffer): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeSecretFile(tmp, data); // 0o600 at create + win32 ACL harden on the TEMP; the ACL rides the rename
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp); // best-effort cleanup of the temp on any failure
    } catch {
      /* ignore — surface the original write/rename error */
    }
    throw e;
  }
}

/**
 * {@link writeSecretFile} with `O_EXCL`: the bytes land only if this caller created the name.
 * Same fail-closed hardening contract as {@link writeSecretFile}: a win32 ACL failure propagates
 * and the just-written file is best-effort removed, so a caller never proceeds as if the secret
 * were private. EEXIST propagates to the caller, which is the point: the name was already taken.
 *
 * `O_EXCL` alone does not carry that contract everywhere. On POSIX it refuses a final symlink
 * without following it, so a DANGLING link is EEXIST (measured: file, directory and dangling link
 * all refuse, and nothing is materialised). On Windows the reparse point resolves, the missing
 * target is created, and the bytes land at a name this caller did NOT create, which is precisely
 * what the contract above forbids. A win32-only `lstatSync` closes that: it reports the LINK rather
 * than its target, so a name that exists in any form is refused before anything is written.
 *
 * That pre-check is deliberately NOT run on POSIX. It would be a check-then-act step guarding a
 * case `O_EXCL` already refuses, and an unnecessary one weakens the very property this function
 * exists to provide. Where it does run it is a refusal, never a fallback: it only converts a
 * would-be silent write-through into the EEXIST the caller already handles, and it never decides a
 * concurrent create: two creators that both find the name free still both reach `O_EXCL`, which is
 * one syscall and is what picks the winner.
 */
function writeSecretFileCreateOnlyRaw(path: string, data: string | Buffer): void {
  // Deliberately win32 only, for the reason the doc comment gives.
  if (isWin) {
    let exists = true;
    try {
      lstatSync(path); // the NAME exists (file, dir, or dangling link), never write through it
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      exists = false;
    }
    if (exists) {
      const taken: NodeJS.ErrnoException = new Error(`EEXIST: file already exists, open '${path}'`);
      taken.code = "EEXIST";
      throw taken;
    }
  }
  writePrivate(path, data, true);
}

/**
 * Publish a completed temp inode at its final name. Separated from {@link writeSecretFileCreateOnly}
 * because the hard-link primitive is the one part of exclusive create whose AVAILABILITY is
 * platform-dependent: some Windows volumes and some network filesystems reject `link` outright.
 * Naming that seam makes the refusal reachable from a suite.
 */
let publishLink: (from: string, to: string) => void = linkSync;

/** Test-only: drive the `link`-unavailable refusal, which no POSIX CI host can reach naturally.
 *  Pass `undefined` to restore. Not exported from the package index. */
export function __setPublishLinkForTest(fn: ((from: string, to: string) => void) | undefined): void {
  publishLink = fn ?? linkSync;
}

/**
 * Create a private secret file that MUST NOT already exist. Bytes are written to a unique temp
 * sibling first, then {@link linkSync} publishes that complete inode at `path`. `link` is an
 * atomic filesystem primitive: it fails with EEXIST if the destination exists, so of N concurrent
 * creators exactly one succeeds and the others observe EEXIST. A concurrent reader never sees a
 * torn destination because the name appears only after the temp write finished.
 *
 * `renameSync` is NOT this function. Rename replaces a winner, which would let every caller keep
 * the identity it minted in memory. Exclusive create is the mutual-exclusion primitive; atomic
 * replace is not.
 *
 * When the filesystem cannot hard-link (some Windows volumes or network filesystems), the function
 * refuses rather than falling back to an in-place create, so a concurrent reader is never exposed
 * to a partially written file.
 *
 * The TEMP write is exclusive for the same reason the publish is. A temp name is unique only by
 * probability (pid plus clock plus `Math.random`), and probability is not a concurrency argument:
 * two creators that collided on the name would plain-overwrite each other's bytes, and then the
 * one whose `link` succeeded would return the candidate IT minted while the published file held
 * the OTHER one's identity: the exact split this function exists to prevent, reintroduced one
 * step earlier. `O_EXCL` on the temp makes a collision fail loudly instead of silently swapping bytes.
 */
export function writeSecretFileCreateOnly(path: string, data: string | Buffer): void {
  // Keep the sibling name independent of the destination, which may already fill NAME_MAX.
  const tmp = join(dirname(path), `.cotal-create.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  // Exclusive, so EEXIST here means the temp name belongs to ANOTHER creator. Cleanup below must
  // never run in that case: unlinking it would delete a live creator's bytes out from under it.
  writeSecretFileCreateOnlyRaw(tmp, data);
  try {
    try {
      publishLink(tmp, path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOTSUP" || code === "EPERM" || code === "ENOSYS") {
        const err: NodeJS.ErrnoException = new Error(
          `atomic-publish-unsupported: filesystem at '${path}' cannot publish a file atomically (${code})`,
        );
        err.code = code;
        throw err;
      }
      throw e;
    }
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore: surface the original exclusive-create error */
    }
    throw e;
  }
  try {
    unlinkSync(tmp);
  } catch {
    /* drop the extra nlink after a successful link, or a leftover temp */
  }
}

/** Create a private directory chain (recursive) and harden it — call BEFORE writing secrets into it
 *  so a child file is born under a private ACL (no creation-race window). POSIX sets 0o700 at create;
 *  win32 hardens the leaf's ACL (children then inherit it). Idempotent. */
export function mkSecretDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  hardenPrivate(path, "dir");
}
