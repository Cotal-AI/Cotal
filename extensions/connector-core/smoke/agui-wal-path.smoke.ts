/**
 * `agui-wal-path.ts` — the event WAL's location, its containment, and `[P10]`'s durable chain.
 *
 * **The property under test is CONTAINMENT, and it is tested by attacking it, not by reading the
 * layout back.** A cell that only checks `walPath` ends in `wal.json` passes against an
 * implementation that interpolates a raw space name straight into the path — which is the single
 * failure this module exists to prevent. So every hostile-input cell asserts the RESOLVED path is
 * still inside the root, not merely that it looks unusual.
 *
 * **The `..` cases are the ones that matter and they are easy to test vacuously.** `join()` already
 * normalises `a/../b`, so a traversal that is *defeated by normalisation* proves nothing about
 * hashing. The control below is the point: an unhashed component with the same value DOES escape, so
 * each cell can distinguish "contained because hashed" from "contained because the string happened
 * to be harmless".
 *
 * Run: npx tsx extensions/connector-core/smoke/agui-wal-path.smoke.ts
 */
import { mkdtempSync, rmSync, statSync, symlinkSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { eventWalLocation, ensureEventWalDir } from "../src/agui-wal-path.js";

let pass = 0;
let fail = 0;
const c = (n: string, v: boolean, extra?: unknown): void => {
  if (v) {
    pass += 1;
    return;
  }
  fail += 1;
  console.error(`  x FAIL: ${n}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
};

const root = mkdtempSync(join(tmpdir(), "agui-walpath-"));
const BENIGN = { workspaceRoot: root, space: "main", principal: "owner.actor", threadId: "sess-1" };

try {
  // ── 1. SHAPE ──────────────────────────────────────────────────────────────────────────────────
  const loc = eventWalLocation(BENIGN);
  c("the WAL sits under <root>/.cotal/events", loc.walPath.startsWith(join(root, ".cotal", "events") + sep), loc.walPath);
  c("the document is named wal.json", loc.walPath.endsWith(`${sep}wal.json`), loc.walPath);
  c("the lock is a sibling of the THREAD dir, i.e. per-principal not per-thread",
    loc.lockPath === join(loc.principalDir, ".lock") && loc.threadDir.startsWith(loc.principalDir + sep),
    { lock: loc.lockPath, thread: loc.threadDir });
  c("the thread dir holds the wal", loc.walPath === join(loc.threadDir, "wal.json"));

  // NO RAW VALUE APPEARS. This is what "hashed path component" means operationally, and it is
  // asserted per component rather than on the whole string, so a single un-hashed one cannot hide
  // behind two hashed ones.
  c("the space name never appears raw in the path", !loc.walPath.includes("main"), loc.walPath);
  c("the principal never appears raw in the path", !loc.walPath.includes("owner.actor"), loc.walPath);
  c("the threadId never appears raw in the path", !loc.walPath.includes("sess-1"), loc.walPath);

  // ── 2. INJECTIVITY ────────────────────────────────────────────────────────────────────────────
  // Different threads must not share a WAL: one file per thread is the whole state machine's
  // premise, and two threads on one document would interleave two frontiers.
  const t2 = eventWalLocation({ ...BENIGN, threadId: "sess-2" });
  c("two threads of one principal get DIFFERENT wal files", loc.walPath !== t2.walPath);
  c("...but SHARE the principal lock, because the lock is per-principal", loc.lockPath === t2.lockPath);

  const p2 = eventWalLocation({ ...BENIGN, principal: "owner.other" });
  c("two principals get different directories", loc.principalDir !== p2.principalDir);
  c("two principals get different locks", loc.lockPath !== p2.lockPath);

  const s2 = eventWalLocation({ ...BENIGN, space: "other" });
  c("the SAME principal and thread in two spaces get different WALs", loc.walPath !== s2.walPath);

  // ── 3. CONTAINMENT, WITH A CONTROL THAT PROVES THE CELL CAN FAIL ──────────────────────────────
  // The control is the inverse of the predicate: the same hostile value interpolated WITHOUT
  // hashing. If the control does not escape, the paired cell proves nothing, so the control is
  // asserted to escape rather than assumed to.
  const inside = (p: string): boolean => resolve(p).startsWith(resolve(root) + sep);
  let escapedUnhashed = 0;
  const HOSTILE = [
    ["parent traversal", "../../../../etc/passwd"],
    ["absolute path", "/etc/passwd"],
    ["embedded separator", "a/b/c"],
    ["nul-ish and dots", "..%2f..%2f.."],
    ["pure dots", ".."],
    ["home expansion", "~"],
  ] as const;

  for (const [label, evil] of HOSTILE) {
    const viaSpace = eventWalLocation({ ...BENIGN, space: evil });
    const viaThread = eventWalLocation({ ...BENIGN, threadId: evil });
    const viaPrincipal = eventWalLocation({ ...BENIGN, principal: evil });
    c(`hostile ${label} as SPACE stays inside the root`, inside(viaSpace.walPath), viaSpace.walPath);
    c(`hostile ${label} as THREAD stays inside the root`, inside(viaThread.walPath), viaThread.walPath);
    c(`hostile ${label} as PRINCIPAL stays inside the root`, inside(viaPrincipal.walPath), viaPrincipal.walPath);

    // THE CONTROL: unhashed, the same value, the same join.
    //
    // Which inputs escape is MEASURED, never asserted from a hardcoded list. Writing that list by
    // hand is how a control cell becomes decoration: `join()` already contains `/etc/passwd`, `..`
    // and `~`, so only genuine multi-level traversal escapes, and a hand-written split that guessed
    // otherwise would have reported three failures about the test rather than the code.
    const naive = resolve(join(root, ".cotal", "events", evil, "wal.json"));
    const naiveEscapes = !naive.startsWith(resolve(root) + sep);
    escapedUnhashed += naiveEscapes ? 1 : 0;
    c(
      naiveEscapes
        ? `CONTROL(${label}): unhashed DOES escape, so the paired cells are not vacuous`
        : `CONTROL(${label}): unhashed is contained by join() too — these cells prove DEPTH, not containment`,
      true,
      naive,
    );
  }

  // THE AGGREGATE THAT KEEPS THE SECTION HONEST. Every per-input control above passes either way by
  // construction — it only LABELS what it measured. So the section is worth something only if at
  // least one input genuinely escapes when unhashed; without this, a rewrite that made every hostile
  // input harmless would leave a wall of green asserting nothing.
  c("at least one hostile input ESCAPES unhashed — the containment cells are non-vacuous",
    escapedUnhashed > 0, escapedUnhashed);

  // Depth: a component carrying separators must not add directory levels.
  const deep = eventWalLocation({ ...BENIGN, threadId: "a/b/c/d/e" });
  c("a separator-laden threadId adds NO extra path depth",
    deep.walPath.split(sep).length === loc.walPath.split(sep).length,
    { deep: deep.walPath, benign: loc.walPath });

  // ── 4. ensureEventWalDir — CREATION, MODE, IDEMPOTENCE ────────────────────────────────────────
  const made = await ensureEventWalDir(BENIGN);
  c("ensureEventWalDir returns the SAME location the pure function computes",
    made.walPath === loc.walPath && made.lockPath === loc.lockPath, { made: made.walPath, pure: loc.walPath });
  c("the thread directory now exists", existsSync(made.threadDir));
  c("the WAL file itself is NOT created — that is the WAL's own job", !existsSync(made.walPath));

  // 0700: the WAL is written 0600 and a world-readable parent would undo that.
  const mode = statSync(made.threadDir).mode & 0o777;
  c("the thread directory is 0700", mode === 0o700, mode.toString(8));
  const pmode = statSync(made.principalDir).mode & 0o777;
  c("the principal directory is 0700", pmode === 0o700, pmode.toString(8));

  let again: Error | undefined;
  try {
    await ensureEventWalDir(BENIGN);
  } catch (e) {
    again = e as Error;
  }
  c("calling it twice is not an error — it runs on every emitter start", again === undefined, again?.message);

  // ── 5. SYMLINK REFUSAL, ON THE CHAIN ──────────────────────────────────────────────────────────
  // A symlinked component would redirect a 0600 write outside the tree the mode bits protect.
  const evilRoot = mkdtempSync(join(tmpdir(), "agui-walpath-evil-"));
  const target = mkdtempSync(join(tmpdir(), "agui-walpath-target-"));
  mkdirSync(join(evilRoot, ".cotal"), { recursive: true, mode: 0o700 });
  symlinkSync(target, join(evilRoot, ".cotal", "events"));
  let refused: Error | undefined;
  try {
    await ensureEventWalDir({ ...BENIGN, workspaceRoot: evilRoot });
  } catch (e) {
    refused = e as Error;
  }
  c("a SYMLINKED component in the chain is REFUSED", refused !== undefined, "no throw");
  c("...and the refusal names the symlink rather than failing generically",
    /symlink/i.test(refused?.message ?? ""), refused?.message);
  // The refusal must not have written anything into the link's target first.
  c("...and nothing was created through the link", !existsSync(join(target, "wal.json")));
  rmSync(evilRoot, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`agui-wal-path smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
