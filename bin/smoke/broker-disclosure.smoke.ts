/**
 * Smoke for the ambient-broker disclosure — pure (no broker, no network, no spawning).
 *
 * A handful of suites default `COTAL_SERVERS` with `||=`, which KEEPS an already-set value. That
 * makes them loopback only where nothing exported the variable; in an agent's or an operator's
 * shell they resolve to whatever that shell holds. Each of them names what it resolved, so an
 * archived run can be audited after the fact.
 *
 * This grades the convention rather than any one suite: every file that sets the default must also
 * print it, and must capture whether it was inherited BEFORE the `||=` overwrites the evidence.
 * Without this, the disclosure is a habit, and a habit is one careless edit from gone — with
 * nothing red, which is the same failure the disclosure exists to prevent.
 *
 * Run: `pnpm smoke:broker-disclosure`
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = new Set(["node_modules", "dist", ".git", ".pnpm-store", "coverage", "reserved"]);

/** Every tracked source file, so the census is keyed on CONTENT and not on a directory. A sweep of
 *  `extensions/` misses `bin/smoke/launch-parity.smoke.ts`, which carries the same default. */
function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.(ts|mts|cts|mjs|js)$/.test(e.name) && statSync(p).size < 2_000_000) yield p;
  }
}

const DEFAULTS = /process\.env\.COTAL_SERVERS\s*\|\|=/;
const CAPTURES = /process\.env\.COTAL_SERVERS\s*!==\s*undefined/;
const PRINTS = /console\.log\([^\n]*broker:[^\n]*process\.env\.COTAL_SERVERS/;

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const defaulters: string[] = [];
for (const file of sources(repoRoot)) {
  const text = readFileSync(file, "utf8");
  if (DEFAULTS.test(text)) defaulters.push(relative(repoRoot, file));
}
defaulters.sort();

console.log(`• ${defaulters.length} file(s) default COTAL_SERVERS with \`||=\``);
for (const f of defaulters) console.log(`    ${f}`);

// 1 — the census is not empty. A guard over an empty set passes forever and grades nothing, which
// is the exact shape of an allowlist entry nobody notices has stopped matching anything.
check(
  "at least one file defaults COTAL_SERVERS, so this guard is grading a non-empty set",
  defaulters.length > 0,
  { defaulters },
);

// 2 — the disclosure itself, per file.
for (const f of defaulters) {
  const text = readFileSync(join(repoRoot, f), "utf8");
  check(`${f} prints the broker it resolved`, PRINTS.test(text));
  // The inherited/defaulted distinction is the forensically useful half, and it is only knowable
  // BEFORE the `||=` runs. Capturing it afterwards reads the value the suite just wrote.
  const capture = text.search(CAPTURES);
  const assign = text.search(DEFAULTS);
  check(
    `${f} records whether the value was inherited, before \`||=\` overwrites the evidence`,
    capture !== -1 && capture < assign,
    { captureAt: capture, assignAt: assign },
  );
}

console.log(`\nBROKER-DISCLOSURE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
