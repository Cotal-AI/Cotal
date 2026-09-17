#!/usr/bin/env node
/**
 * Cell-discrimination self-test for scripts/check-operator-literals.mjs.
 *
 * WHAT THIS GRADES, AND WHY THE SCANNER'S OWN SELF-TEST CANNOT.
 *
 * The scanner runs `selftest()` on every invocation, and that suite grades BEHAVIOUR: weaken a
 * matching rule and cells go red. It cannot grade ITSELF. A cell is a planted positive read by two
 * independent instruments. A `primary` (the scanner's real `findings()`) and a `secondary` (a
 * small reader asserting the subject genuinely carries what the cell claims to plant). Hollow a
 * secondary out to a constant, `() => 1`, and the cell still reports `status=PASS`, the summary
 * still reports `cells=65/65 status=PASS`, and the process still exits 0.
 *
 * Measured by hollowing three different secondaries one at a time, each inside its own cell block:
 *   host-planted  (host-token arrow)  -> () => 1 : exit 0, cells=65/65 status=PASS   SURVIVED
 *   ip-loopback   (shapeIPv4Count)    -> () => 1 : exit 0, cells=65/65 status=PASS   SURVIVED
 *   home-relative (homeFragmentCount) -> () => 1 : exit 0, cells=65/65 status=PASS   SURVIVED
 * against a same-session behaviour control proving the scanner is not simply blind: dropping the
 * trailing `(?![A-Za-z0-9_/])` from the real CIDR_SUFFIX pattern gave exit 2, cells=61/65
 * status=FAIL, reddening exactly the four cells that grade that lookahead (public-cidr-alpha-tail,
 * public-cidr-slash-tail, shared-cidr-alpha-tail, shared-cidr-slash-tail). The weakening is spelled
 * out because "weakening the pattern" is not reproducible and the cell count depends on which
 * weakening. A dead discriminator is invisible to the instrument it belongs to, while dead
 * behaviour is not.
 *
 * THE FIGURES IN THIS DOCBLOCK are re-derivable at THIS head and were re-derived here. That is
 * deliberate: they previously cited a prior sha, and a reviewer pointed out that a historical claim
 * wearing the same clothes as a live one is precisely this suite's own subject.
 *
 * FIGURES FURTHER DOWN THAT DESCRIBE A PAST DEFECT OR A PAST REVIEW ROUND are labelled with the
 * head they were measured at and are deliberately NOT restated here. A dated figure that says how
 * old it is beats a fresh-looking figure under an old pin. So the claim is narrowed on purpose:
 * this docblock is current, and every other figure in this file carries its own date.
 *
 * #1614 added four cells while this branch sat in review, moving the scanner from 61 to 65 cells
 * and this suite from 149 to 173 checks; the inline-registry check added in this revision takes
 * the suite to 175. That is why the labelled figures below read 61 and 149.
 *
 * THE MEASUREMENT. A discriminator is alive only if it can still say NO. For each subject cell we
 * TAMPER the cell's planted subject so the property the secondary asserts is genuinely destroyed,
 * run the scanner's own self-test over the tampered copy, and REQUIRE that cell to flip to FAIL.
 * A live reader flips. A reader hollowed to a constant cannot flip, so the tamper stops going red
 * and this suite goes red in its place. That is the kill: the mutation is detected by the ABSENCE
 * of a failure it should have caused, which is the only signal a hollowed cell emits.
 *
 * WHY TAMPER A COPY. The tracked scanner is never written to. Each case copies the tracked file to
 * a temporary directory, edits the copy, and runs the copy with `--root` pointed back at this
 * repository so the copy resolves a real git HEAD exactly as the tracked file does. Under
 * mutation-proof the tracked file already carries the mutation when it is copied, so the mutation
 * flows into every case without this suite knowing a mutation happened.
 *
 * WHY THE TAMPER IS POSITIONAL. Cells are delimited by `// SELFTEST_CELL <id> START/END` markers,
 * so each edit is applied INSIDE one named block rather than to the file at large. A substring
 * edit applied file-wide would silently hit the identical text in a neighbouring cell or in a
 * comment, and a tamper that lands somewhere other than where it is documented to land is a
 * control that does not reach its subject. Every case asserts its edit actually changed the text
 * and that exactly one block matched, so a tamper that becomes a no-op fails loudly instead of
 * reporting a pass it did not earn.
 *
 * REQUIRES AN INSTALL: `pnpm install --frozen-lockfile` before `node scripts/...selftest.mjs`.
 *
 * This suite imports `typescript`, which is a devDependency, not a node builtin. An earlier version
 * imported only builtins and ran in a bare checkout, and that property was RETIRED here rather than
 * lost: reading source structure is what defeats the attacks below, and no amount of text matching
 * substitutes for it. Two reviewers measured the regression independently in clones with no
 * node_modules, and both recorded the direction correctly as ALARMING: it fails at once with
 * ERR_MODULE_NOT_FOUND, never as a false pass. The import is guarded below so the failure names the
 * cause instead of looking like a broken fixture. `scripts/mutation-coverage.mjs` and
 * `scripts/doc-binding.mjs` already import typescript, so the dependency is house-normal; the
 * defect was leaving the change undeclared, which is this file's own subject.
 *
 * Exit 0 all checks passed, 1 a check failed, 2 a prerequisite is missing.
 */
let ts;
try {
  ({ default: ts } = await import("typescript"));
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  process.stderr.write(
    "check-operator-literals.celltamper.selftest: cannot find package 'typescript'.\n"
    + "This suite parses the scanner's source, so it needs the repository's devDependencies.\n"
    + "Run `pnpm install --frozen-lockfile` first, then re-run this command.\n",
  );
  process.exit(2);
}
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// Namespace, for the same reason as mutation-proof.selftest.mjs: a tree without the #1625 cleanup
// guard must still RUN this suite (it grades the scanner's cells, not the guard) rather than die at
// link time on an export that tree does not have.
import * as safety from "./mutation-command-safety.mjs";

const removeSelfTestDir = (dir, dirBase, created) =>
  typeof safety.removeSelfTestDir === "function"
    ? safety.removeSelfTestDir(dir, dirBase, created)
    : rmSync(dir, { recursive: true, force: true });

const HERE = dirname(fileURLToPath(import.meta.url));
const SCANNER = join(HERE, "check-operator-literals.mjs");
const ROOT = join(HERE, "..");

let passed = 0;
const failures = [];

const check = (name, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok ${name}${detail !== undefined ? ` - ${detail}` : ""}`);
    return true;
  }
  failures.push(name);
  console.error(`  FAIL ${name}${detail !== undefined ? ` - ${detail}` : ""}`);
  return false;
};

/** Run a scanner file's self-test and return its exit code plus the rows it emitted. */
const makeRun = (status, output) => ({
  exitCode: status,
  output,
  rows: output.split(/\r?\n/).filter(Boolean),
});

const runSelftest = (file) => {
  const result = spawnSync(process.execPath, [file, "--selftest", "--root", ROOT], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`could not run ${file}: ${result.error.message}`);
  return makeRun(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`);
};

/**
 * The baseline run, spawning the TRACKED scanner by a path spelled out at the call site.
 *
 * This is deliberately not routed through `runSelftest`'s `file` parameter. A parameter has no
 * value until the program runs, so a reader of this file cannot tell which path is executed, and
 * mutation-coverage refuses a fixture whose suite it cannot see reaching the mutated file. That
 * refusal is correct: an unreadable launch is indistinguishable from no launch. Naming SCANNER in
 * the argv makes the execution this suite genuinely performs visible to a reader as well, and it
 * is the same process the tampered copies below are compared against.
 */
const runTrackedSelftest = () => {
  const result = spawnSync(process.execPath, [SCANNER, "--selftest", "--root", ROOT], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`could not run ${SCANNER}: ${result.error.message}`);
  return makeRun(result.status, `${result.stdout ?? ""}${result.stderr ?? ""}`);
};

/**
 * The status a run's ROWS reported for one cell, or undefined when the cell emitted no result row.
 *
 * Takes rows rather than the run, for the reason spelled out over `cellSecondary` below: a reader
 * that can see `exitCode` can answer from it instead of from the row, and every real tampered run
 * in this suite exits 2. Measured on this reader too, before the change: an added
 * `if (run.exitCode === 2) return "FAIL";` left the suite at 91/91 exit 0.
 */
const cellStatus = (rows, id) => {
  const row = rows.find(
    (candidate) => candidate.startsWith("SELFTEST_RESULT_ROW ") && candidate.includes(` cell=${id} `),
  );
  return /\bstatus=([A-Z]+)/.exec(row ?? "")?.[1];
};

/**
 * The value a run's ROWS reported for one cell's SECONDARY reader, or undefined when the cell
 * emitted no readable row.
 *
 * Status alone is too blunt to grade a hollowed reader, and the difference decides the whole suite.
 * On a POSITIVE cell (`host-planted`, expecting `primary=1`) destroying the planted subject drops
 * BOTH readings, so the cell goes FAIL on its primary whether or not the secondary still works. A
 * suite asserting only `status=FAIL` would therefore report a pass with the secondary hollowed out,
 * which is the exact wrong-green this file exists to catch. Reading the secondary FIELD instead
 * grades the reader that was actually mutated: a live reader reports 0 for a destroyed subject, and
 * one hollowed to a constant reports its expected value no matter what it is handed.
 *
 * IT TAKES `rows`, NOT THE RUN, AND THAT SIGNATURE IS LOAD-BEARING. Given the run, this reader can
 * see `exitCode`, and the exit code alone answers every assertion in the suite: each real tampered
 * run exits 2 and each kill expects 0. Three reviewers independently landed on the same survivor,
 * `if (run.exitCode === 2) return "0";` above the parse, which is a plausible early return reading
 * naturally as "a failed run has no live discriminator". It parses honestly for the synthetic
 * control and for every green baseline row, so it satisfied the control completely, and it never
 * read a field on a single tampered run: 91/91, exit 0. Adding more synthetic runs would have
 * caught that one spelling and left the class open, because the reader could still see the exit
 * code. Removing the parameter makes the shortcut UNWRITABLE rather than detectable: the value it
 * would key on is no longer in scope, and `rows.exitCode` on an array is inert. This is the round-4
 * lesson one level down, where widening a reader moved the boundary and changing the denominator
 * closed the class. It applies to function signatures too.
 */
const cellSecondary = (rows, id, field = "secondary") => {
  const row = rows.find(
    (candidate) => candidate.startsWith("SELFTEST_RESULT_ROW ") && candidate.includes(` cell=${id} `),
  );
  return new RegExp(`\\b${field}=(\\d+)\\/`).exec(row ?? "")?.[1];
};

/** The `cells=passed/total status=...` summary a run's ROWS reported. Rows-only, as above. */
const summary = (rows) => {
  const row = rows.find((candidate) => candidate.startsWith("SELFTEST_SUMMARY_ROW "));
  const match = /cells=(\d+)\/(\d+) status=([A-Z]+)/.exec(row ?? "");
  if (!match) return undefined;
  return { passed: Number(match[1]), total: Number(match[2]), status: match[3] };
};

/**
 * Replace `find` with `replace` INSIDE the `// SELFTEST_CELL <id> ...` block only.
 * Throws when the block is missing, when it is not unique, or when the edit changes nothing:
 * a tamper that did not land cannot stand as a tamper that landed and was survived.
 */
const tamperCell = (source, id, find, replace) => {
  const start = `// SELFTEST_CELL ${id} START`;
  const end = `// SELFTEST_CELL ${id} END`;
  const starts = source.split(start).length - 1;
  const ends = source.split(end).length - 1;
  if (starts !== 1 || ends !== 1) {
    throw new Error(`cell ${id}: expected exactly one START/END marker pair, found ${starts}/${ends}`);
  }
  const from = source.indexOf(start);
  const to = source.indexOf(end) + end.length;
  if (to <= from) throw new Error(`cell ${id}: END marker precedes START marker`);
  const block = source.slice(from, to);
  const occurrences = block.split(find).length - 1;
  if (occurrences !== 1) {
    throw new Error(`cell ${id}: tamper text occurs ${occurrences} time(s) in the block, expected exactly 1`);
  }
  const tamperedBlock = block.split(find).join(replace);
  if (tamperedBlock === block) throw new Error(`cell ${id}: tamper was a no-op`);
  return source.slice(0, from) + tamperedBlock + source.slice(to);
};

/**
 * Tamper inside a named HELPER FUNCTION rather than inside a cell's marker block.
 *
 * Some cells build their subject in a shared fixture helper: `binary-skip` gets its NUL-bearing
 * file from `binaryFixtureResult`, and the three `production-*` cells drive the real `main()`
 * through `productionPathFixtureResult`. The subject is genuinely outside the marker block, so the
 * block-scoped tamper above REFUSED them, correctly and by name (`occurs 0 time(s) in the block`).
 *
 * The refusal is a feature and is not being relaxed: the containment guarantee is what stops a
 * tamper from drifting into unrelated code and being mistaken for a reading of this cell. So this
 * variant keeps the guarantee and moves the boundary to a span that is still exact. The helper's
 * extent comes from the AST, not from brace counting or a regex, for the same reason the inventory
 * does: a string or comment containing the helper's name cannot widen the span.
 *
 * A shared helper is shared, so a tamper here COULD in principle affect several cells at once. The
 * decisive reading is still per-cell: the NAMED cell's own discriminator must go dead. But read the
 * summary assertion in the kill loop before believing that is the whole contract. It requires
 * `passed === total - 1`, so EXACTLY ONE cell may redden, helper tamper or not. This docblock used
 * to say the grading held "regardless of how many neighbours also went red", which promised a
 * tolerance the suite does not grant, and the direction of that error matters: the assertion is
 * STRICTER than the sentence, not looser, so nothing was going ungraded. At this head every helper
 * tamper here does redden exactly one cell, and a future helper tamper that catches a neighbour
 * will fail this suite loudly rather than be tolerated. That is the intended behaviour: a tamper
 * whose blast radius is wider than its name is a control that no longer reads what it claims.
 */
const tamperHelper = (source, id, helper, find, replace) => {
  const sf = ts.createSourceFile("scanner.mjs", source, ts.ScriptTarget.Latest, true);
  const spans = [];
  const visit = (node) => {
    const isNamedFunction = ts.isFunctionDeclaration(node) && node.name?.text === helper;
    const isNamedBinding = ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === helper && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
    if (isNamedFunction || isNamedBinding) spans.push([node.getStart(sf), node.getEnd()]);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (spans.length !== 1) {
    throw new Error(`cell ${id}: expected exactly one declaration of helper ${helper}, found ${spans.length}`);
  }
  const [from, to] = spans[0];
  const block = source.slice(from, to);
  const occurrences = block.split(find).length - 1;
  if (occurrences !== 1) {
    throw new Error(`cell ${id}: tamper text occurs ${occurrences} time(s) in helper ${helper}, expected exactly 1`);
  }
  const tamperedBlock = block.split(find).join(replace);
  if (tamperedBlock === block) throw new Error(`cell ${id}: tamper was a no-op`);
  return source.slice(0, from) + tamperedBlock + source.slice(to);
};

/**
 * Each case names a cell, and an edit that destroys the property the cell's SECONDARY reader
 * asserts while leaving the scanner's matching rules untouched.
 *
 * COVERAGE IS BY CONSTRUCTOR FAMILY, NOT BY CELL. The scanner builds its 65 cells from a small
 * number of shared factories, and hollowing a factory's discriminator kills every cell it built at
 * once. One case per family therefore grades every cell in that family, while one case per cell
 * would be 65 cases mostly re-proving the same function. The families are enumerated from the
 * SOURCE by the census below, so a family added later without a case fails loudly instead of being
 * silently ungraded. That enumeration is what an earlier version of this file lacked: two separate
 * survivors were found in review, both in families the case list did not name.
 */
const CASES = [
  {
    cell: "host-planted",
    reader: "inline host-token arrow (positive cell)",
    family: "matchCell",
    // `host-planted` carries its OWN copy of the host-token arrow, textually identical to the one
    // in `host-substring` but a separate function object, so hollowing it is a separate mutant that
    // the host-substring case cannot see. Found by an adversarial reviewer, who hollowed exactly
    // this reader and observed SURVIVED while a same-run host-substring hollowing was KILLED. Two
    // cells sharing a reader's SPELLING do not share its coverage.
    find: "`connect ${SELFTEST_HOST} now`",
    replace: "`connect PLAIN now`",
  },
  {
    cell: "host-substring",
    reader: "inline host-token arrow (negative cell)",
    family: "matchCell",
    // The cell plants the host token inside a longer word to prove a whole-token matcher ignores
    // it. Remove the token and the "it is really planted" assertion must drop to 0.
    find: "`connect x${SELFTEST_HOST}y now`",
    replace: "`connect xPLAINy now`",
  },
  {
    cell: "ip-loopback",
    reader: "shapeIPv4Count",
    family: "matchCell",
    // The cell plants a real dotted quad that must not be reported as public. Replace it with text
    // carrying no IPv4 shape at all and the shape counter must drop to 0.
    find: "[127, 0, 0, 1].join('.')",
    replace: "'no address literal here'",
  },
  {
    cell: "ipv6-planted",
    reader: "shapeIPv6Count",
    family: "matchCell",
    // The IPv6 cells all pass the SAME named function, `shapeIPv6Count`, so they are one
    // equivalence class and this single case grades every one of them: hollowing that function
    // reddens all 27 together. They arrived on main after this fixture was first written, and the
    // positional census reported them as `declared=61 unaccounted=27` rather than absorbing them
    // into a neighbouring class, which is how they were noticed at all.
    //
    // The cell plants a real public IPv6 literal that must be reported. Replace it with text
    // carrying no IPv6 shape and the shape counter must drop to 0.
    find: "`connect ${SELFTEST_PUBLIC_IPV6} now`",
    replace: "'no address literal here'",
  },
  {
    cell: "ipv6-spelling-pair",
    reader: "inline spelling-pair comparison (own reader)",
    family: "inline",
    // An INLINE cell: it carries its own reader, so it is a singleton and no other case can cover
    // it. Its `planted` field counts how many of the two spellings the shape reader recognises, so
    // destroying the subject it reads drives that count to 0 and the cell must report it.
    find: "[SELFTEST_PUBLIC_IPV6, SELFTEST_PUBLIC_IPV6_EXPANDED].filter(",
    replace: "['no address literal here', 'none here either'].filter(",
  },
  {
    cell: "ipv6-hex-embedded-ipv4",
    reader: "inline hex-vs-dotted rule comparison (own reader)",
    family: "inline",
    // INLINE, singleton. Its `ipv4_rule` field counts the IPv4 findings in the hex-spelled text,
    // so destroying that planted subject drives the count to 0 and the cell must report it.
    find: "const hex = rulesFor(SELFTEST_IPV6_HEX_MAPPED);",
    replace: "const hex = rulesFor('no address literal here');",
  },
  {
    cell: "ipv6-embedded-ipv4",
    reader: "inline embedded-ipv4 rule split (own reader)",
    family: "inline",
    // INLINE, singleton. Its claim is that an IPv4-mapped IPv6 literal is reported under the IPv4
    // rule and not the IPv6 one. Remove the embedded address and both counts collapse.
    find: "`::ffff:${SELFTEST_PUBLIC_IP}`",
    replace: "'no address literal here'",
  },
  {
    cell: "home-relative",
    reader: "homeFragmentCount",
    family: "matchCell",
    // The cell plants a RELATIVE home-shaped path that must not be reported as absolute. Remove
    // the home fragment and the fragment counter must drop to 0.
    find: "`open ${SELFTEST_HOME.slice(1)}/file`",
    replace: "`open plain/file`",
  },
  {
    cell: "public-cidr-alpha-tail",
    reader: "cidrBoundaryCell planted probe",
    family: "cidrBoundaryCell",
    // `cidrBoundaryCell` builds four cells from one factory, and its `planted` discriminator is a
    // different function from anything `matchCell` uses. An adversarial reviewer hollowed that
    // probe to a constant and it SURVIVED a version of this suite that graded only matchCell
    // readers, while the suite still printed a full green. Removing the address from the positive
    // subject must drive `planted` to 0.
    find: "`${SELFTEST_PUBLIC_IP}/8suffix`",
    replace: "`no address/8suffix`",
  },
  {
    cell: "allowlisted-fixture",
    reader: "scanCell metricCount",
    family: "scanCell",
    // `scanCell` reports its discriminator under the cell's own metric name, here `allowed`, which
    // counts the allowlisted matches the scan really produced. Emptying the subject means there is
    // nothing to allow, so a live `metricCount` must report 0. Hollowing it to the expected value
    // SURVIVED while this family was exempted as a "known limit".
    find: "[{ path: 'fixtures/scrubber.txt', text: SELFTEST_HOME }], [SELFTEST_HOST], SELFTEST_ALLOWLIST",
    replace: "[{ path: 'fixtures/scrubber.txt', text: 'no literal here' }], [SELFTEST_HOST], SELFTEST_ALLOWLIST",
  },

  // THE FOUR REMAINING `scanCell` CELLS, each carrying a reader no other cell uses.
  //
  // These were not omitted by oversight. They were reported as COVERED by a coverage rule that
  // grouped cells by FACTORY, on the premise that one case driving a factory's shared discriminator
  // grades every cell it builds. That premise holds only for a factory that OWNS its discriminator.
  // `scanCell` RECEIVES its measure as an argument, so `allowlisted-fixture` having a case said
  // nothing whatever about these four, and review measured the consequence: hollowing two of these
  // readers to a constant that satisfies its own expectation left `scanEntries` uncalled, the
  // scanner reporting `cells=61/61 status=PASS` (DATED: measured at the then-current 61-cell head,
  // before #1614; the scanner builds 65 cells now), and this suite fully green. Two cells graded by
  // nothing, reported as graded by their family. The coverage rule now groups by reader, which put
  // all four here as uncovered singletons, and this is that debt paid rather than renamed.
  //
  // Each also reports under its OWN metric name, because that too is an argument: `findings`,
  // `errors` and `missing` rather than the family's `allowed`. Hence the per-case `secondaryField`.
  {
    cell: "same-token-elsewhere",
    reader: "scanCell findings count",
    family: "scanCell",
    secondaryField: "findings",
    // The cell's point is that an allowlisted fixture absorbs its own occurrence while the SAME
    // token in an ordinary source file is still reported, so `findings` must be exactly 1 with two
    // entries carrying the literal. Emptying the non-fixture entry leaves only the allowlisted one,
    // which the allowlist then absorbs: a live count reports 0 and the scan comes back `clean`.
    find: "path: 'src/output.txt', text: SELFTEST_HOME",
    replace: "path: 'src/output.txt', text: 'no literal here'",
  },
  {
    cell: "allowlist-fixture-deleted",
    reader: "scanCell errors count",
    family: "scanCell",
    secondaryField: "errors",
    // This cell's planted subject is an ABSENCE: the allowlist requires one `home-path` in
    // `fixtures/scrubber.txt`, the fixture no longer contains it, and the scan must come back
    // `broken` with exactly 1 error. The tamper therefore RESTORES the literal rather than removing
    // one. That is the same move as every other case here, destroying whatever condition this cell
    // was planted to detect: with the fixture intact the allowlist is satisfied, a live error count
    // reports 0, and a count hollowed to its expectation still says 1.
    find: "text: 'fixture removed'",
    replace: "text: SELFTEST_HOME",
  },
  {
    cell: "must-come-back-dirty",
    reader: "scanCell findings count",
    family: "scanCell",
    secondaryField: "findings",
    // An unallowlisted public address in an ordinary source file is the plainest thing the scanner
    // must catch, and this cell is the one that says so: `dirty` with exactly 1 finding and no
    // allowlist in play. Emptying the subject leaves nothing to find, so a live count reports 0 and
    // the scan comes back `clean`.
    find: "text: SELFTEST_PUBLIC_IP",
    replace: "text: 'no address'",
  },
  {
    cell: "missing-subject",
    reader: "missingSubjectResult missing count",
    family: "scanCell",
    secondaryField: "missing",
    helper: "missingSubjectResult",
    // The only one of the five whose measure is a NAMED function rather than an inline closure, so
    // the tamper goes through the helper path: the cell's marker block contains just the identifier
    // and there is nothing inside it to destroy.
    //
    // Its subject is a path that must NOT exist. `missingSubjectResult` makes a temporary directory
    // and stats a name inside it that was never created, so the stat throws and `missing` is 1.
    // Pointing that stat at the directory itself, which does exist, means the stat succeeds and a
    // live count reports 0, while a count hollowed to `Array(1)` still says 1. The scan keeps
    // coming back `broken` either way, since the entry list is empty, which is precisely why the
    // status assertion alone never graded this cell and the count has to.
    find: "lstatSync(join(dir, 'missing'))",
    replace: "lstatSync(dir)",
  },

  // THE TEN INLINE CELLS. Each is an object literal with a `measure` of its own and no factory,
  // so nothing about its reader can be inferred from a sibling and each needs its own case. Two
  // reviewers independently hollowed one of these discriminators and watched it SURVIVE at a full
  // green, each with a same-run positive control proving the cell was genuinely reached. These are
  // those cells, and the census above now refuses to pass until every one of them is named here.
  {
    cell: "workflow-host-exclusion",
    reader: "inline planted-count filter",
    // The cell's point is that a host token in a workflow file is excluded while the same token in
    // a source file is reported. `planted` is the separate assertion that the token is really in
    // the fixture texts at all, which is what stops the exclusion half from passing vacuously.
    //
    // It counts BOTH texts, so both must lose the token. Stripping only one drove it 2 -> 1 and
    // this check went red naming `planted=1/0`: a partial kill correctly refused, because a reader
    // that merely MOVED is not a reader shown to be alive.
    find: "const workflowText = `runs-on: ${SELFTEST_HOST}`;\n      const nonWorkflowText = `connect ${SELFTEST_HOST} now`;",
    replace: "const workflowText = 'runs-on: PLAIN';\n      const nonWorkflowText = 'connect PLAIN now';",
  },
  {
    cell: "short-host-token",
    reader: "hostTokenLengthFailures on a configured token",
    // The guard must reject a host token shorter than the minimum. `configured_errors` counts the
    // rejections it produced for the deliberately short token. Configure a token that is NOT short
    // and a live guard must find nothing to reject, dropping the count to 0.
    find: "hostTokenConfiguration(runtimeHostname, [], ['short'])",
    replace: "hostTokenConfiguration(runtimeHostname, [], ['a-sufficiently-long-token'])",
  },
  {
    cell: "host-token-ceiling",
    reader: "hostTokenCeilingFailures on an over-ceiling entry set",
    // The guard must reject a token matching more files than the ceiling allows. `errors` counts
    // those rejections. Strip the token from the fixture texts so nothing matches, and a live
    // guard must find no over-ceiling token to report, dropping the count to 0.
    //
    // The anchor is the fixture text, deliberately NOT the `hostTokenCeilingFailures(...)` call:
    // the mutation that hollows this cell replaces that call, so anchoring there made the tamper
    // vanish and mutation-proof reported WRONG-RED rather than a kill. A tamper whose anchor is
    // destroyed by the mutation it is meant to catch is not a reading of anything.
    find: "        text: `connect ${SELFTEST_HOST} now`,\n      }));",
    replace: "        text: 'connect PLAIN now',\n      }));",
  },
  {
    cell: "binary-skip",
    reader: "trackedEntries binarySkipped accounting",
    helper: "binaryFixtureResult",
    // The scanner must skip a NUL-bearing file rather than scan it. `binary_skipped` counts the
    // skips. Write a PNG header with no NUL byte and a live accounting must skip nothing.
    find: "Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])",
    replace: "Buffer.from('plain text, no nul byte')",
  },
  {
    cell: "production-main-wiring",
    reader: "SKIP_ROW emission from the real main()",
    helper: "productionPathFixtureResult",
    // This drives the REAL main() over a fixture repository and asserts it emits exactly one
    // SKIP_ROW for the binary file. `skip_rows` counts those rows. Write that fixture without a NUL
    // byte and a live main() has nothing to skip, so the count must drop to 0.
    find: "writeFileSync(join(dir, 'fixture.bin'), Buffer.from([0x66, 0x69, 0x78, 0x00]));",
    replace: "writeFileSync(join(dir, 'fixture.bin'), Buffer.from('fix'));",
  },
  {
    cell: "production-short-token-guard",
    reader: "ERROR_ROW reason text from the real main()",
    // The short-token guard must fire END TO END, not just in isolation: this passes `--host-token
    // short` to the real main() and counts the ERROR_ROWs carrying the too-short reason. Pass a
    // long token instead and a live guard must emit none.
    find: "productionPathFixtureResult({ argumentHostTokens: ['short'] })",
    replace: "productionPathFixtureResult({ argumentHostTokens: ['a-sufficiently-long-token'] })",
  },
  {
    cell: "production-token-ceiling-guard",
    reader: "ERROR_ROW reason text from the real main() at the ceiling",
    // The ceiling guard, likewise end to end. `reason_rows` counts ERROR_ROWs carrying the
    // too-many-files reason. Drop the fixture below the ceiling and a live guard must emit none.
    find: "matchingFiles: HOST_TOKEN_FILE_CEILING + 1,",
    replace: "matchingFiles: 0,",
  },
  // The four cells #1614 added to the scanner while this branch sat in review. They are INLINE
  // object literals, so each carries its own reader and is a singleton class: no existing case can
  // cover them, and the census reported all four as unaccounted the moment this branch was rebased.
  {
    cell: "sentence-final-period-ipv6",
    reader: "the sentence-final IPv6 pair, both arms read from the planted array",
    secondaryField: "secondary",
    // Both arms read the SAME planted array, so the subject is destroyed once for both: a live
    // pair reports 0/0 on clean text, and either arm hardwired to 10 still prints 10 and reds here.
    find: "      const primary = SELFTEST_SENTENCE_IPV6.filter((text) => findings(text, 'fixture', [SELFTEST_HOST]).some((f) => f.rule === 'public-ipv6')).length;\n      const secondary = SELFTEST_SENTENCE_IPV6.filter((text) => shapeIPv6Count(text) === 1).length;",
    replace: "      const primary = ['The broker is elsewhere.'].filter((text) => findings(text, 'fixture', [SELFTEST_HOST]).some((f) => f.rule === 'public-ipv6')).length;\n      const secondary = ['The broker is elsewhere.'].filter((text) => shapeIPv6Count(text) === 1).length;",
  },
  {
    cell: "sentence-final-period-ipv4",
    reader: "public-ipv4 findings over the planted sentence array",
    secondaryField: "ipv4_rule",
    find: "SELFTEST_SENTENCE_IPV4.filter((text) => findings(text, 'fixture', [SELFTEST_HOST]).some((f) => f.rule === 'public-ipv4')).length",
    replace: "['The broker is elsewhere.'].filter((text) => findings(text, 'fixture', [SELFTEST_HOST]).some((f) => f.rule === 'public-ipv4')).length",
  },
  {
    cell: "letter-adjacent-address",
    reader: "public-ipv4 and public-ipv6 findings on letter-adjacent subjects",
    secondaryField: "ipv6_rule",
    // Both subjects are destroyed together for the same reason as the IPv6 pair above: the cell
    // passes only when BOTH arms read 1, so leaving one arm planted would grade half the cell.
    find: "      const ipv4 = findings(SELFTEST_LETTER_ADJACENT_IPV4, 'fixture', [SELFTEST_HOST])\n        .filter((finding) => finding.rule === 'public-ipv4').length;\n      const ipv6 = findings(SELFTEST_LETTER_ADJACENT_IPV6, 'fixture', [SELFTEST_HOST])\n        .filter((finding) => finding.rule === 'public-ipv6').length;",
    replace: "      const ipv4 = findings('no address here', 'fixture', [SELFTEST_HOST])\n        .filter((finding) => finding.rule === 'public-ipv4').length;\n      const ipv6 = findings('no address here', 'fixture', [SELFTEST_HOST])\n        .filter((finding) => finding.rule === 'public-ipv6').length;",
  },
  {
    // A REFUSAL CELL, and the reason this runner needed a second direction.
    //
    // Its baseline row is `name_tail=0/0`: it asserts that a path-tailed address is NOT reported.
    // Destroying its subject leaves the field at 0, so the drive-to-zero kill every other case uses
    // cannot discriminate here, and the baseline control above would red on a perfectly live cell.
    // The exemption list cannot take it either: `validateUngraded` accepts only the claim "no
    // gradable field in the baseline row" and this cell DOES emit one, so an entry for it is
    // refused with `baseline reports name_tail=0`. Both of the usual doors are shut, which is what
    // a zero-expectation cell does to a suite that only grades in one direction.
    //
    // So the subject is replaced with one the suite already PROVES is reported: the first element
    // of the array `sentence-final-period-ipv4` measures at 10/10. A live `findings` reads it and
    // the count rises above 0; a `findings` hollowed to return [] reports 0 both before and after
    // and fails the kill. The anti-vacuity control is the inversion itself: a reader hardwired to 0
    // fails the kill, and one hardwired to nonzero fails the baseline.
    cell: "sentence-final-period-refuses-name",
    reader: "findings on a path-tailed address, graded by planting a reportable one",
    secondaryField: "name_tail",
    refusal: true,
    find: "findings(SELFTEST_SENTENCE_NAME_TAIL, 'fixture', [SELFTEST_HOST]).length",
    replace: "findings(SELFTEST_SENTENCE_IPV4[0], 'fixture', [SELFTEST_HOST]).length",
  },
];

/**
 * The cells this suite must account for, read from the scanner's own `SELFTEST_CELLS` array.
 *
 * COVERAGE IS OVER CELLS, AND THE FACTORY IS ONLY A GROUPING. An earlier version enumerated cell
 * FACTORIES and treated a case per factory as covering everything that factory built. That is true
 * as far as it goes, and it is not far enough: 14 of the scanner's 65 cells are INLINE object
 * literals with a `measure` of their own and no factory at all, so a census over factories cannot
 * see them by construction. Two reviewers found that independently, and it is the same defect as
 * #1580 itself a third time: an enumeration whose denominator silently excludes the thing being
 * asked about.
 *
 * So the denominator is the CELL LIST, parsed from the AST, partitioned into:
 *   factory cells  built by a call, e.g. matchCell(...). One case per factory grades all of them,
 *                  since hollowing the factory's discriminator kills every cell it builds.
 *   inline cells   an object literal carrying its own `measure`. Each has its own reader, so each
 *                  needs its own case; none can be inferred from another.
 * Every cell must land in one partition and every partition must be accounted for, so a cell added
 * in either style fails loudly rather than joining an ungraded remainder.
 */
/**
 * THE FACTORY CONTRACTS, declared rather than inferred.
 *
 * `arity` is the exact argument count the product's signature takes, and `readerIndex` is the
 * position at which that factory RECEIVES its discriminator, or null when it OWNS one. Both are
 * transcribed from scripts/check-operator-literals.mjs:
 *   matchCell(id, text, rule, expectedPrimary, secondaryReader, expectedSecondary)
 *   scanCell(id, expectedStatus, metric, expectedCount, measure)
 *   cidrBoundaryCell(id, positive, control, rule)
 *
 * Arity is checked as well as the index because a signature change that inserts a parameter would
 * otherwise silently move the reader while this table kept reading the old slot and reporting a
 * confident wrong class. A mismatch here makes every cell of that factory a singleton, so the
 * coverage row goes RED and names them, rather than quietly re-partitioning the census.
 */
const FACTORY_CONTRACTS = new Map([
  ["matchCell", { arity: 6, readerIndex: 4 }],
  ["scanCell", { arity: 5, readerIndex: 4 }],
  ["cidrBoundaryCell", { arity: 4, readerIndex: null }],
]);

/**
 * The reader class a cell carries, read at its factory's contract position.
 *
 * Returns one of:
 *   `<identifier>`      a SHARED class: every cell naming that function dies together when it is
 *                       hollowed, so one case covering any of them covers all of them.
 *   `owned@<factory>`   the factory owns its discriminator and takes none, so its cells are one
 *                       class by construction.
 *   `inline@<cellId>`   a SINGLETON: a direct function literal is a distinct function object no
 *                       other cell uses, so only a case naming this cell covers it.
 *   `opaque@<cellId>`   a SINGLETON by REFUSAL: an unknown factory, a mismatched arity, or any
 *                       other expression at the reader position (a wrapper call, a conditional, a
 *                       member access). We cannot prove what function this cell ends up carrying,
 *                       so we never let it share a class. It is covered only by its own case.
 *
 * The two singleton forms are distinct in the detail string so a red row says whether a cell is
 * genuinely inline or is a shape this census refused to classify.
 */
const readerIdentity = (factoryName, cellId, args) => {
  const contract = FACTORY_CONTRACTS.get(factoryName);
  if (!contract || args.length !== contract.arity) return `opaque@${cellId}`;
  if (contract.readerIndex === null) return `owned@${factoryName}`;
  const arg = args[contract.readerIndex];
  if (!arg) return `opaque@${cellId}`;
  if (ts.isIdentifier(arg)) return arg.text;
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return `inline@${cellId}`;
  // A PARENTHESIZED identifier, `(shapeIPv4Count)`, is deliberately NOT unwrapped, though it does
  // denote the same function object and unwrapping it would be sound. Unwrapping is a rule about
  // which expressions may be PEELED before classification, and the wrapper defect was exactly a
  // rule of that kind applied one step too far. No cell in the scanner is written that way (grep
  // count 0 at this commit), so unwrapping would buy nothing and would reopen the question of what
  // else deserves peeling. The cost of refusing is bounded and loud: such a cell reports UNCOVERED
  // and someone adds a case or deletes the parentheses. The cost of peeling wrongly is silent
  // inherited coverage. When the two errors are not symmetric, take the one that shouts.
  return `opaque@${cellId}`;
};

const readCellInventory = (source) => {
  const sf = ts.createSourceFile("scanner.mjs", source, ts.ScriptTarget.Latest, true);
  const factories = new Set();
  const byFactory = new Map();
  const inline = [];
  const readerById = new Map();
  const unclassified = [];
  let total = 0;
  const literalText = (node) =>
    node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === "SELFTEST_CELLS"
      && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
      for (const element of node.initializer.elements) {
        if (ts.isCallExpression(element)) {
          total += 1;
          const name = element.expression.getText();
          factories.add(name);
          // The first argument is the cell id. Reading it lets the census say which cells a
          // factory's case actually covers, instead of assuming the mapping.
          const id = literalText(element.arguments[0]);
          if (!byFactory.has(name)) byFactory.set(name, []);
          if (id) byFactory.get(name).push(id);
          // AND THE DISCRIMINATOR THIS CELL ACTUALLY CARRIES, by identity rather than by factory.
          //
          // A factory that OWNS its discriminator is one equivalence class: hollowing the shared
          // function kills every cell it builds, so one case genuinely grades all of them. A
          // factory that RECEIVES the discriminator as an ARGUMENT is not. `matchCell` takes its
          // secondary reader as a parameter, so two of its cells can carry entirely different
          // functions, and review demonstrated the consequence: a new `matchCell` cell with its own
          // inline reader was counted, declared and accounted as covered, and hollowing that reader
          // left the suite fully green. Nothing graded it.
          //
          // So the reader is recorded as the argument's own text. An IDENTIFIER is a shared class,
          // since every cell naming it dies together when it is hollowed. An inline function
          // expression is its OWN class, because it is a distinct function object no other cell
          // uses, which is what the case list must then cover.
          // The discriminator is read AT THE FACTORY'S OWN PARAMETER POSITION, never by searching
          // the argument list for something that looks like a reader.
          //
          // This scanned backward from the end and took the first identifier or function
          // expression it met. Review defeated it in one line by WRAPPING the reader:
          //   matchCell('wrapped', shapeIPv4Count, 'host-name', 0, ((r) => r)((t) => ...), 1)
          // The wrapper is a CallExpression, so the scan skipped it, walked back into argument 1,
          // found the SUBJECT identifier `shapeIPv4Count`, and recorded that as the cell's reader.
          // `ip-loopback` has a case on that named class, so the wrapped cell inherited coverage it
          // did not have: hollowing its real inner reader left the suite green at 119/119. A search
          // for a plausible shape will always answer with the wrong argument for some spelling,
          // which is this file's recurring defect one level in.
          //
          // So the contract is declared rather than inferred. Each factory states its arity and the
          // index at which it RECEIVES its discriminator, taken from the product's own signatures:
          //   matchCell(id, text, rule, expectedPrimary, secondaryReader, expectedSecondary)
          //   scanCell(id, expectedStatus, metric, expectedCount, measure)
          //   cidrBoundaryCell(id, positive, control, rule)   <- receives none, OWNS its logic
          // A factory that owns its discriminator is one equivalence class, so its cells share
          // `owned@<factory>` and one case grades them all.
          //
          // Everything else FAILS CLOSED to a singleton named for the cell. An unknown factory, an
          // arity that does not match the contract, or any expression at the reader position that
          // is not a bare identifier or a direct function literal is its own class and can be
          // covered only by a case naming that cell. A singleton can make a cell report UNCOVERED,
          // which is a loud red; it can never hand a cell someone else's coverage, which is the
          // silent direction the wrapper exploited.
          if (id) {
            readerById.set(id, readerIdentity(name, id, element.arguments));
          }
        } else if (ts.isObjectLiteralExpression(element)) {
          total += 1;
          const id = element.properties.find(
            (property) => property.name && property.name.getText() === "id",
          );
          const text = id && ts.isPropertyAssignment(id) ? literalText(id.initializer) : undefined;
          inline.push(text ?? "(unnamed inline cell)");
        } else {
          // REFUSE WHAT CANNOT BE CLASSIFIED, rather than skipping it.
          //
          // This branch used to be absent, so any element that was neither a call nor an object
          // literal was silently not counted. Review spread a live cell into this array,
          // `...[matchCell('extra', ...)],`, and a SpreadElement is neither: the scanner executed
          // 62 cells and this reader reported 61, while the marker reader also reported 61 because
          // the spread carried no comments. Two readers, one shared convention, mutual agreement on
          // an omission.
          //
          // Unpacking spreads would be an enumeration of syntaxes, and this file's history is that
          // every enumeration is defeated by the construction it did not list. Refusing is the
          // opposite shape: a new spelling fails LOUDLY here instead of passing silently, so the
          // failure mode of a future change is a red build rather than an ungraded cell.
          unclassified.push(ts.SyntaxKind[element.kind]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { factories: [...factories], byFactory, inline, total, unclassified, readerById };
};

/**
 * Cells deliberately left ungraded, each with the reason it cannot be graded.
 *
 * This list is empty, and that is a measurement rather than a default. The one entry it used to
 * carry claimed `scanCell` had no gradable discriminator; a reviewer hollowed the field and showed
 * it did, under the metric's own name. A limitation ASSERTED rather than MEASURED is a gap wearing
 * a label, and the label makes it less likely anyone looks again. Anything added here needs the
 * hollowing attempt that justifies it quoted in the reason.
 *
 * THIS LIST IS AN ESCAPE HATCH, AND AN UNVALIDATED ESCAPE HATCH IS A HOLE THE SIZE OF THE WHOLE
 * SUITE. Review demonstrated it: with a wrapped reader hollowed to a constant, adding the single
 * line
 *
 *     const UNGRADED_CELLS = [{ cell: "wrapped-reader-extra" }];
 *
 * with no reason at all, the scanner reported 62/62 PASS and this suite reported 144/144 at exit 0.
 * The opposite control proved the hidden reader was live: flipping the constant to `() => 0` drove
 * the product to exit 2 and the suite to 44 real failures. So the exemption was silently restoring
 * exactly the wrong-green the positional census had just closed, one line at a time. The accounting
 * check read `entry.cell` and nothing else; the docblock promised a reason and no code required
 * one.
 *
 * Every entry must now carry:
 *   cell    a declared cell id. An entry naming a cell that does not exist is a stale exemption,
 *           and a stale exemption is how a grading requirement silently evaporates when a cell is
 *           renamed, so an unknown id is fatal rather than ignored.
 *   reason  a nonempty justification, enforced, not merely documented.
 *
 * A reason is prose and prose cannot be checked, so the requirement is deliberately not "say
 * something". The list is EMPTY here and the validator makes adding an entry cost more than a line:
 * it must name a real cell and state why. That does not make an exemption honest, and it is not
 * meant to. It makes an exemption VISIBLE and ATTRIBUTABLE, so the loud path stays loud and the
 * silent path stops being one line long.
 */
const UNGRADED_CELLS = [];

/**
 * Exemptions planted to drive the validator, concatenated onto the real list at its ONE call site.
 *
 * They live here rather than inside the check because the real list is empty, so the validator
 * would otherwise never run on real data and a mutation deleting it would survive. Each entry fails
 * for a different reason, including both forms review used: a bare cell id, and a cell id with a
 * satisfying sentence attached. The last is fully formed and still refused, by measurement, on the
 * strength of the cell's own baseline row.
 */
const PLANTED_EXEMPTIONS = [
  { cell: "ip-loopback" },
  { cell: "ip-loopback", reason: "   " },
  { cell: "ip-loopback", reason: "cannot be graded" },
  { cell: "ip-loopback", reason: "cannot be graded", provenBy: "no gradable field in the baseline row" },
  { cell: "no-such-cell-anywhere", reason: "stale exemption naming a renamed cell" },
  { reason: "no cell id at all" },
];

/** The cell factories, and the field each one's discriminator reports. */
const FACTORIES = [
  { name: "matchCell", secondaryField: "secondary" },
  { name: "cidrBoundaryCell", secondaryField: "planted" },
  { name: "scanCell", secondaryField: "allowed" },
];

/**
 * The inline cells, each with the field its own `measure` reports.
 *
 * These have no factory, so nothing about them can be inferred from a sibling: each carries its own
 * reader. A reviewer demonstrated the cost of leaving them out by hollowing
 * `workflow-host-exclusion`'s inline `planted` computation to a constant and watching it survive at
 * a full green, with a same-run positive control proving the cell really was reached.
 *
 * The FIELD each one reports is a property of that cell's own code and cannot be read off the
 * array, so this list is written out. It is held to the source rather than trusted: the registry
 * check below requires it to match the inline cells the AST inventory finds, IN BOTH DIRECTIONS.
 *
 * THAT CHECK IS NEW, AND IT IS WHY THIS ARRAY NOW READS 14 RATHER THAN 10. This comment already
 * claimed bidirectionality and the code did not provide it: the only enforced direction was
 * claimed -> source (`census: every cell this suite names is actually declared in the scanner`,
 * which filters these names against the scanner's markers). Nothing checked source -> claimed, so
 * when #1614 added four INLINE cells they never reached this array and the suite stayed green at
 * 173/173 with the registry four entries short. Being listed here is not coverage and never was,
 * so the gap cost no grading; it cost the registry its accuracy, silently.
 *
 * A comment asserting a guarantee the code does not provide is a stale figure in prose form. The
 * guarantee is now implemented rather than the sentence deleted, because the next four cells are
 * already coming.
 */
const INLINE_CELLS = [
  { name: "ipv6-spelling-pair", secondaryField: "planted" },
  { name: "ipv6-hex-embedded-ipv4", secondaryField: "ipv4_rule" },
  { name: "ipv6-embedded-ipv4", secondaryField: "planted" },
  { name: "workflow-host-exclusion", secondaryField: "planted" },
  { name: "short-host-token", secondaryField: "configured_errors" },
  { name: "host-token-ceiling", secondaryField: "errors" },
  { name: "binary-skip", secondaryField: "binary_skipped" },
  { name: "production-main-wiring", secondaryField: "skip_rows" },
  { name: "production-short-token-guard", secondaryField: "reason_rows" },
  { name: "production-token-ceiling-guard", secondaryField: "reason_rows" },
  // #1614's four, added to the scanner while this branch sat in review. They were absent from this
  // registry and nothing made that fail, which is the defect the both-directions check below fixes.
  { name: "sentence-final-period-ipv6", secondaryField: "secondary" },
  { name: "sentence-final-period-ipv4", secondaryField: "ipv4_rule" },
  { name: "letter-adjacent-address", secondaryField: "ipv6_rule" },
  { name: "sentence-final-period-refuses-name", secondaryField: "name_tail" },
];

/**
 * A working directory the scanner's self-execute guard can survive.
 *
 * The guard used to be ``import.meta.url === `file://${process.argv[1]}` ``, comparing a real URL
 * against a string built by concatenation. Those agree only for paths needing no URL escaping, so
 * TWO host conditions silently broke it, and each made a spawned copy exit 0 having run NOTHING:
 *   symlinked TMPDIR   `import.meta.url` resolves symlinks, `process.argv[1]` does not
 *   a space in TMPDIR  the URL percent-encodes it, the concatenated string does not
 * Neither was found by reading. The first was caught by the untampered-copy control below, the
 * second by an adversarial reviewer who set TMPDIR to a directory containing a space.
 *
 * The scanner now asks `isMainEntry`, which resolves both sides to a real path, so neither
 * condition can disable a copy today. The workdir is still realpath'd and still REJECTED outright
 * when its URL form differs from the naive concatenation, and that is deliberate rather than
 * leftover: it is the one place a regression of that guard turns into a single named refusal
 * instead of sixty-six spawned copies reporting phantom reds whose cause no reader can see. The
 * repository is the fallback base. If no usable base exists this THROWS with the reason.
 */
const guardSafe = (path) => pathToFileURL(path).href === `file://${path}`;

const makeWorkdir = () => {
  const rejected = [];
  for (const base of [tmpdir(), ROOT]) {
    let candidate;
    try {
      mkdirSync(base, { recursive: true });
      candidate = realpathSync(mkdtempSync(join(base, "operator-literal-celltamper-")));
    } catch (error) {
      rejected.push(`${base}: ${error.message}`);
      continue;
    }
    if (guardSafe(candidate)) return { dir: candidate, base, created: candidate };
    removeSelfTestDir(candidate, base, candidate);
    rejected.push(`${candidate}: needs URL escaping, so the scanner's self-execute guard cannot fire there`);
  }
  throw new Error(
    `no usable working directory: a copied scanner would exit 0 having run nothing.\n  ${rejected.join("\n  ")}`,
  );
};

const workspace = makeWorkdir();
const workdir = workspace.dir;

// The scanner imports `./main-entry.mjs`, so a copy needs that sibling next to it or every spawned
// copy dies on module resolution instead of grading anything. Copied once, untampered: the tampers
// below are edits to the scanner's own source and none of them touches this file. A copy that
// arrives without it fails the untampered-copy control loudly, which is where that control earns
// its place.
writeFileSync(join(workdir, "main-entry.mjs"), readFileSync(join(HERE, "main-entry.mjs"), "utf8"));

/**
 * GRADE THE TWO FUNCTIONS THAT CHOOSE WHERE EVERY TAMPER RUNS.
 *
 * `guardSafe` and `makeWorkdir` were UNGRADED, and they are the load-bearing pair: if `guardSafe`
 * stops rejecting, `makeWorkdir` hands back a path whose URL form differs from the concatenation
 * the scanner's self-execute guard compares against, every spawned copy exits 0 having run NOTHING,
 * and every kill below reads a silence as a pass. Nothing in the kill loop can see that, because a
 * scanner that ran nothing and a scanner whose cell passed both print no failure.
 *
 * Hollowing either one is a NO-OP ON A HEALTHY HOST, which is exactly why neither was graded by
 * accident: on this box `tmpdir()` needs no escaping, so `guardSafe = () => true` changes no
 * observable behaviour anywhere in the run. So these checks do not wait for a hostile host. They
 * feed `guardSafe` both answers directly, and they assert `makeWorkdir`'s own postcondition.
 *
 * Killed by, each run at this head and each observed red:
 *   `const guardSafe = (path) => true;`  -> exit 1, 174/175, red on the rejecting check BY NAME.
 *     This is the one the fixture scores, because `expectRed` needs a named check row to match.
 *   `const guardSafe = (path) => false;` -> exit 1, but it THROWS out of makeWorkdir at module load
 *     ("no usable working directory: a copied scanner would exit 0 having run nothing") before any
 *     check runs, so there is no check row at all. Red, and red for the right reason, but it is a
 *     crash rather than a graded reading, so it is recorded here and NOT scored in the fixture.
 */
check(
  "guardSafe accepts a path whose URL form equals the naive concatenation",
  guardSafe(join(workdir, "plain-name")) === true,
  `guardSafe(plain)=${guardSafe(join(workdir, "plain-name"))}/true`,
);
check(
  "guardSafe rejects a path that needs URL escaping, so a silently-inert copy cannot be chosen",
  guardSafe(join(workdir, "needs escaping #1")) === false,
  `guardSafe(escaping)=${guardSafe(join(workdir, "needs escaping #1"))}/false`,
);
check(
  "makeWorkdir returns a realpath'd directory its own guard accepts",
  typeof workdir === "string" && workdir.length > 0 && realpathSync(workdir) === workdir
    && guardSafe(workdir),
  `workdir=${workdir} realpath_stable=${realpathSync(workdir) === workdir} guardSafe=${guardSafe(workdir)}`,
);

try {
  const tracked = readFileSync(SCANNER, "utf8");

  // Baseline, run through the TRACKED scanner itself. This is also what witnesses that this suite
  // executes the file it grades: the mutated path is the one spawned here.
  const baseline = runTrackedSelftest();
  const baseSummary = summary(baseline.rows);
  check(
    "baseline: the tracked scanner reports every required cell passing and exits 0",
    baseline.exitCode === 0 && baseSummary !== undefined
      && baseSummary.status === "PASS" && baseSummary.passed === baseSummary.total,
    `exit=${baseline.exitCode}/0 cells=${baseSummary?.passed}/${baseSummary?.total} status=${baseSummary?.status}`,
  );

  // An untampered COPY must behave exactly like the tracked file. Without this, a copy that failed
  // to run for an unrelated reason would make every tamper below look like it "went red" when in
  // fact nothing was measured. This is the refuse control for the whole harness.
  const copyPath = join(workdir, "copy-untampered.mjs");
  writeFileSync(copyPath, tracked);
  const copyRun = runSelftest(copyPath);
  const copySummary = summary(copyRun.rows);
  const copyOk = check(
    "control: an UNTAMPERED copy reproduces the baseline, so a red below is caused by the tamper",
    copyRun.exitCode === 0 && copySummary !== undefined
      && copySummary.status === "PASS" && copySummary.passed === copySummary.total,
    `exit=${copyRun.exitCode}/0 cells=${copySummary?.passed}/${copySummary?.total} status=${copySummary?.status}`,
  );

  // THE CENSUS, over CELLS. The denominator is every cell the scanner declares, not every factory.
  //
  // This was pointed at factories for two rounds and it was the wrong denominator. A case list
  // grades what it names and stays silent about what it forgot, so the census exists to make that
  // silence loud; but a census over FACTORIES inherits the same blindness one level up. 14 of the
  // scanner's 65 cells are inline object literals built by no factory at all, so no factory
  // enumeration, however perfect, can see them. A reviewer proved the cost rather than arguing it:
  // hollowing `workflow-host-exclusion`'s inline discriminator to a constant left the scanner at
  // cells=61/61 exit 0 AND this suite at a full green (DATED: measured at the then-current 61-cell
  // head, before #1614), with a same-run positive control showing the cell really was reached. Live code that both instruments declined to grade.
  //
  // Two earlier readers were defeated here and both failures came from reading TEXT rather than
  // structure: `function matchCell(` -> `function matchCell (` silently shrank the denominator, and
  // a declaration-shaped line inside a template literal stood in for a factory that had been
  // refactored away. Widening a pattern only moves the boundary to the next spelling.
  //
  // The fix is not a better pattern, it is the right denominator read by a reader already proven
  // robust. The `// SELFTEST_CELL <id> START/END` markers are what the tampers themselves key on,
  // and that reader was probed hard in review: a renamed cell reports `found 0/0`, a reformatted
  // one reports `occurs 0 time(s)`, and a marker quoted in a comment reports `found 2/2`. It
  // refuses ambiguity instead of guessing, which is exactly what a denominator needs to do.
  //
  // MARKERS ARE READ AS COMMENT TRIVIA FROM THE AST, not as lines of text.
  //
  // A line-anchored regex cannot tell a COMMENT from a LINE INSIDE A STRING, and a reviewer proved
  // the distinction is reachable: deleting the real `ip-zero START` marker and planting that exact
  // line inside a multi-line template literal left every row unchanged at `starts=61 ends=61
  // duplicates=0 unpaired=0` while the cell's real marker was gone. The suite even carried a
  // control claiming the reader "refuses a marker quoted in a string", and that control passed,
  // because it only ever fed the reader a ONE-LINE string. A control that tests a narrower case
  // than the claim it is attached to is worse than no control: it converts an untested claim into
  // an apparently tested one.
  //
  // This is the third time in this lane that reading characters instead of code lost a denominator
  // in silence, after `function matchCell (` and the declaration-shaped template literal. The
  // scanner is parsed once here and comment trivia is enumerated from the tree, so a marker inside
  // a string of any shape is not trivia and cannot be seen, while a real comment always is.
  // EVERY TOKEN is visited, via `getChildren()`, not every NODE.
  //
  // Trivia attaches to tokens, and punctuation tokens are not nodes. The scanner's cell array ends
  // with `];`, so its last END marker is leading trivia of that `]`. A node-only walk therefore
  // reported `starts=61 ends=60 unpaired=1 [missing-subject]` on a perfectly healthy file, and my
  // own planted control caught the same hole in the same run at `planted_unpaired=0/1`.
  //
  // A RAW TOKEN SCANNER IS NOT THE ANSWER EITHER, and it was tried: `ts.createScanner` over the
  // text has no parser context, so it cannot resolve whether `/` opens a regex or divides, and it
  // desynced and found 3 of 61 markers. That failed loudly, in the ALARMING direction, and the
  // fix was to take positions from the parsed tree instead of re-deciding them.
  const readMarkers = (source) => {
    const sf = ts.createSourceFile("scanner.mjs", source, ts.ScriptTarget.Latest, true);
    const text = sf.getFullText();
    const found = [];
    const seen = new Set();
    const collect = (fullStart) => {
      for (const range of ts.getLeadingCommentRanges(text, fullStart) ?? []) {
        if (seen.has(range.pos)) continue;
        seen.add(range.pos);
        const match = /^\/\/ SELFTEST_CELL (\S+) (START|END)$/.exec(text.slice(range.pos, range.end).trim());
        if (match) found.push({ id: match[1], kind: match[2], pos: range.pos });
      }
    };
    const visit = (node) => {
      collect(node.getFullStart());
      for (const child of node.getChildren(sf)) visit(child);
    };
    visit(sf);
    // Deduplicated by SOURCE POSITION, never by id: two markers sharing an id are exactly the
    // defect this reader exists to report, and collapsing them by id would hide it.
    return found.sort((a, b) => a.pos - b.pos);
  };

  const readMarkerIntegrity = (source) => {
    const markers = readMarkers(source);
    const starts = markers.filter((marker) => marker.kind === "START").map((marker) => marker.id);
    const ends = markers.filter((marker) => marker.kind === "END").map((marker) => marker.id);
    return {
      starts,
      ends,
      duplicates: starts.filter((id, index) => starts.indexOf(id) !== index),
      unpaired: [
        ...starts.filter((id) => !ends.includes(id)),
        ...ends.filter((id) => !starts.includes(id)),
      ],
    };
  };
  const readCellIds = (source) => readMarkerIntegrity(source).starts;
  const declaredCells = readCellIds(tracked);
  const inventory = readCellInventory(tracked);
  const factoryCellIds = inventory.byFactory;

  // EVERY MARKER ID MUST BE UNIQUE AND PAIRED. A COUNT IS NOT A SET, and that distinction was a
  // BLOCK: an earlier version compared only how MANY markers and parsed cells existed, and a
  // reviewer defeated it with a single-token edit. Renaming one START marker
  // (`ip-zero` -> `ip-private`, a cell id already in use) kept the count at 61 while LOSING one id
  // and DUPLICATING another, leaving a START/END pair mismatched. Every row still read
  // `markers=61 parsed_cells=61 ... unaccounted=0` and the suite passed in full. (DATED: that round
  // was measured at the then-current 61-cell head, before #1614.)
  //
  // Two totals can agree while the things they count differ, so equal counts prove nothing about
  // membership. Duplicates are what make that possible, and a duplicate id is independently fatal:
  // `tamperCell` requires exactly one START/END pair, so a duplicated id silently disarms the
  // tamper for BOTH cells that share it.
  const integrity = readMarkerIntegrity(tracked);
  check(
    "census: every cell marker id is unique and has a matching START and END",
    integrity.starts.length > 0 && integrity.duplicates.length === 0 && integrity.unpaired.length === 0,
    `starts=${integrity.starts.length} ends=${integrity.ends.length} duplicates=${integrity.duplicates.length}${integrity.duplicates.length ? ` [${[...new Set(integrity.duplicates)].join(", ")}]` : ""} unpaired=${integrity.unpaired.length}${integrity.unpaired.length ? ` [${[...new Set(integrity.unpaired)].join(", ")}]` : ""}`,
  );

  // The two readers must agree on WHICH cells exist, compared as sets in both directions. They are
  // independent (marker comments versus the SELFTEST_CELLS array parsed from the AST), so any
  // disagreement means one of them is wrong and the denominator is unsafe to quantify over.
  const compareCellSets = (markerIds, parsedCellIds) => ({
    onlyInMarkers: markerIds.filter((id) => !parsedCellIds.includes(id)),
    onlyInParsed: parsedCellIds.filter((id) => !markerIds.includes(id)),
  });
  const parsedIds = [...inventory.byFactory.values()].flat().concat(inventory.inline);
  const { onlyInMarkers, onlyInParsed } = compareCellSets(declaredCells, parsedIds);
  check(
    "census: the marker reader and the parsed cell array name the same cells, not merely as many",
    declaredCells.length > 0 && onlyInMarkers.length === 0 && onlyInParsed.length === 0,
    `markers=${declaredCells.length} parsed=${parsedIds.length} (factory=${parsedIds.length - inventory.inline.length} inline=${inventory.inline.length})${onlyInMarkers.length ? ` MARKER ONLY [${onlyInMarkers.join(", ")}]` : ""}${onlyInParsed.length ? ` PARSED ONLY [${onlyInParsed.join(", ")}]` : ""}`,
  );

  // THE INLINE REGISTRY IS HELD TO THE SOURCE IN BOTH DIRECTIONS.
  //
  // `INLINE_CELLS` records the field each inline cell's own reader reports, which cannot be read
  // off the AST. Until this check existed only claimed -> source was enforced, so an inline cell
  // added to the scanner never had to reach the registry: #1614 added four and the suite stayed
  // green with the registry four entries short, under a comment claiming both directions. A
  // registry that only has to shrink stops describing the thing it indexes without ever going red.
  // The real reading and BOTH planted controls go through this one function on purpose. An earlier
  // revision of this check called `compareCellSets` separately for the real comparison and for each
  // control, and that was measured to be hollow: replacing the real call with a constant
  // `{ onlyInMarkers: [], onlyInParsed: [] }` left the suite at a full green, because the controls
  // exercised a different call than the one the verdict was read from. That is this file's own
  // subject reproduced inside the check meant to close it, so the reading is shared instead.
  const compareRegistry = (registry, sourceInline) => compareCellSets(registry, sourceInline);
  const inlineRegistry = INLINE_CELLS.map((entry) => entry.name);
  const registryVsSource = compareRegistry(inlineRegistry, inventory.inline);
  check(
    "inline registry: INLINE_CELLS names exactly the inline cells the inventory finds, in both directions",
    inventory.inline.length > 0
      && registryVsSource.onlyInMarkers.length === 0 && registryVsSource.onlyInParsed.length === 0,
    `registry=${inlineRegistry.length} inventory=${inventory.inline.length}${registryVsSource.onlyInParsed.length ? ` NOT IN REGISTRY [${registryVsSource.onlyInParsed.join(", ")}]` : ""}${registryVsSource.onlyInMarkers.length ? ` NOT IN SOURCE [${registryVsSource.onlyInMarkers.join(", ")}]` : ""}`,
  );

  // Both directions get their own planted positive, because a control on one says nothing about the
  // other, and it is the source -> registry direction that was missing and must be shown to bite.
  const plantedUnregistered = compareRegistry(inlineRegistry, [...inventory.inline, "planted-inline-cell"]);
  const plantedUnsourced = compareRegistry([...inlineRegistry, "planted-registry-cell"], inventory.inline);
  check(
    "inline registry control: an unregistered inline cell and an unsourced registry name are each reported",
    plantedUnregistered.onlyInParsed.length === 1
      && plantedUnregistered.onlyInParsed[0] === "planted-inline-cell"
      && plantedUnsourced.onlyInMarkers.length === 1
      && plantedUnsourced.onlyInMarkers[0] === "planted-registry-cell",
    `planted_unregistered=${plantedUnregistered.onlyInParsed.length}/1 [${plantedUnregistered.onlyInParsed.join(", ")}] planted_unsourced=${plantedUnsourced.onlyInMarkers.length}/1 [${plantedUnsourced.onlyInMarkers.join(", ")}]`,
  );

  // The parsed reader must not have SKIPPED anything in that array. See its refusal branch: an
  // element it cannot classify is recorded rather than ignored, and this is where that is graded.
  // The control is planted against a synthetic source rather than against the real one, because the
  // real one is required to be empty here and an empty list proves nothing about the reader.
  const plantedUnclassified = readCellInventory(
    "const SELFTEST_CELLS = [matchCell('a'), ...[matchCell('b')], { id: 'c' }];",
  );
  check(
    "census: the cell array holds nothing the parsed reader cannot classify, and the reader is proven able to say so",
    inventory.unclassified.length === 0 && plantedUnclassified.unclassified.length === 1
      && plantedUnclassified.unclassified[0] === "SpreadElement",
    `unclassified=${inventory.unclassified.length}/0${inventory.unclassified.length ? ` [${inventory.unclassified.join(", ")}]` : ""} planted_control=${plantedUnclassified.unclassified.length}/1 [${plantedUnclassified.unclassified.join(", ")}]`,
  );

  // THE READER POSITION MUST NOT BE SEARCHED FOR, AND THIS IS WHERE THAT IS GRADED.
  //
  // An earlier census found the discriminator by scanning arguments from the end for the first
  // identifier or function literal. Review wrapped a reader in a call:
  //
  //     matchCell('wrapped', shapeIPv4Count, 'host-name', 0, ((r) => r)((t) => ...), 1)
  //
  // the scan skipped the CallExpression, walked back into the SUBJECT argument, and recorded
  // `shapeIPv4Count` as this cell's reader. A case on `ip-loopback` covers that named class, so the
  // cell was handed coverage it did not have and hollowing its real reader left the suite green.
  //
  // The planted source below carries all three outcomes at once, so this control fails if the
  // positional read regresses in EITHER direction: `shared` must still resolve to its named class
  // (a refusal that classed everything as a singleton would also produce a green "no false
  // coverage" row, and would be useless), while `wrapped` must be `opaque@wrapped` rather than
  // `shapeIPv4Count`. The wrapped row is the one that matters: the subject argument it would have
  // stolen is present and is the same identifier the shared cell legitimately uses, so attribution
  // to an earlier argument is observable here rather than merely absent.
  const plantedReaders = readCellInventory([
    "const SELFTEST_CELLS = [",
    "  matchCell('shared', subjectText, 'host-name', 0, shapeIPv4Count, 1),",
    "  matchCell('own-inline', subjectText, 'host-name', 0, (t) => Number(t.length), 1),",
    "  matchCell('wrapped', shapeIPv4Count, 'host-name', 0, ((r) => r)((t) => Number(t.length)), 1),",
    "  matchCell('short-arity', subjectText, shapeIPv4Count),",
    // LONG arity, not short, and the distinction is load-bearing. A SHORT call leaves index 4
    // undefined, so the missing-argument branch returns opaque on its own and the arity check is
    // never exercised: removing that check left the suite green, which the corpus caught as a
    // SURVIVED mutant. This call has one argument too many and a BARE IDENTIFIER sitting at index
    // 4, so without the arity check it classifies happily as a shared class. That is the real
    // hazard: a signature that grows a parameter shifts every reader one slot right, and a table
    // still reading the old slot reports a confident wrong class rather than a refusal.
    "  matchCell('long-arity', subjectText, 'host-name', 0, shapeIPv4Count, 1, 'extra'),",
    "  cidrBoundaryCell('owns-it', 'a', 'b', 'rule'),",
    "];",
  ].join("\n"));
  const plantedReaderRow = (id) => plantedReaders.readerById.get(id);
  check(
    "census control: the reader is read at the factory's contract position, so a wrapped reader is refused rather than attributed to an earlier argument",
    plantedReaderRow("shared") === "shapeIPv4Count"
      && plantedReaderRow("own-inline") === "inline@own-inline"
      && plantedReaderRow("wrapped") === "opaque@wrapped"
      && plantedReaderRow("short-arity") === "opaque@short-arity"
      && plantedReaderRow("long-arity") === "opaque@long-arity"
      && plantedReaderRow("owns-it") === "owned@cidrBoundaryCell",
    `shared=${plantedReaderRow("shared")}/shapeIPv4Count own-inline=${plantedReaderRow("own-inline")}/inline@own-inline wrapped=${plantedReaderRow("wrapped")}/opaque@wrapped short-arity=${plantedReaderRow("short-arity")}/opaque@short-arity long-arity=${plantedReaderRow("long-arity")}/opaque@long-arity owns-it=${plantedReaderRow("owns-it")}/owned@cidrBoundaryCell`,
  );

  // A THIRD INPUT THAT IS NOT A READING OF THE SOURCE AT ALL: THE CELLS THAT ACTUALLY RAN.
  //
  // The two readers above are independent in their METHOD, one walking comments and one walking the
  // AST, and review showed that independence is not enough, because they share a CONVENTION. A cell
  // spread into the array with no marker comments,
  //
  //     ...[matchCell('extra', ...)],
  //
  // executes and emits a real result row, but a SpreadElement is neither a call nor an object
  // literal so the AST reader does not count it, and it carries no comments so the marker reader
  // does not either. Both readers agreed at 61/61 while the scanner ran 62 cells, and the scanner's
  // own summary said `cells=61/61 status=PASS` because its denominator is the expectation map
  // rather than the array. (DATED: measured at the then-current 61-cell head, before #1614.) Three readers, one silence, measured.
  //
  // Bidirectional set equality cannot escape that: it proves the two inputs name the same cells,
  // never that either input is complete. So the third input is the RUN: every `cell=` id the
  // baseline scanner actually emitted a result row for. It cannot share a source-shape convention
  // with the other two because it does not read the source. A cell that runs is in it, whatever it
  // is spelled like, and a cell that is declared but silently never executed is missing from it.
  const executedIds = baseline.rows
    .filter((row) => row.startsWith("SELFTEST_RESULT_ROW "))
    .map((row) => /\bcell=([^\s]+)/.exec(row)?.[1])
    .filter(Boolean);
  // The comparison is a NAMED FUNCTION so the planted control below can drive THIS code rather than
  // a copy of it. Written inline, a mutation deleting one direction of the comparison left the
  // suite GREEN and mutation-proof reported a SURVIVOR, correctly: the honest tree has no
  // undeclared cell, so the deleted clause had nothing to report, and a control that computes its
  // own answer beside the real one proves only that the control works. A control must reach the
  // code it licenses.
  // MEMBERSHIP IS NOT MULTIPLICITY, which is this lane's opening blocker inverted. That round's
  // finding was that a COUNT IS NOT A SET: an earlier census compared totals while the membership
  // differed. The inverse is equally false. Two mutual-inclusion passes are satisfied by a
  // DUPLICATED id, so duplicating an already-declared cell printed `executed=63 declared=61` and
  // still read `ok`, with the disagreement visible in the detail string nobody would be reading on
  // a green run. The predicate therefore checks identity, count AND uniqueness, and the row prints
  // `unique` so that 63/61 with 61 unique (a duplicate) is distinguishable from 63/63 (two new
  // cells) rather than merely red.
  const censusAgreement = (executed, declared) => ({
    ranButUndeclared: executed.filter((id) => !declared.includes(id)),
    declaredButNeverRan: declared.filter((id) => !executed.includes(id)),
  });
  // THE VERDICT IS A NAMED FUNCTION TOO, for the reason the comparison already is, one level up.
  // Making `censusAgreement` shared fixed the COMPARISON but left the PREDICATE inline, and the
  // shard then reported a real SURVIVOR for deleting its `ranButUndeclared` clause: 118/118 checks
  // passed with the census blinded, carrying a positive control proving another mutation in this
  // same file was killed in the same run, so the suite provably reached it and the gap was real.
  //
  // The reason the deletion was invisible is exact and worth keeping. On the honest tree the four
  // clauses are not independent. With `declared` holding 61 distinct ids, an executed id that
  // nobody declared forces `declaredButNeverRan` to be non-empty too, because equal lengths plus a
  // stranger in one list means a missing one in the other. The surviving clauses therefore cover
  // for the deleted one on every honest input, and on every input the old control supplied. The
  // clause is load-bearing on exactly one shape: an undeclared id WHILE `declared` itself repeats
  // an id, where lengths still match, nothing is missing and only the undeclared check can object.
  // That shape is planted below, so the clause now has an input that fails without it.
  const censusVerdict = (executed, declared) => {
    const { ranButUndeclared, declaredButNeverRan } = censusAgreement(executed, declared);
    return executed.length > 0 && ranButUndeclared.length === 0 && declaredButNeverRan.length === 0
      && executed.length === declared.length
      && new Set(executed).size === executed.length;
  };
  const { ranButUndeclared: executedExtra, declaredButNeverRan: executedMissing } =
    censusAgreement(executedIds, declaredCells);
  check(
    "census: every cell the scanner actually EXECUTED is one the source readers declared, and every declared cell ran",
    censusVerdict(executedIds, declaredCells),
    `executed=${executedIds.length} declared=${declaredCells.length} unique=${new Set(executedIds).size}${executedExtra.length ? ` UNDECLARED [${executedExtra.join(", ")}]` : ""}${executedMissing.length ? ` NEVER RAN [${executedMissing.join(", ")}]` : ""}`,
  );

  // The verdict's planted positives, driving THE SAME FUNCTION the check above calls. Each input is
  // chosen so that the FULL predicate refuses it while the predicate with ONE clause removed would
  // accept it, which is what makes the input grade that clause rather than merely exercise it. The
  // honest shape is included so a predicate hardwired to `false` cannot pass this either.
  //
  // The isolating shapes are not obvious and were found by search, not by reading. `undeclared`
  // needs a repeat in `declared`, and `length` needs `executed` shorter than a `declared` that
  // repeats, because on tidier inputs the other clauses cover for the missing one and the deletion
  // stays invisible. That is the whole lesson of the survivor this control was added for.
  //
  // `declaredButNeverRan` is DELIBERATELY NOT LISTED. It is not missing: it is redundant, and that
  // is provable rather than merely unobserved. If `executed` has no duplicates, has no id absent
  // from `declared`, and the two have equal length, then `executed` is a subset of `declared` of
  // the same size, so the two name the same set and nothing can be left over for `declared` to hold
  // alone. The clause is therefore implied by the other four for ANY finite input, not just for
  // small ones. Search agreed before the argument was found: 116281 pairs up to length four over
  // four symbols, then 15256836 pairs up to length five over five symbols, with no separating input
  // in either. It is kept in the predicate because it names the failure directly in the row a human
  // reads, and it is claimed here as covered by nothing, because claiming otherwise would be the
  // exact error this file keeps catching.
  const verdictHonest = censusVerdict(["alpha", "beta"], ["alpha", "beta"]);
  const verdictUndeclared = censusVerdict(["alpha", "ghost"], ["alpha", "alpha"]);
  const verdictLength = censusVerdict(["alpha"], ["alpha", "alpha"]);
  const verdictDuplicate = censusVerdict(["alpha", "alpha"], ["alpha", "alpha"]);
  const verdictEmpty = censusVerdict([], []);
  check(
    "census control: the verdict accepts an honest census and refuses an undeclared cell, a length mismatch, a duplicate and an empty run, each planted so that deleting exactly one clause would accept it",
    verdictHonest === true && verdictUndeclared === false
      && verdictLength === false && verdictDuplicate === false && verdictEmpty === false,
    `honest=${verdictHonest}/true undeclared=${verdictUndeclared}/false length=${verdictLength}/false duplicate=${verdictDuplicate}/false empty=${verdictEmpty}/false`,
  );

  // And its planted control, because an id reader that returns nothing would report the same tidy
  // agreement as one that works. Both directions are planted: a row for a cell nobody declared, and
  // a declared cell with no row. A control that only planted one direction would let the other rule
  // be deleted silently.
  const controlAgreement = censusAgreement(["alpha", "ghost"], ["alpha", "never-ran"]);
  check(
    "census control: an executed cell nobody declared and a declared cell that never ran are both reported, by the same comparison the check above uses",
    controlAgreement.ranButUndeclared.length === 1 && controlAgreement.ranButUndeclared[0] === "ghost"
      && controlAgreement.declaredButNeverRan.length === 1
      && controlAgreement.declaredButNeverRan[0] === "never-ran",
    `planted_undeclared=${controlAgreement.ranButUndeclared.length}/1 [${controlAgreement.ranButUndeclared.join(", ")}] planted_never_ran=${controlAgreement.declaredButNeverRan.length}/1 [${controlAgreement.declaredButNeverRan.join(", ")}]`,
  );

  // The comparison's own planted positive, and it must plant a SWAP rather than an absence: two
  // lists of equal length naming different cells. An extra or missing entry would also be caught by
  // a mere count, so only a swap can tell an identity comparison from a count. Without this,
  // mutation-proof reported a SURVIVOR for weakening this very check back to counts, which is the
  // third time in this lane that an unexercised reader read as working.
  const plantedSwap = compareCellSets(["alpha", "beta"], ["alpha", "gamma"]);
  check(
    "census control: two equal-length sets naming different cells are reported, so the comparison is by identity",
    plantedSwap.onlyInMarkers.length === 1 && plantedSwap.onlyInMarkers[0] === "beta"
      && plantedSwap.onlyInParsed.length === 1 && plantedSwap.onlyInParsed[0] === "gamma",
    `planted_marker_only=${plantedSwap.onlyInMarkers.length}/1 [${plantedSwap.onlyInMarkers.join(", ")}] planted_parsed_only=${plantedSwap.onlyInParsed.length}/1 [${plantedSwap.onlyInParsed.join(", ")}] (equal counts, different identities)`,
  );

  // The integrity reader's planted positive, fed the REVIEWER'S EXACT ATTACK in miniature rather
  // than a hand-built array: one START renamed to an id already in use, which is a loss and a
  // duplicate at once and leaves the total unchanged. The control must reach the real reader,
  // because a control built from literals grades nothing but itself.
  const plantedIntegrity = readMarkerIntegrity([
    "const cells = [",
    "  // SELFTEST_CELL alpha START",
    "  realCell('alpha'),",
    "  // SELFTEST_CELL alpha END",
    "  // SELFTEST_CELL alpha START",   // was `beta`: same count, one id lost, one duplicated
    "  realCell('beta'),",
    "  // SELFTEST_CELL beta END",
    "];",
  ].join("\n"));
  check(
    "census control: a duplicated id and an unpaired marker are both reported, so the check above is a reading",
    plantedIntegrity.starts.length === 2
      && plantedIntegrity.duplicates.length === 1 && plantedIntegrity.duplicates[0] === "alpha"
      && plantedIntegrity.unpaired.length === 1 && plantedIntegrity.unpaired[0] === "beta",
    `planted_starts=${plantedIntegrity.starts.length}/2 planted_duplicate=${plantedIntegrity.duplicates.length}/1 [${plantedIntegrity.duplicates.join(", ")}] planted_unpaired=${plantedIntegrity.unpaired.length}/1 [${plantedIntegrity.unpaired.join(", ")}]`,
  );

  // EVERY cell must be accounted for: graded by a case, covered by its factory's case, or named in
  // UNGRADED_CELLS with a reason. There is no fourth category and no silent remainder, which is the
  // whole point. A cell added in either style lands here rather than in an unmeasured gap.
  const casesByCell = new Set(CASES.map((entry) => entry.cell));
  const readerByCell = inventory.readerById;
  const coveredReaders = new Set(
    CASES.map((entry) => readerByCell.get(entry.cell)).filter((reader) => reader !== undefined),
  );
  const inlineNamed = new Set(INLINE_CELLS.map((entry) => entry.name));

  // AN EXEMPTION IS VALIDATED BEFORE IT IS HONOURED, or it is not an exemption but a hole.
  //
  // `ungradedNamed` used to be built straight from `entry.cell`. Review hollowed a wrapped reader
  // to a constant and added one line, `[{ cell: "wrapped-reader-extra" }]`, with no reason: product
  // 62/62 PASS, suite 144/144 exit 0. The `() => 0` control proved the reader was live, so the
  // exemption was reinstating the wrong-green this census had just closed.
  //
  // A reason is PROSE, and prose is not a measurement. Requiring one only raises the price of the
  // hole from one line to two: measured here, `{ cell: "wrapped-reader-extra", reason: "cannot be
  // graded" }` bought a full 145/145 green with the same hollowed reader underneath. A rule that a
  // liar can satisfy by typing is not a rule.
  //
  // So an exemption must state a FALSIFIABLE claim and the suite checks it. `reason` is retained
  // for humans, and `provenBy` carries the claim: the cell's own measured field is read from the
  // untampered baseline, and the exemption stands only if that field is genuinely ABSENT. The claim
  // being made is "this cell exposes no field I can drive to zero", and the one cell review kept
  // exempting, `wrapped-reader-extra`, reports `secondary=1/1` in the baseline, so the claim is
  // false and the exemption is refused with the value that refutes it.
  //
  // That is the whole difference: an exemption now has to be WRONG ABOUT AN OBSERVABLE to pass,
  // rather than merely unembarrassed.
  const declaredCellSet = new Set(declaredCells);
  // THE FIELD READER DECIDES EVERY EXEMPTION, so it is fed known inputs below rather than trusted.
  // Two defects were found that way, both of which GRANT a false exemption, which is the silent
  // direction:
  //   prefix collision   `new RegExp("\\bcell=" + id + "\\b")` matched `cell=prefix-trap` for the
  //                      id `prefix`, because `-` is a word boundary. A cell could inherit another
  //                      cell's row. The id is now compared for EQUALITY against the parsed value.
  //   missed field name  `[a-z_]+` does not match `ipv4_rule`, so a cell whose only field contains
  //                      a digit read as HAVING NO FIELD, which is precisely the claim an exemption
  //                      needs to be true. Field names now allow digits after the first character.
  // The cell id is also stripped from the body before fields are read, so an id that itself looks
  // like `name=1/1` cannot be mistaken for a measured field.
  const baselineFieldFor = (cellId) => {
    const row = baseline.rows.find((line) => {
      if (!line.startsWith("SELFTEST_RESULT_ROW ")) return false;
      const match = /\bcell=(\S+)/.exec(line);
      return match !== null && match[1] === cellId;
    });
    if (!row) return undefined;
    const body = row.replace(/^SELFTEST_RESULT_ROW\s+/, "").replace(/\bcell=\S+\s*/, "");
    const fields = [...body.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9_]*)=(\d+)\/\d+/g)]
      .filter((match) => match[1] !== "cells");
    return fields.length ? fields.map((match) => `${match[1]}=${match[2]}`).join(" ") : undefined;
  };
  const validateUngraded = (entries, known, fieldFor) => {
    const malformed = [];
    const valid = new Set();
    for (const [index, entry] of entries.entries()) {
      const cell = entry && typeof entry.cell === "string" ? entry.cell : undefined;
      const reason = entry && typeof entry.reason === "string" ? entry.reason.trim() : "";
      const label = cell ?? `#${index}`;
      const observed = cell ? fieldFor(cell) : undefined;
      if (!cell) malformed.push(`${label}: no cell id`);
      else if (!known.has(cell)) malformed.push(`${label}: names no declared cell`);
      else if (!reason) malformed.push(`${label}: no reason`);
      else if (entry.provenBy !== "no gradable field in the baseline row") {
        malformed.push(`${label}: no falsifiable claim`);
      } else if (observed !== undefined) {
        malformed.push(`${label}: claims no gradable field, baseline reports ${observed}`);
      } else valid.add(cell);
    }
    return { valid, malformed };
  };
  // BOTH the real list and the planted one go through THE SAME CALL, and that is deliberate.
  //
  // The real list is EMPTY, so a mutation that replaces this call with a bare `entry.cell` read
  // changes nothing observable and SURVIVES: the corpus reported exactly that. A control that
  // exercises a private copy of the logic does not defend the call site the product actually uses.
  // Concatenating the planted entries here means the validator is driven with real data on the
  // path that matters, and `exemptions` is filtered back to the real list afterwards so the
  // planted entries can never grant coverage to anything.
  const allExemptions = validateUngraded(
    [...UNGRADED_CELLS, ...PLANTED_EXEMPTIONS],
    declaredCellSet,
    baselineFieldFor,
  );
  const realExemptionCells = new Set(UNGRADED_CELLS.map((entry) => entry && entry.cell));
  const exemptions = {
    valid: new Set([...allExemptions.valid].filter((cell) => realExemptionCells.has(cell))),
    malformed: allExemptions.malformed.filter((entry) => [...realExemptionCells]
      .some((cell) => typeof cell === "string" && entry.startsWith(`${cell}:`))),
  };
  const ungradedNamed = exemptions.valid;

  // The validator is planted against a synthetic list, because the real one is required to be EMPTY
  // and an empty list exercises none of its branches. Each planted entry fails for a DIFFERENT
  // reason, INCLUDING the two that review actually used: a bare cell id, and a cell id with a
  // satisfying sentence attached. The last is the one that matters, because it is fully formed and
  // still refused, by measurement, on the strength of the cell's own baseline row.
  //
  // NO ENTRY IN THIS CONTROL IS VALID, and that is the measured state rather than an oversight: all
  // 65 cells emit a gradable field in the baseline, so no cell can honestly claim it has none, and
  // the honest arm of this control is currently UNSATISFIABLE. That is reported here rather than
  // papered over with a fabricated passing entry, because a control whose positive case cannot be
  // constructed is exactly the shape of the delete-the-cell proof this suite already rejects.
  //
  // `qualifying_cells=0` is therefore an assertion, not a description: if a cell ever appears with
  // no gradable field, this row goes red and someone decides deliberately whether an exemption is
  // warranted, instead of the category quietly becoming reachable.
  //
  // The honest arm HAS been exercised, by constructing the missing cell rather than reasoning about
  // it. A temporary inline cell emitting `actual: 'shape=clean'`, with no numeric field, was added
  // to the scanner; the scanner stayed green at 62/62 and this suite reported `qualifying_cells=1`
  // plus `unaccounted=1 [status-only-cell]`. Exempting it with a cell id, a reason and the claim
  // made `real_malformed=0` and removed the unaccounted row, leaving only this tripwire red. So the
  // accepting path works end to end and is not dead code: it was measured, then the cell was removed
  // and the product restored to its exact blob.
  const qualifyingCells = declaredCells.filter((cellId) => baselineFieldFor(cellId) === undefined);

  // The field reader is graded on SYNTHETIC rows, because on the real ones every cell has a field
  // and the undefined branch, the one that grants exemptions, would never be exercised. Feeding it
  // a known-good input before trusting an UNDEFINED is the whole point: an undefined that means
  // "reader is broken" is indistinguishable from one that means "no field" unless the reader has
  // been shown to find a field it should find.
  const probeRows = [
    "SELFTEST_RESULT_ROW sha=a utc=t cell=probe-normal primary=0/1 secondary=1/1 status=PASS",
    "SELFTEST_RESULT_ROW sha=a utc=t cell=probe-nofields status=PASS",
    "SELFTEST_RESULT_ROW sha=a utc=t cell=probe-prefix-trap primary=0/1 status=PASS",
    "SELFTEST_RESULT_ROW sha=a utc=t cell=probe-digit ipv4_rule=1/1 status=PASS",
  ];
  const probeField = (cellId) => {
    const row = probeRows.find((line) => {
      if (!line.startsWith("SELFTEST_RESULT_ROW ")) return false;
      const match = /\bcell=(\S+)/.exec(line);
      return match !== null && match[1] === cellId;
    });
    if (!row) return undefined;
    const body = row.replace(/^SELFTEST_RESULT_ROW\s+/, "").replace(/\bcell=\S+\s*/, "");
    const fields = [...body.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9_]*)=(\d+)\/\d+/g)]
      .filter((match) => match[1] !== "cells");
    return fields.length ? fields.map((match) => `${match[1]}=${match[2]}`).join(" ") : undefined;
  };
  check(
    "unit test: the baseline field reader finds fields it should, misses none it should not, and refuses a prefix of another cell's id",
    probeField("probe-normal") === "primary=0 secondary=1"
      && probeField("probe-digit") === "ipv4_rule=1"
      && probeField("probe-nofields") === undefined
      && probeField("probe-prefix") === undefined
      && probeField("probe-absent") === undefined,
    `normal=${probeField("probe-normal")}/primary=0 secondary=1 digit=${probeField("probe-digit")}/ipv4_rule=1 nofields=${probeField("probe-nofields")}/undefined prefix=${probeField("probe-prefix")}/undefined absent=${probeField("probe-absent")}/undefined`,
  );
  const plantedExemptions = {
    valid: new Set([...allExemptions.valid].filter((cell) => !realExemptionCells.has(cell))),
    malformed: allExemptions.malformed.filter((entry) => ![...realExemptionCells]
      .some((cell) => typeof cell === "string" && entry.startsWith(`${cell}:`))),
  };
  check(
    "census control: an exemption must name a declared cell, give a reason, and make a claim the baseline row can refute, and no cell currently qualifies",
    exemptions.malformed.length === 0
      && qualifyingCells.length === 0
      && plantedExemptions.valid.size === 0
      && plantedExemptions.malformed.length === 6
      && plantedExemptions.malformed.some((entry) => entry.includes("baseline reports")),
    `real_malformed=${exemptions.malformed.length}/0${exemptions.malformed.length ? ` [${exemptions.malformed.join("; ")}]` : ""} qualifying_cells=${qualifyingCells.length}/0 planted_valid=${plantedExemptions.valid.size}/0 planted_refused=${plantedExemptions.malformed.length}/6 [${plantedExemptions.malformed.join("; ")}]`,
  );

  // Being LISTED in INLINE_CELLS is deliberately NOT a way to be accounted for. That list only
  // records which field a cell's own reader reports; naming a field is not driving it, and an
  // inline cell with no case is exactly the survivor two reviewers demonstrated. Treating the list
  // as coverage would reproduce the defect being fixed, with a tidier denominator on top.
  const accountFor = (cellId) => {
    if (casesByCell.has(cellId)) return "case";
    if (ungradedNamed.has(cellId)) return "named-ungraded";
    // A factory cell is covered when a case drives THE DISCRIMINATOR THIS CELL CARRIES, which is
    // not the same as its factory having a case somewhere.
    //
    // This used to return "factory" for any cell whose constructor was named by any case, on the
    // premise that hollowing a factory's shared discriminator kills every cell it builds. That
    // premise is true only for a factory that OWNS its discriminator. `matchCell` RECEIVES one, so
    // review added a `matchCell` cell with its own inline reader, no case, and watched it be
    // declared, counted and accounted as covered while hollowing its reader left the suite green.
    // A cell graded by nothing was reported as graded by its family.
    //
    // So coverage is asked per READER: a cell is covered when some case's cell carries the same
    // discriminator. Cells sharing a named reader form one class and one case covers them, which is
    // measured rather than assumed, because hollowing that named function reddens every cell in the
    // class. A cell with an inline function is its own class and needs its own case. This is the
    // round-3 fix one level in: the census stopped counting factories and started counting cells,
    // and coverage now stops counting factories and starts counting readers.
    const reader = readerByCell.get(cellId);
    if (reader !== undefined && coveredReaders.has(reader)) return "reader";
    return undefined;
  };
  const findUnaccounted = (cellIds) => cellIds.filter((cellId) => accountFor(cellId) === undefined);
  const unaccountedCells = findUnaccounted(declaredCells);
  check(
    "census: every declared cell is graded by a case, covered by a case driving the same reader, or named as ungraded",
    declaredCells.length > 0 && unaccountedCells.length === 0,
    `declared=${declaredCells.length} unaccounted=${unaccountedCells.length}${unaccountedCells.length ? ` [${unaccountedCells.join(", ")}]` : ""}`,
  );

  // The accounting reader's own planted positive. With every cell accounted for, a working filter
  // and a hardcoded empty list print the identical `unaccounted=0`, so the check above cannot tell
  // them apart and mutation-proof correctly reported a SURVIVOR when this control was missing.
  // That is this fixture's own subject turned on itself: an absence-detector emits the same output
  // whether it is working or blinded, so it can only be graded against a planted subject.
  const plantedUngraded = findUnaccounted([...declaredCells, "planted-ungraded-cell"]);
  check(
    "census control: a cell nothing grades is reported, so the accounting above is a reading",
    plantedUngraded.length === 1 && plantedUngraded[0] === "planted-ungraded-cell",
    `planted_reported=${plantedUngraded.length}/1 [${plantedUngraded.join(", ")}]`,
  );

  // The reverse direction. A name this suite claims must actually exist in the scanner, or a cell
  // that was renamed or deleted quietly reduces what is measured while every count still reads
  // clean. This is the half whose absence cost a BLOCK when the census was over factories.
  const claimedCells = [...new Set([...casesByCell, ...inlineNamed, ...ungradedNamed])];
  const findMissing = (claimed, declared) => claimed.filter((name) => !declared.includes(name));
  const missingFromSource = findMissing(claimedCells, declaredCells);
  check(
    "census: every cell this suite names is actually declared in the scanner",
    missingFromSource.length === 0,
    `claimed=${claimedCells.length} located=${claimedCells.length - missingFromSource.length}${missingFromSource.length ? ` NOT FOUND [${missingFromSource.join(", ")}]` : ""}`,
  );

  // Each reader gets its own planted positive, because a control on one says nothing about another:
  // the round-3 BLOCK landed precisely because an existing control exercised the set comparison
  // while the defect was in the reader that built the set. With everything accounted for, a working
  // comparison and a hardcoded empty list print identical output, so the difference is only visible
  // against a planted subject.
  const plantedLoss = findMissing([...claimedCells, "planted-absent-cell"], declaredCells);
  check(
    "census control: a named cell absent from the scanner is reported, so the containment is a reading",
    plantedLoss.length === 1 && plantedLoss[0] === "planted-absent-cell",
    `planted_reported=${plantedLoss.length}/1 [${plantedLoss.join(", ")}]`,
  );

  // The marker reader's own planted positive, with a REFUSE half. A reader loose enough to match a
  // marker mentioned in prose or quoted in a string would report cells that do not exist and mask
  // the loss of one that does.
  //
  // THE MULTI-LINE STRING CASE IS THE POINT. An earlier version of this control fed the reader only
  // a one-line string while claiming the reader "refuses a marker quoted in a string", and a
  // reviewer defeated exactly that gap with a multi-line template. The control must be at least as
  // wide as the claim attached to it, so both shapes are exercised here.
  const plantedMarkers = readCellIds([
    "const cells = [",
    "  // SELFTEST_CELL planted-accept START",
    "  realCell('planted-accept'),",
    "  // SELFTEST_CELL planted-accept END",
    "  // a comment discussing // SELFTEST_CELL planted-prose START inline",
    "  ...(() => { const oneLine = `// SELFTEST_CELL planted-string START`; return []; })(),",
    "  ...(() => { const multiLine = `",
    "  // SELFTEST_CELL planted-multiline-string START",
    "  `; return []; })(),",
    "];",
  ].join("\n"));
  check(
    "census control: the marker reader finds a real marker and refuses one in prose or any string",
    plantedMarkers.length === 1 && plantedMarkers[0] === "planted-accept",
    `found=${plantedMarkers.length}/1 [${plantedMarkers.join(", ")}] (prose, one-line string and multi-line string mentions must all be refused)`,
  );

  // Every factory carrying a discriminator must have a case that drives it. Nothing is exempt: the
  // one factory this suite previously exempted turned out to carry a gradable discriminator under a
  // different field name, and a reviewer proved it by hollowing that field out.
  const gradable = FACTORIES.filter((entry) => entry.secondaryField !== null);
  const ungraded = gradable.filter((entry) => !CASES.some((c) => c.family === entry.name));
  check(
    "census: every factory carrying a discriminator has a case that drives it",
    ungraded.length === 0 && gradable.length === FACTORIES.length,
    `gradable=${gradable.length}/${FACTORIES.length}_factories covered=${gradable.length - ungraded.length}${ungraded.length ? ` MISSING [${ungraded.map((e) => e.name).join(", ")}]` : ""}`,
  );

  // A UNIT TEST OF THE FIELD READER, on synthetic rows it supplies itself.
  //
  // All seventeen kills below are decided by `cellSecondary` parsing a named field for a named cell,
  // so this checks that it does, against four mutually inconsistent values that no constant can
  // satisfy at once, plus two miss cases that require `undefined`.
  //
  // ITS SCOPE IS THIS READER AND NOTHING MORE. An earlier revision claimed this control established
  // that the kills are honestly graded. It does not, and that was measured: a TWIN reader added
  // beside this one, returning "0" whenever the rows contain `status=FAIL`, fakes all seventeen
  // kills at a full green while this control passes untouched, because synthetic rows carry
  // `status=PASS` so the twin's lie never fires here. A control grades the reader it is handed, and
  // readers are addable. Treat this as a unit test, which is worth having, and not as evidence that
  // the suite cannot be blinded.
  const syntheticRows = [
    "SELFTEST_RESULT_ROW sha=synthetic utc=synthetic cell=alpha primary=2/9 secondary=7/9 status=PASS",
    "SELFTEST_RESULT_ROW sha=synthetic utc=synthetic cell=beta primary=3/9 secondary=5/9 status=PASS",
  ];
  const reads = {
    "alpha.secondary": cellSecondary(syntheticRows, "alpha", "secondary"),
    "alpha.primary": cellSecondary(syntheticRows, "alpha", "primary"),
    "beta.secondary": cellSecondary(syntheticRows, "beta", "secondary"),
    "beta.primary": cellSecondary(syntheticRows, "beta", "primary"),
  };
  const expected = { "alpha.secondary": "7", "alpha.primary": "2", "beta.secondary": "5", "beta.primary": "3" };
  const missCell = cellSecondary(syntheticRows, "no-such-cell", "secondary");
  const missField = cellSecondary(syntheticRows, "alpha", "no_such_field");
  check(
    "unit test: the field reader returns each named field for each named cell, and undefined for a miss",
    Object.keys(expected).every((key) => reads[key] === expected[key])
      && missCell === undefined && missField === undefined,
    `${Object.keys(expected).map((key) => `${key}=${reads[key] ?? "undefined"}/${expected[key]}`).join(" ")} miss_cell=${missCell ?? "undefined"} miss_field=${missField ?? "undefined"}`,
  );

  // WHAT THIS SUITE DOES NOT PROVE, AND WHY THE GUARDS THAT CLAIMED IT ARE GONE.
  //
  // Everything above grades THE SCANNER: 65 cells from a derived census, tampered one at a time,
  // each required to go red BY NAME. That part held under eleven rounds of review without a single
  // finding against it, and it is what this file is for.
  //
  // What this suite does NOT do is prove itself. Earlier revisions carried five instruments that
  // tried to: a reader census, taint tracking through aliases and destructuring, an escape rule on
  // handovers, a file-wide rule on call arguments, and a counter on reads of the exit code. Each
  // closed a real hole, and each was then defeated by a construction it did not enumerate. The
  // measured sequence, every one a green suite deciding every kill from a lie:
  //
  //   a launderer inside a row reader, then the same launderer one frame out in the kill loop
  //   `pickRows({ ...r })`, a wrapper expression rather than a bare identifier
  //   `run.exitCode === 2 ? "0" : ...`, which hands nothing to anything and propagates nothing
  //   a lie keyed on row TEXT rather than on the exit code, which spends no counted read at all
  //   `const stolen = run.exitCode;` reused by both the lie and the honest assertion, one read total
  //
  // The pattern is not that those guards were written badly. It is that each one anchored to a
  // NAMED THING and was beaten by a thing beside it: a function beside the walked function, a field
  // beside the counted field. A guard that reads this file to decide whether this file can be
  // trusted has no fixed point, so the claim has been removed rather than defended with a sixth
  // rule. Known holes are named above so the next contributor inherits the truth instead of a
  // reassuring green.
  //
  // WHAT A CASE PROVES. Every case below tampers with a cell's SUBJECT and requires that cell's
  // count to fall to 0. That grades the path from subject to reported number, which is what catches
  // a hollowed reader, and it reaches further than it first appears.
  //
  // An earlier revision of this comment claimed a limit here that DOES NOT EXIST, and the correction
  // is worth more than the claim was. The claim was that a reader which keeps its subject text and
  // stops consuming it survives: rewrite a measure to `CONSTANT ?? scanEntries(<original
  // arguments>)` and the argument text stays verbatim, so the tamper still finds its anchor and
  // still applies, while the scan is never evaluated. That much is true, and at the SCANNER level
  // it is a genuine hollow: `node --check` passes, the scan never runs, and the scanner's own
  // self-test reports `cells=61/61 status=PASS` at exit 0, blind to it. (The rows in this block are
  // DATED: measured at the then-current 61-cell head, before #1614.)
  //
  // The suite kills it anyway, measured on the real file rather than reasoned about:
  //
  //   FAIL must-come-back-dirty: destroying the planted subject drives this cell's findings to 0 - findings=1/0
  //   FAIL must-come-back-dirty: that dead reading turns the cell red - status=PASS/FAIL
  //   FAIL must-come-back-dirty: a dead cell is visible in the summary row and the exit code - exit=0/2 cells=61/61 status=PASS
  //
  // The reason is the structure of a case, not luck. A case does not ask what the source says. It
  // RE-RUNS the scanner over the tampered copy and requires the number to MOVE. A constant answers
  // the tampered run exactly as it answered the untampered one, so the count that must fall to 0
  // stays at 1 and the kill assertion goes red naming the cell. A reader that cannot say `no` fails
  // here precisely because it cannot say anything different.
  //
  // The false claim came from a probe that re-derived an answer from the tampered SOURCE instead of
  // RUNNING the suite against it, which is the error this whole file exists to punish, made by its
  // own author while documenting it. Review caught it by running the thing. That is the thirteenth
  // consecutive time a question here was settled by building the construction and not by reading.
  //
  // ONE STRUCTURAL PROPERTY IS KEPT, because it is not a guard. The three row readers take `rows`
  // and not the run, so they cannot see an exit code. Every tampered run here exits 2 and every
  // kill expects 0, so a reader holding the run can answer from the exit code instead of from the
  // row, and three reviewers independently wrote `if (run.exitCode === 2) return "0";` above the
  // parse, which reads naturally as "a failed run has no live discriminator" and scored a full
  // green. Taking `rows` makes that shortcut UNWRITABLE rather than detectable, since the value it
  // would key on is not in scope and `rows.exitCode` on an array is inert. Every evasion listed
  // above therefore has to be a deliberate, visible edit to the kill loop rather than a plausible
  // early return, which is a cost, not a proof.
  //
  // IF YOU ARE CHECKING WHETHER THIS SUITE STILL WORKS: a clean run is not evidence. In eleven
  // rounds, every blinded decider was caught by planting a lie and requiring a named cell to go
  // red, and NONE was ever caught by reading the code. Note also that `grep -c FAIL` over this
  // suite's output returns 26 on a healthy green run, because passing rows legitimately contain
  // `status=FAIL/FAIL` as asserted data. Real failures are stderr-only and two-space indented:
  // count `^  FAIL`, or a wrong-green will read to you as a kill.
  for (const testCase of CASES) {
    const { cell, reader, find, replace, family, helper } = testCase;
    // THE FIELD IS ASKED OF THE CASE FIRST, because a factory's field is not always a property of
    // the factory. `matchCell` and `cidrBoundaryCell` report under one field each, so the family
    // answers for them. `scanCell` does not: it RECEIVES its metric name as an argument, and its
    // five cells report under four different fields (`allowed`, `findings`, `errors`, `missing`).
    // Reading the family's single `allowed` for all five would hand the reader a field four of them
    // never emit, `cellSecondary` would return undefined, and the baseline control below would go
    // red for a live cell. This is the same confusion the coverage rule above was just fixed for,
    // one level down: what a factory OWNS may be asked of the family, what it RECEIVES may not.
    const secondaryField = testCase.secondaryField
      ?? FACTORIES.find((entry) => entry.name === family)?.secondaryField
      ?? INLINE_CELLS.find((entry) => entry.name === cell)?.secondaryField
      ?? "secondary";

    check(
      `${cell}: the untampered copy reports this cell passing`,
      copyOk && cellStatus(copyRun.rows, cell) === "PASS",
      `status=${cellStatus(copyRun.rows, cell)}/PASS`,
    );

    // BEFORE TRUSTING A ZERO, PROVE THIS READER CAN REPORT A NONZERO. Every kill below is decided
    // by `cellSecondary` returning "0", so a reader hardwired to "0" would make all of them pass
    // vacuously. That is not hypothetical: a reviewer replaced this reader's return with
    // `return "0"` and the whole suite stayed at a full green, every kill assertion satisfied by a
    // reader that had stopped reading. The status and summary checks did not expose it, because
    // they read a different field and still went red on the live tampers.
    //
    // So the reader is fed a KNOWN-GOOD input first: the same field, on the same cell, in the
    // UNTAMPERED run, where the subject is intact and the discriminator must report a positive
    // count. A constant "0" fails here, and a reader that cannot find its row reports undefined and
    // fails here too. This is the fixture's own subject applied to the fixture: an instrument that
    // only ever reports the value meaning "dead" cannot tell you anything is alive.
    const baselineSecondary = cellSecondary(copyRun.rows, cell, secondaryField);
    // A REFUSAL CELL grades in the opposite direction: its baseline field is 0 BY DESIGN (it
    // asserts something is not reported), so "prove the reader can report nonzero" is unavailable
    // here and its kill plants a reportable subject instead of destroying one. The vacuity guard is
    // the inversion itself, and it is tighter than the forward one: a reader hardwired to 0 passes
    // this baseline and fails the kill, a reader hardwired to nonzero fails this baseline.
    const refusal = testCase.refusal === true;
    check(
      refusal
        ? `${cell}: the ${secondaryField} reader reports 0 before any tamper, so a later nonzero is a reading`
        : `${cell}: the ${secondaryField} reader reports a nonzero count before any tamper, so a later 0 is a reading`,
      refusal
        ? baselineSecondary === "0"
        : baselineSecondary !== undefined && Number(baselineSecondary) > 0,
      `baseline ${secondaryField}=${baselineSecondary ?? "undefined"}/${refusal ? "0" : ">0"}`,
    );

    let tamperedSource;
    try {
      tamperedSource = helper
        ? tamperHelper(tracked, cell, helper, find, replace)
        : tamperCell(tracked, cell, find, replace);
    } catch (error) {
      check(`${cell}: the tamper lands inside the named ${helper ? `helper ${helper}` : "cell block"}`, false, error.message);
      continue;
    }
    check(
      `${cell}: the tamper lands inside the named ${helper ? `helper ${helper}` : "cell block"}`,
      tamperedSource !== tracked,
      `reader=${reader}`,
    );

    const tamperedPath = join(workdir, `tampered-${cell}.mjs`);
    writeFileSync(tamperedPath, tamperedSource);
    const run = runSelftest(tamperedPath);
    const status = cellStatus(run.rows, cell);
    const secondary = cellSecondary(run.rows, cell, secondaryField);
    const runSummary = summary(run.rows);

    // THE KILL. A live secondary reader notices the destroyed subject and reports 0. A reader
    // hollowed to a constant returns its expected value no matter what it is handed, so it still
    // reports 1 and this check goes red. `undefined` is red too: a cell that stopped emitting a
    // readable row is not a cell that passed.
    check(
      refusal
        ? `${cell}: planting a reportable subject drives this cell's ${secondaryField} above 0, so its ${reader} still discriminates`
        : `${cell}: destroying the planted subject drives this cell's ${secondaryField} to 0, so its ${reader} still discriminates`,
      refusal
        ? secondary !== undefined && Number(secondary) > 0
        : secondary === "0",
      `${secondaryField}=${secondary}/${refusal ? ">0" : "0"}`,
    );

    // And the cell must actually go red, so a working reader is not merely printing a number that
    // nothing acts on.
    check(
      `${cell}: that dead reading turns the cell red`,
      status === "FAIL",
      `status=${status}/FAIL`,
    );

    // A dead discriminator must also be visible in the two figures a human actually reads.
    //
    // The exit code is read ONCE, into a binding, and the condition and the message both use that
    // binding. That is now style rather than instrumentation: an earlier revision asserted a BUDGET
    // on reads of this field, and review defeated it with an oracle that STOLE the one permitted
    // read, using it for the lie and handing the same value to this assertion. The budget counted
    // one read and stayed green through thirteen faked kills, because a count is not an ownership.
    // The budget is gone. The single read stays because it is clearer, and nothing rests on it.
    const observedExit = run.exitCode;
    check(
      `${cell}: a dead cell is visible in the summary row and the exit code`,
      observedExit === 2 && runSummary !== undefined && runSummary.status === "FAIL"
        && runSummary.passed === runSummary.total - 1,
      `exit=${observedExit}/2 cells=${runSummary?.passed}/${runSummary?.total} status=${runSummary?.status}`,
    );
  }
} finally {
  // The cleanup may only remove the directory mkdtemp handed `makeWorkdir`, and only beneath the
  // base it was created in. A mutant that makes that helper return a parent must not delete it.
  removeSelfTestDir(workdir, workspace.base, workspace.created);
}

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`\n${passed}/${total} checks passed, ${failures.length} failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`\n${passed}/${total} checks passed`);
