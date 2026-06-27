/**
 * Private-by-owner file/dir helpers — the one place secret material (creds, signing keys, the
 * transient MCP config) is written so it is readable ONLY by the current user.
 *
 * On POSIX `writeFileSync(…, { mode: 0o600 })` does this. On Windows the Unix mode is a NO-OP — Node
 * honors only the write bit — so a secret written that way inherits its parent's ACL and can be
 * world-readable (e.g. a `.cotal/auth` under a project on a permissive path). The fix is to harden
 * the NTFS ACL explicitly with the built-in `icacls` (no new dependency). See {@link hardenPrivate}.
 */
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const isWin = process.platform === "win32";

/** The current user's SID, for an `icacls` grant — parsed from `whoami /user /fo csv /nh`
 *  (`"machine\user","S-1-5-…"`). Cached: it never changes within a process. win32-only. */
let cachedSid: string | undefined;
function ownerSid(): string {
  if (cachedSid) return cachedSid;
  const out = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
  const sid = out.trim().split(",").pop()?.replace(/^"|"$/g, "").trim();
  if (!sid || !/^S-1-/.test(sid))
    throw new Error(`could not determine the current user's SID from \`whoami\` (got: ${out.trim()})`);
  cachedSid = sid;
  return sid;
}

/**
 * Lock a file or directory down to the current user (+ SYSTEM + Administrators) only.
 *
 * POSIX: `chmod` (0o600 file / 0o700 dir) — a belt-and-braces reassert of the create-time mode.
 * win32: harden the NTFS ACL with `icacls` — `/inheritance:r` drops every inherited (broad) ACE and
 * `/grant:r` REPLACES the ACL with grants for ONLY the owner SID (`whoami /user`), SYSTEM
 * (`S-1-5-18`), and Administrators (`S-1-5-32-544`). Removing broad grants this way — rather than
 * adding deny ACEs, which can catch the owner through group membership — is the documented-safe
 * pattern. Numeric SIDs are `*`-prefixed; invoked shell-free (arg arrays). A directory grants
 * `(OI)(CI)` so children inherit the private ACE. FAIL-CLOSED: any `whoami`/`icacls` failure throws.
 */
export function hardenPrivate(path: string, kind: "file" | "dir"): void {
  if (!isWin) {
    chmodSync(path, kind === "dir" ? 0o700 : 0o600);
    return;
  }
  const perm = kind === "dir" ? "(OI)(CI)(F)" : "(F)";
  const grant = (sid: string): string[] => ["/grant:r", `*${sid}:${perm}`];
  try {
    execFileSync(
      "icacls",
      [path, "/inheritance:r", ...grant(ownerSid()), ...grant("S-1-5-18"), ...grant("S-1-5-32-544")],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (e) {
    throw new Error(
      `failed to harden ${kind} "${path}" to private via icacls: ${(e as Error).message.trim()}. ` +
        `Cotal will not leave a secret with a permissive ACL — ensure \`icacls\`/\`whoami\` are on PATH and the path is on an NTFS volume.`,
    );
  }
}

/**
 * Write a private secret file: the bytes (mode 0o600 at create on POSIX), then {@link hardenPrivate}
 * for the win32 ACL. FAIL-CLOSED — if hardening throws, the hardening error propagates (the caller
 * never proceeds as if the secret were safe) and the just-written file is best-effort deleted so it
 * isn't left readable. `flag` (e.g. `"wx"` for exclusive create) is honored.
 */
export function writeSecretFile(path: string, data: string | Buffer, opts: { flag?: string } = {}): void {
  writeFileSync(path, data, opts.flag ? { mode: 0o600, flag: opts.flag } : { mode: 0o600 });
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

/** Create a private directory chain (recursive) and harden it — call BEFORE writing secrets into it
 *  so a child file is born under a private ACL (no creation-race window). POSIX sets 0o700 at create;
 *  win32 hardens the leaf's ACL (children then inherit it). Idempotent. */
export function mkSecretDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  hardenPrivate(path, "dir");
}
