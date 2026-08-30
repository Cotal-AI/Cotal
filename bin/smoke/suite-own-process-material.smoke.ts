/**
 * Own-process launch-material census.
 *
 * `smoke:suite-ambient-env` grades SPREADS into children. This grades the suite's OWN
 * process, which that census does not police. A file that defaults `COTAL_SERVERS` and
 * then calls `configFromEnv()` on `process.env` manufactures the two-carrier launch the
 * connector refuses, whenever the runner is a managed seat that exported
 * `COTAL_LAUNCH_MATERIAL`. Issue #995: hermes tool-parity, reached by `pnpm test`.
 *
 * THE RULE. Every such file must drop the `COTAL_LAUNCH_MATERIAL` POINTER from
 * `process.env` before the `configFromEnv()` call. Pointer only. Unlinking the file is
 * wrong: the session that launched this process may still need it.
 *
 * A file that defaults the broker but hands `configFromEnv` an explicit object is not in
 * this class: that call does not read the ambient pair.
 *
 * Run: `pnpm smoke:suite-own-process-material`
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = new Set(["node_modules", "dist", ".git", ".pnpm-store", "coverage", "reserved"]);

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.(ts|mts|cts|mjs|js)$/.test(e.name) && statSync(p).size < 2_000_000) yield p;
  }
}

const VAR = String.raw`process\.env(?:\.COTAL_SERVERS|\[["']COTAL_SERVERS["']\])`;
const DEFAULTS = new RegExp(String.raw`${VAR}\s*(?:\|\||\?\?)=`);
/** `configFromEnv()` or `configFromEnv(process.env)`. An explicit object is a different call. */
const CALLS = /configFromEnv\s*\(\s*(?:process\.env\b)?\s*\)/;
/** A real statement, not a mention in a comment. */
const SCRUB =
  /^[ \t]*delete\s+process\.env(?:\.COTAL_LAUNCH_MATERIAL|\[["']COTAL_LAUNCH_MATERIAL["']\]|\s*\[\s*LAUNCH_MATERIAL_ENV\s*\])/m;

const self = relative(repoRoot, fileURLToPath(import.meta.url));

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

function evaluate(text: string): { applicable: boolean; scrubs: boolean; ordered: boolean } {
  const applicable = DEFAULTS.test(text) && CALLS.test(text);
  if (!applicable) return { applicable: false, scrubs: false, ordered: false };
  const scrub = text.search(SCRUB);
  const call = text.search(CALLS);
  return { applicable: true, scrubs: scrub !== -1, ordered: scrub !== -1 && scrub < call };
}

const offenders: string[] = [];
const excludedPaths: string[] = [];
for (const file of sources(repoRoot)) {
  const text = readFileSync(file, "utf8");
  const rel = relative(repoRoot, file).split("\\").join("/");
  if (rel === self.split("\\").join("/")) {
    excludedPaths.push(rel);
    continue;
  }
  if (evaluate(text).applicable) offenders.push(rel);
}
offenders.sort();

console.log(
  `• ${offenders.length} file(s) default COTAL_SERVERS and call configFromEnv() on process.env`,
);
for (const f of offenders) console.log(`    ${f}`);

check(
  "at least one file is in this class, so this guard is grading a non-empty set",
  offenders.length > 0,
  { offenders },
);

check(
  "exactly one file is excluded from the census, and it is this file's own fixtures",
  excludedPaths.length === 1 && excludedPaths[0]!.endsWith("bin/smoke/suite-own-process-material.smoke.ts"),
  { excludedPaths, self },
);

{
  // Today every member lives under extensions/, so a top-level-directory span is
  // vacuous. The miss this cell is for is "only hermes tool-parity, the reported
  // file" — scoping the walk to one package would still exit 0 if every per-file
  // cell is generated from the census.
  const pkgs = new Set(offenders.map((f) => f.split("/").slice(0, 2).join("/")));
  check(
    "the census spans more than one package directory, so it is keyed on content and not on one connector",
    pkgs.size > 1,
    { pkgs: [...pkgs] },
  );
}

{
  // Assembled so this file's source does not itself match the broker-disclosure
  // census of files that default the servers variable with an or-equal. A census
  // keyed on TEXT cannot tell a call site from a fixture; broker-disclosure
  // already excludes its own file for that reason. Building the operator at
  // runtime keeps this file out of that census without adding a second carve-out.
  const assign = `process.env.COTAL_SERVERS ${"|" + "|="} "nats://127.0.0.1:4222";\n`;
  const bracket = `process.env["COTAL_SERVERS"] ${"?" + "?="} "nats://127.0.0.1:4222";\n`;
  const GOOD =
    "delete process.env.COTAL_LAUNCH_MATERIAL;\n" +
    assign +
    "const config = configFromEnv();\n";
  const LATE =
    assign +
    "const config = configFromEnv();\n" +
    "delete process.env.COTAL_LAUNCH_MATERIAL;\n";
  const MISSING = assign + "const config = configFromEnv();\n";
  const OBJECT = assign + 'const config = configFromEnv({ COTAL_NAME: "parity-smoke" });\n';
  const COMMENTED = "// delete process.env.COTAL_LAUNCH_MATERIAL;\n" + assign + "const config = configFromEnv();\n";
  const BRACKET =
    'delete process.env["COTAL_LAUNCH_MATERIAL"];\n' +
    bracket +
    "const config = configFromEnv(process.env);\n";
  check("fixture: a compliant file passes both requirements", evaluate(GOOD).scrubs && evaluate(GOOD).ordered);
  check("fixture: a file that drops the pointer AFTER configFromEnv is rejected on order", !evaluate(LATE).ordered);
  check("fixture: a file that never drops the pointer is rejected", !evaluate(MISSING).scrubs);
  check(
    "fixture: a file that defaults the broker but hands configFromEnv an explicit object is not in this class",
    !evaluate(OBJECT).applicable,
  );
  check("fixture: a commented-out drop is rejected", !evaluate(COMMENTED).scrubs);
  check(
    "fixture: the same drop under bracket access is SEEN, so it can be judged at all",
    evaluate(BRACKET).applicable && evaluate(BRACKET).scrubs && evaluate(BRACKET).ordered,
  );
}

for (const f of offenders) {
  const { scrubs, ordered } = evaluate(readFileSync(join(repoRoot, f), "utf8"));
  check(`${f} drops COTAL_LAUNCH_MATERIAL from process.env`, scrubs);
  check(`${f} drops the pointer before configFromEnv() reads the pair`, ordered);
}

console.log(
  `\nOWN-PROCESS-MATERIAL SMOKE ${fail === 0 ? "OK" : "FAILED"}  (${pass} passed, ${fail} failed)`,
);
process.exit(fail === 0 ? 0 : 1);
