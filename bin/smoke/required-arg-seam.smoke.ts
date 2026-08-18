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
 * TWO DIRECTIONS OF ERROR, and they are not equally bad. Blessing a site that lacks the argument is
 * severe: the check then reads as coverage and is not. Failing to SEE a site is caught by the floor
 * cells, which is why a count is part of the instrument rather than trivia.
 *
 * WHAT THIS DOES NOT CATCH, so nobody mistakes it for more than it is: it checks that the argument
 * is PASSED, never that its value is right. `tls: false` against a TLS broker is a wrong value and
 * this check is blind to it, by design, because the seam it guards demands a decision rather than a
 * particular decision. It also cannot see through an alias (`const f = seam; f({...})`) or a
 * wrapper; those change the call's NAME, so they present as the seam losing call sites and land on
 * the floor cells rather than here.
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

/** One seam: a function whose argument object must carry `key`, enforced at runtime by a throw, and
 *  therefore needing a static reader for the call sites the compiler never sees. The two floors are
 *  the counts measured when this was last edited; see the floor cells for why they are here. */
type Seam = { fn: string; key: string; floor: number; untypecheckedFloor: number };
const SEAMS: Seam[] = [
  { fn: "standaloneConnectOpts", key: "tls", floor: 93, untypecheckedFloor: 66 },
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".internal", "build", "coverage", ".next", "out"]);
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"];

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
 * Blank out comments, string/template bodies and regex literals, preserving length and newlines so
 * every offset in the result still indexes the original file. Everything below scans the blanked
 * copy, so a mention of a seam inside a doc comment or a string is not a call site, and a brace or
 * a quote inside one cannot throw off the depth counting.
 *
 * REGEX LITERALS ARE LEXED, not ignored, for a measured reason rather than tidiness. Without it,
 * `/https?:\/\//` reads as a line comment and hides the call that follows it, and a regex containing
 * a quote (`/['"]/`, an ordinary idiom) opens a phantom string that closes on the next apostrophe in
 * the file and can blank everything after it, swallowing every later call site. `/` is disambiguated
 * from division the standard way, by the last significant character: after a value it divides,
 * otherwise it opens a regex.
 *
 * This is a lexer, not a parser. It does not evaluate template substitutions, so a `${...}` inside a
 * template literal is blanked with the rest of the template. No call site in this repo lives inside
 * one; if one ever does, this check will not see it, which is the direction the floor cells cover.
 */
function blankNonCode(src: string): string {
  const out = src.split("");
  let i = 0;
  let lastSig = "";
  const blankTo = (end: number): void => {
    for (let k = i; k < end && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
    i = end;
  };
  /** After these a `/` opens a regex; after a value (identifier, literal, closing bracket) it divides. */
  const regexAllowed = (): boolean => lastSig === "" || "(,=:[!&|?{};+-*%~^<>".includes(lastSig);
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { let e = src.indexOf("\n", i); if (e === -1) e = src.length; blankTo(e); continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); blankTo(e === -1 ? src.length : e + 2); continue; }
    if (c === "/" && regexAllowed()) {
      let k = i + 1, inClass = false, closed = false;
      while (k < src.length) {
        const ch = src[k];
        if (ch === "\\") { k += 2; continue; }
        if (ch === "\n") break; // an unterminated regex is not a regex
        if (ch === "[") { inClass = true; k++; continue; }
        if (ch === "]") { inClass = false; k++; continue; }
        if (ch === "/" && !inClass) { k++; closed = true; break; }
        k++;
      }
      if (closed) {
        while (k < src.length && /[dgimsuvy]/.test(src[k])) k++;
        lastSig = "/";
        blankTo(k);
        continue;
      }
      // not a regex after all: fall through and treat it as an ordinary character
    }
    if (c === '"' || c === "'" || c === "`") {
      let k = i + 1;
      while (k < src.length) {
        if (src[k] === "\\") { k += 2; continue; }
        if (src[k] === c) { k++; break; }
        k++;
      }
      lastSig = c;
      blankTo(k);
      continue;
    }
    if (!/\s/.test(c)) lastSig = c;
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

/** Every call of `fn` in `code`, classified. A generic instantiation and an optional call are the
 *  same call and are matched too; the DEFINITION is not a call and is excluded by the keyword that
 *  precedes it. */
function sitesIn(file: string, raw: string, seam: Seam): Site[] {
  const code = blankNonCode(raw);
  const found: Site[] = [];
  const re = new RegExp(`\\b${seam.fn}\\s*(?:<[^<>()]*>\\s*)?(?:\\?\\.\\s*)?\\(`, "g");
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
 * Does every object this call can actually pass state `key` at its own top level?
 *
 * THE ALTERNATIVES ARE THE QUESTION, and getting this wrong is how the first cut of this file
 * blessed a throwing site. An argument is not always one literal: a live site here picks between
 * three objects with nested ternaries, and `opts || { tls: false }` picks between something built
 * elsewhere and a literal that states the key. Asking only the literals that are present answers
 * "has-key" for that second one while the seam throws at runtime, which is the severe direction of
 * error. So the argument is split at its own depth into the values it can evaluate to, the ternary
 * CONDITIONS are dropped because they are never passed, and every remaining alternative must be an
 * object literal that states the key. An alternative that is an identifier, a call, or a spread
 * cannot be decided from one file and makes the site `unverifiable`, never a pass.
 *
 * Depth matters within an alternative: `{ opts: { tls: false } }` states nothing about the seam's
 * own argument, and a check that only asked whether the text contains the key would call it a pass.
 */
function keyVerdict(args: string, key: string): Site["verdict"] {
  const alternatives = valueAlternatives(args.trim());
  if (alternatives.length === 0) return "unverifiable";
  let unverifiable = false;
  for (const a of alternatives) {
    const t = a.trim();
    if (!isObjectLiteral(t)) { unverifiable = true; continue; }
    if (statesKey(t, key)) continue;
    if (topLevelSpread(t)) { unverifiable = true; continue; }
    return "missing-key"; // an alternative that provably omits it is the severe answer, so it wins
  }
  return unverifiable ? "unverifiable" : "has-key";
}

/**
 * The values an argument expression can evaluate to, split at the argument's own depth.
 *
 * Handles the shapes that occur: `a ? X : Y` and nested chains of them, `X || Y`, `X ?? Y`, `X && Y`.
 * A segment immediately followed by `?` is a CONDITION and is dropped; everything else is a value
 * the seam could receive. `?.` is optional chaining rather than a ternary, and `??` is not `?`.
 */
function valueAlternatives(t: string): string[] {
  const segments: { text: string; op: string }[] = [];
  let depth = 0, start = 0;
  const push = (end: number, op: string, skip: number): number => {
    segments.push({ text: t.slice(start, end), op });
    start = end + skip;
    return start;
  };
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "{" || c === "[" || c === "(") { depth++; continue; }
    if (c === "}" || c === "]" || c === ")") { depth--; continue; }
    if (depth !== 0) continue;
    if (c === "?" && t[i + 1] === "?") { i = push(i, "??", 2) - 1; continue; }
    if (c === "?" && t[i + 1] === ".") continue; // optional chaining
    if (c === "?") { i = push(i, "?", 1) - 1; continue; }
    if (c === ":") { i = push(i, ":", 1) - 1; continue; }
    if ((c === "|" && t[i + 1] === "|") || (c === "&" && t[i + 1] === "&")) { i = push(i, c + c, 2) - 1; continue; }
  }
  segments.push({ text: t.slice(start), op: "" });
  return segments.filter((s) => s.op !== "?").map((s) => s.text).filter((s) => s.trim() !== "");
}

/** Is this alternative one balanced object literal, rather than an identifier or a call? */
function isObjectLiteral(t: string): boolean {
  if (!t.startsWith("{")) return false;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) return t.slice(i + 1).trim() === "";
    }
  }
  return false;
}

/** `key` as a property of THIS object literal, not of something nested inside it. Both spellings
 *  count: `key: value` and the shorthand `key`, which is idiomatic and passes the argument just as
 *  well, so flagging it would be a false red whose message says the opposite of the truth. */
function statesKey(obj: string, key: string): boolean {
  const keyRe = new RegExp(`^${key}\\s*(?::|,|\\}|$)`);
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
  check("SHORTHAND states the key as well as `tls: v` does, and must not be a false red",
    fx(`standaloneConnectOpts({ creds, tls })`)[0]?.verdict === "has-key");
  check("an argument built elsewhere is UNVERIFIABLE, never silently passed",
    fx(`standaloneConnectOpts(buildAuth())`)[0]?.verdict === "unverifiable");
  check("a top-level spread is UNVERIFIABLE, because the key may live in what is spread",
    fx(`standaloneConnectOpts({ ...base })`)[0]?.verdict === "unverifiable");
  // A live call site picks between three objects with nested ternaries, so the question is asked of
  // every alternative. The `||` and mixed-ternary cells below are the severe direction: the first
  // cut of this file answered has-key for them while the seam threw at runtime.
  check("a TERNARY whose every branch states the key is accepted",
    fx(`standaloneConnectOpts(a ? { creds: c, tls: true } : b ? { bearer: t, tls: false } : { tls: false })`)[0]?.verdict === "has-key");
  check("a ternary with the key on only ONE branch is flagged (the other branch is a real argument too)",
    fx(`standaloneConnectOpts(a ? { creds: c, tls: true } : { creds: d })`)[0]?.verdict === "missing-key");
  check("`opts || { tls: false }` is UNVERIFIABLE: the left alternative is a real argument and this file cannot see inside it",
    fx(`standaloneConnectOpts(opts || { tls: false })`)[0]?.verdict === "unverifiable");
  check("...and so are `opts ?? { tls: false }` and `a && { tls: false }`",
    fx(`standaloneConnectOpts(opts ?? { tls: false })`)[0]?.verdict === "unverifiable"
    && fx(`standaloneConnectOpts(a && { tls: false })`)[0]?.verdict === "unverifiable");
  check("a ternary mixing a keyed literal with a NON-literal branch is UNVERIFIABLE, not a pass",
    fx(`standaloneConnectOpts(a ? { tls: true } : base)`)[0]?.verdict === "unverifiable"
    && fx(`standaloneConnectOpts(a ? { tls: true } : buildAuth())`)[0]?.verdict === "unverifiable");
  check("a ternary CONDITION is not an argument, so an optional chain in one does not confuse the split",
    fx(`standaloneConnectOpts(a?.b ? { tls: true } : { tls: false })`)[0]?.verdict === "has-key");
  check("a mention inside a COMMENT is not a call site",
    fx(`// standaloneConnectOpts({ creds: c })\nconst x = 1;`).length === 0);
  check("a mention inside a STRING is not a call site",
    fx('const s = "standaloneConnectOpts({ creds: c })";').length === 0);
  check("a brace inside a string cannot throw off the depth counting",
    fx(`standaloneConnectOpts({ creds: "}{", tls: false })`)[0]?.verdict === "has-key");
  // Regex literals, both measured failure modes of the first cut: an escaped `//` inside one read as
  // a line comment and hid the call, and a quote inside one opened a phantom string that swallowed
  // everything after it.
  check("a regex containing `//` does not hide the call that follows it",
    fx(`const u = s.replace(/https?:\\/\\//, ""); standaloneConnectOpts({ creds: c })`)[0]?.verdict === "missing-key");
  check("a regex containing a QUOTE does not open a phantom string that swallows later call sites",
    fx(`const q = /['"]/; const s = "it's fine"; standaloneConnectOpts({ creds: c })`)[0]?.verdict === "missing-key");
  check("division is not mistaken for a regex (a value before `/` divides)",
    fx(`const r = a / b; standaloneConnectOpts({ creds: c, tls: false })`)[0]?.verdict === "has-key");
  check("a GENERIC instantiation and an OPTIONAL call are the same call and are seen",
    fx(`standaloneConnectOpts<Opts>({ creds: c })`)[0]?.verdict === "missing-key"
    && fx(`standaloneConnectOpts?.({ creds: c })`)[0]?.verdict === "missing-key");
  check("the DEFINITION is not counted as a call site",
    fx(`export function standaloneConnectOpts(auth: StandaloneAuth) { return {}; }`).length === 0);
}

console.log("B. the seam, across every source the compiler may or may not read");
const files = sources(ROOT);
check("the scan reached a source tree at all (a zero-file walk would pass every cell below)", files.length > 500, files.length);

for (const seam of SEAMS) {
  const sites = files.flatMap((f) => sitesIn(relative(ROOT, f), readFileSync(f, "utf8"), seam));
  const bad = sites.filter((s) => s.verdict !== "has-key");
  const untypechecked = sites.filter((s) => s.file.includes(`${sep}smoke${sep}`) || s.file.includes("/smoke/"));
  // Printed on SUCCESS as well as failure: a legitimate removal then shows the number to put back,
  // instead of sending the next author into this file to find out what the floor should become.
  console.log(`  · ${seam.fn}: ${sites.length} call sites (${untypechecked.length} under smoke/, ${sites.length - untypechecked.length} typechecked)`);
  check(`\`${seam.fn}\`: every call site states \`${seam.key}\``, bad.length === 0,
    bad.map((s) => `${s.file}:${s.line} [${s.verdict}] ${s.args.slice(0, 120)}`));

  // THE FLOORS. Without them this check degrades into a green that means nothing: a rename, a
  // wrapper, an alias, or a lexer that stops matching all produce "no bad sites" out of "no sites
  // at all". They are set to the counts measured when this file was last edited, so decay is red
  // and a deliberate removal is a one-line edit made on purpose.
  check(`\`${seam.fn}\`: the scan still FINDS its call sites (>= ${seam.floor}; if you removed some, lower this floor deliberately)`,
    sites.length >= seam.floor, { found: sites.length, floor: seam.floor });

  // Split from the total on purpose. The half the compiler cannot see is the whole reason this file
  // exists, and a bare "> 0" here would be satisfied by a single smoke site while the rest vanished.
  check(`\`${seam.fn}\`: the UNTYPECHECKED half is still reached (>= ${seam.untypecheckedFloor} call sites under smoke/, which no tsconfig includes)`,
    untypechecked.length >= seam.untypecheckedFloor, { found: untypechecked.length, floor: seam.untypecheckedFloor });
}

console.log(`\n${fail === 0 ? "REQUIRED-ARG SEAM SMOKE OK ✅" : "REQUIRED-ARG SEAM SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
