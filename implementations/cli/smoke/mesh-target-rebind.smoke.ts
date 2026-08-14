/**
 * TARGET RESOLUTION REBINDS TO THE RECORDED MESH, NOT TO THE DEFAULT
 *
 * `resolveMeshTarget` answers "which mesh does this command act on". For a local project it looks
 * up the registry entry recorded for THIS root and honours its `server` and `mode`. That lookup
 * (`packages/workspace/src/mesh-target.ts:355`) compared roots with `resolve()`, which normalizes
 * separators and `..`/`.` but does NOT collapse a symlink — so a project recorded under one
 * spelling of its directory and running under another read as UNRECORDED. The consequences are the
 * two arms this suite drives:
 *
 *   ARM A (SILENT) — the recorded server and mode are discarded and the target is retargeted to
 *     `DEFAULT_SERVER` (`:380`). Nothing warns. A project started on `…:4333` resolves to `…:4222`,
 *     and a recorded OPEN mesh mints creds off stale `.cotal/auth`.
 *   ARM B (LOUD) — when the record IS at the default port, the companion test at `:372` reads our
 *     own record as a foreign root and refuses with `default-occupied`: the project is told its own
 *     mesh belongs to someone else.
 *
 * This is a STATE claim, so it is asserted as one: the binding is read BEFORE (what the registry
 * holds) and AFTER (what `resolveMeshTarget` returns), and the post-state is produced by calling
 * the REAL entry point — not by re-implementing its comparison. A suite that hand-builds both
 * sides of a comparison and asserts the comparison proves only the precondition.
 *
 * Isolation: `COTAL_HOME` redirects the registry to a scratch dir, and the machine's real registry
 * is asserted untouched. No broker is started and no live host is contacted.
 *
 * Imports are by relative SOURCE path, not package name: a `@cotal-ai/*` import resolves to
 * `dist/`, so a mutation of `src` would be reported SURVIVED by a suite that never loaded it.
 *
 * ---------------------------------------------------------------------------------------------
 * MUTATION PROOF — PREDICTED CELLS, REGISTERED HERE BEFORE THE MUTANTS WERE APPLIED
 *
 * A prediction written after the run is a description. These are named cells, not a count, and
 * each mutant is argued NON-EQUIVALENT (or, for M2, argued EQUIVALENT) before it is run.
 * Every run rebuilds (`tsc -p packages/core` then `tsc -p packages/workspace`) so that a stale
 * `dist/` cannot mask or fake a result, even though this suite reaches the target through `src`.
 *
 * M1 — the match predicate at `mesh-target.ts` reverted to the pre-fix spelling:
 *        `canonicalRoot(m.root) === canonicalRoot(root)`  ->  `resolve(m.root) === resolve(root)`
 *      NON-EQUIVALENT because the fixture's recorded root is a symlink spelling of the live root:
 *      `resolve` keeps the two apart, `canonicalRoot` collapses them.
 *      PREDICTED RED (exactly these six):
 *        - ARM A POST: resolution BINDS TO THE RECORD, not to the default port
 *        - ARM A POST: the target's source is `local-recorded`, so the record is what answered
 *        - ARM A POST: the RECORDED space is carried, not the default space
 *        - ARM A POST: the record's `origin` rides along, so pruning knows who owns it
 *        - ARM A POST: resolution did NOT silently retarget to DEFAULT_SERVER
 *        - ARM B POST: it binds to our own record at the default port
 *      PREDICTED GREEN, and named because it is the discriminating one:
 *        - ARM B POST: resolution does NOT refuse our own mesh as a foreign one. It stays green
 *          under M1: `onDefault` still compares with `canonicalRoot`, which excludes our own
 *          record from the "foreign mesh" search. ARM B's LOUD refusal needs BOTH sites spelled
 *          the old way, which is how the tree stood before this branch.
 *        - both NEGATIVE CONTROL cells, every PRE cell, and both isolation cells.
 *
 * M2 — only the `onDefault` predicate reverted:
 *        `canonicalRoot(m.root) !== canonicalRoot(root)`  ->  `resolve(m.root) !== resolve(root)`
 *      PREDICTED: SURVIVED, 22/22, NO cell red — because the mutant is EQUIVALENT, argued here
 *      in advance rather than excused afterwards. `onDefault` is reached only when `rootMatches`
 *      is EMPTY (a non-empty `rootMatches` either returns at `recorded` or throws
 *      `ambiguous-target`). Empty means no recorded entry canonicalizes to this root, so the
 *      conjunct is vacuously true for every entry; and `resolve(a) === resolve(b)` implies
 *      `canonicalRoot(a) === canonicalRoot(b)`, so the mutated conjunct is vacuously true as
 *      well. Both spellings reduce to `meshes.find((m) => m.server === DEFAULT_SERVER)`.
 *      So a SURVIVED here is NOT a weak suite: with the match predicate corrected, the second
 *      half of the fix is a no-op, and the comment that presents it as ARM B's fix overstates it.
 *      REFUTATION CONDITION, declared before the run: if ANY cell reddens under M2, this
 *      equivalence argument is WRONG and is withdrawn rather than reworded.
 *
 * M3 — the match predicate WIDENED to `meshes.filter(() => true)`.
 *      NON-EQUIVALENT, and the control for "the fix was widened, not corrected".
 *      PREDICTED RED (exactly these three):
 *        - ARM B POST: resolution does NOT refuse our own mesh as a foreign one
 *        - ARM B POST: it binds to our own record at the default port
 *        - NEGATIVE CONTROL: it is refused BECAUSE the default port is held by another mesh
 *      (both become `ambiguous-target`: with the predicate always true, every recorded entry
 *      matches every root, so the multi-space guard fires first.)
 *      PREDICTED GREEN: every ARM A cell — at the moment ARM A resolves, ONE record exists, so a
 *      predicate that matches everything still matches exactly that one. A widening mutant is
 *      invisible to ARM A on its own, which is precisely why the negative control is not optional.
 * ---------------------------------------------------------------------------------------------
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
// `DEFAULT_SERVER` comes from the package, not from core's source: core's `src` entry pulls in the
// JetStream deps, which this worktree does not install. It is a constant and not a mutation target;
// the two files under test (`mesh-target.ts`, `mesh-registry.ts`) are the relative-source imports.
import { DEFAULT_SERVER } from "@cotal-ai/core";
import { canonicalRoot, recordMesh, findMesh, homeCotalDir, meshesDir } from "../../../packages/workspace/src/mesh-registry.js";
import { MeshTargetError, resolveMeshTarget } from "../../../packages/workspace/src/mesh-target.js";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: unknown = "") =>
  results.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });

const LIVE_BROKER = "nats://broker.cotal.ai:4222";
/** Recorded in a registry entry that other tooling on this box may dial. Asserted FIRST. */
const RECORDED_SERVER = "nats://127.0.0.1:14333";

const scratch: string[] = [];

/** A project root reachable under two spellings: the physical dir, and a symlink to it — exactly
 *  what `cotal meshes add --root <dir>` records, since its `checkRoot` applies `resolve()` and not
 *  realpath. `.cotal` anchor first: an unanchored tree walks up to a shared root. */
function project(tag: string): { physical: string; alias: string } {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), `cotal-rebind-${tag}-`)));
  scratch.push(tmp);
  const physical = join(tmp, "project");
  mkdirSync(join(physical, ".cotal"), { recursive: true });
  const alias = join(tmp, "typed-path");
  symlinkSync(physical, alias, "dir");
  return { physical, alias };
}

async function main(): Promise<void> {
  check("FIRST ACTION: the recorded broker URL is NOT the live host",
    RECORDED_SERVER !== LIVE_BROKER, RECORDED_SERVER);
  check("FIRST ACTION: the recorded broker is not the default either, so ARM A can be seen",
    RECORDED_SERVER !== DEFAULT_SERVER, `${RECORDED_SERVER} vs ${DEFAULT_SERVER}`);

  const home = mkdtempSync(join(tmpdir(), "cotal-rebind-home-"));
  scratch.push(home);
  process.env.COTAL_HOME = home;
  check("the registry is redirected to a scratch home", homeCotalDir() === home, homeCotalDir());
  const realHomeMeshes = join(homedir(), ".cotal", "meshes");
  const realBefore = existsSync(realHomeMeshes) ? readdirSync(realHomeMeshes).sort() : [];

  // ================= ARM A — the SILENT arm: recorded off-default server ========================
  const a = project("arma");
  const SPACE_A = "rebind-arm-a";
  recordMesh({
    space: SPACE_A,
    server: RECORDED_SERVER,
    root: resolve(a.alias), // the spelling an operator typed; `checkRoot` does not collapse it
    mode: "open",
    origin: "manual",
    ts: new Date().toISOString(),
  });

  // ---- PRE-STATE: what the binding IS before we resolve anything -------------------------------
  const preA = findMesh(SPACE_A);
  check("ARM A PRE: the registry holds a record for this project",
    preA !== undefined, preA ? preA.space : "<missing>");
  check("ARM A PRE: the record's server is the RECORDED one, not the default",
    preA?.server === RECORDED_SERVER, preA?.server ?? "<missing>");
  check("ARM A PRE: the record's root is a DIFFERENT STRING from the live root",
    preA !== undefined && preA.root !== a.physical, `${preA?.root} vs ${a.physical}`);
  check("ARM A PRE: ... but names the SAME DIRECTORY on disk",
    preA !== undefined && realpathSync(preA.root) === a.physical, realpathSync(preA?.root ?? "/"));
  check("ARM A PRE: `resolve()` — the OUTGOING spelling — reads them as DIFFERENT roots",
    preA !== undefined && resolve(preA.root) !== resolve(a.physical),
    `${resolve(preA?.root ?? "")} vs ${resolve(a.physical)}`);

  // ---- POST-STATE: produced by the REAL entry point, from that exact pre-state ------------------
  const targetA = resolveMeshTarget(a.physical);
  check("ARM A POST: resolution BINDS TO THE RECORD, not to the default port",
    targetA.server === RECORDED_SERVER, targetA.server);
  check("ARM A POST: the target's source is `local-recorded`, so the record is what answered",
    targetA.source === "local-recorded", targetA.source);
  check("ARM A POST: the RECORDED space is carried, not the default space",
    targetA.space === SPACE_A, targetA.space);
  check("ARM A POST: the record's `origin` rides along, so pruning knows who owns it",
    targetA.origin === "manual", targetA.origin ?? "<absent>");
  // The stale binding stated as the thing that must NOT happen, so a reader does not have to infer
  // it from the positive cells above.
  check("ARM A POST: resolution did NOT silently retarget to DEFAULT_SERVER",
    targetA.server !== DEFAULT_SERVER, `${targetA.server} vs ${DEFAULT_SERVER}`);

  // ================= ARM B — the LOUD arm: recorded AT the default port =========================
  const b = project("armb");
  const SPACE_B = "rebind-arm-b";
  recordMesh({
    space: SPACE_B,
    server: DEFAULT_SERVER,
    root: resolve(b.alias),
    mode: "open",
    origin: "up",
    ts: new Date().toISOString(),
  });

  const preB = findMesh(SPACE_B);
  check("ARM B PRE: the record is at the DEFAULT server", preB?.server === DEFAULT_SERVER, preB?.server ?? "<missing>");
  check("ARM B PRE: its root is a different string that names the same directory",
    preB !== undefined && preB.root !== b.physical && realpathSync(preB.root) === b.physical,
    `${preB?.root} -> ${realpathSync(preB?.root ?? "/")}`);

  let armBError: string | undefined;
  let targetB: ReturnType<typeof resolveMeshTarget> | undefined;
  try {
    targetB = resolveMeshTarget(b.physical);
  } catch (e) {
    armBError = e instanceof MeshTargetError ? `${e.code}: ${e.message}` : String(e);
  }
  check("ARM B POST: resolution does NOT refuse our own mesh as a foreign one",
    armBError === undefined, armBError ?? "<no error>");
  check("ARM B POST: it binds to our own record at the default port",
    targetB?.space === SPACE_B && targetB?.source === "local-recorded",
    `${targetB?.space}/${targetB?.source}`);

  // ================= NEGATIVE CONTROL — the fix must not match everything =======================
  // Without this, both arms above would pass just as well if the predicate had been replaced by
  // `true`. A control is only a control if its arms CAN differ: this one WOULD have failed (with
  // `local-recorded` for an unrelated project) had the predicate been widened instead of corrected.
  const c = project("unrelated");
  let unrelatedTarget: ReturnType<typeof resolveMeshTarget> | undefined;
  let unrelatedError: string | undefined;
  try {
    unrelatedTarget = resolveMeshTarget(c.physical);
  } catch (e) {
    unrelatedError = e instanceof MeshTargetError ? `${e.code}: ${e.message}` : String(e);
  }
  check("NEGATIVE CONTROL: an UNRELATED project does not resolve to a recorded mesh",
    unrelatedTarget?.source !== "local-recorded",
    unrelatedError ?? `${unrelatedTarget?.source}/${unrelatedTarget?.space}`);
  check("NEGATIVE CONTROL: it is refused BECAUSE the default port is held by another mesh",
    unrelatedError?.startsWith("default-occupied") === true, unrelatedError ?? "<no error>");

  // ================= the predicate is ONE predicate, not a second spelling ======================
  // `canonicalRoot` is the same function `meshesForRoot` uses; the fix routes both sites through it
  // rather than adding a third root-compare to the tree.
  check("the two spellings agree under `canonicalRoot`, which is what both sites now use",
    canonicalRoot(resolve(a.alias)) === canonicalRoot(a.physical),
    `${canonicalRoot(resolve(a.alias))} vs ${canonicalRoot(a.physical)}`);

  // ================= isolation held ============================================================
  const realAfter = existsSync(realHomeMeshes) ? readdirSync(realHomeMeshes).sort() : [];
  check("the machine's REAL registry was not written",
    JSON.stringify(realBefore) === JSON.stringify(realAfter), `${realBefore.join(",")} -> ${realAfter.join(",")}`);
  check("every write landed in the scratch registry", meshesDir().startsWith(home), meshesDir());
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
