/**
 * Private-secret filesystem smoke (no NATS, no test runner) — run with: pnpm smoke:secret-fs
 *
 * Guards the WS5 secrets-at-rest seam a POSIX-only build breaks on Windows: `0o600`/`0o700` are a
 * no-op there, so secrets must be locked down via an NTFS ACL instead. POSIX checks run EVERYWHERE
 * (the local regression guard — mode bits after write/harden). The win32 `icacls` readback (the real
 * point — broad inherited access is actually stripped) is win32-only; Windows CI is the oracle.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { __setPublishLinkForTest, hardenPrivate, mkSecretDir, writeSecretFile, writeSecretFileCreateOnly } from "../src/secret-fs.js";

const isWin = process.platform === "win32";
const statSafe = (p: string): boolean => { try { return statSync(p).isFile(); } catch { return false; } };
// Read for an ASSERTION, never for control flow. A broken implementation can delete or never
// create the file a cell is about to inspect, and a raw readFileSync would then throw and abort
// the whole suite, every later cell silently unreported, which reads as a WRONG-RED rather than
// as the kill it actually is. A missing file simply is not the expected bytes.
const readSafe = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return "\u0000ABSENT"; } };
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
check("...and the first writer's bytes are unchanged", readSafe(exclusive) === "first-writer\n");

// The TEMP write is exclusive too. A temp-name collision that plain-overwrote would destroy the
// other creator's bytes, and the caller whose link then succeeded would return the candidate IT
// minted while the file held the OTHER identity: the split, one step earlier.
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
  readSafe(squattedTmp) === "other-creator\n");
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
check("...and the incumbent's bytes are intact", readSafe(takenDest) === "incumbent\n");

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
  // on every platform. Only the SETUP can be unavailable, since creating a symlink needs a privilege
  // on Windows, and that is reported as a named skip rather than a pass, so it can never read as a
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
    console.log("· dangling-symlink atomicity cell could not PLANT a symlink (no privilege): skipped, setup only");
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
      readSafe(fresh) === "first\n");
    let fbCode: string | undefined;
    try {
      writeSecretFileCreateOnly(fresh, "second\n");
    } catch (e) {
      fbCode = (e as NodeJS.ErrnoException).code;
    }
    check(`REFUSE: the ${code} fallback is EEXIST on an existing path, never an overwrite`,
      fbCode === "EEXIST");
    check(`...and the ${code} fallback did not replace the first writer's bytes`,
      readSafe(fresh) === "first\n");
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

// ATOMICITY, graded deterministically. Refusing an existing name is NOT the same property as
// deciding a concurrent create: a userspace `if (exists) throw; write()` refuses too, and is
// exactly the defect. The discriminator is a name that is FREE when a pre-check would look and
// TAKEN by the time the write runs. `O_EXCL` re-decides at the write and refuses; a check-then-
// write has already passed its check and overwrites the incumbent.
//
// This replaces an N-process barrier race that was measured to FAIL TOWARD GREEN: with a stall
// between the release and the write, racers arrive one at a time, each finds the name taken, and
// the round records exactly one winner with `O_EXCL` removed. A cell that passes when the code is
// correct AND (often) when it is broken launders a survived mutant into a green. This one is
// deterministic: same verdict on every machine, every run, no N and no timing.
{
  const atomicDir = join(dir, "atomic-decides");
  mkSecretDir(atomicDir);
  const contested = join(atomicDir, "contested.secret");
  // The competitor lands DURING the call, after any pre-check has seen a free name. The publish
  // seam is the seam that runs between the two, so it is where the interleave is injected; it also
  // forces the link-unavailable fallback, making the raw write the only thing deciding the
  // destination, the Windows-side primitive, and the one place a check-then-write could hide.
  __setPublishLinkForTest(() => {
    writeFileSync(contested, "incumbent\n", { mode: 0o600 }); // the competitor wins the name here
    const e: NodeJS.ErrnoException = new Error("ENOTSUP: forced fallback");
    e.code = "ENOTSUP";
    throw e;
  });
  let raced: string | undefined;
  try {
    writeSecretFileCreateOnly(contested, "latecomer\n");
  } catch (e) {
    raced = (e as NodeJS.ErrnoException).code;
  } finally {
    __setPublishLinkForTest(undefined);
  }
  // The bytes are the real assertion. An error code alone would also be satisfied by a write that
  // clobbered the incumbent and then failed for some other reason.
  check("REFUSE: a name taken AFTER the check but BEFORE the write does not get overwritten (O_EXCL decides at the write)",
    readSafe(contested) === "incumbent\n");
  check("...and the losing creator sees EEXIST", raced === "EEXIST");
  check("...and that loss left no .tmp litter",
    readdirSync(atomicDir).filter((n) => n.endsWith(".tmp")).length === 0);
}

// The SAME interleave, aimed at the TEMP write rather than the destination. The destination cell
// above rides the fallback seam; this one proves the property holds on the primary path too, where
// the temp inode is built before `link` publishes it. One refusing case per accepting branch: the
// two branches write through the same raw helper but reach it by different routes.
{
  const tempRaceDir = join(dir, "atomic-temp");
  mkSecretDir(tempRaceDir);
  const dest = join(tempRaceDir, "primary.secret");
  // Pin the clock and the RNG so the internal temp name is computable, then squat it between the
  // moment a pre-check would look and the moment the write runs. The destination stays FREE, so
  // only the temp write can refuse.
  const realNow = Date.now;
  const realRandom = Math.random;
  Date.now = () => 1700000000000;
  Math.random = () => 0.5;
  const tmpName = `${dest}.${process.pid}.1700000000000.${(0.5).toString(36).slice(2)}.tmp`;
  writeFileSync(tmpName, "squatter\n", { mode: 0o600 });
  let tempRaced: string | undefined;
  try {
    writeSecretFileCreateOnly(dest, "latecomer\n");
  } catch (e) {
    tempRaced = (e as NodeJS.ErrnoException).code;
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
  check("REFUSE: a temp name taken before the write is not overwritten (the temp write is exclusive too)",
    readSafe(tmpName) === "squatter\n");
  check("...and the creator that lost the temp name sees EEXIST", tempRaced === "EEXIST");
  check("...and nothing was published at the destination on that refusal", !statSafe(dest));
}

// THE REFUSING CHECK-THEN-WRITE, graded deterministically. This is the mutant no in-process cell
// can catch: `if (exists) throw; write()` raises EEXIST for a caller that arrives second, exactly
// as `O_EXCL` does. They differ only for a creator that is ALREADY PAST the check when the name is
// taken. `O_EXCL` re-decides at the write and refuses; the check-then-write has nothing left to
// check and overwrites the incumbent.
//
// An earlier version of this cell raced N processes and hoped to land in that window. Measured, it
// let this mutant escape roughly one run in six while staying green 12/12 when the implementation
// was correct: a one-sided failure toward green, which is the direction that ships a live defect.
// Here the competitor is placed IN the window by an `fs` preload instead of being hoped for, so
// the verdict is the same on every machine, every run, with no N and no scheduler.
{
  const interleaveDir = join(dir, "interleave");
  mkSecretDir(interleaveDir);
  const target = join(interleaveDir, "contested.secret");
  const preload = fileURLToPath(new URL("./_secret-fs-interleave-preload.cjs", import.meta.url));
  const child = fileURLToPath(new URL("./_secret-fs-interleave-child.mjs", import.meta.url));
  // The BUILT module, because the preload patches the `fs` binding the shipped package closes over.
  // The BUILT module, because tsx re-execs into a child process and the `--require` preload does
  // not survive that, while plain node running the compiled `.js` keeps it. That makes the cell
  // dependent on `dist` being current, so staleness is checked rather than assumed: a stale build
  // would grade the PREVIOUS implementation and pass while the current one is broken, which is the
  // vacuous green this suite exists to make impossible.
  const distPath = fileURLToPath(new URL("../dist/secret-fs.js", import.meta.url));
  const srcPath = fileURLToPath(new URL("../src/secret-fs.ts", import.meta.url));
  const distFresh = statSafe(distPath) &&
    statSync(distPath).mtimeMs >= statSync(srcPath).mtimeMs;
  check("the built module is current with its source (else this cell would grade stale code)",
    distFresh);
  const dist = pathToFileURL(distPath).href;
  // Whatever runs a suite may be a managed agent session, so a raw env spread would hand the child
  // a live credential and broker URL. Strip every COTAL_ key, then add only what it needs.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) if (k.startsWith("COTAL_")) delete childEnv[k];
  const run = spawnSync(process.execPath, ["--require", preload, child], {
    env: {
      ...childEnv,
      COTAL_SECRETFS_INTERLEAVE_TARGET: target,
      COTAL_SECRETFS_INTERLEAVE_DIST: dist,
    },
    encoding: "utf8",
  });
  // A child that never ran would print nothing, and "no clobber observed" would then be true for
  // the wrong reason. Parse explicitly and treat an unparseable result as a failure.
  let observed: { code?: string; bytes?: string } | undefined;
  try {
    observed = JSON.parse(run.stdout.trim()) as { code?: string; bytes?: string };
  } catch {
    observed = undefined;
  }
  check("REFUSE: a name taken while the creator is past its check is still not overwritten (O_EXCL re-decides at the write)",
    observed?.bytes === "incumbent\n");
  check("...and that creator sees EEXIST rather than believing it created the name",
    observed?.code === "EEXIST");
  // The positive control: the interleave has to have actually happened, or the cell above is vacuous.
  check("...and the interleaved child ran and reported (the window was really entered)",
    run.status === 0 && observed !== undefined);
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
