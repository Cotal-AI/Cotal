/**
 * `epname` closed-machine smoke — § S2's state variants and edge table.
 *
 * Pure: no broker, no clock. Every refusal below asserts on the REASON, not merely that something
 * threw — this lane has already shipped a guard that could not fire and only noticed because a
 * cell reported the wrong refusal, so a bare `throws` is not evidence here.
 *
 * Run: pnpm smoke:ep-epname   (part of smoke:ci)
 */
import {
  parseEpName, assertEpNameEdge,
  type EpNameRow, type EpNameActor,
} from "../src/endpoint-epname.js";

let ok = 0, fail = 0;
function c(label: string, cond: boolean, detail?: unknown): void {
  if (cond) { ok++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`); }
}
function refuses(label: string, fn: () => unknown, matching: RegExp): void {
  try { fn(); c(label, false, "did NOT throw"); }
  catch (e) {
    const m = (e as Error).message;
    c(label, matching.test(m), { expected: String(matching), got: m });
  }
}
function allows(label: string, fn: () => unknown): void {
  try { fn(); c(label, true); }
  catch (e) { c(label, false, (e as Error).message); }
}

const OWNER = { instanceId: "mgr-a", processEpoch: 7 };
const OWNER2 = { instanceId: "mgr-b", processEpoch: 2 };
const CLAIMANT = { kind: "action", goalId: "g-1", gen: 1 };
const UID = "u_abc";

const claimed = { v: 1, ts: 1, state: "claimed", claimant: CLAIMANT };
const launching = { v: 1, ts: 2, state: "launching", claimant: CLAIMANT, lifecycleUid: UID, launchAttemptId: "att-1", executor: OWNER };
const live = { v: 1, ts: 3, state: "live", claimant: CLAIMANT, lifecycleUid: UID, runtimeOwner: OWNER };
const preserved = { v: 1, ts: 4, state: "preserved", claimant: CLAIMANT, lifecycleUid: UID, runtimeOwner: OWNER };
const relaunching = { v: 1, ts: 5, state: "relaunching", claimant: CLAIMANT, lifecycleUid: UID, launchAttemptId: "att-2", executor: OWNER2 };
const draining = { v: 1, ts: 6, state: "draining", claimant: CLAIMANT, lifecycleUid: UID, runtimeOwner: OWNER, enteredAt: 6 };
const released = { v: 1, ts: 7, state: "released", claimant: null };

const P = (v: unknown): EpNameRow => parseEpName(v);
const CLAIM: EpNameActor = { role: "claimant" };
const HOLDER: EpNameActor = { role: "holder", lifecycleUid: UID };
const SWEEPER: EpNameActor = { role: "sweeper" };
const OPERATOR: EpNameActor = { role: "operator" };
const ALLOC: EpNameActor = { role: "allocator" };
const CUTOVER: EpNameActor = { role: "cutover" };
const G = { gateSatisfied: true };

console.log("\n── § S2 shape: each state names the COMPLETE legal field set ──");
allows("claimed parses", () => P(claimed));
allows("launching parses", () => P(launching));
allows("live parses", () => P(live));
allows("preserved parses", () => P(preserved));
allows("relaunching parses", () => P(relaunching));
allows("draining parses", () => P(draining));
allows("released parses with a null claimant", () => P(released));

refuses("`live` must NOT carry a launch nonce (no launch is in flight)",
  () => P({ ...live, launchAttemptId: "att-1" }), /unknown field\(s\) for state live: launchAttemptId/);
refuses("`live` must NOT carry an `executor`",
  () => P({ ...live, executor: OWNER }), /unknown field\(s\) for state live: executor/);
refuses("`launching` must NOT carry a `runtimeOwner` (nothing owns a handle yet)",
  () => P({ ...launching, runtimeOwner: OWNER }), /unknown field\(s\) for state launching: runtimeOwner/);
refuses("`launching` REQUIRES an `executor` — the release predicate reads it on every path",
  () => { const { executor: _x, ...rest } = launching; return P(rest); },
  /state launching is missing required field\(s\): executor/);
refuses("`draining` REQUIRES `enteredAt`",
  () => { const { enteredAt: _x, ...rest } = draining; return P(rest); },
  /missing required field\(s\): enteredAt/);
refuses("an unknown state is refused", () => P({ ...claimed, state: "quiescing" }), /unknown state/);

console.log("\n── claimant: NON-NULL everywhere but `released` ──");
refuses("a `live` row with a null claimant is refused",
  () => P({ ...live, claimant: null }), /state live REQUIRES a non-null `claimant`/);
refuses("a `claimed` row with a null claimant is refused",
  () => P({ ...claimed, claimant: null }), /state claimed REQUIRES a non-null `claimant`/);
refuses("a `released` row with a claimant is refused (the name is unheld)",
  () => P({ ...released, claimant: CLAIMANT }), /`released` REQUIRES a null `claimant`/);
allows("a direct claimant parses", () => P({ ...claimed, claimant: { kind: "direct", instanceId: "m", processEpoch: 1, opId: "o" } }));
allows("an incumbent claimant parses", () => P({ ...claimed, claimant: { kind: "incumbent", backfillId: "b-1" } }));
refuses("an unknown claimant kind is refused",
  () => P({ ...claimed, claimant: { kind: "roster", who: "x" } }), /unknown claimant kind/);
refuses("a claimant missing a required field is refused",
  () => P({ ...claimed, claimant: { kind: "action", goalId: "g-1" } }), /is missing: gen/);
refuses("a claimant carrying an extra field is refused",
  () => P({ ...claimed, claimant: { ...CLAIMANT, uid: "x" } }), /unknown field\(s\) on a action claimant/);

console.log("\n── § S2 edges: the table, and nothing else ──");
allows("— → claimed (allocator)", () => assertEpNameEdge(null, P(claimed), ALLOC, G));
allows("released → claimed re-claim", () => assertEpNameEdge(P(released), P(claimed), ALLOC, G));
allows("claimed → launching (claimant)", () => assertEpNameEdge(P(claimed), P(launching), CLAIM, G));
allows("claimed → released (claimant)", () => assertEpNameEdge(P(claimed), P(released), CLAIM, G));
allows("live → preserved (holder)", () => assertEpNameEdge(P(live), P(preserved), HOLDER, G));
allows("preserved → relaunching (holder)", () => assertEpNameEdge(P(preserved), P(relaunching), HOLDER, G));

refuses("claimed → live skips the launch record",
  () => assertEpNameEdge(P(claimed), P(live), CLAIM, G), /not a legal edge/);
refuses("released → live is not a re-claim",
  () => assertEpNameEdge(P(released), P(live), ALLOC, G), /not a legal edge/);
refuses("live → released cannot bypass draining",
  () => assertEpNameEdge(P(live), P(released), SWEEPER, G), /not a legal edge/);

console.log("\n── ordinary `live` authorizes NO relaunch — the round-11 edge stays deleted ──");
refuses("live → relaunching is refused",
  () => assertEpNameEdge(P(live), P(relaunching), HOLDER, G), /not a legal edge/);
refuses("live → launching is refused too (a second launch under a live name)",
  () => assertEpNameEdge(P(live), P(launching), CLAIM, G), /not a legal edge/);

console.log("\n── `draining` has exactly ONE exit, and it is the operator ──");
allows("draining → released by the OPERATOR",
  () => assertEpNameEdge(P(draining), P(released), OPERATOR, G));
refuses("a sweeper may NOT release a draining row",
  () => assertEpNameEdge(P(draining), P(released), SWEEPER, G), /a sweeper may not take draining → released/);
refuses("the holder may NOT release a draining row",
  () => assertEpNameEdge(P(draining), P(released), HOLDER, G), /a holder may not take draining → released/);
refuses("draining → live is not a recovery path",
  () => assertEpNameEdge(P(draining), P(live), OPERATOR, G), /not a legal edge/);
// A `released` row cannot carry `lifecycleUid` through the parser — it is not in that state's
// legal set — so the leftover is constructed directly on the parsed row. That is the ONE place in
// this suite that bypasses the parser, and it is deliberate: the guard exists for a writer that
// builds the row itself, which is exactly what this constructs.
refuses("the operator edge CLEARS the lifecycle fields",
  () => assertEpNameEdge(P(draining), { ...P(released), lifecycleUid: UID }, OPERATOR, G),
  /CLEARS `lifecycleUid`/);

console.log("\n── runtimeOwner is MOVED on the launch-completing edges ──");
allows("launching → live moves the FULL executor into runtimeOwner",
  () => assertEpNameEdge(P(launching), P(live), CLAIM, G));
allows("relaunching → live OVERWRITES the previous owner with the resuming one",
  () => assertEpNameEdge(P(relaunching), P({ ...live, runtimeOwner: OWNER2 }), HOLDER, G));
refuses("moving only `instanceId` is refused — an identity is not an incarnation",
  () => assertEpNameEdge(P(launching), P({ ...live, runtimeOwner: { instanceId: OWNER.instanceId, processEpoch: 0 } }), CLAIM, G),
  /an `instanceId` without its `processEpoch` is an identity/);
refuses("naming a DIFFERENT incarnation as owner is refused",
  () => assertEpNameEdge(P(launching), P({ ...live, runtimeOwner: OWNER2 }), CLAIM, G),
  /MOVES the full `executor`/);
refuses("launching → draining also moves the full executor",
  () => assertEpNameEdge(P(launching), P({ ...draining, runtimeOwner: OWNER2 }), SWEEPER, G),
  /MOVES the full `executor`/);

console.log("\n── runtimeOwner is CARRIED everywhere else, never re-derived ──");
allows("live → draining carries the owner unchanged",
  () => assertEpNameEdge(P(live), P(draining), SWEEPER, G));
refuses("live → draining may NOT re-derive the owner",
  () => assertEpNameEdge(P(live), P({ ...draining, runtimeOwner: OWNER2 }), SWEEPER, G),
  /CARRIES `runtimeOwner` unchanged/);
refuses("live → preserved may NOT change the owner (quiescing is not a transfer)",
  () => assertEpNameEdge(P(live), P({ ...preserved, runtimeOwner: OWNER2 }), HOLDER, G),
  /CARRIES `runtimeOwner` unchanged/);
refuses("preserved → draining may NOT change the owner",
  () => assertEpNameEdge(P(preserved), P({ ...draining, runtimeOwner: OWNER2 }), SWEEPER, G),
  /CARRIES `runtimeOwner` unchanged/);

console.log("\n── the cutover backfill refuses to invent an owner ──");
allows("— → live with an owner read from the incumbent's live gate row",
  () => assertEpNameEdge(null, P({ ...live, claimant: { kind: "incumbent", backfillId: "b-1" } }), CUTOVER, G));
refuses("— → live is refused when no gate row names an incarnation",
  () => assertEpNameEdge(null,
    { ...P({ ...live, claimant: { kind: "incumbent", backfillId: "b-1" } }), runtimeOwner: undefined },
    CUTOVER, G),
  /record a cutover CASUALTY instead of inventing an owner/);
refuses("a non-cutover actor may not create a `live` row",
  () => assertEpNameEdge(null, P({ ...live, claimant: { kind: "incumbent", backfillId: "b-1" } }), ALLOC, G),
  /a allocator may not take — → live/);

console.log("\n── the actor and the gate are both required, and neither is inferable ──");
refuses("a sweeper may not take the claimant's launch edge",
  () => assertEpNameEdge(P(claimed), P(launching), SWEEPER, G), /a sweeper may not take claimed → launching/);
refuses("a non-holder lifecycleUid may not relaunch",
  () => assertEpNameEdge(P(preserved), P(relaunching), { role: "holder", lifecycleUid: "u_other" }, G),
  /EXACT `lifecycleUid` holder only/);
refuses("an unattested gate is refused",
  () => assertEpNameEdge(P(live), P(draining), SWEEPER, { gateSatisfied: false }),
  /requires its gate to hold FIRST/);

console.log("\n── claimant and lifecycleUid immutability ──");
refuses("`claimant` cannot change while a claim is held",
  () => assertEpNameEdge(P(launching), P({ ...live, claimant: { kind: "action", goalId: "g-2", gen: 1 } }), CLAIM, G),
  /`claimant` is immutable/);
refuses("`lifecycleUid` cannot change while a claim is held",
  () => assertEpNameEdge(P(live), P({ ...draining, lifecycleUid: "u_zzz" }), SWEEPER, G),
  /`lifecycleUid` is immutable/);

console.log(`\nENDPOINT EPNAME SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
if (fail > 0) process.exitCode = 1;
