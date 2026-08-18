/**
 * REQUIRED-ARGUMENT SEAM completeness (Cotal #550): every call site of a seam that THROWS when an
 * argument is missing must actually pass it, checked statically over sources the compiler does not
 * read.
 *
 * WHY A RUNTIME THROW IS NOT ENOUGH, in the words of the one seam that has this shape today:
 * `standaloneConnectOpts` refuses to build connect options without an explicit `tls` boolean, and
 * its own comment records the limit, that smoke files sit outside the tsconfigs so a large minority
 * of its call sites are never typechecked. The throw is the correct response to that. But a guard
 * whose only reader is a suite, is heard only when the suite runs, and the failure it produces does
 * not look like a missing argument: it stops the suite where it fires, so an author sees a run that
 * ends after N cells. A suite that gets SHORTER reads as a shorter suite, not a broken one. That is
 * how a real occurrence of this went unheard: `user-spawn` threw at its section B1e and lost roughly
 * fifty cells, and nothing said so.
 *
 * So the reader here is static and gated: a new call site missing the argument is red in the run
 * that adds it, whatever suite it belongs to and whether or not that suite is ever executed.
 *
 * SEAMS is a table because the class is "a runtime-required argument whose callers are only partly
 * typechecked", not one function. It has one row today because one seam in this repo has that
 * shape. Adding the next one is a line.
 *
 * WHAT THIS DOES NOT CATCH, so nobody mistakes it for more than it is: it checks that the argument
 * is PASSED, never that its value is right. `tls: false` against a TLS broker is a wrong value and
 * this check is blind to it, by design, because the seam it guards demands a decision rather than a
 * particular decision.
 *
 * Run: pnpm smoke:required-arg-seam
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/** One seam: a function whose first argument object must carry `key`, enforced at runtime by a
 *  throw, and therefore needing a static reader for the call sites the compiler never sees.
 *  `floor` is the number of direct call sites this check must still find; see the floor cell for
 *  why a count is part of the instrument rather than trivia. */
type Seam = { fn: string; key: string; floor: number };
const SEAMS: Seam[] = [
  { fn: "standaloneConnectOpts", key: "tls", floor: 80 },
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".internal", "build", "coverage", ".next", "out"]);
const EXTS = [".ts", ".mts", ".cts", ".mjs", ".cjs", ".js"];

function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      sources(p, acc);
    } else if (EXTS.some((x) => e.name.endsWith(x))) acc.push(p);
  }
  return acc;
}

/**
 * Blank out comments and string/template bodies, preserving length and newlines so every offset in
 * the result still indexes the original file. Everything below scans the blanked copy, so a mention
 * of a seam inside a doc comment or a string is not a call site, and a brace inside a string cannot
 * throw off the depth counting.
 *
 * This is a lexer, not a parser. It does not evaluate template substitutions, so a `${...}` inside a
 * template literal is blanked along with the rest of the template. No call site in this repo lives
 * inside a template substitution; if one ever does, this check will simply not see it, which is the
 * one direction of error a floor cell exists to catch.
 */
function blankNonCode(src: string): string {
  const out = src.split("");
  let i = 0;
  const blankTo = (end: number): void => {
    for (let k = i; k < end && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
    i = end;
  };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { let e = src.indexOf("\n", i); if (e === -1) e = src.length; blankTo(e); continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); blankTo(e === -1 ? src.length : e + 2); continue; }
    if (c === '"' || c === "'" || c === "`") {
      let k = i + 1;
      while (k < src.length) {
        if (src[k] === "\\") { k += 2; continue; }
        if (src[k] === c) { k++; break; }
        k++;
      }
      blankTo(k);
      continue;
    }
    i++;
  }
  return out.join("");
}

/** The balanced argument text of a call whose `(` is at `open`, or undefined if it never closes. */
function argsOf(code: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return undefined;
}

type Site = { file: string; line: number; verdict: "has-key" | "missing-key" | "unverifiable"; args: string };

/** Every call of `fn` in `code`, classified. The DEFINITION is not a call and is excluded by the
 *  `function`/`const` keyword that precedes it. */
function sitesIn(file: string, raw: string, seam: Seam): Site[] {
  const code = blankNonCode(raw);
  const found: Site[] = [];
  const re = new RegExp(`\\b${seam.fn}\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const before = code.slice(Math.max(0, m.index - 40), m.index);
    if (/\b(function|const|let|var|declare)\s+$/.test(before)) continue; // the definition, not a call
    const open = m.index + m[0].length - 1;
    const args = argsOf(code, open);
    const line = code.slice(0, m.index).split("\n").length;
    if (args === undefined) { found.push({ file, line, verdict: "unverifiable", args: "" }); continue; }
    found.push({ file, line, verdict: keyVerdict(args, seam.key), args: args.trim() });
  }
  return found;
}

/**
 * Does every object this argument list can pass state `key` at its own TOP LEVEL?
 *
 * The argument is not always one literal. A real call site in this repo picks between three objects
 * with nested ternaries, and each of them is an argument the seam may receive, so the question is
 * asked of every branch rather than of the text as a whole. A check that only looked at the first
 * `{` would have called that site unverifiable and pushed a true statement onto an allowlist.
 *
 * Depth matters within a branch: `{ opts: { tls: false } }` states nothing about the seam's own
 * argument, and a check that only asked whether the text contains "tls:" would call it a pass. A
 * branch assembled elsewhere (an identifier, a call, a spread) cannot be decided from one file and
 * is reported as `unverifiable` rather than assumed either way.
 */
function keyVerdict(args: string, key: string): Site["verdict"] {
  const branches = topLevelObjects(args.trim());
  if (branches.length === 0) return "unverifiable";
  let unverifiable = false;
  for (const b of branches) {
    if (statesKey(b, key)) continue;
    if (topLevelSpread(b)) { unverifiable = true; continue; }
    return "missing-key"; // one branch that provably omits it is enough
  }
  return unverifiable ? "unverifiable" : "has-key";
}

/** Every `{...}` group that sits at the argument list's own depth: the objects this call can pass. */
function topLevelObjects(t: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "{") { if (depth === 0) start = i; depth++; continue; }
    if (c === "[" || c === "(") { depth++; continue; }
    if (c === "}") { depth--; if (depth === 0 && start >= 0) { out.push(t.slice(start, i + 1)); start = -1; } continue; }
    if (c === "]" || c === ")") { depth--; continue; }
  }
  return out;
}

/** `key:` as a property of THIS object literal, not of something nested inside it. */
function statesKey(obj: string, key: string): boolean {
  const keyRe = new RegExp(`^${key}\\s*:`);
  let depth = 0;
  for (let i = 0; i < obj.length; i++) {
    const c = obj[i];
    if (c === "{" || c === "[" || c === "(") { depth++; continue; }
    if (c === "}" || c === "]" || c === ")") { depth--; continue; }
    if (depth === 1 && keyRe.test(obj.slice(i)) && !/[A-Za-z0-9_$.]/.test(obj[i - 1] ?? "")) return true;
  }
  return false;
}

function topLevelSpread(t: string): boolean {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "{" || c === "[" || c === "(") { depth++; continue; }
    if (c === "}" || c === "]" || c === ")") { depth--; continue; }
    if (depth === 1 && t.startsWith("...", i)) return true;
  }
  return false;
}

console.log("A. the scanner itself, on fixtures whose verdicts are known");
{
  // POSITIVE CONTROLS FIRST. A scanner that matches nothing passes every completeness assertion
  // below in silence, so it is graded on inputs whose answers are stated here before it runs.
  const fx = (body: string): Site[] => sitesIn("fixture.ts", body, SEAMS[0]);
  check("a call that states the key is accepted",
    fx(`standaloneConnectOpts({ creds: c, tls: false })`)[0]?.verdict === "has-key");
  check("a call that OMITS the key is flagged (the defect this check exists for)",
    fx(`standaloneConnectOpts({ creds: c })`)[0]?.verdict === "missing-key");
  check("the key on a LATER LINE is still accepted (a line-oriented grep would miss this, and the seam's callers are free to wrap)",
    fx(`standaloneConnectOpts({\n  creds: c,\n  tls: true,\n})`)[0]?.verdict === "has-key");
  check("the key NESTED in a sub-object does not count (it says nothing about the seam's own argument)",
    fx(`standaloneConnectOpts({ opts: { tls: false } })`)[0]?.verdict === "missing-key");
  check("a key-like suffix of another identifier does not count (`notls:` is not `tls:`)",
    fx(`standaloneConnectOpts({ notls: false })`)[0]?.verdict === "missing-key");
  check("an argument built elsewhere is UNVERIFIABLE, never silently passed",
    fx(`standaloneConnectOpts(buildAuth())`)[0]?.verdict === "unverifiable");
  check("a top-level spread is UNVERIFIABLE, because the key may live in what is spread",
    fx(`standaloneConnectOpts({ ...base })`)[0]?.verdict === "unverifiable");
  // A live call site picks between three objects with nested ternaries, so the question is asked of
  // every branch. Both halves matter: the accept, and the refusal when one branch omits it.
  check("a TERNARY whose every branch states the key is accepted",
    fx(`standaloneConnectOpts(a ? { creds: c, tls: true } : b ? { bearer: t, tls: false } : { tls: false })`)[0]?.verdict === "has-key");
  check("a ternary with the key on only ONE branch is flagged (the other branch is a real argument too)",
    fx(`standaloneConnectOpts(a ? { creds: c, tls: true } : { creds: d })`)[0]?.verdict === "missing-key");
  check("a mention inside a COMMENT is not a call site",
    fx(`// standaloneConnectOpts({ creds: c })\nconst x = 1;`).length === 0);
  check("a mention inside a STRING is not a call site",
    fx('const s = "standaloneConnectOpts({ creds: c })";').length === 0);
  check("a brace inside a string cannot throw off the depth counting",
    fx(`standaloneConnectOpts({ creds: "}{", tls: false })`)[0]?.verdict === "has-key");
  check("the DEFINITION is not counted as a call site",
    fx(`export function standaloneConnectOpts(auth: StandaloneAuth) { return {}; }`).length === 0);
}

console.log("B. the seam, across every source the compiler may or may not read");
const files = sources(ROOT);
check("the scan reached a source tree at all (a zero-file walk would pass every cell below)", files.length > 500, files.length);

for (const seam of SEAMS) {
  const sites = files.flatMap((f) => sitesIn(relative(ROOT, f), readFileSync(f, "utf8"), seam));
  const bad = sites.filter((s) => s.verdict !== "has-key");
  check(`\`${seam.fn}\`: every call site states \`${seam.key}\``, bad.length === 0,
    bad.map((s) => `${s.file}:${s.line} [${s.verdict}] ${s.args.slice(0, 120)}`));

  // THE FLOOR. Without it this check degrades into a green that means nothing: a rename, a
  // re-export, a wrapper, or a lexer that stops matching all produce "no bad sites" out of "no
  // sites at all". The number is the instrument reporting its own reach, and it is supposed to
  // move only when someone changes it on purpose.
  check(`\`${seam.fn}\`: the scan still FINDS its call sites (>= ${seam.floor}; raise this floor when the count grows)`,
    sites.length >= seam.floor, { found: sites.length, floor: seam.floor });

  // The half the compiler cannot see is the whole reason this file exists. If the walk ever stops
  // reaching smoke sources, the check would be re-proving what tsc already proves.
  const untypechecked = sites.filter((s) => s.file.includes(`${sep}smoke${sep}`) || s.file.includes("/smoke/"));
  check(`\`${seam.fn}\`: the scan reaches the UNTYPECHECKED half (call sites under smoke/, which no tsconfig includes)`,
    untypechecked.length > 0, untypechecked.length);
}

console.log(`\n${fail === 0 ? "REQUIRED-ARG SEAM SMOKE OK ✅" : "REQUIRED-ARG SEAM SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
