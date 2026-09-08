/**
 * Fail when a mutation fixture's `find` no longer matches the source it targets.
 *
 * `mutation-proof` proves a suite discriminates by breaking the implementation on purpose and
 * requiring the named assertion to go red. Every mutation anchors on a literal `find` string. When
 * the source moves under it, the mutation stops applying and the tool reports ERROR rather than
 * KILLED — correctly, and to nobody, because nothing in CI runs the fixtures. A rotted anchor
 * merges green and stays green, and the guard it represents quietly stops being enforced.
 *
 * That is a guard whose ABSENCE is invisible, which is the failure mode this repo keeps finding:
 * the check still exists, still looks maintained, and no longer fires. Three anchors were dead on
 * `main` when this was written, all in `packages/core/src/endpoint.ts`, and one of them was killed
 * by a COMMENT-ONLY commit — its `find` embedded two lines of docblock that a later `docs(core)`
 * commit collapsed into one. A semantically inert change disarmed a guard, which is worth stating
 * plainly because "inert" is always inert with respect to some property, and never all of them.
 *
 * WHAT THIS CANNOT SEE, before what it can:
 *
 *   - It does NOT prove the mutation still KILLS. A `find` that matches proves the text is present,
 *     not that the suite still catches its removal, and not that the anchor still sits on the code
 *     the author meant. **A re-anchor onto the wrong block passes this check.** That is the more
 *     dangerous state than rot, because it looks repaired. Only running the fixture proves grading.
 *   - It does NOT prove the fixture is reached by any suite, or that its `command` is gated.
 *   - It reads the source as text, exactly as the tool does. It knows nothing about what the code
 *     means, so a `find` matching a comment rather than a statement is a pass here.
 *
 * What it does prove is narrow and worth having on its own: every anchor in every fixture is still
 * present, exactly once, at this commit — so a mutation that reports ERROR is a live defect rather
 * than a fixture nobody noticed rotting.
 *
 * THIS CLOSES A VISIBILITY GAP, NOT A SILENT-PASS GAP, and the distinction was measured rather
 * than assumed. A dead anchor gives zero occurrences, and `mutation-proof` refuses an absent target
 * before it copies a backup or runs anything, so it grades ERROR — it cannot go green. All three
 * anchors repaired alongside this suite were run in that state and all three ERRORed. The defect is
 * that nothing in CI runs the fixtures at all, so the ERROR is real and addressed to nobody, and in
 * a batch of sixteen it reads as noise. A rotted anchor is a guard that stopped being enforced
 * while still appearing in the tree; this suite is what makes that state say so out loud.
 *
 * Worse, the ERROR is not even reliably reachable by someone looking for it: two of the three sat
 * behind a red baseline, where the tool answers `is red BEFORE any mutation` and never reaches the
 * anchor check at all. Two failure modes stacked, the outer one hiding the inner.
 *
 * DISCOVERY IS BY SHAPE, NOT BY PATH. Any `.json` in the tree with a top-level `mutations` array is
 * a fixture. Globbing `*mutation*` would have been shorter and would miss the one fixture somebody
 * files somewhere unexpected, which is precisely the one nobody is validating.
 */
import {
  readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { parseSuiteSources } from "../../scripts/mutation-suite-metadata.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = new Set(["node_modules", "dist", ".git", ".changeset", "coverage", "build"]);

/**
 * The submodule paths, read from `.gitmodules` rather than named here.
 *
 * A SUBMODULE IS NOT THIS TREE, AND CI DOES NOT CHECK IT OUT. Walking one makes this gate read a
 * different set of files on a developer box than on CI: the anchor count moves with whatever
 * commit the submodule happens to sit at, and a fixture-shaped `.json` inside it gets graded by a
 * gate that CI can never see. That asymmetry is the defect. A gate that is red locally and green
 * on CI does not get fixed, it gets ignored, and an ignored gate is worse than no gate because it
 * still reads as coverage.
 *
 * Parsed from `.gitmodules` instead of hardcoding a directory, so adding a second submodule does
 * not quietly reintroduce this.
 */
function submodulePaths(gitmodules: string): Set<string> {
  if (!existsSync(gitmodules)) return new Set();
  const paths = [...readFileSync(gitmodules, "utf8").matchAll(/^\s*path\s*=\s*(.+)$/gm)];
  return new Set(paths.map((m) => m[1].trim()).filter(Boolean));
}
const SUBMODULES = submodulePaths(join(ROOT, ".gitmodules"));

/** Every `.json` in the tree, minus the directories that hold other people's. */
function jsonFiles(dir: string, out: string[] = [], root = ROOT, skip = SUBMODULES): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (skip.has(relative(root, path))) continue;
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.isDirectory()) jsonFiles(path, out, root, skip);
    else if (entry.endsWith(".json")) out.push(path);
  }
  return out;
}

type Mutation = { name?: string; file?: string; find?: string; allowMultiple?: boolean };

/**
 * Does this anchor include a comment?
 *
 * ANCHOR ON CODE; PROSE IS NOT AN ANCHOR. A `find` that spans a docblock is disarmed by anyone
 * tidying prose, and nothing about a comment edit could ever announce that it disabled a guard.
 * That is not hypothetical: it is how `bind-recovery[0]` died.
 *
 * THE REFUSAL HAS TO NAME THE ALTERNATIVE, because the tool is what sends authors here. Anchoring
 * on a bare code line that occurs twice makes `mutation-proof` refuse an ambiguous target, and the
 * nearest comment is always unique — so "reach for the comment" is the path of least resistance out
 * of a refusal, not carelessness. A rule that forbids the easy answer without naming the hard one
 * gets worked around, and the workaround is what this suite already found. The hard one is: widen
 * to a MULTI-LINE, CODE-ONLY window until it is unique. It works — the three anchors repaired
 * alongside this suite needed windows of one, three and seven lines, and kept their verdicts.
 *
 * Deliberately not a bare `includes("//")`, which would refuse any anchor containing a URL —
 * `nats://` appears in this tree constantly. A refusal that fires on correct fixtures is how a gate
 * gets allowlisted rather than satisfied, so the detector is line-oriented and checks that a `//`
 * is not the tail of a `scheme://`.
 */
function commentLines(find: string): string[] {
  return find.split("\n").filter((raw) => {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("/*") || line.startsWith("*/")) return true;
    if (/^\*\s/.test(line) || line === "*") return true;      // docblock continuation
    return /(^|[^:])\/\/(?!\/)/.test(line) && !/\w+:\/\//.test(line);  // trailing `// note`
  });
}

/**
 * SELF-CHECK: the walk must not enter a submodule.
 *
 * Three cells rather than one, because the obvious cell passes for the wrong reason exactly where
 * it runs. CI does not check the submodule out, so "no fixtures found under it" is true on CI
 * whether the skip works or not; asserting only that absence would be vacuous on the very machine
 * the gate is meant to protect. So: prove the real `.gitmodules` yields a path to skip, then prove
 * the skip on a tree built to contain a planted fixture, with a control proving the same tree
 * WITHOUT the skip does find it.
 */
const selfChecks: string[] = [];
function cell(name: string, ok: boolean): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) selfChecks.push(name);
}

function suiteDiagnosis(value: unknown, sources: Record<string, string> = {}): string | undefined {
  const root = mkdtempSync(join(tmpdir(), "mutation-suite-metadata-probe-"));
  try {
    for (const [path, content] of Object.entries(sources)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    parseSuiteSources(root, "probe/mutations/config.json", value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

cell("missing suite metadata is diagnosed", suiteDiagnosis(undefined)?.includes("MISSING SUITE METADATA") === true);
cell("an empty suite array is diagnosed", suiteDiagnosis([])?.includes("EMPTY SUITE METADATA") === true);
cell("the legacy suite string is diagnosed as malformed", suiteDiagnosis("probe/a.smoke.ts")?.includes("MALFORMED SUITE METADATA") === true);
cell("a non-string suite member is diagnosed as malformed", suiteDiagnosis([42])?.includes("MALFORMED SUITE METADATA") === true);
cell("a syntactically non-path suite member is diagnosed", suiteDiagnosis(["not-a-path"])?.includes("NON-PATH SUITE SOURCE") === true);
cell("a normalized but missing suite source is diagnosed", suiteDiagnosis(["probe/missing.smoke.ts"])?.includes("SUITE SOURCE MISSING") === true);
cell(
  "a valid multi-source suite array passes and every member is checked",
  suiteDiagnosis(["probe/a.smoke.ts", "probe/b.smoke.ts"], {
    "probe/a.smoke.ts": "a\n",
    "probe/b.smoke.ts": "b\n",
  }) === undefined
    && suiteDiagnosis(["probe/a.smoke.ts", "probe/missing.smoke.ts"], { "probe/a.smoke.ts": "a\n" })?.includes("suite[1]") === true,
);

function proofMetadata(value: unknown, configMode = true): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), "mutation-proof-metadata-probe-"));
  try {
    mkdirSync(join(root, "smoke"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "impl.mjs"), "export const value = 1;\n");
    writeFileSync(join(root, "smoke", "suite.mjs"), [
      "import { value } from '../src/impl.mjs';",
      "if (value !== 1) { console.error('FAIL metadata proof control'); process.exit(1); }",
      "console.log('✓ metadata proof control');",
      "",
    ].join("\n"));
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    const mutation = {
      name: "metadata proof control", file: "src/impl.mjs", find: "export const value = 1;",
      replace: "export const value = 2;", expectRed: "metadata proof control",
    };
    const config = { suite: value, command: `${process.execPath} smoke/suite.mjs`, mutations: [mutation] };
    writeFileSync(join(root, "config.json"), JSON.stringify(config));
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.email=smoke@example.test", "-c", "user.name=Smoke", "commit", "--quiet", "-m", "fixture"], { cwd: root });
    const args = configMode
      ? [join(ROOT, "scripts", "mutation-proof.mjs"), "--config", "config.json"]
      : [join(ROOT, "scripts", "mutation-proof.mjs"), "--command", config.command, "--file", mutation.file,
          "--find", mutation.find, "--replace", mutation.replace, "--expect-red", mutation.expectRed];
    const run = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const [name, value, diagnosis] of [
  ["missing", undefined, "MISSING SUITE METADATA"],
  ["empty", [], "EMPTY SUITE METADATA"],
  ["legacy string", "smoke/suite.mjs", "MALFORMED SUITE METADATA"],
  ["non-string member", [42], "MALFORMED SUITE METADATA"],
  ["non-path member", ["suite.mjs"], "NON-PATH SUITE SOURCE"],
  ["missing source", ["smoke/missing.mjs"], "SUITE SOURCE MISSING"],
] as const) {
  const result = proofMetadata(value);
  cell(`mutation-proof config mode rejects ${name} suite metadata`, result.status !== 0 && result.output.includes(diagnosis));
}
const validProof = proofMetadata(["smoke/suite.mjs", "src/impl.mjs"]);
cell("mutation-proof config mode accepts valid multi-source metadata", validProof.status === 0 && validProof.output.includes("KILLED"));
const adHocProof = proofMetadata(undefined, false);
cell("mutation-proof ad-hoc CLI mode remains usable without suite metadata", adHocProof.status === 0 && adHocProof.output.includes("KILLED"));

cell("the real .gitmodules yields at least one submodule path to skip", SUBMODULES.size > 0);

const probe = mkdtempSync(join(tmpdir(), "mutation-fixtures-probe-"));
try {
  mkdirSync(join(probe, "sub"), { recursive: true });
  writeFileSync(
    join(probe, "sub", "planted.mutations.json"),
    JSON.stringify({ mutations: [{ name: "planted", file: "gone.ts", find: "// a prose anchor" }] }),
  );
  cell(
    "a fixture-shaped file inside a submodule path is not walked",
    jsonFiles(probe, [], probe, new Set(["sub"])).length === 0,
  );
  // The control. Without it the cell above proves nothing: a walk that found nothing because the
  // tree was empty reads exactly like a walk that skipped, and only one of those is the guard.
  cell(
    "and the same tree WITHOUT the skip finds it, so the 0 above is a skip and not an empty tree",
    jsonFiles(probe, [], probe, new Set()).length === 1,
  );
} finally {
  rmSync(probe, { recursive: true, force: true });
}

// The real entry point, which the three cells above do not cover: they build their input by hand,
// so they show the walker obeys a skip set, not that the production walk is given one. This cell
// closes that -- and it is only observable when the submodule is actually checked out, so when it
// is not, it says so instead of counting as a pass.
const populated = [...SUBMODULES].filter((p) => {
  const abs = join(ROOT, p);
  try { return readdirSync(abs).length > 0; } catch { return false; }
});
if (populated.length) {
  const leaked = jsonFiles(ROOT)
    .map((p) => relative(ROOT, p))
    .filter((r) => populated.some((s) => r === s || r.startsWith(`${s}/`)));
  cell(
    `the production walk returns nothing from inside ${populated.join(", ")}`,
    leaked.length === 0,
  );
  if (leaked.length) console.log(`      leaked: ${leaked.slice(0, 3).join(", ")}`);
} else {
  console.log("  · submodule not checked out here, so the production-walk cell has nothing to");
  console.log("    observe. It is UNOBSERVED, not passed, and on CI it is always this branch.");
}

const fixtures: { path: string; suite: string[]; mutations: Mutation[] }[] = [];
const metadataProblems: string[] = [];
for (const path of jsonFiles(ROOT)) {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
  const cfg = parsed as { suite?: unknown; mutations?: unknown };
  if (!Array.isArray(cfg.mutations)) continue;
  const rel = relative(ROOT, path);
  try {
    fixtures.push({ path, suite: parseSuiteSources(ROOT, rel, cfg.suite), mutations: cfg.mutations as Mutation[] });
  } catch (error) {
    metadataProblems.push(error instanceof Error ? error.message : `${rel}: ${String(error)}`);
  }
}

if (metadataProblems.length) {
  console.log(`✗ FAIL: ${metadataProblems.length} mutation fixture(s) have invalid suite metadata:`);
  for (const problem of metadataProblems) console.log(`  ✗ ${problem}`);
  process.exit(1);
}

// An empty discovery is an ERROR, not a fast pass. A walker that finds nothing and exits 0 reports
// the same thing as a walker that checked everything — the defect this suite exists to prevent,
// one level up.
if (fixtures.length === 0) {
  console.log("✗ FAIL: no mutation fixtures found at all. Either the tree moved or the walk is broken;");
  console.log("        either way this suite cannot have checked anything, so it is not a pass.");
  process.exit(1);
}

let checked = 0;
const stale: string[] = [];
const ambiguous: string[] = [];
const missing: string[] = [];
const prose: string[] = [];

for (const { path, mutations } of fixtures) {
  const rel = relative(ROOT, path);
  const problems: string[] = [];
  let here = 0;

  mutations.forEach((m, i) => {
    const where = `${rel} [${i}] ${m.name ?? "(unnamed)"}`;
    if (typeof m.file !== "string" || typeof m.find !== "string") {
      missing.push(where);
      problems.push(`  ✗ [${i}] has no \`file\` or no \`find\`, so it names no anchor at all.`);
      return;
    }
    const target = join(ROOT, m.file);
    if (!existsSync(target)) {
      missing.push(where);
      problems.push(`  ✗ [${i}] TARGET FILE MISSING: ${m.file}`);
      return;
    }
    checked++;
    here++;

    // Checked BEFORE the match count, because an anchor spanning prose is wrong even while it
    // still matches. Reporting it only once it has already rotted would be reporting the damage
    // instead of the cause.
    const comments = commentLines(m.find);
    if (comments.length) {
      prose.push(where);
      problems.push(
        `  ✗ [${i}] ANCHOR SPANS A COMMENT — ${comments.length} comment line(s) in \`find\`\n` +
        `        ${m.name ?? "(unnamed)"}\n` +
        `        ${comments.map((c) => c.trim()).slice(0, 2).map((c) => `> ${c.slice(0, 88)}`).join("\n        ")}\n` +
        `        Anchor on code. A \`find\` that spans prose is disarmed by anyone tidying prose,\n` +
        `        and a comment-only commit cannot announce that it disabled a guard.\n` +
        `        INSTEAD OF REACHING FOR THE COMMENT: widen to a multi-line, CODE-ONLY window until\n` +
        `        it is unique. A bare code line that occurs twice makes mutation-proof refuse an\n` +
        `        ambiguous target, and the nearest comment is always unique — which is why this\n` +
        `        keeps happening. More code lines resolve the ambiguity just as well, and nothing\n` +
        `        a docs commit can touch is load-bearing afterwards.`,
      );
    }

    // Count the same way the tool applies it: `src.split(find).join(replace)`.
    const hits = readFileSync(target, "utf8").split(m.find).length - 1;

    // Three outcomes, three diagnoses. A gate that calls all of them "invalid fixture" sends the
    // reader to the wrong repair: rot needs a re-anchor, ambiguity needs a longer anchor or an
    // explicit `allowMultiple`, and they are not the same mistake.
    if (hits === 0) {
      stale.push(where);
      problems.push(
        `  ✗ [${i}] ANCHOR IS DEAD — \`find\` matches 0x in ${m.file}\n` +
        `        ${m.name ?? "(unnamed)"}\n` +
        `        The source moved under this mutation, so it applies to nothing and grades ERROR.\n` +
        `        Re-anchor it on the current code AND re-run the fixture: an anchor that matches\n` +
        `        again is not the same claim as a mutation that still kills.`,
      );
    } else if (hits > 1 && !m.allowMultiple) {
      ambiguous.push(where);
      problems.push(
        `  ✗ [${i}] ANCHOR IS AMBIGUOUS — \`find\` matches ${hits}x in ${m.file}\n` +
        `        ${m.name ?? "(unnamed)"}\n` +
        `        The tool replaces EVERY occurrence, so this mutates ${hits} sites while claiming one.\n` +
        `        Lengthen the anchor with MORE CODE LINES until it is unique — not with the nearest\n` +
        `        comment, which is unique for free and is why the other half of this suite exists.\n` +
        `        Or set \`allowMultiple\` to say you meant every site.`,
      );
    }
  });

  // One line per fixture either way. A walker that prints only failures reports the same thing on
  // "every anchor is good" as on "the walk never reached this file", and the second is how a gate
  // stops covering something without ever saying so.
  if (problems.length) console.log(`\n${rel}\n${problems.join("\n")}`);
  else console.log(`  ✓ ${rel} — ${here} anchor(s) present and unique`);
}

const failed = stale.length + ambiguous.length + missing.length + prose.length + selfChecks.length;
console.log(`\n${fixtures.length} fixture file(s), ${checked} anchor(s) checked at this commit`);
console.log(`  dead anchors:        ${stale.length}`);
console.log(`  ambiguous anchors:   ${ambiguous.length}`);
console.log(`  anchors spanning prose: ${prose.length}`);
console.log(`  missing file/key:    ${missing.length}`);
console.log(`  walk self-checks failed: ${selfChecks.length}`);
// The caveat belongs where the verdict is read, not only in the prologue: a ✓ reads as "the
// fixtures are good" unless it says otherwise in the same breath.
console.log(
  failed === 0
    ? `\nMUTATION FIXTURES OK ✅  (every anchor is PRESENT and unique — this does not prove any of them still kills)`
    : `\nMUTATION FIXTURES FAILED ❌  (${failed} anchor(s) need repair)`,
);
process.exit(failed === 0 ? 0 : 1);
