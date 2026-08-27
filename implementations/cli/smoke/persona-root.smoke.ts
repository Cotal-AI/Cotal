/**
 * The persona catalog answers for the RESOLVED MESH, never for the cwd.
 *
 * `cotal personas` and `cotal spawn` must name the same set. They did not: `personasDir(root =
 * cotalRoot())` and its four siblings defaulted to the directory the cwd walks up to, so every
 * caller that forgot a root silently described a different project than the one the command acts
 * on. `spawn.ts` was the only caller passing the resolved mesh's root. From one cwd, with a mesh
 * selected elsewhere, `personas` listed a set `spawn` could not launch a single member of — and
 * neither surface said anything was wrong.
 *
 * Three properties, each measured rather than asserted:
 *   1. CATALOG AGREEMENT — what `personas list` prints equals what `spawn` will launch.
 *   2. `--space` IS REAL — naming a mesh moves the catalog, so two spaces give two answers from
 *      one cwd. (Before the fix `--space` reached only the live `--running` overlay, so the named
 *      mesh's running-marks were painted onto the cwd's names: two meshes in one table.)
 *   3. COMPLETERS AGREE — `spawn --role`/`--subscribe` and `send msg`/`ask` complete from the
 *      target mesh's personas, not the cwd's.
 *
 * (3) is not redundant with a typecheck. The signature change makes a forgotten root a compile
 * error, but passing `cotalRoot()` at those sites silences the compiler and keeps the bug: that
 * mutant typechecks with ZERO errors. Only an answer-level check catches it, so this file checks
 * answers.
 *
 * Hermetic: COTAL_HOME and the fixtures are sandboxed, meshes are registered straight into the
 * registry, and NO BROKER is needed — catalog and completion resolution are offline by contract,
 * which is itself part of the claim. Run: pnpm smoke:persona-root
 */
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeScratch } from "../../../bin/smoke/_scratch.js";

// Isolate the machine-home AND the temp root before importing anything that resolves a root.
// `findCotalRoot` walks to `/` with no boundary, so a `.cotal` above the temp base captures every
// fixture: the "cwd project" then resolves somewhere else and the whole suite grades a state it
// failed to create. Measured on this machine: TMPDIR was $HOME/.cotal/jcode/…, i.e. already
// captured, so os.tmpdir() cannot be trusted here.
const scratch = makeScratch();
const cleanScratch = (e: unknown): never => {
  rmSync(scratch, { recursive: true, force: true });
  throw new Error(`fixture setup failed (scratch removed): ${(e as Error).message}`, { cause: e });
};
let home!: string;
try {
  home = mkdtempSync(join(scratch, "home-"));
} catch (e) { cleanScratch(e); }
process.env.COTAL_HOME = home;

// Typed against the modules they come from — `any` would buy tidiness by giving up the
// compile-time checking this suite exists to exercise.
let recordMesh!: typeof import("@cotal-ai/workspace").recordMesh;
let setCurrent!: typeof import("@cotal-ai/workspace").setCurrent;
let resolveMeshTarget!: typeof import("@cotal-ai/workspace").resolveMeshTarget;
let listPersonas!: typeof import("../src/lib/personas.js").listPersonas;
let personas!: typeof import("../src/commands/personas.js").personas;
let personasComplete!: typeof import("../src/commands/personas.js").personasComplete;
let spawnComplete!: typeof import("../src/commands/spawn.js").spawnComplete;
let sendComplete!: typeof import("../src/commands/send.js").sendComplete;
try {
  ({ recordMesh, setCurrent, resolveMeshTarget } = await import("@cotal-ai/workspace"));
  ({ listPersonas } = await import("../src/lib/personas.js"));
  ({ personas, personasComplete } = await import("../src/commands/personas.js"));
  ({ spawnComplete } = await import("../src/commands/spawn.js"));
  ({ sendComplete } = await import("../src/commands/send.js"));
} catch (e) { cleanScratch(e); }

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

/** A project root with a persona catalog; each persona declares a role and a channel. */
function project(label: string, personas: { name: string; role: string; channel: string }[]): string {
  const root = mkdtempSync(join(scratch, `${label}-`));
  const dir = join(root, ".cotal", "agents");
  mkdirSync(dir, { recursive: true });
  for (const p of personas)
    writeFileSync(
      join(dir, `${p.name}.md`),
      `---\nname: ${p.name}\nrole: ${p.role}\nsubscribe: [${p.channel}]\n---\n\nI am ${p.name}.\n`,
    );
  return root;
}

const sorted = (r: { items: { value: string }[] }) => r.items.map((i) => i.value).sort();
const names = (root: string) => listPersonas(root).map((p) => p.name).sort();

/** Run `cotal personas list` for real and return everything it printed.
 *
 *  The command's answer IS its stdout, so that is what gets observed. Calling `listPersonas` with
 *  a root the suite resolved itself would grade the suite's own arithmetic instead of the
 *  command's, and would pass against the unfixed tree — measured, not hypothesised. */
async function captureList(values: { space?: string; server?: string }): Promise<string> {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await personas({ values, positionals: ["list"], raw: [] });
  } finally {
    console.log = realLog;
  }
  // Strip ANSI: the listing bolds names, so a flush-left name test would match nothing and every
  // "the cwd's personas are absent" check would pass for the wrong reason.
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Persona names out of a captured listing: printed flush-left, descriptions indented under them. */
function personaNamesFrom(out: string): string[] {
  return [...new Set(
    out.split("\n").filter((l) => /^[A-Za-z0-9_-]+(\s|$)/.test(l)).map((l) => l.split(/\s/)[0]),
  )].sort();
}

// MESH and CWD are disjoint in every dimension — persona names, roles, and channels — so a wrong
// answer NAMES itself rather than merely failing an expectation. A suite whose two sides overlap
// cannot tell "read the right root" from "read either root".
let MESH!: string, CWD!: string, ALPHA!: string, BETA!: string;
try {
  MESH = project("mesh", [
    { name: "mesh-default", role: "mesh-reviewer", channel: "mesh-alpha" },
    { name: "mesh-lead", role: "mesh-builder", channel: "mesh-beta" },
  ]);
  CWD = project("cwd", [
    { name: "cwd-one", role: "cwd-writer", channel: "cwd-chan" },
    { name: "cwd-two", role: "cwd-editor", channel: "cwd-other" },
  ]);
  ALPHA = project("alpha", [{ name: "alpha-only", role: "alpha-role", channel: "alpha-chan" }]);
  BETA = project("beta", [{ name: "beta-only", role: "beta-role", channel: "beta-chan" }]);
} catch (e) { cleanScratch(e); }

const entry = (space: string, root: string, server: string) =>
  ({ space, server, root, mode: "open" as const, ts: "2026-08-27T00:00:00.000Z" });

const prevCwd = process.cwd();
try {
  recordMesh(entry("meshspace", MESH, "nats://127.0.0.1:4222"));
  setCurrent("meshspace");
  process.chdir(CWD); // stand in the OTHER project — the entire point of the suite

  // The premise. If these two ever coincide the suite proves nothing, so assert the split exists
  // before grading anything that depends on it.
  const target = resolveMeshTarget(process.cwd());
  check("premise: the resolved mesh root differs from the cwd", target.root === MESH && MESH !== CWD, { mesh: target.root, cwd: CWD });
  check("premise: the cwd is itself a real project with its own catalog", existsSync(join(CWD, ".cotal", "agents", "cwd-one.md")));

  // 1. CATALOG AGREEMENT.
  //
  // Read `personas list` by CAPTURING WHAT IT PRINTS, not by calling listPersonas(target.root)
  // and comparing. That distinction decides whether this suite is a detector at all: the first
  // version of this file did the latter, and every catalog cell PASSED against the unfixed tree,
  // because the cell was re-implementing the fix instead of measuring the command. A cell that
  // cannot fail is not evidence. `personas()` writes to stdout, so stdout is the observation.
  const listedOut = await captureList({});
  const listed = personaNamesFrom(listedOut);
  // `spawn` resolves its catalog as listPersonas(target.root) — that IS spawn's implementation,
  // so calling it here is calling the product, not a replica of it.
  const launchable = names(target.root);
  check("catalog: personas list prints the MESH's personas", listed.join(",") === "mesh-default,mesh-lead", listed);
  check("catalog: personas and spawn name the SAME set", listed.join(",") === launchable.join(","), { listed, launchable });
  check("catalog: the cwd's own personas are NOT listed", !listed.some((n) => n.startsWith("cwd-")), listed);

  // 2. `--space` MOVES THE CATALOG. Two meshes, one cwd, changing only the flag — and again read
  // off what the command PRINTS. Neither answer may be the cwd's; that is the failure mode, named
  // explicitly so it cannot be confused with "not what we expected".
  recordMesh(entry("alpha", ALPHA, "nats://127.0.0.1:4301"));
  recordMesh(entry("beta", BETA, "nats://127.0.0.1:4302"));
  const alphaListed = personaNamesFrom(await captureList({ space: "alpha" }));
  const betaListed = personaNamesFrom(await captureList({ space: "beta" }));
  check("--space alpha: personas list prints alpha's catalog", alphaListed.join(",") === "alpha-only", alphaListed);
  check("--space beta: personas list prints beta's catalog", betaListed.join(",") === "beta-only", betaListed);
  check("--space: two spaces give two DIFFERENT answers from one cwd", alphaListed.join(",") !== betaListed.join(","));
  check("--space: neither answer is the cwd's catalog", !alphaListed.concat(betaListed).some((n) => n.startsWith("cwd-")), { alphaListed, betaListed });

  // 3. COMPLETERS. argv EXCLUDES the command name (same convention as spawn-from-anywhere's
  // `spawnComplete([""])`); the trailing "" is the word being completed.
  check("completion: spawn --role offers the MESH's declared roles", sorted(spawnComplete(["--role", ""])).join(",") === "mesh-builder,mesh-reviewer", sorted(spawnComplete(["--role", ""])));
  check("completion: spawn --subscribe offers the MESH's declared channels", sorted(spawnComplete(["--subscribe", ""])).join(",") === "mesh-alpha,mesh-beta", sorted(spawnComplete(["--subscribe", ""])));
  check("completion: send ask <role> offers the MESH's declared roles", sorted(sendComplete(["ask", ""])).join(",") === "mesh-builder,mesh-reviewer", sorted(sendComplete(["ask", ""])));
  check("completion: send msg <channel> offers the MESH's declared channels", sorted(sendComplete(["msg", ""])).join(",") === "mesh-alpha,mesh-beta", sorted(sendComplete(["msg", ""])));
  check("completion: personas show offers the MESH's persona names", sorted(personasComplete(["show", ""])).join(",") === "mesh-default,mesh-lead", sorted(personasComplete(["show", ""])));
  check("completion: personas show --space alpha offers ALPHA's names", sorted(personasComplete(["--space", "alpha", "show", ""])).join(",") === "alpha-only", sorted(personasComplete(["--space", "alpha", "show", ""])));

  // POSITIVE CONTROL for every "the cwd's names are absent" claim above. Those are all zeroes, and
  // a zero fuses two claims: "the instrument looked" and "there was nothing". This proves the
  // first — the SAME readers, pointed at the cwd root, do return the cwd's names. Without it, a
  // reader that returned nothing at all would satisfy every absence check in this file.
  check("control: the same reader DOES return the cwd's names when given the cwd root", names(CWD).join(",") === "cwd-one,cwd-two", names(CWD));
  // And the listing PARSER can see cwd names when they are genuinely printed — otherwise a parser
  // that matched nothing would also satisfy "the cwd's personas are NOT listed".
  check("control: the listing parser CAN see cwd names when they are present", personaNamesFrom("cwd-one  role\n  desc\ncwd-two  role").join(",") === "cwd-one,cwd-two");

  // FAIL CLOSED. A completer must never throw into the operator's interactive shell, and must not
  // guess a root when none resolves. With `--space` naming a mesh that is not registered there is
  // no target, so the honest answer is no items.
  check("completion fails CLOSED on an unresolvable target (no throw, no items)", personasComplete(["--space", "no-such-mesh", "show", ""]).items.length === 0);

  console.log(`\npersona-root smoke: ${pass} checks passed`);
} finally {
  process.chdir(prevCwd);
  rmSync(scratch, { recursive: true, force: true });
}
