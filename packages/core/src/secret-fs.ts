/**
 * Private-by-owner file/dir helpers — the one place secret material (creds, signing keys, the
 * transient MCP config) is written so it is readable ONLY by the current user.
 *
 * On POSIX `writeFileSync(…, { mode: 0o600 })` does this. On Windows the Unix mode is a NO-OP — Node
 * honors only the write bit — so a secret written that way inherits its parent's ACL and can be
 * world-readable (e.g. a `.cotal/auth` under a project on a permissive path). The fix is to harden
 * the NTFS ACL explicitly with the built-in `icacls` (no new dependency). See {@link hardenPrivate}.
 */
import { chmodSync, linkSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

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
 * POSIX: `chmod` (0o600 file / 0o700 dir) — a belt-and-braces reassert of the create-time mode.
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
    chmodSync(path, kind === "dir" ? 0o700 : 0o600);
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

/**
 * Write a private secret file: the bytes (mode 0o600 at create on POSIX), then {@link hardenPrivate}
 * for the win32 ACL. FAIL-CLOSED — if hardening throws, the hardening error propagates (the caller
 * never proceeds as if the secret were safe) and the just-written file is best-effort deleted so it
 * isn't left readable.
 */
export function writeSecretFile(path: string, data: string | Buffer): void {
  writeFileSync(path, data, { mode: 0o600 });
  if (!isWin) return; // POSIX mode set at create — nothing more to do
  try {
    hardenPrivate(path, "file");
  } catch (e) {
    try {
      unlinkSync(path); // best-effort cleanup; the hardening error below is what the caller sees
    } catch {
      /* ignore — surface the original hardening failure, not a secondary unlink error */
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
 * Same fail-closed hardening contract as {@link writeSecretFile} — a win32 ACL failure propagates
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
  // WIN32 ONLY, and deliberately so. Measured on POSIX: `O_EXCL` already refuses a plain file, a
  // directory AND a dangling symlink with EEXIST, materialising nothing, so a pre-check there
  // would add a check-then-act step that buys nothing and can only weaken the guarantee. Windows
  // is the platform where `O_EXCL` RESOLVES a reparse point and creates its target, which would
  // land bytes at a name the caller never asked for; `lstatSync` reports the link rather than its
  // target, so the name is refused before anything is written.
  //
  // This never decides a concurrent create. Two creators that both see the name free still both
  // reach `O_EXCL` below, and O_EXCL, one syscall, is what picks the winner. The check only ever
  // converts a would-be write-through into the EEXIST the caller already handles.
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
  writeFileSync(path, data, { flag: "wx", mode: 0o600 });
  if (!isWin) return; // POSIX mode set at create — nothing more to do
  try {
    hardenPrivate(path, "file");
  } catch (e) {
    try {
      unlinkSync(path); // best-effort cleanup; the hardening error below is what the caller sees
    } catch {
      /* ignore — surface the original hardening failure, not a secondary unlink error */
    }
    throw e;
  }
}

/**
 * Publish a completed temp inode at its final name. Separated from {@link writeSecretFileCreateOnly}
 * because the hard-link primitive is the one part of exclusive create whose AVAILABILITY is
 * platform-dependent: some Windows volumes and some network filesystems reject `link` outright, and
 * the caller must then fall back to `O_EXCL` on the destination. Naming that seam also makes the
 * fallback branch reachable from a suite, so the Windows-side primitive can carry a refusing case
 * instead of being the one accepting branch nothing grades.
 */
let publishLink: (from: string, to: string) => void = linkSync;

/** Test-only: drive the `link`-unavailable fallback, which no POSIX CI host can reach naturally.
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
 * When the filesystem cannot hard-link (some Windows volumes), the fallback is `wx`
 * (`O_CREAT|O_EXCL`) on `path` itself, which is still exclusive create, not a replace.
 *
 * The TEMP write is exclusive for the same reason the publish is. A temp name is unique only by
 * probability (pid plus clock plus `Math.random`), and probability is not a concurrency argument:
 * two creators that collided on the name would plain-overwrite each other's bytes, and then the
 * one whose `link` succeeded would return the candidate IT minted while the published file held
 * the OTHER one's identity — the exact split this function exists to prevent, reintroduced one
 * step earlier. `wx` on the temp makes a collision fail loudly instead of silently swapping bytes.
 */
export function writeSecretFileCreateOnly(path: string, data: string | Buffer): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  // Exclusive, so EEXIST here means the temp name belongs to ANOTHER creator. Cleanup below must
  // never run in that case: unlinking it would delete a live creator's bytes out from under it.
  writeSecretFileCreateOnlyRaw(tmp, data);
  try {
    try {
      publishLink(tmp, path);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOTSUP" || code === "EPERM" || code === "ENOSYS") {
        writeSecretFileCreateOnlyRaw(path, data);
      } else {
        throw e;
      }
    }
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore — surface the original exclusive-create error */
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
