/**
 * REQUIRED-ARGUMENT SEAM (Cotal #550): every call site of a seam that THROWS when an argument is
 * missing must actually pass it, checked statically over sources the compiler does not read.
 *
 * "EVERY CALL SITE" MEANS EVERY ONE THIS READER CAN SEE, and what it can see is a decision recorded
 * in this file rather than a property of the repository. It reads the extensions in `EXTS`, plus the
 * executable part of each container language in `CONTAINERS`; it counts calls made through the
 * seam's own NAME, and turns every spelling that rebinds that name RED rather than following it, so
 * the bound fails loud instead of narrowing in silence. The population watches the seeing itself.
 * Read the paragraph headed THE ALIAS REFUSAL IS NOT A PROOF OF TOTAL CLOSURE as part of this
 * sentence rather than as a footnote to it.
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
 * IT READS THE REAL GRAMMAR, via the TypeScript parser, and that is a correctness requirement rather
 * than a convenience. The first two cuts of this file scanned text with a hand lexer and a call
 * regex, and both were defeated by ordinary code rather than by anything contrived. A regex literal
 * containing a quote opened a phantom string that blanked every later call site in the file, so the
 * lexer learned regexes; then the same hole reopened one keyword away, because `/` after `return` or
 * `typeof` looks like division to anything that decides by the last CHARACTER. The population cells
 * do not cover a file that was ALWAYS hidden: its sites were never counted, so the expected count
 * still passes. Chasing lexer holes one at a time is a losing shape when a parser that already knows
 * the grammar costs about seven hundred milliseconds over nine hundred files. Everything below asks
 * the syntax tree, so regex-versus-division, template substitutions, casts, generic instantiation,
 * optional calls and unicode escapes in identifiers are the parser's problem and not this file's.
 *
 * THE SEAM MUST BE CALLED BY ITS OWN NAME, and a rebinding is red rather than ignored. This reader
 * has no type checker, so it cannot follow `const f = seam` or `import { seam as f }` to the call
 * that uses `f`, and a call it cannot follow is a call it would silently bless. It therefore refuses
 * the rebinding itself, at the point the name escapes, which is one line for an author to see and
 * fail-closed for everyone else. The name counts as escaping whether it is spelled as an identifier
 * or as a string, because `const f = core["seam"]` reaches the same binding as `const f = seam` and
 * a rule about identifiers cannot see it. What stays legal is every form that binds the name this
 * reader already scans for: a same-name import, re-export or destructure, `import { default as
 * seam }`, and an object key, which names a slot rather than reading the seam (the READ of such a
 * table is caught, and a call through it is counted, so flagging the key would say something
 * untrue). Each of those has a cell, so the refusal cannot quietly become a false red on the live
 * idiom.
 *
 * SEAMS is a table because the class is "a runtime-required argument whose callers are only partly
 * typechecked", not one function. It has one row today because one seam in this repo has that
 * shape. Adding the next one is a line.
 *
 * TWO DIRECTIONS OF ERROR, and they are not equally bad. Blessing a site that lacks the argument is
 * severe: the check then reads as coverage and is not. Failing to SEE a site is caught by the count
 * cells, which is why a count is part of the instrument rather than trivia.
 *
 * WHAT THIS DOES NOT CATCH, so nobody mistakes it for more than it is: it checks that the argument
 * is PASSED, never that its value is right. `tls: false` against a TLS broker is a wrong value and
 * this check is blind to it, by design, because the seam it guards demands a decision rather than a
 * particular decision. The one value it does judge is an `undefined` written AT THE CALL, on any
 * branch, which is not a boolean and which the seam throws on, so stating the key that way counts as
 * omitting it. A value held in a VARIABLE is mostly not judged, and the one exception is a `const`
 * bound to `undefined`, which is that value written in two steps rather than a value this reader
 * cannot see. That exception now applies in BOTH spellings, `{ tls: t }` and shorthand `{ tls }`,
 * because shorthand reads a binding of the key's own name; review demonstrated the gap by rewriting
 * a real counted site into shorthand IN PLACE, leaving the counts and every cell green while the
 * call threw. Anything else in a variable is not judged and cannot be, since deciding what it holds
 * is symbol resolution. It also
 * cannot see through a WRAPPER: a function that takes an options object and passes it on is a call
 * site whose own argument is an identifier, which lands as `unverifiable` rather than as a pass.
 *
 * ONE KNOWN FALSE-RED CLASS is carried deliberately rather than fixed, and it is written here so it
 * is a decision rather than a surprise. Both sides of `||` and `??` are treated as real alternatives,
 * so `tls: (undefined as any) || false` is reported missing even though the expression can only ever
 * evaluate to `false`, and `tls: false ?? undefined` likewise. Pruning provably dead branches would
 * be sound and would only ever turn reds green, but it is arithmetic on operator semantics added to
 * a file that has already produced four false-red classes by adding cleverness late, so the residual
 * is stated instead. Neither spelling has an occupant here, and both are stiff enough that a person
 * writing `false` would write `false`.
 *
 * THE ALIAS REFUSAL IS NOT A PROOF OF TOTAL CLOSURE, and it should not be read as one. It refuses
 * every spelling that names the seam statically, as an identifier or as a string, in the positions
 * that can obtain it: a property read off a namespace or a table, a rename in a destructure whether
 * that destructure DECLARES or ASSIGNS, a quoted import or re-export rename, a shorthand capture,
 * and the name handed to a call as data. The key it reads may be assembled, because `"standalone" +
 * "ConnectOpts"` and a template whose spans all fold are arithmetic a reader does by eye; review
 * showed each of these is ordinary code rather than exotica, and documenting an escape is not
 * closing it.
 *
 * The declaration/assignment pair is worth naming because the two look identical in source and are
 * not identical to the parser: `const { seam: f } = core` is a BindingElement, while
 * `({ seam: f } = core)` is an ordinary object KEY, which this reader allows everywhere else
 * because a key normally names a slot rather than reading one. Only position tells them apart.
 *
 * THE PLAIN-SOURCE DOOR HAS A CENSUS, and keeping the census current is the point of writing it here.
 * A document
 * refuses a computed key it cannot settle; a plain source does not, so `export const KEY = "<seam>"`
 * in one file and `core[KEY]({ ... })` in another is SILENT. Review measured it. The fence was not
 * extended to plain sources because that was measured too: refusing every unsettled computed key
 * across the tree reddens ten call sites that have nothing to do with this seam (four on a clean
 * checkout, and the gap is a gitignored bundle, see A FOURTH boundary below), most of them in
 * vendored bundles, and a check that cries wolf on ordinary code teaches people to route around it.
 * What IS closed everywhere, because it can be closed for free, is the order-dependent name: a key
 * folding through a name declared more than once, where some declaration spells the seam, is refused
 * in a plain source exactly as in a document.
 *
 * THE DOOR'S OTHER SPELLINGS are all ways of writing a table that the fold map declines to ADMIT,
 * and they are listed because each was MEASURED silent at this tip rather than reasoned about. The
 * control is a plain `const T = { k: "<seam>" }; core[T.k]({...})`, which IS seen: it moves the
 * population to 95 and reddens. Each of the following leaves the population at 94 with the suite
 * fully green, which is what makes them misses rather than opinions:
 *
 *   - a NESTED table, `const T = { a: { k: "<seam>" } }; core[T.a.k]`, since the fold reads one
 *     level of properties rather than a path;
 *   - a key DESTRUCTURED out of a table, `const { k } = T; core[k]`, since a binding pattern is not
 *     a name this map collects;
 *   - a table destructured out of a literal, `const { T } = { T: { k: "<seam>" } }`, the same gap
 *     one level up;
 *   - a table wrapped in `Object.freeze`, since the admission test wants a bare object literal and
 *     freeze's initializer is a CALL. This is the one to flinch at, because freezing a constant
 *     table is ordinary defensive style rather than a way to hide anything;
 *   - a GETTER-valued property, `{ get k() { return "<seam>" } }`, where there is no initializer to
 *     fold at all.
 *
 * THOSE FIVE ARE A SAMPLE, NOT A CENSUS, and pretending otherwise was this file's own mistake for
 * several rounds. Adversarial review measured NINE more silent spellings at one sitting: `Object.seal`,
 * `Object.preventExtensions`, `Object.assign({}, ...)`, a class STATIC property, an enum member, an
 * `as const` array indexed by literal, `Object.freeze` applied AFTER construction, a spread copy of
 * another table, and a namespace const. Enumerating them would invite a fifteenth.
 *
 * So state the door by what the fold map ADMITS, which is closed and short, rather than by what it
 * excludes, which is unbounded. A table is folded only when ALL THREE hold: its initializer is a
 * bare object literal, its name is declared exactly once in the file, and every mention of that name
 * is a property access. Anything failing any clause is not folded, its key does not settle, and a
 * call through it is not seen. That is the whole door, and it is a description a reader can check.
 *
 * AND WRITING A NEW ONE IS FREE, which is the sharp end and was understated here until review
 * measured it. A call in a non-admitted spelling was never counted, so ADDING one moves the
 * population not at all: no conversion, no compensating call, nothing. The counts police only the
 * SEEN population. The convert-and-compensate composite described above is what it takes to hide an
 * EXISTING counted call; hiding a NEW one takes a single ordinary-looking edit.
 *
 * None of this is closed, and that is a judgement rather than an oversight. Every closure in this
 * area has opened a sibling, five times running, and four of those cost a FALSE RED that had to be
 * found before it could be fixed. It is all MISS-side, the direction where being wrong spends
 * coverage instead of credibility. No cell asserts any individual miss, deliberately: a cell that
 * pins a hole reads as intent to the next author, which is precisely how the previous hole survived
 * two reviews. The census cell instead executes the SAMPLE plus a control, so the sample cannot rot
 * unnoticed, while making no claim to completeness that it could not keep.
 *
 * THREE OF ITS BOUNDARIES ARE CURATION, not deduction, and adversarial review measured each one
 * silent. The container WATCHLIST decides which markup languages get a recorded decision, so an
 * arrival it does not list (a `.php` naming the seam was the probe) is read by nothing and reddens
 * nothing. SKIP_DIRS is the same bet on directories: adding `examples` to it drops six container
 * files from the walk with every cell still green, because the census that guards the walk shares
 * the same skip list and simply sees a smaller tree. And the COUNTS measure population, not
 * identity, so moving sites between files is indistinguishable from losing them; the split into a
 * total and an untypechecked half catches a move ACROSS the halves, and nothing catches a move
 * within one.
 *
 * That last boundary COMPOSES with the door spellings below, and the composition is worth stating
 * because neither half is alarming alone. A door spelling is a way to write a call this reader does
 * not see; population-not-identity means an unseen call and a deleted one are the same number. So
 * rewriting one counted site into a door spelling AND adding any ordinary counted call elsewhere in
 * the same half leaves the count at exactly 94/67 with every cell green, while a call that throws at
 * runtime sits in the tree. That pair is only needed to hide an ALREADY COUNTED call; a call written
 * in a non-admitted spelling from the start is never counted, so adding one costs nothing at all. That was reproduced here rather than reasoned about: one site converted
 * to a nested table with `tls` dropped, one plain compensating call added, suite green at 143 of 143.
 * The counts are therefore NOT cover for the door. They pin that the SEEN population stays seen, and
 * even that only against an author who does not add a call while removing one. Closing it needs
 * identity rather than population, which is the site manifest named below and a different instrument.
 *
 * THE DELIBERATE AUTHOR IS OUT OF SCOPE, by this file's construction rather than by omission, and
 * saying so is what keeps the paragraph above from reading as a security claim it cannot make. Every
 * instrument here is aimed at ACCIDENT and negligence. Someone who WANTS to conceal a call can edit
 * this file, lower the counts, or delete the census, so a manifest would only move concealment from
 * a dummy call to a dummy manifest line. What such an instrument actually buys is accidental-drift
 * visibility, and the accidental form is the narrow real one: two unrelated edits landing in a single
 * change, one refactoring a site into a table and one adding a call elsewhere in the same half. That
 * is the case a follow-up earns, and the shape it should take is PER-FILE exact counts rather than
 * file and line, since line numbers would redden on every unrelated edit to a touched file and
 * reintroduce exactly the cry-wolf tax this design exists to avoid.
 *
 * A FOURTH boundary is the TREE ITSELF, and it matters more now that the counts are matched exactly
 * rather than as floors. This walk reads the FILESYSTEM, not the commit, so a working copy that has
 * run a build carries files a fresh clone does not. `node_modules`, `dist`, `build` and friends are
 * skipped, but a generated bundle landing outside those names is not: the Hermes sidecar at
 * `extensions/connector-hermes/plugin/cotal/_sidecar/` is gitignored build output and IS walked.
 * Today it costs nothing, measured both ways: 94/67 with the bundle present and 94/67 with it moved
 * aside. It is on the record because an EXACT count turns any future divergence into a red that
 * depends on whether someone ran `pnpm bundle`, which is a property of a disk rather than of a
 * revision. Reading it is deliberate rather than an oversight, since that bundle SHIPS in the
 * connector package: a seam call inside it would be real, and skipping it would be a hole in shipped
 * code rather than a tidier number. Review found this by measuring the same fence on two trees and
 * getting ten refusals against four, which is the same lesson one level up.
 *
 * Each would need a different instrument (a site manifest, a census that does not share
 * the walk's exclusions), and each is written here so the next author inherits the bet rather than
 * the impression that it was checked.
 *
 * What it still cannot EVALUATE is a key computed from a runtime value, a function's return
 * (`["standalone", "ConnectOpts"].join("")` reaches the same binding), or an import it would have to
 * resolve. Closing those means executing the program or running a type checker, which is a different
 * instrument rather than a better rule. In a PLAIN source that stays a residual with the count as
 * its only cover.
 *
 * That residual USED to be wider than the sentence above admitted, and adversarial review is what
 * measured the difference. A stringly dispatch table written in ONE file, `const API = { connect:
 * "<seam>" }; core[API.connect]({creds})`, needs no runtime value and no import: it is static to any
 * human reading it, and it was invisible. A table's string properties now fold, so that call is seen
 * and classified like any other. What remains open is genuinely CROSS-FILE: `export const KEY =
 * "<seam>"` in one file and `core[KEY]({...})` in another. Fencing that was implemented and MEASURED
 * rather than argued about, and it costs ten refusals on ordinary computed calls that have nothing
 * to do with this seam, so it is a stated door rather than a fence people would route around. In a multi-program DOCUMENT it does not: there, a computed key that does not
 * settle within its own script is refused outright, because a document's scripts can hand each other
 * state and three successive attempts to say which of them mattered were each defeated by an
 * ordinary page. The difference is not that a document is more dangerous, it is that a document is
 * where this reader was caught being silent, and silence is the failure it exists to prevent.
 *
 * It also has NO SCOPE. Any local that happens to share the seam's name is read as the seam, so a
 * parameter or variable of that name used as a value is flagged, and a call to it is classified.
 * Both directions are conservative, neither has an occupant here, and resolving them is the same
 * type checker as above. The folding map INHERITS that blindness: it is file-wide and the last
 * declaration in source order wins, so two same-named bindings in different scopes fold to whichever
 * is written later. It also reads `let` as well as `const`.
 *
 * An earlier version of this paragraph claimed a reassigned `let` folds to its first value and that
 * this is "the conservative direction". THAT WAS FALSE, and adversarial review executed the half it
 * got wrong. Folding to the first value is conservative only when the seam is written FIRST: then a
 * later reassignment leaves a call flagged that no longer reaches the seam, which is a false red and
 * loud. Written the other way round, `let m = "other"; m = "<seam>"; core[m]({creds})`, the map
 * answers `"other"`, the call is never recognised as the seam, and the file is never named. That is
 * the silent direction, and it is the one this file exists to refuse. A name BOUND MORE THAN ONCE
 * where any binding spells the seam is therefore refused outright, counting declarations and
 * assignments alike, so neither direction depends on which line came first.
 *
 * The name handed to a call AS DATA is an escape, and that rule has a cost worth stating so the
 * author who pays it knows it is the rule working: an ordinary assertion about the name, such as
 * `expect(fn.name).toBe("standaloneConnectOpts")`, is flagged. Measured across 906 files, the seam
 * name appears as an exact string literal in exactly ONE of them, this file's own seam table, so the
 * cost today is zero and the fail-closed direction is the right default for a reflective read.
 *
 * A file that does not PARSE is refused rather than scanned; see `sitesIn`. That is a change of
 * position rather than a limit: an unparseable file cannot execute, so declining to report a count
 * for it loses nothing, while scanning its error-recovery tree reports a number that looks like
 * coverage and answers about nodes no valid source can produce.
 *
 * Run: pnpm smoke:required-arg-seam
 */
import ts from "typescript";
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
 *  therefore needing a static reader for the call sites the compiler never sees. The two counts are
 *  the population measured when this was last edited, and they are matched EXACTLY rather than as a
 *  floor; see the population cells for why. */
type Seam = { fn: string; key: string; sites: number; untypecheckedSites: number };
const SEAMS: Seam[] = [
  { fn: "standaloneConnectOpts", key: "tls", sites: 94, untypecheckedSites: 67 },
];

/**
 * Directories the walk does not enter, named one by one on purpose. An earlier cut skipped every
 * dot-directory with a single `startsWith(".")`, which is a hole nobody wrote down: a source file
 * under any dotted path was unreachable to this check and to its counts alike. If a new dotted
 * directory ever holds vendored code, add it here, so that the skip is a decision on the record.
 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".internal", "build", "coverage", ".next", "out"]);
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"];

/**
 * CONTAINER LANGUAGES: files that are not TypeScript, but whose EXECUTABLE part is. Review proved
 * this class is not theoretical. `.astro` frontmatter is TypeScript, `website/` holds five such
 * components, and `.github/workflows/docs.yml` runs a real `npm ci && npm run build` over them on
 * any PR touching docs sources. A seam call placed there is executed BY CI while a TypeScript-only
 * walk reports nothing, which is this whole file's failure mode wearing a different extension.
 *
 * Two treatments, because "just parse it" is only honest where the executable part can be isolated:
 *
 *  - `frontmatter`: the fenced head IS TypeScript, so it is extracted and parsed like any other
 *    source, blank-padded so a reported line still points at the real line of the real file. Adding
 *    the extension to EXTS instead would hand the whole component to the TypeScript parser and trip
 *    the parse-diagnostic refusal on every one of them.
 *  - `tripwire`: the executable part cannot be isolated without that language's own compiler. MDX
 *    frontmatter is YAML, and its body mixes markdown with ESM, so any extraction here would be a
 *    guess. The file is therefore not parsed at all; instead the seam's NAME appearing anywhere in
 *    it is itself a failure that says so. Crude, exact, and fail-closed: a tripwire cannot bless a
 *    call, only refuse to answer for one.
 */
const CONTAINERS: Record<string, "frontmatter" | "script" | "tripwire"> = {
  ".astro": "frontmatter",
  ".mdx": "tripwire",
  // `.html` and `.svg` both carry inline `<script>`, and five pages here already do. An earlier cut
  // EXCLUDED them on the reasoning that a browser cannot reach a NATS seam. That reasoning was
  // wrong as stated: browsers run NATS over WebSocket, and this package ships a browser entry. The
  // true reason the path is closed today is narrower and lives in another file, which is exactly
  // the kind of premise that rots without anyone noticing. So they are READ instead, and no
  // rationale has to stay true for this check to be right.
  ".html": "script", ".svg": "script",
};

/** Container extensions this repo could plausibly grow. A cell asserts every one PRESENT in the tree
 *  has a decision in CONTAINERS, so a new `.vue` is a red that asks the question rather than a
 *  silence that answers it. No instrument checks its own boundary unless it is made to. */
const CONTAINER_WATCHLIST = [".astro", ".vue", ".svelte", ".mdx", ".marko", ".riot", ".html", ".svg"];

const extOf = (f: string): string => { const i = f.lastIndexOf("."); return i < 0 ? "" : f.slice(i); };
const scanned = (ext: string): boolean => CONTAINERS[ext] !== undefined;

/**
 * An HTML/SVG document split into the JavaScript it EXECUTES and everything else, both blank-padded
 * so every line number is the document's own. A `<script>` with no type, `type="module"`, or a
 * JavaScript mime is code; anything else (a template, JSON-LD, an unknown language) is not, and
 * lands in the remainder where the tripwire can see it.
 *
 * The remainder is not discarded, and that is deliberate: this splitter is a regex over HTML, which
 * is a thing that can be wrong. Tripwiring what it did NOT treat as code means a mis-slice loses a
 * call into a region that still fails the run, rather than into silence.
 */
function htmlSplit(text: string): { codes: { code: string }[]; rest: string } {
  const blank = (t: string): string => t.replace(/[^\n]/g, " ");
  const codes: { code: string }[] = [];
  let rest = "", last = 0;
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const attrs = m[1], body = m[2];
    const type = /type\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    const isJs = !type || type === "module" || /javascript|ecmascript/.test(type);
    const bodyStart = m.index + m[0].indexOf(">") + 1;
    // One program per script, blank-padded from the FILE's start so it keeps the file's own line
    // numbers. Emitting a single concatenation instead would invent a source the browser never
    // runs: two adjacent tags put the second body on the same physical line as the first, where a
    // trailing `//` comment in the first comments the second out and its calls vanish silently.
    if (isJs) codes.push({ code: blank(text.slice(0, bodyStart)) + body });
    rest += text.slice(last, bodyStart) + (isJs ? blank(body) : body);
    last = bodyStart + body.length;
  }
  return { codes, rest: rest + text.slice(last) };
}

/** The fenced TypeScript head of an Astro component, plus where the rest of the file starts. The
 *  head is blank-padded so every line number in it is the file's own. */
function frontmatter(text: string): { code: string; restAt: number } | undefined {
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return undefined;
  const close = text.indexOf("\n---", open[0].length);
  return close < 0 ? undefined : { code: `\n${text.slice(open[0].length, close)}`, restAt: close };
}

function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      sources(p, acc);
    } else if (EXTS.some((x) => e.name.endsWith(x)) || scanned(extOf(e.name))) acc.push(p);
  }
  return acc;
}

/** JSX is a different grammar, so a `.tsx` parsed as `.ts` mis-reads `<T>` and can drop call sites. */
const parseAll = (file: string, text: string): ts.SourceFile[] => {
  const container = CONTAINERS[extOf(file)];
  if (container === "frontmatter")
    return [ts.createSourceFile(file, frontmatter(text)?.code ?? "", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)];
  if (container === "script")
    return htmlSplit(text).codes.map((c) =>
      ts.createSourceFile(file, c.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  return [ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : undefined)];
};

const WRAPPERS = new Set([
  ts.SyntaxKind.ParenthesizedExpression, ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression, ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.TypeAssertionExpression,
]);

/** Down through the wrappers that change an expression's type or spelling but not its value, so
 *  `(x as F)`, `(x)`, `x!` and `x satisfies T` are all just `x`. */
function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (WRAPPERS.has(cur.kind)) cur = (cur as ts.ParenthesizedExpression).expression;
  return cur;
}

/** Up through the same wrappers, to ask what a node is being USED as. */
function outermost(n: ts.Node): ts.Node {
  let cur = n;
  while (cur.parent && WRAPPERS.has(cur.parent.kind)
    && (cur.parent as ts.ParenthesizedExpression).expression === cur) cur = cur.parent;
  return cur;
}

const isCalleeOf = (n: ts.Node): boolean => {
  const o = outermost(n);
  return !!o.parent && ts.isCallExpression(o.parent) && o.parent.expression === o;
};

/**
 * The string an expression provably evaluates to, or undefined when this file cannot say.
 *
 * Literals fold, `+` of foldable parts folds, and a same-file binding held to a foldable value
 * folds. That is deliberately not a symbol table: it is the arithmetic a reader does by eye, and it
 * exists because review showed `core["standalone" + "ConnectOpts"]` and `const k = "..."; core[k]`
 * are ordinary code rather than exotica. Documenting an escape is not closing it.
 */
function foldString(e: ts.Expression, consts: Map<string, string>, objects?: Objects): string | undefined {
  const x = unwrap(e);
  if (ts.isStringLiteralLike(x)) return x.text;
  if (ts.isIdentifier(x)) return consts.get(x.text);
  // `TABLE.name` and `TABLE["name"]`, where TABLE is a same-file object literal of string literals.
  // This is a fold rather than a fence: it makes the reader SEE more calls, so it cannot turn
  // ordinary code red the way a refusal can. Review landed the shape it exists for, and it is
  // ordinary rather than exotic: `const API = { connect: "<seam>" }; core[API.connect]({creds})`.
  if (objects && ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.expression))
    return objects.get(x.expression.text)?.get(x.name.text);
  if (objects && ts.isElementAccessExpression(x) && ts.isIdentifier(x.expression)) {
    const k = foldString(x.argumentExpression, consts, objects);
    return k === undefined ? undefined : objects.get(x.expression.text)?.get(k);
  }
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = foldString(x.left, consts, objects), r = foldString(x.right, consts, objects);
    return l !== undefined && r !== undefined ? l + r : undefined;
  }
  // A template whose spans ALL fold is the same arithmetic as `+`, done with different punctuation:
  // `` `standalone${"ConnectOpts"}` `` is as static as `"standalone" + "ConnectOpts"`. Declining it
  // while folding `+` would be a promise this file does not keep. A span that does not fold (a call,
  // a runtime value) makes the whole template unfoldable, which is the documented residual.
  if (ts.isTemplateExpression(x)) {
    let out = x.head.text;
    for (const span of x.templateSpans) {
      const v = foldString(span.expression, consts, objects);
      if (v === undefined) return undefined;
      out += v + span.literal.text;
    }
    return out;
  }
  return undefined;
}

type Objects = Map<string, Map<string, string>>;

/** Every same-file `const TABLE = { k: "<foldable string>" }`, so `TABLE.k` is still a spelling. A
 *  stringly dispatch table is the person-shaped version of a computed key, and review landed one
 *  that this reader could not see: same file, no runtime value anywhere, obvious to any human. */
function constObjects(src: ts.SourceFile, consts: Map<string, string>): Objects {
  const out: Objects = new Map();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = unwrap(n.initializer);
      if (ts.isObjectLiteralExpression(init)) {
        const props = new Map<string, string>();
        for (const prop of init.properties) {
          // A SPREAD, or a computed name this file cannot read, can carry any key at all, so every
          // property written BEFORE it stops being settled. Properties after it still win outright.
          if (ts.isSpreadAssignment(prop)
            || (ts.isPropertyAssignment(prop) && ts.isComputedPropertyName(prop.name)
              && foldString(prop.name.expression, consts) === undefined)) { props.clear(); continue; }
          if (!ts.isPropertyAssignment(prop)) continue;
          const k = ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name) ? prop.name.text
            : ts.isComputedPropertyName(prop.name) ? foldString(prop.name.expression, consts) : undefined;
          const v = foldString(prop.initializer, consts);
          if (k !== undefined && v !== undefined) props.set(k, v);
        }
        if (props.size > 0) out.set(n.name.text, props);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);

  // A property the program ASSIGNS after construction is not settled by its initializer, and folding
  // it anyway is a FALSE RED rather than a miss: the reader would name a call the seam while the
  // program calls something else entirely. Review executed exactly that, twice. This is the same
  // surgery as the multiply-bound rule one level down, and for the same reason: read only what the
  // program settles, and refuse the rest rather than guessing which write wins.
  const drop = (obj: string, key: string | undefined): void => {
    if (key === undefined) out.delete(obj);
    else out.get(obj)?.delete(key);
  };
  const assigns = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const target = unwrap(n.left);
      if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression))
        drop(target.expression.text, target.name.text);
      else if (ts.isElementAccessExpression(target) && ts.isIdentifier(target.expression))
        drop(target.expression.text, foldString(target.argumentExpression, consts));
    }
    ts.forEachChild(n, assigns);
  };
  assigns(src);

  // And if the TABLE ITSELF ever leaves this reader's sight, nothing above can be trusted: an alias
  // (`const U = T; U.k = "other"`) or a handoff (`Object.assign(T, {...})`) mutates the same object
  // through a name the sweep never looked at, and both were measured producing a FALSE RED.
  //
  // Enumerating the routes is the losing shape, and this file has lost it four times already: alias,
  // then Object.assign, then whatever the next one is called. So the question is not "which mutation
  // did I miss" but "does this table stay where I can see it": every mention of the name must be the
  // object of a property access. Anything else, passed as an argument, aliased, returned, spread,
  // exported, closed over, gives some other code a handle on it, and a table with a handle out is
  // not settled by its own text. That question has a complete answer; the other one does not.
  // A table name DECLARED more than once is the multiply-bound rule one level up, and it fails the
  // same way: this map is last-wins over the whole file and the reader has no scope, so an inner
  // `const T = { k: "<seam>" }` in some other function decides what an OUTER `T.k` folds to. Measured
  // as a FALSE RED before this existed: the outer table spelled something else entirely.
  const declared = new Map<string, number>();
  const countDecls = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name))
      declared.set(n.name.text, (declared.get(n.name.text) ?? 0) + 1);
    ts.forEachChild(n, countDecls);
  };
  countDecls(src);
  for (const [name, count] of declared) if (count > 1) out.delete(name);

  const escapes = new Set<string>();
  const walkNames = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && out.has(n.text)) {
      const parent = n.parent;
      const isReceiver = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
        && parent.expression === n;
      // Its own declaration is not a handle out, UNLESS the declaration is EXPORTED, which hands
      // the object to files this reader never opens: `import { T } from "./x"; T.k = "other"` is a
      // mutation no single-file reader can see, and folding through it would be a false red.
      const exported = ts.isVariableDeclaration(parent) && ts.isVariableDeclarationList(parent.parent)
        && ts.isVariableStatement(parent.parent.parent)
        && !!parent.parent.parent.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      const isOwnDeclaration = ts.isVariableDeclaration(parent) && parent.name === n && !exported;
      if (!isReceiver && !isOwnDeclaration) escapes.add(n.text);
    }
    ts.forEachChild(n, walkNames);
  };
  walkNames(src);
  for (const name of escapes) out.delete(name);
  return out;
}

/** Every same-file `const x = <foldable string>`, so a key held in one variable is still a spelling. */
function constStrings(src: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const v = foldString(n.initializer, out);
      if (v !== undefined) out.set(n.name.text, v);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

/** Names declared MORE THAN ONCE where at least one declaration spells the seam. The folding map is
 *  last-wins over the whole program, so its answer for such a name is the value after the LAST
 *  declaration, not the value at any particular call, and review used exactly that: a redeclaration
 *  written AFTER a call retroactively changed the key the call appeared to use, and the call went
 *  silent while a browser ran it.
 *
 *  The "at least one spells the seam" half is what keeps this from crying wolf. A name redeclared
 *  with values that are never the seam cannot make any call the seam whatever the order, so refusing
 *  it would say nothing; measured, the unrestricted form reddened two vendored bundles, where short
 *  names are reused constantly and none of it is about this seam. */
function orderDependent(src: ts.SourceFile, fn: string, consts: Map<string, string>): Set<string> {
  const count = new Map<string, number>(), spellsSeam = new Set<string>();
  const bind = (name: string, value: ts.Expression | undefined): void => {
    count.set(name, (count.get(name) ?? 0) + 1);
    if (value && foldString(value, consts) === fn) spellsSeam.add(name);
  };
  const visit = (n: ts.Node): void => {
    // A declaration WITHOUT an initializer still binds the name, and counting it is what makes
    // `let m: string; m = "<seam>";` two bindings rather than one.
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) bind(n.name.text, n.initializer);
    // An ASSIGNMENT rebinds exactly as a redeclaration does, and `constStrings` never sees it, so
    // the folding map keeps answering with the value the name was DECLARED with. Review executed
    // that: `let m = "other"; m = "<seam>"; core[m]({creds})` folded to `"other"`, so the call was
    // never recognised as the seam at all and the file was never named.
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(n.left)) bind(n.left.text, n.right);
    ts.forEachChild(n, visit);
  };
  visit(src);
  return new Set([...spellsSeam].filter((x) => (count.get(x) ?? 0) > 1));
}

/** Whether an expression reads any of those names. */
function reads(e: ts.Expression, names: Set<string>): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) { visit(n.expression); return; }
    if (ts.isIdentifier(n) && names.has(n.text)) hit = true;
    ts.forEachChild(n, visit);
  };
  visit(e);
  return hit;
}

type Folds = (e: ts.Expression | undefined) => boolean;

/** `seam(...)`, `ns.seam(...)`, `ns["seam"](...)`, and any of them behind casts or parens. */
function callsSeam(call: ts.CallExpression, fn: string, folds: Folds): boolean {
  const c = unwrap(call.expression);
  if (ts.isIdentifier(c)) return c.text === fn;
  if (ts.isPropertyAccessExpression(c)) return c.name.text === fn;
  if (ts.isElementAccessExpression(c)) return folds(c.argumentExpression);
  return false;
}

type Verdict = "has-key" | "missing-key" | "unverifiable" | "aliased";

/** The aggregation the tree-wide checks run on, factored out for ONE reason: review showed it was
 *  the load-bearing part with no evidence behind it. Every fixture cell calls the classifier
 *  directly, so a one-token change here (dropping `unverifiable` from the counted set) silenced the
 *  entire refusal regime while the suite stayed green at the right count. A refusal is only red
 *  because these two predicates say so, and nothing asserted that. Now a cell drives this same
 *  function, so the predicates are covered by the thing that depends on them. */
function summarize(all: Site[]): { sites: Site[]; aliased: Site[]; bad: Site[]; untypechecked: Site[] } {
  const sites = all.filter((s) => s.verdict !== "aliased");
  return {
    sites,
    aliased: all.filter((s) => s.verdict === "aliased"),
    bad: sites.filter((s) => s.verdict !== "has-key"),
    untypechecked: sites.filter((s) => s.file.includes(`${sep}smoke${sep}`) || s.file.includes("/smoke/")),
  };
}
type Site = { file: string; line: number; verdict: Verdict; detail: string };

/**
 * Is this mention of the seam's name one that cannot smuggle a call past the reader?
 *
 * Legal: the seam's own declaration; a call, however it is spelled; a same-name import, re-export or
 * destructure, which binds the name this file already looks for; and a `typeof` type query, which
 * cannot invoke anything. Everything else is the name escaping to somewhere this file cannot follow,
 * and is reported rather than assumed harmless.
 */
function referenceIsAllowed(id: ts.Identifier, fn: string): boolean {
  const p = id.parent;
  if (!p) return true;
  // A construct NAMED for the seam declares or labels; it does not read the seam. That includes an
  // object key (`{ seam: mock }`, `{ seam }`), which is how a test table is written: the READ of
  // such a table is caught below, and a call through it is counted by `callsSeam`, so flagging the
  // key would be a false red whose message says something untrue.
  // ...but only in a literal that CONSTRUCTS one. Inside an assignment pattern the very same node
  // is a READ of the seam, so it takes the binding rule below instead of the slot-name allowance.
  if (ts.isPropertyAssignment(p) && p.name === id && inAssignmentPattern(p))
    return ts.isIdentifier(p.initializer) && p.initializer.text === fn;
  // Shorthand splits the same way, and the two halves point OPPOSITE ways. In a literal `{ seam }`
  // captures the value into a table that can be read back without ever spelling the key, which is
  // why it is flagged. In an assignment pattern it assigns the property back into a variable of the
  // same name: the exact twin of `const { seam } = core`, which is allowed three lines below. Left
  // unsplit, identical code got opposite verdicts depending on where the variable was declared.
  if (ts.isShorthandPropertyAssignment(p) && p.name === id && inAssignmentPattern(p)) return true;
  // The same split for a bare identifier in TARGET position: `[seam] = pair`, `for ([seam] of pairs)`
  // and `({ k: seam } = row)` all ASSIGN INTO a variable of the seam's own name, so the name stays
  // the one this reader scans and any call through it is counted. In a LITERAL the identical node is
  // a READ (`const arr = [seam]`, `{ k: seam }`) and stays flagged. Unlike shorthand there is no
  // ambiguity to weigh: a bare identifier in a pattern can only be a target. Review found the array
  // half of this unwired after the object half landed, which is the shape of the whole rule: the
  // helper was already array-aware and only the identifier branch failed to ask it.
  if (inAssignmentPattern(id)
    && (ts.isArrayLiteralExpression(p) || (ts.isPropertyAssignment(p) && p.initializer === id)))
    return true;
  if ((p as { name?: ts.Node }).name === id
    && (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isVariableDeclaration(p)
      // `MethodSignature` is an interface's method SLOT and `EnumMember` an enum's member slot;
      // both name a slot exactly as `MethodDeclaration` and `PropertySignature` already did, and
      // neither can hand anyone the seam. Review reddened a typed facade declaring the seam's shape
      // with NO call anywhere in the file, which is a false red on ordinary TypeScript.
      || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)
      || ts.isMethodSignature(p) || ts.isEnumMember(p)
      || ts.isTypeAliasDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isClassDeclaration(p)
      || ts.isEnumDeclaration(p) || ts.isModuleDeclaration(p) || ts.isParameter(p)
      // A property assignment's KEY names a slot; its VALUE is a separate node and is asked
      // separately. SHORTHAND is deliberately absent: `{ seam }` is the key AND a read of the
      // seam, and review built the read that proves it, taking the value straight back out with
      // `Object.values` without ever spelling the key again.
      || ts.isPropertyAssignment(p)
      // `import seam from "x"` binds the scannable name, exactly as `import { default as seam }` does.
      || ts.isImportClause(p))) return true;
  // A binding is safe exactly when the name it binds LOCALLY is still the one this reader scans
  // for. `import { seam }`, `import { default as seam }` and `const { seam } = core` all bind it;
  // every rename AWAY from it (`{ seam as other }`) is the hazard, whichever half is being visited.
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isBindingElement(p))
    return ts.isIdentifier(p.name) && p.name.text === fn;
  if (isCalleeOf(id)) return true;
  // `ns.seam(...)` and `ns["seam"](...)`: the name sits inside the callee rather than being it.
  if (ts.isPropertyAccessExpression(p) && p.name === id && isCalleeOf(p)) return true;
  if (ts.isTypeQueryNode(p)) return true;
  return false;
}

/**
 * The same escape, spelled as a STRING, which no rule about identifiers can see.
 *
 * `core["seam"](...)` is a call and is counted. `const f = core["seam"]` is the identical rebinding
 * wearing a different spelling, and it reaches the same binding with no identifier naming the seam
 * anywhere in the file; so does a computed rename in a destructure. Found by review, proven as a
 * green pass on a real throwing call site, which is the reads-as-coverage failure this file exists
 * to refuse.
 *
 * A computed key in an object LITERAL (`{ ["seam"]: mock }`) is a key rather than a read, so it is
 * left alone for the same reason the identifier keys above are.
 *
 * RESIDUAL, stated rather than papered over: a name assembled at runtime (`core["standalone" +
 * "ConnectOpts"]`) is not constant-folded here and stays invisible. Closing it means evaluating
 * expressions, which is a different instrument; the population count is the only cover it has.
 */
/**
 * Is this node inside an object/array pattern that is the TARGET of an assignment, rather than
 * inside a literal that CONSTRUCTS a value? The distinction is invisible in the source and decisive
 * here: `({ seam: f } = core)` reads the seam exactly as `const { seam: f } = core` does, but the
 * parser gives the destructuring DECLARATION a `BindingElement` and the destructuring ASSIGNMENT an
 * ordinary `PropertyAssignment`, which this file allows because a key normally names a slot. That
 * spelling is ordinary JavaScript whenever the variable is declared before the assignment or filled
 * inside a loop, so the two must be answered the same way.
 */
function inAssignmentPattern(n: ts.Node): boolean {
  let cur: ts.Node = n;
  while (cur.parent) {
    const p: ts.Node = cur.parent;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.left === cur) return true;
    if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === cur) return true;
    if (ts.isObjectLiteralExpression(p) || ts.isArrayLiteralExpression(p) || ts.isPropertyAssignment(p)
      || ts.isSpreadAssignment(p) || ts.isSpreadElement(p) || ts.isParenthesizedExpression(p)) { cur = p; continue; }
    return false;
  }
  return false;
}

function escapesAt(n: ts.Node, fn: string, folds: Folds): boolean {
  const bindsTheName = (name: ts.Node): boolean => ts.isIdentifier(name) && name.text === fn;
  // Reading the property off a namespace, a module object, or any table: `core["seam"]`. When the
  // access IS the callee it is a call and is counted instead.
  if (ts.isElementAccessExpression(n)) return folds(n.argumentExpression) && !isCalleeOf(n);
  // `const { ["seam"]: f } = core`, unless it binds the name back.
  if (ts.isBindingElement(n) && n.propertyName && ts.isComputedPropertyName(n.propertyName))
    return folds(n.propertyName.expression) && !bindsTheName(n.name);
  // `({ ["seam"]: f } = core)`: the assignment-pattern twin of the computed rename above, which the
  // parser spells as a PropertyAssignment with a ComputedPropertyName rather than a BindingElement.
  if (ts.isPropertyAssignment(n) && ts.isComputedPropertyName(n.name) && inAssignmentPattern(n))
    return folds(n.name.expression) && !bindsTheName(n.initializer);
  // `import { "seam" as f }` / `export { "seam" as f }`: ordinary syntax whose propertyName is a
  // string rather than an identifier, so no rule about identifiers can see the rename.
  if ((ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) && n.propertyName
    && ts.isStringLiteralLike(n.propertyName))
    return n.propertyName.text === fn && !bindsTheName(n.name);
  // The name handed to something else AS DATA, which is how a reflective get obtains it:
  // `Reflect.get(core, "seam")`, `Object.getOwnPropertyDescriptor(core, "seam")`, and friends.
  if (ts.isCallExpression(n)) return n.arguments.some((a) => folds(a));
  return false;
}

const literalUndefined = (x: ts.Node): boolean =>
  (ts.isIdentifier(x) && x.text === "undefined") || ts.isVoidExpression(x);

/** How many times each name is BOUND across this file, declarations and assignments alike.
 *  The KEY fold needs this at file granularity, because the const map it folds through is itself
 *  built file-wide: a name this file binds twice has no one value, and folding it means answering
 *  what it WOULD BE at runtime from text that does not settle it. The VALUE reader below asks a
 *  narrower, scoped question and does not use this. */
const BINDS = new WeakMap<ts.SourceFile, Map<string, number>>();
function bindingCounts(src: ts.SourceFile): Map<string, number> {
  const cached = BINDS.get(src);
  if (cached) return cached;
  const out = new Map<string, number>();
  const bump = (name: string): void => { out.set(name, (out.get(name) ?? 0) + 1); };
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n)) { const b = new Set<string>(); boundNames(n.name, b); b.forEach(bump); }
    else writesTo(n).forEach(bump);
    ts.forEachChild(n, walk);
  };
  walk(src);
  BINDS.set(src, out);
  return out;
}

/** The consts an ARGUMENT key may fold through: those this file SETTLES, meaning bound exactly once.
 *  Review defeated the unfiltered version by rewriting a real counted site to `let K = "tls"; K =
 *  "other"; seam({ creds, [K]: false })`: the fold answered "tls" from the declaration, the runtime
 *  key was "other", the seam threw, and the suite stayed green at 94 of 94 with the counts unmoved.
 *  That is the same false green the seam-name path already refuses by its own order rule, and it
 *  arrived through the fold this file had just widened to argument position. */
function settledStrings(src: ts.SourceFile, consts: Map<string, string>): Map<string, string> {
  const counts = bindingCounts(src);
  return new Map([...consts].filter(([name]) => (counts.get(name) ?? 0) <= 1));
}

/** What this file can say about a NAME used as the key's value, answered in the SCOPE that binds it.
 *
 *  A file-wide map cannot answer this, and the two ways it fails are the two findings that produced
 *  this function. Claiming too much: `let tls = false; tls = undefined` passed as has-key, because a
 *  map keyed by name reads the declaration while the program runs on the assignment. Claiming too
 *  little, which is worse, because a false red teaches people to route around the check: two
 *  ordinary functions, each with its own local `tls`, one of them dead, and the dead one answers for
 *  the live call. Counting harder does not fix that second one, it only changes which red it is,
 *  since the two names are genuinely different bindings and no file-wide count can tell them apart.
 *
 *  So the walk goes outward from the use to the nearest scope that BINDS the name, and that scope
 *  alone answers. Bound once with no initializer or an undefined one: undefined, which is the value
 *  the seam throws on. Bound more than once, by any declaration or assignment: unsettled, refused in
 *  both directions rather than answered from whichever binding the text happens to show first. Bound
 *  by something this file cannot value, which is what a parameter, a destructured local, a catch
 *  variable or an import is: unknown, and untouched. That last case is the house idiom feeding
 *  `{ creds, tls }`, and it must stay green.
 *
 *  Residual, stated rather than papered over: a nested BLOCK binding is folded into its enclosing
 *  function rather than given its own scope, so a name declared in both is unsettled and refused
 *  where a full resolver would answer it. That is a refusal on a shadowing shape, in the direction
 *  that costs a verdict rather than the one that grants a pass. */
type NameFact = "undefined" | "unsettled" | "unknown";

/** Every name an assignment WRITES, which is not the same as the name on its left. `({ K } = o)`
 *  and `[K] = a` write K through a pattern, and a rule that reads only `x = v` sees no write at all
 *  and answers the name from its declaration while the program runs on the assignment. That is the
 *  original false green wearing different syntax. */
function assignmentTargets(e: ts.Expression, out: Set<string>): void {
  const x = unwrap(e);
  if (ts.isIdentifier(x)) { out.add(x.text); return; }
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    assignmentTargets(x.left, out); // a default inside a pattern: `{ a: b = 1 }`
    return;
  }
  if (ts.isObjectLiteralExpression(x)) {
    x.properties.forEach((q) => {
      if (ts.isShorthandPropertyAssignment(q)) out.add(q.name.text);
      else if (ts.isPropertyAssignment(q)) assignmentTargets(q.initializer, out);
      else if (ts.isSpreadAssignment(q)) assignmentTargets(q.expression, out);
    });
    return;
  }
  if (ts.isArrayLiteralExpression(x)) {
    x.elements.forEach((el) => {
      if (ts.isOmittedExpression(el)) return;
      assignmentTargets(ts.isSpreadElement(el) ? el.expression : el, out);
    });
  }
}

/** The names a DECLARATION binds, pattern included. */
function boundNames(n: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(n)) { out.add(n.text); return; }
  n.elements.forEach((el) => { if (!ts.isOmittedExpression(el)) boundNames(el.name, out); });
}

const writesTo = (n: ts.Node): Set<string> => {
  const out = new Set<string>();
  if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) assignmentTargets(n.left, out);
  // `for (K of xs)` rebinds K on every pass and is not an assignment expression at all.
  else if ((ts.isForOfStatement(n) || ts.isForInStatement(n))
    && !ts.isVariableDeclarationList(n.initializer)) assignmentTargets(n.initializer, out);
  else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
    && ts.isIdentifier(n.operand)
    && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken))
    out.add(n.operand.text);
  return out;
};

const rebinds = (n: ts.Node, name: string): boolean => writesTo(n).has(name);

/** The nearest enclosing scope of a node: a function, or the file when there is no function. */
function scopeOf(n: ts.Node): ts.Node | undefined {
  let cur: ts.Node | undefined = n.parent;
  while (cur && !ts.isSourceFile(cur) && !ts.isFunctionLike(cur)) cur = cur.parent;
  return cur;
}

/** A binding of this name that this reader cannot VALUE: a parameter, a destructured local, a catch
 *  variable, an import, a function or class of that name.
 *
 *  It matters that these are recognised as bindings rather than skipped as unreadable, because the
 *  walk below goes outward until something binds the name, and anything it fails to recognise sends
 *  it one scope further out to an unrelated binding that then answers for a name it has nothing to
 *  do with. A parameter got that treatment first; the general rule arrived after two more spellings
 *  of it turned up as false reds, `const { tls } = cfg` and `catch (tls)`. The catch clause was the
 *  worse of the two: it parses as a declaration with NO INITIALIZER, which is the one shape this
 *  reader had just learned to call undefined, so it did not merely walk past the binding, it read
 *  the wrong answer off it.
 *
 *  An IMPORT was in this list and has been removed, because mutation said nothing tested it and the
 *  reason turned out to be structural rather than a missing cell: this rule only matters where a
 *  binding SHADOWS an outer one, and an import lives at file scope, where a second binding of its
 *  name is a duplicate declaration and not a program. A name this file never binds is already
 *  answered by the walk running out of scopes. Writing a cell to cover the branch would have
 *  produced a green that proved the branch reachable by fixture and never by any real file. */
function opaqueBinding(n: ts.Node, name: string): boolean {
  const named = (x: ts.Node | undefined): boolean => !!x && ts.isIdentifier(x) && x.text === name;
  if (ts.isBindingElement(n)) return named(n.name);
  if (ts.isParameter(n)) return named(n.name);
  if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) return named(n.name);
  return false;
}

/** What a destructuring pattern hands this name, when the thing being taken apart is written out
 *  right here. `const { tls } = { tls: undefined }` is readable and was passing as stated; `const
 *  { tls } = cfg` is not readable, and the difference between those two is the difference between
 *  declining to answer and answering wrongly. */
function patternValue(pattern: ts.BindingName, init: ts.Expression | undefined,
  name: string): ts.Expression | undefined | "opaque" {
  if (!ts.isObjectBindingPattern(pattern) || !init) return "opaque";
  const src = unwrap(init);
  if (!ts.isObjectLiteralExpression(src)) return "opaque";
  if (src.properties.some((q) => ts.isSpreadAssignment(q)
    || (!!q.name && ts.isComputedPropertyName(q.name)))) return "opaque";
  const el = pattern.elements.find((e) => ts.isIdentifier(e.name) && e.name.text === name);
  if (!el || el.dotDotDotToken || el.initializer) return "opaque"; // a rest or a default is another read
  const key = el.propertyName ?? el.name;
  if (!ts.isIdentifier(key) && !ts.isStringLiteralLike(key)) return "opaque";
  const hit = src.properties.find((q) => !!q.name
    && (ts.isIdentifier(q.name) || ts.isStringLiteralLike(q.name)) && q.name.text === key.text);
  if (!hit) return undefined; // the property is absent, so this name IS undefined
  if (ts.isPropertyAssignment(hit)) return hit.initializer;
  if (ts.isShorthandPropertyAssignment(hit)) return hit.name;
  return "opaque";
}

/** The value a DECLARATION gives this name, or "opaque" where it binds the name by a route this
 *  file cannot value. A catch variable is bound by the throw and a for-of variable by the
 *  iteration: neither has an initializer to read, and reading the absent one as undefined is how
 *  `catch (tls)` came to claim the very value the seam throws on. */
function declaredValue(decl: ts.VariableDeclaration, name: string): ts.Expression | undefined | "opaque" {
  if (ts.isCatchClause(decl.parent)) return "opaque";
  if (ts.isVariableDeclarationList(decl.parent) && decl.parent.parent
    && (ts.isForOfStatement(decl.parent.parent) || ts.isForInStatement(decl.parent.parent))) return "opaque";
  if (ts.isIdentifier(decl.name)) return decl.initializer;
  return patternValue(decl.name, decl.initializer, name);
}

function nameFact(id: ts.Identifier): NameFact {
  for (let scope = scopeOf(id); scope; scope = ts.isSourceFile(scope) ? undefined : scopeOf(scope)) {
    const values: (ts.Expression | undefined)[] = [];
    let writes = 0, opaque = 0;
    const visit = (n: ts.Node): void => {
      // A nested function DECLARATION is both a binding here and a scope of its own, and the binding
      // has to be seen first: skipping it as a scope hid the name it binds, and the walk carried on
      // outward to an unrelated binding that then answered for it.
      if (opaqueBinding(n, id.text)) { opaque += 1; return; }
      if (n !== scope && ts.isFunctionLike(n)) return; // another scope answers for its own names
      if (ts.isVariableDeclaration(n)) {
        const bound = new Set<string>();
        boundNames(n.name, bound);
        if (bound.has(id.text)) {
          const v = declaredValue(n, id.text);
          if (v === "opaque") opaque += 1;
          else values.push(v);
          // The pattern IS this binding, so do not walk it again; the initializer can still hold
          // rebindings of the name and is walked on its own.
          if (n.initializer) visit(n.initializer);
          return;
        }
      }
      if (rebinds(n, id.text)) writes += 1;
      ts.forEachChild(n, visit);
    };
    visit(scope);
    const binds = values.length + writes + opaque;
    if (binds === 0) continue; // not bound here: the enclosing scope answers
    if (binds > 1) return "unsettled";
    if (opaque === 1) return "unknown"; // bound here, by something this file cannot value
    const init = values[0];
    return !init || literalUndefined(unwrap(init)) ? "undefined" : "unknown";
  }
  return "unknown";
}

const isProvablyUndefined = (e: ts.Expression, src: ts.SourceFile): boolean => {
  void src;
  const x = unwrap(e);
  return literalUndefined(x) || (ts.isIdentifier(x) && nameFact(x) === "undefined");
};

/**
 * The values an argument expression can actually evaluate to.
 *
 * The tree answers this where text could only guess it: a ternary's CONDITION is a different field
 * from its branches, so it is excluded structurally rather than by spotting a `?`. `||`, `??` and
 * `&&` each yield one side or the other, and both sides are real arguments, which is the hole that
 * blessed a throwing site once: `opts || { tls: false }` reads as a keyed literal and passes `opts`.
 * A comma sequence produces only its right-hand value.
 */
function alternatives(e: ts.Expression): ts.Expression[] {
  const x = unwrap(e);
  if (ts.isConditionalExpression(x)) return [...alternatives(x.whenTrue), ...alternatives(x.whenFalse)];
  if (ts.isBinaryExpression(x)) {
    const k = x.operatorToken.kind;
    if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken
      || k === ts.SyntaxKind.AmpersandAmpersandToken) return [...alternatives(x.left), ...alternatives(x.right)];
    if (k === ts.SyntaxKind.CommaToken) return alternatives(x.right);
  }
  return [x];
}

/** `key` named by this property, in any of the three spellings that all state it: `key:`, `"key":`
 *  and `["key"]:`. The shorthand `{ key }` arrives here as an identifier name and states it too. */
function propertyNames(name: ts.PropertyName | undefined, key: string,
  consts: Map<string, string>, objects: Objects): boolean {
  if (!name) return false;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text === key;
  // A computed key folds by exactly the arithmetic the SEAM's own name folds by. Review found the
  // asymmetry as a FALSE RED: this reader would fold `core["standalone" + "ConnectOpts"]` to find a
  // call, then refuse to fold `{ [TLS]: false }` with `const TLS = "tls"` beside it and report the
  // key missing from a call that states it. One arithmetic, both positions.
  if (ts.isComputedPropertyName(name)) return foldString(name.expression, consts, objects) === key;
  return false;
}

/**
 * Does every object this call can pass state `key` at its own top level, with a value that is not
 * provably absent?
 *
 * ORDER MATTERS INSIDE THE LITERAL, and getting that wrong is a false green in the severe direction:
 * `{ tls: false, ...cfg }` states the key and then lets `cfg` overwrite it, so the seam can still
 * receive nothing. A spread BEFORE the key cannot do that, and flagging it would be a false red on
 * an ordinary override idiom, so the two orders are answered differently.
 *
 * Depth matters too: `{ opts: { tls: false } }` says nothing about the seam's own argument.
 */
function classify(arg: ts.Expression | undefined, key: string, src: ts.SourceFile,
  consts: Map<string, string>, objects: Objects): { verdict: Verdict; detail: string } {
  if (!arg) return { verdict: "missing-key", detail: "called with no argument at all" };
  const show = (n: ts.Node): string => n.getText(src).replace(/\s+/g, " ").slice(0, 100);
  let unverifiable = "";
  for (const alt of alternatives(arg)) {
    if (!ts.isObjectLiteralExpression(alt)) {
      unverifiable ||= `an alternative built elsewhere: ${show(alt)}`;
      continue;
    }
    let keyAt = -1, keyValue: ts.Expression | undefined, keyIsOpaque = false;
    let overwrittenAfterKey = "", anySpread = false;
    alt.properties.forEach((p, i) => {
      // A spread, or a key this file cannot resolve, can both land on the seam's own key. Whether
      // that matters depends entirely on WHERE it sits, which is why position is tracked and not
      // just presence: before the key it is an ordinary override idiom, after it, it can undo it.
      const opaqueKey = !ts.isSpreadAssignment(p) && !!p.name && ts.isComputedPropertyName(p.name)
        && foldString(p.name.expression, consts, objects) === undefined;
      if (ts.isSpreadAssignment(p) || opaqueKey) {
        if (ts.isSpreadAssignment(p)) anySpread = true;
        if (keyAt >= 0) overwrittenAfterKey = ts.isSpreadAssignment(p) ? "a spread" : "a computed key this file cannot resolve";
        return;
      }
      if (!propertyNames(p.name, key, consts, objects)) return;
      keyAt = i;
      // Only a property assignment carries a value this file can look at. A getter is a function
      // body, and reading it would be evaluating code, so it states the key without a knowable
      // value and must not be answered as though the value were fine.
      // SHORTHAND states the key and reads a binding of the same name, so `{ tls }` carries a value
      // just as `{ tls: tls }` does. Reading only PropertyAssignment let `const tls = undefined;
      // seam({ creds, tls })` pass as has-key while the seam threw on it, and review demonstrated it
      // by rewriting a real counted site in place: counts unmoved, every cell green, call throwing.
      keyValue = ts.isPropertyAssignment(p) ? p.initializer
        : ts.isShorthandPropertyAssignment(p) ? p.name
        : undefined;
      keyIsOpaque = ts.isGetAccessorDeclaration(p);
      overwrittenAfterKey = ""; // a later restatement wins over an earlier one
    });
    if (keyAt < 0) {
      if (anySpread) { unverifiable ||= `the key may live in a spread: ${show(alt)}`; continue; }
      return { verdict: "missing-key", detail: `an alternative omits it: ${show(alt)}` };
    }
    if (overwrittenAfterKey) { unverifiable ||= `${overwrittenAfterKey} AFTER the key can overwrite it: ${show(alt)}`; continue; }
    if (keyIsOpaque) { unverifiable ||= `the key is a getter, whose value this file cannot read: ${show(alt)}`; continue; }
    // The VALUE is asked the same question the argument was: an expression that can evaluate to
    // `undefined` on any branch delivers exactly what the seam throws on.
    if (keyValue && alternatives(keyValue).some((v) => isProvablyUndefined(v, src))) {
      return { verdict: "missing-key", detail: `states the key as \`undefined\`, which is not the boolean the seam demands: ${show(alt)}` };
    }
    // A value this file binds MORE THAN ONCE has no single value to read, and the order rule the KEY
    // has carried since round 19 belongs here for exactly the reason it belongs there. Without it
    // `let tls = false; tls = undefined` passed as has-key while the seam threw: the reader answered
    // from the declaration and the program ran on the assignment. A parameter is bound nowhere this
    // file can read and stays untouched, which is the load-bearing case: destructured params feeding
    // `{ creds, tls }` are the house idiom and must not go red.
    const unsettled = keyValue && alternatives(keyValue).map(unwrap)
      .find((v) => ts.isIdentifier(v) && nameFact(v) === "unsettled");
    if (unsettled) {
      unverifiable ||= `the value is a name this file binds more than once, so its value at the call is not settled here: ${show(alt)}`;
      continue;
    }
  }
  return unverifiable ? { verdict: "unverifiable", detail: unverifiable } : { verdict: "has-key", detail: "" };
}

/** Every call of the seam in one file, classified, plus every escape of its name. */
/** Every file extension present in the walked tree, so the reach claim can be checked against the
 *  repository rather than against memory. */
function extensionsPresent(dir: string, acc: Set<string> = new Set()): Set<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) extensionsPresent(join(dir, e.name), acc); }
    else acc.add(extOf(e.name));
  }
  return acc;
}

function sitesIn(file: string, text: string, seam: Seam): Site[] {
  // A tripwire container is never parsed, so it can only ever REFUSE. Naming the seam in a file this
  // reader cannot read is the one thing it can detect, and it is enough to force the question.
  const tripwire = (from: number, why: string): Site[] => {
    const at = text.indexOf(seam.fn, from);
    return at < 0 ? [] : [{
      file, line: text.slice(0, at).split("\n").length, verdict: "unverifiable",
      detail: `\`${seam.fn}\` is named ${why}, which this reader cannot isolate without that language's own compiler; move the call into a source it can read, or teach this check to extract it`,
    }];
  };
  if (CONTAINERS[extOf(file)] === "tripwire")
    return tripwire(0, `in a ${extOf(file)} file, whose executable part is mixed into its prose`);
  const programs = parseAll(file, text);
  // A file that does not PARSE is refused rather than scanned, because the recovery tree the parser
  // hands back is not the program: it invents nodes that no valid source can produce, and a rule
  // asked about one of them answers about nothing. Review hit this exactly once, reporting a false
  // red on `const { ["seam"] } = core` (a SyntaxError in both Node and tsc, whose recovery is a
  // binding whose name is an identifier with EMPTY text) and reading it as a defect in the rule.
  // Refusing here is also fail-closed in the direction that matters: an unparseable file cannot run,
  // so nothing is lost by declining to report a count for it, while scanning it silently reports a
  // number that looks like coverage.
  for (const src of programs) {
    const diags = (src as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (diags.length) return [{
      file, line: 1, verdict: "unverifiable",
      detail: `this file does not parse (${ts.flattenDiagnosticMessageText(diags[0].messageText, " ")}), so the tree here is error recovery rather than the program`,
    }];
  }
  const found: Site[] = [];
  // NO NAME IS RESOLVED ACROSS PROGRAMS, and this is a deliberate retreat from trying. Two review
  // rounds killed two different attempts to model it: sharing every program's constants let a later
  // module's `const N = "other"` overwrite a classic global, and sharing only the classic ones still
  // let a later `var N = "other"` overwrite the value an EARLIER call had already run with. Each fix
  // modelled one more rule of browser scope (module vs classic, then execution order) and each
  // opened another. A smoke check is the wrong place to reimplement that, so it is not modelled at
  // all: a program folds only what it declares itself, and a key that leans on a name from another
  // program is REFUSED by name rather than resolved. That turns the whole class from a silent miss
  // into a loud one, and it is the same answer this file already gives an alias: call the seam by
  // its own name so the argument can be seen.
  const multiProgram = CONTAINERS[extOf(file)] === "script";
  programs.forEach((src) => {
    const consts = constStrings(src);
    const objects = constObjects(src, consts);
    const settled = settledStrings(src, consts);
    const redeclared = orderDependent(src, seam.fn, consts);
    const folds: Folds = (e) => !!e && foldString(e, consts, objects) === seam.fn;
    const lineOf = (n: ts.Node): number => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isElementAccessExpression(n.expression)
        && ((multiProgram && foldString(n.expression.argumentExpression, consts, objects) === undefined)
          || reads(n.expression.argumentExpression, redeclared))) {
        found.push({
          file, line: lineOf(n), verdict: "unverifiable",
          detail: `this call's key does not settle in its own ${multiProgram ? "script" : "file"}, so answering it would mean running the program; call the seam by its own name, or spell the key from a name declared once here`,
        });
      } else if (ts.isCallExpression(n) && callsSeam(n, seam.fn, folds)) {
        const { verdict, detail } = classify(n.arguments[0], seam.key, src, settled, objects);
        found.push({ file, line: lineOf(n), verdict, detail });
      } else if ((ts.isIdentifier(n) && n.text === seam.fn && !referenceIsAllowed(n, seam.fn))
        || escapesAt(n, seam.fn, folds)) {
        found.push({
          file, line: lineOf(n), verdict: "aliased",
          detail: `the name is rebound here (${ts.SyntaxKind[n.parent.kind]}); call the seam by its own name so this check can see the argument`,
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  });
  // A frontmatter container's TEMPLATE half is executable too: Astro evaluates `{expr}` at build
  // time, so extracting only the fenced head would leave a second live surface unread. It is not
  // TypeScript and cannot be parsed as any, so the same tripwire covers it. Extract what is a
  // program, refuse the rest: the two together are what makes the container claim honest.
  const kind = CONTAINERS[extOf(file)];
  if (kind === "frontmatter") {
    const fm = frontmatter(text);
    found.push(...tripwire(fm ? fm.restAt : 0, `outside the frontmatter of a ${extOf(file)} file, in its template half`));
  }
  if (kind === "script" && htmlSplit(text).rest.includes(seam.fn)) found.push({
    file, line: text.slice(0, text.indexOf(seam.fn)).split("\n").length, verdict: "unverifiable",
    detail: `\`${seam.fn}\` is named in a ${extOf(file)} file OUTSIDE any JavaScript this reader extracted (markup, an attribute, or a script whose type it does not treat as code); move the call into a script it can read, or teach this check to extract that form`,
  });
  return found;
}

console.log("A. the reader itself, on fixtures whose verdicts are known");
{
  // POSITIVE CONTROLS FIRST. A reader that matches nothing passes every completeness assertion
  // below in silence, so it is graded on inputs whose answers are stated here before it runs.
  const fx = (body: string): Site[] => sitesIn("fixture.ts", body, SEAMS[0]);
  const one = (body: string): Verdict | undefined => fx(body)[0]?.verdict;

  console.log(" A1. the argument");
  check("a call that states the key is accepted", one(`standaloneConnectOpts({ creds: c, tls: false })`) === "has-key");
  check("a call that OMITS the key is flagged (the defect this check exists for)",
    one(`standaloneConnectOpts({ creds: c })`) === "missing-key");
  check("a call with NO argument at all is flagged",
    one(`standaloneConnectOpts()`) === "missing-key");
  check("the key on a LATER LINE is still accepted (the seam's callers are free to wrap)",
    one(`standaloneConnectOpts({\n  creds: c,\n  tls: true,\n})`) === "has-key");
  check("the key NESTED in a sub-object does not count (it says nothing about the seam's own argument)",
    one(`standaloneConnectOpts({ opts: { tls: false } })`) === "missing-key");
  check("a key-like suffix of another identifier does not count (`notls:` is not `tls:`)",
    one(`standaloneConnectOpts({ notls: false })`) === "missing-key");
  check("SHORTHAND states the key as well as `tls: v` does, and must not be a false red",
    one(`standaloneConnectOpts({ creds, tls })`) === "has-key");
  // Both were false REDS while the reader scanned blanked text: the quoted key vanished with the
  // string it lived in, and the computed one never matched the `tls:` shape at all.
  check("a QUOTED key states it, and a COMPUTED string key states it (both pass the argument)",
    one(`standaloneConnectOpts({ creds: c, "tls": false })`) === "has-key"
    && one(`standaloneConnectOpts({ creds: c, ["tls"]: v })`) === "has-key");
  check("an argument built elsewhere is UNVERIFIABLE, never silently passed",
    one(`standaloneConnectOpts(buildAuth())`) === "unverifiable");
  check("a top-level spread is UNVERIFIABLE, because the key may live in what is spread",
    one(`standaloneConnectOpts({ ...base })`) === "unverifiable");
  // The severe order-of-properties case: the key is stated and then overwritten. Its mirror image is
  // an ordinary override idiom and must stay green, so the two orders cannot share an answer.
  check("a spread AFTER the key is UNVERIFIABLE, because it can overwrite what the key stated",
    one(`standaloneConnectOpts({ tls: false, ...cfg })`) === "unverifiable");
  check("a spread BEFORE the key is accepted, because the literal key wins (not a false red)",
    one(`standaloneConnectOpts({ ...cfg, tls: false })`) === "has-key");
  check("...and restating the key after that spread wins again",
    one(`standaloneConnectOpts({ tls: false, ...cfg, tls: true })`) === "has-key");
  // The seam demands a boolean, so the one value this reader judges is the one that provably is not.
  check("the key stated as `undefined` is flagged, because the seam throws on it just the same",
    one(`standaloneConnectOpts({ creds, tls: undefined })`) === "missing-key"
    && one(`standaloneConnectOpts({ creds, tls: void 0 })`) === "missing-key");
  check("...including when only ONE BRANCH of the value is `undefined`",
    one(`standaloneConnectOpts({ tls: want ? true : undefined })`) === "missing-key"
    && one(`standaloneConnectOpts({ tls: want ?? undefined })`) === "missing-key");
  check("a GETTER states the key with a value this file cannot read, so it is UNVERIFIABLE, not a pass",
    one(`standaloneConnectOpts({ get tls() { return undefined; } })`) === "unverifiable");
  // The same ordering question as the spread, in the spelling that hides it: a key the file cannot
  // resolve can be the seam's own key, so after the key it can undo it.
  check("a COMPUTED KEY this file cannot resolve, AFTER the key, can overwrite it and is UNVERIFIABLE",
    one(`standaloneConnectOpts({ tls: false, [k]: undefined })`) === "unverifiable");
  check("...and the same computed key BEFORE the key is accepted, because the literal key wins",
    one(`standaloneConnectOpts({ [k]: undefined, tls: false })`) === "has-key");

  console.log(" A2. what the argument can evaluate to");
  check("a TERNARY whose every branch states the key is accepted",
    one(`standaloneConnectOpts(a ? { creds: c, tls: true } : b ? { bearer: t, tls: false } : { tls: false })`) === "has-key");
  check("a ternary with the key on only ONE branch is flagged (the other branch is a real argument too)",
    one(`standaloneConnectOpts(a ? { creds: c, tls: true } : { creds: d })`) === "missing-key");
  check("`opts || { tls: false }` is UNVERIFIABLE: the left alternative is a real argument and this file cannot see inside it",
    one(`standaloneConnectOpts(opts || { tls: false })`) === "unverifiable");
  check("...and so are `opts ?? { tls: false }` and `a && { tls: false }`",
    one(`standaloneConnectOpts(opts ?? { tls: false })`) === "unverifiable"
    && one(`standaloneConnectOpts(a && { tls: false })`) === "unverifiable");
  check("a ternary mixing a keyed literal with a NON-literal branch is UNVERIFIABLE, not a pass",
    one(`standaloneConnectOpts(a ? { tls: true } : base)`) === "unverifiable"
    && one(`standaloneConnectOpts(a ? { tls: true } : buildAuth())`) === "unverifiable");
  check("a ternary CONDITION is not an argument, so an optional chain in one cannot confuse the split",
    one(`standaloneConnectOpts(a?.b ? { tls: true } : { tls: false })`) === "has-key");
  // A false RED while alternatives were split out of text: authors parenthesize long ternaries.
  check("PARENTHESES around the argument change nothing (a keyed ternary in parens is not a false red)",
    one(`standaloneConnectOpts((cond ? { creds: c, tls: true } : { creds: d, tls: false }))`) === "has-key");
  check("a comma sequence passes only its right-hand value",
    one(`standaloneConnectOpts((log(), { creds, tls: false }))`) === "has-key"
    && one(`standaloneConnectOpts((log(), { creds }))`) === "missing-key");

  console.log(" A3. finding the call at all");
  check("a mention inside a COMMENT is not a call site", fx(`// standaloneConnectOpts({ creds: c })\nconst x = 1;`).length === 0);
  check("a mention inside a STRING is not a call site", fx('const s = "standaloneConnectOpts({ creds: c })";').length === 0);
  check("a brace inside a string cannot throw off the reading",
    one(`standaloneConnectOpts({ creds: "}{", tls: false })`) === "has-key");
  check("the DEFINITION is not counted as a call site",
    fx(`export function standaloneConnectOpts(auth: StandaloneAuth) { return {}; }`).length === 0);
  // Regex-versus-division, the hole that reopened twice under a hand lexer. The keyword case is the
  // one that survived the character-based fix: after `return`, the last character is a letter.
  check("a regex containing `//` does not hide the call that follows it",
    one(`const u = s.replace(/https?:\\/\\//, ""); standaloneConnectOpts({ creds: c })`) === "missing-key");
  check("a regex containing a QUOTE does not swallow later call sites, in VALUE position",
    one(`const q = /['"]/; const s = "it's fine"; standaloneConnectOpts({ creds: c })`) === "missing-key");
  check("...and in KEYWORD position, where a reader that looks at the last CHARACTER sees division",
    one(`function f(s) { return /['"]/.test(s); }\nstandaloneConnectOpts({ creds: c })`) === "missing-key"
    && one(`const t = typeof /['"]/; standaloneConnectOpts({ creds: c })`) === "missing-key");
  check("division is not mistaken for a regex (a value before `/` divides)",
    one(`const r = a / b; standaloneConnectOpts({ creds: c, tls: false })`) === "has-key");
  check("a GENERIC instantiation is the same call, including a NESTED one",
    one(`standaloneConnectOpts<Opts>({ creds: c })`) === "missing-key"
    && one(`standaloneConnectOpts<Record<string, unknown>>({ creds: c })`) === "missing-key");
  check("an OPTIONAL call is the same call", one(`standaloneConnectOpts?.({ creds: c })`) === "missing-key");
  check("a call behind a CAST is the same call",
    one(`(standaloneConnectOpts as (a: unknown) => unknown)({ creds: c })`) === "missing-key"
    && one(`(standaloneConnectOpts satisfies Fn)({ creds: c })`) === "missing-key");
  check("a call inside a TEMPLATE SUBSTITUTION is seen (the text around it is a literal, the call is code)",
    one("`${standaloneConnectOpts({ creds: c })}`") === "missing-key");
  check("a NAMESPACE call is seen, by property and by computed string alike",
    one(`core.standaloneConnectOpts({ creds: c })`) === "missing-key"
    && one(`core["standaloneConnectOpts"]({ creds: c })`) === "missing-key");
  check("a UNICODE ESCAPE in the identifier is the same identifier",
    one(`standaloneConnectOpt\\u0073({ creds: c })`) === "missing-key");
  check("a JSX file is parsed as JSX, so `<T>` there is not mistaken for a tag",
    sitesIn("fixture.tsx", `const el = <div />;\nstandaloneConnectOpts({ creds: c });`, SEAMS[0])[0]?.verdict === "missing-key");

  console.log(" A4. the name escaping to where this reader cannot follow");
  check("a LOCAL ALIAS is flagged", one(`const alias = standaloneConnectOpts;`) === "aliased");
  check("an ALIASED IMPORT is flagged", one(`import { standaloneConnectOpts as connectOpts } from "x";`) === "aliased");
  check("an ALIASED RE-EXPORT is flagged", one(`export { standaloneConnectOpts as connectOpts } from "x";`) === "aliased");
  check("an ALIASED DESTRUCTURE is flagged", one(`const { standaloneConnectOpts: connectOpts } = core;`) === "aliased");
  check("`.call` / `.apply` / `.bind` are flagged, because the argument moves out of the call's own list",
    one(`standaloneConnectOpts.call(undefined, { creds })`) === "aliased"
    && one(`standaloneConnectOpts.apply(undefined, [{ creds }])`) === "aliased");
  check("passing the seam as a VALUE is flagged (Reflect.apply, a callback, anything)",
    one(`Reflect.apply(standaloneConnectOpts, undefined, [{ creds }]);`) === "aliased"
    && one(`register(standaloneConnectOpts);`) === "aliased");
  // The same escape spelled as a STRING, which no rule about identifiers can see. Found by review
  // as a green pass on a real throwing call site: `const f = core["seam"]` reaches the same binding
  // with no identifier naming the seam anywhere in the file.
  check("a STRING-spelled read of the name is a rebinding too",
    one(`const connectOpts = core["standaloneConnectOpts"];`) === "aliased");
  check("...including a computed rename in a destructure",
    one(`const { ["standaloneConnectOpts"]: f } = core;`) === "aliased");
  // The false-red guard for the line above. Review reported the same-name computed form as a
  // regression, having probed `const { ["seam"] } = core`, which is a SyntaxError in Node and in tsc
  // alike; its empty-text recovery node is what made the rule look broken. The form that a program
  // can actually contain is the one below, and it binds the scannable name.
  check("...while the same-name computed destructure binds the name, so it is not a rebinding",
    fx(`const { ["standaloneConnectOpts"]: standaloneConnectOpts } = core;`).length === 0);
  check("...and a file that does not PARSE is refused rather than scanned through its recovery tree",
    one(`const { ["standaloneConnectOpts"] } = core;`) === "unverifiable");
  check("...and a QUOTED import or re-export rename, which is ordinary syntax and states no identifier",
    one(`import { "standaloneConnectOpts" as connectOpts } from "x";`) === "aliased"
    && one(`export { "standaloneConnectOpts" as connectOpts } from "x";`) === "aliased");
  check("...while a quoted specifier that binds the SAME name is not a rebinding",
    fx(`import { "standaloneConnectOpts" as standaloneConnectOpts } from "x";`).length === 0);
  check("...while the string-spelled CALL stays a counted call site, not an alias",
    one(`core["standaloneConnectOpts"]({ creds: c })`) === "missing-key");
  // The false-red guard for the rule above: these bind the name this file already looks for.
  check("a SAME-NAME import, re-export and destructure are NOT rebindings (the live idiom here)",
    fx(`import { standaloneConnectOpts } from "@cotal-ai/core";`).length === 0
    && fx(`export { standaloneConnectOpts } from "@cotal-ai/core";`).length === 0
    && fx(`const { standaloneConnectOpts } = await import("@cotal-ai/core");`).length === 0);
  check("`import { default as standaloneConnectOpts }` binds the scannable name, so it is not a rebinding",
    fx(`import { default as standaloneConnectOpts } from "@cotal-ai/core";`).length === 0);
  // A key NAMES a slot and is not a read, so flagging it would say something untrue.
  check("an object KEY of the same name is not a rebinding",
    fx(`const tbl = { standaloneConnectOpts: mockFn };`).length === 0
    && fx(`const tbl = { ["standaloneConnectOpts"]: mockFn };`).length === 0);
  check("...but its VALUE is asked separately, so a key cannot launder one",
    one(`const tbl = { standaloneConnectOpts: standaloneConnectOpts };`) === "aliased");
  // SHORTHAND is the key and the value at once, and the difference is not academic: review took the
  // value straight back out with `Object.values`, never spelling the key again, so there was nothing
  // left for any rule about names to catch.
  check("SHORTHAND is a value capture, not just a key, and is flagged",
    one(`const tbl = { standaloneConnectOpts };`) === "aliased");
  check("...and reading a table back by name IS caught too",
    one(`const f = tbl.standaloneConnectOpts;`) === "aliased");
  // A destructuring ASSIGNMENT reads the seam exactly as a destructuring DECLARATION does, but the
  // parser spells it as an ordinary object key, which the rule above deliberately allows. Review
  // proved the gap on a real throwing call site, green at the unchanged count; it is ordinary code
  // whenever the variable is declared before the assignment or filled in a loop.
  check("a destructuring ASSIGNMENT that renames is a rebinding, like its `const` twin",
    one(`({ standaloneConnectOpts: connectOpts } = core);`) === "aliased");
  check("...including the computed spelling, which states no identifier at all",
    one(`({ ["standaloneConnectOpts"]: connectOpts } = core);`) === "aliased");
  check("...and the `for...of` assignment target, where there is no `=` to key on",
    one(`for ({ standaloneConnectOpts: connectOpts } of [core]) { connectOpts({ creds: c }); }`) === "aliased");
  check("...while an assignment destructure that binds the SAME name is not a rebinding",
    fx(`({ standaloneConnectOpts } = core);`).length === 0);
  // `noAlias` rather than `length === 0`, because the `for...of` form below carries a real call that
  // is correctly COUNTED: the point of the rule is that the name stays scannable, so the call site
  // showing up is the evidence, not a failure.
  const noAlias = (body: string): boolean => fx(body).every((s) => s.verdict !== "aliased");
  check("...and the ARRAY side of the same split, where a bare identifier can only be a target",
    noAlias(`[standaloneConnectOpts] = pair;`)
    && noAlias(`for ([standaloneConnectOpts] of pairs) { standaloneConnectOpts({ tls: false }); }`)
    && noAlias(`({ k: standaloneConnectOpts } = row);`));
  check("...while the same node in a LITERAL is a read, and stays flagged",
    one(`const arr = [standaloneConnectOpts];`) === "aliased"
    && one(`const row = { k: standaloneConnectOpts };`) === "aliased");

  console.log(" A5. container languages, whose executable part is not this reader's grammar");
  // Found by review, executed rather than argued: it built an `.astro` component calling the seam
  // without the key, ran the real `npm run build` the docs workflow runs, watched the SEAM ITSELF
  // throw during prerender, and watched this check stay green at 93/66. A TypeScript-only walk over
  // a repo that builds Astro on CI is not a walk over the executable sources.
  const astro = (body: string): Site[] => sitesIn("c.astro", body, SEAMS[0]);
  check("an Astro component's FRONTMATTER is read, so a call there is classified like any other",
    astro(`---\nconst r = standaloneConnectOpts({ creds: c });\n---\n<div />`)[0]?.verdict === "missing-key");
  check("...and a WELL-FORMED one is accepted, so the extraction reads rather than merely refusing",
    astro(`---\nconst r = standaloneConnectOpts({ creds: c, tls: false });\n---\n<div />`)[0]?.verdict === "has-key");
  check("...at the real line of the real FILE, not the line of the extracted fragment",
    astro(`---\n// one\n// two\nconst r = standaloneConnectOpts({ creds: c });\n---\n<div />`)[0]?.line === 4);
  // The template half is executable too (Astro evaluates `{expr}` at build time) and is not
  // TypeScript, so it is refused rather than read. Extract what is a program, refuse the rest.
  check("...while the TEMPLATE half is refused rather than read, because it is executable and is not TypeScript",
    astro(`---\nconst x = 1;\n---\n<div>{standaloneConnectOpts({ creds: c })}</div>`)[0]?.verdict === "unverifiable");
  check("...and a component that never names the seam is silent, in both halves",
    astro(`---\nconst x = 1;\n---\n<div>hello</div>`).length === 0
    && astro(`<div>hello</div>`).length === 0);
  const mdx = (body: string): Site[] => sitesIn("d.mdx", body, SEAMS[0]);
  check("a TRIPWIRE container refuses rather than blesses, since it is never parsed at all",
    mdx(`import { standaloneConnectOpts } from "x";`)[0]?.verdict === "unverifiable");
  check("...and is silent when it does not name the seam, so it is a tripwire and not a ban",
    mdx(`# just documentation`).length === 0);
  // Inline `<script>` in HTML/SVG, which five pages here already carry. An earlier cut EXCLUDED
  // these on the reasoning that a browser cannot reach a NATS seam; that reasoning was wrong as
  // stated (browsers run NATS over WebSocket) and the true reason lived in another file, which is
  // the kind of premise that rots unwatched. Reading them means no rationale has to stay true.
  const html = (body: string): Site[] => sitesIn("p.html", body, SEAMS[0]);
  check("an inline MODULE script is read, so a call in a page is classified like any other",
    html(`<!doctype html>\n<script type="module">\nstandaloneConnectOpts({ creds: c });\n</script>`)[0]?.verdict === "missing-key");
  check("...and a CLASSIC script with no type at all is code too",
    html(`<script>\nstandaloneConnectOpts({ creds: c });\n</script>`)[0]?.verdict === "missing-key");
  check("...and a well-formed one is accepted, so the split reads rather than merely refusing",
    html(`<script type="module">\nstandaloneConnectOpts({ creds: c, tls: false });\n</script>`)[0]?.verdict === "has-key");
  check("...at the real line of the real document",
    html(`<!doctype html>\n<body>\n<script type="module">\nstandaloneConnectOpts({ creds: c });\n</script>`)[0]?.line === 4);
  // The remainder is tripwired rather than dropped, because this split is a regex over HTML and a
  // regex over HTML can be wrong. A mis-slice then loses a call into a failure, not into silence.
  check("a script whose TYPE is not JavaScript is not read, and naming the seam there is refused",
    html(`<script type="text/x-template">standaloneConnectOpts({ creds: c })</script>`)[0]?.verdict === "unverifiable");
  check("...as is the seam named in MARKUP, an attribute, or anywhere the split did not treat as code",
    html(`<button onclick="standaloneConnectOpts({ creds: c })">go</button>`)[0]?.verdict === "unverifiable");
  check("...while a document that never names the seam is silent",
    html(`<!doctype html>\n<script type="module">\nconst x = 1;\n</script>`).length === 0);
  // EACH SCRIPT IS ITS OWN PROGRAM, and this is the cell that says why. Review found the container
  // splitter reading two adjacent tags as one source: the browser runs them separately, but a single
  // concatenation puts the second body on the same physical line as the first, so a trailing `//`
  // in the first comments the whole second script out. It parsed clean and stayed GREEN while a
  // tls-less call ran in a real headless browser: the exact failure this file exists to refuse,
  // arrived at through the reader's own seam rather than through a rule.
  check("ADJACENT scripts are separate programs: a trailing line comment cannot swallow the next one",
    html(`<script>ready = true; // bootstrap</script><script type="module">standaloneConnectOpts({ creds: c });</script>`)[0]?.verdict === "missing-key");
  check("...and the swallowed call keeps the real line of the real document, not the program's",
    html(`<!doctype html>\n<body>\n<script>a = 1; // x</script><script>standaloneConnectOpts({ creds: c });</script>`)[0]?.line === 3);
  // The same split must not cost the reach it had while concatenated. Classic scripts share one
  // global scope, so a constant declared in an earlier script still spells the seam in a later one.
  check("a name from ANOTHER script is REFUSED rather than folded, since resolving it means running the page",
    html(`<script>const N = "standaloneConnectOpts";</script>\n<script>core[N]({ creds: c });</script>`)[0]?.verdict === "unverifiable");
  check("...and a LATER script's own constants are collected too, not just the first program's",
    html(`<script>const a = 1;</script>\n<script>const N = "standaloneConnectOpts";\ncore[N]({ creds: c });</script>`)[0]?.verdict === "missing-key");
  // The two shapes that killed the two attempts to MODEL cross-script scope, kept as cells because
  // the refusal is what makes them safe rather than any rule about scope. Both were silent greens
  // while a real browser executed the call; both are now the same loud refusal, and neither depends
  // on this file knowing what a module is or which script ran first.
  check("...so a LATER script rebinding that name cannot hide the call, whatever the browser would do",
    html(`<script>var N = "standaloneConnectOpts";</script>\n<script>core[N]({ creds: c });</script>\n<script>var N = "other";</script>`)[0]?.verdict === "unverifiable");
  // The other side of the refusal, and the one that keeps it from being a blanket. A script that
  // declares the name ITSELF resolves it itself, even when another script declares the same name:
  // the local declaration is what the call reads, so refusing here would be a false red on ordinary
  // code, and this file treats crying wolf as its own kind of failure.
  check("...but a name the script declares ITSELF still folds, even when another script declares it too",
    html(`<script>var N = "other";</script>\n<script>var N = "standaloneConnectOpts";\ncore[N]({ creds: c });</script>`)[0]?.verdict === "missing-key");
  // The rule asks whether a name is resolvable HERE, not where else it came from, and these are the
  // two shapes that killed the version which asked the other question. A helper FUNCTION in another
  // script is an ordinary declaration that a variable-only collector never saw; a name from a
  // `<script src>` is declared in a file this reader is never given. Neither can be proved foreign.
  // Both are trivially not local.
  check("a key built by a helper FUNCTION from another script is refused, not just a variable",
    html(`<script>function k() { return "standaloneConnectOpts"; }</script>\n<script>core[k()]({ creds: c });</script>`)[0]?.verdict === "unverifiable");
  check("...as is a name declared NOWHERE in the document, which is what a `<script src>` leaves behind",
    html(`<script src="v.js"></script>\n<script>core[vendorKey]({ creds: c });</script>`)[0]?.verdict === "unverifiable");
  check("...and a LOCAL helper is refused too, since a local function is still runtime code",
    html(`<script>const a = 1;</script>\n<script>function k() { return "x"; }\ncore[k()]({ creds: c });</script>`)[0]?.verdict === "unverifiable");
  check("...as is a key holding NO identifier at all, which is where asking about names ran out",
    html(`<script>String.prototype.k = function () { return "standaloneConnectOpts"; };</script>\n<script>core["".k()]({ creds: c });</script>`)[0]?.verdict === "unverifiable");
  // The fence is the DOCUMENT's programs, not every computed call in the repository. A plain source
  // is one program, so an unfoldable key there is the residual this file already documents and the
  // population count already covers; refusing it would redden ordinary code across the tree.
  check("a computed key in a PLAIN source stays the documented residual, since only a document is fenced",
    fx(`const r = core[k()]({ creds: c });`).length === 0);
  // ORDER WITHIN one program, which is where the retreat stopped one dimension short. The folding
  // map is last-wins over the whole program, so a redeclaration written AFTER a call retroactively
  // changed what the call appeared to be spelled with, and a seam call went silent while a browser
  // ran it. The fold is only trusted for a name declared once.
  check("a redeclaration written AFTER the call cannot retroactively hide it: the key is refused",
    html(`<script>var N = "standaloneConnectOpts";\ncore[N]({ creds: c });\nvar N = "unrelated";</script>`)[0]?.verdict === "unverifiable");
  check("...and the same holds in a PLAIN source, where the fold is last-wins for the same reason",
    fx(`var N = "standaloneConnectOpts";\ncore[N]({ creds: c });\nvar N = "unrelated";`)[0]?.verdict === "unverifiable");
  check("...while a name declared ONCE still folds and is classified, so the fold survives being honest",
    fx(`var N = "standaloneConnectOpts";\ncore[N]({ creds: c });`)[0]?.verdict === "missing-key");
  // The bound that keeps this off ordinary code: a name redeclared with values that are never the
  // seam cannot make any call the seam, whatever the order. Without it the rule reddened two
  // vendored bundles, where short names are reused constantly and none of it concerns this seam.
  check("...and a name redeclared with values that are never the seam is not refused at all",
    fx(`var e = "a";\nvar e = "b";\ncore[e]({ creds: c });`).length === 0);
  check("...and a local name that folds to something ELSE is not the seam, so it is not refused either",
    html(`<script>var N = "other";</script>\n<script>var N = "unrelated";\ncore[N]({ creds: c });</script>`).length === 0);
  check("...and the same holds when the rebinding is a MODULE, whose scope is not the page's at all",
    html(`<script>const N = "standaloneConnectOpts";</script>\n<script>core[N]({ creds: c });</script>\n<script type="module">const N = "other";</script>`)[0]?.verdict === "unverifiable");
  check("...while a module still folds its OWN constants, so the split does not cost it that",
    html(`<script>const a = 1;</script>\n<script type="module">const N = "standaloneConnectOpts";\ncore[N]({ creds: c });</script>`)[0]?.verdict === "missing-key");

  // ASSIGNMENT, not just redeclaration. The folding map is built from DECLARATIONS, so an ordinary
  // reassignment never reached it and the map kept answering with the declared value. Adversarial
  // review executed the silent direction on a real tree: the call below was not counted at all, the
  // file was never named, and the suite stayed green while that call reaches the seam and throws.
  check("a name ASSIGNED the seam after being declared something else is refused, not folded to the stale value",
    fx(`let m = "otherConnect";\nm = "standaloneConnectOpts";\ncore[m]({ creds: c });`)[0]?.verdict === "unverifiable");
  check("...and a bare `let` assigned the seam afterwards is the same two bindings, so it is refused too",
    fx(`let m: string;\nm = "standaloneConnectOpts";\ncore[m]({ creds: c });`)[0]?.verdict === "unverifiable");
  check("...and the OPPOSITE order is refused as well, so the rule does not depend on which line came first",
    fx(`let m = "standaloneConnectOpts";\nm = "otherConnect";\ncore[m]({ creds: c });`)[0]?.verdict === "unverifiable");
  // The same bound as the redeclaration rule: a name whose bindings never spell the seam cannot make
  // any call the seam, so refusing it would say nothing and would redden ordinary reassignment.
  check("...while a name reassigned among values that are NEVER the seam is not refused (not a false red)",
    fx(`let m = "a";\nm = "b";\ncore[m]({ creds: c });`).length === 0);

  // A STRINGLY DISPATCH TABLE is the person-shaped computed key: same file, no runtime value, and
  // obvious to a human reader. This is a FOLD rather than a fence, so it makes the reader see the
  // call and classify it; it cannot turn unrelated code red the way a refusal can.
  check("a key read from a same-file const TABLE folds, so the call is seen and classified",
    fx(`const API = { connect: "standaloneConnectOpts" };\ncore[API.connect]({ creds: c });`)[0]?.verdict === "missing-key");
  check("...including through a quoted index into that table, which is the same spelling",
    fx(`const API = { connect: "standaloneConnectOpts" };\ncore[API["connect"]]({ creds: c });`)[0]?.verdict === "missing-key");
  check("...and such a call that STATES the key passes, so folding more did not start failing everything",
    fx(`const API = { connect: "standaloneConnectOpts" };\ncore[API.connect]({ creds: c, tls: false });`)[0]?.verdict === "has-key");
  check("...while a table whose values are never the seam yields no site at all (not a false red)",
    fx(`const API = { connect: "otherConnect" };\ncore[API.connect]({ creds: c });`).length === 0);

  // The fold reads only what the program SETTLES, which is the same surgery as the multiply-bound
  // rule one level down. A property the program reassigns, or one a later spread can overwrite, is
  // not settled by its initializer, and folding it anyway is a FALSE RED rather than a miss: the
  // reader names a call the seam while the program calls something else. Review executed both.
  check("a table property REASSIGNED afterwards is not settled, so the call is not claimed (false red guard)",
    fx(`const T = { k: "standaloneConnectOpts" };\nT.k = "other";\ncore[T.k]({ creds: c });`).length === 0);
  check("...including through a quoted index assignment, which writes the same property",
    fx(`const T = { k: "standaloneConnectOpts" };\nT["k"] = "other";\ncore[T.k]({ creds: c });`).length === 0);
  check("...and an index assignment this file cannot read unsettles the WHOLE table, since it may hit any key",
    fx(`const T = { k: "standaloneConnectOpts" };\nT[pick()] = "other";\ncore[T.k]({ creds: c });`).length === 0);
  check("...and a SPREAD after the property can overwrite it, so that property is not settled either",
    fx(`const T = { k: "standaloneConnectOpts", ...rest };\ncore[T.k]({ creds: c });`).length === 0);
  check("...and a computed name this file cannot read has the same reach as a spread",
    fx(`const T = { k: "standaloneConnectOpts", [pick()]: "other" };\ncore[T.k]({ creds: c });`).length === 0);
  // The other direction, so the settlement rule cannot quietly become a blanket that folds nothing.
  check("...while a spread BEFORE the property leaves it settled, because the literal key wins",
    fx(`const T = { ...rest, k: "standaloneConnectOpts" };\ncore[T.k]({ creds: c });`)[0]?.verdict === "missing-key");
  check("...and an assignment to a DIFFERENT property leaves this one settled",
    fx(`const T = { k: "standaloneConnectOpts", other: "x" };\nT.other = "y";\ncore[T.k]({ creds: c });`)[0]?.verdict === "missing-key");

  // Enumerating mutation ROUTES is the losing shape, and this file has lost it four times. A table
  // that leaves this reader's sight can be mutated through a name the sweep never looked at, so the
  // question is not which route was missed but whether the table stays where it can be seen. Both of
  // the shapes below were measured producing a FALSE RED before this rule existed.
  check("a table ALIASED to another name can be mutated through the alias, so it is not settled",
    fx(`const T = { k: "standaloneConnectOpts" };\nconst U = T;\nU.k = "other";\ncore[T.k]({ creds: c });`).length === 0);
  check("...and a table HANDED to something else can be mutated by it, whatever that something does",
    fx(`const T = { k: "standaloneConnectOpts" };\nObject.assign(T, { k: "other" });\ncore[T.k]({ creds: c });`).length === 0);
  check("...and an EXPORTED table is reachable from files this reader never opens",
    fx(`export const T = { k: "standaloneConnectOpts" };\ncore[T.k]({ creds: c });`).length === 0);
  check("...and one RETURNED from a function is handed out just as plainly",
    fx(`const T = { k: "standaloneConnectOpts" };\nexport function get() { return T; }\ncore[T.k]({ creds: c });`).length === 0);
  // The other direction again, so "stays where it can be seen" cannot collapse into "fold nothing".
  check("...while a table only ever READ through its properties stays settled and still folds",
    fx(`const T = { k: "standaloneConnectOpts" };\nconst other = T.k.length;\ncore[T.k]({ creds: c });`)[0]?.verdict === "missing-key");

  // The multiply-bound rule one level up. This map is last-wins over the whole file and the reader
  // has no scope, so a table declared in some OTHER function decides what this one folds to.
  check("a table name DECLARED more than once is not settled, since this reader has no scope",
    fx(`const T = { k: "otherConnect" };\nfunction f() { const T = { k: "standaloneConnectOpts" }; return T.k; }\ncore[T.k]({ creds: c });`).length === 0);
  check("...while a table declared exactly ONCE still folds, so the shadow rule is not a blanket",
    fx(`const T = { k: "standaloneConnectOpts" };\ncore[T.k]({ creds: c });`)[0]?.verdict === "missing-key");

  // THE DOOR CENSUS, executed rather than described. The docblock paragraph headed THE DOOR'S OTHER
  // SPELLINGS names five table shapes the fold map does not admit, each measured silent. Prose rots:
  // this file spent several rounds asserting the door was "two lines wide" when it is five, inside
  // the very paragraph this cell now guards, and nothing caught it because a paragraph checks
  // nothing. A paragraph plus a cell that runs the paragraph cannot silently diverge.
  //
  // This is a MEASUREMENT, not a pin on a hole, and the distinction is what a failure here means. If
  // this cell reds, the door moved in one direction or the other and the census is now WRONG: update
  // the paragraph to match what the reader does. It does not say these five ought to stay silent.
  // The control carries the weight, because five silent probes and a harness that stopped running
  // produce identical output; only a probe that must be SEEN separates them.
  //
  // Two boundaries on this cell, because neither is visible from the cell itself. It does NOT guard
  // REACH: if the walk stopped handing plain sources to the classifier, these fixtures would still
  // pass. Reach belongs to the tree-tied family (the walk-reach cell, the per-extension cells, the
  // exact counts), and the two families cover what neither covers alone, so this premise holds only
  // while BOTH exist. Anyone reading one family as redundant and deleting it takes the other's cover
  // with it. It also does not bound the door's CONSEQUENCE: see the composition note in the
  // docblock, where a door spelling plus a compensating call defeats the counts outright.
  //
  // The IN-TREE form was considered and declined. The five spellings are misses, so planting them as
  // real files would leave the population at 94 and a cell could assert exactly that. It is declined
  // because files deliberately spelling the seam name are the intent hazard in tree form, the one
  // that already survived two reviews here, and because it would spend the tree-independence that is
  // the fixture form's whole advantage.
  const DOOR: Record<string, boolean> = {
    "CONTROL, a plain table, must be SEEN":
      fx(`const T = { k: "standaloneConnectOpts" };\ncore[T.k]({ creds: c });`)[0]?.verdict === "missing-key",
    "a nested table, read through a path":
      fx(`const T = { a: { k: "standaloneConnectOpts" } };\ncore[T.a.k]({ creds: c });`).length === 0,
    "a key destructured out of a table":
      fx(`const T = { k: "standaloneConnectOpts" };\nconst { k } = T;\ncore[k]({ creds: c });`).length === 0,
    "a table destructured out of a literal":
      fx(`const { T } = { T: { k: "standaloneConnectOpts" } };\ncore[T.k]({ creds: c });`).length === 0,
    "a table wrapped in Object.freeze":
      fx(`const T = Object.freeze({ k: "standaloneConnectOpts" });\ncore[T.k]({ creds: c });`).length === 0,
    "a getter-valued property, which has no initializer to fold":
      fx(`const T = { get k() { return "standaloneConnectOpts"; } };\ncore[T.k]({ creds: c });`).length === 0,
  };
  check("the DOOR CENSUS still measures what the docblock claims: control SEEN, five SAMPLED spellings silent",
    Object.values(DOOR).every(Boolean),
    { moved: Object.entries(DOOR).filter(([, ok]) => !ok).map(([k]) => k),
      action: "the door changed direction; update THE DOOR'S OTHER SPELLINGS in the docblock to match" });

  // The seam throws on `undefined`, and a `const` bound to it is exactly that value spelled in two
  // steps. Review passed this through as a COUNTED, GREEN site while it threw at runtime.
  check("a `const` bound to `undefined` states the key as undefined, which is what the seam throws on",
    one(`const t = undefined;\nstandaloneConnectOpts({ creds: c, tls: t });`) === "missing-key");
  check("...while a `let` bound to undefined is NOT claimed, since it can hold a real boolean later",
    one(`let t = undefined;\nt = false;\nstandaloneConnectOpts({ creds: c, tls: t });`) !== "missing-key");
  // SHORTHAND states the key AND reads a binding of that name, so it carries a value. Reading only
  // PropertyAssignment let this pass as has-key while the seam threw, and review proved it on a real
  // counted site rewritten IN PLACE: counts unmoved at 94/67, every cell green, call throwing.
  check("...and SHORTHAND carries the same value, since `{ tls }` reads a binding of that very name",
    one(`const tls = undefined;\nstandaloneConnectOpts({ creds: c, tls });`) === "missing-key");
  check("...while shorthand holding a real boolean is untouched, so this is not a blanket on shorthand",
    one(`const tls = false;\nstandaloneConnectOpts({ creds: c, tls });`) !== "missing-key");
  // A DECLARATION WITH NO INITIALIZER states the very value the seam throws on, one spelling over
  // from the case above. The first rule demanded an initializer to read and so never visited these
  // at all: both passed as counted, green sites while the seam threw.
  check("`let tls;` with no initializer IS undefined at the call, which is what the seam throws on",
    one(`let tls;\nstandaloneConnectOpts({ creds: c, tls });`) === "missing-key");
  check("...and `var tls;` likewise, since the spelling of the declaration is not the fact",
    one(`var tls;\nstandaloneConnectOpts({ creds: c, tls });`) === "missing-key");
  // ORDER on the value, the rule the key has carried since round 19. The kept-direction cell below
  // covered undefined-then-real; real-then-undefined was invisible, and green while the seam threw.
  check("a value made undefined AFTER a real boolean is not answered from the declaration",
    one(`let tls = false;\ntls = undefined;\nstandaloneConnectOpts({ creds: c, tls });`) === "unverifiable");
  check("...and the mirror is refused too, not called undefined, since neither claim is supportable",
    one(`let tls = undefined;\ntls = false;\nstandaloneConnectOpts({ creds: c, tls });`) === "unverifiable");
  check("...while a name bound ONCE to undefined is settled, so `const` was never what made it safe",
    one(`let tls = undefined;\nstandaloneConnectOpts({ creds: c, tls });`) === "missing-key");
  check("...and a compound assignment counts as a binding, so `||=` cannot settle what it rewrites",
    one(`let tls = undefined;\ntls ||= false;\nstandaloneConnectOpts({ creds: c, tls });`) === "unverifiable");
  // THE LOAD-BEARING GREEN. A parameter is bound zero times by this counter, and the house idiom is
  // a destructured parameter fed straight into the call. If this goes red the check is unusable.
  check("a PARAMETER value stays green, since this file binds it nowhere and claims nothing about it",
    one(`function f({ tls }: any) { return standaloneConnectOpts({ creds: c, tls }); }`) === "has-key");
  check("...and a PLAIN identifier parameter shadows it as well, which is a different branch entirely",
    one(`const tls = undefined;\nfunction f(tls: any) { return standaloneConnectOpts({ creds: c, tls }); }`) === "has-key");
  // A REBINDING does not have to be `x = v`. Review found three routes that are not, and each one
  // was a green while the program ran on a value this reader had answered from the declaration.
  check("a value rebound through an OBJECT assignment pattern is not answered from its declaration",
    one(`let tls: any = false;\n({ tls } = { tls: undefined });\nstandaloneConnectOpts({ creds: c, tls });`) === "unverifiable");
  check("...and through an ARRAY assignment pattern, which writes the name without naming it on the left",
    one(`let tls: any = false;\n[tls] = [undefined];\nstandaloneConnectOpts({ creds: c, tls });`) === "unverifiable");
  check("...and by a for-of, which rebinds on every pass and is no assignment expression at all",
    one(`let tls: any = false;\nfor (tls of [undefined]) standaloneConnectOpts({ creds: c, tls });`) === "unverifiable");
  // The same routes in KEY position, where the fold answers which key the call states.
  check("a KEY rebound through an assignment pattern does not fold, so the stated key cannot be faked",
    one(`let K = "tls";\n({ K } = { K: "other" });\nstandaloneConnectOpts({ creds: c, [K]: false });`) === "missing-key");
  check("...and a KEY rebound by a for-of does not fold either",
    one(`let K = "tls";\nfor (K of ["other"]) standaloneConnectOpts({ creds: c, [K]: false });`) === "missing-key");
  // DESTRUCTURING declarations: read the ones written out here, decline the ones that are not.
  check("a destructured local IS read when what it takes apart is written out right here",
    one(`const { tls } = { tls: undefined as any };\nstandaloneConnectOpts({ creds: c, tls });`) === "missing-key");
  check("...including an absent property, which is exactly the undefined the seam throws on",
    one(`const { tls } = { other: 1 } as any;\nstandaloneConnectOpts({ creds: c, tls });`) === "missing-key");
  check("...while the same shape holding a real boolean is untouched",
    one(`const { tls } = { tls: false };\nstandaloneConnectOpts({ creds: c, tls });`) === "has-key");
  check("...and one taken from a value this file cannot read is DECLINED, not claimed",
    one(`const { tls } = cfg;\nstandaloneConnectOpts({ creds: c, tls });`) === "has-key");
  check("...and a RENAME binds the new name, not the property name it reads from",
    one(`function f({ tls: renamed }: any) { const tls = undefined as any; return standaloneConnectOpts({ creds: c, tls }); }`) === "missing-key");
  check("a for-of DECLARATION is bound by the iteration, so it is not read as an undefined declaration",
    one(`for (const tls of [true, false]) standaloneConnectOpts({ creds: c, tls });`) === "has-key");
  check("...and a DESTRUCTURED local shadows it too, since the walk stops at any binding of the name",
    one(`const tls = undefined;\nfunction f(cfg: any) { const { tls } = cfg; return standaloneConnectOpts({ creds: c, tls }); }`) === "has-key");
  check("...and a CATCH variable likewise, which parses as a declaration with no initializer and is not one",
    one(`const tls = undefined;\nfunction f() { try { g(); } catch (tls) { return standaloneConnectOpts({ creds: c, tls }); } }`) === "has-key");
  check("...and a name this file never binds at all, an import say, is not claimed in either direction",
    one(`import { tls } from "./x";\nstandaloneConnectOpts({ creds: c, tls });`) === "has-key");
  check("...and a nested FUNCTION of the name shadows an outer undefined binding, since it binds it too",
    one(`const tls = undefined;\nfunction f() { function tls() { return 1; } return standaloneConnectOpts({ creds: c, tls }); }`) === "has-key");
  check("...as does a nested CLASS of the name, which binds it by the same rule",
    one(`const tls = undefined;\nfunction f() { class tls {} return standaloneConnectOpts({ creds: c, tls }); }`) === "has-key");
  check("...and a parameter SHADOWING an outer undefined binding stays green, since it is not that name",
    one(`const tls = undefined;\nfunction f({ tls }: any) { return standaloneConnectOpts({ creds: c, tls }); }`) === "has-key");

  // The VALUE rule has no scope either, so it is held to the same settlement discipline as the key.
  // Review reddened an ordinary file: one function with a dead `const tls = undefined`, another
  // calling the seam with `const tls = false`. The dead path answered for the live call.
  check("a dead `const tls = undefined` in ANOTHER function does not redden a live call's own `tls`",
    one(`function a() { const tls = undefined; return tls; }\nfunction b() { const tls = false; return standaloneConnectOpts({ creds: c, tls }); }`) === "has-key");
  // A NESTED function is another scope too, in both directions. Mutation caught this pair missing:
  // the scope boundary lives in two places, the walk outward and the refusal to descend, and the
  // cell above exercises neither, since two sibling functions are invisible to both spellings.
  check("a NESTED function's own `tls` does not answer for the enclosing function's call",
    one(`function outer() { const tls = false; function inner() { const tls = undefined; return tls; } inner(); return standaloneConnectOpts({ creds: c, tls }); }`) === "has-key");
  check("...and the nested call is answered by the nested binding, not by the one it shadows",
    one(`function outer() { const tls = false; function inner() { const tls = undefined; return standaloneConnectOpts({ creds: c, tls }); } return inner(); }`) === "missing-key");
  check("...and the same file with only the dead binding still reds, so scope did not become a blanket",
    one(`function a() { const tls = undefined; return standaloneConnectOpts({ creds: c, tls }); }`) === "missing-key");

  // A computed ARGUMENT key folds by the arithmetic the SEAM's own name already folds by. The
  // asymmetry was a FALSE RED: this reader would fold a key to FIND a call and then refuse to fold
  // one to READ it, reporting the key missing from a call that states it.
  check("a computed ARGUMENT key that FOLDS states the key, by the arithmetic the seam's name uses",
    one(`const TLS = "tls";\nstandaloneConnectOpts({ creds: c, [TLS]: false });`) === "has-key");
  check("...including one assembled from literals, so a key folds alike in both positions",
    one(`standaloneConnectOpts({ creds: c, ["tl" + "s"]: false });`) === "has-key");
  // A multiply-bound key is REFUSED in argument position and reads as unverifiable in CALLEE
  // position, and that is not an inconsistency to be tidied away: they are different programs. In
  // argument position the value at the call is unknowable, so nothing can be claimed about the key;
  // in callee position the same arithmetic says this call is knowably not the seam's. Each position
  // answers its own question, and making them agree would make one of them wrong.
  check("...while a key that does NOT fold stays opaque, so folding did not become a blanket",
    one(`standaloneConnectOpts({ creds: c, [pick()]: false });`) === "missing-key");
  // A computed key folds through a TABLE PATH in the seam's own position, so it folds here too. The
  // gap made `{ [KEYS.transport]: false }` a false red on a call that states the key plainly.
  check("...and an argument key folds through a const TABLE, the arithmetic the seam's name uses",
    one(`const KEYS = { transport: "tls" };\nstandaloneConnectOpts({ creds: c, [KEYS.transport]: false });`) === "has-key");
  // THE SAME ORDER RULE, in argument-key position. Review rewrote a real counted site in place to
  // `let K = "tls"; K = "other"; seam({ creds, [K]: false })`: the fold answered from the
  // declaration, the runtime key was `other`, the seam threw, and the suite stayed green at 94/67.
  check("an argument key this file binds more than once does not fold, so a rewritten key cannot pass",
    one(`let K = "tls";\nK = "other";\nstandaloneConnectOpts({ creds: c, [K]: false });`) === "missing-key");
  check("...and the same holds when the LAST binding is the key, since order is not what settles it",
    one(`let K = "other";\nK = "tls";\nstandaloneConnectOpts({ creds: c, [K]: false });`) === "missing-key");
  check("...while a key bound exactly once still folds, so settlement did not disable the fold",
    one(`let K = "tls";\nstandaloneConnectOpts({ creds: c, [K]: false });`) === "has-key");

  // A TYPE's method slot and an enum member NAME a slot; neither can hand anyone the seam. Review
  // reddened a typed facade that declared the seam's shape with no call anywhere in the file.
  check("an interface METHOD SLOT of the seam's name is a slot, not a rebinding, and is no call",
    fx(`export interface H { standaloneConnectOpts(a: { tls: boolean }): void; }`).length === 0);
  check("...as is an ENUM MEMBER of that name, which can only ever reach a number",
    fx(`enum E { standaloneConnectOpts = 1 }`).length === 0);
  check("...while an actual rebinding of the name is still refused, so the slot rule is narrow",
    fx(`const f = standaloneConnectOpts;`).length === 1);
  // Separate parsing must not turn a neighbour's syntax error into silence for the whole document.
  check("a script that does not PARSE refuses the document rather than scanning its recovery tree",
    html(`<script>function (</script>\n<script>standaloneConnectOpts({ creds: c });</script>`)[0]?.verdict === "unverifiable");
  check("...and a LATER script's syntax error refuses it just the same, so the refusal is not first-only",
    html(`<script>standaloneConnectOpts({ creds: c });</script>\n<script>function (</script>`)[0]?.verdict === "unverifiable");
  check("a BARE DEFAULT import binds the scannable name, so it is not a rebinding",
    fx(`import standaloneConnectOpts from "@cotal-ai/core";`).length === 0);
  // The residual both reviews called ordinary rather than exotic, and they were right: this is
  // arithmetic a reader does by eye, so the reader does it too.
  check("a key ASSEMBLED from literals is the same spelling, and is folded",
    one(`const f = core["standalone" + "ConnectOpts"];`) === "aliased");
  // A template whose spans all fold is the same arithmetic with different punctuation. Folding `+`
  // while declining this would be a promise this file does not keep.
  check("...and a TEMPLATE whose spans all fold is the same arithmetic",
    one('const f = core[`standalone${"ConnectOpts"}`];') === "aliased");
  check("...including through a same-file `const`",
    one(`const k = "standalone" + "ConnectOpts";\nconst f = core[k];`) === "aliased"
    && one(`const k = "standaloneConnectOpts";\nconst { [k]: f } = core;`) === "aliased");
  check("...while a call through such a key is a counted CALL, not an escape",
    one(`const k = "standaloneConnectOpts";\ncore[k]({ creds: c })`) === "missing-key");
  check("the name handed to a REFLECTIVE get as data is an escape",
    one(`const f = Reflect.get(core, "standaloneConnectOpts");`) === "aliased");
  check("a TYPE named like the seam declares a type, and cannot invoke anything",
    fx(`type standaloneConnectOpts = (a: unknown) => unknown;`).length === 0
    && fx(`interface standaloneConnectOpts { x: number }`).length === 0);
  check("a `typeof` type query cannot invoke anything, so it is not a rebinding",
    fx(`type F = typeof standaloneConnectOpts;`).length === 0);
}

// The two predicates every tree-wide verdict rests on, driven DIRECTLY rather than trusted. Review
// changed one token here (dropping `unverifiable` from the counted set), dropped a real refusal file
// into the tree, and the suite stayed GREEN at the right count: every fixture cell above calls the
// classifier, and nothing asked whether a refusal still reaches the completeness check. A refusal is
// red only because these say so.
{
  const one = (verdict: Verdict): Site => ({ file: "p.html", line: 1, verdict, detail: "" });
  const refused = summarize([one("unverifiable")]);
  check("a REFUSAL is counted as a site and FAILS completeness, which is the only reason a refusal is red",
    refused.sites.length === 1 && refused.bad.length === 1);
  const stated = summarize([one("has-key")]);
  check("...while a stated key is counted and PASSES, so the aggregation is not simply failing everything",
    stated.sites.length === 1 && stated.bad.length === 0);
  check("...and an ALIAS is kept out of the count, since its own cell is what judges it",
    summarize([one("aliased")]).sites.length === 0 && summarize([one("aliased")]).aliased.length === 1);
}

console.log("\nB. the seam, across every source the compiler may or may not read");
const files = sources(ROOT);
check("the scan reached a source tree at all (a zero-file walk would pass every cell below)", files.length > 500, files.length);

// NO INSTRUMENT CHECKS ITS OWN BOUNDARY UNLESS IT IS MADE TO. The reach hole review found was not a
// wrong rule, it was an extension nobody had decided about, and nothing in here would ever have
// said so. This asserts every container language actually PRESENT in the tree has a decision on the
// record, so adding a `.vue` is a red that asks the question rather than a silence that answers it.
// And the reach half of the same point: every container cell above calls the classifier DIRECTLY,
// so all of them would still pass if the WALK stopped admitting container files. A fixture proves
// the reader; only the real tree proves it is reached. This floor is tied to the components that
// exist here today.
// Per EXTENSION rather than as a total, because a total is defeated by arithmetic: once `.svg`
// contributes nineteen files, a floor of seven survives `.html` being dropped from the walk
// entirely. Each declared container that EXISTS here must actually appear in the walked set.
const walkedExts = new Set(files.map((f) => extOf(f)));
const unwalked = Object.keys(CONTAINERS).filter((x) => extensionsPresent(ROOT).has(x) && !walkedExts.has(x));
check("the WALK admits every declared container extension present in the tree, not just the classifier",
  unwalked.length === 0, unwalked);

const present = extensionsPresent(ROOT);
const undecided = CONTAINER_WATCHLIST.filter((x) => present.has(x) && !CONTAINERS[x]);
check("every container language present in this tree has a recorded decision, read or tripwire",
  undecided.length === 0, undecided);


for (const seam of SEAMS) {
  const all = files.flatMap((f) => sitesIn(relative(ROOT, f), readFileSync(f, "utf8"), seam));
  const { sites, aliased, bad, untypechecked } = summarize(all);
  // Printed on SUCCESS as well as failure: a legitimate removal then shows the number to put back,
  // instead of sending the next author into this file to find out what the floor should become.
  console.log(`  · ${seam.fn}: ${sites.length} call sites (${untypechecked.length} under smoke/, ${sites.length - untypechecked.length} typechecked)`);
  check(`\`${seam.fn}\`: every call site states \`${seam.key}\``, bad.length === 0,
    bad.map((s) => `${s.file}:${s.line} [${s.verdict}] ${s.detail}`));

  check(`\`${seam.fn}\`: the name is never rebound, so no call can hide behind an alias`, aliased.length === 0,
    aliased.map((s) => `${s.file}:${s.line} ${s.detail}`));

  // THE POPULATION. Without it this check degrades into a green that means nothing: a rename, a
  // wrapper, or a reader that stops matching all produce "no bad sites" out of "no sites at all".
  //
  // These were FLOORS (`>=`) until adversarial review executed the cost of the slack. With the live
  // population one above each floor, it rewrote a single counted site into a form the reader could
  // not see, the count fell to exactly the floor, and every cell stayed green while a call that
  // throws at runtime sat in the tree. Slack of one is one free silent hide, so the counts are now
  // matched EXACTLY: any movement, in either direction, is a call site added, removed, or hidden,
  // and each of those deserves a human look rather than an inequality that absorbs it.
  //
  // The cost is honest and small: a PR that legitimately adds or removes a seam call site updates
  // one number here, and the failure prints both counts so there is nothing to work out. What this
  // still cannot do is notice a site that moves BETWEEN files, since a count carries no identity,
  // which is why the reader above refuses what it cannot resolve instead of relying on this.
  check(`\`${seam.fn}\`: the scan finds EXACTLY ${seam.sites} call sites (if you added or removed one, update this number deliberately)`,
    sites.length === seam.sites, { found: sites.length, expected: seam.sites });

  // Split from the total on purpose. The half the compiler cannot see is the whole reason this file
  // exists, and a bare "> 0" here would be satisfied by a single smoke site while the rest vanished.
  check(`\`${seam.fn}\`: EXACTLY ${seam.untypecheckedSites} of them are under smoke/, which no tsconfig includes`,
    untypechecked.length === seam.untypecheckedSites, { found: untypechecked.length, expected: seam.untypecheckedSites });
}

console.log(`\n${fail === 0 ? "REQUIRED-ARG SEAM SMOKE OK ✅" : "REQUIRED-ARG SEAM SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
