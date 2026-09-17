#!/usr/bin/env node
/**
 * Self-test for the cell-target check in `mutation-coverage.mjs` (#1545).
 *
 * WHAT IS UNDER TEST. `expectRed` is machine-checked to redden: `mutation-proof` grades WRONG-RED
 * when the named assertion never printed its failure, and again when it printed its green text
 * unchanged. Neither can fire when the named assertion reddens for a reason unrelated to the
 * mutated guard, so an entry could edit an end-to-end guard, name a parser-only cell, and grade a
 * clean KILLED having proved nothing about the code it edits. PR #1521 shipped two such entries.
 *
 * WHAT THE CHECK CLAIMS, AND WHAT THIS SUITE THEREFORE ASSERTS. "This assertion proves that guard"
 * is semantic and undecidable from text. The necessary condition is decidable: a cell whose verdict
 * rests on nothing outside the suite's own source cannot be proving anything about a file in
 * another module, because no edit to that file can change what it prints. Every cell below asserts
 * that condition and nothing stronger.
 *
 * WHY THE FIXTURES COME IN PAIRS. A refusal on its own shows only that something was refused. Each
 * refusal here has a twin differing ONLY in which cell the mutation names -- same suite, same
 * guarded source, same command, same anchor -- so what separates them is the RELATION between the
 * mutated file and the named cell rather than either one alone. A check that refused on the suite,
 * the source, or the command would fail the twin.
 *
 * WHY IT DRIVES THE REAL COMMAND. Each case spawns `scripts/mutation-coverage.mjs` against a
 * throwaway repository, so the code under test is the shipped validator on its real entry path
 * rather than a helper this file imports. That is also what keeps the proof honest under a revert:
 * this suite imports nothing the fix adds, so reverting the fix leaves the module graph intact and
 * the cells below measure behaviour.
 *
 * Run: node scripts/mutation-cell-witness.selftest.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "mutation-coverage.mjs");
const root = mkdtempSync(join(tmpdir(), "mutation-cell-witness-"));
let passed = 0;
let failed = 0;
// Report every cell rather than exiting at the first red. A mutant is only proven to bite when the
// cell it NAMES reds, and a fail-fast run hides every cell after the first.
const check = (name, condition, detail) => {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ FAIL: ${name}${detail !== undefined ? `\n      ${detail}` : ""}`); }
};

const write = (path, content) => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
};

/** A suite command that prints a parseable total without doing any work. */
const TALLY = `${JSON.stringify(process.execPath)} -e ${JSON.stringify('console.log("FIXTURE: 3 passed, 0 failed")')}`;

const runTool = (...configs) => {
  const run = spawnSync(process.execPath, [TOOL, ...configs], {
    cwd: root, encoding: "utf8", timeout: 120_000,
  });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "", out: `${run.stdout ?? ""}${run.stderr ?? ""}` };
};

try {
  // The guarded source every mutation below edits. One file, so the mutated side is held fixed and
  // only the named cell varies.
  write("bin/direct.mjs", "export const x = 1;\n");

  // One suite carrying cells of different kinds, so a fixture can name any of them without
  // changing anything else about the run.
  //
  // EACH OBSERVING CELL REACHES THE WORLD BY EXACTLY ONE ROUTE, which is the whole reason the cells
  // are written this way rather than in whatever shape reads most naturally. A cell that reached it
  // by two routes would stay green with either one deleted, so the arms of the analysis could be
  // removed one at a time without any cell noticing -- and the resulting suite would be an
  // instrument that always says accept, which is precisely the defect this file exists to refuse.
  write("bin/smoke/cells.smoke.ts", [
    'import { readFileSync, appendFileSync } from "node:fs";',
    'import { spawnSync } from "node:child_process";',
    'import { report } from "./report.js";',
    "let passed = 0;",
    "// The suite LAUNCHES the guarded entrypoint once, up front and outside every cell. That is what",
    "// makes the fixture gradable at all (mutation-coverage requires the suite to reach the mutated",
    "// file), and keeping it out of the cells is what keeps each cell's route to the world single.",
    'const launched = spawnSync(process.execPath, ["bin/direct.mjs"], { encoding: "utf8" });',
    "void launched;",
    "const check = (name, cond) => { if (cond) passed++; console.log(`${cond ? '  ok' : '  FAIL'} ${name}`); };",
    "",
    "// PARSER-ONLY: graded against a string this file wrote. Nothing outside this source can change",
    "// what it prints, so no mutation anywhere else is proven by it.",
    "const parse = (text) => (text.match(/expected: (\\\\d+)/) ?? [])[1];",
    'check("the banner parser reads the count out of a banner", parse("expected: 7") === "7");',
    "",
    "// THROUGH AN IMPORT ONLY: the verdict rests on a function from another module and on nothing",
    "// ambient, so deleting the import arm alone reddens the cell that names it.",
    'check("the guarded source still declares an export", readFileSync("bin/direct.mjs", "utf8").includes("export"));',
    "",
    "// THROUGH A GLOBAL ONLY: the verdict rests on `process`, which reaches the environment and the",
    "// processes this suite started. No import is involved, so deleting the global arm alone reddens",
    "// the cell that names it.",
    'check("the run carries the environment the guarded entrypoint needs", process.env.PATH !== "");',
    "",
    "// PARSER-ONLY, REPORTED THROUGH A HELPER that computes the verdict itself. A reader that only",
    "// looked at the call site's arguments would call this one self-fed for the wrong reason.",
    "const graded = (name, text, want) => { check(name, parse(text) === want); };",
    'graded("the parser is graded through a helper", "expected: 3", "3");',
    "",
    "// OBSERVING, REPORTED THROUGH THE SAME HELPER, and it is the twin of the cell above: a reader",
    "// that stopped at the call site would call this one self-fed too, because everything it",
    "// observes is reached from inside the helper.",
    "const gradedRead = (name, path) => { check(name, readFileSync(path, \"utf8\").includes(\"export\")); };",
    'gradedRead("the guarded source is read from inside a helper", "bin/direct.mjs");',
    "",
    "// SELF-FED VERDICT, OBSERVING BOOKKEEPING. The reporter writes a transcript, so its body",
    "// reaches the filesystem while the verdict it is handed reaches nothing. A reader that walked",
    "// the whole helper body rather than the part consuming the verdict would call this observing,",
    "// and since every reporter in every suite does SOMETHING on the side, it would call every cell",
    "// in the corpus observing and refuse nothing ever again.",
    "const logged = (name, cond) => { appendFileSync(\"run.log\", `${name}\\n`); check(name, cond); };",
    'logged("the parser is reported by a helper that writes a transcript", parse("expected: 9") === "9");',
    "",
    "// REPORTED BY AN IMPORTED HELPER, verdict self-fed. The verdict may be computed anywhere inside",
    "// a module this analysis does not read, so it has no standing to refuse and must accept. A",
    "// refusal here would be an accusation the tool cannot back, against an entry that may be right.",
    'report("the parser is reported from another module", parse("expected: 5") === "5");',
    "",
    "console.log(`FIXTURE: ${passed} passed, 0 failed`);",
  ].join("\n"));

  // The reporter this analysis cannot read: a different module, so the verdict it is handed may be
  // computed anywhere inside it.
  write("bin/smoke/report.js", "export const report = (name, cond) => { console.log(`${cond ? '  ok' : '  FAIL'} ${name}`); };\n");

  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=c", "commit", "--quiet", "-m", "fixture"], { cwd: root });

  const fixture = (name, cell, overrides = {}) => {
    write(`${name}.json`, JSON.stringify({
      suite: ["bin/smoke/cells.smoke.ts"],
      command: TALLY,
      executes: ["bin/direct.mjs"],
      mutations: [{
        name: `edits bin/direct.mjs naming ${JSON.stringify(cell)}`,
        file: "bin/direct.mjs", find: "export const x = 1;", replace: "export const x = 2;",
        expectRed: cell, cell,
      }],
      ...overrides,
    }));
    return `${name}.json`;
  };

  // ---- the refusal ------------------------------------------------------------------------------
  let result = runTool("--gradable-only", fixture("parser-only", "the banner parser reads the count out of a banner"));
  check(
    "a mutation whose named cell observes nothing outside the suite text is refused",
    result.status !== 0 && /REFUSED parser-only\.json/.test(result.out),
    result.out,
  );
  check(
    "...and the refusal says WHY in the terms it can actually back, naming the cell it read",
    /reaches no launch, file read, or module import/.test(result.out)
      && /cannot be the assertion that proves the mutated guard/.test(result.out)
      && /the banner parser reads the count out of a banner/.test(result.out),
    result.out,
  );

  // The same shape one level in: the verdict is computed inside a helper rather than at the call
  // site. Reading only the reported expression would miss this and accept it.
  result = runTool("--gradable-only", fixture("parser-through-helper", "the parser is graded through a helper"));
  check(
    "a self-fed cell reported through a helper that computes the verdict is refused too",
    result.status !== 0 && /REFUSED parser-through-helper\.json/.test(result.out),
    result.out,
  );

  // ---- the twins that must stay ACCEPTED --------------------------------------------------------
  //
  // Each differs from the refusal above ONLY in the named cell. Together they are what shows the
  // refusal is about the relation rather than about this suite, source, or command.
  result = runTool("--gradable-only", fixture("reads-source", "the guarded source still declares an export"));
  check(
    "the SAME mutation naming a cell that reaches the world through an IMPORT is accepted",
    result.status === 0 && /ACCEPTED reads-source\.json/.test(result.out),
    result.out,
  );

  // The second route, isolated from the first. This cell touches no import at all, so an accept
  // here cannot be the import arm answering, and the two together are what show the analysis reads
  // observation from the binding rather than from one privileged spelling.
  result = runTool("--gradable-only", fixture("reads-global", "the run carries the environment the guarded entrypoint needs"));
  check(
    "and so is one reaching it through an ambient GLOBAL and no import at all",
    result.status === 0 && /ACCEPTED reads-global\.json/.test(result.out),
    result.out,
  );

  // Reported through the same helper as the refused cell above and differing only in what the
  // helper reaches. A reader that stopped at the call site would call BOTH self-fed, and this is
  // the half that would then be a false refusal against a correct entry.
  result = runTool("--gradable-only", fixture("observes-through-helper", "the guarded source is read from inside a helper"));
  check(
    "and so is one whose observation happens INSIDE the reporter helper, not at the call site",
    result.status === 0 && /ACCEPTED observes-through-helper\.json/.test(result.out),
    result.out,
  );

  // The reporter's own side effects are not evidence about the code under test. A reader that
  // walked the whole helper body would call this cell observing, and since every reporter does
  // SOMETHING on the side, it would then accept every cell in the corpus and refuse nothing ever
  // again -- an instrument that always says accept, which is this issue's own defect one level up.
  result = runTool("--gradable-only", fixture("logging-reporter", "the parser is reported by a helper that writes a transcript"));
  check(
    "a self-fed cell is still refused when its reporter writes a transcript of its own",
    result.status !== 0 && /REFUSED logging-reporter\.json/.test(result.out),
    result.out,
  );

  // ---- the refusals this check must NOT make ----------------------------------------------------
  //
  // A cell the analysis cannot locate is not a cell it has judged. A composed label, or one reported
  // from a helper module, lands here, and refusing on it would be an accusation the tool cannot back.
  result = runTool("--gradable-only", fixture("unlocated", "a cell no suite source reports under that literal text"));
  check(
    "a cell the analysis cannot locate in the suite is accepted, not refused",
    result.status === 0 && /ACCEPTED unlocated\.json/.test(result.out),
    result.out,
  );

  // A cell reported from ANOTHER MODULE is accepted whatever its arguments look like: the verdict
  // may be computed anywhere inside a module this analysis does not read, so it has no standing to
  // refuse. This cell's arguments are self-fed, so an accept here can only be the unreadable
  // reporter and not the values at the call site.
  result = runTool("--gradable-only", fixture("imported-reporter", "the parser is reported from another module"));
  check(
    "a cell reported from a module this cannot read is accepted, however its arguments look",
    result.status === 0 && /ACCEPTED imported-reporter\.json/.test(result.out),
    result.out,
  );

  // A suite mutating its OWN source observes the mutation by running at all. Without this exemption
  // every tool self-test in the corpus would be refused for a reason that is false about it.
  write("self.json", JSON.stringify({
    suite: ["bin/smoke/cells.smoke.ts"],
    command: TALLY,
    mutations: [{
      name: "edits the suite it runs", file: "bin/smoke/cells.smoke.ts",
      find: 'parse("expected: 7") === "7"', replace: 'parse("expected: 7") === "8"',
      expectRed: "the banner parser reads the count out of a banner",
      cell: "the banner parser reads the count out of a banner",
    }],
  }));
  result = runTool("--gradable-only", "self.json");
  check(
    "a suite mutating its OWN source is exempt: running it is how it observes the mutation",
    result.status === 0 && /ACCEPTED self\.json/.test(result.out),
    result.out,
  );

  // A fixture with no `cell` at all is the existing REQUIRED-key refusal, not this one. Grading it
  // here would report the wrong repair for a fixture that has a different problem.
  write("no-cell.json", JSON.stringify({
    suite: ["bin/smoke/cells.smoke.ts"],
    command: TALLY,
    executes: ["bin/direct.mjs"],
    mutations: [{
      name: "carries no cell", file: "bin/direct.mjs", find: "export const x = 1;",
      replace: "export const x = 2;", expectRed: "the banner parser reads the count out of a banner",
    }],
  }));
  result = runTool("--gradable-only", "no-cell.json");
  check(
    "a mutation with no cell is refused for the MISSING key, not for observing nothing",
    result.status !== 0 && /is missing "cell"/.test(result.out)
      && !/reaches no launch, file read, or module import/.test(result.out),
    result.out,
  );

  // An instrument config (`grades: "tool"`) does not carry a `cell` at all, so this check has
  // nothing to read and must stay out of its way.
  write("instrument.json", JSON.stringify({
    grades: "tool",
    suite: ["bin/smoke/cells.smoke.ts"],
    command: TALLY,
    mutations: [{
      name: "grades an instrument", file: "bin/direct.mjs", find: "export const x = 1;",
      replace: "export const x = 2;", expectRed: "the banner parser reads the count out of a banner",
    }],
  }));
  result = runTool("--gradable-only", "instrument.json");
  check(
    'a grades:"tool" config is untouched by this check',
    result.status === 0 && /ACCEPTED instrument\.json/.test(result.out),
    result.out,
  );

  // ---- CONTROL: the validator still runs and still reports the rest of its work ------------------
  //
  // Every cell above reads a REFUSAL or an ACCEPT of one config. If the validator died on startup,
  // "not accepted" would be true of everything and the refusals would read as passes. This asserts
  // the summary the tool prints when it has examined a selection, so a run that never got that far
  // is visibly different from one that graded.
  result = runTool("--gradable-only", "reads-source.json", "reads-global.json", "unlocated.json");
  check(
    "CONTROL: the validator examines and grades a whole selection, and says so in its summary",
    result.status === 0
      && /enumerated=3 examined=3 graded=3/.test(result.out)
      && /refused-with-reason=0/.test(result.out),
    result.out,
  );

  // The mixed selection: one refusal must not stop the others being examined, and the summary must
  // count both sides. A check that aborted the run would be invisible to the single-config cells.
  result = runTool("--gradable-only", "parser-only.json", "reads-source.json");
  check(
    "a refused config does not hide the config after it, and both are counted",
    result.status !== 0
      && /REFUSED parser-only\.json/.test(result.out)
      && /ACCEPTED reads-source\.json/.test(result.out)
      && /examined=2 graded=1 refused-with-reason=1/.test(result.out),
    result.out,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

/**
 * How many cells this file is expected to run.
 *
 * A tally of what DID run cannot tell a full green run from one that quietly did less: guard a cell
 * out with a refactor accident and the suite still prints `0 failed` and exits 0, just with a
 * smaller first number nothing compares against. Raise it in the same change that adds a cell.
 */
const EXPECTED_CELLS = 14;
console.log(`\nMUTATION CELL-WITNESS SELF-TEST: ${passed} passed, ${failed} failed`);
if (failed === 0 && passed !== EXPECTED_CELLS) {
  console.log(`  ✗ FAIL: expected ${EXPECTED_CELLS} cells, ran ${passed}: silently skipped cells must not read as green`);
  process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
