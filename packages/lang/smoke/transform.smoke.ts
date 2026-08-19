/**
 * The transform's surface: what the emitted module IS, before anything runs it.
 *
 * The differential suite is the primary gate and it needs an engine to run against. This one holds
 * the properties that are true of the emitted string alone, and they are not small: the module has
 * NO unbound references (seam ruling 1 — the host evaluates it with zero endowments and passes the
 * context as the call argument), it reaches no seam member that has not been ruled, it is a pure
 * function of its source, and every node type the language admits has a rule.
 *
 * Each cell reports a COUNT. A parity check that silently walked an empty corpus would be green
 * forever, so the coverage cell derives its universe from `syntax.ts` and fails on a type no corpus
 * program contains, rather than trusting a hand-kept list.
 */
import { parse } from "acorn";
import { transform } from "../src/transform/index.js";
import { SEAM_PROPOSED, SEAM_RULED } from "../src/transform/seam.js";
import { ADMITTED_NODES } from "../src/syntax.js";
import { run as walk } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

type Node = Record<string, unknown> & { type: string };

const parseModule = (js: string): Node => parse(`(${js})`, { ecmaVersion: 2023, sourceType: "module" }) as unknown as Node;

// ---- a scope resolver over the EMITTED code ------------------------------------------------------

/**
 * Every identifier the emitted module references and does not bind.
 *
 * Written here rather than imported, because what it reads is not cotal-lang: it is the JavaScript
 * the emitter produces, and the property under test is exactly that this set is empty. A positive
 * control below injects a free name and requires it to be found, so an empty answer means "none",
 * never "the walk missed them".
 */
function unbound(root: Node): string[] {
  const found = new Set<string>();
  const declare = (scope: Set<string>, pattern: Node | null): void => {
    if (pattern === null || pattern === undefined) return;
    switch (pattern.type) {
      case "Identifier":
        scope.add(pattern.name as string);
        return;
      case "AssignmentPattern":
        declare(scope, pattern.left as Node);
        return;
      case "RestElement":
        declare(scope, pattern.argument as Node);
        return;
      case "ObjectPattern":
        for (const p of pattern.properties as Node[]) declare(scope, (p.type === "RestElement" ? p.argument : p.value) as Node);
        return;
      case "ArrayPattern":
        for (const el of pattern.elements as (Node | null)[]) declare(scope, el);
        return;
      default:
        return;
    }
  };

  const walk = (node: unknown, scopes: Set<string>[]): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, scopes);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const n = node as Node;
    const resolved = (name: string): boolean => scopes.some((s) => s.has(name));

    switch (n.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        if (n.type === "FunctionDeclaration" && n.id !== null && n.id !== undefined) declare(scopes[scopes.length - 1] as Set<string>, n.id as Node);
        const inner = new Set<string>();
        if (n.type === "FunctionExpression" && n.id !== null && n.id !== undefined) declare(inner, n.id as Node);
        for (const p of (n.params as Node[]) ?? []) declare(inner, p);
        const next = [...scopes, inner];
        for (const p of (n.params as Node[]) ?? []) walk(p, next);
        walk(n.body, next);
        return;
      }
      case "Program":
      case "BlockStatement":
      case "StaticBlock": {
        const inner = new Set<string>();
        const body = (n.body as Node[]) ?? [];
        for (const s of body) {
          if (s.type === "FunctionDeclaration" && s.id !== null && s.id !== undefined) declare(inner, s.id as Node);
          if (s.type === "VariableDeclaration") for (const d of s.declarations as Node[]) declare(inner, d.id as Node);
        }
        const next = [...scopes, inner];
        for (const s of body) walk(s, next);
        return;
      }
      case "ForStatement":
      case "ForOfStatement":
      case "ForInStatement": {
        const inner = new Set<string>();
        for (const key of ["init", "left"]) {
          const d = n[key] as Node | undefined;
          if (d?.type === "VariableDeclaration") for (const decl of d.declarations as Node[]) declare(inner, decl.id as Node);
        }
        const next = [...scopes, inner];
        for (const key of ["init", "left", "test", "update", "right", "body"]) if (n[key] !== undefined && n[key] !== null) walk(n[key], next);
        return;
      }
      case "CatchClause": {
        const inner = new Set<string>();
        declare(inner, (n.param ?? null) as Node | null);
        walk(n.body, [...scopes, inner]);
        return;
      }
      case "SwitchStatement": {
        walk(n.discriminant, scopes);
        const inner = new Set<string>();
        for (const c of (n.cases as Node[]) ?? []) {
          for (const s of (c.consequent as Node[]) ?? []) {
            if (s.type === "FunctionDeclaration" && s.id !== null && s.id !== undefined) declare(inner, s.id as Node);
            if (s.type === "VariableDeclaration") for (const d of s.declarations as Node[]) declare(inner, d.id as Node);
          }
        }
        walk(n.cases, [...scopes, inner]);
        return;
      }
      case "VariableDeclarator":
        // The name is declared by the block pass above; only the initializer is a reference site.
        walk(n.init, scopes);
        return;
      case "MemberExpression":
        walk(n.object, scopes);
        if (n.computed === true) walk(n.property, scopes);
        return;
      case "Property":
        if (n.computed === true) walk(n.key, scopes);
        walk(n.value, scopes);
        return;
      case "LabeledStatement":
        walk(n.body, scopes);
        return;
      case "BreakStatement":
      case "ContinueStatement":
        return;
      case "Identifier":
        if (!resolved(n.name as string)) found.add(n.name as string);
        return;
      default: {
        for (const [k, v] of Object.entries(n)) {
          if (k === "type" || k === "start" || k === "end" || k === "loc" || k === "range") continue;
          walk(v, scopes);
        }
        return;
      }
    }
  };

  walk(root, []);
  return [...found].sort();
}

/** Every `<ctx>.<member>` the emitted module reaches. */
function seamMembers(root: Node, ctx: string): string[] {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const n = node as Node;
    if (n.type === "MemberExpression") {
      const obj = n.object as Node;
      const prop = n.property as Node;
      if (obj.type === "Identifier" && obj.name === ctx && n.computed !== true) out.add(prop.name as string);
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === "type" || k === "start" || k === "end" || k === "loc" || k === "range") continue;
      walk(v);
    }
  };
  walk(root);
  return [...out].sort();
}

const nodeTypes = (root: Node): Set<string> => {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const n = node as Node;
    out.add(n.type);
    for (const [k, v] of Object.entries(n)) {
      if (k === "type" || k === "start" || k === "end" || k === "loc" || k === "range") continue;
      walk(v);
    }
  };
  walk(root);
  return out;
};

// ---- the corpus ---------------------------------------------------------------------------------

/**
 * One program per shape the emitter has a rule for. The COVERAGE cell below derives its universe
 * from `syntax.ts` and reports what is missing, so a node type nothing here exercises is a red
 * cell rather than an untested rule.
 */
const CORPUS: readonly (readonly [string, string])[] = [
  ["literals and names", 'const a = 1; const b = "t"; const c = true; const d = null; log(a, b, c, d);'],
  ["template", "const n = 2; log(`n=${n}!`);"],
  ["array and object literals", "const xs = [1, 2]; const o = { a: 1, b: xs }; log(o, xs);"],
  ["spread", "const xs = [1, 2]; const ys = [0, ...xs]; const o = { ...{ a: 1 }, b: 2 }; log(ys, o);"],
  ["member read and write", "const o = { a: 1 }; o.a = 2; const xs = [1]; xs[0] = 3; log(o.a, xs[0]);"],
  ["computed member", 'const k = "a"; const o = { a: 1 }; log(o[k]);'],
  ["optional chain", "const o = { a: { b: 1 } }; log(o.a?.b, o.z?.b);"],
  ["method call", "const xs = [1, 2]; log(xs.map((x) => x + 1));"],
  ["operators", "const a = 1 + 2 * 3; const b = -a; const c = ~a; const d = !true; const e = a === 7; log(a, b, c, d, e, a % 2, a ** 2, a > 1, a & 1);"],
  ["logical and conditional", "const a = 1 || 2; const b = null ?? 3; const c = a ? 1 : 2; const d = a && b; log(a, b, c, d);"],
  ["update", "let n = 0; n++; ++n; const o = { c: 0 }; o.c++; log(n, o.c);"],
  ["assignment operators", "let n = 1; n += 2; n -= 1; n ||= 9; n &&= 4; let m = null; m ??= 5; log(n, m);"],
  ["if and blocks", "const a = 1; if (a === 1) { log(1); } else { log(2); }"],
  ["while with break and continue", "let n = 0; while (true) { n = n + 1; if (n === 2) { continue; } if (n > 3) { break; } } log(n);"],
  ["for with per-iteration closures", "const fs = []; for (let i = 0; i < 3; i = i + 1) { fs.push(() => i); } log(len(fs));"],
  ["for over items", "let s = 0; for (const x of [1, 2, 3]) { s = s + x; } log(s);"],
  ["switch", 'const a = 2; switch (a) { case 1: { log("one"); break; } case 2: { log("two"); break; } default: { log("other"); break; } }'],
  ["try catch finally", 'try { throw { code: "x" }; } catch (e) { log(e.code); } finally { log("done"); }'],
  ["try with no parameter", "try { throw 1; } catch { log(2); }"],
  ["functions and closures", "function add(a, b) { return a + b; } const inc = (x) => x + 1; log(add(1, 2), inc(3));"],
  ["default and rest parameters", "function f(a, b = 2, ...rest) { return a + b + len(rest); } log(f(1), f(1, 2, 3, 4));"],
  ["destructuring", "const { a, b: bb, ...rest } = { a: 1, b: 2, c: 3 }; const [x, , ...ys] = [1, 2, 3, 4]; log(a, bb, rest, x, ys);"],
  ["destructuring assignment", "let a = 1; let b = 2; [a, b] = [b, a]; log(a, b);"],
  ["a captured mutable binding is a cell", "let seen = 0; const bump = () => { seen = seen + 1; }; bump(); log(seen);"],
  ["free names in value position", "const f = map; log(len(f([1, 2], (x) => x)), map === map);"],
  ["a named function expression", "const fact = function walk(n) { return n === 0 ? 1 : n * walk(n - 1); }; log(fact(4));"],
  ["effects", 'const a = await spawn("builder"); const r = await turn(a, { name: "build" }); log(r.status);'],
  ["a scope combinator", 'await parallel({ one: () => sleep("1m", { name: "one" }), two: () => sleep("2m", { name: "two" }) }, { name: "both" });'],
  ["empty statement", "; log(1);"],
  ["the undefined value", "const u = undefined; log(u === undefined);"],
];

// ---- 1) every emitted module is closed --------------------------------------------------------------

{
  let checked = 0;
  for (const [name, source] of CORPUS) {
    const { module, meta } = transform(source);
    const free = unbound(parseModule(module));
    ok(`the emitted module has no unbound reference: ${name}`, free.length === 0, free);
    const members = seamMembers(parseModule(module), meta.ctx);
    const unruled = members.filter((m) => !SEAM_RULED.has(m) && SEAM_PROPOSED[m] === undefined);
    ok(`and reaches no seam member outside the ruling: ${name}`, unruled.length === 0, unruled);
    checked += 1;
  }
  console.log(`  (${checked} corpus programs closed over the seam)`);
}

// ---- 2) the resolver would find one if there were one -------------------------------------------

{
  // The cell above is a claim about an EMPTY set, and an empty set is what a broken walk also
  // produces. This is the positive control: the same resolver, over emitted code with one name
  // renamed out from under its binding, must name it.
  const { module } = transform("const a = 1; log(a);");
  const broken = module.replace("const a = 1;", "const a$renamed = 1;");
  const free = unbound(parseModule(broken));
  ok("the resolver names a free identifier when one exists", free.includes("a"), free);
}

// ---- 3) purity ------------------------------------------------------------------------------------

{
  let same = 0;
  for (const [, source] of CORPUS) {
    const a = transform(source);
    const b = transform(source);
    if (a.module === b.module && a.meta.programHash === b.meta.programHash) same += 1;
  }
  ok("transform is a pure function of its source, byte for byte", same === CORPUS.length, { same, of: CORPUS.length });
}

// ---- 4) a program cannot shadow the context ------------------------------------------------------

{
  // The validator ADMITS a program-declared `__ctx` (measured at 9dc154f8), so the name is picked
  // against the program's own identifiers rather than assumed. Emitting it verbatim would rebind the
  // whole seam to a program value for the rest of that scope.
  const { module, meta } = transform("const __ctx = 1; log(__ctx);");
  ok("a program that declares `__ctx` does not get the context's name", meta.ctx !== "__ctx", meta.ctx);
  ok("and the module is still closed", unbound(parseModule(module)).length === 0, unbound(parseModule(module)));
  const plain = transform("const a = 1; log(a);");
  ok("a program that does not declare it keeps the contract's name", plain.meta.ctx === "__ctx", plain.meta.ctx);
}

// ---- 5) every admitted node type has a rule ------------------------------------------------------

{
  const covered = new Set<string>();
  for (const [, source] of CORPUS) for (const t of nodeTypes(parse(source, { ecmaVersion: 2023, sourceType: "module", allowAwaitOutsideFunction: true }) as unknown as Node)) covered.add(t);
  const missing = [...ADMITTED_NODES].filter((t) => !covered.has(t));
  ok("the corpus exercises every admitted node type", missing.length === 0, missing);
  console.log(`  (${ADMITTED_NODES.size} admitted node types, ${covered.size} node types in the corpus)`);
}

// ---- 6) the surfaced-but-unruled debt is exactly what it is ---------------------------------------

{
  const reached = new Set<string>();
  for (const [, source] of CORPUS) for (const m of transform(source).meta.proposed) reached.add(m);
  // PINNED, not asserted empty: `callee` is surfaced on #fix.lang-transform and not yet ruled, and a
  // suite that hid that behind a green cell would be the forbidden move wearing a passing test. When
  // it is ruled the member moves to SEAM_RULED and this list shrinks in the same change.
  const expected = ["callee"];
  ok("the emission's unruled seam debt is exactly the surfaced list", JSON.stringify([...reached].sort()) === JSON.stringify(expected), {
    reached: [...reached].sort(),
    expected,
  });
  ok("and every surfaced member carries its reason", Object.keys(SEAM_PROPOSED).every((m) => (SEAM_PROPOSED[m] as string).length > 40));
}

// ---- 7) site accounting: each routing rule, counted ----------------------------------------------

/**
 * What each rule COSTS, derived by hand and then held.
 *
 * A shape check can pass while a rule quietly stops firing — the module still parses, still has no
 * free names, still reaches only ruled members. The counts are what notice: a member read that
 * stopped going through `get`, a loop header that stopped charging fuel, and a literal that stopped
 * being born all move a number here.
 */
const SITES: readonly (readonly [string, string, Readonly<Record<string, number>>])[] = [
  // one fuel for the module body, one born for the literal, one get for `o.a`, one free for `log`.
  ["a member read is one get", "const o = { a: 1 }; log(o.a);", { fuel: 1, born: 1, get: 1, free: 1 }],
  // the write is a set; the read of `o.a` in the log is a get.
  ["a member write is one set", "const o = { a: 1 }; o.a = 2; log(o.a);", { fuel: 1, born: 1, get: 1, set: 1, free: 1 }],
  // module + loop header. The header charges on every pass, including the one that ends the loop.
  ["a loop header charges fuel", "let n = 0; while (n < 1) { n = n + 1; } log(n);", { fuel: 2 }],
  // module + the arrow's entry.
  ["a function entry charges fuel", "const f = (x) => x; log(f(1));", { fuel: 2 }],
  // module + the await site.
  ["an await charges fuel and passes the thenable gate", 'await sleep("1m", { name: "s" });', { fuel: 2, await: 1, effect: 1 }],
  // a method is resolved at the call and nowhere else.
  ["a method call is one call and no get", "const xs = [1]; log(xs.map((x) => x));", { call: 1, get: 0 }],
  // interpolation is the seam's, not the host's.
  ["a template is one template", "log(`a${1}b`);", { template: 1 }],
  // spread and for-of are the iterability law.
  ["a spread is one iter", "const xs = [1]; log([...xs]);", { iter: 1 }],
  ["a for-of is one iter", "for (const x of [1]) { log(x); }", { iter: 1 }],
];

{
  for (const [name, source, expected] of SITES) {
    const { meta } = transform(source);
    const actual = Object.fromEntries(Object.keys(expected).map((k) => [k, meta.sites[k] ?? 0]));
    ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected, all: meta.sites });
  }
}

// ---- 8) the cell scheme, in both directions ------------------------------------------------------

{
  // L2032's binding half. A mutable binding WRITTEN from inside a deeper function carries its depth
  // through a born cell, so `__ctx.set` refuses the write from a concurrent branch exactly as it
  // refuses one to a captured record.
  const captured = transform("let seen = 0; const bump = () => { seen = seen + 1; }; bump(); log(seen);").meta.sites;
  ok("a mutable binding written from a nested function is a born cell", (captured.born ?? 0) === 1 && (captured.set ?? 0) === 1 && (captured.get ?? 0) >= 1, captured);

  // AND THE MIRROR, which is the half that keeps the rule honest: a binding nothing nested writes
  // stays a native binding. Without this cell, "make every binding a cell" passes the cell above
  // and costs the hot path a seam call per read.
  const local = transform("let n = 0; while (n < 3) { n = n + 1; } log(n);").meta.sites;
  ok("a binding no nested function writes stays native", (local.born ?? 0) === 0 && (local.set ?? 0) === 0, local);

  // A `const` can never be a cell: it cannot be written at all.
  const constant = transform("const seen = 0; const read = () => seen; read(); log(seen);").meta.sites;
  ok("a const captured by a nested function is not a cell", (constant.born ?? 0) === 0, constant);
}

// ---- 9) an object literal's keys are emitted computed --------------------------------------------

{
  // `{ __proto__: x }` sets a prototype in JavaScript and names an own field in this language. The
  // validator refuses the literal spelling (L1028), and a COMPUTED key cannot reach a prototype at
  // all — so the emitted form cannot express the hazard whatever the validator does later.
  const { module } = transform("const o = { a: 1 }; log(o);");
  ok("an object literal's keys are emitted computed", module.includes('{ ["a"]: 1 }'), module.slice(0, 200));
}

// ---- 10) an update's coercion is native, because the walker's is ---------------------------------

{
  // `x++` reads its old value through a bare `Number(...)` in the walker, with NO refusal: a record
  // there answers NaN, where `+o.c` on the same record answers L4018. So the update's coercion must
  // NOT be charged to the seam's `unary` member, whose whole content is that refusal. This cell
  // measures the walker rather than restating it, because the oracle is the reason for the rule.
  const logs: unknown[] = [];
  const r = await walk("const o = { c: {} }; o.c++; log(o.c);", {
    runId: "u",
    handler: new SimHandler({}),
    onLog: (l) => logs.push([...l.values]),
  });
  ok("the walker coerces an update's operand without refusing", JSON.stringify(logs) === "[[null]]", { logs, value: r.value });

  const update = transform("let n = 0; n++; const o = { c: 0 }; o.c++; log(n, o.c);").meta.sites;
  ok("an update does not charge the seam's coercion law", (update.unary ?? 0) === 0, update);

  // THE MIRROR. Without it, "never call unary" passes the cell above and silently drops L4018 from
  // every `-x` in the language.
  const negate = transform("const o = {}; log(-o);").meta.sites;
  ok("a unary operator that can refuse still charges it", (negate.unary ?? 0) === 1, negate);
}

console.log(`\ntransform.smoke: ${pass} cells passed`);
