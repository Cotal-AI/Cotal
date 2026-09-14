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
 * still reports `cells=34/34 status=PASS`, and the process still exits 0.
 *
 * Measured by hollowing three different secondaries one at a time, each inside its own cell block:
 *   host-planted  (host-token arrow)  -> () => 1 : exit 0, cells=34/34 status=PASS   SURVIVED
 *   ip-loopback   (shapeIPv4Count)    -> () => 1 : exit 0, cells=34/34 status=PASS   SURVIVED
 *   home-relative (homeFragmentCount) -> () => 1 : exit 0, cells=34/34 status=PASS   SURVIVED
 * against a same-session behaviour control proving the scanner is not simply blind: weakening the
 * real CIDR_SUFFIX pattern gave exit 2, cells=19/34 status=FAIL. A dead discriminator is invisible
 * to the instrument it belongs to, while dead behaviour is not.
 *
 * These figures are re-derivable at THIS head, which is deliberate. They previously cited a prior
 * sha, and a reviewer pointed out that a historical claim wearing the same clothes as a live one is
 * precisely this suite's own subject. Every number in this file should be reproducible from the
 * file it sits in.
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
const runSelftest = (file) => {
  const result = spawnSync(process.execPath, [file, "--selftest", "--root", ROOT], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`could not run ${file}: ${result.error.message}`);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { exitCode: result.status, output, rows: output.split(/\r?\n/).filter(Boolean) };
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
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { exitCode: result.status, output, rows: output.split(/\r?\n/).filter(Boolean) };
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
 * A shared helper is shared, so a tamper here can legitimately affect several cells at once. The
 * grading below accounts for that by requiring the NAMED cell's own discriminator to go dead, which
 * is a per-cell reading regardless of how many neighbours also went red.
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
 * COVERAGE IS BY CONSTRUCTOR FAMILY, NOT BY CELL. The scanner builds its 34 cells from a small
 * number of shared factories, and hollowing a factory's discriminator kills every cell it built at
 * once. One case per family therefore grades every cell in that family, while one case per cell
 * would be 34 cases mostly re-proving the same function. The families are enumerated from the
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

  // THE SEVEN INLINE CELLS. Each is an object literal with a `measure` of its own and no factory,
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
];

/**
 * The cells this suite must account for, read from the scanner's own `SELFTEST_CELLS` array.
 *
 * COVERAGE IS OVER CELLS, AND THE FACTORY IS ONLY A GROUPING. An earlier version enumerated cell
 * FACTORIES and treated a case per factory as covering everything that factory built. That is true
 * as far as it goes, and it is not far enough: 7 of the scanner's 34 cells are INLINE object
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
const readCellInventory = (source) => {
  const sf = ts.createSourceFile("scanner.mjs", source, ts.ScriptTarget.Latest, true);
  const factories = new Set();
  const byFactory = new Map();
  const inline = [];
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
        } else if (ts.isObjectLiteralExpression(element)) {
          total += 1;
          const id = element.properties.find(
            (property) => property.name && property.name.getText() === "id",
          );
          const text = id && ts.isPropertyAssignment(id) ? literalText(id.initializer) : undefined;
          inline.push(text ?? "(unnamed inline cell)");
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { factories: [...factories], byFactory, inline, total };
};

/**
 * Cells deliberately left ungraded, each with the reason.
 *
 * This list is empty, and that is a measurement rather than a default. The one entry it used to
 * carry claimed `scanCell` had no gradable discriminator; a reviewer hollowed the field and showed
 * it did, under the metric's own name. A limitation ASSERTED rather than MEASURED is a gap wearing
 * a label, and the label makes it less likely anyone looks again. Anything added here needs the
 * hollowing attempt that justifies it quoted in the reason.
 */
const UNGRADED_CELLS = [];

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
 * array, so this list is written out. It is held to the source rather than trusted: the inventory
 * check below requires it to match the inline cells actually present, in both directions.
 */
const INLINE_CELLS = [
  { name: "workflow-host-exclusion", secondaryField: "planted" },
  { name: "short-host-token", secondaryField: "configured_errors" },
  { name: "host-token-ceiling", secondaryField: "errors" },
  { name: "binary-skip", secondaryField: "binary_skipped" },
  { name: "production-main-wiring", secondaryField: "skip_rows" },
  { name: "production-short-token-guard", secondaryField: "reason_rows" },
  { name: "production-token-ceiling-guard", secondaryField: "reason_rows" },
];

/**
 * A working directory the scanner's self-execute guard can survive.
 *
 * The guard is ``import.meta.url === `file://${process.argv[1]}` ``, comparing a real URL against a
 * string built by concatenation. Those agree only for paths needing no URL escaping, so TWO host
 * conditions silently break it, and each makes a spawned copy exit 0 having run NOTHING:
 *   symlinked TMPDIR   `import.meta.url` resolves symlinks, `process.argv[1]` does not
 *   a space in TMPDIR  the URL percent-encodes it, the concatenated string does not
 * Neither was found by reading. The first was caught by the untampered-copy control below, the
 * second by an adversarial reviewer who set TMPDIR to a directory containing a space.
 *
 * The scanner is the product and this suite does not modify it, so the workdir is chosen to avoid
 * both conditions: realpath'd, then REJECTED outright when its URL form differs from the naive
 * concatenation. The repository is the fallback base, since a checkout needing escaping would
 * already be breaking the scanner in production. If no usable base exists this THROWS with the
 * reason, because one accurate sentence is a better report than a cascade of confusing cell
 * failures that all share a cause the reader cannot see.
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
    if (guardSafe(candidate)) return candidate;
    rmSync(candidate, { recursive: true, force: true });
    rejected.push(`${candidate}: needs URL escaping, so the scanner's self-execute guard cannot fire there`);
  }
  throw new Error(
    `no usable working directory: a copied scanner would exit 0 having run nothing.\n  ${rejected.join("\n  ")}`,
  );
};

const workdir = makeWorkdir();

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
  // silence loud; but a census over FACTORIES inherits the same blindness one level up. 7 of the
  // scanner's 34 cells are inline object literals built by no factory at all, so no factory
  // enumeration, however perfect, can see them. A reviewer proved the cost rather than arguing it:
  // hollowing `workflow-host-exclusion`'s inline discriminator to a constant left the scanner at
  // cells=34/34 exit 0 AND this suite at a full green, with a same-run positive control showing the
  // cell really was reached. Live code that both instruments declined to grade.
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
  // line inside a multi-line template literal left every row unchanged at `starts=34 ends=34
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
  // reported `starts=34 ends=33 unpaired=1 [missing-subject]` on a perfectly healthy file, and my
  // own planted control caught the same hole in the same run at `planted_unpaired=0/1`.
  //
  // A RAW TOKEN SCANNER IS NOT THE ANSWER EITHER, and it was tried: `ts.createScanner` over the
  // text has no parser context, so it cannot resolve whether `/` opens a regex or divides, and it
  // desynced and found 3 of 34 markers. That failed loudly, in the ALARMING direction, and the
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
  // (`ip-zero` -> `ip-private`, a cell id already in use) kept the count at 34 while LOSING one id
  // and DUPLICATING another, leaving a START/END pair mismatched. Every row still read
  // `markers=34 parsed_cells=34 ... unaccounted=0` and the suite passed in full.
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
  const factoryCovered = new Set(
    CASES.filter((entry) => entry.family).map((entry) => entry.family),
  );
  const inlineNamed = new Set(INLINE_CELLS.map((entry) => entry.name));
  const ungradedNamed = new Set(UNGRADED_CELLS.map((entry) => entry.cell));

  // Being LISTED in INLINE_CELLS is deliberately NOT a way to be accounted for. That list only
  // records which field a cell's own reader reports; naming a field is not driving it, and an
  // inline cell with no case is exactly the survivor two reviewers demonstrated. Treating the list
  // as coverage would reproduce the defect being fixed, with a tidier denominator on top.
  const accountFor = (cellId) => {
    if (casesByCell.has(cellId)) return "case";
    if (ungradedNamed.has(cellId)) return "named-ungraded";
    // A factory cell is covered when a case drives that factory's shared discriminator: hollowing
    // it kills every cell that factory builds, so one case genuinely grades all of them.
    for (const factory of FACTORIES) {
      if (factoryCovered.has(factory.name) && factoryCellIds.get(factory.name)?.includes(cellId)) {
        return "factory";
      }
    }
    return undefined;
  };
  const findUnaccounted = (cellIds) => cellIds.filter((cellId) => accountFor(cellId) === undefined);
  const unaccountedCells = findUnaccounted(declaredCells);
  check(
    "census: every declared cell is graded, covered by its factory, or named as ungraded",
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

  // THE FIELD READER'S OWN CONTROL, on SYNTHETIC ROWS it supplies itself.
  //
  // Everything below depends on `cellSecondary` actually parsing a named field for a named cell,
  // and grading it against real runs cannot establish that. Both halves of every kill correlate
  // perfectly with run identity: the untampered copy always exits 0 and wants a nonzero, every
  // tampered run exits 2 and wants a zero. Three reviewers independently measured the consequence,
  // and `return run.exitCode === 0 ? "1" : "0"` passed the whole suite at 90/90 exit 0 without
  // reading a row. A control asking "nonzero here, zero there" grades responsiveness to the RUN,
  // not to the FIELD, which is the same defect one level in from the one it replaced.
  //
  // So the reader is handed rows it cannot recognise: two cells whose fields hold four MUTUALLY
  // INCONSISTENT values. No constant can satisfy 2, 3, 5 and 7 at once, so a reader tuned to any
  // single expected value fails on the other three, and the two miss cases require `undefined`,
  // which no value-returning shortcut can produce.
  //
  // THIS CONTROL AND THE ROWS-ONLY SIGNATURE ARE TWO INSTRUMENTS AND NEITHER SUBSUMES THE OTHER.
  // The signature removes the run-status oracle by construction, because a reader that never
  // receives the exit code cannot answer from it. This control grades what remains: that the reader
  // picks the named CELL and the named FIELD rather than any row or any number. An earlier revision
  // shipped this control against a synthetic RUN, and it was defeated by a reader that special-cased
  // exit codes, which is why the fixture below is a bare array.
  //
  // ITS BOUND, STATED RATHER THAN LEFT TO BE DISCOVERED: a control proves the reader works on the
  // inputs THE CONTROL chooses; it cannot prove the reader takes the same path on the inputs the
  // SUITE uses. A reader that parsed honestly for exactly the six probes below and cheated
  // elsewhere would pass here, which review classed as deliberate gaming rather than plausible
  // drift. The 13 real-row assertions that follow are what cover the suite's own inputs, and the
  // rows-only signature is what stops those assertions being answered without a parse.
  //
  // All four reads and both misses are asserted in ONE check with every value printed, deliberately.
  // The mechanism here is the mutual inconsistency, and it is only visible when the values appear
  // together: `7/7 7/2 7/5 7/3` on one line is self-evidently a constant, where four separate
  // red/green lines would not be. A reviewer's own testing error was caught exactly this way, by
  // reading the printed values rather than the exit code.
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
    "reader control: the field reader returns each named field for each named cell, and undefined for a miss",
    Object.keys(expected).every((key) => reads[key] === expected[key])
      && missCell === undefined && missField === undefined,
    `${Object.keys(expected).map((key) => `${key}=${reads[key] ?? "undefined"}/${expected[key]}`).join(" ")} miss_cell=${missCell ?? "undefined"} miss_field=${missField ?? "undefined"}`,
  );

  // THE SIGNATURE IS THE FIX, SO THE SIGNATURE IS GUARDED.
  //
  // Everything above rests on the three row readers being UNABLE to see a run's exit code, and that
  // property lives in a parameter list, where nothing else would notice it changing. Restoring the
  // old `(run, id)` signature and one `.exitCode` test reopens a hole that passed 91/91 in full, so
  // the guard has to be structural rather than a comment asking future readers not to.
  //
  // It parses THIS file and requires that none of the three readers mention any property of a run
  // object. The reader is the AST, not a regex, for the reason established earlier in this suite:
  // a text scan for `exitCode` is defeated by `run["exit"+"Code"]`, and by the same token it fires
  // on the word appearing in a comment, so it is wrong in both directions. Walking the function
  // bodies asks the question that is actually meant, which is whether the reader can reach the run.
  //
  // The control is planted, not assumed: the same walker is run over a synthetic function that DOES
  // read `exitCode`, and must report it. An absence-detector that is broken reports the same clean
  // absence as one that is working, which is the failure this whole file exists to catch.
  //
  // ITS DENOMINATOR IS DERIVED, NOT ENUMERATED, AND REVIEW HAD TO SAY SO TWICE IN THIS FILE. An
  // earlier revision named the three readers in a list. A list is checked against itself: a FOURTH
  // reader added later, taking a run and reading its exit code, is simply not in it, and the guard
  // reports the same tidy `examined=3/3 leaks=0` while the new reader goes ungraded. That is this
  // suite's own subject one level up, and it is the same shape as the census that had to stop
  // counting factories and start counting cells. So the denominator is every top-level function in
  // this file whose FIRST PARAMETER is named `rows` or `run`, which is what "a row reader" means
  // here, and the guard requires that at least the known three are among them, so a rename cannot
  // shrink the denominator to nothing and still read clean.
  const runFieldsNamedBy = (source) => {
    const sf = ts.createSourceFile("suite.mjs", source, ts.ScriptTarget.Latest, true);
    const found = [];
    const seen = [];
    // WHAT COUNTS AS A ROW READER IS A BEHAVIOUR, NOT A NAME. An earlier revision selected on the
    // first parameter being spelled `rows` or `run`, and review defeated it by spelling it `r`:
    // a copy of the round-7 blocker, wired into the real kill assertion with the run passed in,
    // scored a full green 92/92 while the guard reported a tidy `examined=3_derived leaks=0`. That
    // is the round-3 defect for the fifth time in this lane, where `function matchCell(` became
    // `function matchCell (` and a factory left the census. A pattern over spellings is defeated by
    // the next spelling, so the selector must ask what the function DOES.
    //
    // A row reader is any function whose body names a `SELFTEST_..._ROW` marker literal, which is
    // what parsing this suite's rows consists of and cannot be renamed away without ceasing to
    // parse. The leak test then binds to THAT function's own first parameter, whatever it is
    // called, so `r.exitCode` is caught exactly as `run.exitCode` is.
    const ROW_MARKER = /^SELFTEST_[A-Z_]*ROW/;
    // Reaching a row reader's parameter through an ARRAY method is the whole point of the thing.
    // Anything else is reaching into a run: `.rows`, `.exitCode`, `.output`, a computed key.
    const ARRAY_USE = new Set([
      "find", "filter", "map", "some", "every", "slice", "join", "length", "includes",
      "indexOf", "at", "forEach", "reduce", "flatMap", "concat", "entries", "keys", "values",
    ]);
    const namesRowMarker = (fn) => {
      let hit = false;
      const scan = (node) => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
          && ROW_MARKER.test(node.text)) hit = true;
        ts.forEachChild(node, scan);
      };
      if (fn.body) scan(fn.body);
      return hit;
    };
    // THE PARAMETER IS TAINTED, AND SO IS ANYTHING COPIED OUT OF IT. Tracking the parameter's own
    // identifier is not enough, which review demonstrated twice in one round: `const source = r;`
    // then `source.exitCode`, and `const { exitCode, rows } = r;`, both passed at a full green with
    // the guard reporting `leaks=0`. Following one name is the same mistake as matching one
    // spelling, one level along: the value moved and the reader did not.
    //
    // So the taint set starts at the first parameter and grows: an alias binds the whole value and
    // inherits it, and a destructure of a tainted value names the very fields this guard exists to
    // forbid, so a destructured binding IS the leak and is reported at the point of binding.
    //
    // AND TAINT MAY NOT ESCAPE THROUGH A CALL, which is the door review walked through next. An
    // earlier revision let a reader pass its parameter on, reasoning that the function at the other
    // end would be derived and walked itself. That holds only if the other end parses rows, and a
    // LAUNDERER need not: `const pickRows = (anything) => anything.exitCode === 2 ? [] : anything.rows;`
    // names no row literal, so it is not a row reader, is never derived, and is never walked. The
    // reader calling it stayed honest, touched neither field, and the exit-2 oracle was restored in
    // full at 92/92. Every component behaved exactly as specified and the SCOPE was the defect.
    //
    // So handing a tainted value to another function is itself the leak, reported at the call site.
    // The three real readers never do this, measured before the rule was written, so it costs them
    // nothing: a reader needing a helper can hand it the ROWS, which is what it was given. This
    // replaces a claim about where taint goes with a rule that it does not leave, and that is the
    // only version which does not need a second denominator naming every function that might
    // receive one. A denominator of launderers would be this lane's defect for the seventh time.
    const walkBody = (node, owner, param) => {
      const tainted = new Set([param]);
      const scan = (current) => {
        // A tainted value handed to any function escapes this walker's view, so the handover is the
        // leak. The callee is named so the row says where it went, not merely that it went.
        if (ts.isCallExpression(current)) {
          for (const argument of current.arguments) {
            if (ts.isIdentifier(argument) && tainted.has(argument.text)) {
              const callee = ts.isIdentifier(current.expression) ? current.expression.text : "call";
              found.push(`${owner}:escapes_into(${callee})`);
            }
          }
        }
        if (ts.isVariableDeclaration(current) && current.initializer) {
          // `const source = r;` aliases the whole tainted value.
          if (ts.isIdentifier(current.initializer) && tainted.has(current.initializer.text)) {
            if (ts.isIdentifier(current.name)) tainted.add(current.name.text);
            // `const { exitCode, rows } = r;` names run fields directly; the binding is the leak.
            if (ts.isObjectBindingPattern(current.name)) {
              for (const element of current.name.elements) {
                const key = element.propertyName ?? element.name;
                const field = ts.isIdentifier(key) ? key.text : "computed";
                if (!ARRAY_USE.has(field)) found.push(`${owner}:destructured.${field}`);
              }
            }
          }
        }
        if (ts.isPropertyAccessExpression(current) && ts.isIdentifier(current.expression)
          && tainted.has(current.expression.text) && !ARRAY_USE.has(current.name.text)) {
          found.push(`${owner}:${current.expression.text}.${current.name.text}`);
        }
        if (ts.isElementAccessExpression(current) && ts.isIdentifier(current.expression)
          && tainted.has(current.expression.text)) {
          found.push(`${owner}:${current.expression.text}[computed]`);
        }
        ts.forEachChild(current, scan);
      };
      scan(node);
    };
    const consider = (fn, name) => {
      const first = fn.parameters?.[0];
      if (!first || !ts.isIdentifier(first.name)) return;
      if (!namesRowMarker(fn)) return;
      seen.push(name);
      walkBody(fn.body, name, first.name.text);
    };
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
        && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        consider(node.initializer, node.name.text);
      }
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        consider(node, node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return { found, seen };
  };
  // The known three are a FLOOR on the derived set, never the set itself: if a rename or a parser
  // change drops them, `examined` stops containing them and the guard goes red rather than quietly
  // grading fewer readers than it did yesterday.
  const REQUIRED_READERS = ["cellStatus", "cellSecondary", "summary"];
  const suiteSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const { found: leaked, seen: examined } = runFieldsNamedBy(suiteSource);
  // The planted control names a marker literal, because the selector is behavioural now: a control
  // that would not be DERIVED as a row reader proves nothing about a guard that only walks derived
  // readers. It also spells its parameter `r`, so the control exercises the exact evasion review
  // used rather than the shape that was already caught.
  //
  // It reaches the exit code through an ALIAS and a DESTRUCTURE as well as directly, because those
  // are the two hops review used to walk past an earlier version, and a control that only exercises
  // the direct spelling would report a healthy nonzero while taint propagation was broken.
  // It also HANDS THE VALUE TO A FUNCTION, because the escape rule is the fourth thing this walker
  // does and a control that never escapes would let the escape rule be deleted silently.
  const { found: plantedLeak } = runFieldsNamedBy(
    'const planted = (r, id) => { const alias = r; const { output } = alias;'
      + ' if (alias.exitCode === 2 || output) return "0";'
      + ' const laundered = launder(r);'
      + ' return r.rows.find((c) => c.startsWith("SELFTEST_RESULT_ROW ") && c.includes(id)); };',
  );
  // Each hop must be represented, not just the total: `planted_control=4` could be four direct
  // reads with both propagation paths dead. The row names them so the reader can see all three.
  const PLANTED_PATHS = ["alias.exitCode", "destructured.output", "r.rows", "escapes_into(launder)"];
  check(
    "signature guard: no row reader can reach a run's exit code, and the walker that says so is proven able to see one",
    leaked.length === 0 && plantedLeak.length > 0
      && PLANTED_PATHS.every((path) => plantedLeak.some((entry) => entry.endsWith(path)))
      && REQUIRED_READERS.every((name) => examined.includes(name)),
    `examined=${examined.length}_derived required=${REQUIRED_READERS.filter((name) => examined.includes(name)).length}/${REQUIRED_READERS.length} [${examined.join(", ")}] leaks=${leaked.length}/0${leaked.length ? ` [${leaked.join(", ")}]` : ""} planted_control=${plantedLeak.length}/>0 [${plantedLeak.join(", ")}]`,
  );

  // AND THE SAME RULE FILE-WIDE, ON ARGUMENTS RATHER THAN ON READERS.
  //
  // The guard above asks whether a DERIVED READER hands its parameter onward, and review moved the
  // identical launderer one frame out to defeat it: `cellSecondary(pickRows(run), cell, field)` in
  // the kill loop restored the exit-2 oracle with the reader untouched, `examined` unmoved at 3, and
  // the guard's row BYTE-IDENTICAL to a healthy run. The launderer ran 13 times and decided 13
  // assertions. Nothing was reintroduced and no rule was broken; the SUBJECT was wrong.
  //
  // Every round so far moved the frame rather than breaking the rule, so this asks the question with
  // no next frame: A RUN-SHAPED VALUE MAY NOT BE PASSED TO ANY CALL, ANYWHERE IN THIS FILE. Not "no
  // reader may pass it on", which is a claim about one frame. Runs are found by their CONSTRUCTORS
  // rather than by name, aliases inherit to a FIXED POINT so a chain of any length is covered, and
  // every argument position in the file is the subject.
  //
  // Reading `.rows` or `.exitCode` off a run stays legal, because that is how the harness asserts on
  // exit codes at all, measured at 2 construction points and 7 assertion reads. What is forbidden is
  // handing the OBJECT to something, which is the only way a value these walkers cannot see gets to
  // decide an assertion.
  const RUN_MAKERS = new Set(["runSelftest", "runTrackedSelftest"]);
  const runsPassedToCalls = (source) => {
    const sf = ts.createSourceFile("suite.mjs", source, ts.ScriptTarget.Latest, true);
    const runs = new Set();
    const passed = [];
    // Alias propagation runs to a FIXED POINT, not for a fixed number of passes. A two-pass version
    // covers `const a = run;` and quietly misses `const b = a;` later in the file, which is the
    // same one-hop blindness the taint walker was already corrected for once.
    const collect = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const init = node.initializer;
        if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)
          && RUN_MAKERS.has(init.expression.text)) runs.add(node.name.text);
        if (ts.isIdentifier(init) && runs.has(init.text)) runs.add(node.name.text);
      }
      ts.forEachChild(node, collect);
    };
    let previous = -1;
    while (runs.size !== previous) {
      previous = runs.size;
      collect(sf);
    }
    const audit = (node) => {
      if (ts.isCallExpression(node)) {
        node.arguments.forEach((argument, index) => {
          if (ts.isIdentifier(argument) && runs.has(argument.text)) {
            const callee = ts.isIdentifier(node.expression)
              ? node.expression.text
              : (ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : "call");
            passed.push(`${callee}(arg${index}=${argument.text})`);
          }
        });
      }
      ts.forEachChild(node, audit);
    };
    audit(sf);
    return { runs: [...runs], passed };
  };
  const { runs: runBindings, passed: runsPassed } = runsPassedToCalls(suiteSource);
  // The control plants the exact shape review used AND a two-hop alias chain, so a walker that had
  // stopped resolving the constructor, or that propagated only one hop, reports a zero that reads
  // exactly like compliance. `planted_runs` must be 3: the run and both aliases.
  const { runs: plantedRuns, passed: plantedPassed } = runsPassedToCalls(
    // Declared in REVERSE order deliberately: r2 aliases r1 and r1 aliases r0, but each appears
    // BEFORE the binding it copies. One traversal resolves only the hop whose source it has already
    // seen, so a single pass reports planted_runs=1 and this control goes red. Source order is what
    // makes the fixed point observable; a forward-ordered chain resolves in one pass and would grade
    // nothing.
    'const r2 = r1; const r1 = r0; const r0 = runSelftest(p);'
      + ' const rows = pickRows(r2); const ok = summary(r0.rows);',
  );
  check(
    "argument guard: no run-shaped value is passed to any call in this file, and the walker that says so is proven able to see one through a two-hop alias",
    runsPassed.length === 0 && runBindings.length >= 3
      && plantedPassed.length > 0 && plantedRuns.length === 3,
    `runs=${runBindings.length}/>=3 [${runBindings.join(", ")}] passed=${runsPassed.length}/0${runsPassed.length ? ` [${runsPassed.join(", ")}]` : ""} planted_control=${plantedPassed.length}/>0 [${plantedPassed.join(", ")}] planted_runs=${plantedRuns.length}/3 [${plantedRuns.join(", ")}]`,
  );

  for (const testCase of CASES) {
    const { cell, reader, find, replace, family, helper } = testCase;
    const secondaryField = FACTORIES.find((entry) => entry.name === family)?.secondaryField
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
    check(
      `${cell}: the ${secondaryField} reader reports a nonzero count before any tamper, so a later 0 is a reading`,
      baselineSecondary !== undefined && Number(baselineSecondary) > 0,
      `baseline ${secondaryField}=${baselineSecondary ?? "undefined"}/>0`,
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
      `${cell}: destroying the planted subject drives this cell's ${secondaryField} to 0, so its ${reader} still discriminates`,
      secondary === "0",
      `${secondaryField}=${secondary}/0`,
    );

    // And the cell must actually go red, so a working reader is not merely printing a number that
    // nothing acts on.
    check(
      `${cell}: that dead reading turns the cell red`,
      status === "FAIL",
      `status=${status}/FAIL`,
    );

    // A dead discriminator must also be visible in the two figures a human actually reads.
    check(
      `${cell}: a dead cell is visible in the summary row and the exit code`,
      run.exitCode === 2 && runSummary !== undefined && runSummary.status === "FAIL"
        && runSummary.passed === runSummary.total - 1,
      `exit=${run.exitCode}/2 cells=${runSummary?.passed}/${runSummary?.total} status=${runSummary?.status}`,
    );
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`\n${passed}/${total} checks passed, ${failures.length} failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`\n${passed}/${total} checks passed`);
