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
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

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

/** Is this changeset front-matter a `major` bump for any package? */
export function isBreakingChangeset(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return false;
  return /:\s*major\s*$/m.test(m[1]);
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
  // TWO REFUSALS THAT BOTH EXIT 2 ARE INDISTINGUISHABLE TO AN EXIT-CODE READER, and the mutation
  // proof caught exactly that: a cell asserting `=== 2` for the combination refusal stayed green
  // with the combination refusal deleted, because the parent check fires first and also exits 2.
  // The cell was passing for a reason unrelated to the line it names. Reading the refusal's own
  // words is what makes the two separable, so this helper returns them.
  const runSelfSays = (args, needle) => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], { encoding: "utf8" });
    return r.status === 2 && (r.stderr ?? "").includes(needle);
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
  cell("EXIT 2 on --merge-snapshot outside a two-parent merge: HEAD^1 is not a merge base",
    runSelfSays(["--merge-snapshot"], "needs a two-parent merge commit"));
  cell("EXIT 2 when --merge-snapshot is combined with an explicit range: one range, one source",
    runSelfSays(["--merge-snapshot", "--range", "HEAD~1..HEAD"], "cannot be combined with --base or --range"));
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

  const EXPECTED = 41;
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

const RUN_AS_CLI = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
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
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
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
  const rangeHead = range.split("..").pop() || "HEAD";
  const changesetDir = ".changeset";
  let changesetNames = [];
  try {
    changesetNames = gitQuiet(["ls-tree", "--name-only", `${rangeHead}:${changesetDir}`]).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    changesetNames = [];
  }
  for (const name of changesetNames) {
    if (!name.endsWith(".md") || name === "README.md") continue;
    let text = "";
    try { text = gitQuiet(["show", `${rangeHead}:${changesetDir}/${name}`]); } catch { continue; }
    if (isBreakingChangeset(text)) breaking.push(`changeset ${name} (major)`);
  }
  // The uncommitted case: the changeset that accompanies the very change being graded is not in
  // any tree yet, so a HEAD run also reads the working directory.
  if (rangeHead === "HEAD" && existsSync(changesetDir)) {
    for (const name of readdirSync(changesetDir)) {
      if (!name.endsWith(".md") || name === "README.md") continue;
      const label = `changeset ${name} (major)`;
      if (breaking.includes(label)) continue;
      if (isBreakingChangeset(readFileSync(join(changesetDir, name), "utf8"))) breaking.push(label);
    }
  }

  // THE SECTIONS THIS RANGE ADDED, base against head. Reading only the head would answer "does the
  // page have sections", which every page does forever after its first release; the difference is
  // what answers "did THIS range write one".
  const [rangeBase] = range.split("..");
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
