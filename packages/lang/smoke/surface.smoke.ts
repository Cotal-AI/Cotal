/**
 * The surface: the validator and the interpreter are two readings of ONE table.
 *
 * Before `syntax.ts` existed the two halves were two hand-kept lists, and they disagreed: the
 * validator admitted `x++`, `?.`, rest parameters and `**` and the interpreter refused each at run
 * time as "unsupported"; `sort` and `json` were names the validator resolved and the interpreter
 * never defined. This suite is what makes the table a fact rather than a note:
 *
 * 1. every free builtin the validator resolves is a binding the interpreter defines, and vice versa;
 * 2. every node type acorn emits lands in exactly one set of the table, and the table's sets are
 *    disjoint (a corpus of snippets exercises every one, so a type the table forgot is a red cell,
 *    not a runtime surprise);
 * 3. the interpreter's `case` labels are exactly the admitted and structural sets, read from its source;
 * 4. every admitted node type EXECUTES, and every forbidden row REJECTS with its own code;
 * 5. every method in the curated tables is callable on its receiver, and `sort`'s total order holds;
 * 6. every ```js block in the language reference and the guide VALIDATES as written (it is not run:
 *    a block's behaviour is held by the cells above and by the differential suite, this holds only
 *    that no example uses syntax or names the language refuses).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { validate } from "../src/grammar.js";
import { LangErrors, type LangErrorCode } from "../src/errors.js";
import { run } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";
import { BUILTINS } from "../src/primitives.js";
import { ADMITTED_NODES, FORBIDDEN_CHILDREN, FORBIDDEN_NODES, KNOWN_NODES, STRUCTURAL_NODES } from "../src/syntax.js";
import { arrayMethods, builtins, numberMethods, stringMethods } from "../src/library.js";
import { Prng } from "../src/values.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

const here = fileURLToPath(new URL(".", import.meta.url));

async function logsOf(source: string): Promise<unknown[]> {
  const logs: unknown[] = [];
  await run(source, { runId: "surf", handler: new SimHandler({}), onLog: (l) => logs.push(l.values.length === 1 ? l.values[0] : [...l.values]) });
  return logs;
}

const codesOf = (source: string): string[] => {
  try {
    validate(source);
    return [];
  } catch (e) {
    if (e instanceof LangErrors) return e.errors.map((x) => x.code);
    throw e;
  }
};

// ---- 1) builtins: one list, both halves -----------------------------------------------------------

{
  const defined = builtins({
    runId: "x",
    programHash: "sha256:0",
    startedAt: 0,
    prng: new Prng("s"),
    assertWritable: () => undefined,
  }).map(([name]) => name);
  const validatorSide = [...BUILTINS].sort();
  const interpreterSide = [...defined].sort();
  ok("the validator's BUILTINS and the interpreter's library define the same names", JSON.stringify(validatorSide) === JSON.stringify(interpreterSide), {
    onlyValidator: validatorSide.filter((n) => !interpreterSide.includes(n)),
    onlyInterpreter: interpreterSide.filter((n) => !validatorSide.includes(n)),
  });
  ok("and no builtin is defined twice", new Set(defined).size === defined.length);
  // Executed, not inferred: a program that names every builtin runs.
  const probe = `log(${BUILTINS.map((n) => `typeof ${n}`).join(", ")});`;
  const [types] = (await logsOf(probe)) as [string[]];
  ok("every builtin is a bound name at run time", types.every((t) => t === "function" || t === "object"), types);
  ok("`undefined` is a value a program can name", (await logsOf("let u; const o = {}; log(u === undefined, o.a === undefined);"))[0]?.toString() === "true,true");
  ok("and cannot be shadowed", codesOf("const undefined = 1;").includes("L2002"));
}

// ---- 2) the node table partitions everything acorn emits ------------------------------------------

/** One snippet per node type acorn can produce, valid JavaScript whether or not it is in the language. */
const CORPUS: readonly string[] = [
  "const a = 1; let b = a + 2; b += 1; b++; --b;",
  "function f(x = 1, ...r) { return x; } const g = function () {}; const h = async (y) => await y;",
  "{ ; } if (a) { b; } else { c; } while (a) { break; } for (let i = 0; i < 1; i++) { continue; } for (const q of xs) { }",
  "switch (a) { case 1: { break; } default: break; } try { throw 1; } catch (e) { } finally { }",
  "const o = { p, q: 1, [k]: 2, ...s, m() {}, get z() { return 1; } }; const [x, , ...ys] = arr; const { p: pp = 3, ...rest } = o;",
  "o.p; o[k]; o?.p; o?.[k]; f?.(); `t${a}u`; tag`x`; [1, ...arr]; f(...arr); a ? b : c; a && b; a || b; a ?? b;",
  "typeof a; -a; !a; void 0; delete o.p; a === b; a == b; a instanceof b; k in o; (a, b); new F(); this;",
  "class C extends D { #priv = 1; static s = 2; static { } m() { super.m(); } get x() { return this.#priv; } } const K = class {};",
  "label: for (;;) { break label; } do { } while (a); for (const k in o) { } debugger;",
  "import x, { y as z } from 'm'; import * as ns from 'm'; export const e = 1; export { e as ee }; export default 1; export * from 'm'; import.meta; import('m');",
  "function* gen() { yield 1; } async function* ag() { yield* x; } new.target;",
];

{
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (typeof rec.type === "string") seen.add(rec.type);
    for (const [k, v] of Object.entries(rec)) {
      if (k === "loc" || k === "start" || k === "end" || k === "range") continue;
      walk(v);
    }
  };
  for (const snippet of CORPUS) {
    try {
      walk(parse(snippet, { ecmaVersion: 2023, sourceType: "module", allowAwaitOutsideFunction: true }));
    } catch (e) {
      // `new.target` outside a function and `super` outside a method are early errors for acorn too;
      // they are parsed in a function context instead.
      walk(parse(`function f() { ${snippet} }`, { ecmaVersion: 2023, sourceType: "module" }));
    }
  }
  seen.delete("Program");
  const known = new Set(KNOWN_NODES);
  const unknown = [...seen].filter((t) => !known.has(t) && t !== "Program");
  ok("every node type acorn emitted for the corpus is on the table", unknown.length === 0, unknown);
  const unexercised = KNOWN_NODES.filter((t) => t !== "Program" && !seen.has(t));
  ok("and every node type on the table was emitted by the corpus", unexercised.length === 0, unexercised);
  const sets = [
    ["admitted", [...ADMITTED_NODES]],
    ["structural", [...STRUCTURAL_NODES]],
    ["forbidden", Object.keys(FORBIDDEN_NODES)],
    ["forbidden-children", [...FORBIDDEN_CHILDREN]],
  ] as const;
  const overlaps: string[] = [];
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      const a = new Set(sets[i]![1]);
      for (const t of sets[j]![1]) if (a.has(t)) overlaps.push(`${t} in ${sets[i]![0]} and ${sets[j]![0]}`);
    }
  }
  ok("the table's sets are disjoint", overlaps.length === 0, overlaps);
}

// ---- 3) the interpreter's switches ARE the admitted set ---------------------------------------------

{
  const src = readFileSync(new URL("../src/interpret.ts", import.meta.url), "utf8");
  const labels = new Set<string>();
  for (const m of src.matchAll(/case "([A-Z][A-Za-z]+)":/g)) labels.add(m[1] as string);
  // `Program` is the entry: `run` hands its body to `executeBlock` directly, so it has no case.
  const missing = [...ADMITTED_NODES].filter((t) => t !== "Program" && !labels.has(t));
  ok("every admitted node type has a case in the interpreter", missing.length === 0, missing);
  const extra = [...labels].filter((t) => !ADMITTED_NODES.has(t) && !STRUCTURAL_NODES.has(t));
  ok("and the interpreter has no case for a node type the table does not admit", extra.length === 0, extra);
}

// ---- 4) every admitted node executes; every forbidden row rejects with its own code ------------------

const EXECUTES: Readonly<Record<string, [string, unknown]>> = {
  Program: ["log(1);", 1],
  ExpressionStatement: ["log(2);", 2],
  VariableDeclaration: ["const a = 3; let b = a; log(b);", 3],
  FunctionDeclaration: ["function f() { return 4; } log(f());", 4],
  BlockStatement: ["{ const a = 5; log(a); }", 5],
  IfStatement: ["if (true) { log(6); } else { log(0); }", 6],
  WhileStatement: ["let n = 0; while (n < 7) { n += 1; } log(n);", 7],
  ForStatement: ["let s = 0; for (let i = 0; i < 4; i += 1) { s += 2; } log(s);", 8],
  ForOfStatement: ["let s = 0; for (const x of [4, 5]) { s += x; } log(s);", 9],
  ReturnStatement: ["const f = () => { return 10; }; log(f());", 10],
  BreakStatement: ["let n = 0; while (true) { n = 11; break; } log(n);", 11],
  ContinueStatement: ["let n = 0; for (const x of [1, 2, 3]) { if (x === 2) { continue; } n += x; } log(n + 8);", 12],
  ThrowStatement: ["try { throw 13; } catch (e) { log(e); }", 13],
  TryStatement: ["let n = 0; try { n = 14; } finally { log(n); }", 14],
  SwitchStatement: ["switch (15) { case 15: { log(15); break; } default: break; }", 15],
  EmptyStatement: ["; log(16);", 16],
  Literal: ["log(17);", 17],
  Identifier: ["const eighteen = 18; log(eighteen);", 18],
  TemplateLiteral: ["log(`${19}`);", "19"],
  ArrayExpression: ["log([20][0]);", 20],
  ObjectExpression: ["log({ a: 21 }.a);", 21],
  MemberExpression: ["const o = { a: [22] }; log(o.a[0]);", 22],
  ChainExpression: ["const o = null; log(o?.a ?? 23);", 23],
  UnaryExpression: ["log(-(-24));", 24],
  UpdateExpression: ["let n = 24; n++; log(n);", 25],
  BinaryExpression: ["log(13 * 2);", 26],
  LogicalExpression: ["log(null ?? 27);", 27],
  ConditionalExpression: ["log(true ? 28 : 0);", 28],
  AssignmentExpression: ["let n = 0; n = 29; log(n);", 29],
  AwaitExpression: ["log(await 30);", 30],
  ArrowFunctionExpression: ["log((() => 31)());", 31],
  FunctionExpression: ["const f = function () { return 32; }; log(f());", 32],
  CallExpression: ["log(len([1, 2, 3]) + 30);", 33],
};

{
  const untested = [...ADMITTED_NODES].filter((t) => EXECUTES[t] === undefined);
  ok("every admitted node type has an execution cell", untested.length === 0, untested);
  for (const [type, [program, expected]] of Object.entries(EXECUTES)) {
    const logs = await logsOf(program);
    ok(`${type} executes`, JSON.stringify(logs[0]) === JSON.stringify(expected), logs);
  }
}

const REJECTS: Readonly<Record<string, string>> = {
  ClassDeclaration: "class C {}",
  ClassExpression: "const C = class {};",
  ThisExpression: "const f = () => this;",
  ForInStatement: "for (const k in {}) { }",
  YieldExpression: "function* g() { yield 1; }",
  TaggedTemplateExpression: "const f = () => 1; f`x`;",
  NewExpression: "const f = () => 1; new f();",
  ImportDeclaration: "import x from 'y';",
  ImportExpression: "await import('y');",
  ExportNamedDeclaration: "export const a = 1;",
  ExportDefaultDeclaration: "export default 1;",
  ExportAllDeclaration: "export * from 'y';",
  DoWhileStatement: "do { } while (false);",
  LabeledStatement: "l: for (;;) { break; }",
  SequenceExpression: "const a = (1, 2);",
  MetaProperty: "const m = import.meta;",
  DebuggerStatement: "debugger;",
};

{
  const untested = Object.keys(FORBIDDEN_NODES).filter((t) => REJECTS[t] === undefined);
  ok("every forbidden row has a rejection cell", untested.length === 0, untested);
  for (const [type, program] of Object.entries(REJECTS)) {
    const want = FORBIDDEN_NODES[type]?.code as LangErrorCode;
    ok(`${type} is rejected with ${want}`, codesOf(program).includes(want), codesOf(program));
  }
  // The conditional refusals the table cannot carry, and the operator rows.
  ok("a labelled break is L1017", codesOf("l: while (true) { break l; }").includes("L1017"));
  ok("`await` outside an async function is L1023", codesOf("function f() { await 1; }").includes("L1023"));
  ok("`with` cannot parse in a module and is still named as L1013", codesOf("with ({}) { }").includes("L1013"));
  ok("`==` is L1025", codesOf("const a = 1 == 1;").includes("L1025"));
  ok("`!=` is L1025", codesOf("const a = 1 != 1;").includes("L1025"));
  ok("`void` is L1027", codesOf("const a = void 0;").includes("L1027"));
  ok("a `__proto__` key is L1028", codesOf("const o = { __proto__: {} };").includes("L1028"));
  ok("`==` and friends never reach the interpreter: `===` is JavaScript's", (await logsOf('log(0 === "0", null === undefined);'))[0]?.toString() === "false,false");
  ok("a switch case whose block ends in a terminator is accepted", codesOf("switch (1) { case 1: { break; } default: { return; } }").length === 0 || !codesOf("switch (1) { case 1: { break; } default: { break; } }").includes("L1010"));
  ok("and one whose block does not is still L1010", codesOf("function f(x) { switch (x) { case 1: { log(1); } default: break; } }").includes("L1010"));
  ok("an unawaited USER async function is L2013", codesOf("async function w(x) { await sleep('1s'); return x; } const p = w(1);").includes("L2013"));
  ok("an unawaited const bound to an async arrow is L2013", codesOf("const w = async (x) => { await sleep('1s'); return x; }; const p = w(1);").includes("L2013"));
  ok("an awaited, returned or thunked call is not", codesOf("async function w(x) { await sleep('1s'); return x; } const a = await w(1); async function g() { return w(2); } await parallel({ b: () => w(3) });").length === 0);
  ok("a member write to a captured record from a branch is L2032", codesOf("const acc = {}; await parallel({ a: async () => { acc.a = 1; }, b: async () => 2 });").includes("L2032"));
  ok("a mutator call on a captured array from a branch is L2032", codesOf("const out = []; await parallel({ a: async () => { out.push(1); }, b: async () => 2 });").includes("L2032"));
  ok("a host global names its replacement", (() => { try { validate("const x = JSON.stringify({});"); return false; } catch (e) { return e instanceof LangErrors && e.errors.some((x) => x.code === "L2012" && x.fix.includes("json.stringify")); } })());
}

// ---- 5) the method tables, each entry called; `sort`'s total order -----------------------------------

const ARRAY_CALLS: Readonly<Record<string, string>> = {
  map: "[1].map((x) => x)", filter: "[1].filter((x) => x)", find: "[1].find((x) => x)", findIndex: "[1].findIndex((x) => x)",
  findLast: "[1].findLast((x) => x)", findLastIndex: "[1].findLastIndex((x) => x)", some: "[1].some((x) => x)", every: "[1].every((x) => x)",
  forEach: "[1].forEach((x) => x)", reduce: "[1].reduce((a, b) => a + b, 0)", flatMap: "[1].flatMap((x) => [x])", includes: "[1].includes(1)",
  indexOf: "[1].indexOf(1)", lastIndexOf: "[1].lastIndexOf(1)", slice: "[1].slice(0)", concat: "[1].concat([2])", join: "[1].join(',')",
  flat: "[[1]].flat()", at: "[1].at(0)", toReversed: "[1].toReversed()", push: "[1].push(2)", pop: "[1].pop()", shift: "[1].shift()",
  unshift: "[1].unshift(0)", splice: "[1].splice(0, 1)",
};
const STRING_CALLS: Readonly<Record<string, string>> = {
  trim: "' a '.trim()", trimStart: "' a '.trimStart()", trimEnd: "' a '.trimEnd()", toLowerCase: "'A'.toLowerCase()", toUpperCase: "'a'.toUpperCase()",
  startsWith: "'ab'.startsWith('a')", endsWith: "'ab'.endsWith('b')", includes: "'ab'.includes('a')", indexOf: "'ab'.indexOf('b')", lastIndexOf: "'ab'.lastIndexOf('b')",
  slice: "'ab'.slice(1)", substring: "'ab'.substring(1)", split: "'a,b'.split(',')", replace: "'ab'.replace('a', 'c')", replaceAll: "'aa'.replaceAll('a', 'c')",
  repeat: "'a'.repeat(2)", padStart: "'a'.padStart(2, '0')", padEnd: "'a'.padEnd(2, '0')", at: "'ab'.at(0)", charAt: "'ab'.charAt(0)", concat: "'a'.concat('b')",
};
const NUMBER_CALLS: Readonly<Record<string, string>> = {
  toFixed: "(1.5).toFixed(1)", toString: "(255).toString(16)", toPrecision: "(1.5).toPrecision(2)",
};

{
  const tables = [
    ["array", Object.keys(arrayMethods({ runId: "x", programHash: "sha256:0", startedAt: 0, prng: new Prng("s"), assertWritable: () => undefined })), ARRAY_CALLS],
    ["string", Object.keys(stringMethods()), STRING_CALLS],
    ["number", Object.keys(numberMethods()), NUMBER_CALLS],
  ] as const;
  for (const [kind, names, calls] of tables) {
    const untested = names.filter((n) => calls[n] === undefined);
    ok(`every ${kind} method has a call cell`, untested.length === 0, untested);
    const stale = Object.keys(calls).filter((n) => !names.includes(n));
    ok(`and every ${kind} call cell names a method in the table`, stale.length === 0, stale);
    const program = `log(${names.map((n) => `typeof (${calls[n]})`).join(", ")});`;
    const [types] = (await logsOf(program)) as [string[]];
    ok(`every ${kind} method is callable on its receiver`, Array.isArray(types) && types.length === names.length && types.every((t) => t !== "function"), types);
  }
  ok("a member outside the table on an array is L4014, with the table in the message", await logsOf("[1].foo()").then(() => false, (e: Error) => e.message.startsWith("L4014") && e.message.includes("flatMap")));
  ok("a host prototype is not reachable through a record", (await logsOf("const o = {}; log(o.constructor === undefined, o.hasOwnProperty === undefined, o.__proto__ === undefined);"))[0]?.toString() === "true,true,true");
  ok("`sort` orders numbers by value and strings by code unit", JSON.stringify(await logsOf('log(sort([10, 9, 1]), sort(["b", "a", "B"]));')) === JSON.stringify([[[1, 9, 10], ["B", "a", "b"]]]));
  ok("`sort` with a key breaks ties by the canonical form of the elements, whatever their input order", JSON.stringify(await logsOf('log(sort([{ n: 1, k: "b" }, { n: 1, k: "a" }], (x) => x.n), sort([{ n: 1, k: "a" }, { n: 1, k: "b" }], (x) => x.n));')) === JSON.stringify([[[{ n: 1, k: "a" }, { n: 1, k: "b" }], [{ n: 1, k: "a" }, { n: 1, k: "b" }]]]));
  ok("`sort` returns a new array and leaves its input alone", JSON.stringify(await logsOf("const xs = [2, 1]; const ys = sort(xs); log(xs, ys);")) === JSON.stringify([[[2, 1], [1, 2]]]));
  ok("`json.stringify` is the canonical form (sorted keys, no spaces)", (await logsOf('log(json.stringify({ b: 1, a: [2, { d: 3, c: 4 }] }));'))[0] === '{"a":[2,{"c":4,"d":3}],"b":1}');
  // And it REFUSES what has no canonical form, instead of silently dropping or nulling it
  // (measured before the rule: `{ a: undefined }` lost its key, `[undefined]` and NaN became
  // null — information loss wearing the canonical name).
  ok("`json.stringify` refuses a value with no canonical form (L4016), naming the path",
    await logsOf("log(json.stringify({ b: 1, a: undefined }));").then(() => false, (e: Error) => e.message.startsWith("L4016") && e.message.includes(".a"))
      && await logsOf("log(json.stringify([undefined, 1]));").then(() => false, (e: Error) => e.message.startsWith("L4016"))
      && await logsOf("log(json.stringify(0 / 0));").then(() => false, (e: Error) => e.message.startsWith("L4016")));
  // JSON can spell an OWN field named __proto__, which the literal (L1028) and the member write
  // (L4014) both refuse — a parse that minted one was a bypass around both (measured).
  ok("`json.parse` refuses a \"__proto__\" key (L4016), exactly as the literal refuses it",
    await logsOf(`log(json.parse('{"__proto__":{"polluted":true}}'));`).then(() => false, (e: Error) => e.message.startsWith("L4016") && e.message.includes("__proto__"))
      && await logsOf(`log(json.parse('{"nested":{"__proto__":1}}'));`).then(() => false, (e: Error) => e.message.startsWith("L4016"))
      && JSON.stringify(await logsOf(`log(keys(json.parse('{"constructor":1}')));`)) === '[["constructor"]]');
  // The order is TOTAL: NaN sorts after every number, undefined and null rank below everything,
  // and both directions of the same input agree (measured before the rule: NaN compared "equal"
  // to every number and `[undefined, null]` kept its arrival order).
  ok("`sort` is total: NaN after every number, undefined below null, both directions agreeing",
    JSON.stringify(await logsOf("log(sort([1, 0 / 0, 0]), sort([0 / 0, 0, 1]));")) === '[[[0,1,null],[0,1,null]]]'
      && JSON.stringify(await logsOf("log(sort([null, undefined])[0] === undefined, sort([undefined, null])[0] === undefined, sort([\"b\", 2, null, true])[0] === null);")) === '[[true,true,true]]');
  ok("a fresh local record and array may be written; a value that crossed an effect boundary may not (L2031)",
    (await logsOf("const o = { a: 1 }; o.b = 2; const xs = [1]; xs.push(2); xs[2] = 6; xs[0] = 0; log(o, xs.length);"))[0]?.toString() === "[object Object],3"
      && await logsOf('const b = await spawn("b"); b.x = 1;').then(() => false, (e: Error) => e.message.startsWith("L2031")));
  // Contiguous or refused: a write past the end would create holes, a value class this language
  // does not have (measured before the rule: `xs[2] = 1` on an empty array built a sparse array
  // whose holes crossed an effect boundary as silent nulls). At the length it appends.
  ok("an array index write past the end is L4019, catchable, and names the index and the length",
    await logsOf("const xs = [1, 2]; xs[5] = 6;").then(() => false, (e: Error) => e.message.startsWith("L4019") && e.message.includes("index 5") && e.message.includes("length 2"))
      && JSON.stringify(await logsOf("const xs = []; try { xs[2] = 1; } catch (e) { log(e.code); } log(xs);")) === '["L4019",[]]');
  // No implicit conversion: a container or function where a primitive is needed is L4018 rather
  // than the host's ToPrimitive machinery (measured before the rule: `o + 1` with an own `valueOf`
  // closure crashed with a raw host TypeError, and `${f}` printed the interpreter's compiled
  // closure source).
  ok("`+`, comparison, unary minus, and `${...}` refuse a record, an array, or a function with L4018",
    await logsOf("const o = { a: 1 }; log(o + 1);").then(() => false, (e: Error) => e.message.startsWith("L4018"))
      && await logsOf("log([1] + 1);").then(() => false, (e: Error) => e.message.startsWith("L4018"))
      && await logsOf("const o = { a: 1 }; log(o > o);").then(() => false, (e: Error) => e.message.startsWith("L4018"))
      && await logsOf("log(-[1]);").then(() => false, (e: Error) => e.message.startsWith("L4018"))
      && await logsOf("const f = () => 1; log(`${f}`);").then(() => false, (e: Error) => e.message.startsWith("L4018"))
      && JSON.stringify(await logsOf('const o = { a: 1 }; try { log(`${o}`); } catch (e) { log(e.code); }')) === '["L4018"]');
  ok("but identity comparison takes any operands, and primitives coerce as JavaScript coerces them",
    JSON.stringify(await logsOf('const o = { a: 1 }; const p = o; log(o === p, o !== p, "a" + 1, true + 1, null + 1);')) === '[[true,false,"a1",2,1]]');
  // A method is not a value: it is looked up at the call and exists nowhere else (measured before
  // the rule: `xs.map === xs.map` was false where JavaScript says true, and an extracted `push`
  // wrote to its receiver where strict JavaScript throws).
  ok("a bare method read is L4020, catchable, and names the method",
    await logsOf("const xs = [1]; const m = xs.map;").then(() => false, (e: Error) => e.message.startsWith("L4020") && e.message.includes("map"))
      && await logsOf('log("a".trim === "a".trim);').then(() => false, (e: Error) => e.message.startsWith("L4020"))
      && await logsOf("const xs = [1]; const { push } = xs;").then(() => false, (e: Error) => e.message.startsWith("L4020"))
      && JSON.stringify(await logsOf("const xs = [1, 2]; log(xs.map((x) => x * 2));")) === '[[2,4]]');
  // `xs.length = n` is a write the table permits; a LONGER length is refused with its own code rather
  // than escaping as the host's "Cannot redefine property: length" (measured before the rule).
  ok("`xs.length = n` longer than the array, negative, or not an integer is L4017, catchable, and names the bound",
    await logsOf("const xs = [1]; xs.length = 3;").then(() => false, (e: Error) => e.message.startsWith("L4017") && e.message.includes("current length (1)"))
      && await logsOf("const xs = [1]; xs.length = -1;").then(() => false, (e: Error) => e.message.startsWith("L4017"))
      && await logsOf("const xs = [1]; xs.length = 0.5;").then(() => false, (e: Error) => e.message.startsWith("L4017"))
      && JSON.stringify(await logsOf('const xs = [1]; try { xs.length = 3 } catch (e) { log(e.code) } log(xs);')) === '["L4017",[1]]');
  ok("a value born outside a concurrent branch and written inside it, through an alias, is L2032",
    await logsOf("const acc = {}; await parallel({ a: async () => { const local = acc; local.a = 1; }, b: async () => 2 });").then(() => false, (e: Error) => e.message.startsWith("L2032")));
  ok("a value born inside a branch may be written there and is returned frozen",
    JSON.stringify(await logsOf("const r = await parallel({ a: async () => { const xs = []; xs.push(1); return xs; } }); log(r.a);")) === "[[1]]"
      && await logsOf("const r = await parallel({ a: async () => [1] }); r.a.push(2);").then(() => false, (e: Error) => e.message.startsWith("L2031")));
  // The boundary refuses INPUTS as well as results, before any entry is written: `undefined` and a
  // non-finite number are L3041, a function is L3042, and the argument is named.
  const refusedAs = (source: string): Promise<string> =>
    logsOf(source).then(() => "accepted", (e: Error) => e.message.slice(0, 5));
  ok("`undefined` inside an effect's argument is L3041, naming the argument",
    await refusedAs('const b = await spawn("b"); await ask(b, { name: "q", schema: { x: undefined } });') === "L3041"
      && await logsOf('const b = await spawn("b"); await ask(b, { name: "q", schema: { x: undefined } });')
        .then(() => false, (e: Error) => e.message.includes("argument 2 of `ask`.schema.x")));
  ok("a non-finite number inside an effect's argument is L3041",
    await refusedAs('const b = await spawn("b"); await ask(b, { name: "q", schema: { x: 1 / 0 } });') === "L3041");
  ok("a function inside an effect's argument is L3042",
    await refusedAs('const b = await spawn("b"); await ask(b, { name: "q", schema: { f: (x) => x } });') === "L3042");
  ok("a refused input writes no journal entry",
    await (async () => {
      const r = await run('const b = await spawn("b"); try { await ask(b, { name: "q", schema: { x: undefined } }); } catch (e) { log(e.code); }', { runId: "surf", handler: new SimHandler({}) });
      return r.journal.entries().map((e) => e.kind).join(",") === "spawn";
    })());
}

// ---- 6) the language reference and the guide parse ------------------------------------------------------

for (const rel of ["spec/cotal-lang.md", "docs/workflows.md"]) {
  const path = `${here}/../../../${rel}`;
  let text: string | null = null;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    text = null;
  }
  if (text !== null) {
    const blocks = [...text.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1] as string);
    const bad: string[] = [];
    for (const [i, block] of blocks.entries()) {
      // A block marked as an example of a REFUSAL states its code on the first line.
      const refusal = /^\/\/ refused: (L\d{4})/.exec(block);
      const codes = codesOf(block);
      if (refusal !== null) {
        if (!codes.includes(refusal[1] as string)) bad.push(`block ${i + 1}: expected ${refusal[1]}, got ${codes.join(",") || "accepted"}`);
      } else if (codes.length > 0) {
        bad.push(`block ${i + 1}: ${codes.join(",")}`);
      }
    }
    ok(`every js block in ${rel} validates as written (${blocks.length} blocks)`, bad.length === 0, bad);
  } else {
    console.log(`  (${rel} not present; its cells skipped)`);
  }
}

console.log(`surface.smoke: ${pass} checks passed`);
