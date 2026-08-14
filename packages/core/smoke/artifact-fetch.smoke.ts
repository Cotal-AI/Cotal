/**
 * The fetch gate's ORDER and its COLLAPSE, neither of which an outcome can show.
 *
 * A suite asserting that both refusals carry the right names passes whether or not the read-gate
 * ran first — the outcomes are identical either way. So these cells record the ORDER of dependency
 * calls and assert on it, and the ordering mutation has a named cell to redden.
 *
 * THE PREVIOUS VERSION OF THIS SUITE PINNED A LEAK IN PLACE, and that is worth stating at the top
 * rather than in a footnote. Its `O3a` asserted that an unattached digest must refuse
 * `not yet attached` and NOT `unknown digest` — which requires the gate to branch on a GLOBAL blob
 * probe, making the pair of names a space-wide existence oracle. The plan forbade that in terms
 * (§5.1). So the code was wrong, the plan was right, and the suite was actively holding the code
 * wrong: a reviewer fixing the leak would have been met by a failing test telling them not to.
 *
 * A cell can be worse than absent. These cells now assert the COLLAPSE — that the two names do not
 * differ on global existence — and the byte store's non-consultation is asserted directly, because
 * "the oracle is closed" is a statement about what was NOT called and no return value can carry it.
 *
 * Run: pnpm smoke:artifact-fetch
 */
import { fetchGate, FETCH_REFUSAL, FETCH_REFUSALS, type FetchGateDeps, type ScopeRecord } from "../src/artifact-fetch.js";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

const D = "sha256:" + "ab".repeat(32);
const CALLER = "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.agent";
const SCOPE = "general";

/**
 * Records the ORDER of dependency calls — the only way an ordering property becomes observable —
 * and the ARGUMENTS, so a lookup that ignores `scope` cannot pass as scope-local.
 */
const spy = (over: Partial<FetchGateDeps> = {}) => {
  const calls: string[] = [];
  const args: Record<string, unknown[]> = {};
  const base: FetchGateDeps = {
    async mayRead() { return true; },
    async scopeRecord() { return "attached" as ScopeRecord; },
    async blobExists() { return true; },
  };
  const deps = { ...base, ...over } as FetchGateDeps;
  // Wrap EVERY dep, overrides included, so no override can escape the recorder.
  for (const k of Object.keys(deps) as (keyof FetchGateDeps)[]) {
    const inner = deps[k] as (...a: unknown[]) => Promise<unknown>;
    (deps as unknown as Record<string, unknown>)[k] = async (...a: unknown[]) => {
      calls.push(k); args[k] = a; return inner(...a);
    };
  }
  return { deps, calls, args };
};

/**
 * Every refusal the cells below ACTUALLY produced, collected as they run.
 *
 * This exists so the reachability cell at the bottom compares the declared vocabulary against
 * OBSERVED BEHAVIOUR rather than against a restatement of itself. Nothing writes to this set except
 * a real reply from the shipped gate.
 */
const OBSERVED = new Set<string>();
const gate = async (deps: FetchGateDeps) => {
  const r = await fetchGate(CALLER, D, SCOPE, deps);
  if (r.error !== undefined) OBSERVED.add(r.error);
  return r;
};

console.log("fetch gate: ordering, scope-locality, and the collapse\n");

// ---- O1 — THE ORDERING PROPERTY ----------------------------------------------------------------
// An unentitled caller must reach NO digest-dependent lookup at all. If any digest lookup runs
// before the gate, the refusal it produces is a statement about the store made to someone entitled
// to nothing.
{
  const { deps, calls } = spy({ async mayRead() { return false; } });
  const r = await gate(deps);
  check("O1a an unauthorized caller is refused `not authorized`",
    r.ok === false && r.error === FETCH_REFUSAL.notAuthorized, r);
  check("O1b the read-gate ran FIRST", calls[0] === "mayRead", calls);
  check("O1c and NO digest-dependent lookup ran at all — nothing to leak",
    !calls.includes("scopeRecord") && !calls.includes("blobExists"), calls);
}

// ---- O2 — NO SCOPE RECORD: the collapsed name, and the byte store NEVER consulted ---------------
//
// THE LOAD-BEARING CELL OF THIS SUITE. A caller with read on ONE scope must not be able to learn
// whether bytes exist anywhere in the space. That is a claim about a call that must not happen, so
// it is asserted as a call that did not happen — a returned refusal name cannot express it, and
// asserting only the name is what let the previous version pass over a live oracle.
//
// THE COUPLING, NAMED. `O2b`, `O3b` and `O4b` all assert an ABSENCE — that `blobExists` was never
// called. An absence assertion is worth exactly as much as the proof that the recorder can see a
// PRESENCE, and that proof is not here: it is `O5b` and `CONTROL`, which assert the spy DID record
// `blobExists` on the one path that must call it.
//
// MEASURED, not assumed: a spy blind to `blobExists` reddens `O5b` + `CONTROL` (14/2); the realistic
// regression — wrapping only the base deps so an override escapes the recorder — reddens `O1b` +
// `O2c` + `O5b` (13/3). A review finding claiming there was no positive control was refuted by
// exactly those two mutations.
//
// BUT THE PROTECTION WAS INCIDENTAL AND UNNAMED, which is why this note exists. Nothing said that
// cheapening `O5b` or CONTROL's order string would silently remove the backing for three other
// cells. IF YOU WEAKEN EITHER OF THOSE TWO, these absence assertions stop meaning anything and no
// cell will tell you. A named residual instead of a silent one.
{
  const { deps, calls, args } = spy({ async scopeRecord() { return "none" as ScopeRecord; } });
  const r = await gate(deps);
  check("O2a a digest with no record IN THIS SCOPE refuses the collapsed `unknown digest`",
    r.ok === false && r.error === FETCH_REFUSAL.unknownDigest, r);
  check("O2b THE ORACLE IS CLOSED — the global byte store was never consulted",
    !calls.includes("blobExists"), calls);
  check("O2c and the scope lookup was passed the SCOPE, not just the digest",
    args.scopeRecord?.[0] === D && args.scopeRecord?.[1] === SCOPE, args.scopeRecord);
}

// ---- O2d — SCOPE-SENSITIVITY, which O2c does NOT establish ---------------------------------------
//
// O2c proves the scope was PASSED. It says nothing about whether the answer DEPENDS on it, and that
// is arity mistaken for semantics: a `scopeRecord` that ignores its second argument entirely — the
// globalizing implementation this whole rewrite exists to prevent — satisfies O2c and every other
// cell in this suite, because every other stub returns a constant.
//
// So this fixture is TABLE-DRIVEN over two scopes with ONE digest: attached in `S_a`, no record in
// `S_b`. A dep that ignores `scope` cannot produce both answers, so it cannot pass both halves.
//
// The gate's own control flow is honest either way — this constrains the DEPENDENCY it trusts, which
// is where the reach would actually come from once `scopeRecord` is implemented against real stores.
{
  const S_A = "alpha", S_B = "beta";
  const table: Record<string, ScopeRecord> = { [S_A]: "attached", [S_B]: "none" };
  const scopedDeps = (): FetchGateDeps => ({
    async mayRead() { return true; },
    async scopeRecord(_digest, scope) { return table[scope] ?? "none"; },
    async blobExists() { return true; },
  });
  const inA = await fetchGate(CALLER, D, S_A, scopedDeps());
  const inB = await fetchGate(CALLER, D, S_B, scopedDeps());
  if (inB.error !== undefined) OBSERVED.add(inB.error);
  check("O2d the SAME digest is allowed in one scope and unknown in another — the answer is scope-SENSITIVE",
    inA.ok === true && inB.ok === false && inB.error === FETCH_REFUSAL.unknownDigest, { inA, inB });
}

// ---- O3 — PENDING: the retryable name, earned by a scope-specific record ------------------------
// `not yet attached` is honest here and ONLY here: a scope-specific pending attach exists, so a
// retry can still win. It is NOT derived from whether the bytes exist — that derivation is the leak.
{
  const { deps, calls } = spy({ async scopeRecord() { return "pending" as ScopeRecord; } });
  const r = await gate(deps);
  check("O3a a scope-specific PENDING record refuses the retryable `not yet attached`",
    r.ok === false && r.error === FETCH_REFUSAL.notYetAttached, r);
  check("O3b and still without consulting the global byte store", !calls.includes("blobExists"), calls);
}

// ---- O4 — THE COLLAPSE ITSELF, asserted as an equality ------------------------------------------
//
// The two fixtures below differ ONLY in whether the bytes exist globally. Under the old gate they
// produced DIFFERENT names, and a cell required them to. Here they must produce the SAME name —
// asserting the names are equal to each other, not merely that each is what it should be, because
// the property is indistinguishability and that is a relation between two runs.
{
  const absent = spy({ async scopeRecord() { return "none" as ScopeRecord; }, async blobExists() { return false; } });
  const present = spy({ async scopeRecord() { return "none" as ScopeRecord; }, async blobExists() { return true; } });
  const rA = await gate(absent.deps);
  const rP = await gate(present.deps);
  check("O4a bytes-absent and bytes-present are INDISTINGUISHABLE when the scope has no record",
    rA.error === rP.error && rA.ok === rP.ok, { absent: rA, present: rP });
  check("O4b neither run consulted the byte store at all — identical in work, not just in text",
    !absent.calls.includes("blobExists") && !present.calls.includes("blobExists"),
    { absent: absent.calls, present: present.calls });
}

// ---- O5 — EXPIRED is reachable, and only from scope-local terminal state ------------------------
// An attachment this scope holds whose bytes are gone. Distinct because the caller already has an
// attachment record in a scope it may read, so a terminal answer reveals nothing further — and it
// replaces a `not yet attached` that invited retries which could never succeed.
{
  const { deps, calls } = spy({
    async scopeRecord() { return "attached" as ScopeRecord; },
    async blobExists() { return false; },
  });
  const r = await gate(deps);
  check("O5a an attached digest whose bytes are gone refuses the TERMINAL `expired`",
    r.ok === false && r.error === FETCH_REFUSAL.expired, r);
  check("O5b and the byte store was consulted only AFTER the scope record put the digest in scope",
    calls.join(">") === "mayRead>scopeRecord>blobExists", calls);
}

// ---- CONTROL — a suite that only refuses is unfalsifiable ---------------------------------------
{
  const { deps, calls } = spy();
  const r = await gate(deps);
  check("CONTROL a fully authorized fetch of an attached, present artifact is allowed",
    r.ok === true && r.error === undefined, r);
  check("CONTROL and it consulted all three IN ORDER — gate, then scope, then bytes",
    calls.join(">") === "mayRead>scopeRecord>blobExists", calls);
}

// ---- the vocabulary is closed --------------------------------------------------------------------
{
  const v = Object.values(FETCH_REFUSAL);
  check("the fetch refusal vocabulary has no accidental duplicates", new Set(v).size === v.length, v);
  // EVERY declared refusal must be REACHABLE, not merely declared. `expired` was declared and
  // returned by no path — dead vocabulary that read as a live guarantee.
  //
  // THE FIRST VERSION OF THIS CELL WAS A TAUTOLOGY. It built its expected set by hand from
  // `FETCH_REFUSAL`, then asserted `FETCH_REFUSALS` — which IS `Object.values(FETCH_REFUSAL)` —
  // against it. A table compared to itself. It passed if `O3` and `O5` were deleted, and would have
  // passed against a gate returning none of these names. The comment above it claimed it asserted
  // each name "was actually produced by a cell above", which is exactly what it did not do. Shipped
  // in the commit that closed the dead-`expired` hole, and caught by a reviewer.
  //
  // THE CLASS, so the next person recognises it without the story: an assertion whose EXPECTED value
  // is derived from the same source as its ACTUAL value cannot fail. The tell is that the expected
  // side was COMPUTED rather than STATED — if you can trace it back to the thing under test, it is
  // not an assertion, it is a restatement.
  //
  // `OBSERVED` is collected from the errors the cells above ACTUALLY returned. Delete `O3` and
  // `notYetAttached` never enters it; delete `O5` and `expired` never does.
  check("every declared refusal is REACHABLE — each was produced by a cell above, not just declared",
    FETCH_REFUSALS.every((r) => OBSERVED.has(r)), FETCH_REFUSALS.filter((r) => !OBSERVED.has(r)));
}

console.log(`\nartifact-fetch: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
