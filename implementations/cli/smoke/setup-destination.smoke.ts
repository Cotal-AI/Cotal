/**
 * `cotal setup` seeds into the catalog `cotal spawn` READS, and says which directory that is.
 *
 * setup wrote its personas through a cwd-derived root (`cotalPath("agents", …)`, a `findCotalRoot`
 * walk up from `process.cwd()`), while `spawn` loads from the RESOLVED MESH's root
 * (`agentFilePath(target.root, ref)`). Where those disagree — a cwd outside every project plus a
 * mesh registered against another root — setup dutifully wrote a file spawn would never open, so
 * "no default persona yet - run `cotal setup` to seed one" survived running exactly the command it
 * named. The remedy the error prescribed did not fix the error.
 *
 * Its sibling `persona-root.smoke.ts` guards which catalog is READ; `persona-templates` guards what
 * gets WRITTEN into it. This one guards WHERE a write lands, and that the output names the place.
 *
 * Four properties, each measured against the resolution spawn actually performs:
 *   1. DESTINATION — the seed lands under the resolved mesh's root, and NOT under the cwd's.
 *      Asserted against `agentFilePath(target.root, "default")`, the path spawn itself resolves,
 *      rather than a path this suite rebuilds — a second implementation could agree by accident.
 *   2. IT PARSES — the seeded bytes load under `loadAgentFile`, the loader spawn uses. `existsSync`
 *      is not the question: status reports a green `default` for a file the loader refuses, so a
 *      seed that emitted unparseable frontmatter would start that divergence here.
 *   3. EMPTY ROOT — a mesh registered against a brand-new root with no `.cotal` at all seeds like
 *      an established one (the case that actually bit), rather than throwing ENOENT.
 *   4. THE FALLBACK IS NARROW — with NO mesh at all the cwd is the one honest answer, so setup
 *      seeds there. With SEVERAL meshes and none selected the operator has a real choice, and
 *      picking for them would be this same defect wearing a different hat: it must refuse.
 *
 * (4) is the cell that would have caught the bug this fix first shipped with: a `catch` that
 * swallowed every resolution failure fell back to the cwd for ambiguity too.
 *
 * Hermetic: COTAL_HOME and the fixtures are sandboxed and meshes are registered straight into the
 * registry. NO BROKER is needed — seed-destination resolution is offline by contract, which is
 * itself part of the claim. Run: pnpm smoke:setup-destination
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeScratch } from "../../../bin/smoke/_scratch.js";

// Isolate the machine-home AND the temp root BEFORE importing anything that resolves a root.
// `findCotalRoot` walks to `/` with no boundary, so a `.cotal` anywhere above the temp base
// captures every fixture and the suite grades a state it failed to create. Measured on this
// machine while developing this fix: a `/tmp/.cotal` appeared mid-session and flipped a sibling
// suite from pass to fail with the code unchanged and committed.
const scratch = makeScratch();
const cleanScratch = (e: unknown): never => {
  rmSync(scratch, { recursive: true, force: true });
  throw new Error(`fixture setup failed (scratch removed): ${(e as Error).message}`, { cause: e });
};
let home!: string;
try {
  home = mkdtempSync(join(scratch, "home-"));
} catch (e) {
  cleanScratch(e);
}
process.env.COTAL_HOME = home;

// Typed against the modules they come from — `any` would buy tidiness by giving up the
// compile-time checking this suite exists to exercise.
let recordMesh!: typeof import("@cotal-ai/workspace").recordMesh;
let setCurrent!: typeof import("@cotal-ai/workspace").setCurrent;
let resolveMeshTarget!: typeof import("@cotal-ai/workspace").resolveMeshTarget;
let agentFilePath!: typeof import("@cotal-ai/core").agentFilePath;
let loadAgentFile!: typeof import("@cotal-ai/core").loadAgentFile;
let seedDestinationFor!: typeof import("../src/commands/setup.js").seedDestinationFor;
try {
  ({ recordMesh, setCurrent, resolveMeshTarget } = await import("@cotal-ai/workspace"));
  ({ agentFilePath, loadAgentFile } = await import("@cotal-ai/core"));
  ({ seedDestinationFor } = await import("../src/commands/setup.js"));
} catch (e) {
  cleanScratch(e);
}

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** Register a mesh rooted at a fresh directory. `seedCotal` false leaves the root EMPTY — no
 *  `.cotal` at all — which is the brand-new-root case property 3 covers. */
function mesh(space: string, port: number, opts: { seedCotal?: boolean } = {}): string {
  const root = mkdtempSync(join(scratch, `${space}-`));
  if (opts.seedCotal !== false) mkdirSync(join(root, ".cotal"), { recursive: true });
  recordMesh({ space, server: `nats://127.0.0.1:${port}`, root, mode: "open", origin: "up" });
  return root;
}

/** A cwd that is NOT any mesh's root and holds no `.cotal` of its own — the shape that triggers
 *  the defect, where the cwd walk and the mesh's root disagree. */
const cwd = (): string => mkdtempSync(join(scratch, "cwd-"));

const clearCurrent = () => rmSync(join(home, "current-mesh"), { force: true });
const catalogOf = (root: string) => join(root, ".cotal", "agents");
const listed = (dir: string): string[] => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
};

try {
  // ── 1. the seed lands where SPAWN reads, not where the cwd points ──────────────────────────
  const alpha = mesh("alpha", 4801);
  const beta = mesh("beta", 4802);
  const here = cwd();

  for (const [space, root] of [["alpha", alpha], ["beta", beta]] as const) {
    setCurrent(space);
    const dest = seedDestinationFor(here);
    check(`${space}: the destination is the RESOLVED MESH's catalog, not the cwd's`, dest.source === "mesh" && dest.dir === catalogOf(root), {
      dir: dest.dir,
      expected: catalogOf(root),
    });

    // The authority is the path SPAWN resolves. Rebuilding it here would be a second
    // implementation of spawn's resolution that could agree with the product by accident.
    const target = resolveMeshTarget(here, {});
    check(`${space}: that directory is exactly where spawn resolves \`default\``, join(dest.dir, "default.md") === agentFilePath(target.root, "default"), {
      seed: join(dest.dir, "default.md"),
      spawn: agentFilePath(target.root, "default"),
    });
    check(`${space}: the destination is absolute (a relative path is what hid the bug)`, dest.dir.startsWith("/") || /^[A-Za-z]:/.test(dest.dir), dest.dir);
  }

  // Switching the selected mesh MOVES the destination — from one unchanged cwd. Before the fix
  // both answers were the cwd's, so this pair was indistinguishable.
  setCurrent("alpha");
  const destA = seedDestinationFor(here).dir;
  setCurrent("beta");
  const destB = seedDestinationFor(here).dir;
  check("the selected mesh decides the catalog: two meshes give two destinations from ONE cwd", destA !== destB, { destA, destB });
  check("neither destination is the cwd's own catalog", destA !== catalogOf(here) && destB !== catalogOf(here), { cwd: catalogOf(here) });

  // ── 2. what setup writes must LOAD under the loader spawn uses ─────────────────────────────
  // `existsSync` is not the question: `status` reports a green `default` for a file `loadAgentFile`
  // refuses, so an unparseable seed would originate that divergence right here.
  setCurrent("alpha");
  const seeded = seedDestinationFor(here);
  const { seedDefaultAgentInto } = await import("../src/commands/setup.js");
  seedDefaultAgentInto(seeded.dir);
  const file = join(seeded.dir, "default.md");
  check("the seed actually wrote the file", existsSync(file));
  const def = loadAgentFile(file); // throws on malformed frontmatter — that IS the assertion
  check("the seeded persona PARSES under the loader spawn uses", def.name === "default_agent", { name: def.name });
  check("it declares the channels it reads (never left to a default)", Array.isArray(def.subscribe), def.subscribe);
  // Positive control for the loader: "it parsed" is only interesting if this loader refuses anything.
  const badDir = mkdtempSync(join(scratch, "bad-"));
  const bad = join(badDir, "x.md");
  (await import("node:fs")).writeFileSync(bad, "---\nname: [unclosed\n---\nbody\n");
  let refused = false;
  try {
    loadAgentFile(bad);
  } catch {
    refused = true;
  }
  check("control: the same loader DOES reject a malformed persona", refused);

  // ── 3. a mesh registered against a BRAND-NEW, EMPTY root ───────────────────────────────────
  // The case that actually bit: the resolved root has no `.cotal` at all, let alone an agents dir.
  const fresh = mesh("fresh", 4803, { seedCotal: false });
  check("the new root really is empty before seeding", listed(fresh).length === 0, listed(fresh));
  setCurrent("fresh");
  const freshDest = seedDestinationFor(here);
  seedDefaultAgentInto(freshDest.dir);
  check("seeding builds the whole .cotal/agents chain under an empty root", existsSync(join(catalogOf(fresh), "default.md")));
  check("and it parses too", loadAgentFile(join(catalogOf(fresh), "default.md")).name === "default_agent");

  // ── 4. the fallback is NARROW ──────────────────────────────────────────────────────────────
  // No mesh at all: the cwd is the one honest answer, and setup must say it fell back.
  for (const f of readdirSync(join(home, "meshes"))) rmSync(join(home, "meshes", f), { force: true });
  clearCurrent();
  const lonely = cwd();
  const fell = seedDestinationFor(lonely);
  check("no mesh at all: falls back to the cwd's catalog", fell.source === "cwd" && fell.dir === catalogOf(lonely), fell.dir);
  check("no mesh at all: it carries the REASON, so the fallback is never silent", Boolean(fell.reason && /no mesh/i.test(fell.reason)), fell.reason);

  // Several meshes, NONE selected: the operator has a real choice. Seeding the cwd here would be
  // this same defect wearing a different hat — a root chosen for them that spawn may not read.
  mesh("ma", 4804);
  mesh("mb", 4805);
  clearCurrent();
  const ambiguous = cwd();
  let threw: Error | undefined;
  try {
    seedDestinationFor(ambiguous);
  } catch (e) {
    threw = e as Error;
  }
  check("ambiguous target: REFUSES rather than guessing a root", threw !== undefined, threw?.message);
  check("ambiguous target: the refusal is the resolver's typed error, so the CLI renders its recovery copy", (threw as { code?: string } | undefined)?.code === "ambiguous-target", (threw as { code?: string } | undefined)?.code);
  check("ambiguous target: nothing was written to the cwd", !existsSync(join(catalogOf(ambiguous), "default.md")));

  console.log(`\nsetup-destination smoke: ${pass} checks passed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
