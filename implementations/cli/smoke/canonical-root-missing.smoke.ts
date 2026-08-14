/**
 * WHAT DOES `canonicalRoot` DO WHEN THE ROOT IS NOT ON DISK?
 *
 * `canonicalRoot` (`packages/workspace/src/mesh-registry.ts`) is about to be put on a RESOLUTION
 * path (`mesh-target.ts:355`, `:372`), where it runs against registry records that may name roots
 * since deleted, renamed, or unmounted. Before that happens the question has to be MEASURED, not
 * read off the doc comment: if it throws, or returns something surprising, the fix would convert a
 * silent mis-resolution into a CRASH on a path that previously worked — strictly worse than the
 * defect being fixed.
 *
 * The comment at `mesh-registry.ts` claims it "Falls back to `resolve` for a root that no longer
 * exists on disk". A comment is a claim, not a measurement. This suite is the measurement, and it
 * is deliberately committed BEFORE the fix so the answer stands on its own either way it came out.
 *
 * It also measures the case the comment does NOT mention, which is the one that can actually bite:
 * `canonicalRoot` is not a total function into one namespace. When one side of a comparison
 * resolves and the other falls back, two spellings of the SAME directory can compare UNEQUAL — and
 * that asymmetry is what a resolution path would feel.
 *
 * Imports come from the package SOURCE by relative path, not by package name. That is deliberate:
 * a `@cotal-ai/workspace` import resolves to `dist/`, so a mutation of `src` would be reported as
 * SURVIVED by a suite that never loaded it. `smoke:dist-freshness` is what covers src/dist drift.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalRoot } from "../../../packages/workspace/src/mesh-registry.js";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: unknown = "") =>
  results.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });

const LIVE_BROKER = "nats://broker.cotal.ai:4222";
/** This suite starts no broker and records no server. The assertion is kept as the FIRST action
 *  anyway, because "this one doesn't dial anything" is exactly the reasoning that puts a suite on
 *  the live host. */
const EPHEMERAL_SERVER = "nats://127.0.0.1:14623";

/** Did the call THROW? The whole point of the measurement — a throw here is a crash on a
 *  resolution path. Returns the thrown error rather than letting it escape. */
function callCanonicalRoot(p: string): { threw: false; value: string } | { threw: true; error: string } {
  try {
    return { threw: false, value: canonicalRoot(p) };
  } catch (e) {
    return { threw: true, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

const scratch: string[] = [];

async function main(): Promise<void> {
  check("FIRST ACTION: this suite's recorded broker URL is NOT the live host",
    EPHEMERAL_SERVER !== LIVE_BROKER, EPHEMERAL_SERVER);

  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "cotal-canonroot-")));
  scratch.push(tmp);

  // ---- POSITIVE CONTROL: it canonicalizes a root that IS on disk -------------------------------
  // Without this, every "did not throw" below could be a function that does nothing at all. The
  // control must show canonicalRoot CHANGING a path, not merely returning one.
  const physical = join(tmp, "project");
  mkdirSync(join(physical, ".cotal"), { recursive: true }); // `.cotal` anchor first, as everywhere
  const alias = join(tmp, "alias-to-project");
  symlinkSync(physical, alias, "dir");
  const aliasOut = callCanonicalRoot(alias);
  check("POSITIVE CONTROL: an EXISTING symlinked root canonicalizes to its physical path",
    aliasOut.threw === false && aliasOut.value === physical,
    aliasOut.threw ? aliasOut.error : aliasOut.value);
  check("POSITIVE CONTROL: it is not a no-op — the input and output differ",
    aliasOut.threw === false && aliasOut.value !== alias,
    aliasOut.threw ? aliasOut.error : `${alias} -> ${aliasOut.value}`);

  // ---- THE MEASUREMENT: a root that is NOT on disk ---------------------------------------------
  // Case 1: a plain absolute path that simply is not there (a deleted project).
  const gone = join(tmp, "deleted-project");
  const goneOut = callCanonicalRoot(gone);
  check("MEASURED: a MISSING absolute root does NOT throw", goneOut.threw === false,
    goneOut.threw ? goneOut.error : goneOut.value);
  check("MEASURED: a MISSING absolute root returns `resolve()` of the input, unchanged",
    goneOut.threw === false && goneOut.value === resolve(gone),
    goneOut.threw ? goneOut.error : `${goneOut.value} vs resolve=${resolve(gone)}`);

  // Case 2: the path's PARENT is missing too — realpath fails further up the chain.
  const goneDeep = join(tmp, "no-such-parent", "no-such-child");
  const goneDeepOut = callCanonicalRoot(goneDeep);
  check("MEASURED: a missing root under a MISSING PARENT does not throw either",
    goneDeepOut.threw === false, goneDeepOut.threw ? goneDeepOut.error : goneDeepOut.value);
  check("MEASURED: ... and also returns `resolve()` of the input",
    goneDeepOut.threw === false && goneDeepOut.value === resolve(goneDeep),
    goneDeepOut.threw ? goneDeepOut.error : goneDeepOut.value);

  // Case 3: a DANGLING symlink — the record's root exists as a link, but its target does not.
  // realpath refuses to resolve it (ENOENT on the target), so this takes the fallback.
  const dangling = join(tmp, "dangling");
  symlinkSync(join(tmp, "never-existed"), dangling, "dir");
  const danglingOut = callCanonicalRoot(dangling);
  check("MEASURED: a DANGLING symlink root does not throw",
    danglingOut.threw === false, danglingOut.threw ? danglingOut.error : danglingOut.value);
  check("MEASURED: a DANGLING symlink returns the LINK's own path, NOT its target",
    danglingOut.threw === false && danglingOut.value === resolve(dangling),
    danglingOut.threw ? danglingOut.error : danglingOut.value);

  // Case 4: a non-normalized spelling of a missing root — the fallback must still normalize,
  // or the fix would be strictly WORSE than the `resolve()` it replaces at `mesh-target.ts:355`.
  const messy = join(tmp, "deleted-project", "..", "deleted-project", ".");
  const messyOut = callCanonicalRoot(messy);
  check("MEASURED: the fallback still NORMALIZES — `..`/`.` segments of a missing root collapse",
    messyOut.threw === false && messyOut.value === resolve(gone),
    messyOut.threw ? messyOut.error : `${messyOut.value} vs ${resolve(gone)}`);

  // Case 5: an UNREADABLE parent (EACCES, not ENOENT). The root EXISTS here — only the lookup is
  // refused — so this is the case where a real directory takes the fallback path.
  const locked = join(tmp, "locked");
  const hidden = join(locked, "project");
  mkdirSync(hidden, { recursive: true });
  chmodSync(locked, 0o000);
  const lockedOut = callCanonicalRoot(hidden);
  const lockedDenied = lockedOut.threw === false && lockedOut.value === resolve(hidden);
  const lockedResolved = lockedOut.threw === false && lockedOut.value === realpathSyncOrEmpty(hidden);
  check("MEASURED: an UNREADABLE (EACCES) parent does not throw",
    lockedOut.threw === false, lockedOut.threw ? lockedOut.error : lockedOut.value);
  check("MEASURED: EACCES either falls back or resolves — but never throws, and is recorded here",
    lockedDenied || lockedResolved, lockedOut.threw ? lockedOut.error
      : `${lockedOut.value} (fallback=${lockedDenied}, resolved=${lockedResolved})`);
  chmodSync(locked, 0o700); // restore before cleanup, or rmSync cannot descend

  // ---- THE ASYMMETRY, which is what a RESOLUTION PATH actually feels ---------------------------
  // The doc comment stops at "falls back". The consequence it does not state: when one side of a
  // comparison resolves and the other falls back, the SAME directory can compare UNEQUAL. Here the
  // live root exists (it must — `mesh-target.ts:343` gates on `isGenuineSpace(root)`), and the
  // RECORD's root is a dangling symlink to it. Both name one directory in the operator's head.
  const liveRoot = physical;
  const recordRoot = join(tmp, "record-link"); // a symlink the operator typed, target since removed
  const doomed = join(tmp, "will-be-removed");
  mkdirSync(doomed);
  symlinkSync(doomed, recordRoot, "dir");
  const bothPresent = canonicalRoot(recordRoot) === canonicalRoot(doomed);
  check("ASYMMETRY CONTROL: while BOTH sides exist, the link and its target compare EQUAL",
    bothPresent === true, `equal=${bothPresent}`);
  rmSync(doomed, { recursive: true, force: true }); // the target goes away; the record does not
  const afterRemoval = canonicalRoot(recordRoot) === canonicalRoot(doomed);
  check("ASYMMETRY MEASURED: once the target is gone, the SAME pair compares UNEQUAL",
    afterRemoval === false,
    `equal=${afterRemoval} — ${canonicalRoot(recordRoot)} vs ${canonicalRoot(doomed)}`);
  // What this means for the two sites, stated so no reader has to infer it:
  //   `:355` — a false MISS. The record is skipped, the project reads as unrecorded, and resolution
  //            falls through to `localTarget(root, DEFAULT_SERVER)` at `:380`. SILENT.
  //   `:372` — a false "different root", so a foreign-mesh refusal (`default-occupied`) can fire
  //            for our OWN record. LOUD.
  // Both are ALSO what the outgoing `resolve()` spelling does for this input, so the fix does not
  // introduce the asymmetry — it inherits it. Asserted directly, because "no worse than before" is
  // the claim the fix rests on and it must not be left to the reader:
  const outgoingEqual = resolve(recordRoot) === resolve(doomed);
  check("NOT A REGRESSION: the OUTGOING `resolve()` spelling also compares these UNEQUAL",
    outgoingEqual === false, `resolve-equal=${outgoingEqual}`);

  // ---- `resolve`-equal does NOT imply `canonicalRoot`-equal -----------------------------------
  // Measured because TWO SEATS independently asserted the implication and rested an
  // equivalent-mutant argument on it. It is FALSE, and a third seat told not to inherit the
  // argument produced this counterexample. It is re-derived here so it survives in the tree rather
  // than in one reviewer's scratch file: a green nobody can re-derive at a named hash is not
  // evidence.
  //
  // `a/link/../file` where `a/link` is a symlink to `b/c` — pointing OUTSIDE its own parent.
  // `resolve` collapses `..` LEXICALLY, never looking at the link, and yields `<a>/file`.
  // `canonicalRoot` follows the link FIRST, so the `..` climbs out of `b/c` and yields `<b>/file`.
  //
  // BOTH TARGETS MUST EXIST for this to bite, and that is itself part of the result. `canonicalRoot`
  // only diverges from `resolve` when `realpath` SUCCEEDS; with nothing on disk both sides take the
  // fallback and agree. The first attempt at this cell created no targets, and the suite reported
  // `canonical-equal=true` — it refused a counterexample that did not reproduce, which is what a
  // cell is for.
  const outer = realpathSync(mkdtempSync(join(tmpdir(), "cotal-outlink-")));
  scratch.push(outer);
  const aDir = join(outer, "a");
  const bDir = join(outer, "b", "c");
  mkdirSync(bDir, { recursive: true });
  mkdirSync(join(aDir, "file"), { recursive: true }); // <outer>/a/file — the plain spelling's target
  mkdirSync(join(outer, "b", "file"), { recursive: true }); // <outer>/b/file — where the link route lands
  symlinkSync(bDir, join(aDir, "link")); // a/link -> b/c, i.e. OUT of a
  // Built by CONCATENATION, not `join`. `path.join` normalizes as it builds, so it collapses the
  // `..` lexically and the `link` segment never reaches `realpath` at all — the second attempt at
  // this cell used `join` and destroyed its own input, reporting `canonical-equal=true` for a pair
  // that was `<a>/file` on both sides. The raw string is the whole point of the counterexample.
  const viaLink = `${aDir}/link/../file`; // a/link/../file -> realpath <outer>/b/file
  const viaPlain = join(aDir, "file"); //    a/file         -> realpath <outer>/a/file
  const resolveAgrees = resolve(viaLink) === resolve(viaPlain);
  const canonicalAgrees = canonicalRoot(viaLink) === canonicalRoot(viaPlain);
  check("COUNTEREXAMPLE: `resolve` reads the symlink-escaping pair as the SAME path",
    resolveAgrees === true, `resolve-equal=${resolveAgrees}`);
  check("COUNTEREXAMPLE: `canonicalRoot` reads that SAME pair as DIFFERENT paths",
    canonicalAgrees === false,
    `canonical-equal=${canonicalAgrees} — ${canonicalRoot(viaLink)} vs ${canonicalRoot(viaPlain)}`);
  // Both together are the refutation: the implication holds only on the REACHABLE set, where every
  // writer has already stored `resolve()` output (`meshes-add.ts`, `findCotalRoot`) so a raw
  // `symlink/../` string is never recorded. On this pair the two spellings actively DISAGREE —
  // `canonicalRoot` calls the entry foreign, `resolve` calls it ours — which is why the second root
  // compare keeps the canonical spelling even though it is inert on everything reachable today.
  check("...so `resolve`-equal does NOT imply `canonicalRoot`-equal, and the unqualified claim is FALSE",
    resolveAgrees === true && canonicalAgrees === false,
    `resolve-equal=${resolveAgrees} canonical-equal=${canonicalAgrees}`);

  // ---- WOULD-HAVE-REFUTED, stated as a cell so it cannot be claimed after the fact -------------
  // If `canonicalRoot` had thrown on ANY missing-root case above, the fix would have been withdrawn
  // rather than landed. This cell records that the refutation condition was defined in advance and
  // did not occur; it is not independent evidence and is not counted as such.
  const anyThrew = [goneOut, goneDeepOut, danglingOut, messyOut, lockedOut].some((r) => r.threw);
  check("REFUTATION CONDITION (declared before the run): no missing-root case threw",
    anyThrew === false, `anyThrew=${anyThrew}`);
}

function realpathSyncOrEmpty(p: string): string {
  try { return realpathSync.native(p); } catch { return ""; }
}

try {
  await main();
} finally {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
