/**
 * The step key's proof.
 *
 * The claim under test is the one the whole durability story rests on: **every occurrence counter
 * is allocated deterministically, including inside concurrency scopes**. If two branches of a
 * `parallel` can race for occurrence 0, then a resumed run can look up the wrong journal entry
 * and hand a program a result that belongs to a different agent, which is the exact class of
 * silent breakage keyed journalling exists to prevent.
 *
 * These tests deliberately allocate keys in adversarial interleavings, because the interpreter
 * will produce them once branches contain awaits.
 */
import {
  requestId, KeyScope, branchKeys, digest, stepKeyString, type StepKey } from "../src/keys.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};
const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

// ---- 1) sequential keys ---------------------------------------------------------------------

{
  const root = new KeyScope();
  eq("first turn", stepKeyString(root.nextEffect("turn", "build")), "/turn:build#0");
  eq("second turn of the same name", stepKeyString(root.nextEffect("turn", "build")), "/turn:build#1");
  eq("a different name restarts the count", stepKeyString(root.nextEffect("turn", "review")), "/turn:review#0");
  eq("a different kind restarts the count", stepKeyString(root.nextEffect("ask", "build")), "/ask:build#0");
  eq("unnamed steps key on the kind alone", stepKeyString(root.nextEffect("sleep")), "/sleep#0");
}

// ---- 2) a loop gives each iteration a fresh key ---------------------------------------------

// This is the mechanism that replaces the plan's `rescue` keyword: a retry loop re-runs its
// effects because each iteration's key is new, not because anything unwinds the journal.
{
  const root = new KeyScope();
  const keys = [0, 1, 2].map(() => stepKeyString(root.nextEffect("turn", "build")));
  eq("a retry loop produces distinct keys", keys, ["/turn:build#0", "/turn:build#1", "/turn:build#2"]);
}

// ---- 3) concurrency: branches cannot race for a counter --------------------------------------

{
  const root = new KeyScope();
  const occ = root.nextScope("parallel", "reviews");
  const security = root.branch("parallel", "reviews", occ, "security");
  const perf = root.branch("parallel", "reviews", occ, "perf");

  // Allocate in the WORST order: interleaved, and with perf going first. Branch keys must not
  // depend on which branch happened to reach its effect first.
  const p0 = stepKeyString(perf.nextEffect("turn", "review"));
  const s0 = stepKeyString(security.nextEffect("turn", "review"));
  const p1 = stepKeyString(perf.nextEffect("turn", "review"));
  const s1 = stepKeyString(security.nextEffect("turn", "review"));

  eq("same step name in two branches does not collide", [s0, p0], [
    "/parallel:reviews#0/b:security/turn:review#0",
    "/parallel:reviews#0/b:perf/turn:review#0",
  ]);
  ok("both branches start at occurrence 0", s0.endsWith("#0") && p0.endsWith("#0"));
  eq("each branch counts independently", [s1, p1], [
    "/parallel:reviews#0/b:security/turn:review#1",
    "/parallel:reviews#0/b:perf/turn:review#1",
  ]);

  // The determinism argument: replaying in the opposite interleaving yields the same keys.
  const root2 = new KeyScope();
  const occ2 = root2.nextScope("parallel", "reviews");
  const security2 = root2.branch("parallel", "reviews", occ2, "security");
  const perf2 = root2.branch("parallel", "reviews", occ2, "perf");
  const s0b = stepKeyString(security2.nextEffect("turn", "review"));
  const p0b = stepKeyString(perf2.nextEffect("turn", "review"));
  eq("replay in the opposite order yields identical keys", [s0b, p0b], [s0, p0]);
}

// ---- 4) a scope re-entered in a loop gets a fresh namespace ----------------------------------

{
  const root = new KeyScope();
  const seen: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const occ = root.nextScope("parallel", "checks");
    for (const b of ["lint", "tests"]) {
      seen.push(stepKeyString(root.branch("parallel", "checks", occ, b).nextEffect("turn", b)));
    }
  }
  eq("re-entering a scope in a loop does not reuse keys", seen, [
    "/parallel:checks#0/b:lint/turn:lint#0",
    "/parallel:checks#0/b:tests/turn:tests#0",
    "/parallel:checks#1/b:lint/turn:lint#0",
    "/parallel:checks#1/b:tests/turn:tests#0",
  ]);
  ok("every key in a re-entered scope is unique", new Set(seen).size === seen.length);
}

// ---- 5) nesting ------------------------------------------------------------------------------

{
  const root = new KeyScope();
  const outer = root.nextScope("fanOut", "reviews");
  const item = root.branch("fanOut", "reviews", outer, "security");
  const inner = item.nextScope("parallel", null);
  const nested = item.branch("parallel", null, inner, "0");
  eq(
    "nested scopes compose, and an unnamed scope omits its name",
    stepKeyString(nested.nextEffect("turn", "check")),
    "/fanOut:reviews#0/b:security/parallel#0/b:0/turn:check#0",
  );
}

// ---- 6) two sibling unnamed scopes stay distinct ---------------------------------------------

{
  const root = new KeyScope();
  const a = root.nextScope("parallel", null);
  const b = root.nextScope("parallel", null);
  ok("sibling unnamed scopes get distinct occurrences", a === 0 && b === 1, { a, b });
  eq(
    "and therefore distinct branch namespaces",
    [
      stepKeyString(root.branch("parallel", null, a, "0").nextEffect("turn", "x")),
      stepKeyString(root.branch("parallel", null, b, "0").nextEffect("turn", "x")),
    ],
    ["/parallel#0/b:0/turn:x#0", "/parallel#1/b:0/turn:x#0"],
  );
}

// ---- 7) branch keys: the record form survives insertion, the array form does not -------------

{
  eq("array branches are keyed by index", branchKeys([() => 1, () => 2]), ["0", "1"]);
  eq("record branches are keyed by name", branchKeys({ lint: () => 1, tests: () => 2 }), ["lint", "tests"]);

  // Insert a branch at the FRONT of each form and ask what key the SAME branch now gets. This is
  // the whole reason the record form is the documented default: an author inserting a branch is
  // a routine edit, and under the array form it silently moves every later branch's journal
  // namespace, so their recorded steps are orphaned and re-run.
  const keyOfArrayBranch = (order: readonly string[], branch: string): string | undefined =>
    branchKeys(order.map(() => () => 0))[order.indexOf(branch)];
  const keyOfRecordBranch = (order: readonly string[], branch: string): string | undefined => {
    const rec: Record<string, () => number> = {};
    for (const b of order) rec[b] = () => 0;
    const keys = branchKeys(rec);
    return keys[keys.indexOf(branch)];
  };

  ok("array form: `lint` starts at key 0", keyOfArrayBranch(["lint", "tests"], "lint") === "0");
  ok(
    "array form: inserting ahead of it moves `lint` to key 1",
    keyOfArrayBranch(["typecheck", "lint", "tests"], "lint") === "1",
  );
  ok(
    "record form: `lint` keeps its key across the same insertion",
    keyOfRecordBranch(["lint", "tests"], "lint") === "lint" &&
      keyOfRecordBranch(["typecheck", "lint", "tests"], "lint") === "lint",
  );
}

// ---- 8) the input hash ------------------------------------------------------------------------

{
  const a = digest({ agent: "builder", worktree: "wt-1" });
  const b = digest({ worktree: "wt-1", agent: "builder" });
  ok("the digest is a sha256 content address", a.startsWith("sha256:") && a.length === 71, a);
  ok("key order does not change the digest", a === b);
  ok("content does change the digest", digest({ agent: "planner", worktree: "wt-1" }) !== a);
  ok(
    "an absent field and an explicit null are different inputs",
    digest({ a: 1 }) !== digest({ a: 1, b: null }),
  );
}

// ---- the request identity ----------------------------------------------------------------------

/**
 * `requestId` is what a handler submits under, so it has two jobs that pull in opposite directions:
 * it must DISCRIMINATE (two runs, two attempts) and it must REPRODUCE (a resume derives the same
 * id it first used, or recovery reissues under an identity the far side never saw).
 *
 * The encoding is not cosmetic. An endpoint id token is `[A-Za-z0-9_-]{1,64}`; the `sha256:<hex>`
 * form this first carried is 71 characters and contains a colon, so it was never a legal id and a
 * handler could not have used it at all. That is asserted here against the real shape rather than
 * left to a reader to notice.
 */
{
  const k = (name: string, occurrence = 0) =>
    ({ scope: [], kind: "turn" as const, name, occurrence });

  const a = requestId("run-a", k("build"), "h");
  const b = requestId("run-b", k("build"), "h");
  ok("two runs at the same step derive different ids", a !== b, { a, b });

  const t0 = requestId("run-a", k("gate"), "h", 0);
  const t1 = requestId("run-a", k("gate"), "h", 1);
  ok("two attempts at one step derive different ids", t0 !== t1, { t0, t1 });

  ok("the same inputs reproduce the same id", requestId("run-a", k("build"), "h") === a);
  ok("a different step is a different id", requestId("run-a", k("other"), "h") !== a);
  ok("a different input hash is a different id", requestId("run-a", k("build"), "h2") !== a);

  // The endpoint's own grammar, restated here rather than imported: this package is pure and does
  // not depend on core, so the constraint is pinned as a literal and named as borrowed.
  const ID = /^[A-Za-z0-9_-]{1,64}$/;
  ok("the id is a legal endpoint id token", ID.test(a), a);
  ok("and carries no dot, which a dot-separated subject would split on", !a.includes("."));
  ok("the digest form it replaced would NOT be legal", !ID.test(`sha256:${"a".repeat(64)}`));
}

// ---- g3: stepKeyString is NOT injective, pinned as a KNOWN DEFECT ---------------------------
//
// These cells assert what the code does TODAY and are written to DIE. The repair makes them fail,
// and that is the point: they are the tripwire for a defect this lane did not detect and is now
// fixing against its own model of it. A cell that must break when the bug is fixed has no
// correct-looking state to pass in, so it cannot go quietly vacuous the way a forward-looking
// assertion can.
//
// The key grammar builds `/kind:name#occ/b:branch` by concatenation and NOTHING escapes the three
// characters it reserves. So a branch key — or a step name — that spells a path forges structure,
// and two structurally different programs print one identical key. Measured consequences, both
// reproduced live: with DIFFERENT inputs at the two locations the run throws a spurious L5001
// "run divergence, INPUT CHANGED" for a program that never diverged; with the SAME inputs it is
// entirely silent — one durable row serves two locations, the run reports success, and a replay
// hands the second location the first one's recorded effect. The silent case is the worse one.
// THE TRIPWIRE ABOVE DIED, WHICH IS THE ONLY OUTCOME THAT PROVES THE REPAIR REACHES HERE.
// It asserted that two structurally different scopes print one identical key and that a step name
// forges structure as readily as a branch key. Both were true; both are now unreachable, because
// the mint refuses the inputs. What replaces it asserts the REFUSAL, and the twin below asserts
// that the refusal is narrow — a guard that rejected every branch key would satisfy the first half
// perfectly and destroy the language.
const refuses = (what: string, f: () => unknown): string | null => {
  try { f(); return null; } catch (e) { return (e as { code?: string }).code ?? `no code: ${what}`; }
};
{
  const root = new KeyScope();

  ok("a branch key that spells a nested path is REFUSED at the mint, not silently keyed",
    refuses("branch", () => root.branch("parallel", "outer", 0, "a/parallel:inner#0/b:b")) === "L3025");
  ok("and so is a bare reserved character, because the forgery needs no cleverness",
    refuses("branch", () => root.branch("parallel", "outer", 0, "a#b")) === "L3025");
  ok("a step NAME forges structure too, and is refused on the same grammar",
    refuses("name", () => root.nextEffect("sleep", "z#0/b:x/sleep:y")) === "L3025");

  // The narrowness twin. The guard rejects exactly the three characters the key grammar reserves;
  // anything else a program legitimately writes must still mint. Without this the cells above are
  // satisfied by a guard that refuses everything.
  ok("an ordinary branch key still mints", refuses("branch", () => root.branch("parallel", "outer", 0, "a")) === null);
  ok("and a camelCase one, which is an ordinary object key",
    refuses("branch", () => root.branch("parallel", "outer", 0, "runTests")) === null);
  ok("and a fan-out branch keyed by a hyphenated item",
    refuses("branch", () => root.branch("fanOut", "reviews", 0, "security-lens")) === null);
  ok("and an ordinary step name", refuses("name", () => root.nextEffect("sleep", "one")) === null);

  // The residual, asserted rather than described: the KEY FUNCTION is still non-injective. The
  // repair closes the paths that MINT a key, not `stepKeyString` itself, so anything handing the
  // runtime a key STRING — `planFork`'s caller-supplied `fromStepKey` is exactly this — is
  // unprotected by everything above. Named here so the repair is not read as more than it is.
  const forged: StepKey = {
    scope: [{ kind: "parallel", name: "outer", occurrence: 0, branch: "a/parallel:inner#0/b:b" }],
    kind: "sleep", name: "z", occurrence: 0,
  };
  const nested: StepKey = {
    scope: [
      { kind: "parallel", name: "outer", occurrence: 0, branch: "a" },
      { kind: "parallel", name: "inner", occurrence: 0, branch: "b" },
    ],
    kind: "sleep", name: "z", occurrence: 0,
  };
  ok("RESIDUAL: stepKeyString is still not injective for a hand-built key, so a caller-supplied key string is unprotected",
    stepKeyString(forged) === stepKeyString(nested), { forged: stepKeyString(forged), nested: stepKeyString(nested) });
}

console.log(`keys.smoke: ${pass} checks passed`);
