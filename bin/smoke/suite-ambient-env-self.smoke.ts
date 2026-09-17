/**
 * Ambient-environment census over a suite's OWN process - the other half of `smoke:suite-ambient-env`.
 *
 * WHAT THE OTHER HALF COVERS, AND WHAT IT DOES NOT. `suite-ambient-env` grades the environment a
 * suite hands a CHILD: every `...process.env` spread into a child env must strip the `COTAL_` keys
 * first, so a spawned daemon cannot inherit the runner's live mesh identity. It has no view of a
 * suite that never spawns anything and simply READS its own `process.env` in-process. That read is
 * the same defect pointed the other way: whatever runs the suite may be a managed agent session, so
 * the suite is handed an identity nobody chose, and the connector's config layer is entitled to
 * refuse it.
 *
 * THE FAILURE THIS IS FOR. `configFromEnv` refuses a launch that carries connection material BOTH as
 * a launch-material pointer and as the direct variables, because one launch carries one identity
 * plane. A suite that defaults a direct variable itself then dies inside its own import, with an
 * error that reads exactly like a code defect in the thing under test. The launch-material pointer
 * is only the loudest of them: an inherited agent-file path makes the same read throw on a file the
 * suite never named, and an inherited broker address makes it resolve somewhere nobody chose and
 * say nothing at all. CI carries none of these variables, so CI never sees any of it.
 *
 * THE RULE. Every suite that reads the ambient environment through one of {@link READERS} must
 * scrub the `COTAL_` prefix from `process.env` at MODULE SCOPE, before that first read - or appear
 * in {@link REVIEWED} with a measured reason. Prefix, not one variable: a scrub aimed at the single
 * variable that throws today leaves the twelve beside it, and the next one to bite is whichever the
 * config layer starts reading next.
 *
 * MODULE SCOPE IS THE WHOLE POINT. A scrub inside a function is not ownership, it is a promise that
 * the function runs before every read, and a census cannot see whether it does. A scrub inside a
 * conditional is a promise the condition fires. The other half encodes this as structural brace
 * depth zero; this one asks the parser directly, so the qualifying statement is a top-level
 * statement of the source file and nothing else.
 *
 * WHAT THIS CANNOT SEE, stated so nobody mistakes it for more than it is. It reads source, never a
 * run. A top-level scrub loop whose `Object.keys` somehow yields nothing, or whose `startsWith` test
 * is true for no key present, is shaped exactly like a scrub that works. Recognition is also by
 * SPELLING: a reader imported under an alias, or reached through a re-export this file does not name,
 * is not in the census at all - and a file that is not in the census is absent rather than red.
 *
 * Run: `pnpm smoke:suite-ambient-env-self`
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = new Set(["node_modules", "dist", ".git", ".pnpm-store", "coverage", "reserved"]);

/** Every tracked source file under a smoke path, keyed on CONTENT and location rather than on one
 *  directory: suites live under `bin/smoke`, under a package's own `smoke` directory, and as bare
 *  `*.smoke.ts` files beside their package. Same walk as the child-process half, for the same
 *  reason: a census that knew only the first would miss the other two silently. */
function* suiteSources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* suiteSources(p);
    else if (/\.(ts|mts|cts|mjs|js)$/.test(e.name) && statSync(p).size < 2_000_000) {
      const rel = relative(repoRoot, p).split("\\").join("/");
      if (/(^|\/)smoke(\/|\.)/.test(rel) || /\.smoke\.[a-z]+$/.test(rel)) yield p;
    }
  }
}

/**
 * The connector-core entry points that resolve a session from the AMBIENT environment.
 *
 * `configFromEnv` is the one the tree calls today and the one issue #833 names. The other two are
 * here because they read the same variables from the same default argument, and the next author
 * reaching for a sibling should land inside the census rather than outside it. A term that matches
 * no repository file matches the fixtures below instead, which is where its behaviour is graded.
 */
const READERS = new Set(["configFromEnv", "controlFromEnv", "hasIdentity"]);

function isProcessEnv(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === "env"
  );
}

/** A call that reads the ambient environment: no argument at all (the default is `process.env`), or
 *  `process.env` passed explicitly. A call handed a constructed object is a DIFFERENT call - it
 *  reads what the suite built, which is the shape this census is asking files to move to. */
function ambientReadPositions(file: ts.SourceFile): number[] {
  const found: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : undefined;
      if (name !== undefined && READERS.has(name)) {
        const args = node.arguments;
        if (args.length === 0 || (args.length === 1 && isProcessEnv(args[0]))) found.push(node.getStart(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found.sort((a, b) => a - b);
}

/** `delete process.env[<key>]`, with the SAME identifier the loop bound. A delete keyed on anything
 *  else is a loop that walks the ambient keys and removes something else. */
function deletesAmbientKey(node: ts.Node, key: string): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (ts.isDeleteExpression(n)) {
      const target = n.expression;
      if (
        ts.isElementAccessExpression(target) &&
        isProcessEnv(target.expression) &&
        ts.isIdentifier(target.argumentExpression) &&
        target.argumentExpression.text === key
      ) {
        hit = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/** `<key>.startsWith("COTAL_")`, on the identifier the loop bound. */
function testsCotalPrefix(node: ts.Expression, key: string): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "startsWith") return false;
  if (!ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== key) return false;
  if (node.arguments.length !== 1) return false;
  const arg = node.arguments[0];
  return ts.isStringLiteral(arg) && arg.text === "COTAL_";
}

/** The guarded delete, as the loop body: `if (k.startsWith("COTAL_")) delete process.env[k];`,
 *  either bare or as the single guarded statement of a block. The `if` must be a statement OF the
 *  loop body, not buried under a second condition the census cannot evaluate. */
function scrubsInsideLoop(body: ts.Statement, key: string): boolean {
  const statements = ts.isBlock(body) ? [...body.statements] : [body];
  return statements.some(
    (st) =>
      ts.isIfStatement(st) &&
      testsCotalPrefix(st.expression, key) &&
      deletesAmbientKey(st.thenStatement, key),
  );
}

/**
 * The first MODULE-SCOPE prefix scrub, or undefined.
 *
 * Only `file.statements` is examined, so the statement is a top-level statement of the module and
 * cannot be inside a function, a conditional, a block, a try, or a loop. That is the distinction the
 * child-process half draws with structural brace depth, asked of the parser instead of counted.
 */
function moduleScopeScrubPosition(file: ts.SourceFile): number | undefined {
  for (const statement of file.statements) {
    if (!ts.isForOfStatement(statement)) continue;
    const iterated = statement.expression;
    if (!ts.isCallExpression(iterated)) continue;
    if (!ts.isPropertyAccessExpression(iterated.expression)) continue;
    if (!ts.isIdentifier(iterated.expression.expression) || iterated.expression.expression.text !== "Object") continue;
    if (iterated.expression.name.text !== "keys") continue;
    if (iterated.arguments.length !== 1 || !isProcessEnv(iterated.arguments[0])) continue;
    const initializer = statement.initializer;
    if (!ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) continue;
    const bound = initializer.declarations[0].name;
    if (!ts.isIdentifier(bound)) continue;
    if (!scrubsInsideLoop(statement.statement, bound.text)) continue;
    return statement.getStart(file);
  }
  return undefined;
}

interface Verdict {
  applicable: boolean;
  scrubs: boolean;
  ordered: boolean;
  readLines: number[];
}

function evaluate(source: string, fileName = "suite.ts"): Verdict {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const reads = ambientReadPositions(file);
  if (reads.length === 0) return { applicable: false, scrubs: false, ordered: false, readLines: [] };
  const scrub = moduleScopeScrubPosition(file);
  return {
    applicable: true,
    scrubs: scrub !== undefined,
    ordered: scrub !== undefined && scrub < reads[0],
    readLines: reads.map((p) => file.getLineAndCharacterOfPosition(p).line + 1),
  };
}

/**
 * Files in this class that are graded SAFE without a scrub, each with the measurement.
 *
 * An entry is about the READ: why this suite's own process cannot be handed an identity it did not
 * choose, and why the variables it inherits cannot change what it resolves. A suite whose read
 * changes shape has to be re-measured, which is why the reason and not just the path is recorded.
 *
 * EMPTY TODAY, and that is the honest state rather than an oversight: every member of the class
 * scrubs. The mechanism is kept because the alternative to an exemption with a written reason is an
 * exemption nobody wrote down, and because a file that genuinely cannot scrub - one whose subject IS
 * the inherited environment - is a real possibility this census should not force into a lie. The
 * fixtures below grade the mechanism, so it is not an untested door.
 */
const REVIEWED: Record<string, string> = {};

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
};

// ── fixtures: the classifier's own negative controls ──
// Every repository member is compliant, so dropping a requirement below would change no real
// verdict. A requirement nothing exercises is a requirement nobody can prove.
{
  const READ = "const config = configFromEnv();\n";
  const SCRUB = 'for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];\n';

  check("fixture: a module-scope scrub before the read passes both requirements", (() => {
    const v = evaluate(SCRUB + READ);
    return v.applicable && v.scrubs && v.ordered;
  })());

  check("fixture: a scrub AFTER the read is rejected on order, not accepted on presence",
    !evaluate(READ + SCRUB).ordered);

  check("fixture: a file with no scrub at all is rejected", !evaluate(READ).scrubs);

  // The distinction the brief of this census turns on: a scrub in a function is a promise that the
  // function runs first, and nothing here can see whether it does.
  check("fixture: a scrub inside an uncalled function is not ownership",
    !evaluate(`function prepare() {\n  ${SCRUB}}\n` + READ).scrubs);

  check("fixture: a scrub inside a conditional is not ownership",
    !evaluate(`if (shouldScrub) {\n  ${SCRUB}}\n` + READ).scrubs);

  check("fixture: a scrub inside a try block is not ownership",
    !evaluate(`try {\n  ${SCRUB}} catch {}\n` + READ).scrubs);

  // Indentation is not structure. The child-process half learned this one the hard way: a scrub at
  // column zero can still be nested, and a scrub indented four spaces can still be top level.
  check("fixture: an indented module-scope scrub is still ownership",
    evaluate("    " + SCRUB + READ).ordered);

  // The narrow scrub the previous round of this defect installed. It stops the one variable that
  // throws today and leaves the rest of the prefix in place, so it is not a scrub.
  check("fixture: dropping a single named variable is not a prefix scrub",
    !evaluate("delete process.env.COTAL_LAUNCH_MATERIAL;\n" + READ).scrubs);

  check("fixture: a loop that walks the ambient keys but deletes from a COPY is not a scrub",
    !evaluate('const copy = { ...process.env };\nfor (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete copy[key];\n' + READ).scrubs);

  check("fixture: a loop guarded on a DIFFERENT prefix is not a scrub",
    !evaluate('for (const key of Object.keys(process.env)) if (key.startsWith("OPENCODE_")) delete process.env[key];\n' + READ).scrubs);

  // A census keyed on TEXT cannot tell a call site from a fixture, which is why the two sibling
  // censuses each carve their own file out of their own scan. This one reads the PARSE, so a
  // fixture living in a string literal is not a call and not a loop, and no carve-out is needed.
  // The cell states that as a fact rather than leaving it as a happy accident.
  check("fixture: a read and a scrub inside a string literal are not code",
    !evaluate(`const SOURCE = ${JSON.stringify(SCRUB + READ)};\n`).applicable);

  check("fixture: a comment mentioning the read is not a read",
    !evaluate("// const config = configFromEnv();\n").applicable);

  // The reader set, on the two terms no repository file exercises today.
  check("fixture: controlFromEnv() on the ambient environment is in the class",
    evaluate("const control = controlFromEnv();\n").applicable);
  check("fixture: hasIdentity(process.env) passed explicitly is in the class",
    evaluate("const managed = hasIdentity(process.env);\n").applicable);

  // The direction a suite is asked to move in: build the environment you mean, and the ambient one
  // is no longer an input at all.
  check("fixture: a read handed a constructed object is not in this class",
    !evaluate('const config = configFromEnv({ COTAL_NAME: "probe" });\n').applicable);
}

// ── the repository census ──
const offenders: string[] = [];
const compliant: string[] = [];
const exempted: string[] = [];
const members: string[] = [];

for (const file of suiteSources(repoRoot)) {
  const rel = relative(repoRoot, file).split("\\").join("/");
  const verdict = evaluate(readFileSync(file, "utf8"), rel);
  if (!verdict.applicable) continue;
  members.push(rel);
  if (rel in REVIEWED) {
    exempted.push(rel);
    continue;
  }
  if (verdict.scrubs && verdict.ordered) compliant.push(rel);
  else offenders.push(rel);
}
members.sort();
compliant.sort();
offenders.sort();

console.log(
  `• census: ${members.length} suite file(s) read the ambient environment in their own process ` +
    `(${compliant.length} scrub first, ${exempted.length} reviewed-safe, ${offenders.length} unguarded)`,
);
for (const f of compliant) console.log(`  ✓ ${f} - scrubs COTAL_ at module scope before the read`);
for (const f of exempted) console.log(`  · ${f} - reviewed safe: ${REVIEWED[f]}`);

// A census that found nothing is not a pass. Reading the ambient environment is a normal thing for
// a connector suite to do, so a zero here means the scan stopped seeing files rather than the tree
// getting clean.
check("at least one file is in this class, so this guard is grading a non-empty set", members.length > 0, {
  members,
});

// Every per-file cell below is GENERATED from the census, so a census that narrows does not fail
// cells, it stops emitting them - and a suite with fewer cells still exits 0. The class already
// spans several connector packages, so a scan that can only see one is the failure this cell
// catches, not an incidental property.
{
  const packages = new Set(members.map((f) => f.split("/").slice(0, 2).join("/")));
  check(
    "the census spans more than one package directory, so it is keyed on content and not on one connector",
    packages.size > 1,
    { packages: [...packages] },
  );
}

// An exemption must correspond to a file that still exists and is still in the class; a stale entry
// is a waiver nobody is checking.
for (const path of Object.keys(REVIEWED))
  check(
    `REVIEWED lists ${path}, and the census still finds an ambient read there`,
    members.includes(path),
    { members },
  );

// ── the rule itself, per real file ──
for (const f of members) {
  if (f in REVIEWED) continue;
  const verdict = evaluate(readFileSync(join(repoRoot, f), "utf8"), f);
  check(`${f} scrubs COTAL_ from its own process.env at module scope`, verdict.scrubs);
  check(`${f} scrubs before its first ambient read`, verdict.ordered, { readLines: verdict.readLines });
}

check(
  "no suite reads the ambient environment unguarded",
  offenders.length === 0,
  {
    offenders,
    remedy:
      "scrub the COTAL_ prefix from process.env at module scope before the read, or add the file to REVIEWED with the measured reason its own process cannot be handed an identity it did not choose",
  },
);

console.log(
  `\nSUITE-AMBIENT-ENV-SELF SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
