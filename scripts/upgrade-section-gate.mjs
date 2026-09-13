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
 *
 * Exit 0 when every breaking commit in range is covered, 1 when one is not, 2 on misuse.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
 * The release sections a page declares, with whether each carries any body text.
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
    const h = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (h) { out.push({ title: h[2], body: "" }); continue; }
    if (out.length && line.trim()) out[out.length - 1].body += line;
  }
  return out.filter((s) => !STRUCTURAL_HEADINGS.includes(s.title));
}

/** Release sections that actually say something. An empty heading is not coverage. */
export function coveringSections(markdown) {
  return sectionsOf(markdown).filter((s) => s.body.trim().length > 0).map((s) => s.title);
}

/**
 * The verdict for one range.
 *
 * `breaking` are the commits that declared themselves breaking; `covered` is whether the range also
 * touched the page. BOTH halves matter and the second is the one worth explaining: the gate does
 * not try to match a commit to a specific section, because a release's section is written once for
 * several breaking commits and any such matching rule would be guesswork wearing a rule's clothes.
 * What it asserts is that a range which broke something also WROTE something here.
 */
export function verdict({ breaking, upgradingChanged, sections }) {
  if (breaking.length === 0) return { ok: true, reason: "no breaking commits in range" };
  if (!upgradingChanged)
    return { ok: false, reason: `${breaking.length} breaking change(s) and no ${UPGRADING_PATH} edit in the same range` };
  if (sections.length === 0)
    return { ok: false, reason: `${UPGRADING_PATH} was edited but declares no non-empty release section` };
  return { ok: true, reason: `${breaking.length} breaking change(s) covered by ${sections.length} section(s)` };
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
  let pass = 0, fail = 0;
  const cell = (name, ok, detail) => {
    if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ FAIL: ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`); }
  };

  // THE THREE LEGS, IN ONE INVOCATION. The third is the one that makes the other two mean
  // something: without it a gate that reds on EVERY changeset is indistinguishable from a gate
  // that detects breaking ones.

  // LEG 1, ACCEPT CONTROL: breaking, no section. MUST RED, and must name what it caught.
  const v1 = verdict({ breaking: ["feat(core)!: bind hosted runs"], upgradingChanged: false, sections: [] });
  cell("ACCEPT CONTROL: a breaking change with no UPGRADING.md edit is REFUSED", v1.ok === false, v1);
  cell("…and the refusal names the breaking change it caught", /breaking change/.test(v1.reason), v1.reason);

  // LEG 2, REFUSE CONTROL: breaking, with a section. MUST STAY GREEN.
  const v2 = verdict({ breaking: ["feat(core)!: bind hosted runs"], upgradingChanged: true, sections: ["From 0.48.2 to 0.49.0"] });
  cell("REFUSE CONTROL: a breaking change WITH its section passes", v2.ok === true, v2);

  // LEG 3, REFUSE CONTROL: non-breaking, no section. MUST STAY GREEN, i.e. the gate is keyed on
  // BREAKING and not on "a changeset exists".
  const v3 = verdict({ breaking: [], upgradingChanged: false, sections: [] });
  cell("REFUSE CONTROL: a NON-breaking change with no section passes (not vacuously red)", v3.ok === true, v3);

  // The edited-but-empty case. A heading with nothing under it is the cheapest way to satisfy a
  // gate that only checked the file's mtime, so it is refused explicitly.
  const v4 = verdict({ breaking: ["fix(core)!: x"], upgradingChanged: true, sections: [] });
  cell("an UPGRADING.md edit that adds no non-empty section does NOT count as coverage", v4.ok === false, v4);

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
  cell("REFUSE CONTROL: a `#` inside a fenced block is not a section",
    coveringSections("## Real\n\nbody\n\n```bash\n## Not a heading\ncotal up\n```\n").length === 1,
    coveringSections("## Real\n\nbody\n\n```bash\n## Not a heading\ncotal up\n```\n"));
  cell("REFUSE CONTROL: an empty section is not coverage", coveringSections("## Empty\n\n## Also empty\n").length === 0);

  const EXPECTED = 16;
  cell(`every cell ran (${EXPECTED} before this sentinel)`, pass + fail === EXPECTED, { pass, fail });

  console.log(`\nUPGRADE SECTION GATE SELF-TEST ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---- CLI ---------------------------------------------------------------------------------------

const RUN_AS_CLI = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (RUN_AS_CLI) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // A path that is absent from a tree is an ORDINARY answer here (the page did not exist yet), not
  // an error to show an operator. `git show` still writes "fatal: …" to stderr on the way to its
  // nonzero exit, and that line reads like a gate malfunction beside a legitimate refusal.
  const gitQuiet = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

  const range = flag("range") ?? (flag("base") ? `${flag("base")}..HEAD` : undefined);
  if (!range) {
    console.error("usage: node scripts/upgrade-section-gate.mjs --base <ref> | --range <a..b> | --self-test");
    process.exit(2);
  }

  // Commit subjects and bodies in range, one record per commit. A NUL separator, because a commit
  // body may contain anything a person can type, blank lines and the word "commit" included.
  const raw = git(["log", "--format=%H%x1f%s%x1f%b%x1e", range]);
  const commits = raw.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, subject, body] = r.split("\x1f");
    return { sha, subject: subject ?? "", body: body ?? "" };
  });
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

  const touched = git(["diff", "--name-only", range]).split("\n").map((s) => s.trim());
  const upgradingChanged = touched.includes(UPGRADING_PATH.split("\\").join("/"));

  // READ THE PAGE AT THE RANGE'S HEAD, not the working tree. The difference only shows up when it
  // matters most: replaying a past release to ask "would this gate have fired then" must see the
  // page as it was AT that release, and a working-tree read would answer with today's page and
  // report a green that belongs to now. `--range a..b` takes `b`; `--base` leaves head at HEAD,
  // which for a working-tree run is the same file plus any uncommitted edit, so the uncommitted
  // case is read from disk deliberately.
  const head = range.split("..").pop() || "HEAD";
  let page = "";
  try {
    page = gitQuiet(["show", `${head}:${UPGRADING_PATH.split("\\").join("/")}`]);
  } catch {
    // Not in that tree. For a HEAD run the file may exist only in the working tree, which is the
    // ordinary state of the very changeset that introduces it, so fall back to disk THERE only.
    if (head === "HEAD" && existsSync(UPGRADING_PATH)) page = readFileSync(UPGRADING_PATH, "utf8");
  }
  const sections = coveringSections(page);

  const v = verdict({ breaking, upgradingChanged, sections });
  console.log(`upgrade-section-gate ${range}`);
  for (const b of breaking) console.log(`  breaking: ${b}`);
  console.log(`  ${UPGRADING_PATH} edited in range: ${upgradingChanged}`);
  console.log(`  non-empty release sections on the page: ${sections.length}`);
  console.log(`${v.ok ? "OK" : "REFUSED"}: ${v.reason}`);
  if (!v.ok) {
    console.error(
      `\nA breaking change must carry an operator upgrade section in ${UPGRADING_PATH}.\n` +
      "Add a section naming what migrates on its own, what does not, the order to move a split\n" +
      "topology in, what the outage window looks like, and what to snapshot first.",
    );
  }
  process.exit(v.ok ? 0 : 1);
}
