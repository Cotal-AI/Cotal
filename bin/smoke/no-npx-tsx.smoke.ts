/**
 * No smoke suite may launch the CLI through `npx tsx`.
 *
 * `npm exec` resolves a package from the CURRENT WORKING DIRECTORY upward, never from PATH. Every
 * suite that spawns the CLI does so with `cwd` set to a scratch directory outside this repo, so from
 * there `npx tsx` misses the workspace copy in `node_modules/.bin`. What happens next depends on the
 * runner's npx cache: a warm box serves whatever `tsx@latest` it last cached, and a cold CI runner
 * goes to the registry. The registry install prints
 *
 *     npm warn exec The following package was not found and will be installed: tsx@X.Y.Z
 *
 * onto stderr, which the fixtures merge into the output they parse, so `ps` assertions read a
 * warning where they expect a roster row, and `cotal up` can miss its budget and be SIGKILLed.
 * That reddened every smoke shard on main at `7f3a8a03` (#1244) from a change that touched no
 * smoke file at all: the tree was byte-identical to the green run before it.
 *
 * The robust form, already used by the majority of suites, resolves the workspace binary by path:
 *
 *     const TSX = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx");
 *     spawn(TSX, [BIN, ...args], opts)
 *
 * This guard reddens on any `spawn("npx", ["tsx"` (plain or `pty.spawn`) under a `smoke/` directory.
 * It carries a planted positive control so the search is shown able to find the banned form, and a
 * self-check that the real tree contributes zero hits; a grep that finds nothing and a grep that cannot
 * find anything print the same zero, and only the planted control tells them apart.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
// Any spawner name, any whitespace or newline between the tokens. The first version of this guard
// matched only `spawn(` and missed spawnSync, spawnProc and a multi-line call in seven files; CI
// found the one it reached. A grammar guard has to match the family, not the one form its author
// happened to fix.
const BANNED = /\b(?:spawn|spawnSync|spawnProc|execFile|execFileSync|pty\.spawn)\(\s*"npx"\s*,\s*\[\s*"tsx"/;
/** This file quotes the banned form in its own docstring, so it excludes itself and grades the rest. */
const SELF = "bin/smoke/no-npx-tsx.smoke.ts";
const SKIP = new Set(["node_modules", "dist", ".git", ".changeset", "coverage", "build", ".internal"]);

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

/** Every `.ts` file whose path has a `smoke/` segment, excluding this guard's own fixture directory. */
function smokeSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) smokeSources(p, out);
    else if (p.endsWith(".ts") && /(^|\/)smoke\//.test(relative(ROOT, p)) && !relative(ROOT, p).startsWith("bin/smoke/fixtures/") && relative(ROOT, p) !== SELF) out.push(p);
  }
  return out;
}

const files = smokeSources(ROOT);
const hits = files.filter((f) => BANNED.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));

check("the walk finds a non-trivial population of smoke sources (a walk over nothing would pass for free)", files.length >= 50, `found ${files.length}`);

// Planted positive control: a fixture that carries the banned form verbatim. If the regex cannot see
// it, every real hit below would have been invisible too, and the zero would mean nothing.
const planted = join(ROOT, "bin", "smoke", "fixtures", "no-npx-tsx.planted.txt");
const plantedText = readFileSync(planted, "utf8");
check("the planted control carries the banned form and the regex sees it", BANNED.test(plantedText), plantedText.slice(0, 80));

// Negative control: the robust form must NOT match, or the guard would redden its own remedy.
check("the robust form spawn(TSX, [BIN, ...]) is not matched", !BANNED.test('const child = spawn(TSX, [BIN, ...args], options);'));
check("the multi-line and spawnSync forms ARE matched (the family, not the one form)",
  BANNED.test('spawnSync(\n    "npx",\n    ["tsx", x]') && BANNED.test('spawnProc("npx", ["tsx", BIN])') && BANNED.test('pty.spawn("npx", ["tsx"'));

check(`no smoke source launches the CLI via npx tsx (${files.length} files walked)`, hits.length === 0, hits);

console.log(`\nNO-NPX-TSX ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
console.log(`SUITE COMPLETE: ${pass + fail} declared`);
process.exit(fail === 0 ? 0 : 1);
