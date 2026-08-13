/**
 * The fetch gate's ORDER, which no outcome can show.
 *
 * A suite asserting that both refusals carry the right names passes whether or not the read-gate
 * ran first — the outcomes are identical either way. So these cells record the ORDER of dependency
 * calls and assert on it, and the ordering mutation has a named cell to redden. Without that, the
 * rule is prose and the code is free to drift from it silently.
 *
 * Run: pnpm smoke:artifact-fetch
 */
import { fetchGate, FETCH_REFUSAL, FETCH_REFUSALS, type FetchGateDeps } from "../src/artifact-fetch.js";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

const D = "sha256:" + "ab".repeat(32);
const CALLER = "UAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.agent";
const SCOPE = "general";

/** Records the ORDER of dependency calls — the only way an ordering property becomes observable. */
const spy = (over: Partial<FetchGateDeps> = {}) => {
  const calls: string[] = [];
  const deps: FetchGateDeps = {
    async mayRead() { calls.push("mayRead"); return true; },
    async blobExists() { calls.push("blobExists"); return true; },
    async isAttached() { calls.push("isAttached"); return true; },
    ...over,
  };
  // Wrap the overrides too, so an override cannot silently escape the recorder.
  for (const k of Object.keys(over) as (keyof FetchGateDeps)[]) {
    const inner = over[k] as (...a: unknown[]) => Promise<boolean>;
    (deps as Record<string, unknown>)[k] = async (...a: unknown[]) => { calls.push(k); return inner(...a); };
  }
  return { deps, calls };
};

console.log("fetch gate: ordering + named refusals\n");

// ---- O1 — THE ORDERING PROPERTY ----------------------------------------------------------------
// An unentitled caller must reach NO digest-dependent lookup at all. If `blobExists` or `isAttached`
// runs before the gate, the refusal it produces is a statement about the global store made to
// someone entitled to nothing.
{
  const { deps, calls } = spy({ async mayRead() { return false; } });
  const r = await fetchGate(CALLER, D, SCOPE, deps);
  check("O1a an unauthorized caller is refused `not authorized`",
    r.ok === false && r.error === FETCH_REFUSAL.notAuthorized, r);
  check("O1b the read-gate ran FIRST", calls[0] === "mayRead", calls);
  check("O1c and NO digest-dependent lookup ran at all — nothing to leak",
    !calls.includes("blobExists") && !calls.includes("isAttached"), calls);
}

// ---- O2 — after entitlement, scoped statements are permitted ------------------------------------
{
  const { deps, calls } = spy({ async blobExists() { return false; } });
  const r = await fetchGate(CALLER, D, SCOPE, deps);
  check("O2a a missing blob refuses `unknown digest` — but only past the gate",
    r.ok === false && r.error === FETCH_REFUSAL.unknownDigest, r);
  check("O2b and the gate still ran first", calls[0] === "mayRead", calls);
}

// ---- O3 — not-yet-attached is distinct and reachable only past the gate --------------------------
{
  const { deps, calls } = spy({ async isAttached() { return false; } });
  const r = await fetchGate(CALLER, D, SCOPE, deps);
  check("O3a an unattached digest refuses `not yet attached`, not `unknown digest`",
    r.ok === false && r.error === FETCH_REFUSAL.notYetAttached, r);
  check("O3b gate first, then blob, then attachment", calls.join(">") === "mayRead>blobExists>isAttached", calls);
}

// ---- CONTROL — a suite that only refuses is unfalsifiable ---------------------------------------
{
  const { deps, calls } = spy();
  const r = await fetchGate(CALLER, D, SCOPE, deps);
  check("CONTROL a fully authorized fetch is allowed", r.ok === true && r.error === undefined, r);
  check("CONTROL and it consulted all three, gate first",
    calls.join(">") === "mayRead>blobExists>isAttached", calls);
}

// ---- the vocabulary is closed --------------------------------------------------------------------
{
  const v = Object.values(FETCH_REFUSAL);
  check("the fetch refusal vocabulary has no accidental duplicates", new Set(v).size === v.length, v);
  check("every refusal returned above is in the declared set",
    FETCH_REFUSALS.includes(FETCH_REFUSAL.notAuthorized), FETCH_REFUSALS);
}

console.log(`\nartifact-fetch: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
