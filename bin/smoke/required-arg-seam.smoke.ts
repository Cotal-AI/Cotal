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
 * IT READS THE REAL GRAMMAR, via the TypeScript parser, and that is a correctness requirement rather
 * than a convenience. The first two cuts of this file scanned text with a hand lexer and a call
 * regex, and both were defeated by ordinary code rather than by anything contrived. A regex literal
 * containing a quote opened a phantom string that blanked every later call site in the file, so the
 * lexer learned regexes; then the same hole reopened one keyword away, because `/` after `return` or
 * `typeof` looks like division to anything that decides by the last CHARACTER. The floor cells do
 * not cover that: a file hidden from its first line never increments the count, so an exact floor
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
 * severe: the check then reads as coverage and is not. Failing to SEE a site is caught by the floor
 * cells, which is why a count is part of the instrument rather than trivia.
 *
 * WHAT THIS DOES NOT CATCH, so nobody mistakes it for more than it is: it checks that the argument
 * is PASSED, never that its value is right. `tls: false` against a TLS broker is a wrong value and
 * this check is blind to it, by design, because the seam it guards demands a decision rather than a
 * particular decision. The one value it does judge is an `undefined` written AT THE CALL, on any
 * branch, which is not a boolean and which the seam throws on, so stating the key that way counts as
 * omitting it. A value held in a VARIABLE is not judged and cannot be: `{ tls }` and `{ tls: flag }`
 * are the same statement to this file, and deciding what the variable holds is symbol resolution. It
 * also
 * cannot see through a WRAPPER: a function that takes an options object and passes it on is a call
 * site whose own argument is an identifier, which lands as `unverifiable` rather than as a pass.
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
 * What it still cannot refuse is a key this file cannot evaluate: one computed from a runtime value,
 * a function's return (`["standalone", "ConnectOpts"].join("")` reaches the same binding), or an
 * import it would have to resolve. Closing those means executing the program or running a type
 * checker, which is a different instrument rather than a better rule, and the floors are the only
 * cover they have.
 *
 * It also has NO SCOPE. Any local that happens to share the seam's name is read as the seam, so a
 * parameter or variable of that name used as a value is flagged, and a call to it is classified.
 * Both directions are conservative, neither has an occupant here, and resolving them is the same
 * type checker as above. The folding map INHERITS that blindness: it is file-wide and the last
 * declaration in source order wins, so two same-named bindings in different scopes fold to whichever
 * is written later. It also reads `let` as well as `const`, which the wording above should not be
 * taken to deny; a reassigned `let` therefore folds to its first value, which can invent an escape
 * that the program does not contain. Both are the conservative direction, which is the one to be on.
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
 *  therefore needing a static reader for the call sites the compiler never sees. The two floors are
 *  the counts measured when this was last edited; see the floor cells for why they are here. */
type Seam = { fn: string; key: string; floor: number; untypecheckedFloor: number };
const SEAMS: Seam[] = [
  { fn: "standaloneConnectOpts", key: "tls", floor: 93, untypecheckedFloor: 66 },
];

/**
 * Directories the walk does not enter, named one by one on purpose. An earlier cut skipped every
 * dot-directory with a single `startsWith(".")`, which is a hole nobody wrote down: a source file
 * under any dotted path was unreachable to this check and to its floors alike. If a new dotted
 * directory ever holds vendored code, add it here, so that the skip is a decision on the record.
 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".internal", "build", "coverage", ".next", "out"]);
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"];

function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      sources(p, acc);
    } else if (EXTS.some((x) => e.name.endsWith(x))) acc.push(p);
  }
  return acc;
}

/** JSX is a different grammar, so a `.tsx` parsed as `.ts` mis-reads `<T>` and can drop call sites. */
const parse = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    /\.(tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : undefined);

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
function foldString(e: ts.Expression, consts: Map<string, string>): string | undefined {
  const x = unwrap(e);
  if (ts.isStringLiteralLike(x)) return x.text;
  if (ts.isIdentifier(x)) return consts.get(x.text);
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = foldString(x.left, consts), r = foldString(x.right, consts);
    return l !== undefined && r !== undefined ? l + r : undefined;
  }
  // A template whose spans ALL fold is the same arithmetic as `+`, done with different punctuation:
  // `` `standalone${"ConnectOpts"}` `` is as static as `"standalone" + "ConnectOpts"`. Declining it
  // while folding `+` would be a promise this file does not keep. A span that does not fold (a call,
  // a runtime value) makes the whole template unfoldable, which is the documented residual.
  if (ts.isTemplateExpression(x)) {
    let out = x.head.text;
    for (const span of x.templateSpans) {
      const v = foldString(span.expression, consts);
      if (v === undefined) return undefined;
      out += v + span.literal.text;
    }
    return out;
  }
  return undefined;
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
      || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p)
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
 * expressions, which is a different instrument; the floors are the only cover it has.
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

const isProvablyUndefined = (e: ts.Expression): boolean => {
  const x = unwrap(e);
  return (ts.isIdentifier(x) && x.text === "undefined") || ts.isVoidExpression(x);
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
function propertyNames(name: ts.PropertyName | undefined, key: string): boolean {
  if (!name) return false;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text === key;
  if (ts.isComputedPropertyName(name)) {
    const e = unwrap(name.expression);
    return ts.isStringLiteralLike(e) && e.text === key;
  }
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
function classify(arg: ts.Expression | undefined, key: string, src: ts.SourceFile): { verdict: Verdict; detail: string } {
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
        && !ts.isStringLiteralLike(unwrap(p.name.expression));
      if (ts.isSpreadAssignment(p) || opaqueKey) {
        if (ts.isSpreadAssignment(p)) anySpread = true;
        if (keyAt >= 0) overwrittenAfterKey = ts.isSpreadAssignment(p) ? "a spread" : "a computed key this file cannot resolve";
        return;
      }
      if (!propertyNames(p.name, key)) return;
      keyAt = i;
      // Only a property assignment carries a value this file can look at. A getter is a function
      // body, and reading it would be evaluating code, so it states the key without a knowable
      // value and must not be answered as though the value were fine.
      keyValue = ts.isPropertyAssignment(p) ? p.initializer : undefined;
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
    if (keyValue && alternatives(keyValue).some(isProvablyUndefined)) {
      return { verdict: "missing-key", detail: `states the key as \`undefined\`, which is not the boolean the seam demands: ${show(alt)}` };
    }
  }
  return unverifiable ? { verdict: "unverifiable", detail: unverifiable } : { verdict: "has-key", detail: "" };
}

/** Every call of the seam in one file, classified, plus every escape of its name. */
function sitesIn(file: string, text: string, seam: Seam): Site[] {
  const src = parse(file, text);
  // A file that does not PARSE is refused rather than scanned, because the recovery tree the parser
  // hands back is not the program: it invents nodes that no valid source can produce, and a rule
  // asked about one of them answers about nothing. Review hit this exactly once, reporting a false
  // red on `const { ["seam"] } = core` (a SyntaxError in both Node and tsc, whose recovery is a
  // binding whose name is an identifier with EMPTY text) and reading it as a defect in the rule.
  // Refusing here is also fail-closed in the direction that matters: an unparseable file cannot run,
  // so nothing is lost by declining to report a count for it, while scanning it silently reports a
  // number that looks like coverage.
  const diags = (src as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diags.length) return [{
    file, line: 1, verdict: "unverifiable",
    detail: `this file does not parse (${ts.flattenDiagnosticMessageText(diags[0].messageText, " ")}), so the tree here is error recovery rather than the program`,
  }];
  const found: Site[] = [];
  const consts = constStrings(src);
  const folds: Folds = (e) => !!e && foldString(e, consts) === seam.fn;
  const lineOf = (n: ts.Node): number => src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && callsSeam(n, seam.fn, folds)) {
      const { verdict, detail } = classify(n.arguments[0], seam.key, src);
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

console.log("\nB. the seam, across every source the compiler may or may not read");
const files = sources(ROOT);
check("the scan reached a source tree at all (a zero-file walk would pass every cell below)", files.length > 500, files.length);

for (const seam of SEAMS) {
  const all = files.flatMap((f) => sitesIn(relative(ROOT, f), readFileSync(f, "utf8"), seam));
  const sites = all.filter((s) => s.verdict !== "aliased");
  const aliased = all.filter((s) => s.verdict === "aliased");
  const bad = sites.filter((s) => s.verdict !== "has-key");
  const untypechecked = sites.filter((s) => s.file.includes(`${sep}smoke${sep}`) || s.file.includes("/smoke/"));
  // Printed on SUCCESS as well as failure: a legitimate removal then shows the number to put back,
  // instead of sending the next author into this file to find out what the floor should become.
  console.log(`  · ${seam.fn}: ${sites.length} call sites (${untypechecked.length} under smoke/, ${sites.length - untypechecked.length} typechecked)`);
  check(`\`${seam.fn}\`: every call site states \`${seam.key}\``, bad.length === 0,
    bad.map((s) => `${s.file}:${s.line} [${s.verdict}] ${s.detail}`));

  check(`\`${seam.fn}\`: the name is never rebound, so no call can hide behind an alias`, aliased.length === 0,
    aliased.map((s) => `${s.file}:${s.line} ${s.detail}`));

  // THE FLOORS. Without them this check degrades into a green that means nothing: a rename, a
  // wrapper, or a reader that stops matching all produce "no bad sites" out of "no sites at all".
  // They are set to the counts measured when this file was last edited, so decay is red and a
  // deliberate removal is a one-line edit made on purpose. What they cannot do is notice a call site
  // that was never counted, which is why the reader above refuses aliases instead of relying here.
  check(`\`${seam.fn}\`: the scan still FINDS its call sites (>= ${seam.floor}; if you removed some, lower this floor deliberately)`,
    sites.length >= seam.floor, { found: sites.length, floor: seam.floor });

  // Split from the total on purpose. The half the compiler cannot see is the whole reason this file
  // exists, and a bare "> 0" here would be satisfied by a single smoke site while the rest vanished.
  check(`\`${seam.fn}\`: the UNTYPECHECKED half is still reached (>= ${seam.untypecheckedFloor} call sites under smoke/, which no tsconfig includes)`,
    untypechecked.length >= seam.untypecheckedFloor, { found: untypechecked.length, floor: seam.untypecheckedFloor });
}

console.log(`\n${fail === 0 ? "REQUIRED-ARG SEAM SMOKE OK ✅" : "REQUIRED-ARG SEAM SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail > 0) process.exit(1);
