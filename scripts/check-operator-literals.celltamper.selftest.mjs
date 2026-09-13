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
 * still reports `cells=34/34 status=PASS`, and the process still exits 0. Measured at
 * fe813fe390d3ef47ac54325f48be816ebaa84148: three separate hollowed readers each survived the
 * scanner's own suite with 34/34 PASS, while a genuine behaviour weakening (CIDR_SUFFIX) went
 * 30/34 FAIL exit 2. A dead discriminator is invisible to the instrument it belongs to.
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
 * Exit 0 all checks passed, 1 a check failed.
 */
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

/** The status this run reported for one cell, or undefined when the cell emitted no result row. */
const cellStatus = (run, id) => {
  const row = run.rows.find(
    (candidate) => candidate.startsWith("SELFTEST_RESULT_ROW ") && candidate.includes(` cell=${id} `),
  );
  return /\bstatus=([A-Z]+)/.exec(row ?? "")?.[1];
};

/**
 * The value this run reported for one cell's SECONDARY reader, or undefined when the cell emitted
 * no readable row.
 *
 * Status alone is too blunt to grade a hollowed reader, and the difference decides the whole suite.
 * On a POSITIVE cell (`host-planted`, expecting `primary=1`) destroying the planted subject drops
 * BOTH readings, so the cell goes FAIL on its primary whether or not the secondary still works. A
 * suite asserting only `status=FAIL` would therefore report a pass with the secondary hollowed out,
 * which is the exact wrong-green this file exists to catch. Reading the secondary FIELD instead
 * grades the reader that was actually mutated: a live reader reports 0 for a destroyed subject, and
 * one hollowed to a constant reports its expected value no matter what it is handed.
 */
const cellSecondary = (run, id, field = "secondary") => {
  const row = run.rows.find(
    (candidate) => candidate.startsWith("SELFTEST_RESULT_ROW ") && candidate.includes(` cell=${id} `),
  );
  return new RegExp(`\\b${field}=(\\d+)\\/`).exec(row ?? "")?.[1];
};

/** The `cells=passed/total status=...` summary this run reported. */
const summary = (run) => {
  const row = run.rows.find((candidate) => candidate.startsWith("SELFTEST_SUMMARY_ROW "));
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
];

/**
 * Every cell-constructing family in the scanner, and the field each one's discriminator reports.
 *
 * THIS IS THE PART THAT MAKES ABSENCE DETECTABLE. A case list grades what it names and is silent
 * about what it forgot, so on its own it can never report the family it missed, which is exactly
 * how survivors reached review. The census below counts the factories in the SOURCE and requires
 * each to appear here, turning a missing case from an invisible gap into a named failure.
 *
 * EVERY FAMILY IS GRADED. An earlier version exempted `scanCell` as a "known limit", claiming it
 * reported no secondary reading. That was WRONG and a reviewer disproved it: `scanCell` reports a
 * `metricCount` under the cell's own metric name, and hollowing that to the expected value
 * SURVIVED. The field is simply not called `secondary`, which is why a reader looking only for that
 * name concluded there was nothing to grade. A limitation asserted rather than measured is just a
 * gap with a label on it, so the exemption is gone and the field name is read per family.
 */
const FAMILIES = [
  { name: "matchCell", secondaryField: "secondary" },
  { name: "cidrBoundaryCell", secondaryField: "planted" },
  { name: "scanCell", secondaryField: "allowed" },
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
  const baseSummary = summary(baseline);
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
  const copySummary = summary(copyRun);
  const copyOk = check(
    "control: an UNTAMPERED copy reproduces the baseline, so a red below is caused by the tamper",
    copyRun.exitCode === 0 && copySummary !== undefined
      && copySummary.status === "PASS" && copySummary.passed === copySummary.total,
    `exit=${copyRun.exitCode}/0 cells=${copySummary?.passed}/${copySummary?.total} status=${copySummary?.status}`,
  );

  // THE CENSUS. Enumerate the cell factories the scanner actually defines and require this file to
  // account for every one. A case list grades what it names and stays silent about what it forgot,
  // so without this check a factory this file never knew about is ungraded and green. Survivors
  // found in review were exactly that shape. Reading the SOURCE rather than a hand-maintained list
  // makes the scanner itself the denominator.
  //
  // The match is deliberately tolerant of formatting: `export`, `async` and whitespace before the
  // parenthesis are all behaviour-neutral edits that a tidier may make, and a reader that loses a
  // factory to one of them reports a SMALLER denominator while still saying `unaccounted=0`.
  const extractFamilies = (source) =>
    [...source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w*Cell)\s*\(/gm)].map((m) => m[1]);
  const definedFamilies = extractFamilies(tracked);
  const accounted = FAMILIES.map((entry) => entry.name);
  const findUnaccounted = (defined) => defined.filter((name) => !accounted.includes(name));
  const unaccounted = findUnaccounted(definedFamilies);
  check(
    "census: every cell factory the scanner defines is accounted for by this suite",
    definedFamilies.length > 0 && unaccounted.length === 0,
    `defined=${definedFamilies.length} [${definedFamilies.join(", ")}] unaccounted=${unaccounted.length}${unaccounted.length ? ` [${unaccounted.join(", ")}]` : ""}`,
  );

  // THE CENSUS MUST BE BIDIRECTIONAL, and this is the half that cost a BLOCK.
  //
  // `unaccounted` only asks whether everything FOUND is named. It cannot notice a factory the
  // extractor FAILED TO FIND, because a name that never enters `definedFamilies` cannot appear in
  // any difference computed from it. Measured by a reviewer: the behaviour-neutral edit
  // `function matchCell(` -> `function matchCell (` dropped matchCell from the census entirely and
  // the suite still reported `defined=2 ... unaccounted=0` and a full green. The denominator
  // shrank in silence, which is this issue's own defect one more level down.
  //
  // So require the reverse containment too: every family this file claims to grade must actually be
  // located in the source. A factory that is renamed, reformatted beyond the pattern, or deleted
  // now fails by name instead of quietly reducing what is measured.
  const findMissingFromSource = (claimed, defined) => claimed.filter((name) => !defined.includes(name));
  const missingFromSource = findMissingFromSource(accounted, definedFamilies);
  check(
    "census: every family this suite claims to grade is actually found in the scanner source",
    missingFromSource.length === 0,
    `claimed=${accounted.length} located=${accounted.length - missingFromSource.length}${missingFromSource.length ? ` NOT FOUND [${missingFromSource.join(", ")}]` : ""}`,
  );

  // Same reasoning as the comparison control below, applied to this direction: with every family
  // present, a working containment check and a hardcoded empty list print the same `located=3`.
  const plantedLoss = findMissingFromSource([...accounted, "plantedLostCell"], definedFamilies);
  check(
    "census control: a family absent from the source is reported, so the containment above is a reading",
    plantedLoss.length === 1 && plantedLoss[0] === "plantedLostCell",
    `planted_reported=${plantedLoss.length}/1 [${plantedLoss.join(", ")}]`,
  );

  // A CENSUS THAT CANNOT REPORT A MISS IS NOT A CENSUS. Two separate readers are involved and each
  // needs its own planted positive, because a control on one says nothing about the other: the
  // BLOCK above landed precisely because the existing control exercised the set comparison while
  // the defect was in the source extractor.
  const plantedMiss = findUnaccounted([...definedFamilies, "plantedUnaccountedCell"]);
  check(
    "census control: a planted unaccounted factory is reported, so the comparison above is a reading",
    plantedMiss.length === 1 && plantedMiss[0] === "plantedUnaccountedCell",
    `planted_reported=${plantedMiss.length}/1 [${plantedMiss.join(", ")}]`,
  );

  // The extractor's own planted positive, fed synthetic source rather than the real file. The
  // REFUSE half matters as much as the accept half: a pattern loose enough to match a call site or
  // a mention in prose would report factories that do not exist and mask a real loss.
  const plantedSource = [
    "function plantedAcceptCell(id) {",
    "export function plantedExportCell(id) {",
    "  plantedCallSiteCell('x'),",
    "// a comment mentioning function plantedCommentCell( in prose",
  ].join("\n");
  const plantedExtraction = extractFamilies(plantedSource);
  check(
    "census control: the source extractor finds declared factories and refuses call sites and prose",
    plantedExtraction.length === 2
      && plantedExtraction.includes("plantedAcceptCell")
      && plantedExtraction.includes("plantedExportCell"),
    `extracted=${plantedExtraction.length}/2 [${plantedExtraction.join(", ")}] (call site and prose must be refused)`,
  );

  // Every family carrying a discriminator must have a case that drives it. Nothing is exempt: the
  // one family this suite previously exempted turned out to carry a gradable discriminator under a
  // different field name, and a reviewer proved it by hollowing that field out.
  const gradable = FAMILIES.filter((entry) => entry.secondaryField !== null);
  const ungraded = gradable.filter((entry) => !CASES.some((c) => c.family === entry.name));
  check(
    "census: every family carrying a discriminator has a case that drives it",
    ungraded.length === 0 && gradable.length === FAMILIES.length,
    `gradable=${gradable.length}/${FAMILIES.length}_families covered=${gradable.length - ungraded.length}${ungraded.length ? ` MISSING [${ungraded.map((e) => e.name).join(", ")}]` : ""}`,
  );

  for (const testCase of CASES) {
    const { cell, reader, find, replace, family } = testCase;
    const secondaryField = FAMILIES.find((entry) => entry.name === family)?.secondaryField ?? "secondary";

    check(
      `${cell}: the untampered copy reports this cell passing`,
      copyOk && cellStatus(copyRun, cell) === "PASS",
      `status=${cellStatus(copyRun, cell)}/PASS`,
    );

    let tamperedSource;
    try {
      tamperedSource = tamperCell(tracked, cell, find, replace);
    } catch (error) {
      check(`${cell}: the tamper lands inside the named cell block`, false, error.message);
      continue;
    }
    check(
      `${cell}: the tamper lands inside the named cell block`,
      tamperedSource !== tracked,
      `reader=${reader}`,
    );

    const tamperedPath = join(workdir, `tampered-${cell}.mjs`);
    writeFileSync(tamperedPath, tamperedSource);
    const run = runSelftest(tamperedPath);
    const status = cellStatus(run, cell);
    const secondary = cellSecondary(run, cell, secondaryField);
    const runSummary = summary(run);

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
