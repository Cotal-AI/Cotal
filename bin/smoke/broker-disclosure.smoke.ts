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

/** What the guard asks of one file. Extracted so it can be aimed at a fixture as well as at the
 *  repo: with every real file compliant, dropping a requirement here changes no real verdict, and
 *  a check nothing exercises is a check nobody can prove. */
function evaluate(text: string): { prints: boolean; ordered: boolean } {
  const capture = text.search(CAPTURES);
  const assign = text.search(DEFAULTS);
  // The inherited/defaulted distinction is the forensically useful half, and it is only knowable
  // BEFORE the `||=` runs — afterwards the variable is set either way, so a capture below the
  // assignment reads the value the suite just wrote and reports every run as inherited.
  return { prints: PRINTS.test(text), ordered: capture !== -1 && capture < assign };
}

// 2 — the census spans more than one top-level directory. Every cell below is generated per
// discovered file, so a census that narrows does not FAIL cells, it stops emitting them — and a
// suite with fewer cells still exits 0. The pattern living outside `extensions/` is the whole
// reason the first count of these files was wrong, so a census that cannot see outside one
// directory is the failure this cell is here to catch, not an incidental property.
{
  const tops = new Set(defaulters.map((f) => f.split("/")[0]));
  check(
    "the census spans more than one top-level directory, so it is keyed on content and not on location",
    tops.size > 1,
    { tops: [...tops] },
  );
}

// 3 — the checker rejects a file that discloses in the wrong ORDER. Aimed at a fixture rather than
// at the repo, because every real file is compliant: without a negative control, removing the
// ordering requirement would pass and the requirement would be unprovable.
{
  const GOOD = 'const brokerFromEnv = process.env.COTAL_SERVERS !== undefined;\n'
    + 'process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";\n'
    + 'console.log(`• broker: ${process.env.COTAL_SERVERS} (${brokerFromEnv ? "INHERITED" : "default"})`);\n';
  const SWAPPED = 'process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";\n'
    + 'const brokerFromEnv = process.env.COTAL_SERVERS !== undefined;\n'
    + 'console.log(`• broker: ${process.env.COTAL_SERVERS} (${brokerFromEnv ? "INHERITED" : "default"})`);\n';
  const MUTE = 'const brokerFromEnv = process.env.COTAL_SERVERS !== undefined;\n'
    + 'process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";\nvoid brokerFromEnv;\n';
  check("fixture: a compliant file passes both requirements", evaluate(GOOD).prints && evaluate(GOOD).ordered);
  check("fixture: a file that captures AFTER the `||=` is rejected on order", !evaluate(SWAPPED).ordered);
  check("fixture: a file that never prints the broker is rejected on disclosure", !evaluate(MUTE).prints);
}

// 4 — the disclosure itself, per real file.
for (const f of defaulters) {
  const { prints, ordered } = evaluate(readFileSync(join(repoRoot, f), "utf8"));
  check(`${f} prints the broker it resolved`, prints);
  check(`${f} records whether the value was inherited, before \`||=\` overwrites the evidence`, ordered);
}

console.log(`\nBROKER-DISCLOSURE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
