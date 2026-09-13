/**
 * Private-secret filesystem smoke (no NATS, no test runner) — run with: pnpm smoke:secret-fs
 *
 * Guards the WS5 secrets-at-rest seam a POSIX-only build breaks on Windows: `0o600`/`0o700` are a
 * no-op there, so secrets must be locked down via an NTFS ACL instead. POSIX checks run EVERYWHERE
 * (the local regression guard — mode bits after write/harden). The win32 `icacls` readback (the real
 * point — broad inherited access is actually stripped) is win32-only; Windows CI is the oracle.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenPrivate, mkSecretDir, writeSecretFile, writeSecretFileCreateOnly } from "../src/secret-fs.js";

const isWin = process.platform === "win32";
let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

const dir = mkdtempSync(join(tmpdir(), "cotal-secret-"));

// writeSecretFile creates the file with the secret content.
const file = join(dir, "creds.secret");
writeSecretFile(file, "super-secret-token\n");
check("writeSecretFile wrote the file", statSync(file).isFile());

const exclusive = join(dir, "exclusive.secret");
writeSecretFileCreateOnly(exclusive, "first-writer\n");
check("writeSecretFileCreateOnly ACCEPTS a missing path", statSync(exclusive).isFile());
let exclusiveCode: string | undefined;
try {
  writeSecretFileCreateOnly(exclusive, "second-writer\n");
} catch (e) {
  exclusiveCode = (e as NodeJS.ErrnoException).code;
}
check("writeSecretFileCreateOnly REFUSES an existing file (EEXIST), never overwrites", exclusiveCode === "EEXIST");
check("...and the first writer's bytes are unchanged", readFileSync(exclusive, "utf8") === "first-writer\n");

// The TEMP write is exclusive too. A temp-name collision that plain-overwrote would let the caller
// whose link succeeded return the candidate IT minted while the file held the OTHER one's bytes —
// the identity split, one step earlier. Drive the collision directly on a temp-shaped name.
const tmpShaped = join(dir, `collide.secret.${process.pid}.0.zzz.tmp`);
writeSecretFileCreateOnly(tmpShaped, "creator-A\n");
let tmpCollisionCode: string | undefined;
try {
  writeSecretFileCreateOnly(tmpShaped, "creator-B\n");
} catch (e) {
  tmpCollisionCode = (e as NodeJS.ErrnoException).code;
}
check("REFUSE: a colliding temp-shaped name is EEXIST, not a silent overwrite", tmpCollisionCode === "EEXIST");
check("...and the colliding creator did NOT swap the first creator's bytes",
  readFileSync(tmpShaped, "utf8") === "creator-A\n");

// A loser must never destroy a live creator's temp. Publishing into an already-taken destination
// fails, and the pre-existing temp-shaped sibling must survive that failure untouched.
const takenDest = join(dir, "taken.secret");
writeSecretFileCreateOnly(takenDest, "incumbent\n");
let secondPublish: string | undefined;
try {
  writeSecretFileCreateOnly(takenDest, "challenger\n");
} catch (e) {
  secondPublish = (e as NodeJS.ErrnoException).code;
}
check("REFUSE: publishing into a taken destination is EEXIST", secondPublish === "EEXIST");
check("...and a failed create leaves no .tmp litter behind",
  readdirSync(dir).filter((n) => n.endsWith(".tmp") && n.startsWith("taken.secret")).length === 0);
check("...and the incumbent's bytes are intact", readFileSync(takenDest, "utf8") === "incumbent\n");

// mkSecretDir creates a private dir.
const sub = join(dir, "auth");
mkSecretDir(sub);
check("mkSecretDir created the dir", statSync(sub).isDirectory());

if (!isWin) {
  // POSIX: the mode bits are the security boundary — assert them exactly.
  check("file is 0600 (owner rw, no group/other)", (statSync(file).mode & 0o777) === 0o600);
  check("dir is 0700 (owner rwx, no group/other)", (statSync(sub).mode & 0o777) === 0o700);
  // hardenPrivate re-asserts on an existing path (idempotent).
  hardenPrivate(file, "file");
  check("hardenPrivate keeps the file 0600", (statSync(file).mode & 0o777) === 0o600);
  console.log("· icacls ACL stripping is win32-only — skipped (CI is the oracle)");
} else {
  // win32: the Unix mode is a no-op — the NTFS ACL is the boundary. Read it back with icacls and
  // assert the broad inherited principals are GONE and only owner + SYSTEM + Administrators remain.
  const acl = (p: string): string => execFileSync("icacls", [p], { encoding: "utf8" });
  // The current account name (icacls shows resolved NAMES, not SIDs) — its ACE must survive so we
  // never lock ourselves out of our own secret.
  const user = execFileSync("whoami", { encoding: "utf8" }).trim(); // e.g. machine\user
  const broadGone = (out: string): boolean =>
    !/\bEveryone\b/i.test(out) &&
    !/\bAuthenticated Users\b/i.test(out) &&
    !/\\Users:/i.test(out); // BUILTIN\Users
  const hasSafe = (out: string): boolean =>
    /\\SYSTEM:/i.test(out) && /\\Administrators:/i.test(out) && out.toLowerCase().includes(user.toLowerCase());

  const fileAcl = acl(file);
  check("file ACL strips Everyone / Authenticated Users / Users", broadGone(fileAcl));
  check("file ACL grants owner SID + SYSTEM + Administrators", hasSafe(fileAcl));
  check("file ACL dropped inheritance (no inherited ACEs)", !/\(I\)/.test(fileAcl));

  const dirAcl = acl(sub);
  check("dir ACL strips Everyone / Authenticated Users / Users", broadGone(dirAcl));
  check("dir ACL grants owner SID + SYSTEM + Administrators", hasSafe(dirAcl));
}

rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
