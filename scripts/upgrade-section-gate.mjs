#!/usr/bin/env node
/**
 * Does every BREAKING change carry an operator upgrade section?
 *
 * The defect this exists for (Cotal #1578): 0.49.0 changed how a credential's authority is
 * recorded, an operator with an existing 30-agent deployment could not tell whether their
 * credentials survived or which side of a split topology to upgrade first, and the repository
 * carried no UPGRADING.md at all. The release body was 35k characters and mentioned migration
 * nowhere. Nothing in CI noticed, because nothing was looking.
 *
 * So this looks. A change is BREAKING when it says so in the vocabulary this repository already
 * uses, and it must be accompanied by a section in `docs/UPGRADING.md`.
 *
 * WHAT COUNTS AS BREAKING, and why it is not the changesets bump level alone. The obvious design
 * is "a changeset at `major`". Measured before building this: the tree carries ZERO changesets at
 * `major`, and none is reachable in history either, while 0.49.0 broke a deployment anyway. A gate
 * keyed on that marker would have an accept control that returns nothing, would pass forever, and
 * would be a gate grading nothing. The markers this repository ACTUALLY uses are the conventional
 * `!` in a commit subject (`feat(core)!: …`) and the `BREAKING CHANGE` footer; the
 * v0.48.2..v0.49.0 range carries two of the former. So all three are accepted as the breaking
 * signal, and the `major` changeset is included so the gate is already correct on the day someone
 * writes one rather than needing a second change then.
 *
 * WHAT COUNTS AS A SECTION. An `##` or `###` heading under `docs/UPGRADING.md` that is not one of
 * the page's structural headings. The check is deliberately shallow about the section's CONTENT:
 * a gate that graded prose would be a gate people route around, and the reviewer is better placed
 * to judge whether a section is any good. What it can enforce is that the section EXISTS and is
 * not empty, which is the part that silently does not happen.
 *
 *   node scripts/upgrade-section-gate.mjs --self-test   grade this tool against its own controls
 *   node scripts/upgrade-section-gate.mjs --base <ref>   check <ref>..HEAD
 *   node scripts/upgrade-section-gate.mjs --range a..b   check an arbitrary range (replay a release)
 *   node scripts/upgrade-section-gate.mjs --merge-snapshot   check a pull request's own range,
 *       derived as HEAD^1..HEAD from a checked-out merge commit. Refuses anything else, because
 *       on a single-parent checkout HEAD^1 is the previous commit and the range silently shrinks.
 *
 * Exit 0 when every breaking commit in range is covered, 1 when one is not, 2 on misuse.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export const UPGRADING_PATH = join("docs", "UPGRADING.md");

/** The page's own furniture. A section that merely restates the contract is not a release section,
 *  and counting it would let an empty release pass on the strength of the header. */
export const STRUCTURAL_HEADINGS = Object.freeze([
  "The pre-1.0 upgrade contract",
  "Adding a section for a future release",
]);

/**
 * Is this commit subject + body a declared breaking change?
 *
 * The `!` must sit in the conventional-commit TYPE, before the colon, so a subject that merely
 * contains an exclamation mark in its prose is not a false positive. The footer form is matched on
 * its own line, which is where the convention puts it.
 */
export function isBreakingCommit(subject, body = "") {
  if (/^[a-z]+(?:\([^)]*\))?!:/.test(subject.trim())) return true;
  return /^BREAKING[ -]CHANGE:/m.test(body);
}

/** Package names whose changeset front-matter declares a `major` bump. */
export function majorChangesetPackages(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return [];
  const parsed = parseYaml(m[1]);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("changeset front matter must be a YAML mapping of package names to bump levels");
  return Object.entries(parsed).filter(([, bump]) => bump === "major").map(([pkg]) => pkg);
}

/** Is this changeset front-matter a `major` bump for any package? */
export function isBreakingChangeset(text) {
  return majorChangesetPackages(text).length > 0;
}

/**
 * A release section's heading must NAME what it covers, and that is a load-bearing rule rather
 * than a style preference. Coverage is claimed by a heading, so a heading that names no release
 * lets any prose satisfy the gate: "Notes", "Misc", or a subsection title carried along with an
 * unrelated edit. Requiring a version token means the section a reviewer is pointed at is the one
 * an operator upgrading THAT release will search for.
 *
 * Deliberately permissive about SHAPE and strict about PRESENCE: `0.49.0`, `v0.49.0`, `0.48.2 to
 * 0.49.0` and `0.50` all qualify, because the project has used several spellings and a gate that
 * dictated one would be refused around rather than obeyed.
 */
export function namesARelease(title) {
  return /\bv?\d+\.\d+(\.\d+)?\b/.test(title);
}

/**
 * The release sections a page declares, with whether each carries any body text.
 *
 * ONLY `##` COUNTS, NOT `###`. A release section is a top-level entry on this page; its
 * subsections are part of it, not additional coverage. Counting them inflated an honest one-section
 * release into "8 new sections added" in this tool's own output, which is noise a reader has to
 * discount, and noise in a gate's output is how a gate stops being read.
 *
 * Fenced blocks are skipped: a shell transcript containing a `#` comment is not a heading, and a
 * gate that read one as a section would count a code sample as coverage.
 */
export function sectionsOf(markdown) {
  const out = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^ {0,3}```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const h = /^(##)\s+(.+?)\s*$/.exec(line);
    if (h) { out.push({ title: h[2], body: "" }); continue; }
    // A HEADING OF ANY DEPTH IS STRUCTURE, NEVER BODY. `###` does not open a release section, but it
    // must not accrue as PROSE either: a section whose entire body is subsection headings says
    // nothing to an operator while satisfying a naive "is the body non-empty" test. That was a real
    // defect here, and it is M5 one nesting level down. Skipping the line at its source is what
    // makes the hollow case unrepresentable rather than merely filtered later.
    if (/^ {0,3}#{1,6}\s/.test(line)) continue;
    // Prose accrues to the open release section THROUGH its subsections, so a section whose words
    // all live under `###` headings still reads as non-empty.
    if (out.length && line.trim()) out[out.length - 1].body += line;
  }
  return out.filter((s) => !STRUCTURAL_HEADINGS.includes(s.title));
}

/** Release sections that actually say something AND name the release they cover. An empty heading
 *  is not coverage, and neither is a heading that could belong to any release. */
export function coveringSections(markdown) {
  return sectionsOf(markdown)
    .filter((s) => s.body.trim().length > 0 && namesARelease(s.title))
    .map((s) => s.title);
}

/**
 * The release sections `headPage` adds over `basePage`, by title.
 *
 * EXPORTED, AND THAT IS THE POINT RATHER THAN TIDINESS. This difference was originally computed
 * inline inside the CLI, where no cell could reach it, and a mutation that replaced it with a
 * head-only read SURVIVED the whole suite: every cell passed while the gate answered "does the
 * page have sections" (which every page does forever after its first release) instead of "did THIS
 * range write one". The mutation tool's own positive control proved the suite reached the file and
 * simply did not test that line. A predicate the suite cannot call is a predicate nothing grades.
 */
export function addedSectionsBetween(basePage, headPage) {
  const before = new Set(coveringSections(basePage));
  return coveringSections(headPage).filter((s) => !before.has(s));
}

/**
 * The verdict for one range.
 *
 * `breaking` are the commits that declared themselves breaking. `addedSections` are the non-empty
 * release sections THIS RANGE ADDED to the page, base compared against head.
 *
 * THE PREDICATE IS "ADDED A SECTION", NOT "TOUCHED THE FILE", AND THE DIFFERENCE IS THE WHOLE
 * GATE. Measured on the first version of this tool, which asked only whether the diff touched the
 * path: a breaking commit shipped beside a ONE-LINE TYPO FIX on this page passed, "covered by 8
 * section(s)", every one of them written for an earlier release. That is worse than it looks,
 * because it decays: every section the page ever accumulates becomes permanent pre-coverage for
 * every future break, so the gate gets weaker precisely as the page gets longer. It is also the
 * reporter's own failure reintroduced one level up, since it greens a breaking release that did no
 * upgrade work at all.
 *
 * The comparison is deliberately by section TITLE rather than by content. A range that edits an
 * existing section does not read as coverage, which is correct: amending the 0.48.2 section is not
 * documenting a 0.50.0 break. It also means the gate cannot be satisfied by rewording, only by
 * writing something that was not there.
 *
 * What it still does NOT do is match a breaking commit to a SPECIFIC section, because a release's
 * section is written once for several breaking commits and any such rule would be guesswork
 * wearing a rule's clothes. What it asserts is that a range which broke something also WROTE
 * something new here.
 */
/** Which OTHER job names a document still claims runs the gate.
 *
 *  PURE, EXPORTED, AND TESTED AGAINST BUILT INPUTS, because the live repository is the one input
 *  that cannot prove this works. When the docs are correct, deleting this check changes nothing
 *  observable, so a cell that only reads the real files passes either way and is decoration.
 *  Measured: three mutations disabling the live-file cells all SURVIVED for exactly that reason.
 *  The self-test therefore drives this function with documents it writes itself, one carrying a
 *  known stale claim and one clean, so the cells fail when the detector is broken rather than when
 *  the repository happens to be dirty.
 *
 *  `hostJob` is read from the workflow at the call site rather than passed as a constant, so moving
 *  the step makes every document that names the old job go red until the prose follows it. */
export function staleJobClaims(text, hostJob, candidates) {
  // CANDIDATES ARE REQUIRED, NOT DEFAULTED, AND THAT IS THE POINT OF THIS SIGNATURE.
  //
  // An earlier version defaulted to ["unit", "ci-ok"], the two jobs that had actually gone stale.
  // Found by review, end to end rather than by reading: a page naming the CORRECT host AND ALSO a
  // false third job passed everything. The positive cell was satisfied because the right job
  // appeared, and the refuse leg never looked at the third because it was not in the hard-coded
  // pair. That is a page simultaneously correct and false, shipping green, and it is the exact
  // shape this leg exists to catch, surviving for any job outside those two.
  //
  // Callers pass the jobs the repository actually defines, so the leg tracks the workflows the way
  // the host lookup already does. A literal list can only ever notice yesterday's mistake.
  if (!Array.isArray(candidates) || candidates.length === 0)
    throw new Error("staleJobClaims: candidates must be a non-empty array of job names read from the workflows");
  return candidates.filter((j) => j !== hostJob
    && new RegExp(`(runs?|grades?|grading path is|step (?:in|of)|in) the .${j}. job`).test(text));
}

export function verdict({ breaking, addedSections }) {
  // "no breaking commits DETECTED", never "no breaking commits". The gate reads markers, and the
  // design note is explicit that no marker-keyed detector can see an unmarked break, so a pass
  // asserting ABSENCE would have the script contradicting its own note on the one line an
  // operator actually reads. The honest claim is about what was detected, which is also the only
  // claim the evidence supports.
  if (breaking.length === 0) return { ok: true, reason: "no breaking commits DETECTED in range (unmarked breaks are invisible to this check)" };
  if (addedSections.length === 0)
    return { ok: false, reason: `${breaking.length} breaking change(s) and no new ${UPGRADING_PATH} section in the same range` };
  return { ok: true, reason: `${breaking.length} breaking change(s) covered by ${addedSections.length} new section(s): ${addedSections.join(", ")}` };
}

// ---- self-test ---------------------------------------------------------------------------------

const PAGE = `# Upgrading a running deployment

## The pre-1.0 upgrade contract

Pin an exact version.

## From 0.48.2 to 0.49.0

A credential minted before 0.49.0 cannot be renewed.

## Adding a section for a future release

Every changeset marked breaking adds a section.
`;

/** The repository this script is shipped inside, found from the script's own location rather than
 *  from `process.cwd()`. The self-test asserts facts about THIS repository's workflows and docs, so
 *  it must not depend on where the caller happened to be standing. */
function repoRootForDocs() {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

if (process.argv.includes("--self-test")) {
  let pass = 0, fail = 0, skipped = 0;
  const cell = (name, ok, detail) => {
    if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ FAIL: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`); }
  };
  // UNGRADED IS A THIRD STATE AND IT MUST BE LOUD. A cell that needs real release history cannot
  // be graded in a shallow checkout, and pretending otherwise gives two bad options: a false red
  // (the tool is fine, the clone is cut) or a false green (nothing ran, everything "passed").
  // Skips are counted separately and named in the summary, so a reader can never mistake a run
  // that skipped its history cells for one that proved them.
  const skip = (name, why = "needs full release history; this checkout is shallow") => {
    skipped += 1;
    console.log(`  - UNGRADED: ${name} (${why})`);
  };
  const historyIsTruncated = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).stdout.trim() === "true";

  // THE THREE LEGS, IN ONE INVOCATION. The third is the one that makes the other two mean
  // something: without it a gate that reds on EVERY changeset is indistinguishable from a gate
  // that detects breaking ones.

  // LEG 1, ACCEPT CONTROL: breaking, no new section. MUST RED, and must name what it caught.
  const v1 = verdict({ breaking: ["feat(core)!: bind hosted runs"], addedSections: [] });
  cell("ACCEPT CONTROL: a breaking change with no new UPGRADING.md section is REFUSED", v1.ok === false, v1);
  cell("…and the refusal names the breaking change it caught", /breaking change/.test(v1.reason), v1.reason);

  // LEG 2, REFUSE CONTROL: breaking, with a section. MUST STAY GREEN.
  const v2 = verdict({ breaking: ["feat(core)!: bind hosted runs"], addedSections: ["From 0.48.2 to 0.49.0"] });
  cell("REFUSE CONTROL: a breaking change WITH its section passes", v2.ok === true, v2);

  // LEG 3, REFUSE CONTROL: non-breaking, no section. MUST STAY GREEN, i.e. the gate is keyed on
  // BREAKING and not on "a changeset exists".
  const v3 = verdict({ breaking: [], addedSections: [] });
  cell("REFUSE CONTROL: a NON-breaking change with no section passes (not vacuously red)", v3.ok === true, v3);

  // LEG 4, THE TOO-WIDE LEG, AND THE REASON THE PREDICATE CHANGED. The first version of this gate
  // asked only whether the diff TOUCHED the page, and a breaking commit beside a one-line typo fix
  // passed on eight sections written for earlier releases. Nothing in the original five cells
  // walked it: every one held the touched-flag fixed and varied something else, so the cells all
  // graded the rule the author was thinking about. `addedSections` is a base-to-head difference,
  // so an edit that adds no NEW section is now indistinguishable from not touching the page, which
  // is exactly the intent.
  const v5 = verdict({ breaking: ["feat(core)!: a future break"], addedSections: [] });
  cell("TOO WIDE: a breaking change beside an edit that adds NO new section is REFUSED", v5.ok === false, v5);
  cell("…and the refusal says NO NEW section rather than no edit", /no new/.test(v5.reason), v5.reason);

  // The named-sections half: a green must say WHICH section covered it, so a reviewer reading CI
  // output can tell a real section from a stale one without opening the page.
  cell("a passing verdict names the new section it was covered by",
    /From 0\.48\.2 to 0\.49\.0/.test(v2.reason), v2.reason);

  // The section DIFFERENCE, through the SAME exported function the CLI calls. Calling it here is
  // what makes it gradable: while this was inline in the CLI, a head-only mutant survived the
  // entire suite with every cell green.
  const reworded = PAGE.replace("A credential minted before 0.49.0 cannot be renewed.", "Reworded entirely, same heading.");
  cell("REFUSE CONTROL: rewording an EXISTING section adds no new section",
    addedSectionsBetween(PAGE, reworded).length === 0, addedSectionsBetween(PAGE, reworded));
  const grown = `${PAGE}\n## From 0.49.0 to 0.50.0\n\nA real new section.\n`;
  cell("a genuinely NEW section is seen as added",
    addedSectionsBetween(PAGE, grown).join() === "From 0.49.0 to 0.50.0", addedSectionsBetween(PAGE, grown));
  // THE BIRTH CASE, AND WHY IT IS A BOUNDED CASE RATHER THAN A LOOPHOLE. A page absent at base has
  // no sections at base, so every section at head is genuinely new and the range that INTRODUCES
  // the page passes the gate the same change adds. Without it this very change would be refused by
  // its own check. It cannot be exploited twice: it is reachable only while the page does not
  // exist, and after the first release every later range is measured against a page that does. The
  // escape is closed by the page existing, not by anyone remembering to close it.
  cell("the range that CREATES the page counts all its sections as added (reachable only once, while the page is absent)",
    addedSectionsBetween("", PAGE).join() === "From 0.48.2 to 0.49.0", addedSectionsBetween("", PAGE));
  // And the head-only failure mode stated as its own cell, so the property is named rather than
  // implied: an unchanged page adds nothing, however many sections it carries.
  cell("REFUSE CONTROL: an UNCHANGED page adds no sections, however many it has",
    addedSectionsBetween(PAGE, PAGE).length === 0 && coveringSections(PAGE).length > 0,
    { added: addedSectionsBetween(PAGE, PAGE), has: coveringSections(PAGE).length });

  // The breaking-marker reader, both directions.
  cell("a `!` in the conventional type is read as breaking", isBreakingCommit("feat(core)!: bind hosted runs to issued authority"));
  cell("a BREAKING CHANGE footer is read as breaking", isBreakingCommit("feat(core): x", "body\n\nBREAKING CHANGE: the rail moved"));
  cell("REFUSE CONTROL: an ordinary subject is NOT breaking", isBreakingCommit("fix(core): drain conn A when startup rejects") === false);
  cell("REFUSE CONTROL: an exclamation mark in PROSE is not a breaking marker",
    isBreakingCommit("fix(cli): stop printing 'done!' before the work finishes") === false);

  // The changeset reader, both directions.
  cell("a `major` changeset is read as breaking", isBreakingChangeset('---\n"@cotal-ai/core": major\n---\n\nbody'));
  cell("REFUSE CONTROL: a patch changeset is not", isBreakingChangeset('---\n"@cotal-ai/core": patch\n---\n\nbody') === false);
  cell("REFUSE CONTROL: the word major in a changeset BODY is not a bump",
    isBreakingChangeset('---\n"@cotal-ai/core": patch\n---\n\nthis is a major improvement') === false);
  cell("a double-quoted major value is read the same way release tooling reads it",
    majorChangesetPackages('---\n"@cotal-ai/core": "major"\n---\n').join() === "@cotal-ai/core");
  cell("a single-quoted package and major value are accepted YAML",
    majorChangesetPackages("---\n'@cotal-ai/core': 'major'\n---\n").join() === "@cotal-ai/core");
  cell("an inline YAML map declaring major is a breaking changeset",
    majorChangesetPackages('---\n{"@cotal-ai/core": major}\n---\n').join() === "@cotal-ai/core");
  cell("malformed changeset YAML refuses loudly rather than becoming a clean no-signal",
    (() => { try { majorChangesetPackages('---\n"@cotal-ai/core": [\n---\n'); return false; } catch { return true; } })());

  // CHANGESET SIGNALS ARE RANGE-LOCAL, just like commits and upgrade sections. A major file that
  // already exists at the base is pending work from another range, not a new breaking declaration
  // by this one. Counting every major file at the head makes an unrelated README edit fail until
  // somebody writes a duplicate upgrade section. These repositories exercise the real CLI rather
  // than only the front-matter parser: unchanged major stays quiet, while a new major and a
  // patch-to-major transition both refuse.
  {
    const tmp = mkdtempSync(join(tmpdir(), "upgrade-gate-changesets-"));
    const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
    const build = (name, baseBump, headBump) => {
      const dir = join(tmp, name);
      mkdirSync(dir);
      git(["init", "-q", "."], dir);
      git(["config", "user.email", "selftest@example.invalid"], dir);
      git(["config", "user.name", "selftest"], dir);
      mkdirSync(join(dir, ".changeset"));
      mkdirSync(join(dir, "docs"));
      writeFileSync(join(dir, "docs", "UPGRADING.md"), "# Upgrading\n\n## From 1.0 to 2.0\n\nExisting guidance.\n");
      if (baseBump) writeFileSync(join(dir, ".changeset", "existing.md"), baseBump.startsWith("---") ? baseBump : `---\n"@cotal-ai/core": ${baseBump}\n---\n\nbase\n`);
      writeFileSync(join(dir, "README.md"), "base\n");
      git(["add", "."], dir);
      git(["commit", "-qm", "chore: base"], dir);
      if (headBump) writeFileSync(join(dir, ".changeset", "existing.md"), headBump.startsWith("---") ? headBump : `---\n"@cotal-ai/core": ${headBump}\n---\n\nhead\n`);
      writeFileSync(join(dir, "README.md"), "head\n");
      git(["add", "."], dir);
      git(["commit", "-qm", "docs: unrelated readme edit"], dir);
      return dir;
    };
    const run = (dir) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--range", "HEAD^..HEAD"], { cwd: dir, encoding: "utf8" });
    const buildLayouts = (name, baseFiles, headFiles) => {
      const dir = join(tmp, name);
      mkdirSync(dir);
      git(["init", "-q", "."], dir);
      git(["config", "user.email", "selftest@example.invalid"], dir);
      git(["config", "user.name", "selftest"], dir);
      mkdirSync(join(dir, ".changeset"));
      mkdirSync(join(dir, "docs"));
      writeFileSync(join(dir, "docs", "UPGRADING.md"), "# Upgrading\n\n## From 1.0 to 2.0\n\nExisting guidance.\n");
      for (const [name, text] of Object.entries(baseFiles)) writeFileSync(join(dir, ".changeset", name), text);
      git(["add", "."], dir);
      git(["commit", "-qm", "chore: base"], dir);
      for (const name of readdirSync(join(dir, ".changeset"))) rmSync(join(dir, ".changeset", name));
      for (const [name, text] of Object.entries(headFiles)) writeFileSync(join(dir, ".changeset", name), text);
      writeFileSync(join(dir, "README.md"), "head\n");
      git(["add", "."], dir);
      git(["commit", "-qm", "docs: rearrange changesets"], dir);
      return dir;
    };
    const unchangedMajor = run(build("unchanged-major", "major", null));
    const noMajor = run(build("no-major", null, null));
    const newMajor = run(build("new-major", null, "major"));
    const quotedMajor = run(build("quoted-major", null, '---\n"@cotal-ai/core": "major"\n---\n\nhead\n'));
    const inlineMajor = run(build("inline-major", null, '---\n{"@cotal-ai/core": major}\n---\n\nhead\n'));
    const malformedMajor = run(build("malformed-major", null, '---\n"@cotal-ai/core": [\n---\n\nhead\n'));
    const raisedMajor = run(build("patch-to-major", "patch", "major"));
    const baseOnlyCoreMajor = '---\n"@cotal-ai/core": major\n---\n\nbase\n';
    const baseCoreMajorAuthPatch = '---\n"@cotal-ai/core": major\n"@cotal-ai/auth": patch\n---\n\nbase\n';
    const headTwoMajors = '---\n"@cotal-ai/core": major\n"@cotal-ai/auth": major\n---\n\nhead\n';
    const headOnlyCorePatch = '---\n"@cotal-ai/core": patch\n---\n\nhead\n';
    const addedBesideMajor = run(build("add-major-beside-major", baseOnlyCoreMajor, headTwoMajors));
    const raisedBesideMajor = run(build("raise-major-beside-major", baseCoreMajorAuthPatch, headTwoMajors));
    const removedMajor = run(build("remove-major", baseOnlyCoreMajor, headOnlyCorePatch));
    const coreMajor = '---\n"@cotal-ai/core": major\n---\n\ncore\n';
    const authMajor = '---\n"@cotal-ai/auth": major\n---\n\nauth\n';
    const bothMajors = '---\n"@cotal-ai/core": major\n"@cotal-ai/auth": major\n---\n\nboth\n';
    const renamed = run(buildLayouts("rename-major", { "old-name.md": coreMajor }, { "new-name.md": coreMajor }));
    const replaced = run(buildLayouts("replace-major", { "old-name.md": coreMajor }, { "replacement.md": coreMajor }));
    const split = run(buildLayouts("split-major", { "both.md": bothMajors }, { "core.md": coreMajor, "auth.md": authMajor }));
    const merged = run(buildLayouts("merge-major", { "core.md": coreMajor, "auth.md": authMajor }, { "both.md": bothMajors }));
    const addedAcrossFiles = run(buildLayouts("add-package-across-files", { "core.md": coreMajor }, { "core.md": coreMajor, "auth.md": authMajor }));
    cell("REFUSE CONTROL: an unchanged base major changeset does not block unrelated work",
      unchangedMajor.status === 0, { status: unchangedMajor.status, stdout: unchangedMajor.stdout, stderr: unchangedMajor.stderr });
    cell("REFUSE CONTROL: a range with no major changeset still passes",
      noMajor.status === 0, { status: noMajor.status });
    cell("a newly introduced major changeset is a breaking signal for this range",
      newMajor.status === 1 && /new major packages/.test(newMajor.stdout), { status: newMajor.status, stdout: newMajor.stdout });
    cell("a valid quoted-major changeset refuses through the production CLI",
      quotedMajor.status === 1 && /new major packages/.test(quotedMajor.stdout), { status: quotedMajor.status, stdout: quotedMajor.stdout });
    cell("a valid inline-map major changeset refuses through the production CLI",
      inlineMajor.status === 1 && /new major packages/.test(inlineMajor.stdout), { status: inlineMajor.status, stdout: inlineMajor.stdout });
    cell("malformed changeset YAML is a misuse, never a clean no-signal",
      malformedMajor.status === 2 && /could not run/.test(malformedMajor.stderr),
      { status: malformedMajor.status, stdout: malformedMajor.stdout, stderr: malformedMajor.stderr });
    cell("changing an existing changeset from patch to major is a breaking signal",
      raisedMajor.status === 1 && /new major packages/.test(raisedMajor.stdout), { status: raisedMajor.status, stdout: raisedMajor.stdout });
    cell("adding a second major package beside an existing major is a new breaking signal",
      addedBesideMajor.status === 1 && /new major packages/.test(addedBesideMajor.stdout),
      { status: addedBesideMajor.status, stdout: addedBesideMajor.stdout });
    cell("promoting a package from patch to major is seen even beside an existing major",
      raisedBesideMajor.status === 1 && /new major packages/.test(raisedBesideMajor.stdout),
      { status: raisedBesideMajor.status, stdout: raisedBesideMajor.stdout });
    cell("REFUSE CONTROL: removing a major package is not a new breaking signal",
      removedMajor.status === 0, { status: removedMajor.status, stdout: removedMajor.stdout, stderr: removedMajor.stderr });
    cell("REFUSE CONTROL: renaming a changeset file preserves the global major-package set",
      renamed.status === 0, { status: renamed.status, stdout: renamed.stdout, stderr: renamed.stderr });
    cell("REFUSE CONTROL: replacing a changeset filename with the same package signal stays green",
      replaced.status === 0, { status: replaced.status, stdout: replaced.stdout, stderr: replaced.stderr });
    cell("REFUSE CONTROL: splitting one changeset into two preserves the global package set",
      split.status === 0, { status: split.status, stdout: split.stdout, stderr: split.stderr });
    cell("REFUSE CONTROL: merging two changesets into one preserves the global package set",
      merged.status === 0, { status: merged.status, stdout: merged.stdout, stderr: merged.stderr });
    cell("adding a major package in a different changeset file still refuses",
      addedAcrossFiles.status === 1 && /@cotal-ai\/auth/.test(addedAcrossFiles.stdout),
      { status: addedAcrossFiles.status, stdout: addedAcrossFiles.stdout });
    const linkedGate = join(tmp, "gate-link.mjs");
    symlinkSync(fileURLToPath(import.meta.url), linkedGate);
    const throughLink = spawnSync(process.execPath, [linkedGate, "--range", "HEAD^..HEAD"], { cwd: join(tmp, "new-major"), encoding: "utf8" });
    cell("invoking the gate through a symlink still executes and grades the range",
      throughLink.status === 1 && /REFUSED/.test(throughLink.stdout),
      { status: throughLink.status, stdout: throughLink.stdout, stderr: throughLink.stderr });
    rmSync(tmp, { recursive: true, force: true });
  }

  // The section reader. The live page is the accept control for it, so a reader that has quietly
  // stopped parsing headings cannot pass by returning nothing.
  const sections = coveringSections(PAGE);
  cell("the section reader finds a release section on a real page", sections.includes("From 0.48.2 to 0.49.0"), sections);
  cell("…and excludes the page's own structural headings",
    !sections.includes("The pre-1.0 upgrade contract") && !sections.includes("Adding a section for a future release"), sections);
  // THE DECOY INSIDE THE FENCE MUST BE ONE THAT WOULD COUNT IF FENCING BROKE. This fixture
  // previously used `## Real` outside and `## Not a heading` inside, and once headings had to name
  // a release NEITHER qualified: the cell went green on a page with no sections at all, proving
  // nothing about fences. The decoy now names a release, so if fence-skipping regresses this cell
  // sees 2 and reds.
  const fencePage = "## From 0.49.0 to 0.50.0\n\nbody\n\n```bash\n## From 0.50.0 to 0.51.0\ncotal up\n```\n";
  cell("REFUSE CONTROL: a release heading inside a fenced block is not a section",
    coveringSections(fencePage).join() === "From 0.49.0 to 0.50.0", coveringSections(fencePage));
  cell("REFUSE CONTROL: an empty section is not coverage", coveringSections("## Empty 0.50.0\n\n## Also empty 0.51.0\n").length === 0);

  // THE HOLLOW SECTION: a section whose entire body is SUBSECTION HEADINGS. This shipped as a real
  // defect and no cell walked it, because the empty-heading fixture above has no subsections. A
  // heading is structure at every depth, so heading text must never satisfy "the body is non-empty".
  const hollow = "## From 0.49.0 to 0.50.0\n### What changed\n### What to do\n";
  cell("REFUSE CONTROL: a section whose body is only SUBSECTION HEADINGS is not coverage",
    coveringSections(hollow).length === 0, coveringSections(hollow));
  const hollowDeep = "## From 0.49.0 to 0.50.0\n### A\n#### B\n##### C\n";
  cell("…at any heading depth", coveringSections(hollowDeep).length === 0, coveringSections(hollowDeep));
  // The paired accept control, which is what stops the fix from over-correcting: REAL prose under a
  // subsection is still coverage. Without this cell, "reds on hollow sections" and "reds on every
  // section that uses subsections" are the same measurement.
  const proseUnderSub = "## From 0.49.0 to 0.50.0\n\n### Detail\n\nreal prose under the subsection\n";
  cell("ACCEPT CONTROL: real prose under a subsection IS coverage",
    coveringSections(proseUnderSub).join() === "From 0.49.0 to 0.50.0", coveringSections(proseUnderSub));

  // THE HEADING MUST NAME THE RELEASE. Coverage is claimed by a heading, so a heading that names
  // no release lets any prose satisfy the gate.
  cell("a heading that NAMES a release is coverage", namesARelease("From 0.48.2 to 0.49.0"));
  cell("…in the spellings the project actually uses",
    ["0.49.0", "v0.49.0", "From 0.48.2 to 0.49.0", "Upgrading to 0.50"].every(namesARelease));
  cell("REFUSE CONTROL: a heading that names NO release is not coverage",
    ["Notes", "Miscellaneous", "What keeps working without any action"].every((t) => namesARelease(t) === false));
  cell("REFUSE CONTROL: an unnamed section on a real page is not counted",
    coveringSections("## Notes\n\nreal prose, no release named\n").length === 0);

  // ONLY `##` IS A RELEASE SECTION. A subsection belongs to its release, and counting it would
  // inflate one honest release into several, which is noise in the one place a gate must be terse.
  const nested = "## From 0.49.0 to 0.50.0\n\n### A 0.50.0 detail\n\nprose under a subsection\n";
  cell("a `###` subsection is part of its release, not extra coverage", coveringSections(nested).length === 1, coveringSections(nested));
  cell("…and a section whose prose lives only under subsections still reads as non-empty",
    coveringSections(nested).join() === "From 0.49.0 to 0.50.0", coveringSections(nested));

  // EXIT CODES, GRADED RATHER THAN ASSERTED IN A COMMENT. A crash exiting 1 is an instrument
  // failure wearing a verdict's clothes: the reader is told a breaking change is missing its
  // section by a tool that graded nothing at all.
  const runSelf = (args) => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: "utf8" });
    return r.status;
  };
  cell("EXIT 2 on an unresolvable ref: misuse is never reported as a refusal", runSelf(["--range", "qqzzNoSuchRef77..HEAD"]) === 2);
  cell("EXIT 2 on missing arguments", runSelf([]) === 2);
  // `--merge-snapshot` EXISTS TO STOP THE RANGE'S TWO ENDS COMING FROM DIFFERENT SNAPSHOTS, and
  // these cells grade the refusals rather than the happy path, because the happy path is what a
  // caller notices and a missing refusal is what nobody notices. On a single-parent checkout
  // `HEAD^1` is the previous commit rather than the merge base, so the range shrinks to one
  // commit and a breaking change behind it reads as absent: a clean green meaning "I looked at
  // the wrong thing". The tool must refuse that itself and not rely on its caller checking,
  // because a local hook or a future workflow inherits none of the caller's care.
  // A CELL MUST BUILD THE CONDITION IT NAMES RATHER THAN INHERIT IT FROM THE AMBIENT CHECKOUT.
  // These two cells previously ran `--merge-snapshot` against whatever repository the suite
  // happened to be in, so their result was decided by that checkout's parent count. Measured: on
  // a branch head (1 parent) the suite read 42 passed; on the pull request's own merge ref
  // (2 parents) the same tree read 41 passed 1 failed, because the refusal a cell asserted cannot
  // happen on a merge snapshot, where the flag correctly SUCCEEDS. CI checks out that merge ref at
  // fetch-depth 0, so the suite went red on the one checkout that matters and the mutation proof,
  // which refuses to grade against a red baseline, left all 13 mutants UNGRADED.
  //
  // That is the same defect as the one this suite caught in itself an hour earlier: a cell whose
  // outcome turns on a fact nobody declared. There it passed for a reason unrelated to its name;
  // here it failed for one. A suite that grades a tool must not also be reading the weather.
  // So both refusals, and the happy path, are now graded in repositories built here, and the
  // parent probe is shown to discriminate before any of them are believed.
  {
    const tmp = mkdtempSync(join(tmpdir(), "upgrade-gate-merge-"));
    const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
    const build = (name, subject) => {
      const dir = join(tmp, name);
      mkdirSync(dir);
      git(["init", "-q", "."], dir);
      git(["config", "user.email", "selftest@example.invalid"], dir);
      git(["config", "user.name", "selftest"], dir);
      writeFileSync(join(dir, "f.txt"), "base\n");
      git(["add", "f.txt"], dir);
      git(["commit", "-qm", "chore: base"], dir);
      git(["branch", "-q", "-M", "main"], dir);
      git(["checkout", "-q", "-b", "topic"], dir);
      writeFileSync(join(dir, "f.txt"), "topic\n");
      git(["add", "f.txt"], dir);
      git(["commit", "-qm", subject], dir);
      return dir;
    };
    const merged = (name, subject) => {
      const dir = build(name, subject);
      git(["checkout", "-q", "main"], dir);
      git(["merge", "-q", "--no-ff", "topic", "-m", `Merge topic into main`], dir);
      return dir;
    };
    const linear = build("linear", "feat(core)!: rename a wire field");
    const cleanMerge = merged("merge-clean", "fix(core): a harmless fix");
    const breakingMerge = merged("merge-breaking", "feat(core)!: rename a wire field");
    const parentsOf = (dir) => git(["rev-list", "--parents", "-n", "1", "HEAD"], dir).stdout.trim().split(/\s+/).length - 1;
    // THE HELPER REFUSES ANY DIRECTORY THIS BLOCK DID NOT BUILD, and that is construction rather
    // than convention. Mutation found the gap: replacing a built repository with `process.cwd()`
    // left every cell GREEN, because this lane's own checkout happens to have one parent and so
    // happens to satisfy the refusal. The cell could not tell a repository it constructed from an
    // ambient one that merely fit, which is the whole defect restated one level up: a cell whose
    // result is decided by the weather passes for as long as the weather holds. Pinning the
    // helper to `tmp` means the ambient checkout cannot be graded here even by accident.
    //
    // IT REFUSES BY RETURNING A FAILING RESULT RATHER THAN BY THROWING. A throw ends the run, and
    // a suite that dies early is red for a reason no cell names: the reader is handed a stack
    // trace where a verdict belongs, and the mutation proof cannot tell that crash from any other.
    // Returning an impossible status instead makes the cell that used the wrong directory red on
    // its own line, which is the only red worth printing.
    let ungradedDirs = 0;
    const runIn = (dir, args) => {
      if (!String(dir).startsWith(tmp)) {
        ungradedDirs += 1;
        return { status: -1, stdout: "", stderr: `self-test: refused to grade a repository this block did not build: ${dir}` };
      }
      return spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { cwd: dir, encoding: "utf8" });
    };
    const saysIn = (dir, args, needle, code = 2) => {
      const r = runIn(dir, args);
      return r.status === code && (r.stderr ?? "").includes(needle);
    };

    // The probe first, for the same reason the shallow block probes before it asserts: every cell
    // below is a claim about a parent count, and an unproven probe makes all of them decoration.
    cell("the parent probe DISCRIMINATES: 1 on a branch head, 2 on a merge commit",
      parentsOf(linear) === 1 && parentsOf(cleanMerge) === 2,
      { linear: parentsOf(linear), merge: parentsOf(cleanMerge) });

    cell("EXIT 2 on --merge-snapshot outside a two-parent merge: HEAD^1 is not a merge base",
      saysIn(linear, ["--merge-snapshot"], "needs a two-parent merge commit"));
    // GRADED ON A TWO-PARENT REPOSITORY ON PURPOSE. On a single-parent checkout the parent check
    // fires first and also exits 2, so this cell would pass with the combination refusal deleted:
    // that exact mutant survived once already. Here the parent check cannot fire, so only the
    // refusal this cell names can produce the sentence it reads.
    cell("EXIT 2 when --merge-snapshot is combined with an explicit range: one range, one source",
      saysIn(breakingMerge, ["--merge-snapshot", "--range", "HEAD~1..HEAD"], "cannot be combined with --base or --range"));
    cell("…and with --base, the other way to name a second range",
      saysIn(breakingMerge, ["--merge-snapshot", "--base", "HEAD^1"], "cannot be combined with --base or --range"));

    // A FLAG THAT IS SILENTLY DROPPED IS A GATE THAT GREENS ON A TYPO. Measured on a real
    // two-parent checkout: `--merge-snapshot --range` with no value, `--base` with no value, and
    // any unknown flag all graded anyway and exited 0, because the parser read an option's value
    // by looking one slot to the right and never checked that the slot held one, nor that it had
    // read every argument it was given. The well-formed combination refused correctly, which is
    // why this went unnoticed: the shapes that were tested were the shapes that worked.
    cell("EXIT 2 when --range is given no value: a dropped argument is misuse, not a pass",
      saysIn(breakingMerge, ["--merge-snapshot", "--range"], "expects a value"));
    cell("…the same for --base", saysIn(breakingMerge, ["--base"], "expects a value"));
    cell("EXIT 2 on an UNKNOWN flag: an argument this tool does not understand is never ignored",
      saysIn(breakingMerge, ["--merge-snapshot", "--typo"], "unknown argument"));

    // THE PAIR THAT MAKES THE REFUSALS MEAN SOMETHING. Without these two, "refuses a single-parent
    // checkout" and "refuses everything" are the same measurement.
    cell("ACCEPT CONTROL: --merge-snapshot GRADES a real two-parent merge and exits 0",
      runIn(cleanMerge, ["--merge-snapshot"]).status === 0);
    cell("REFUSE CONTROL: …and exits 1 when that merge carries an undocumented breaking commit",
      runIn(breakingMerge, ["--merge-snapshot"]).status === 1);
    // THE GUARD IS ITSELF GRADED, because a guard nobody checks is the mute button this suite
    // already caught once in its skip mechanism. If any cell above reached for a repository this
    // block did not build, the counter is non-zero and this cell reds naming that directly,
    // rather than a substituted repository quietly satisfying whatever it was asked.
    cell("every repository graded above was BUILT HERE, not inherited from the ambient checkout",
      ungradedDirs === 0, { ungradedDirs });
    rmSync(tmp, { recursive: true, force: true });
  }
  // THESE TWO CELLS NEED REAL RELEASE HISTORY, AND A SUITE MUST NOT RED FOR A REASON THAT IS NOT
  // A DEFECT. In a shallow checkout the commits behind these tags are absent, so the CLI answers
  // 2 (nothing was graded) and an assertion of 1 or 0 fails while the tool is behaving exactly as
  // designed. Reporting UNGRADED is the honest third state: it is not a pass, because nothing was
  // proven, and it is not a failure, because nothing is broken. The count of skipped cells is
  // printed in the summary so a green run can never quietly mean "most of it did not run".
  if (historyIsTruncated) {
    skip("ACCEPT CONTROL for the exit reader: a real refusal is still EXIT 1");
    skip("ACCEPT CONTROL for the exit reader: a clean range is still EXIT 0");
  } else {
    cell("ACCEPT CONTROL for the exit reader: a real refusal is still EXIT 1",
      runSelf(["--range", "v0.48.2..v0.49.0"]) === 1);
    cell("ACCEPT CONTROL for the exit reader: a clean range is still EXIT 0",
      runSelf(["--range", "v0.48.1..v0.48.2"]) === 0);
  }

  // THE SHALLOW GUARD, GRADED IN A REAL SHALLOW CLONE RATHER THAN BY MOCKING THE PROBE. Building
  // three commits and cloning them at depth 1 is the only way to prove the guard fires on the
  // thing it names; a stubbed `--is-shallow-repository` would only prove the stub works.
  // The pair matters more than either half: WITHOUT the guard this range exits 0 on a truncated
  // history, a green meaning "I could not see", so the ACCEPT CONTROL below (same gate, same
  // range, FULL history, still exits 0) is what proves the guard discriminates rather than
  // simply refusing everything. A check that reds everywhere passes every mutation and is useless.
  {
    const tmp = mkdtempSync(join(tmpdir(), "upgrade-gate-shallow-"));
    const q = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
    const src = join(tmp, "src");
    mkdirSync(src);
    q(["init", "-q", "."], src);
    q(["config", "user.email", "selftest@example.invalid"], src);
    q(["config", "user.name", "selftest"], src);
    for (const i of [1, 2, 3]) {
      writeFileSync(join(src, "f.txt"), `${i}\n`);
      q(["add", "f.txt"], src);
      q(["commit", "-qm", `c${i}`], src);
    }
    q(["clone", "-q", "--depth", "1", `file://${src}`, "cut"], tmp);
    const cut = join(tmp, "cut");
    const shallowSays = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: cut, encoding: "utf8" }).stdout.trim();
    const fullSays = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: src, encoding: "utf8" }).stdout.trim();
    cell("the shallow probe DISCRIMINATES: true in a depth-1 clone, false in its full source",
      shallowSays === "true" && fullSays === "false", { shallowSays, fullSays });
    const inCut = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--range", "HEAD~0..HEAD"], { cwd: cut, encoding: "utf8" });
    cell("EXIT 2 in a SHALLOW repository: a truncated history is misuse, never a silent pass",
      inCut.status === 2, { status: inCut.status });
    cell("…and it says so in words a reader can act on",
      /SHALLOW repository/.test(inCut.stderr) && /fetch-depth: 0|unshallow/.test(inCut.stderr));
    rmSync(tmp, { recursive: true, force: true });
  }

  // ---- THE DOCUMENTS MUST AGREE WITH THE WORKFLOW THEY DESCRIBE ------------------------------
  //
  // THIS CLASS SHIPPED THREE TIMES IN THIS TOOL'S OWN PULL REQUEST. The body claimed 36 cells and
  // 9 mutants against a measured 50 and 16; an open question said the gate "currently self-tests"
  // after it had been wired into CI; and, worst, docs/UPGRADING.md told operators the check runs
  // in the `unit` job and that a red "reports the problem without blocking the merge" AFTER the
  // step had been moved into the required job and a red had started blocking. That last one was
  // generated into the shipped docs bundle, so the false promise reached users of the product.
  //
  // NO EXISTING CHECK COULD SEE IT, and that is the point. `check:docsbundle` regenerates and
  // diffs, which proves the bundle MATCHES its source and cannot prove the source is TRUE: it
  // propagates a faithful copy of a false claim at exit 0. This gate reads whether a SECTION
  // EXISTS, not whether prose agrees with a workflow. So the tool written to stop documentation
  // going stale against a change had no way to notice its own documentation going stale against
  // its own change.
  //
  // The check is narrow on purpose. It does not grade prose. It asserts ONE fact that is
  // mechanically derivable from the workflow files and is stated in the docs: WHICH JOB RUNS THE
  // GATE. The job is read from the YAML rather than hard-coded here, so moving the step again
  // makes these cells fail until the sentence follows it, which is the failure that was missing.
  const workflowDir = join(repoRootForDocs(), ".github", "workflows");
  // Every job name the workflows define, so the refuse leg below can notice a claim naming ANY of
  // them rather than only the two that happened to go stale on this change.
  const allJobNames = (() => {
    const names = new Set();
    if (!existsSync(workflowDir)) return names;
    for (const f of readdirSync(workflowDir).filter((n) => n.endsWith(".yml"))) {
      let inJobs = false;
      for (const l of readFileSync(join(workflowDir, f), "utf8").split("\n")) {
        if (/^jobs:\s*$/.test(l)) { inJobs = true; continue; }
        if (inJobs && /^\S/.test(l)) inJobs = false;
        if (!inJobs) continue;
        const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
        if (m) names.add(m[1]);
      }
    }
    return names;
  })();
  cell("workflow candidates are job keys, not top-level trigger or configuration keys",
    allJobNames.has("attribution") && allJobNames.has("live")
      && !["pull_request", "push", "release", "schedule", "workflow_dispatch"].some((n) => allJobNames.has(n)),
    { count: allJobNames.size, names: [...allJobNames].sort() });

  const hostJob = (() => {
    if (!existsSync(workflowDir)) return null;
    for (const f of readdirSync(workflowDir).filter((n) => n.endsWith(".yml"))) {
      const text = readFileSync(join(workflowDir, f), "utf8");
      if (!text.includes("upgrade-section-gate.mjs")) continue;
      // The nearest `  <job>:` key above the step is the job that hosts it. Two-space indent is
      // the job level in every workflow here, and the step sits deeper, so scanning upward from
      // the step's line finds the owning job without a YAML parser.
      const lines = text.split("\n");
      const at = lines.findIndex((l) => l.includes("upgrade-section-gate.mjs"));
      for (let i = at; i >= 0; i--) {
        const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i]);
        if (m) return { job: m[1], file: f };
      }
    }
    return null;
  })();

  const attributionWorkflow = existsSync(join(workflowDir, "attribution.yml"))
    ? readFileSync(join(workflowDir, "attribution.yml"), "utf8") : "";
  cell("the required attribution job installs the gate's declared YAML dependency before grading",
    attributionWorkflow.includes("pnpm/action-setup@v6.0.8")
      && attributionWorkflow.includes("pnpm install --frozen-lockfile --ignore-scripts")
      && attributionWorkflow.indexOf("pnpm install --frozen-lockfile --ignore-scripts")
        < attributionWorkflow.indexOf("node scripts/upgrade-section-gate.mjs"));

  cell("the workflow hosting this gate is discoverable from the repository itself",
    hostJob !== null && typeof hostJob.job === "string" && hostJob.job.length > 0, hostJob);

  if (hostJob) {
    // A reader who cannot find the job name in the file learns nothing from a green cell, so the
    // ACCEPT leg is asserted first: the name really is present and really is what we think.
    const docPaths = [join(repoRootForDocs(), "docs", "UPGRADING.md"),
      join(repoRootForDocs(), "docs", "design", "upgrade-section-gate.md")];
    for (const dp of docPaths) {
      if (!existsSync(dp)) { cell(`documentation present: ${dp}`, false, dp); continue; }
      const doc = readFileSync(dp, "utf8");
      const namesHost = doc.includes(`\`${hostJob.job}\``);
      cell(`${dp.split("/").slice(-1)[0]} names the job that actually runs the gate (\`${hostJob.job}\`)`,
        namesHost, { job: hostJob.job, from: hostJob.file });
      // REFUSE LEG. Naming the right job is not enough if the page ALSO names a job that no longer
      // runs it. This is the exact shape that shipped: the correct job appeared in one paragraph
      // while a stale one still appeared in another, and a reader met whichever they reached first.
      const stale = staleJobClaims(doc, hostJob.job, [...allJobNames]);
      cell(`…and does not ALSO claim a different job runs it`, stale.length === 0, { stale });
    }
    // THE SHIPPED COPY IS THE ONE THAT REACHES USERS. A correction that stops at the source leaves
    // the product serving the old promise, which is what happened here.
    const bundle = join(repoRootForDocs(), "extensions", "connector-core", "src", "docs-bundle.generated.ts");
    if (existsSync(bundle)) {
      const b = readFileSync(bundle, "utf8");
      const staleB = staleJobClaims(b, hostJob.job, [...allJobNames]);
      cell("the SHIPPED docs bundle does not claim a job that no longer runs the gate", staleB.length === 0, { stale: staleB });
    }
  }

  // THE DETECTOR ITSELF, DRIVEN BY BUILT INPUTS. These cells are the ones that can actually fail:
  // they do not depend on the repository's documents being in any particular state, so breaking
  // the detector reddens them whether or not the real docs happen to be clean today.
  cell("ACCEPT CONTROL: a page claiming a job that no longer runs the gate is NAMED",
    staleJobClaims("CI runs its self-test and, in the `unit` job, grades each PR.", "attribution", ["unit", "ci-ok"])
      .join() === "unit");
  cell("…and the same page is silent once the claim is corrected",
    staleJobClaims("CI runs its self-test and, as a step of the `attribution` job, grades each PR.",
      "attribution", ["unit", "ci-ok"]).length === 0);
  cell("the host job is honoured rather than assumed: `unit` is not stale when `unit` runs it",
    staleJobClaims("the gate runs in the `unit` job", "unit", ["unit", "ci-ok"]).length === 0);
  cell("…and `attribution` IS stale once the step lives in `unit`",
    staleJobClaims("the gate runs in the `attribution` job", "unit", ["attribution"]).join() === "attribution");
  cell("REFUSE CONTROL: prose merely mentioning a job name is not a claim that it runs the gate",
    staleJobClaims("start it under a systemd unit, or in the unit of work described above",
      "attribution", ["unit", "ci-ok"]).length === 0);
  cell("every stale claim in one page is reported, not just the first",
    staleJobClaims("it runs in the `unit` job, and grades in the `ci-ok` job", "attribution", ["unit", "ci-ok"]).length === 2);
  // THE EVASION THAT DEFAULTING HID, found end to end by review rather than by reading. A page
  // naming the CORRECT host AND ALSO a false third job satisfied the positive cell and slipped past
  // the refuse leg, because the third job was not in the hard-coded pair. The candidates now come
  // from the workflows, so any job the repository defines is a candidate.
  cell("a page that names the right job AND a false third job is still NAMED",
    staleJobClaims("as a step of the `attribution` job, and the grading path is the `live` job",
      "attribution", ["unit", "ci-ok", "live", "smoke"]).join() === "live");
  cell("the docs' own `step of` grammar cannot hide a false third job",
    staleJobClaims("as a step of the `attribution` job, and as a step of the `live` job",
      "attribution", ["unit", "ci-ok", "live", "smoke"]).join() === "live");
  cell("…and the same page with only the right job is silent",
    staleJobClaims("as a step of the `attribution` job", "attribution",
      ["unit", "ci-ok", "live", "smoke"]).length === 0);
  // A MISSING CANDIDATE LIST MUST THROW RATHER THAN GRADE NOTHING. An empty or absent list would
  // make every page read clean, which is the silent-pass shape this whole tool refuses.
  cell("REFUSE CONTROL: grading with no candidate list is a refusal, not a clean page",
    (() => { try { staleJobClaims("the gate runs in the `unit` job", "attribution", []); return false; }
             catch { return true; } })());

  // THE SHIPPED COPY IS A SEPARATE ARTEFACT AND NEEDS ITS OWN PROOF. The bundle stores each page
  // as one escaped JSON string, so backticks survive but newlines become literal `\n`. A reader
  // written for the markdown can therefore pass on the source and miss the generated copy, which
  // is the half that reaches users. This cell drives the detector with a bundle-shaped line.
  cell("ACCEPT CONTROL: a stale claim inside a BUNDLE-shaped escaped string is NAMED",
    staleJobClaims('"body": "CI runs its self-test and, in the `unit` job, grades each\\nPR."',
      "attribution", ["unit", "ci-ok"]).join() === "unit");
  cell("…and a corrected bundle string is silent",
    staleJobClaims('"body": "CI runs it as a step of the `attribution` job, grading each\\nPR."',
      "attribution", ["unit", "ci-ok"]).length === 0);

  const EXPECTED = 89;
  // A SKIP MUST BE JUSTIFIED BY THE REPOSITORY THE SUITE IS ACTUALLY IN, and this cell is the
  // only thing that checks it. Found by mutation: forcing the probe true on a healthy clone made
  // the suite skip two real cells and still print OK, because every other shallow cell reasons
  // about temporary repositories it builds itself and none of them look at THIS one. A skip
  // mechanism with no guard is a mute button, and an unguarded mute button on a gate is the exact
  // defect this tool exists to refuse. Re-probing here rather than reusing the variable is the
  // point: the claim under test is that the variable told the truth.
  const reprobe = spawnSync("git", ["rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).stdout.trim() === "true";
  cell("cells are only skipped when THIS repository is genuinely shallow",
    (skipped > 0) === reprobe && historyIsTruncated === reprobe,
    { skipped, historyIsTruncated, reprobe });

  // THE SENTINEL COUNTS SKIPS TOO, or a shallow run would red here for the second time over the
  // same truncation, and a reader would chase a phantom missing cell.
  cell(`every cell ran or was reported ungraded (${EXPECTED} before this sentinel)`,
    pass + fail + skipped === EXPECTED, { pass, fail, skipped });

  // A GREEN RUN THAT SKIPPED CELLS MUST SAY SO ON THE SUMMARY LINE. The summary is the only line
  // most readers see, so an unqualified OK after two ungraded cells would be the reassuring-
  // shaped lie this whole tool exists to refuse.
  const skipNote = skipped === 0 ? "" : `, ${skipped} UNGRADED (shallow checkout: run \`git fetch --unshallow\` to grade them)`;
  console.log(`\nUPGRADE SECTION GATE SELF-TEST ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed${skipNote})`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---- CLI ---------------------------------------------------------------------------------------

const RUN_AS_CLI = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (RUN_AS_CLI) {
  // EXIT 2 IS MISUSE AND EXIT 1 IS A REFUSAL, AND THEY MUST NEVER BE CONFUSED. Measured on the
  // first version: a mistyped ref let `execFileSync` throw out of the top level, Node printed a
  // sixty-line stack and exited 1, which is the REFUSAL code. A CI job with a bad base ref then
  // reads as "a breaking change is missing its section" and an operator acts on a verdict that was
  // never computed. An instrument failure wearing a verdict's clothes is the same family as a
  // refusal printing a raw `fatal:`; both teach a reader to distrust the gate.
  try {
    main();
  } catch (e) {
    console.error(`upgrade-section-gate: could not run (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
    console.error("This is a MISUSE exit (2), not a refusal: nothing was graded. Check the --base/--range refs exist.");
    process.exit(2);
  }
}

function main() {
  const argv = process.argv.slice(2);
  // A GATE THAT GREENS ON A TYPO IS THE DECORATION THIS TOOL EXISTS TO REMOVE, and this parser
  // was that gate. It read an option's value by looking ONE SLOT TO THE RIGHT and never asked
  // whether the slot held one, nor whether every argument it was handed had been understood.
  // Measured on a real two-parent checkout: `--merge-snapshot --range` with no value, `--base`
  // with no value, and `--merge-snapshot --typo` ALL GRADED ANYWAY AND EXITED 0. A value-less
  // `--range` read `undefined`, which is falsy, so the "cannot be combined" refusal never fired
  // and the tool proceeded on the merge snapshot as though nothing had been asked of it.
  //
  // It went unnoticed because the shapes anyone tested were the shapes that worked: the
  // WELL-FORMED combination refuses correctly, and a control built from it reports the property
  // as settled. The failure lives entirely in the malformed forms, which is where a typo lives.
  // So: every argument must be recognised, and every option that takes a value must be given one.
  const OPTIONS_WITH_VALUES = new Set(["--base", "--range"]);
  const BARE_FLAGS = new Set(["--merge-snapshot", "--self-test"]);
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (OPTIONS_WITH_VALUES.has(arg)) {
      const value = argv[i + 1];
      // A following argument that is itself an option is a MISSING value, not a value. Without
      // this, `--base --merge-snapshot` would quietly grade the range `--merge-snapshot..HEAD`.
      if (value === undefined || value.startsWith("--")) {
        console.error(`upgrade-section-gate: ${arg} expects a value, and none was given.`);
        console.error("Nothing was graded. This is a MISUSE exit (2), not a pass and not a refusal.");
        process.exit(2);
      }
      values.set(arg, value);
      i += 1;
      continue;
    }
    if (BARE_FLAGS.has(arg)) continue;
    console.error(`upgrade-section-gate: unknown argument \`${arg}\`.`);
    console.error("Nothing was graded. This is a MISUSE exit (2), not a pass and not a refusal.");
    console.error("usage: node scripts/upgrade-section-gate.mjs --base <ref> | --range <a..b> | --merge-snapshot | --self-test");
    process.exit(2);
  }
  const flag = (name) => values.get(`--${name}`);
  // EVERY git read here swallows stderr, and that is a deliberate single policy rather than a
  // convenience. Two shapes of git failure reach this tool and neither should print git's own
  // words: a path absent from an old tree is an ORDINARY answer (the page did not exist yet), and
  // a bad ref is OUR misuse to report in our own sentence. Left loud, the first prints `fatal:`
  // under a legitimate refusal and the second prints it above one, and in both cases the reader
  // learns to distrust a gate that is working correctly.
  const gitQuiet = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

  let range = flag("range") ?? (flag("base") ? `${flag("base")}..HEAD` : undefined);
  const mergeSnapshot = argv.includes("--merge-snapshot");
  if (!range && !mergeSnapshot) {
    console.error("usage: node scripts/upgrade-section-gate.mjs --base <ref> | --range <a..b> | --merge-snapshot | --self-test");
    process.exit(2);
  }
  if (range && mergeSnapshot) {
    console.error("upgrade-section-gate: --merge-snapshot takes its own range and cannot be combined with --base or --range.");
    console.error("This is a MISUSE exit (2): nothing was graded.");
    process.exit(2);
  }

  // `--merge-snapshot` GRADES A PULL REQUEST, AND IT REFUSES TO GUESS WHAT THAT MEANS.
  //
  // A CI checkout of a pull request is GitHub's synthetic merge commit, whose first parent is the
  // mainline it would land on. `HEAD^1..HEAD` is therefore the contribution, and both ends are
  // read off ONE object so nothing can drift between them. Taking the base from the event payload
  // instead lets the two ends come from different snapshots: measured on the pull request that
  // introduced this flag, the payload's base was six commits behind the merge's own first parent,
  // and an unrelated release section on the mainline was swallowed into the range and read as
  // coverage for a breaking commit that documented nothing.
  //
  // THE PARENT COUNT IS CHECKED HERE, IN THE TOOL, AND NOT ONLY IN THE CALLER. On a single-parent
  // checkout `HEAD^1` is the branch's previous commit, so the range shrinks to the last commit
  // and a breaking change one commit further back becomes invisible: the gate prints OK and exits
  // 0 while the branch it was pointed at is exactly what it exists to refuse. A caller can hold
  // that guard, and a caller can also be a local hook, a future workflow, or someone running this
  // by hand, none of which inherit the caller's care. A tool that only refuses when its caller
  // remembers to check is a tool that is correct by convention.
  if (mergeSnapshot) {
    let parents;
    try {
      parents = gitQuiet(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/).length - 1;
    } catch {
      console.error("upgrade-section-gate: cannot read HEAD's parents.");
      console.error("This is a MISUSE exit (2): nothing was graded.");
      process.exit(2);
    }
    if (parents !== 2) {
      console.error(`upgrade-section-gate: --merge-snapshot needs a two-parent merge commit, and HEAD has ${parents}.`);
      console.error("Nothing was graded. This is a MISUSE exit (2), not a pass and not a refusal.");
      console.error("On a single-parent checkout HEAD^1 is the previous commit, not the merge base, so the");
      console.error("range would silently shrink and a breaking change would read as absent. Check out the");
      console.error("pull request's merge ref, or pass --range explicitly if you know what you are grading.");
      process.exit(2);
    }
    range = `${gitQuiet(["rev-parse", "HEAD^1"]).trim()}..${gitQuiet(["rev-parse", "HEAD"]).trim()}`;
  }

  // Commit subjects and bodies in range, one record per commit. A NUL separator, because a commit
  // body may contain anything a person can type, blank lines and the word "commit" included.
  // The range reader. A bad ref must surface as OUR misuse message, not as git's raw `fatal:`
  // followed by ours: two errors for one fault, the first of which looks like the gate breaking.
  // Stderr is swallowed here precisely so the `catch` below owns the wording.
  const raw = gitQuiet(["log", "--format=%H%x1f%s%x1f%b%x1e", range]);
  const commits = raw.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, subject, body] = r.split("\x1f");
    return { sha, subject: subject ?? "", body: body ?? "" };
  });

  // A TRUNCATED HISTORY CANNOT BE GRADED, AND SAYING SO IS THE WHOLE POINT OF THIS BLOCK.
  // Measured: in a shallow clone (`clone --depth`, or `actions/checkout` at its DEFAULT
  // fetch-depth of 1) the range v0.48.2..v0.49.0 contains ZERO commits instead of 173, because
  // the commits simply are not there. Every reader downstream then works perfectly on an empty
  // list and the gate exits 0, reporting "no breaking change in range" for a range holding two.
  // THAT IS A CLEAN GREEN THAT MEANS "I COULD NOT SEE", which is the exact failure this gate
  // exists to prevent in other people's changesets. A missing answer must never wear a passing
  // answer's clothes, so this is a MISUSE exit (2): nothing was graded and the caller is told.
  // This repo's own CI sets `fetch-depth: 0`, so CI is unaffected; the case that bites is a
  // developer in a shallow clone being told the suite is broken when their history is cut.
  if (gitQuiet(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    console.error("upgrade-section-gate: refusing to grade a SHALLOW repository (history is truncated).");
    console.error("Nothing was graded. This is a MISUSE exit (2), not a pass and not a refusal.");
    console.error("Run `git fetch --unshallow`, or set `fetch-depth: 0` on actions/checkout.");
    process.exit(2);
  }

  const breaking = commits.filter((c) => isBreakingCommit(c.subject, c.body)).map((c) => `${c.sha.slice(0, 9)} ${c.subject}`);

  // A `major` changeset in range is the same signal. Read AT THE RANGE'S HEAD for the same reason
  // the page is: a replay of a past release that enumerated TODAY's `.changeset/` would be
  // reporting this branch's pending work as though it were that release's.
  const [rangeBase = "", rangeHead = "HEAD"] = range.split("..");
  const changesetDir = ".changeset";
  const majorPackagesAt = (ref) => {
    const packages = new Set();
    let names = [];
    try {
      names = gitQuiet(["ls-tree", "--name-only", `${ref}:${changesetDir}`]).split("\n").map((s) => s.trim()).filter(Boolean);
    } catch { return packages; }
    for (const name of names) {
      if (!name.endsWith(".md") || name === "README.md") continue;
      let text = "";
      try { text = gitQuiet(["show", `${ref}:${changesetDir}/${name}`]); } catch { continue; }
      for (const pkg of majorChangesetPackages(text)) packages.add(pkg);
    }
    return packages;
  };
  const baseMajorPackages = majorPackagesAt(rangeBase);
  const headMajorPackages = majorPackagesAt(rangeHead);
  const addedMajorPackages = [...headMajorPackages].filter((pkg) => !baseMajorPackages.has(pkg));
  if (addedMajorPackages.length > 0) breaking.push(`changesets (new major packages: ${addedMajorPackages.join(", ")})`);
  // The uncommitted case: the changeset that accompanies the very change being graded is not in
  // any tree yet, so a HEAD run also reads the working directory.
  if (rangeHead === "HEAD" && existsSync(changesetDir)) {
    const workingMajorPackages = new Set();
    for (const name of readdirSync(changesetDir)) {
      if (!name.endsWith(".md") || name === "README.md") continue;
      for (const pkg of majorChangesetPackages(readFileSync(join(changesetDir, name), "utf8"))) workingMajorPackages.add(pkg);
    }
    const committedMajorPackages = majorPackagesAt("HEAD");
    const workingAddedMajorPackages = [...workingMajorPackages].filter((pkg) => !committedMajorPackages.has(pkg));
    if (workingAddedMajorPackages.length > 0)
      breaking.push(`working changesets (new major packages: ${workingAddedMajorPackages.join(", ")})`);
  }

  // THE SECTIONS THIS RANGE ADDED, base against head. Reading only the head would answer "does the
  // page have sections", which every page does forever after its first release; the difference is
  // what answers "did THIS range write one".
  const pageAt = (ref) => {
    try {
      return gitQuiet(["show", `${ref}:${UPGRADING_PATH.split("\\").join("/")}`]);
    } catch {
      // Absent from that tree is an ORDINARY answer: before the page existed there were no
      // sections. For a HEAD run the file may live only in the working tree, which is the normal
      // state of the very change that introduces it, so disk is consulted THERE only.
      if (ref === "HEAD" && existsSync(UPGRADING_PATH)) return readFileSync(UPGRADING_PATH, "utf8");
      return "";
    }
  };
  const head = range.split("..").pop() || "HEAD";
  const addedSections = addedSectionsBetween(pageAt(rangeBase || "HEAD"), pageAt(head));

  const v = verdict({ breaking, addedSections });
  console.log(`upgrade-section-gate ${range}`);
  for (const b of breaking) console.log(`  breaking: ${b}`);
  console.log(`  new ${UPGRADING_PATH} sections added by this range: ${addedSections.length}`);
  for (const s of addedSections) console.log(`    + ${s}`);
  console.log(`${v.ok ? "OK" : "REFUSED"}: ${v.reason}`);
  if (!v.ok) {
    console.error(
      `\nA breaking change must carry an operator upgrade section in ${UPGRADING_PATH}.\n` +
      "Add a NEW section naming what migrates on its own, what does not, the order to move a split\n" +
      "topology in, what the outage window looks like, and what to snapshot first. Editing an\n" +
      "existing release's section does not document a new break.",
    );
  }
  process.exit(v.ok ? 0 : 1);
}
