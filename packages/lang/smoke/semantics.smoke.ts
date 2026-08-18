/**
 * The pure fragment is JavaScript: the same program, run here and on node, logs the same values.
 *
 * Every other suite in this package tests what the language ADDS (effects, the journal, the scopes).
 * This one tests what it must not change: for a program that performs no effect, the interpreter is
 * an implementation of JavaScript's meaning, and node is the reference. Each program below is run
 * twice, on the interpreter with the simulation handler and on node as the body of an async function
 * with the same free builtins injected, and the two log transcripts must be identical, snapshot at
 * the moment of each `log` so a later mutation cannot blur what was logged.
 *
 * The free builtins the programs use are given trivial reference implementations on the node side
 * (`len`, `keys`, `range`, ...). `sort` is deliberately absent: its total order is this language's,
 * not JavaScript's, and `surface.smoke` pins it on its own. What is under test here is syntax,
 * operators, control flow, closures, destructuring, and the curated methods, which on node are the
 * host's own.
 *
 * A third column asserts that programs which THROW on node also throw here, without comparing the
 * error (node raises a TypeError, this language a fault with an L-code and a fix).
 */
import { run } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

// ---- the two runners ----------------------------------------------------------------------------

/** Reference implementations of the free builtins a pure program may lean on. Plain JavaScript. */
const REFERENCE_BUILTINS: Record<string, unknown> = {
  len: (x: { length: number }) => x.length,
  keys: (o: object) => Object.keys(o),
  values: (o: object) => Object.values(o),
  entries: (o: object) => Object.entries(o),
  has: (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k),
  merge: (a: object, b: object) => ({ ...a, ...b }),
  range: (n: number) => Array.from({ length: n }, (_, i) => i),
  sum: (xs: number[]) => xs.reduce((a, b) => a + b, 0),
  min: Math.min,
  max: Math.max,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  parseNumber: Number,
  join: (xs: unknown[], sep: string) => xs.join(sep),
  split: (s: string, sep: string) => s.split(sep),
  trim: (s: string) => s.trim(),
  lower: (s: string) => s.toLowerCase(),
  upper: (s: string) => s.toUpperCase(),
  contains: (s: string, t: string) => s.includes(t),
  unique: (xs: unknown[]) => [...new Set(xs)],
  reverse: (xs: unknown[]) => [...xs].reverse(),
  json: { parse: JSON.parse, stringify: JSON.stringify },
};

async function onInterpreter(source: string): Promise<{ logs: string[]; threw: string | null }> {
  const logs: string[] = [];
  try {
    await run(source, {
      runId: "sem",
      handler: new SimHandler({}),
      onLog: (l) => logs.push(JSON.stringify(l.values)),
    });
    return { logs, threw: null };
  } catch (e) {
    return { logs, threw: (e as Error).message };
  }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

async function onNode(source: string): Promise<{ logs: string[]; threw: string | null }> {
  const logs: string[] = [];
  const names = ["log", ...Object.keys(REFERENCE_BUILTINS)];
  const values = [(...vs: unknown[]) => logs.push(JSON.stringify(vs)), ...Object.values(REFERENCE_BUILTINS)];
  try {
    const fn = new AsyncFunction(...names, `"use strict";\n${source}`);
    await fn(...values);
    return { logs, threw: null };
  } catch (e) {
    return { logs, threw: (e as Error).message };
  }
}

async function same(name: string, source: string): Promise<void> {
  const a = await onInterpreter(source);
  const b = await onNode(source);
  if (a.threw !== null || b.threw !== null) {
    throw new Error(`FAIL: ${name} - a side threw\n  interpreter: ${a.threw}\n  node: ${b.threw}`);
  }
  ok(name, a.logs.join("\n") === b.logs.join("\n"), { interpreter: a.logs, node: b.logs });
}

async function bothThrow(name: string, source: string): Promise<void> {
  const a = await onInterpreter(source);
  const b = await onNode(source);
  ok(name, a.threw !== null && b.threw !== null && a.logs.join("\n") === b.logs.join("\n"), {
    interpreter: a.threw,
    node: b.threw,
  });
}

// ---- 0) the instrument ------------------------------------------------------------------------------

// The control, and the upstream marker every mutation config on this suite names: a program that
// logs a literal agrees on both runners before anything interesting is compared.
await same("a program that logs a literal", "log(1, \"a\", null, [2], { b: 3 });");

// ---- 1) operators ---------------------------------------------------------------------------------

await same("compound assignment, every operator", `
let n = 10; n += 5; n -= 3; n *= 2; n /= 4; n %= 4; n **= 3;
let b = 12; b &= 10; b |= 5; b ^= 3; b <<= 2; b >>= 1; b >>>= 1;
let s = "a"; s += "b"; s += 1;
log(n, b, s);
`);

await same("update expressions, prefix and postfix, on bindings and members", `
let i = 0; const o = { c: 1 }; const xs = [5];
const a = i++; const b = ++i; const c = o.c--; const d = --o.c; xs[0]++; ++xs[0];
log(i, a, b, c, d, o.c, xs);
`);

await same("arithmetic, exponent, bitwise, comparison, coercion", `
log(2 ** 3 ** 2, 7 % 3, -7 % 3, 5 & 3, 5 | 2, 5 ^ 1, 1 << 3, -8 >> 1, -8 >>> 28, ~5);
log("a" + 1, 1 + "a", true + 1, null + 1, "3" * "4", "10" / 2, [1] + 1, "b" > "a", "10" < "9", 10 < 9);
log(0 / 0 === 0 / 0, 1 / 0 > 1e308, -0 === 0, typeof (0 / 0), 0.1 + 0.2 === 0.3, (0.1 + 0.2).toFixed(2));
`);

await same("strict equality, logical operators, nullish", `
const z = null; const u = undefined; const e = "";
log(z === u, z === null, u === undefined, e === "", 0 === "0", 0 / 0 === 0 / 0);
log(z ?? "d", e ?? "d", 0 || "d", 0 && "d", "" || null, 1 && 2, z?.x ?? "n");
`);

await same("logical assignment", `
let a = null; a ??= 5; a ??= 6;
let b = 1; b &&= 7; let c = 0; c &&= 8;
let d = 0; d ||= 9; let e = 3; e ||= 10;
const o = { x: null, y: 2 }; o.x ??= 3; o.y ||= 4; o.y &&= 5;
log(a, b, c, d, e, o);
`);

await same("ternary, typeof, unary", `
const v = 3;
log(v > 2 ? "big" : "small", typeof v, typeof "s", typeof null, typeof undefined, typeof [], typeof {}, typeof (() => 1), !v, -v, +"4", !!"", -"x" !== -"x");
`);

// ---- 2) control flow ------------------------------------------------------------------------------

await same("if / else if / else, while, for, for-of, break, continue", `
let out = [];
for (let i = 0; i < 10; i += 1) {
  if (i % 2 === 0) { continue; }
  if (i > 7) { break; }
  out.push(i);
}
let j = 0;
while (true) { j += 1; if (j === 3) { break; } }
for (const [k, v] of [["a", 1], ["b", 2]]) { out.push(k + v); }
for (const ch of "xy") { out.push(ch); }
if (j === 1) { out.push("one"); } else if (j === 3) { out.push("three"); } else { out.push("other"); }
log(out);
`);

await same("for loop per-iteration bindings", `
const fs = [];
for (let i = 0; i < 3; i += 1) { fs.push(() => i); }
let k = 0; const gs = [];
for (k = 0; k < 2; k += 1) { gs.push(() => k); }
log(fs.map((f) => f()), gs.map((g) => g()));
`);

await same("switch with braced and unbraced cases, default, fallthrough-free", `
function kind(x) {
  switch (x) {
    case 1: return "one";
    case "1": { return "string one"; }
    case 2:
    case 3: { const t = "two or three"; return t; }
    default: return "other";
  }
}
let n = 0;
switch (2) { case 2: { n += 2; break; } default: { n += 100; break; } }
log(kind(1), kind("1"), kind(3), kind(4), n);
`);

await same("try / catch / finally with thrown records and rethrow", `
const trail = [];
function risky(x) {
  if (x > 1) { throw { code: "too-big", x }; }
  return x;
}
try { trail.push(risky(1)); trail.push(risky(2)); trail.push("unreached"); }
catch (e) { trail.push(e.code, e.x); }
finally { trail.push("finally"); }
try {
  try { throw "inner"; } finally { trail.push("inner-finally"); }
} catch (e) { trail.push(e); }
const f = () => { try { return "try"; } finally { trail.push("f-finally"); } };
trail.push(f());
log(trail);
`);

// ---- 3) functions and closures ---------------------------------------------------------------

await same("closures, recursion, hoisted declarations, default and rest parameters, spread calls", `
function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }
const counter = () => { let c = 0; return () => { c += 1; return c; }; };
const next = counter(); next(); next();
const f = (a, b = a * 2, ...rest) => [a, b, rest];
const g = function (x) { return x + later(); };
function later() { return 1; }
const args = [1, 2, 3, 4];
log(fact(5), next(), f(1), f(1, 5, 6, 7), f(...args), g(1), Math_free(2));
function Math_free(x) { return x * x; }
`);

await same("async functions and await on plain values", `
async function twice(x) { return x * 2; }
const y = await twice(4);
const z = await 5;
const inner = async () => (await twice(1)) + (await twice(2));
log(y, z, await inner());
`);

// ---- 4) data: records, arrays, destructuring, spread, templates ----------------------------------

await same("record literals, shorthand, member reads and writes, computed member access", `
const x = 1; const key = "dyn";
const o = { x, y: 2, "z w": 3, nested: { a: [1, 2] } };
o.y = 20; o[key] = 4; o["z w"] += 1; o.nested.a[1] = 9;
log(o, o.missing, o.nested.a.length, o[key], keys(o));
`);

await same("array literals, holes-free, spread, length, index reads and writes, nested", `
const a = [1, 2, 3]; const b = [0, ...a, 4, ...[5]];
b[1] = "one"; b[b.length] = "end";
const m = [[1, 2], [3, 4]];
log(a, b, b.length, b[0], b[99], m[1][0], [..."ab"], [1, 2].concat([3], 4));
`);

await same("`xs.length = n` truncates, to a shorter length and to zero, as JavaScript does", `
const xs = [1, 2, 3, 4]; xs.length = 2; const ys = [9]; ys.length = 0;
log(xs, xs.length, ys, ys.length, xs.map((x) => x * 2));
`);

// The names the design once reserved for sugar it never built (\`any\`, \`all\`) are ordinary names.
await same("`any` and `all` are ordinary names", `
const any = 1; let all = [any, 2]; all = all.map((x) => x + any);
log(any, all);
`);

await same("destructuring: objects, arrays, defaults, rest, nested, in parameters, swap", `
const { a, b: renamed, c = 3, ...restO } = { a: 1, b: 2, d: 4, e: 5 };
const [x, , y = 9, ...restA] = [1, 2, undefined, 4, 5];
const { p: { q } } = { p: { q: "deep" } };
const f = ({ k, l = "L" }, [m, n]) => [k, l, m, n];
let s1 = 1; let s2 = 2; [s1, s2] = [s2, s1];
log(a, renamed, c, restO, x, y, restA, q, f({ k: "K" }, [1, 2]), s1, s2);
`);

await same("template literals and string coercion", `
const o = { a: 1 }; const xs = [1, 2]; const n = null; const u = undefined;
log(\`v=\${o.a} \${xs} \${n} \${u} \${true} \${1 + 1} \${"s"}\`, \`\${o}\`, "" + xs);
`);

// ---- 5) the method tables against the host's own --------------------------------------------------

await same("array methods, pure", `
const xs = [3, 1, 4, 1, 5, 9, 2, 6];
log(
  xs.map((x, i) => x * i), xs.filter((x) => x % 2 === 0), xs.find((x) => x > 4), xs.findIndex((x) => x > 4),
  xs.findLast((x) => x < 3), xs.findLastIndex((x) => x < 3), xs.some((x) => x > 8), xs.every((x) => x > 0),
  xs.reduce((a, b) => a + b, 0), xs.reduce((a, b) => a * b), xs.includes(9), xs.indexOf(1), xs.lastIndexOf(1),
  xs.slice(2, 4), xs.slice(-2), xs.concat([7], 8), xs.join("-"), [[1, [2]], [3]].flat(), [[1, [2]], [3]].flat(2),
  xs.flatMap((x) => [x, x]), xs.at(-1), xs.toReversed(), xs.length, [].reduce((a, b) => a + b, "e"),
);
const seen = []; xs.forEach((x, i) => { seen.push(i + ":" + x); }); log(seen);
`);

await same("array methods, mutating, on fresh local arrays", `
const xs = [1, 2, 3];
const r1 = xs.push(4, 5); const r2 = xs.pop(); const r3 = xs.shift(); const r4 = xs.unshift(0);
const r5 = xs.splice(1, 2, "a", "b", "c"); const r6 = xs.splice(2);
log(xs, r1, r2, r3, r4, r5, r6);
`);

await same("string methods and indexing", `
const s = "  Hello, World  ";
log(
  s.trim(), s.trimStart(), s.trimEnd(), s.toLowerCase(), s.toUpperCase(), s.length, s[2], s.at(-3), s.charAt(2),
  s.trim().startsWith("Hell"), s.trim().endsWith("ld"), s.includes("World"), s.indexOf("o"), s.lastIndexOf("o"),
  s.slice(2, 7), s.slice(-7), s.substring(2, 7), s.trim().split(", "), "a-b-c".split("-", 2), "abc".split(""),
  "a.b.c".replace(".", "/"), "a.b.c".replaceAll(".", "/"), "ab".repeat(3), "7".padStart(3, "0"), "7".padEnd(3, "!"),
  "a".concat("b", 1), "abc"[5],
);
`);

await same("number methods", `
const n = 3.14159; const big = 1234.5678; const i = 255;
log(n.toFixed(2), n.toFixed(), big.toFixed(1), i.toString(16), i.toString(2), n.toString(), n.toPrecision(3), (0.5).toFixed(0), (1.5).toFixed(0), (2.5).toFixed(0));
`);

// ---- 6) programs that fail on both sides -------------------------------------------------------

await bothThrow("reading a field of null throws", `const o = null; log("before"); log(o.a);`);
await bothThrow("calling a non-function throws", `const o = { a: 1 }; log(o.a());`);
await bothThrow("destructuring null throws", `const { a } = null; log(a);`);
await bothThrow("a thrown record propagates out of the program", `log(1); throw { code: "x" };`);
await bothThrow("iterating a record throws", `for (const x of { a: 1 }) { log(x); }`);
await bothThrow("repeat with a negative count throws", `log("a".repeat(-1));`);
await bothThrow("reduce of an empty array with no seed throws", `log([].reduce((a, b) => a + b));`);
await bothThrow("json.parse of malformed text throws", `log(json.parse("{"));`);

console.log(`semantics.smoke: ${pass} checks passed`);
