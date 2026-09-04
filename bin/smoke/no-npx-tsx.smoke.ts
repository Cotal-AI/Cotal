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
// Match the TOKEN and nothing about the callee. Three earlier versions of this regex each named
// the spawner identifiers their author had converted (spawn; then spawnSync/spawnProc/pty.spawn;
// then with any argument shape), and each time the reviewer planted a spelling outside the list:
// an aliased import (`spawn as spawnProcess`), `exec("npx tsx ...")`, a single-quoted 'npx', a
// space or newline before the paren, `npx.cmd`, and `spawn("npm", ["exec", "tsx"`. Every one of
// those is the same hazard: a process launcher handed npx from a scratch cwd. So the grammar here
// is only the hazard token in argument position, whatever function it is passed to:
//   (a) any call whose FIRST argument is the literal npx or npx.cmd, single or double quoted
//   (b) any string literal beginning `npx tsx`, which is the shell-string form exec/execSync take
//   (c) any call whose first argument is "npm" followed by an array beginning "exec"
// A bare identifier (`const cmd = "npx"; spawn(cmd, ...)`) carries no token at the call and is
// out of reach of any grammar guard; the guard says so rather than pretending otherwise.
// Quote class: single, double, OR backtick. Fifth round found spawn(`npx`, ...) and exec(`npx tsx ...`)
// slipping because ['"] has no backtick; live smoke already writes template-literal execSync.
// Token class: npx with any Windows shim suffix (.cmd, .exe, .ps1), and npm likewise.
// Between the quoted token and the comma: any TypeScript wrapper that keeps the literal at the
// call (`as const`, `!`, extra parens), so `spawn("npx" as const, ...)` cannot slip either.
const Q = String.raw`['"\x60]`;
const WRAP = String.raw`[\s()!]*(?:as\s+const[\s()!]*)?`;
const BANNED = new RegExp(
  [
    // (a) first argument is the npx token, however quoted or wrapped
    String.raw`\(${WRAP}${Q}npx(?:\.(?:cmd|exe|ps1))?${Q}${WRAP},`,
    // (b) a shell string beginning `npx tsx` or `npm exec`, the exec/execSync form
    // (b) a shell string beginning `npx tsx` or `npm exec`, the exec/execSync form. Anchored to
    //     argument position ( `(` or `,` before the quote ) so a backticked mention inside a
    //     prose comment does not match; round five's first cut reddened on exactly that.
    String.raw`[(,]${WRAP}${Q}(?:npx|npm\s+exec)\s+tsx\b`,
    String.raw`[(,]${WRAP}${Q}npm\s+exec\b`,
    // (c) argv form of npm exec, with the same quote and shim classes
    String.raw`\(${WRAP}${Q}npm(?:\.(?:cmd|exe|ps1))?${Q}${WRAP},\s*\[\s*${Q}exec${Q}`,
  ].join("|"),
);

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
const positives: Array<[string, string]> = [
  ["spawnSync multi-line", 'spawnSync(\n    "npx",\n    ["tsx", x]'],
  ["spawnProc", 'spawnProc("npx", ["tsx", BIN])'],
  ["pty.spawn array", 'pty.spawn("npx", ["tsx"'],
  ["pty.spawn variable args", 'pty.spawn("npx", args, {'],
  ["aliased import", 'spawnProcess("npx", ["tsx", BIN])'],
  ["exec shell string", 'exec("npx tsx BIN attach", cb)'],
  ["execSync shell string", 'execSync("npx tsx " + BIN)'],
  ["single-quoted", "spawn('npx', ['tsx'])"],
  ["space before paren", 'spawn ("npx", ["tsx"])'],
  ["newline before paren", 'pty.spawn\n("npx", args, {'],
  ["windows shim", 'spawn("npx.cmd", ["tsx"])'],
  ["npm exec", 'spawn("npm", ["exec", "tsx", BIN])'],
  ["backtick npx", "spawn(`npx`, [\"tsx\", BIN], {})"],
  ["backtick exec shell string", "exec(`npx tsx BIN attach`, { cwd: root }, () => {})"],
  ["npx.exe", 'spawn("npx.exe", ["tsx"])'],
  ["npx.ps1", 'spawn("npx.ps1", ["tsx"])'],
  ["npm.cmd exec", 'spawn("npm.cmd", ["exec", "tsx"])'],
  ["as const", 'spawn("npx" as const, ["tsx"])'],
  ["non-null bang", 'spawn("npx"!, ["tsx"])'],
  ["extra parens", 'spawn(("npx"), ["tsx"])'],
  ["shell-string npm exec", 'exec("npm exec tsx BIN attach", cb)'],
]; 
for (const [name, src] of positives) check(`banned form IS matched: ${name}`, BANNED.test(src), src);
const negatives: Array<[string, string]> = [
  ["robust form", 'const child = spawn(TSX, [BIN, ...args], options);'],
  ["robust pty", 'pty.spawn(TSX, args, {'],
  ["version.ts kind field", 'return { kind: "npx", root: packageRoot };'],
  ["prose mention", '// Run: npx tsx implementations/auth/smoke/x.smoke.ts'],
  ["prose mention in backticks", "// `npx tsx <missing-file>` exits 1, which is indistinguishable from"],
]; 
for (const [name, src] of negatives) check(`legitimate text is NOT matched: ${name}`, !BANNED.test(src), src);

check(`no smoke source launches the CLI via npx tsx (${files.length} files walked)`, hits.length === 0, hits);

console.log(`\nNO-NPX-TSX ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`);
console.log(`SUITE COMPLETE: ${pass + fail} declared`);
process.exit(fail === 0 ? 0 : 1);
