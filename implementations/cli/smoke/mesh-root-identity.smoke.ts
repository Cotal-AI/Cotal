/**
 * ROOT IDENTITY IN THE MESH REGISTRY — does a recorded root still name the live root?
 *
 * Every `cotal up` decision about an already-running mesh keys on one question: is the broker that
 * is answering THIS project's mesh? The registry answers it by comparing a recorded `root` against
 * the live `cotalRoot()`. Two spellings of that comparison exist in the tree:
 *
 *   - `meshesForRoot` (`packages/workspace/src/mesh-registry.ts`), which canonicalizes both sides
 *     via realpath, and whose own doc states the rule: "Anything comparing a live root against the
 *     registry must go through here: a raw `===` silently misses";
 *   - a raw `held.root === root`, which several call sites in `up.ts`/`down.ts` still use.
 *
 * This suite measures whether those two spellings can DISAGREE about the same directory on a real
 * filesystem, and pins the direction of the disagreement. It proves the PRECONDITION only — that
 * the comparisons diverge — not any consequence inside `up`, which needs a live broker.
 *
 * Isolation: the registry is redirected with `COTAL_HOME` to a scratch dir, and the suite asserts
 * the machine's real registry is untouched before it writes anything.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: unknown = "") =>
  results.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });

const LIVE_BROKER = "nats://broker.cotal.ai:4222";
/** This suite starts no broker at all, but the URL it records must still never be the live host —
 *  a recorded server is dialled by other tooling on this box. Asserted FIRST, before any write. */
const EPHEMERAL_SERVER = "nats://127.0.0.1:14622";

async function main(): Promise<void> {
  check("FIRST ACTION: the recorded broker URL is NOT the live host", EPHEMERAL_SERVER !== LIVE_BROKER, EPHEMERAL_SERVER);

  // ---- isolate the registry BEFORE importing it (homeCotalDir reads COTAL_HOME at call time) ----
  const home = mkdtempSync(join(tmpdir(), "cotal-rootid-home-"));
  process.env.COTAL_HOME = home;
  const { findMesh, homeCotalDir, meshesDir, meshesForRoot, recordMesh } = await import("@cotal-ai/workspace");
  check("registry is redirected to the scratch home", homeCotalDir() === home, homeCotalDir());
  const realHomeMeshes = join(homedir(), ".cotal", "meshes");
  const realBefore = existsSync(realHomeMeshes) ? readdirSync(realHomeMeshes).sort() : [];

  // ---- a project root reachable under TWO spellings of the same directory ----
  // `.cotal` anchor FIRST: an unanchored tree resolves up to a shared root, and that hazard is live.
  const physical = realpathSync(mkdtempSync(join(tmpdir(), "cotal-rootid-proj-")));
  mkdirSync(join(physical, ".cotal"), { recursive: true });
  const aliasParent = realpathSync(mkdtempSync(join(tmpdir(), "cotal-rootid-alias-")));
  const alias = join(aliasParent, "project"); // a symlink an operator could reasonably type
  symlinkSync(physical, alias, "dir");

  check("the two spellings are DIFFERENT strings", alias !== physical, `${alias} vs ${physical}`);
  check("the two spellings are the SAME directory", realpathSync(alias) === physical, realpathSync(alias));

  const SPACE = "rootid";
  const entry = {
    space: SPACE,
    server: EPHEMERAL_SERVER,
    // The spelling an operator hands to `cotal meshes add --root <dir>`: `checkRoot`
    // (implementations/cli/src/commands/meshes-add.ts:126) applies `resolve()`, which does NOT
    // collapse a symlink, so this is exactly what lands in the record.
    root: resolve(alias),
    mode: "open" as const,
    origin: "manual" as const,
    ts: new Date().toISOString(),
  };
  recordMesh(entry);

  // ---- PRE-STATE: what the registry now holds ----
  const held = findMesh(SPACE);
  check("PRE: the record exists and holds the ALIAS spelling", held?.root === resolve(alias), held?.root ?? "<missing>");

  // ---- the divergence itself, both comparisons run against the SAME live root ----
  const liveRoot = physical; // what `cotalRoot()` returns from inside the project (cwd is physical)
  const rawCompare = held !== undefined && held.root === liveRoot; // the `up.ts:621` spelling
  const canonicalCompare = meshesForRoot(liveRoot).some((m) => m.space === SPACE); // the documented rule

  check("the RAW `===` compare MISSES the record for the live root", rawCompare === false, `raw=${rawCompare}`);
  check("the CANONICAL `meshesForRoot` compare FINDS it for the same live root", canonicalCompare === true, `canonical=${canonicalCompare}`);
  check("therefore the two comparisons DISAGREE about one directory", rawCompare !== canonicalCompare, `raw=${rawCompare} canonical=${canonicalCompare}`);

  // ---- the `resolve()`-flavoured spelling, which is what TARGET RESOLUTION actually uses ----
  // `mesh-target.ts:355` filters with `resolve(m.root) === resolve(root)` and `:372` re-tests the
  // same way. `resolve` normalizes separators and relative segments but does NOT collapse a
  // symlink, so it misses here exactly as the bare `===` does — worth its own cell, because a
  // reader can reasonably assume `resolve()` already canonicalizes and that these sites are safe.
  //
  // This matters more than the `up.ts` guard: `:355` is a RESOLUTION path, not a refusal. A miss
  // there leaves `recorded` undefined for a root that IS recorded, so the project is treated as
  // UNRECORDED — discarding the recorded server and mode and falling through to
  // `localTarget(root, DEFAULT_SERVER)` (`:380`) when nothing else holds the default port.
  const resolveCompare = held !== undefined && resolve(held.root) === resolve(liveRoot);
  check("the `resolve()` compare (mesh-target.ts:355 spelling) ALSO misses", resolveCompare === false, `resolve=${resolveCompare}`);
  check("`resolve()` and `meshesForRoot` disagree about one directory too", resolveCompare !== canonicalCompare, `resolve=${resolveCompare} canonical=${canonicalCompare}`);
  // The `:372` companion: our OWN record now reads as "a DIFFERENT mesh" because the roots differ
  // lexically. That is the misleading-refusal half of the same divergence.
  const readsAsForeign = held !== undefined && resolve(held.root) !== resolve(liveRoot);
  check("our own record reads as a FOREIGN root to the `:372` test", readsAsForeign === true, `foreign=${readsAsForeign}`);

  // ---- NON-VACUITY CONTROL ----
  // The miss above must be caused by the SPELLING, not by a broken fixture (a bad space name, a
  // registry that never wrote, a `meshesForRoot` that matches everything). Re-record the SAME mesh
  // under the PHYSICAL spelling: now both comparisons must agree, and agree on TRUE.
  recordMesh({ ...entry, root: physical });
  const held2 = findMesh(SPACE);
  const rawCompare2 = held2 !== undefined && held2.root === liveRoot;
  const canonicalCompare2 = meshesForRoot(liveRoot).some((m) => m.space === SPACE);
  check("CONTROL: recorded under the physical spelling, the RAW compare now FINDS it", rawCompare2 === true, `raw=${rawCompare2}`);
  check("CONTROL: the canonical compare still finds it", canonicalCompare2 === true, `canonical=${canonicalCompare2}`);
  check("CONTROL: the two comparisons AGREE when the spellings match", rawCompare2 === canonicalCompare2, `raw=${rawCompare2} canonical=${canonicalCompare2}`);
  // Non-vacuity for the `resolve()` cells above: they assert a FALSE, which a broken fixture would
  // also produce. Under the physical spelling the same expression must go TRUE, so the miss above
  // is the symlink and not the comparison being incapable of matching anything.
  const resolveCompare2 = held2 !== undefined && resolve(held2.root) === resolve(liveRoot);
  check("CONTROL: the `resolve()` compare FINDS it under the physical spelling", resolveCompare2 === true, `resolve=${resolveCompare2}`);

  // ---- NEGATIVE CONTROL: `meshesForRoot` is not a rubber stamp ----
  const unrelated = realpathSync(mkdtempSync(join(tmpdir(), "cotal-rootid-other-")));
  check("NEGATIVE CONTROL: `meshesForRoot` finds NOTHING for an unrelated root",
    meshesForRoot(unrelated).length === 0, `${meshesForRoot(unrelated).length} entries`);

  // ---- isolation held ----
  const realAfter = existsSync(realHomeMeshes) ? readdirSync(realHomeMeshes).sort() : [];
  check("the machine's REAL registry was not written", JSON.stringify(realBefore) === JSON.stringify(realAfter),
    `${realBefore.join(",")} -> ${realAfter.join(",")}`);
  check("every write landed in the scratch registry", meshesDir().startsWith(home), meshesDir());

  for (const d of [home, physical, aliasParent, unrelated]) rmSync(d, { recursive: true, force: true });
}

await main();

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.detail ? `  [${r.detail}]` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
