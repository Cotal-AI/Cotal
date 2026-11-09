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
 *  (`runtime[key]`, `{ [key]: f } = runtime`) on a runtime origin fails closed as a bypass. A runtime
 *  origin is `this.requiredRuntime`, the `this.runtime` field that getter returns, a call of
 *  `runtimeFor`, a returned runtime, a runtime stored on an object, a name bound from one of those,
 *  or a binding whose type names `Runtime`. A `Reflect.*` or `Object.*` call, written with a dot or
 *  a literal key, or a spread that takes one reaches `reap` without naming it, so that is a bypass
 *  too. `probes` are the `typeof x.reap` feature checks, which call nothing.
 *  `elements` counts each element access by how it was classified, so the census says how much it
 *  read. */
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
  // A runtime origin is `this.requiredRuntime`, the `this.runtime` field that getter returns, a call
  // of `runtimeFor`, a returned runtime, a runtime stored on an object, a name bound from one of
  // those, or a binding whose type names `Runtime`.
  const aliases = new Set<string>();
  const typeNamesRuntime = (type: ts.TypeNode | undefined): boolean => {
    if (!type) return false;
    if (ts.isTypeReferenceNode(type)) return type.typeName.getText(source) === "Runtime" || type.typeName.getText(source).endsWith(".Runtime");
    if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) return type.types.some(typeNamesRuntime);
    if (ts.isParenthesizedTypeNode(type)) return typeNamesRuntime(type.type);
    if (ts.isArrayTypeNode(type)) return typeNamesRuntime(type.elementType);
    if (ts.isTypeLiteralNode(type)) return type.members.some((member) => ts.isPropertySignature(member) && typeNamesRuntime(member.type));
    if (ts.isTupleTypeNode(type)) return type.elements.some((element) => ts.isTypeNode(element) && typeNamesRuntime(element));
    return false;
  };
  const isRuntime = (node: ts.Expression): boolean => {
    const bare = unwrap(node);
    const computed = ts.isElementAccessExpression(bare) ? unwrap(bare.argumentExpression) : undefined;
    if (
      ts.isElementAccessExpression(bare) && bare.expression.kind === ts.SyntaxKind.ThisKeyword &&
      computed !== undefined && (ts.isStringLiteralLike(computed) || ts.isNumericLiteral(computed)) && computed.text === "requiredRuntime"
    ) return true;
    if (ts.isPropertyAccessExpression(bare)) {
      const receiver = unwrap(bare.expression);
      if (receiver.kind === ts.SyntaxKind.ThisKeyword && (bare.name.text === "requiredRuntime" || bare.name.text === "runtime")) return true;
      const holder = ts.isIdentifier(receiver) ? receiver.text : receiver.kind === ts.SyntaxKind.ThisKeyword ? "this" : undefined;
      if (holder !== undefined && aliases.has(`${holder}.${bare.name.text}`)) return true;
    }
    if (ts.isCallExpression(bare) && bare.expression) {
      const called = unwrap(bare.expression);
      if (ts.isPropertyAccessExpression(called) && called.name.text === "runtimeFor") return true;
      const calledName = ts.isIdentifier(called) ? called.text : ts.isPropertyAccessExpression(called) ? called.name.text : undefined;
      if (calledName !== undefined && aliases.has(calledName)) return true;
    }
    return ts.isIdentifier(bare) && aliases.has(bare.text);
  };
  const bind = (name: ts.BindingName | undefined, fromRuntime: boolean, type?: ts.TypeNode): void => {
    if (name === undefined) return;
    if (ts.isIdentifier(name)) {
      if (!aliases.has(name.text) && (fromRuntime || typeNamesRuntime(type))) aliases.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isBindingElement(element) || element.dotDotDotToken !== undefined) continue;
      const elementType = elementTypeOf(type, element);
      bind(element.name, fromRuntime, elementType);
    }
  };
  const elementTypeOf = (type: ts.TypeNode | undefined, element: ts.BindingElement): ts.TypeNode | undefined => {
    if (type === undefined || !ts.isIdentifier(element.name)) return undefined;
    if (ts.isTypeLiteralNode(type) && ts.isObjectBindingPattern(element.parent)) {
      const propertyName = element.propertyName ?? element.name;
      const match = type.members.find((member) => ts.isPropertySignature(member) && member.name.getText(source) === propertyName.getText(source));
      return match !== undefined && ts.isPropertySignature(match) ? match.type : undefined;
    }
    if (ts.isTupleTypeNode(type) && ts.isArrayBindingPattern(element.parent)) {
      const index = element.parent.elements.indexOf(element);
      const elementType = type.elements[index];
      return elementType !== undefined && ts.isTypeNode(elementType) ? elementType : undefined;
    }
    return undefined;
  };
  for (let grew = true; grew;) {
    const before = aliases.size;
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) {
        if (node.initializer !== undefined) {
          bind(node.name, isRuntime(node.initializer), node.type);
          const value = unwrap(node.initializer);
          if (ts.isIdentifier(node.name) && ts.isPropertyAccessExpression(value)) {
            const object = unwrap(value.expression);
            if (ts.isIdentifier(object) && (object.text === "Reflect" || object.text === "Object")) aliases.add(node.name.text);
          }
          if (ts.isIdentifier(node.name) && ts.isObjectLiteralExpression(value)) {
            for (const property of value.properties) {
              if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || !isRuntime(property.initializer)) continue;
              aliases.add(`${node.name.text}.${property.name.text}`);
            }
          }
        } else bind(node.name, false, node.type);
      } else if (ts.isParameter(node)) bind(node.name, false, node.type);
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && isRuntime(node.right)) aliases.add(node.left.text);
      else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name) && typeNamesRuntime(node.type)) aliases.add(`this.${node.name.text}`);
      else if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
        const declared = node.initializer.declarations[0];
        if (declared !== undefined) bind(declared.name, isRuntime(node.expression), declared.type);
      } else if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) bind(node.variableDeclaration.name, false, node.variableDeclaration.type);
      else if (
        (ts.isReturnStatement(node) && node.expression !== undefined && ts.isCallExpression(unwrap(node.expression)) && isRuntime(node.expression)) ||
        ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body !== undefined && ts.isCallExpression(unwrap(node.body as ts.Expression)) && isRuntime(node.body as ts.Expression))
      ) {
        const returned = ts.isReturnStatement(node) ? node : node.parent;
        let owner: ts.Node | undefined = returned;
        while (
          owner !== undefined && !ts.isMethodDeclaration(owner) && !ts.isFunctionDeclaration(owner) &&
          !ts.isPropertyDeclaration(owner) && !ts.isVariableDeclaration(owner)
        ) owner = owner.parent;
        const ownerName = owner !== undefined && "name" in owner && owner.name !== undefined && ts.isIdentifier(owner.name) ? owner.name.text : undefined;
        if (ownerName !== undefined) aliases.add(ownerName);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
    grew = aliases.size > before;
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
    // A reflective or enumerating call, or a spread, reaches reap without naming it.
    if (ts.isCallExpression(node) && node.expression) {
      const callee = unwrap(node.expression);
      const receiver = ts.isPropertyAccessExpression(callee)
        ? unwrap(callee.expression)
        : ts.isElementAccessExpression(callee) && literalKey(callee.argumentExpression) !== undefined
          ? unwrap(callee.expression)
          : ts.isIdentifier(callee) && aliases.has(callee.text) ? callee : undefined;
      const reflective = receiver !== undefined && ts.isIdentifier(receiver) && (receiver.text === "Reflect" || receiver.text === "Object" || aliases.has(receiver.text));
      if (reflective && node.arguments.some((arg) => isRuntime(arg))) out.bypass.push(`${where(node)} (line ${line(node)})`);
    }
    if ((ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) && isRuntime(node.expression)) out.bypass.push(`${where(node)} (line ${line(node)})`);
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
  ["a reflective read of reap is a bypass",
    fixture('  private async later() { await Reflect.get(this.requiredRuntime, "reap")(ref); }'),
    (c) => c.bypass.length === 1 && c.bypass[0]!.startsWith("Manager.later")],
  ["Object.values of the runtime is a bypass",
    fixture('  private async later() { Object.values(this.requiredRuntime); }'),
    (c) => c.bypass.length === 1 && c.bypass[0]!.startsWith("Manager.later")],
  ["a spread of the runtime is a bypass",
    fixture('  private async later() { const copy = { ...this.requiredRuntime }; }'),
    (c) => c.bypass.length === 1 && c.bypass[0]!.startsWith("Manager.later")],
  ["an unreadable key on a runtime parameter is a bypass",
    fixture('  private async later(runtime: Runtime) { const key = "reap"; await runtime[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["an unreadable key on a runtimeFor result is a bypass",
    fixture('  private async later() { const key = "reap"; await this.runtimeFor(kind)[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a later assignment of runtimeFor is a runtime",
    fixture('  private async later() { const key = "reap"; let runtime: Runtime; runtime = this.runtimeFor(kind); await runtime[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a returned runtime is a runtime",
    fixture('  private pick(): Runtime { return this.runtimeFor(kind); }\n  private async later() { const key = "reap"; await this.pick()[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a runtime stored on an object is a runtime",
    fixture('  private async later() { const key = "reap"; const bag = { runtime: this.runtimeFor(kind) }; await bag.runtime[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a for-of Runtime binding is a runtime",
    fixture('  private async later(list: Runtime[]) { const key = "reap"; for (const runtime of list) await runtime[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a catch Runtime binding is a runtime",
    fixture('  private async later() { const key = "reap"; try {} catch (runtime: Runtime) { await runtime[key](ref); } }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a nested Runtime binding is a runtime",
    fixture('  private async later(bag: { runtime: Runtime }) { const key = "reap"; const { runtime } = bag; await runtime[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["an array Runtime binding is a runtime",
    fixture('  private async later(pair: [Runtime, string]) { const key = "reap"; const [runtime] = pair; await runtime[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a class field typed Runtime is a runtime",
    fixture('  private held!: Runtime;\n  private async later() { const key = "reap"; await this.held[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["Reflect read through a literal key is a bypass",
    fixture('  private async later() { await Reflect["get"](this.requiredRuntime, "reap")(ref); }'),
    (c) => c.bypass.length === 1],
  ["Object read through a literal key is a bypass",
    fixture('  private async later() { Object["values"](this.requiredRuntime); }'),
    (c) => c.bypass.length === 1],
  ["a returned value that is not a runtime is not a runtime",
    fixture('  private pick(): string { return "pty"; }\n  private async later() { const key = "reap"; await this.pick()[key](ref); }'),
    (c) => c.bypass.length === 0 && c.elements["unreadable, not on the runtime"] === 1],
  ["a property that is not a runtime is not a runtime",
    fixture('  private async later() { const key = "reap"; const bag = { name: "pty" }; await bag.name[key](ref); }'),
    (c) => c.bypass.length === 0 && c.elements["unreadable, not on the runtime"] === 1],
  ["Reflect read of a value that is not a runtime is not a bypass",
    fixture('  private async later() { Reflect["get"](other, "reap"); }'),
    (c) => c.bypass.length === 0],
  ["a Runtime binding with no initializer is a runtime",
    fixture('  private async later() { const key = "reap"; let runtime: Runtime; await runtime[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["an arrow that returns runtimeFor is a runtime",
    fixture('  private pick = () => this.runtimeFor(kind);\n  private async later() { const key = "reap"; await this.pick()[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a local copy of Reflect.get is a bypass",
    fixture('  private async later(runtime: Runtime) { const get = Reflect.get; await get(runtime, "reap")(ref); }'),
    (c) => c.bypass.length === 1],
  ["a computed requiredRuntime is a runtime",
    fixture('  private async later() { const key = "reap"; await this["requiredRuntime"][key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
];
for (const [name, text, holds] of instrument) {
  const c = censusReaps("fixture.ts", text);
  check(`CONTROL (census instrument): ${name}`, holds(c), c);
}

// The real file. What each reviewed site does with a refusal:
//   reapOrphanedResumeSeat: returns it, and the resume does not relaunch over that seat.
//   reapOrphanSeat: lets it propagate into driveStaticRetirement, which holds the name.
//   spawnCustodied: carries it into the throw, saying the seat was not proved gone.
// restartSupervisedSeat no longer calls requireRuntimeReap. It proves the previous seat's local work
// ended through runtime.reapWork before the resume launches, and a refusal there stays with that proof.
const REVIEWED_SITES = ["Manager.reapOrphanSeat", "Manager.reapOrphanedResumeSeat", "Manager.spawnCustodied"];
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
