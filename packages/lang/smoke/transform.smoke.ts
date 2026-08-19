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
import { readFileSync } from "node:fs";
import { parse } from "acorn";
import { transform } from "../src/transform/index.js";
import { SEAM_MEMBERS, SEAM_PROPOSED, SEAM_RULED } from "../src/transform/seam.js";
import { ADMITTED_NODES } from "../src/syntax.js";
import { type Node, parseModule, unbound } from "./_module-shape.js";
import { run as walk, stripPositions } from "../src/interpret.js";
import { digest } from "../src/keys.js";
import { SimHandler } from "../src/sim.js";

let pass = 0;
/** Every cell that has passed, in order. Section 23 audits this suite's mutation config against it. */
const CELLS: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  CELLS.push(name);
  console.log(`  ok ${name}`);
};

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

/** Every `<ctx>.<member>(...)` CALL the emitted module makes, as `member` and the count it passes. */
function seamSites(root: Node, ctx: string): { member: string; arity: number }[] {
  const out: { member: string; arity: number }[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const n = node as Node;
    if (n.type === "CallExpression") {
      const callee = n.callee as Node;
      if (callee.type === "MemberExpression" && callee.computed !== true) {
        const obj = callee.object as Node;
        if (obj.type === "Identifier" && obj.name === ctx) out.push({ member: (callee.property as Node).name as string, arity: (n.arguments as unknown[]).length });
      }
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === "type" || k === "start" || k === "end" || k === "loc" || k === "range") continue;
      walk(v);
    }
  };
  walk(root);
  return out;
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

// ---- 0) the FIRST transform in this file, and it is captured ------------------------------------

/**
 * A cell for an emitter fault to land on, and it has to be the first transform the file runs.
 *
 * The emitter throws on a name that resolves to nothing — a plain `Error`, not a language refusal,
 * because a validated program cannot contain one. Every other transform in this file is awaited
 * straight into an assertion, so that throw left the block and killed the process: measured, the
 * suite dies with an uncaught Error after 30 named cells and ZERO failed cells. The mutation config
 * then graded the mutant that causes it by matching the THROW MESSAGE, which is a kill graded on a
 * crash rather than on a cell — the same illegible shape the engine suite closed at its own run
 * boundary. Captured here, the identical break reds by name, and the config aims at that name.
 */
{
  // THE PROGRAM IS CHOSEN, NOT ARBITRARY, and the first one here was wrong. `const a = 1; log(a);`
  // does NOT reach the emitter's throw when a declarator goes unrecorded — an unresolved plain read
  // falls through to the free-name route — so the guard passed under the mutant and the file died
  // 31 cells later exactly as before. Measured on both trees: a `for` header's declarator does
  // reach it. A guard whose subject cannot produce the fault is a cell that only looks like one.
  let thrown: unknown;
  let emitted = "";
  try {
    emitted = transform("const a = 1; for (let i = 0; i < a; i = i + 1) { log(i); }").module;
  } catch (e) {
    thrown = e;
  }
  ok("the transform emits, and a fault in the emitter has a cell to land on", thrown === undefined && emitted.length > 0, {
    thrown: thrown === undefined ? null : `${(thrown as Error).name}: ${(thrown as Error).message.slice(0, 120)}`,
  });
}

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
  ["an optional call, and the chain the host finishes", "const o = { m: () => ({ x: { y: 1 } }) }; log(o.m?.().x.y, o.m?.()?.x);"],
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
  ["a race, whose losers are digested", 'const r = await race({ a: async () => "a", b: async () => "b" }, { name: "r" });\nlog(r.index);'],
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
  // PINNED, not asserted empty. It IS empty at ruling 1c — `callee` became member 14 and moved to
  // SEAM_RULED — but the pin is what makes a future proposal visible: a member reached without a
  // ruling reds here rather than sitting indistinguishable from a granted one, which is the
  // forbidden move wearing a passing test.
  const expected: string[] = [];
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
  // A bare callee is the one call shape the member law cannot cover: `call` resolves a name and
  // calls in one step, and there is no name here. `callee` is member 14 (ruling 1c) and it carries
  // L4011, so a call on a value charges it once and a call on a member never does.
  ["a call on a value charges the callee law", "const f = (x) => x; log(f(1));", { callee: 1, call: 0 }],
  ["a method call charges no callee law", "const xs = [1]; log(xs.map((x) => x));", { callee: 0, call: 1 }],
];

{
  for (const [name, source, expected] of SITES) {
    const { meta } = transform(source);
    const actual = Object.fromEntries(Object.keys(expected).map((k) => [k, meta.sites[k] ?? 0]));
    ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected, all: meta.sites });
  }
}

// ---- 7b) the dead zone the write rule cannot see ------------------------------------------------

/** One program per clause of F7's ruled predicate, and the walker's answer for it. */
const DEAD_ZONE: readonly (readonly [string, string])[] = [
  ["a hoisted function reads it", "const r = f(); function f() { return x } const x = 1; log(r);"],
  ["an arrow inside a hoisted function, any depth", "const r = f(); function f() { const g = () => x; return g(); } const x = 1; log(r);"],
  ["a function expression written before it", "const f = () => x; const r = f(); const x = 1; log(r);"],
  ["an arrow inside its own initializer", "const x = (() => x)(); log(x);"],
  ["a `let` read the same way", "const f = () => n; const r = f(); let n = 1; log(r);"],
  ["a call from a nested block", "const f = () => x; if (true) { log(f()); } const x = 1;"],
  ["two functions deep", "const g = () => { const h = () => x; return h(); }; const r = g(); const x = 1; log(r);"],
];

/**
 * Clause (i) ALONE: a hoisted function reads a binding declared BEFORE it, so the textual clause is
 * false and only "any hoisted declaration on the path" makes this a cell. The rule is deliberately
 * conservative there - a hoisted function is reachable from anywhere in its block - and both engines
 * answer 1 either way, so the classification is the only thing that can be checked.
 */
const HOISTED_ONLY: readonly (readonly [string, string])[] = [
  ["a hoisted function reads a binding declared above it", "const x = 1; function f() { return x } log(f());"],
  ["an arrow inside one, two deep", "const x = 1; function f() { const g = () => x; return g(); } log(f());"],
];

/** The mirror: captured, and provably not readable before the declaration. */
const NATIVE_CAPTURE: readonly (readonly [string, string])[] = [
  ["declared, then captured", "const x = 1; const f = () => x; log(f());"],
  ["declared, then captured two deep", "const x = 1; const g = () => { const h = () => x; return h(); }; log(g());"],
  ["a loop head's per-iteration binding", "const fs = []; for (let i = 0; i < 3; i = i + 1) { fs.push(() => i); } log(len(fs));"],
];

{
  // F7, RULED option (b). A binding a closure can read BEFORE ITS DECLARATION HAS RUN is refused
  // L2004 by the walker — a code a program can catch and read — where a native JavaScript binding
  // answers a host ReferenceError, which `caught` can only report as L4000/host. So that class
  // becomes a record: `born({})` at the top of its block, `set` at the declaration, and every read
  // through `get(cell, "v", name)` so the host answers L2004 for the binding by name.
  const shape = (source: string) => {
    const { module, meta } = transform(source);
    return {
      hoists: (module.match(new RegExp(`= ${meta.ctx}\\.born\\(\\{\\}\\)`, "g")) ?? []).length,
      named: (module.match(new RegExp(`${meta.ctx}\\.get\\([A-Za-z_$][\\w$]*, "v", "`, "g")) ?? []).length,
      module,
    };
  };
  const missed: string[] = [];
  for (const [name, source] of DEAD_ZONE) {
    const { hoists, named } = shape(source);
    if (hoists < 1 || named < 1) missed.push(`${name}: hoists ${hoists}, named reads ${named}`);
  }
  ok("every clause of the ruled dead-zone predicate makes a cell, hoisted and read by name", missed.length === 0, missed);
  console.log(`  (${DEAD_ZONE.length} dead-zone clauses)`);

  // CLAUSE (i) ON ITS OWN. Every program above satisfies the textual clause too, so dropping the
  // hoisted-declaration clause changed nothing there and the mutant SURVIVED. These two reach it
  // alone: the declaration sits ABOVE the function, so only "a hoisted declaration on the path"
  // makes them cells.
  const natively: string[] = [];
  for (const [name, source] of HOISTED_ONLY) {
    const { hoists, named } = shape(source);
    if (hoists < 1 || named < 1) natively.push(`${name}: hoists ${hoists}, named reads ${named}`);
  }
  ok("a hoisted function's read makes a cell wherever the declaration sits", natively.length === 0, natively);

  // AND THE MIRROR, which is the half that keeps the predicate from being "make everything a cell":
  // a binding no closure can reach early stays a native binding, at no seam cost per read.
  const wrong: string[] = [];
  for (const [name, source] of NATIVE_CAPTURE) {
    const { hoists, named } = shape(source);
    if (hoists !== 0 || named !== 0) wrong.push(`${name}: hoists ${hoists}, named reads ${named}`);
  }
  ok("a captured binding no closure can read early stays native", wrong.length === 0, wrong);

  // AND THE RECORD EXISTS BEFORE THE CLOSURE THAT CAPTURES IT. Hoisting is the whole point: created
  // at the declaration, the closure written above it would capture nothing.
  const early = shape("const f = () => x; const r = f(); const x = 1; log(r);");
  const born = early.module.indexOf("born({})");
  const closure = early.module.indexOf("const f = async");
  ok("the record is created before the closure that captures it", born !== -1 && closure !== -1 && born < closure, early.module.slice(0, 240));
  ok("and the declaration writes into that record rather than building one", /\.set\(x, "v", 1\)/.test(early.module) && !early.module.includes("born({ v:"), early.module.slice(0, 260));

  // AND THE TWO CELL CLASSES STAY APART. A binding that is a cell for the WRITE rule alone cannot be
  // read early, so its record is still built where it is declared, with its value already in it.
  const write = transform("let seen = 0; const bump = () => { seen = seen + 1; }; bump(); log(seen);").module;
  // ONLY THE HOISTING HALF, on purpose: whether that program has a cell at all is section 8's claim,
  // and asserting it here too would make this cell the first to red for every mutation about the
  // write rule — a true red that names the wrong rule.
  ok("a cell for the write rule alone is not hoisted", !write.includes("born({})"), write.slice(0, 220));

  // AND F7 OVER WRITES, ruled after the read half. The same predicate decides a WRITE that can land
  // in the dead zone, the record is hoisted for it too, and `set` carries the binding NAME so the
  // host refuses L2004 instead of the write landing silently in a record the declaration has not
  // reached. The declaration's own write never carries the name: it is the one that ends the dead
  // zone, and naming it there would make a binding refuse its own initialisation.
  const dzWrite = shape("function f() { n = 2; } f(); let n = 1; log(n);");
  ok("a write that can land in the dead zone hoists its record", dzWrite.module.includes("born({})"), dzWrite.module.slice(0, 240));
  ok("and carries the binding name, which is what the host refuses on", /\.set\(n, "v", [^)]*, "n"\)/.test(dzWrite.module), dzWrite.module.slice(0, 400));
  ok(
    "while the declaration's own write does not, so it still initialises the binding",
    /\.set\(n, "v", 1\)/.test(dzWrite.module),
    dzWrite.module.slice(0, 400),
  );

  // AND THE ORACLE SAYS SO, for every clause: measured, not quoted. Each dead-zone program refuses
  // L2004 on the walker and each native one answers its value, which is what the classification is
  // reproducing — and what the differential suite will hold the engine to once `get` takes the name.
  const answers: string[] = [];
  for (const [, source] of [...DEAD_ZONE, ...HOISTED_ONLY, ...NATIVE_CAPTURE]) {
    try {
      await walk(source, { runId: "p", handler: new SimHandler({}) });
      answers.push("ok");
    } catch (e) {
      answers.push((e as { code?: string }).code ?? "?");
    }
  }
  ok(
    "the walker refuses every dead-zone clause L2004 and answers every native one",
    JSON.stringify(answers) ===
      JSON.stringify([...DEAD_ZONE.map(() => "L2004"), ...HOISTED_ONLY.map(() => "ok"), ...NATIVE_CAPTURE.map(() => "ok")]),
    answers,
  );
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

// ---- 10) an update's operand: a native counter, a refused record --------------------------------

{
  // THE DECLARED DIVERGENCE OF RULING 1c, held by its oracle rather than by a sentence. The walker
  // reads `x++`'s old value through a bare `Number(...)` with no refusal, so a record answers NaN
  // there; the engine refuses it L4018 through `unary("update")`. That is a deliberate departure
  // (issue 646 — silent coercion is the class the language refuses everywhere else), and this cell
  // measures the walker's side of it. When 646 lands, the walker starts refusing, this cell reds,
  // and the divergence is retired in the same change instead of being remembered.
  const logs: unknown[] = [];
  const r = await walk("const o = { c: {} }; o.c++; log(o.c);", {
    runId: "u",
    handler: new SimHandler({}),
    onLog: (l) => logs.push([...l.values]),
  });
  ok("declared divergence 646: the walker coerces an update's operand instead of refusing", JSON.stringify(logs) === "[[null]]", {
    logs,
    value: r.value,
  });

  // A NUMBER NEVER REACHES THE HOST. Counters are the hot path of every loop in the language, and
  // one seam call per increment is what the fast path exists to avoid; it is also why the numeric
  // corpus is identical on both arms while 646 stands.
  const update = transform("let n = 0; n++; const o = { c: 0 }; o.c++; log(n, o.c);");
  ok("an update's fast path keeps a numeric counter native", update.module.includes('typeof __t2 === "number" ? __t2 :'), update.module.slice(0, 400));

  // AND THE MIRROR: the slow leg is charged, so a non-number operand reaches the refusal. Without
  // this cell, emitting the fast path alone would pass the one above and drop L4018 entirely.
  ok("an update's operand charges the coercion law when it is not a number", (update.meta.sites.unary ?? 0) === 2, update.meta.sites);

  const negate = transform("const o = {}; log(-o);").meta.sites;
  ok("a unary operator that can refuse still charges it", (negate.unary ?? 0) === 1, negate);
}

// ---- 11) a race's static payload, checked against the walker's own value ------------------------

{
  // The engine has NO AST at run time, and a settled `race` journals a `branchDigest` over the arms
  // it never walked. So the branch bodies travel in the call site's payload — and the property that
  // matters is not that they travel but that they SURVIVE the trip: the walker hashes the value it
  // holds in memory, the engine hashes what arrived as JSON, and a journal entry that differs by a
  // byte is a divergence. This cell hashes both and requires the same string.
  const source = 'const r = await race({ a: async () => "a", b: async () => "b" }, { name: "r" });\nlog(r.index);';
  const { module } = transform(source);

  const wrapped = `(${module})`;
  const shipped = (() => {
    const found: unknown[] = [];
    const walkNode = (n: unknown): void => {
      if (Array.isArray(n)) return void n.forEach(walkNode);
      if (n === null || typeof n !== "object") return;
      const node = n as Node & { key?: Node & { name?: string }; value?: Node & { start: number; end: number } };
      if (node.type === "Property" && node.key?.name === "branchDigests" && node.value !== undefined) {
        found.push(JSON.parse(wrapped.slice(node.value.start, node.value.end)));
      }
      for (const [k, v] of Object.entries(node)) if (k !== "type") walkNode(v);
    };
    walkNode(parse(wrapped, { ecmaVersion: 2023, sourceType: "module" }) as unknown as Node);
    return found;
  })();
  ok("a race call site ships exactly one branch payload", shipped.length === 1, shipped.length);

  const bodies = shipped[0] as Record<string, unknown>;
  const program = parse(source, { ecmaVersion: 2023, sourceType: "module", allowAwaitOutsideFunction: true }) as unknown as Node;
  const literal = ((((program.body as Node[])[0] as Node).declarations as Node[])[0] as Node).init as Node;
  const branches = ((literal.argument as Node).arguments as Node[])[0] as Node;
  const walkerBodies = new Map<string, unknown>();
  for (const prop of branches.properties as (Node & { key: Node & { name?: string; value?: string }; value: Node })[]) {
    walkerBodies.set(prop.key.name ?? (prop.key.value as string), stripPositions(prop.value));
  }
  ok("every branch travels, because which one loses is the run's answer", Object.keys(bodies).sort().join() === [...walkerBodies.keys()].sort().join(), {
    shipped: Object.keys(bodies).sort(),
    walker: [...walkerBodies.keys()].sort(),
  });

  // Over every loser set a run of this race could produce, not just one of them.
  const names = [...walkerBodies.keys()].sort();
  const subsets = [[], ...names.map((n) => [n]), names];
  let matched = 0;
  const mismatched: string[] = [];
  for (const losers of subsets) {
    const mine = digest(losers.map((n) => [n, bodies[n] ?? null]));
    const theirs = digest(losers.map((n) => [n, walkerBodies.get(n) ?? null]));
    if (mine === theirs) matched += 1;
    else mismatched.push(`[${losers.join()}] mine ${mine.slice(0, 20)} theirs ${theirs.slice(0, 20)}`);
  }
  ok("the shipped payload digests as the walker's value over every loser set", matched === subsets.length, { matched, of: subsets.length, mismatched });
  console.log(`  (${subsets.length} loser sets digested on both sides)`);
}

// ---- 11b) the scope body that must not be evaluated at the call --------------------------------

{
  // `fanOut` and `conclave` take their body at index 1, and the walker evaluates it INSIDE the
  // scope, after the entry has begun: measured on both engines, `fanOut(xs, await choose(), {...})`
  // journals `fanOut:f` BEFORE the `sleep` inside `choose`, while the same effect in the options bag
  // journals before the scope. An eager body has journalled in the wrong place, and the host refuses
  // one that is not a thunk (L1000).
  const fan = transform('const a = await spawn("one"); await fanOut([a], (m) => turn(m, { name: "t" }), { name: "f", key: (m) => m.agent });').module;
  ok('a fan-out\'s body travels unevaluated', /effect\("fanOut", \[.*, async \(\) => \(async \(\.\.\./.test(fan), fan.slice(-320));
  const con = transform('const a = await spawn("one"); await conclave([a], async (c) => c, { name: "k" });').module;
  ok("a conclave's body travels unevaluated", /effect\("conclave", \[.*, async \(\) => \(async \(\.\.\./.test(con), con.slice(-320));

  // AND THE COMBINATORS THAT HAVE NO DEFERRED ARGUMENT KEEP THEIR BAG. `parallel` and `race` take
  // branches, not a body; wrapping that bag would hand the host a thunk it refuses as an engine
  // fault. Which primitives defer comes from the table, so this is the other half of that read.
  const par = transform('await parallel({ one: () => sleep("1m", { name: "one" }) }, { name: "both" });').module;
  // NOT ONLY POSITION 0: the mutant that wraps by "is a scope-opener" rather than by the table wraps
  // `parallel`'s OPTIONS BAG, which a check on the branches alone walks straight past (it did -
  // that mutant SURVIVED until this cell read the whole emission). `async () => (` is the deferred
  // wrapper's own spelling: a branch body is `async (...__ta) =>` and a continuation `async (__tc0) =>`.
  ok(
    "a combinator with no deferred argument wraps nothing at all",
    /effect\("parallel", \[__ctx\.born\(\{/.test(par) && !par.includes("async () => ("),
    par.slice(-320),
  );
}

// ---- 12) the chain the host has to finish, and what the walker answers there --------------------

{
  // THE ARGUMENTS FIRST, then the chain: each rule below is one position of the same call, and they
  // are ordered so a mistake in one is named by its own cell rather than by the next one along.
  //
  // Ruling 1d's fourth argument is the optional flag. The seam resolves a method name and calls it
  // in one step, the one place a method name may be resolved at all, so the short-circuit decision
  // is the host's and the flag is what asks for it.
  const closed = transform("const o = { m: () => 1 }; log(await o.m?.());");
  ok("a tail optional call is emitted through the ruled flag", /\.call\(o, "m", .*, true[,)]/.test(closed.module), closed.module.slice(-260));
  ok("a tail optional call carries no continuation: there is nothing written after it", !closed.module.includes("true, async ("), closed.module.slice(-260));

  // AND ITS ARGUMENTS ARE HANDED OVER UNEVALUATED. The walker checks the member before it evaluates
  // the argument list, so a short-circuited optional call runs NO argument; an emitted array has
  // already run them, and a resume would replay a step the run never recorded.
  const withArgs = transform('const o = { m: (x) => x }; log(await o.m?.(await sleep("1s", { name: "s" })));').module;
  ok("an optional call hands its arguments over as a thunk", /\.call\(o, "m", async \(\) => \[.*sleep/.test(withArgs), withArgs.slice(-320));
  const plain = transform("const xs = [1]; log(xs.map((x) => x));").module;
  ok("an ordinary method call carries no flag", plain.includes('.call(xs, "map", [') && !plain.includes(", true)"), plain.slice(-200));

  // AND THE FIFTH ARGUMENT IS THE REST OF THE CHAIN, because only the host knows it short-circuited:
  // a guard on the value it returns cannot tell a short-circuit from a call that returned undefined,
  // measured below as undefined for `o.z?.().x` on an absent member and L4010 for `o.m?.().x` on a
  // member that returns undefined. So everything written after the call is emitted as a closure the
  // host applies or skips, rather than written after the call where it would always run.
  const after = transform("const o = { m: () => ({ x: 1 }) }; log(o.m?.().x);").module;
  ok(
    "an optional call hands the rest of its chain to the host, as the ruled fifth argument",
    /\.call\(o, "m", async \(\) => \[\], true, async \((\S+)\) => __ctx\.get\(\1, "x"\)\)/.test(after),
    after.slice(-280),
  );

  // AND ALL OF IT TRAVELS, not just the first link: a deep chain and a trailing call are swallowed
  // by the same short-circuit (measured), so both compile into the one closure.
  const deep = transform("const o = { m: () => ({ x: { y: 1 } }) }; log(o.m?.().x.y);").module;
  ok(
    "a deep chain after the optional call travels as one continuation",
    /, true, async \((\S+)\) => __ctx\.get\(__ctx\.get\(\1, "x"\), "y"\)\)/.test(deep),
    deep.slice(-280),
  );
  const trailing = transform('const o = { m: () => " a " }; log(o.m?.().trim());').module;
  ok(
    "a call after the optional call travels in the same continuation",
    /, true, async \((\S+)\) => \(await __ctx\.call\(\1, "trim", \[\]\)\)\)/.test(trailing),
    trailing.slice(-280),
  );

  // AND A `?.` WRITTEN AFTER IT IS GUARDED INSIDE the closure. Its guard must not run when the call
  // short-circuited — there is nothing to test then — so the continuation carries its own guards
  // rather than adding them to the chain's.
  const nested = transform("const o = { m: () => ({ x: 1 }) }; log(o.m?.()?.x);").module;
  const at = nested.indexOf('.call(o, "m"');
  ok(
    "a `?.` after the optional call is guarded inside the continuation, where the call answered",
    at !== -1 && nested.indexOf("=== null") > at && /async \(\S+\) => \(\(\(\S+ = \S+\) === null/.test(nested),
    nested.slice(-320),
  );

  // AND THE WALKER'S ANSWERS ARE RECORDED, because they are what the emission has to reproduce:
  // present function calls, absent short-circuits, a present non-function is L4011, a short-circuit
  // swallows a deep chain and a trailing call alike, and the pair a guard on the returned value
  // could not have told apart (`[[null]]` for the absent member, L4010 for the member that returned
  // undefined) is why the continuation is handed over at all. Measured, not quoted.
  const answers: string[] = [];
  for (const source of [
    "const o = { m: () => 1 }; log(await o.m?.());",
    "const o = {}; log(await o.m?.());",
    "const o = { m: 5 }; log(await o.m?.());",
    "const o = {}; log(o.z?.().x);",
    "const o = { m: () => undefined }; log(o.m?.().x);",
    "const o = {}; log(o.z?.().x.y);",
    "const o = {}; log(o.z?.().trim());",
    "const o = { m: () => ({ x: { y: 2 } }) }; log(o.m?.().x.y);",
    'const o = { m: () => " a " }; log(o.m?.().trim());',
    "const o = { m: () => undefined }; log(o.m?.()?.x);",
  ]) {
    const logs: unknown[] = [];
    try {
      await walk(source, { runId: "p", handler: new SimHandler({}), onLog: (l) => logs.push([...l.values]) });
      answers.push(JSON.stringify(logs));
    } catch (e) {
      answers.push((e as { code?: string }).code ?? "?");
    }
  }
  ok(
    "the walker's answers for an optional call are recorded with the rule and with the hole",
    JSON.stringify(answers) ===
      JSON.stringify(["[[1]]", "[[null]]", "L4011", "[[null]]", "L4010", "[[null]]", "[[null]]", "[[2]]", '[["a"]]', "[[null]]"]),
    answers,
  );
}

// ---- last) every seam call site passes an argument count the contract declares --------------------

{
  // LAST ON PURPOSE. Every mutant that changes the SHAPE of a seam call also changes an arity, so
  // this cell would red first for five rules that each have a cell of their own and name themselves
  // better than "an argument count changed". Sitting here it catches only what nothing else did.
  //
  // ARITY, NOT ONLY NAMES. The cell above compares the member NAMES the module reaches; that is what
  // let `call` grow a fourth and then a fifth argument for F6 against a host member declared with
  // three, and the divergence that came out of it was found by the differential rather than here.
  // The declared range now lives beside the member in `seam.ts`, this checks every emitted site
  // against it, and `engine.smoke` checks the host's `ctx` against the same table.
  const WIDE: readonly (readonly [string, string])[] = [
    ["an optional call whose chain continues", "const o = { m: () => ({ x: { y: 1 } }) }; log(o.m?.().x.y);"],
    ["an optional call at the tail of its chain", "const o = { m: () => 1 }; log(o.m?.());"],
    ["a dead-zone read, which carries its binding name", "const f = () => x; const r = f(); const x = 1; log(r);"],
    ["a dead-zone write, which carries its binding name too", "function f() { n = 2; } f(); let n = 1; log(n);"],
    ["a non-function callee", "const f = 1; f();"],
    ["a catch clause", 'try { log(1); } catch (e) { log(e.code); }'],
    ["a template and an iteration", "const xs = [1, 2]; for (const x of xs) { log(`v${x}`); }"],
  ];
  const observed = new Map<string, { min: number; max: number }>();
  const outside: string[] = [];
  let sites = 0;
  for (const [name, source] of [...CORPUS, ...WIDE]) {
    const { module, meta } = transform(source);
    for (const { member, arity } of seamSites(parseModule(module), meta.ctx)) {
      sites += 1;
      const range = SEAM_MEMBERS[member];
      if (range === undefined || arity < range[0] || arity > range[1]) outside.push(`${name}: ${member}/${arity}`);
      const seen = observed.get(member);
      observed.set(member, seen === undefined ? { min: arity, max: arity } : { min: Math.min(seen.min, arity), max: Math.max(seen.max, arity) });
    }
  }
  // THE SENTENCE NAMES THE SET THE LOOP WALKS, and here that matters more than usual because the
  // set cannot be everything: the property is about the EMITTER, and no loop enumerates every
  // program the language admits. So this is a SAMPLE — this suite's corpus, written to reach every
  // node type, plus the seven programs above that reach the arities the corpus does not. Named as
  // if it were universal it would read as a guarantee about the emitter, which nothing here can
  // give. The cell below is what keeps the sample honest in the other direction.
  // The COUNT stays out of the name and goes to the line below it: `sites` is measured from the
  // emission, so a mutant that changes what is emitted would change the cell's own name, and a
  // mutation config cannot name a cell that renames itself the moment it fails.
  ok("every seam call site the corpus and the wide list emit passes an argument count the contract declares", outside.length === 0, outside);
  // AND THE RANGE IS NOT WIDER THAN THE EMITTER USES, which is the half that keeps the table honest:
  // a range nobody reaches is a permission granted to a future emission with no ruling behind it,
  // and it would pass the cell above forever. Every declared bound has to be a site somewhere here.
  const slack = Object.entries(SEAM_MEMBERS)
    .map(([member, [lo, hi]]) => {
      const seen = observed.get(member);
      if (seen === undefined) return `${member}: declared ${lo}..${hi}, never reached`;
      return seen.min === lo && seen.max === hi ? "" : `${member}: declared ${lo}..${hi}, reached ${seen.min}..${seen.max}`;
    })
    .filter((x) => x !== "");
  ok("and no declared range is wider than the emission that justifies it", slack.length === 0, slack);
  console.log(`  (${sites} seam call sites checked against ${Object.keys(SEAM_MEMBERS).length} declared arity ranges)`);
}

// ---- 23) the mutation config, audited against the cells this suite prints ----------------------

/**
 * An instrument for the instrument, and it exists because all three faults it checks were real.
 *
 * A mutation config's `expectRed` is matched as a SUBSTRING of the run's output, which fails toward
 * confidence in three different ways and did: a sentence that no longer exists after a cell is
 * renamed grades WRONG-RED at fold time rather than at authoring time (one of mine did, in the very
 * commit that argued anchors must identify one thing); a sentence that is a PREFIX of a sibling
 * cell can report a kill off the wrong one (one of mine matched three); and a sentence that is not
 * a cell at all but a THROW MESSAGE grades a crash as a kill (one of mine did, for as long as it
 * had existed). Exactly one printed cell, per aim, catches all three — zero is a stale sentence or
 * a throw, more than one is the prefix trap.
 *
 * It also asserts the section-0 guard is still the file's first transform, BY OFFSET in this file's
 * own source. That is beyond what the fault required and it is here for the reason the guard itself
 * is: an insertion above it silently re-opens the hole, and a rule the author has to remember is
 * not an invariant. This is the half that the engine suite's equivalent had and mine did not.
 */
{
  const here = new URL(import.meta.url).pathname;
  const src = readFileSync(here, "utf8");
  const guardAt = src.indexOf("// ---- 0) the FIRST transform in this file");
  const guardCell = src.indexOf("the transform emits, and a fault in the emitter has a cell to land on", guardAt + 1);
  const firstTransform = src.indexOf("transform(", guardAt);
  ok("the guarded transform is still the first one this file runs", guardAt > 0 && firstTransform > guardAt && firstTransform < guardCell && src.indexOf("transform(") === firstTransform, {
    guardAt,
    firstTransform,
    guardCell,
  });

  const cfg = JSON.parse(readFileSync(new URL("./mutations/transform-surface.json", import.meta.url), "utf8")) as {
    suite: string;
    mutations: { name: string; expectRed: string; completionMarker?: string; note?: string }[];
  };
  ok("the config audited here is the one that names this suite", cfg.suite.endsWith("transform.smoke.ts"), cfg.suite);
  // THIS BLOCK'S OWN CELLS COUNT THEMSELVES, and they have to: a config aims mutants at both of
  // them, and neither name is in `CELLS` yet when the audit runs — `ok` records after it decides.
  // Left out, an aim at either reads as a stale sentence and the audit reds over its own existence.
  // Both are named here rather than at their `ok`, so the list and the cells cannot drift.
  const AUDIT = "every mutation's expectRed names exactly one cell this suite printed";
  const EXCEPTION = "exactly one mutation names no upstream marker, it is the one aimed at this file's first cell, and it says why";
  const MARKERS = "every marker a mutation declares matches exactly one printed cell, and that cell prints before the aim it guards";
  const known = [...CELLS, AUDIT, EXCEPTION, MARKERS];
  const wrong = cfg.mutations
    .map((m) => ({ m, hits: known.filter((c) => c.includes(m.expectRed)).length }))
    .filter(({ hits }) => hits !== 1)
    .map(({ m, hits }) => `${m.name}: ${hits} printed cell(s) match ${JSON.stringify(m.expectRed)}`);
  ok(AUDIT, wrong.length === 0, wrong);
  console.log(`  (${cfg.mutations.length} expectRed strings audited against ${CELLS.length} printed cells)`);

  // AND THE ONE MUTANT WITHOUT AN UPSTREAM MARKER IS A NAMED EXCEPTION, NOT A PRECEDENT.
  //
  // Every mutation here declares a `completionMarker` naming a cell UPSTREAM of its aim, so a run
  // that died early cannot be counted as its kill. Exactly one cannot: the cell that aim moved onto
  // is the file's FIRST cell, and nothing prints before it — left in place, the marker turned a
  // textbook kill into INCONCLUSIVE, because by that rule the run had not finished. The exception is
  // right and it is also the kind of thing that becomes a habit if it is only a comment, so it is
  // three assertions rather than a note: there is exactly ONE bare mutant, its aim IS the first cell
  // this file prints, and its own note says the word, where the next reader looks.
  const bare = cfg.mutations.filter((m) => m.completionMarker === undefined);
  const firstCell = CELLS[0] ?? "";
  ok(EXCEPTION, bare.length === 1 && firstCell.includes(bare[0].expectRed) && (bare[0].note ?? "").includes("completionMarker"), {
    bare: bare.map((m) => m.name),
    firstCell,
  });
  console.log(`  (${cfg.mutations.length - bare.length} of ${cfg.mutations.length} mutations name an upstream marker, and the one that cannot is the first-cell guard)`);

  // AND EVERY MARKER IT DOES DECLARE POINTS AT ONE CELL, UPSTREAM OF THE AIM IT GUARDS.
  //
  // The harness tests a marker as a SUBSTRING of the whole run, so a marker that also occurs inside
  // an EARLIER cell's name is satisfied by a run that stopped at that earlier one: the guard weakens
  // from "reached the cell I named" to "reached whichever cell shares its wording", and a death in
  // between is graded rather than reported. That is not hypothetical — it was live in the sibling
  // seam config this week, with every verdict it produced still correct, which is how an ambiguous
  // instrument survives being read. The other half fails the opposite way: a marker AT or AFTER its
  // own aim cannot print on a kill at all, so a textbook kill grades INCONCLUSIVE (measured here at
  // 0b7db8b0). Cells are checked in the order they printed, which is the only order that answers
  // "did the run get this far".
  const printed = known.map((c) => `ok ${c}`);
  const where = (needle: string) => printed.flatMap((line, i) => (line.includes(needle) ? [i] : []));
  const markerFaults = cfg.mutations.flatMap((m) => {
    if (m.completionMarker === undefined) return [];
    const at = where(m.completionMarker);
    if (at.length !== 1) return [`${m.name}: ${at.length} printed cell(s) match its marker ${JSON.stringify(m.completionMarker)}`];
    const aim = where(m.expectRed);
    if (aim.length === 1 && at[0] < aim[0]) return [];
    return [`${m.name}: its marker prints at cell ${at[0] + 1}, its aim at ${aim.map((i) => i + 1).join(",") || "no cell"}`];
  });
  ok(MARKERS, markerFaults.length === 0, markerFaults);
  console.log(`  (${cfg.mutations.length - bare.length} markers resolved to a single cell each, every one upstream of its aim, across ${printed.length} printed cells)`);
}

console.log(`\ntransform.smoke: ${pass} cells passed`);
