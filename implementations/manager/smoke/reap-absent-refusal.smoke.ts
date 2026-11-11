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
import { dirname, resolve } from "node:path";
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

/** Every reap in a source file, read with the type checker. `guarded` is each `requireRuntimeReap`
 *  call, named by the callables that contain it (`Class.method`, with `<anonymous>` for an unnamed
 *  callback). `bypass` is every other way to reach a runtime's `reap`, which would see `absent`
 *  without the refusal: a `.reap` read or call on anything, a `reap` key in a binding, and on a
 *  runtime value a key the census cannot read (`runtime[key]`, `{ [key]: f } = runtime`), a spread
 *  or rest copy, or a `Reflect.*` or `Object.*` call that takes it. A runtime value is any
 *  expression whose static type carries a `reap` member, so an alias, a field, a return value, an
 *  awaited promise, a conditional, a rest copy or a destructured binding all count without the
 *  census naming their shapes; a value the checker cannot type (`any`, `unknown`) counts too, so an
 *  untyped path fails closed. `probes` are the `typeof x.reap` feature checks, which call nothing.
 *  `elements` counts each element access by how it was classified, so the census says how much it
 *  read. */
function censusReaps(program: ts.Program, source: ts.SourceFile): { guarded: string[]; bypass: string[]; probes: string[]; elements: Record<string, number> } {
  const checker = program.getTypeChecker();
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
  const at = (node: ts.Node) => `${where(node)} (line ${line(node)})`;
  const carriesReap = (type: ts.Type): boolean =>
    type.isUnion() ? type.types.some(carriesReap)
      : (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || type.getProperty("reap") !== undefined;
  const isRuntime = (node: ts.Node): boolean => carriesReap(checker.getTypeAtLocation(node));
  // `Reflect.get`, `Object.values`, `Object.assign` and the rest of those two namespaces, however
  // the callee is spelled (`Reflect["get"]`, a local copy of `Reflect.get`): the resolved callee is
  // a member of `Reflect` or of `ObjectConstructor`.
  const reflective = (callee: ts.Expression): boolean => {
    const type = checker.getTypeAtLocation(callee);
    const symbol = type.getSymbol() ?? type.aliasSymbol;
    const name = symbol === undefined ? "" : checker.getFullyQualifiedName(symbol);
    return name.startsWith("Reflect.") || name.startsWith("ObjectConstructor.");
  };
  // A key the census can read: a literal, or in a binding a plain or quoted name. Anything else
  // (`[key]`, `[a + b]`) is undefined.
  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)
      ? unwrap(node.expression) : node;
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
      (ts.isTypeOfExpression(outer) ? out.probes : out.bypass).push(at(node));
    }
    // A reflective or enumerating call, a spread or a rest copy reaches reap without naming it.
    if (ts.isCallExpression(node) && reflective(node.expression) && node.arguments.some(isRuntime)) out.bypass.push(at(node));
    if ((ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) && isRuntime(node.expression)) out.bypass.push(at(node));
    if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.dotDotDotToken !== undefined ? undefined : bindingKey(node.propertyName ?? node.name);
      if (key === "reap" || (key === undefined && isRuntime(node.parent))) out.bypass.push(at(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

// The instrument sources are typed like the manager: a `Runtime` with `reap`, a class that holds
// one behind `requiredRuntime` and `runtimeFor`, and the free names the bodies use. Each body is
// one file of a program over the default library, so `await`, `Promise` and `Reflect` resolve.
const fixture = (body: string) => `interface Ref { kind: string; id: string }
interface Runtime { kind: string; reserve(): Ref; reap(ref: Ref): Promise<{ outcome: string }> }
type Picker = (kind: string) => Runtime;
declare const rt: Runtime; declare const r: Runtime; declare const ref: Ref; declare const kind: string; declare const flag: boolean;
declare const other: { name: string }; declare const stranger: { reap(ref: Ref): void };
declare function requireRuntimeReap(runtime: Runtime, reference: Ref): Promise<unknown>;
class Manager {
  private readonly runtime!: Runtime;
  private get requiredRuntime(): Runtime { return this.runtime; }
  private runtimeFor(kind: string): Runtime { return this.runtime; }
  private readonly table: Record<string, Runtime> = {};
  private async reapOrphanSeat() { await requireRuntimeReap(rt, ref); }
${body}
}
export {};
`;
const fixtureProgram = (sources: string[]): ts.Program => {
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, noEmit: true, lib: ["lib.es2022.d.ts"], types: [] };
  const names = sources.map((_, i) => `/fixture/${i}.ts`);
  const host = ts.createCompilerHost(options);
  const underlying = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile };
  host.fileExists = (file) => names.includes(file) || underlying.fileExists(file);
  host.readFile = (file) => (names.includes(file) ? sources[names.indexOf(file)] : underlying.readFile(file));
  host.getSourceFile = (file, languageVersion, onError, shouldCreate) =>
    names.includes(file) ? ts.createSourceFile(file, sources[names.indexOf(file)]!, languageVersion, true, ts.ScriptKind.TS) : underlying.getSourceFile(file, languageVersion, onError, shouldCreate);
  return ts.createProgram({ rootNames: names, options, host });
};

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
    fixture('  private async later() { const { "reap": a } = this.requiredRuntime; const { ["reap"]: b } = stranger; }'),
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
  ["a runtime asserted inside a catch clause is a runtime",
    fixture('  private async later() { const key = "reap"; try {} catch (e) { const runtime = e as Runtime; await runtime[key](ref); } }'),
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
    fixture('  private pick(): Record<string, (ref: Ref) => void> { return {}; }\n  private async later() { const key = "reap"; await this.pick()[key](ref); }'),
    (c) => c.bypass.length === 0 && c.elements["unreadable, not on the runtime"] === 1],
  ["a property that is not a runtime is not a runtime",
    fixture('  private async later() { const key = "reap"; const bag = { name: {} as Record<string, (ref: Ref) => void> }; await bag.name[key](ref); }'),
    (c) => c.bypass.length === 0 && c.elements["unreadable, not on the runtime"] === 1],
  ["Reflect read of a value that is not a runtime is not a bypass",
    fixture('  private async later() { Reflect["get"](other, "reap"); }'),
    (c) => c.bypass.length === 0],
  ["a Runtime binding with no initializer is a runtime",
    fixture('  private async later() { const key = "reap"; let runtime!: Runtime; await runtime[key](ref); }'),
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
  ["a computed this.runtime is a runtime",
    fixture('  private async later() { const key = "reap"; await this["runtime"][key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a rest copy of the runtime is a bypass",
    fixture('  private async later() { const { kind, ...rest } = this.requiredRuntime; }'),
    (c) => c.bypass.length === 1 && c.bypass[0]!.startsWith("Manager.later")],
  ["an unreadable key on a rest copy is a bypass",
    fixture('  private async later() { const key = "reap"; const { kind, ...rest } = this.requiredRuntime; await rest[key](ref); }'),
    (c) => c.bypass.length === 2 && c.elements["unreadable, on the runtime"] === 1],
  ["Object.values of a rest copy is a bypass",
    fixture('  private async later() { const { kind, ...rest } = this.requiredRuntime; Object.values(rest); }'),
    (c) => c.bypass.length === 2],
  ["Reflect.get on a rest copy is a bypass",
    fixture('  private async later() { const { ...rest } = this.requiredRuntime; await Reflect.get(rest, "reap")(ref); }'),
    (c) => c.bypass.length === 2],
  ["Object.assign of the runtime is a bypass",
    fixture('  private async later() { const copy = Object.assign({}, this.requiredRuntime); }'),
    (c) => c.bypass.length === 1],
  ["a parenthesized runtimeFor callee is a runtime",
    fixture('  private async later() { const key = "reap"; await (this.runtimeFor)(kind)[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["an asserted runtimeFor callee is a runtime",
    fixture('  private async later() { const key = "reap"; await (this.runtimeFor as Picker)(kind)[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a class field initialized from runtimeFor is a runtime",
    fixture('  private backend = this.runtimeFor(kind);\n  private async later() { const key = "reap"; await this.backend[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a class field assigned from runtimeFor is a runtime",
    fixture('  private backend: Runtime | undefined;\n  private async later() { const key = "reap"; this.backend = this.runtimeFor(kind); await this.backend[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a rest parameter of runtimes is a runtime",
    fixture('  private async later(...list: Runtime[]) { const key = "reap"; for (const runtime of list) await runtime[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a destructured parameter typed Runtime is a runtime",
    fixture('  private async later({ runtime }: { runtime: Runtime }) { const key = "reap"; await runtime[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a returned parameter is a runtime",
    fixture('  private pick(runtime: Runtime) { return runtime; }\n  private async later() { const key = "reap"; await this.pick(r)[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a declared Runtime return type is a runtime",
    fixture('  private pick(): Runtime { return this.table[kind]!; }\n  private async later() { const key = "reap"; await this.pick()[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a shorthand property holding a runtime is a runtime",
    fixture('  private async later(runtime: Runtime) { const key = "reap"; const bag = { runtime }; await bag.runtime[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["an array literal element bound from the runtime is a runtime",
    fixture('  private async later() { const key = "reap"; const [runtime] = [this.requiredRuntime]; await runtime[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a conditional that may yield the runtime is a runtime",
    fixture('  private async later(fallback: Runtime) { const key = "reap"; const runtime = flag ? this.requiredRuntime : fallback; await runtime[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a union that may be the runtime is a runtime",
    fixture('  private async later(maybe: Runtime | { name: string }) { const key = "reap"; if ("reap" in maybe) await maybe[key as keyof Runtime]; }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["an awaited runtime is a runtime",
    fixture('  private async later(pending: Promise<Runtime>) { const key = "reap"; const runtime = await pending; await runtime[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a for-in key read on the runtime is a bypass",
    fixture('  private async later() { for (const k in this.requiredRuntime) this.requiredRuntime[k as keyof Runtime]; }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["a value the checker cannot type fails closed",
    fixture('  private async later(loose: any) { const key = "reap"; await loose[key](ref); }'),
    (c) => c.bypass.length === 1 && c.elements["unreadable, on the runtime"] === 1],
  ["Object.values, a rest copy and a spread of a value that is not a runtime are not bypasses",
    fixture('  private async later() { Object.values(other); const { ...rest } = other; const copy = { ...other }; }'),
    (c) => c.bypass.length === 0],
];
const instrumentProgram = fixtureProgram(instrument.map(([, text]) => text));
const instrumentErrors = ts.getPreEmitDiagnostics(instrumentProgram).map((d) => `${d.file?.fileName ?? "?"}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
check("CONTROL (census instrument): every instrument source typechecks, so each reading is a reading of types", instrumentErrors.length === 0, instrumentErrors);
instrument.forEach(([name, , holds], i) => {
  const c = censusReaps(instrumentProgram, instrumentProgram.getSourceFile(`/fixture/${i}.ts`)!);
  check(`CONTROL (census instrument): ${name}`, holds(c), c);
});

// The real file. What each reviewed site does with a refusal:
//   reapOrphanedResumeSeat: returns it, and the resume does not relaunch over that seat.
//   reapOrphanSeat: lets it propagate into driveStaticRetirement, which holds the name.
//   spawnCustodied: carries it into the throw, saying the seat was not proved gone.
// restartSupervisedSeat no longer calls requireRuntimeReap. It proves the previous seat's local work
// ended through runtime.reapWork before the resume launches, and a refusal there stays with that proof.
const REVIEWED_SITES = ["Manager.reapOrphanSeat", "Manager.reapOrphanedResumeSeat", "Manager.spawnCustodied"];
const managerConfig = ts.getParsedCommandLineOfConfigFile(resolve(here, "..", "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, " ")); } })!;
const managerProgram = ts.createProgram({ rootNames: [managerFile], options: { ...managerConfig.options, noEmit: true } });
const managerSource = managerProgram.getSourceFile(managerFile)!;
const managerErrors = managerProgram.getSemanticDiagnostics(managerSource).map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
check("CONTROL: manager.ts typechecks, so the census read its types and not error types", managerErrors.length === 0, managerErrors);
const census = censusReaps(managerProgram, managerSource);
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
