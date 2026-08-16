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

/** The variable, written either way people write it. Dot access is what the tree uses today and a
 *  bracket read is the same assignment, so a census that knew only the first would MISS a file
 *  silently: it would never enter the census, and every per-file cell is generated from the census.
 *  `??=` is admitted for the same reason. A shape this does not know fails the safe direction only
 *  if it is still SEEN, and the shapes it cannot see are the ones worth widening for. */
const VAR = String.raw`process\.env(?:\.COTAL_SERVERS|\[["']COTAL_SERVERS["']\])`;
const DEFAULTS = new RegExp(String.raw`${VAR}\s*(?:\|\||\?\?)=`);
const CAPTURES = new RegExp(String.raw`${VAR}\s*!==?\s*(?:undefined|null)`);
/**
 * The disclosure line, and it requires the INTERPOLATION rather than the name.
 *
 * The earlier pattern asked only that the name appear on the line, and a guard that asserts a NAME
 * where the behaviour depends on a VALUE is one character from present-and-inert. Deleting the `$`
 * from `${process.env.COTAL_SERVERS}` left every cell green and printed the literal text
 * `{process.env.COTAL_SERVERS}` at runtime, which is the disclosure saying nothing at all. So did a
 * line that hardcoded the address and mentioned the variable in a trailing comment. Both are
 * reproduced as fixtures below rather than argued about here.
 *
 * SINGLE LINE, on purpose and stated so it is a rule rather than an accident: a disclosure wrapped
 * across lines by a formatter will not match and its file will go RED. That is the loud direction,
 * and the fix is to keep the line whole.
 *
 * THE INTERPOLATION MUST BE WHAT FOLLOWS `broker:`, not merely something later on the line. Review
 * found the next member of the family once the first was closed: park the interpolation in a
 * TRAILING COMMENT, hardcode the address in the template, and a pattern that accepted `${…}`
 * anywhere after `broker:` was satisfied by a line that printed a literal every run. That is the
 * plausible careless edit in this family, because it is what somebody leaves behind after pinning
 * an address to debug something.
 *
 * AND THE STRING MUST BE A TEMPLATE, which is the same requirement one level down. `${…}` inside a
 * quoted string is not an interpolation, it is six characters of text: a line reading
 * `console.log("• broker: ${process.env.COTAL_SERVERS}")` prints that literally on every run with
 * the real address sitting in the environment, unread. Ran both forms with the variable set to
 * confirm it rather than reasoning about it. This is the plausible careless edit, not sabotage:
 * somebody converts ticks to quotes, or rewrites toward concatenation and leaves a `${}` behind
 * inside the quotes. So the pattern requires the opening backtick.
 *
 * WHAT READING SOURCE CANNOT DO, named rather than implied, because a boundary nobody wrote down
 * gets mistaken for coverage. This checks that the line is SHAPED like a disclosure. It cannot
 * follow evaluation, so ONE line that builds the value and then discards it stays accepted: a
 * disclosing template with a `.replace` chained onto it that overwrites the whole string. That is
 * deliberate sabotage rather than a careless edit, and closing it means executing repository source
 * inside a guard, which buys less than it costs. Measured and left open, not overlooked.
 *
 * The comma-expression form, which evaluates the disclosing template and hands `console.log`
 * something else, USED to be the second one. Requiring the backtick immediately after the `(` closed
 * it as a side effect, since the comma form opens with a parenthesis. It is recorded here rather
 * than quietly enjoyed: a boundary that has moved and still reads as open is the same misreading as
 * one nobody wrote down. It fails in the loud direction and stays closed.
 */
const PRINTS = new RegExp(String.raw`console\.log\(\`[^\n\`]*broker:\s*\$\{\s*${VAR}\s*\}`);

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, extra?: unknown): void => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

// THIS FILE, and only this file, is left out of its own census. A census keyed on TEXT cannot tell
// a call site from a fixture, and the one file guaranteed to contain fixtures is the one that
// carries them. Without this it reported eight files defaulting the variable when seven do, and
// graded its own negative controls as if they were real suites. The exclusion is computed from
// `import.meta.url` rather than written as a path, so it can only ever name this file: a carve-out
// that could grow is the shape that later hides something, and this one cannot grow.
const self = relative(repoRoot, fileURLToPath(import.meta.url));

const defaulters: string[] = [];
const excludedPaths: string[] = [];
for (const file of sources(repoRoot)) {
  const text = readFileSync(file, "utf8");
  if (!DEFAULTS.test(text)) continue;
  const rel = relative(repoRoot, file);
  if (rel === self) { excludedPaths.push(rel); continue; }
  defaulters.push(rel);
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

// 1b — and the exclusion is exactly this file, still matching. If the fixtures below ever stop
// carrying the pattern the exclusion has quietly become dead, which is the same shape as an
// allowlist entry nobody notices has stopped matching anything.
// The path is named as a LITERAL and not re-derived from `self`, which would make the cell a
// tautology. Cardinality alone leaves the carve-out free to point somewhere else: rewriting `self`
// to a real suite keeps the count at one, keeps the census size unchanged, and silently stops
// grading that suite while this file walks in through its own compliant fixture.
check(
  "exactly one file is excluded from the census, and it is this file's own fixtures",
  excludedPaths.length === 1 && excludedPaths[0]!.endsWith("bin/smoke/broker-disclosure.smoke.ts"),
  { excludedPaths, self },
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
  // The NAME is present in all three of these and the VALUE is not, which is the whole family. A
  // guard that asks only whether `process.env.COTAL_SERVERS` appears on the line is one character
  // from present-and-inert, and the first of these is that one character: `${…}` with the `$`
  // deleted prints the literal text `{process.env.COTAL_SERVERS}` and every cell stays green.
  const DOLLARLESS = 'const brokerFromEnv = process.env.COTAL_SERVERS !== undefined;\n'
    + 'process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";\n'
    + 'console.log(`• broker: {process.env.COTAL_SERVERS} (${brokerFromEnv ? "INHERITED" : "default"})`);\n';
  const HARDCODED = 'const brokerFromEnv = process.env.COTAL_SERVERS !== undefined;\n'
    + 'process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";\n'
    + 'console.log(`• broker: nats://127.0.0.1:4222`); // was process.env.COTAL_SERVERS\n'
    + 'void brokerFromEnv;\n';
  // The next member of the family, found by review once the first was closed: the interpolation is
  // present and correct and is INSIDE A COMMENT, while the template prints a literal. A pattern that
  // took `${…}` anywhere after `broker:` accepted it, which is why the interpolation now has to be
  // the thing that FOLLOWS `broker:` rather than merely something later on the line.
  const COMMENTED_INTERP = 'const brokerFromEnv = process.env.COTAL_SERVERS !== undefined;\n'
    + 'process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";\n'
    + 'console.log(`• broker: nats://127.0.0.1:4222`); // ${process.env.COTAL_SERVERS}\n'
    + 'void brokerFromEnv;\n';
  // Same family, one level down: the interpolation is exactly where it belongs and the string is
  // QUOTED, so JS never interpolates it and the line prints `${process.env.COTAL_SERVERS}` as text.
  // Ran it with the variable set before writing this. Careless rather than sabotage: it is what a
  // tick-to-quote conversion leaves behind.
  const QUOTED = 'const brokerFromEnv = process.env.COTAL_SERVERS !== undefined;\n'
    + 'process.env.COTAL_SERVERS ||= "nats://127.0.0.1:4222";\n'
    + 'console.log("• broker: ${process.env.COTAL_SERVERS} (x)");\nvoid brokerFromEnv;\n';
  // The census direction. A file this cannot SEE is not rejected, it is absent, and every per-file
  // cell is generated from the census -- so a shape it does not know costs cells rather than reds.
  const BRACKET = 'const brokerFromEnv = process.env["COTAL_SERVERS"] !== undefined;\n'
    + 'process.env["COTAL_SERVERS"] ??= "nats://127.0.0.1:4222";\n'
    + 'console.log(`• broker: ${process.env["COTAL_SERVERS"]} (${brokerFromEnv ? "INHERITED" : "default"})`);\n';
  check("fixture: a compliant file passes both requirements", evaluate(GOOD).prints && evaluate(GOOD).ordered);
  check("fixture: a file that captures AFTER the `||=` is rejected on order", !evaluate(SWAPPED).ordered);
  check("fixture: a file that never prints the broker is rejected on disclosure", !evaluate(MUTE).prints);
  check("fixture: a line carrying the NAME without the interpolation is rejected: `${` is the value",
    !evaluate(DOLLARLESS).prints);
  check("fixture: a hardcoded address with the variable in a trailing comment is rejected",
    !evaluate(HARDCODED).prints);
  check("fixture: the INTERPOLATION parked in a trailing comment is rejected too",
    !evaluate(COMMENTED_INTERP).prints);
  check("fixture: the interpolation inside a QUOTED string is rejected: it prints as text, not a value",
    !evaluate(QUOTED).prints);
  check("fixture: the same assignment under bracket access is SEEN, so it can be judged at all",
    DEFAULTS.test(BRACKET) && evaluate(BRACKET).prints && evaluate(BRACKET).ordered);
}

// 4 — the disclosure itself, per real file.
for (const f of defaulters) {
  const { prints, ordered } = evaluate(readFileSync(join(repoRoot, f), "utf8"));
  check(`${f} prints the broker it resolved`, prints);
  check(`${f} records whether the value was inherited, before \`||=\` overwrites the evidence`, ordered);
}

console.log(`\nBROKER-DISCLOSURE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
