/**
 * Private-secret filesystem smoke (no NATS, no test runner) — run with: pnpm smoke:secret-fs
 *
 * Guards the WS5 secrets-at-rest seam a POSIX-only build breaks on Windows: `0o600`/`0o700` are a
 * no-op there, so secrets must be locked down via an NTFS ACL instead. POSIX checks run EVERYWHERE
 * (the local regression guard — mode bits after write/harden). The win32 `icacls` readback (the real
 * point — broad inherited access is actually stripped) is win32-only; Windows CI is the oracle.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { __setPublishLinkForTest, hardenPrivate, mkSecretDir, writeSecretFile, writeSecretFileCreateOnly } from "../src/secret-fs.js";

// THE RACE ITSELF, which no single-process cell can reach. `lstatSync` refuses a name that is
// already there, but on its own that is a CHECK followed by a WRITE: two creators that both pass
// the check would both write, and both would believe they created the name. Only `O_EXCL` makes
// the decision one syscall, and only concurrency can tell the two apart.
//
// N real processes are released on a barrier against one fresh path. Exactly one may succeed.
if (process.env.COTAL_SECRETFS_RACE_WORKER === "1") {
  const target = process.env.COTAL_SECRETFS_RACE_PATH!;
  const barrier = process.env.COTAL_SECRETFS_RACE_BARRIER!;
  // The DESTINATION is normally published by `link`, which is atomic on its own, so a race there
  // cannot say anything about the raw write. Force the link-unavailable path: the raw write is
  // then the only thing deciding the destination, which is exactly the Windows-side primitive.
  __setPublishLinkForTest(() => {
    const e: NodeJS.ErrnoException = new Error("ENOTSUP: forced fallback");
    e.code = "ENOTSUP";
    throw e;
  });
  const there = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };
  while (!there(barrier)) { /* spin to the barrier: the tightest release available */ }
  try {
    writeSecretFileCreateOnly(target, `${process.pid}\n`);
    process.stdout.write("WON\n");
  } catch {
    process.stdout.write("LOST\n");
  }
  process.exit(0);
}
const isWin = process.platform === "win32";
// Racers re-enter THIS file, so they need the same loader running it. Do NOT spawn
// `node_modules/.bin/tsx`: on Windows that is an extensionless shell shim and spawns ENOENT, and
// the `.CMD` beside it needs a shell. The package's own CLI entry is a plain .mjs that `node` can
// run directly on every platform, which is what the tsx bin resolves to anyway.
const TSX_CLI = join(
  fileURLToPath(new URL("../../../", import.meta.url)),
  "node_modules",
  "tsx",
  "dist",
  "cli.mjs",
);
const statSafe = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };
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

// The TEMP write is exclusive too. A temp-name collision that plain-overwrote would destroy the
// other creator's bytes, and the caller whose link then succeeded would return the candidate IT
// minted while the file held the OTHER identity — the split, one step earlier.
//
// The temp name is internal (pid + clock + Math.random), so pin the clock and the RNG, compute the
// exact name this call will choose, and squat it with another creator's bytes. The destination is
// FRESH, so the publish would succeed: the only thing under test is the temp write itself.
const squatDest = join(dir, "squat.secret");
const realRandom = Math.random;
const realNow = Date.now;
Math.random = () => 0.5;
Date.now = () => 1;
const squattedTmp = `${squatDest}.${process.pid}.1.${(0.5).toString(36).slice(2)}.tmp`;
writeSecretFile(squattedTmp, "other-creator\n");
let squatCode: string | undefined;
try {
  writeSecretFileCreateOnly(squatDest, "my-candidate\n");
} catch (e) {
  squatCode = (e as NodeJS.ErrnoException).code;
} finally {
  Math.random = realRandom;
  Date.now = realNow;
}
check("REFUSE: a temp name already held by another creator is EEXIST, not a silent overwrite",
  squatCode === "EEXIST");
check("...and that other creator's bytes were NOT destroyed",
  readFileSync(squattedTmp, "utf8") === "other-creator\n");
check("...and nothing was published at the destination on that refusal", !statSafe(squatDest));

// A loser must never destroy a live creator's temp. Publishing into an already-taken destination
// fails, and leaves no litter of its own behind.
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

// REFUSING an existing file is NOT the same property as being ATOMIC about it. A userspace
// check-then-write (`if (existsSync) throw; writeFileSync(...)`) passes every cell above: it
// refuses a file that is already there. It is still the defect, because the check and the write
// are two syscalls and a creator arriving between them is overwritten.
//
// Discriminate the two WITHOUT monkeypatching, using a property only the kernel has. A dangling
// symlink is a name that EXISTS while a follow-the-link presence check reports absent. `O_EXCL`
// refuses it (the kernel checks the name and does not follow a final symlink); a userspace check
// is told "absent", writes THROUGH the link, and creates the target.
//
// It has to be the TEMP name, not the destination: the destination is also guarded by `linkSync`,
// which refuses a dangling link on its own, so a destination cell would pass even with the raw
// write broken. On the temp path the raw write is the only guard, so this cell is the one that
// actually grades it.
const tmpVictim = join(dir, "tmp-symlink-victim");
const danglingDest = join(dir, "dangling.secret");
{
  // No platform gate on the ASSERTION: `lstatSync` makes the refusal portable, so EEXIST must hold
  // on every platform. Only the SETUP can be unavailable — creating a symlink needs a privilege on
  // Windows — and that is reported as a named skip rather than a pass, so it can never read as a
  // green that proves something it did not test.
  let linkPlanted = true;
  const realRandom2 = Math.random;
  const realNow2 = Date.now;
  Math.random = () => 0.5;
  Date.now = () => 1;
  const danglingTmp = `${danglingDest}.${process.pid}.1.${(0.5).toString(36).slice(2)}.tmp`;
  try {
    symlinkSync(tmpVictim, danglingTmp);
  } catch {
    linkPlanted = false;
  }
  let danglingCode: string | undefined;
  if (linkPlanted) {
    try {
      writeSecretFileCreateOnly(danglingDest, "attacker\n");
    } catch (e) {
      danglingCode = (e as NodeJS.ErrnoException).code;
    }
  }
  Math.random = realRandom2;
  Date.now = realNow2;
  if (linkPlanted) {
    check("REFUSE: a temp name that exists but resolves to nothing is EEXIST (kernel-atomic, not check-then-write)",
      danglingCode === "EEXIST");
    check("...and nothing was written through the dangling link", !statSafe(tmpVictim));
  } else {
    console.log("· dangling-symlink atomicity cell could not PLANT a symlink (no privilege) — skipped, setup only");
  }
}

// THE FALLBACK BRANCH, raised in review as the last accepting branch with no refusing case.
// When `link` is unavailable (ENOTSUP/EPERM/ENOSYS on some Windows volumes and network mounts)
// the helper writes O_EXCL directly to the destination. No POSIX CI host reaches that branch
// naturally, so it is driven through the named platform seam. It is the WINDOWS primitive: if it
// is not exclusive, every guarantee above is POSIX-only.
for (const code of ["ENOTSUP", "EPERM", "ENOSYS"] as const) {
  const fbDir = join(dir, `fallback-${code}`);
  mkSecretDir(fbDir);
  __setPublishLinkForTest(() => {
    const e: NodeJS.ErrnoException = new Error(`${code}: link unavailable`);
    e.code = code;
    throw e;
  });
  try {
    const fresh = join(fbDir, "fresh.secret");
    writeSecretFileCreateOnly(fresh, "first\n");
    check(`ACCEPT: the ${code} fallback still creates a missing path`,
      readFileSync(fresh, "utf8") === "first\n");
    let fbCode: string | undefined;
    try {
      writeSecretFileCreateOnly(fresh, "second\n");
    } catch (e) {
      fbCode = (e as NodeJS.ErrnoException).code;
    }
    check(`REFUSE: the ${code} fallback is EEXIST on an existing path, never an overwrite`,
      fbCode === "EEXIST");
    check(`...and the ${code} fallback did not replace the first writer's bytes`,
      readFileSync(fresh, "utf8") === "first\n");
    check(`...and the ${code} fallback left no .tmp litter`,
      readdirSync(fbDir).filter((n) => n.endsWith(".tmp")).length === 0);
  } finally {
    __setPublishLinkForTest(undefined);
  }
}

// A non-fallback link error must PROPAGATE, not silently take the fallback path. One refusing
// case per accepting branch: EACCES is not in the allowed set and must surface as itself.
const propagateDir = join(dir, "fallback-propagate");
mkSecretDir(propagateDir);
__setPublishLinkForTest(() => {
  const e: NodeJS.ErrnoException = new Error("EACCES: permission denied");
  e.code = "EACCES";
  throw e;
});
let propagated: string | undefined;
try {
  writeSecretFileCreateOnly(join(propagateDir, "nope.secret"), "x\n");
} catch (e) {
  propagated = (e as NodeJS.ErrnoException).code;
} finally {
  __setPublishLinkForTest(undefined);
}
check("REFUSE: a link error outside ENOTSUP/EPERM/ENOSYS propagates instead of falling back",
  propagated === "EACCES");
check("...and that failure left no .tmp litter",
  readdirSync(propagateDir).filter((n) => n.endsWith(".tmp")).length === 0);

{
  const RACERS = 8;
  const ROUNDS = 12;
  let multiWinner = 0;
  let silent = 0;
  let observed = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const raceDir = join(dir, `race-${r}`);
    mkSecretDir(raceDir);
    const target = join(raceDir, "contested.secret");
    const barrier = join(raceDir, "go");
    const outcomes: string[] = [];
    // Whatever runs a suite may be a managed agent session, so a raw spread would hand each racer
    // a live credential and broker URL. Strip every COTAL_ key from the copy first; the racers need
    // only their own three variables.
    const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(cleanEnv)) if (k.startsWith("COTAL_")) delete cleanEnv[k];
    await new Promise<void>((resolve, reject) => {
      let left = RACERS;
      const timer = setTimeout(() => reject(new Error("race workers did not report")), 60_000);
      for (let i = 0; i < RACERS; i++) {
        // spawnSync would serialise the racers and could never observe a conflict; these run
        // concurrently and are released together by the barrier below.
        const child = spawn(process.execPath, [TSX_CLI, process.argv[1]!], {
          env: {
            ...cleanEnv,
            COTAL_SECRETFS_RACE_WORKER: "1",
            COTAL_SECRETFS_RACE_PATH: target,
            COTAL_SECRETFS_RACE_BARRIER: barrier,
          },
          stdio: ["ignore", "pipe", "ignore"],
        });
        let buf = "";
        child.stdout.on("data", (c: Buffer) => { buf += c.toString(); });
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("exit", () => {
          outcomes.push(buf.trim());
          if (--left === 0) { clearTimeout(timer); resolve(); }
        });
      }
      // Let every child reach its spin loop before releasing them.
      setTimeout(() => writeFileSync(barrier, "go"), 300);
    });
    const winners = outcomes.filter((o) => o === "WON").length;
    const reported = outcomes.filter((o) => o === "WON" || o === "LOST").length;
    // A racer that never started prints nothing and would otherwise be counted a loser, which
    // makes "exactly one winner" true for the wrong reason. Every racer must have reported.
    if (reported !== RACERS) silent++;
    observed += reported;
    if (winners !== 1) multiWinner++;
  }
  check(`REFUSE: of ${RACERS} concurrent creators over ${ROUNDS} rounds exactly one ever creates the name`,
    multiWinner === 0 && silent === 0 && observed === RACERS * ROUNDS);
}

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
(failures ? 1 : 0);
