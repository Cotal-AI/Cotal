#!/usr/bin/env node
/**
 * Which declaration does each docblock actually BIND to, and did that change?
 *
 * The property is NOT "a docblock sits immediately above its declaration". TypeScript binds a JSDoc
 * across blank lines, so an adjacency check fires on every harmless blank line and still misses the
 * defect. The mechanism is INTERPOSITION: a declaration appearing between a doc and its subject
 * takes the doc, and the subject silently loses it. Nothing is deleted, so a diff cannot show it.
 *
 * So this asks the parser which declaration each JSDoc is attached to and compares the
 * (declaration -> has-doc) pairs against a ref. Not the text, not the spacing.
 *
 *   pnpm doc-binding --self-test     grade this tool against its own four controls
 *   pnpm doc-binding <ref>           compare <ref> against the working tree
 *
 * ONLY A DECLARATION THAT HAD A DOC AND NOW HAS NONE IS A FINDING. Three classes are counted and
 * not reported, because on any real diff they outnumber the findings by two orders of magnitude and
 * a sweep that surfaces them buries the ones that matter: a new declaration (`ABSENT -> *`), an
 * undocumented declaration that moved or went away (`false -> ABSENT`), and a doc being added
 * (`false -> true`). A documented declaration that is no longer there (`true -> ABSENT`) is printed
 * but does not fail the run: it is usually a move to another file, which the reader can confirm in
 * a way this tool cannot, since it compares one file against itself.
 *
 * Exit 0 when nothing lost a doc, 1 when something did, 2 on misuse.
 */
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

/**
 * Every declaration the parser can hang a JSDoc on, in source order, with whether one is bound to
 * it. `node.jsDoc` is what the parser attached, so this reads the binding rather than re-deriving
 * a rule for it.
 */
export function pairs(text, fileName = "x.ts") {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const out = [];
  const nameOf = (n) => {
    if (ts.isVariableStatement(n)) return n.declarationList.declarations.map((d) => d.name.getText(sf)).join(",");
    if (n.name !== undefined && n.name !== null) return n.name.getText(sf);
    if (ts.isConstructorDeclaration(n)) return "constructor";
    return undefined;
  };
  // A label of our OWN. `ts.SyntaxKind[kind]` returns whichever alias the enum declares first, so a
  // variable statement prints as `FirstStatement`: a name that reads like a position and moves
  // whenever the enum is reordered.
  const kindName = (n) => {
    if (ts.isVariableStatement(n)) return "VariableStatement";
    if (ts.isFunctionDeclaration(n)) return "FunctionDeclaration";
    if (ts.isClassDeclaration(n)) return "ClassDeclaration";
    if (ts.isInterfaceDeclaration(n)) return "InterfaceDeclaration";
    if (ts.isTypeAliasDeclaration(n)) return "TypeAliasDeclaration";
    if (ts.isMethodDeclaration(n) || ts.isMethodSignature(n)) return "Method";
    if (ts.isPropertyDeclaration(n) || ts.isPropertySignature(n)) return "Property";
    return ts.SyntaxKind[n.kind];
  };
  const carries = (n) =>
    ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n)
    || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n) || ts.isEnumMember(n)
    || ts.isVariableStatement(n) || ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n)
    || ts.isPropertySignature(n) || ts.isMethodSignature(n) || ts.isConstructorDeclaration(n)
    || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n) || ts.isModuleDeclaration(n)
    || ts.isParameter(n);
  const walk = (n, path) => {
    let here = path;
    if (carries(n)) {
      const name = nameOf(n) ?? "<anon>";
      here = path === "" ? name : `${path}.${name}`;
      const doc = n.jsDoc;
      out.push({ decl: `${kindName(n)}:${here}`, hasDoc: Array.isArray(doc) && doc.length > 0 });
    }
    ts.forEachChild(n, (c) => walk(c, here));
  };
  ts.forEachChild(sf, (c) => walk(c, ""));
  return out;
}

/** The pairs that differ. A declaration on one side only is reported too, since a rename and a
 *  deletion are both things a comment pass is not allowed to do. */
export function diffPairs(before, after) {
  const index = (list) => {
    const m = new Map();
    const seen = new Map();
    for (const p of list) {
      const n = seen.get(p.decl) ?? 0;
      seen.set(p.decl, n + 1);
      m.set(`${p.decl}#${n}`, p);
    }
    return m;
  };
  const b = index(before);
  const a = index(after);
  const changes = [];
  for (const [k, p] of b) {
    const q = a.get(k);
    if (q === undefined) { changes.push({ decl: k, was: p.hasDoc, now: "ABSENT" }); continue; }
    if (q.hasDoc !== p.hasDoc) changes.push({ decl: k, was: p.hasDoc, now: q.hasDoc });
  }
  for (const [k, q] of a) if (!b.has(k)) changes.push({ decl: k, was: "ABSENT", now: q.hasDoc });
  return changes;
}

const SELF = `
/** doc for alpha */
export const alpha = 1;

/** doc for beta */
export function beta(): void {}

export class C {
  /** doc for m */
  m(): void {}
  n(): void {}
}
`;

if (process.argv.includes("--self-test")) {
  let pass = 0, fail = 0;
  const cell = (name, ok, detail) => {
    if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
    else { fail += 1; console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
  };
  const base = pairs(SELF);
  cell("it finds every declaration that can carry a doc", base.length === 5, base.map((p) => p.decl));
  cell("and reads the bindings the parser made", base.filter((p) => p.hasDoc).length === 3, base);

  // TWO CONTROLS THAT MUST SURVIVE AND TWO THAT MUST KILL. Kill-controls alone would leave a tool
  // that cannot tell a comment rewrite from doc theft, and firing on a rewrite is the failure that
  // teaches people to ignore it.

  // SURVIVE 1: spacing is not the mechanism.
  const spaced = pairs(SELF.replace("/** doc for alpha */\nexport const alpha", "/** doc for alpha */\n\n\nexport const alpha"));
  cell("a blank line between a doc and its subject changes NO binding",
    diffPairs(base, spaced).length === 0, diffPairs(base, spaced));

  // SURVIVE 2: rewriting a doc's text is what a comment pass does.
  const reworded = pairs(SELF.replace("/** doc for alpha */", "/** something else entirely, longer */"));
  cell("rewriting a doc's TEXT changes no binding", diffPairs(base, reworded).length === 0, diffPairs(base, reworded));

  // KILL 1: the defect this exists for.
  const stolen = pairs(SELF.replace("export const alpha = 1;", "export interface Inserted { x: number }\nexport const alpha = 1;"));
  const d = diffPairs(base, stolen);
  cell("an INTERPOSED declaration is caught: the subject loses its doc",
    d.some((c) => c.decl.startsWith("VariableStatement:alpha") && c.was === true && c.now === false), d);
  cell("and the declaration that took it is reported as new",
    d.some((c) => c.decl.startsWith("InterfaceDeclaration:Inserted") && c.was === "ABSENT"), d);

  // KILL 2: an outright deletion.
  const dropped = pairs(SELF.replace("/** doc for beta */\n", ""));
  cell("a DELETED docblock is caught",
    diffPairs(base, dropped).some((c) => c.decl.startsWith("FunctionDeclaration:beta") && c.now === false),
    diffPairs(base, dropped));

  console.log(`\nDOC BINDING SELF-TEST ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
}

const ref = process.argv[2];
if (ref === undefined) {
  console.error("usage: pnpm doc-binding <ref> | pnpm doc-binding --self-test");
  process.exit(2);
}

const files = execFileSync("git", ["diff", "--name-only", ref], { encoding: "utf8" })
  .split("\n").filter((f) => f.endsWith(".ts") || f.endsWith(".mts"));

let checked = 0, decls = 0, lost = 0, gone = 0, quiet = 0;
for (const f of files) {
  let before;
  // A file absent at the ref is new, and a new file cannot have lost a doc. `stderr: "ignore"`
  // because git reports the absence on stderr and it is expected here, not a problem to surface.
  try { before = execFileSync("git", ["show", `${ref}:${f}`], { encoding: "utf8", maxBuffer: 32 << 20, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { continue; }
  if (!existsSync(f)) continue;
  const b = pairs(before, f);
  const a = pairs(readFileSync(f, "utf8"), f);
  checked += 1;
  decls += b.length;
  const changes = diffPairs(b, a);
  const stolen = changes.filter((c) => c.was === true && c.now === false);
  const removed = changes.filter((c) => c.was === true && c.now === "ABSENT");
  quiet += changes.length - stolen.length - removed.length;
  if (stolen.length > 0 || removed.length > 0) console.log(`CHANGED ${f}`);
  for (const c of stolen) { lost += 1; console.log(`   LOST A DOC  ${c.decl}`); }
  for (const c of removed) { gone += 1; console.log(`   documented declaration no longer here, check where it moved: ${c.decl}`); }
}
console.log(`\n${lost === 0 ? "NOTHING LOST A DOC" : "DOCS LOST"}  ${checked} files, ${decls} declarations, `
  + `${lost} lost, ${gone} documented-and-gone, ${quiet} changes not counted`);
process.exit(lost === 0 ? 0 : 1);
