/**
 * The validator's proof: every rule the design doc calls mechanical is actually mechanical.
 *
 * The point of this suite is negative. A program that could reach ambient IO, an ambient clock,
 * hidden concurrency, or a journal key that cannot survive an edit must FAIL TO PARSE, not merely
 * be discouraged. Each case below is written the way an LLM would naturally write it, because
 * those are the programs the rules have to catch.
 */
import { validate } from "../src/grammar.js";
import { CATALOG, LangErrors, type LangErrorCode } from "../src/errors.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

/** Assert the program is rejected, and that `code` is among the reasons. */
const rejects = (name: string, code: LangErrorCode, source: string) => {
  try {
    validate(source);
  } catch (e) {
    if (!(e instanceof LangErrors)) throw new Error(`FAIL: ${name} - wrong error type ${String(e)}`);
    const codes = e.errors.map((x) => x.code);
    ok(name, codes.includes(code), codes);
    return;
  }
  throw new Error(`FAIL: ${name} - expected rejection with ${code}, program was accepted`);
};

const accepts = (name: string, source: string) => {
  try {
    validate(source);
    ok(name, true);
  } catch (e) {
    const detail = e instanceof LangErrors ? e.render() : String(e);
    throw new Error(`FAIL: ${name} - expected acceptance\n${detail}`);
  }
};

// ---- 1) the shape of a real program parses ------------------------------------------------

// The module body IS the workflow, so this is written with top-level await exactly as the
// design doc's section 1 example writes it. If this shape ever stops parsing, the language has
// stopped being the thing the design describes.
accepts(
  "the worked example from the design doc, at the top level",
  `
const team = channel("feat-auth");
const planner = await spawn("planner", { worktree: "wt-1", join: [team] });
const builder = await spawn("builder", { worktree: "wt-1", join: [team], permits: { turns: 40 } });

await turn(planner, { name: "draft-plan" });

const approval = await checkpoint("approve-plan", "Approve the plan?", { timeout: "10m", onExpiry: "proceed" });
if (approval.status === "expired") {
  await notify([planner, builder], { decision: "approve-plan", outcome: "auto-proceeded" });
}

let r = await turn(builder, { name: "build" });
while (r.status === "blocked") {
  await notify([planner], { decision: "build", outcome: "blocked" });
  await turn(planner, { name: "unblock" });
  r = await turn(builder, { name: "build" });
}

const reviews = await fanOut(
  ["security", "perf"],
  async (lens) => turn(await spawn("reviewer", { worktree: "wt-1", join: [team], role: lens }), { name: "review" }),
  { name: "reviews", key: (lens) => lens },
);
log(reviews);
`,
);

// ---- 2) determinism holes are unwriteable, not discouraged --------------------------------

rejects("Date is not reachable", "L2012", "async function f() { const t = Date.now(); return t; }");
rejects("Math.random is not reachable", "L2012", "async function f() { return Math.random(); }");
rejects("fetch is not reachable", "L2012", 'async function f() { return fetch("https://x"); }');
rejects("setTimeout is not reachable", "L2012", "async function f() { setTimeout(f, 1); }");
rejects("process is not reachable", "L2012", "async function f() { return process.env.HOME; }");
rejects("globalThis is not reachable", "L2012", "async function f() { return globalThis; }");

// The tamed replacements ARE reachable, so the restriction costs nothing an author needs.
accepts(
  "now, random and log are the sanctioned replacements",
  'async function f() { log(now(), random()); await sleep("1m"); }',
);

// ---- 3) hidden concurrency is unwriteable -------------------------------------------------

rejects(
  "Promise.all cannot smuggle concurrency past the journal",
  "L2011",
  "async function f(a, b) { return Promise.all([turn(a, { name: \"x\" }), turn(b, { name: \"y\" })]); }",
);
accepts(
  "the sanctioned form is the record-shaped parallel",
  'async function f(a, b) { await parallel({ x: () => turn(a, { name: "x" }), y: () => turn(b, { name: "y" }) }, { name: "both" }); }',
);

// ---- 4) journal keys that cannot survive an edit are refused ------------------------------

rejects(
  "turn without a name has no durable key",
  "L3012",
  'async function f(a) { await turn(a, { deadline: "20m" }); }',
);
rejects(
  "a computed step name cannot be read statically",
  "L3013",
  "async function f(a, n) { await turn(a, { name: n }); }",
);
rejects(
  "a malformed step name is refused",
  "L3014",
  'async function f(a) { await turn(a, { name: "Build Step" }); }',
);
rejects(
  "ask without a name has no durable key",
  "L3012",
  'async function f(a) { await ask(a, { schema: { days: "number" } }); }',
);
rejects(
  "checkpoint needs a literal name",
  "L3013",
  'async function f(n) { await checkpoint(n, "ok?", { timeout: "10m" }); }',
);

// ---- 5) closed option bags answer with a signature ----------------------------------------

rejects(
  "an unknown option key is not silently ignored",
  "L3011",
  'async function f(a) { await turn(a, { name: "build", timeuot: "20m" }); }',
);

{
  // The whole point of closed bags: the error hands the author the accepted keys and an example.
  let rendered = "";
  try {
    validate('async function f(a) { await turn(a, { name: "build", timeuot: "20m" }); }');
  } catch (e) {
    rendered = (e as LangErrors).render();
  }
  // Pinned on the full fix line, not on "deadline" alone: that word also appears in the signature
  // below it, so the loose pin passed on the signature even if the accepted-key list broke. One
  // site is a pin; two is a coincidence waiting (counted, not assumed).
  ok(
    "the typo error names the accepted keys",
    rendered.includes("Accepted keys: name, deadline"),
    rendered.slice(0, 200),
  );
  ok("the typo error carries the callee signature", rendered.includes("turn(agent, { name, deadline? })"));
  ok("the typo error carries a working example", rendered.includes('await turn(builder, { name: "build" })'));
  ok("the blame frame is in user coordinates", rendered.includes("1 | async function f(a)"));
}

// ---- 5b) notify is a decision, not a message -----------------------------------------------

// `notify` is the only primitive that moves program-authored bytes toward an agent's context, so
// this is where the "conversation is the data plane" rule is easiest to break by accident. The
// bound is what makes it hard: eight short scalars in a labelled table cannot carry an
// instruction.
accepts(
  "a bounded decision record is fine",
  'const a = await spawn("x");\nawait notify([a], { decision: "build", outcome: "blocked", detail: { attempt: 3, sha: "abc123" } });',
);
rejects(
  "prose in a decision token is refused",
  "L3043",
  'const a = await spawn("x");\nawait notify([a], { decision: "the build step", outcome: "blocked" });',
);
rejects(
  "an extra top-level field is refused",
  "L3043",
  'const a = await spawn("x");\nawait notify([a], { decision: "build", outcome: "blocked", instructions: "now go fix it" });',
);
rejects(
  "a nested detail value is refused",
  "L3043",
  'const a = await spawn("x");\nawait notify([a], { decision: "build", outcome: "blocked", detail: { plan: { steps: 3 } } });',
);
rejects(
  "a long detail string is refused",
  "L3043",
  `const a = await spawn("x");\nawait notify([a], { decision: "build", outcome: "blocked", detail: { note: "${"x".repeat(200)}" } });`,
);
rejects(
  "more than eight detail keys is refused",
  "L3043",
  'const a = await spawn("x");\nawait notify([a], { decision: "build", outcome: "blocked", detail: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9 } });',
);
rejects(
  "a fact with no outcome is refused",
  "L3043",
  'const a = await spawn("x");\nawait notify([a], { decision: "build" });',
);

// The design's section 1 example, verbatim, semicolon-free and with an un-awaited spawn. Both
// reviewers made this the test of whether the document describes the language it ships.
accepts(
  "the design's section 1 example parses exactly as written",
  `const team    = channel("feat-auth")
const planner = await spawn("planner", { worktree: "wt-1", join: [team] })
const builder = await spawn("builder", { worktree: "wt-1", join: [team],
                                         permits: { turns: 40, spend: "5usd" } })

await turn(planner, { name: "draft-plan" })
await checkpoint("approve-plan", "approve the plan?", { timeout: "10m", onExpiry: "proceed" })

let r = await turn(builder, { name: "build" })
while (r.status === "blocked") {
  await turn(planner, { name: "unblock" })
  r = await turn(builder, { name: "build" })
}`,
);

// ---- 5c) width controls: the nearest legitimate input must still be admitted ------------------

// Every refusal above is compatible with a rule that refuses far too much, and "right in shape,
// wrong in width" is the failure a refusal-only suite cannot see. Each of these sits exactly at
// the boundary the rule draws and MUST pass.
{
  const eightKeys = "a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8";
  accepts(
    "exactly eight detail keys is at the cap, not over it",
    `const a = await spawn("x");\nawait notify([a], { decision: "build", outcome: "blocked", detail: { ${eightKeys} } });`,
  );
  accepts(
    "a detail string of exactly 128 characters is admitted",
    `const a = await spawn("x");\nawait notify([a], { decision: "build", outcome: "blocked", detail: { note: "${"x".repeat(128)}" } });`,
  );
  accepts(
    "detail values may be strings, numbers and booleans",
    'const a = await spawn("x");\nawait notify([a], { decision: "build", outcome: "ok", detail: { sha: "abc", n: 3, clean: true } });',
  );
  accepts("a fact with no detail at all is admitted", 'const a = await spawn("x");\nawait notify([a], { decision: "build", outcome: "ok" });');
}
{
  const name64 = "a".repeat(64);
  accepts("a step name of exactly 64 characters is admitted", `const a = await spawn("x");\nawait turn(a, { name: "${name64}" });`);
  rejects("65 characters is over the cap", "L3014", `const a = await spawn("x");\nawait turn(a, { name: "${"a".repeat(65)}" });`);
  accepts("a single-character step name is admitted", 'const a = await spawn("x");\nawait turn(a, { name: "b" });');
  accepts("digits and inner hyphens are admitted", 'const a = await spawn("x");\nawait turn(a, { name: "build-2-final" });');
}
{
  // The fanOut lint must not fire on the documented default, which is items carrying a string id.
  const withIds = 'await fanOut([{ id: "a" }, { id: "b" }], async (i) => turn(await spawn("r", { role: i.id }), { name: "review" }), { name: "reviews" });';
  const r = validate(withIds);
  ok("items carrying a string id are not linted: that is the documented default", r.warnings.length === 0, r.warnings.map((w) => w.code));

  const noIds = 'await fanOut(["security", "perf"], async (i) => turn(await spawn("r"), { name: "review" }), { name: "reviews" });';
  ok(
    "items that visibly carry no id still are",
    validate(noIds).warnings.some((w) => w.code === "L3021"),
  );

  const computed = 'const items = range(3);\nawait fanOut(items, async (i) => turn(await spawn("r"), { name: "review" }), { name: "reviews" });';
  ok(
    "a computed list is not judged statically: the runtime decides it",
    validate(computed).warnings.length === 0,
    validate(computed).warnings.map((w) => w.code),
  );
}

// ---- 5d) concurrency must be explicit, not implied by the text -------------------------------

// Banning Promise is not enough: calling an async function is itself a way to start work, and
// the program text then reads as concurrency the runtime does not provide.
rejects(
  "a primitive call held in a variable is refused",
  "L2013",
  'const a = await spawn("x");\nconst p = turn(a, { name: "build" });\nawait p;',
);
rejects(
  "a bare un-awaited primitive statement is refused",
  "L2013",
  'const a = await spawn("x");\nmonitor(a);',
);
accepts(
  "awaited is fine, and so is a combinator thunk",
  'const a = await spawn("x");\nawait monitor(a);\nawait parallel({ one: () => turn(a, { name: "b" }) }, { name: "p" });',
);

// ---- 6) the Jessie diff --------------------------------------------------------------------

rejects("no classes", "L1001", "class Foo { }");
rejects("no this", "L1002", "function f() { return this; }");
rejects("no var", "L1003", "var x = 1;");
rejects("no for-in", "L1004", "function f(o) { for (const k in o) { log(k); } }");
rejects("no in operator", "L1004", 'function f(o) { return "a" in o; }');
rejects("no generators", "L1005", "function* g() { }");
rejects("no regex literals", "L1007", "function f(s) { return /a+/.test(s); }");
rejects("no accessors", "L1015", "const o = { get x() { return 1; } };");
rejects("no instanceof", "L1016", "function f(x) { return x instanceof Error; }");
rejects("no tagged templates", "L1018", "function f(t) { return t`hi`; }");
rejects("no new", "L1019", "function f() { return new Thing(); }");
rejects("no imports", "L1020", 'import { x } from "y";');
rejects("no delete", "L1021", "function f(o) { delete o.x; }");
rejects("no do-while", "L1022", "function f() { do { log(1); } while (false); }");
rejects("no computed property names", "L1011", "function f(k) { return { [k]: 1 }; }");
// ASI is ALLOWED, against Jessie: the author writes the JavaScript it would write anyway, which
// is frequently semicolon-free, and ASI is parse-deterministic so determinism is untouched. Only
// the two constructs where a newline genuinely changes meaning stay errors.
accepts("semicolon-free source is ordinary", 'const a = await spawn("x")\nlog(a)\n');
// The TITLE is part of the error, and it was naming a rule this language does not have: an author
// reading "Missing semicolon" over semicolon-free code that the validator accepts everywhere else
// is being told the opposite of what is true.
ok("L1008 is titled for the hazard, not for a semicolon rule that does not exist", CATALOG.L1008 === "Newline hazard", CATALOG.L1008);
accepts("explicit terminators are fine too", 'const a = await spawn("x");\nlog(a);\n');
rejects(
  "a return whose value is on the next line is a hazard",
  "L1008",
  'function f() {\n  return\n  42;\n}',
);
rejects(
  "a line starting with ( continues the one above it",
  "L1008",
  'const a = await spawn("x")\n(log(a));\n',
);
rejects(
  "a line starting with [ does the same",
  "L1008",
  'const a = await spawn("x")\n[1, 2];\n',
);
// A for-header's declaration and update have no terminator of their own: the loop's semicolons
// separate them. Requiring one there would reject every for loop, which the retry pattern needs.
accepts(
  "a for loop header is not an ASI violation",
  'for (let i = 0; i < 3; i = i + 1) {\n  log(i);\n}\n',
);
accepts("a for-of header is not an ASI violation", 'for (const k of range(3)) {\n  log(k);\n}\n');
rejects("no array elision", "L1012", "const a = [1, , 3];");
rejects("no labels", "L1017", "function f() { outer: while (true) { break outer; } }");
rejects("unbraced branches are refused", "L1009", "function f(x) { if (x) log(1); }");
rejects("switch cases must terminate", "L1010", "function f(x) { switch (x) { case 1: log(1); default: break; } }");
rejects(
  "await inside a non-async function is refused",
  "L1023",
  'function f(a) { await turn(a, { name: "x" }); }',
);

// async/await itself is the one deviation from Jessie, and it must work in both positions.
accepts("async and await are restored", 'async function f(a) { await turn(a, { name: "build" }); }');
accepts("top-level await is the normal program shape", 'const a = await spawn("x");\nawait turn(a, { name: "build" });');

// ---- 7) static name resolution -------------------------------------------------------------

rejects("an unknown identifier is a parse error", "L2001", "function f() { return bulider; }");
rejects("shadowing a primitive is refused", "L2002", "const turn = 1;");
rejects("shadowing a builtin as a parameter is refused", "L2002", "function f(log) { return log; }");
rejects("const cannot be reassigned", "L2003", "function f() { const x = 1; x = 2; return x; }");

{
  // A misspelled name must point at the fix, since this is the most common repair an LLM makes.
  let rendered = "";
  try {
    validate("function f() { return bulider; }");
  } catch (e) {
    rendered = (e as LangErrors).render();
  }
  ok("the unknown-name error lists the builtins", rendered.includes("keys, values"), rendered.slice(0, 160));
}

// Legitimate uses of the same shapes must still pass.
accepts("record fields are not identifiers to resolve", 'function f(r) { return r.status === "done"; }');
accepts("shorthand and destructuring bind properly", "function f(r) { const { status, at } = r; return { status, at }; }");
accepts("function declarations hoist within their block", "function a() { return b(); } function b() { return 1; }");
accepts("catch binds its parameter", 'async function f(a) { try { await turn(a, { name: "x" }); } catch (e) { log(e); } }');
accepts("role-parametric procedures are the reuse mechanism",
  'async function review(author, reviewer) { await turn(author, { name: "write" }); await turn(reviewer, { name: "review" }); }');

// ---- 8) errors are collected, not reported one at a time ----------------------------------

{
  let count = 0;
  try {
    validate("var x = 1;\nclass C { }\nfunction f() { return this; }");
  } catch (e) {
    count = (e as LangErrors).errors.length;
  }
  ok("all errors surface in one pass", count >= 3, count);
}

// ---- 9) the lints that warn rather than fail ----------------------------------------------

{
  const r = validate(
    'async function f(a, b) { await parallel([() => turn(a, { name: "x" }), () => turn(b, { name: "y" })], { name: "both" }); }',
  );
  // `validate` throws on a rejected program, so reaching here IS the proof. Stating it as `true`
  // made a real no-throw check indistinguishable from decoration, which is the whole difficulty.
  ok("array-form parallel is legal", r.errors === undefined || r.errors.length === 0, r.errors);
  ok("array-form parallel is linted", r.warnings.some((w) => w.code === "L3023"), r.warnings.map((w) => w.code));
}
{
  // A list whose items visibly carry no id: the source shows there is no stable key.
  const r = validate('await fanOut(["a", "b"], async (i) => turn(await spawn("r"), { name: "review" }), { name: "reviews" });');
  ok("fanOut over visibly unkeyable items is linted", r.warnings.some((w) => w.code === "L3021"), r.warnings.map((w) => w.code));
}
{
  const r = validate('async function f(items, g) { await fanOut(items, g, { name: "reviews", key: (i) => i.id }); }');
  ok("fanOut with a key is clean", r.warnings.length === 0, r.warnings.map((w) => w.code));
}

console.log(`grammar.smoke: ${pass} checks passed`);
