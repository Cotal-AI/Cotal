/**
 * #1554: an `absent` reap outcome must REFUSE, never render as a disposal.
 *
 * `absent` says the custody record could not be read. That is a fact about ADDRESSABILITY, and two
 * of the three ways to reach it leave a LIVE seat: a custodian that dies after `pty.spawn` and
 * before `writeRecord` has a running child and no record, and a stale or wrong reference looks for a
 * record that exists at another path. Both of the manager's rendering sites used to turn that into
 * "already forgotten" and carry on, so an alias could be freed over a seat nobody proved gone.
 *
 * The refusal lives in `requireRuntimeReap` rather than at the callsites, which is what makes the
 * census exhaustive: `absent` never reaches a caller, so no caller can describe it as success.
 *
 * Deliberately broker-free and process-free. The property is about what one function returns versus
 * throws, and the heavy orphan-seat smokes cannot drive a missing record reliably.
 *
 * Run: pnpm smoke:reap-absent-refusal
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { requireRuntimeReap } from "../src/runtime/index.js";

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, extra?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const reference = { kind: "pty", id: "seat-1554-abcdef" };
// Custodial by duck type (`reserve` + `reap` both functions), which is how isCustodialRuntime
// decides. Nothing else on Runtime is touched by the path under test.
const runtimeWith = (reap: () => Promise<unknown>) =>
  ({ kind: "pty", reserve: () => reference, reap }) as never;

// (a) the refusal itself
let threw: unknown;
let returned: unknown;
try {
  returned = await requireRuntimeReap(runtimeWith(async () => ({ outcome: "absent" })), reference as never);
} catch (e) { threw = e; }
check(
  "#1554: an ABSENT reap outcome REFUSES instead of returning an outcome a caller can render",
  threw !== undefined && returned === undefined,
  { threw: threw === undefined ? null : String(threw), returned },
);
check(
  "#1554: the refusal names the reference, so the operator knows what to go looking for",
  threw !== undefined && String((threw as Error).message).includes(reference.id),
  threw === undefined ? null : String((threw as Error).message),
);
check(
  "#1554: the refusal says the seat is NOT proved gone rather than describing a disposal",
  threw !== undefined && /not proved gone|NOT proved gone/.test(String((threw as Error).message)),
  threw === undefined ? null : String((threw as Error).message),
);

// (b) positive control: a real reap is unaffected
let reaped: unknown; let reapedThrew: unknown;
try {
  reaped = await requireRuntimeReap(
    runtimeWith(async () => ({ outcome: "reaped", detail: "custodian signalled, child gone" })),
    reference as never,
  );
} catch (e) { reapedThrew = e; }
check(
  "CONTROL: a REAPED outcome still returns and carries its detail",
  reapedThrew === undefined && (reaped as { detail?: string } | undefined)?.detail === "custodian signalled, child gone",
  { reapedThrew: reapedThrew === undefined ? null : String(reapedThrew), reaped },
);

// (c) negative control: the pre-existing non-custodial refusal is untouched
let nonCustodialThrew: unknown;
try {
  await requireRuntimeReap({ kind: "tmux" } as never, reference as never);
} catch (e) { nonCustodialThrew = e; }
check(
  "CONTROL: a non-custodial runtime still refuses by name (the older contract is unchanged)",
  nonCustodialThrew !== undefined && String((nonCustodialThrew as Error).message).includes("does not support reap"),
  nonCustodialThrew === undefined ? null : String((nonCustodialThrew as Error).message),
);

// (d) the census the issue asked for, stated before measuring: after the fix NO site renders an
// absent outcome, because absent cannot reach one. A sample would not have caught the second site.
const here = dirname(fileURLToPath(import.meta.url));
const managerFile = resolve(here, "..", "src", "manager.ts");
const managerSrc = readFileSync(managerFile, "utf8");
const renderings = managerSrc.split('outcome === "absent"').length - 1;
check(
  "#1554: NO site in manager.ts renders an absent outcome as prose (expected 0)",
  renderings === 0,
  { renderings },
);

/** Every reap in a source file, read from its syntax tree. `guarded` is each `requireRuntimeReap`
 *  call, named by the callables that contain it (`Class.method`, with `<anonymous>` for an unnamed
 *  callback). `bypass` is every other use of a runtime's `reap`: a direct call, a read, or a
 *  destructured binding, which would see `absent` without the refusal. A key the census cannot read
 *  (`runtime[key]`, `{ [key]: f } = runtime`) on the runtime or a local alias of it fails closed as a
 *  bypass. `probes` are the `typeof x.reap` feature checks, which call nothing. `elements` counts each
 *  element access by how it was classified, so the census says how much it read. */
function censusReaps(fileName: string, text: string): { guarded: string[]; bypass: string[]; probes: string[]; elements: Record<string, number> } {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const nameOf = (node: ts.Node): string => {
    if (ts.isClassLike(node)) return node.name?.text ?? "<class>";
    if (ts.isConstructorDeclaration(node)) return "constructor";
    if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !node.name) {
      const holder = node.parent;
      if ((ts.isPropertyDeclaration(holder) || ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)) && holder.initializer === node)
        return holder.name.getText(source);
      return "<anonymous>";
    }
    return (node as ts.NamedDeclaration).name?.getText(source) ?? "<anonymous>";
  };
  const where = (node: ts.Node): string => {
    const names: string[] = [];
    for (let p = node.parent; p; p = p.parent) if (ts.isClassLike(p) || ts.isFunctionLike(p)) names.unshift(nameOf(p));
    return names.join(".") || "<top level>";
  };
  const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)
      ? unwrap(node.expression) : node;
  // The runtime is `this.requiredRuntime`, or a local name bound to it (or to such a name).
  const aliases = new Set<string>();
  const isRuntime = (node: ts.Expression): boolean => {
    const bare = unwrap(node);
    return (ts.isPropertyAccessExpression(bare) && bare.name.text === "requiredRuntime") || (ts.isIdentifier(bare) && aliases.has(bare.text));
  };
  for (let grew = true; grew;) {
    grew = false;
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && !aliases.has(node.name.text) && isRuntime(node.initializer)) {
        aliases.add(node.name.text);
        grew = true;
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
  }
  // A key the census can read: a literal, or in a binding a plain or quoted name. Anything else
  // (`[key]`, `[a + b]`) is undefined.
  const literalKey = (key: ts.Expression): string | undefined => {
    const bare = unwrap(key);
    return ts.isStringLiteralLike(bare) || ts.isNumericLiteral(bare) ? bare.text : undefined;
  };
  const bindingKey = (key: ts.PropertyName | ts.BindingName): string | undefined =>
    ts.isIdentifier(key) || ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text
      : ts.isComputedPropertyName(key) ? literalKey(key.expression) : undefined;
  const out = { guarded: [] as string[], bypass: [] as string[], probes: [] as string[], elements: { "literal reap": 0, "literal, not reap": 0, "unreadable, on the runtime": 0, "unreadable, not on the runtime": 0 } };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "requireRuntimeReap") out.guarded.push(where(node));
    let reap = ts.isPropertyAccessExpression(node) && node.name.text === "reap";
    if (ts.isElementAccessExpression(node)) {
      const key = literalKey(node.argumentExpression);
      const kind = key === "reap" ? "literal reap" : key !== undefined ? "literal, not reap" : isRuntime(node.expression) ? "unreadable, on the runtime" : "unreadable, not on the runtime";
      out.elements[kind]++;
      reap = kind === "literal reap" || kind === "unreadable, on the runtime";
    }
    if (reap) {
      let outer: ts.Node = node.parent;
      while (ts.isParenthesizedExpression(outer)) outer = outer.parent;
      (ts.isTypeOfExpression(outer) ? out.probes : out.bypass).push(`${where(node)} (line ${line(node)})`);
    }
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = bindingKey(node.propertyName ?? node.name);
      const declaration = node.parent.parent;
      const fromRuntime = ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && isRuntime(declaration.initializer);
      if (key === "reap" || (key === undefined && fromRuntime)) out.bypass.push(`${where(node)} (line ${line(node)})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

// The census has to tell a reviewed site from a moved or new one, so it first reads four small
// sources that each break the reviewed set in a way a nearest-header scan misses.
const fixture = (body: string) => `class Manager {\n  private async reapOrphanSeat() { await requireRuntimeReap(rt, ref); }\n${body}\n}\n`;
const instrument: [string, string, (c: ReturnType<typeof censusReaps>) => boolean][] = [
  ["a reap moved into a class arrow property is named by that property", fixture("  private later = async () => { await requireRuntimeReap(rt, ref); };"),
    (c) => c.guarded.includes("Manager.later")],
  ["a reap in a generic method is named by that method", fixture("  private async later<T>(x: T) { await requireRuntimeReap(rt, ref); }"),
    (c) => c.guarded.includes("Manager.later")],
  ["a reap inside a callback is named as that callback, not as its method", fixture("  private async later() { [1].map(async () => requireRuntimeReap(rt, ref)); }"),
    (c) => c.guarded.includes("Manager.later.<anonymous>")],
  ["a direct runtime.reap call that skips the guard is a bypass", fixture("  private async later() { await this.requiredRuntime.reap(ref); }"),
    (c) => c.bypass.length === 1 && c.bypass[0]!.startsWith("Manager.later")],
  ["a key the census cannot read, on the runtime or an alias of it, is a bypass",
    fixture('  private async later() { const key = "reap"; const rt = this.requiredRuntime; await this.requiredRuntime[key](ref); await rt[key](ref); }'),
    (c) => c.bypass.length === 2 && c.elements["unreadable, on the runtime"] === 2],
  ["a quoted or computed reap binding is a bypass",
    fixture('  private async later() { const { "reap": a } = this.requiredRuntime; const { ["reap"]: b } = other; }'),
    (c) => c.bypass.length === 2 && c.bypass.every((b) => b.startsWith("Manager.later"))],
];
for (const [name, text, holds] of instrument) {
  const c = censusReaps("fixture.ts", text);
  check(`CONTROL (census instrument): ${name}`, holds(c), c);
}

// The real file. What each reviewed site does with a refusal:
//   reapOrphanedResumeSeat: returns it, and the resume does not relaunch over that seat.
//   reapOrphanSeat: lets it propagate into driveStaticRetirement, which holds the name.
//   restartSupervisedSeat (#4094): returns it, and the caller retires the lifecycle through the
//     terminal, which reaps again in reapOrphanSeat and so holds the name.
//   spawnCustodied: carries it into the throw, saying the seat was not proved gone.
const REVIEWED_SITES = ["Manager.reapOrphanSeat", "Manager.reapOrphanedResumeSeat", "Manager.restartSupervisedSeat", "Manager.spawnCustodied"];
const census = censusReaps(managerFile, managerSrc);
check(
  `CONTROL: every requireRuntimeReap call in manager.ts sits in a reviewed callable (${REVIEWED_SITES.join(", ")})`,
  JSON.stringify([...census.guarded].sort()) === JSON.stringify(REVIEWED_SITES),
  { guarded: census.guarded },
);
check(
  "#1554: no reap in manager.ts goes around requireRuntimeReap",
  census.bypass.length === 0,
  { bypass: census.bypass },
);
// An independent count of the element accesses, so a kind the classifier skipped shows as a gap.
let elementTotal = 0;
const countElements = (node: ts.Node): void => { if (ts.isElementAccessExpression(node)) elementTotal++; ts.forEachChild(node, countElements); };
countElements(ts.createSourceFile(managerFile, managerSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
const classified = Object.values(census.elements).reduce((a, b) => a + b, 0);
check(
  `CONTROL: the census classified all ${elementTotal} element accesses in manager.ts (${Object.entries(census.elements).map(([k, v]) => `${k}: ${v}`).join(", ")})`,
  elementTotal > 0 && classified === elementTotal,
  { elementTotal, elements: census.elements },
);
check(
  "CONTROL: the bypass scan sees the one typeof feature probe of reap, in Manager.orphanedResumeSeat",
  census.probes.length === 1 && census.probes[0]!.startsWith("Manager.orphanedResumeSeat "),
  { probes: census.probes },
);

console.log(`\nREAP-ABSENT-REFUSAL ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
