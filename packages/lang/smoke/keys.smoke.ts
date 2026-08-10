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
import { KeyScope, branchKeys, digest, stepKeyString } from "../src/keys.js";

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

console.log(`keys.smoke: ${pass} checks passed`);
