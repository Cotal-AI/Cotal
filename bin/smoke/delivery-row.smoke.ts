/**
 * The ready card's delivery row, driven directly.
 *
 * THE LOAD-BEARING ASSERTION is `marker`. It is the one output a reader takes at a glance, and `✓`
 * is the only glyph that says "delivery is working". It is asserted as a PROPERTY over every state
 * below, not case-by-case, so a state added later cannot quietly acquire a tick — the same discipline
 * `manager-claim.smoke.ts` applies to `startHint` for the same reason.
 *
 * What is NOT covered here: whether any real credential profile can perform the read and the
 * round-trip. That is an open measurement (`.lane/credclass-predictions.md`) and the row takes its
 * caller mint as a required parameter precisely so this suite cannot silently assume one.
 *
 * Run: pnpm exec tsx bin/smoke/delivery-row.smoke.ts
 */
import { deliveryRow, renderDeliveryRow, type DeliveryRow } from "../../implementations/cli/src/lib/delivery-row.js";
import type { DeliveryHealth } from "../../packages/core/src/health.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`); }
};

const AT = 1_700_000_000_000;
const serving: DeliveryHealth = {
  serving: true,
  incarnation: { value: "daemon-abc", source: "responder-roundtrip", observedAt: AT, ageMs: 0 },
  respondedIn: { value: 12, source: "responder-roundtrip", observedAt: AT, ageMs: 0 },
  lastHeartbeat: { value: AT - 5_000, source: "lease-kv", observedAt: AT, ageMs: 5_000 },
};
const noResponder: DeliveryHealth = {
  serving: false,
  refusal: { condition: "no-responder", shard: 0, deadlineMs: 3_000, detail: "no answer within the deadline" },
};
const refused: DeliveryHealth = {
  serving: false,
  refusal: { condition: "refused", read: "delivery lease shard 0", detail: "not permitted" },
};
const noLease: DeliveryHealth = {
  serving: false,
  refusal: { condition: "no-lease", shard: 0, detail: "no holder record" },
};

const row = (h: DeliveryHealth): Promise<DeliveryRow> =>
  deliveryRow({ mintCaller: () => Promise.resolve({ check: () => Promise.resolve(h) }), now: () => AT });

console.log("\ndelivery-row — the card's delivery row, constructed\n");

// ---- no-auth: the mint failed. A fact about OUR credentials, not about the daemon.
const na = await deliveryRow({ mintCaller: () => Promise.resolve(undefined), now: () => AT });
check("no-auth: a failed mint does NOT probe and does NOT claim anything about the daemon", na.kind === "no-auth");
check("no-auth: it says so explicitly — 'this surface was never able to ask'",
  na.kind === "no-auth" && /never able to ask/.test(na.detail));
check("no-auth: and it does NOT render a tick", na.marker !== "✓");

// ---- the four assessed states.
const rServing = await row(serving);
const rNoResp = await row(noResponder);
const rRefused = await row(refused);
const rNoLease = await row(noLease);

check("serving: an affirmative round-trip inside a current observation renders ✓", rServing.marker === "✓");
check("serving: and the row carries the health that entitled it",
  rServing.kind === "assessed" && rServing.health.serving === true);
check("no-responder: renders ? and NOT ✓ — the incident's own signature never gets a tick", rNoResp.marker === "?");
check("refused: a DENIED read renders ? and is NOT collapsed into an absence", rRefused.marker === "?");
check("refused: the row preserves the condition by name, so a consumer can tell it from no-responder",
  rRefused.kind === "assessed" && !rRefused.health.serving && rRefused.health.refusal.condition === "refused");
check("no-responder keeps ITS name too — the two refusals are distinguishable at the row",
  rNoResp.kind === "assessed" && !rNoResp.health.serving && rNoResp.health.refusal.condition === "no-responder");
check("no-lease: renders ?", rNoLease.marker === "?");

// ---- THE PROPERTY: ✓ is reachable ONLY from an affirmative round-trip.
const all: DeliveryRow[] = [na, rServing, rNoResp, rRefused, rNoLease];
check("the state set is NON-EMPTY, so the .every assertions below are not vacuous", all.length === 5);
check("EVERY row that renders ✓ is one whose health is serving:true — no other path earns a tick",
  all.filter((r) => r.marker === "✓").every((r) => r.kind === "assessed" && r.health.serving === true));
check("and at least one row DOES render ✓ — otherwise the property above holds vacuously",
  all.some((r) => r.marker === "✓"));
check("every NON-serving state renders ?, none of them dim or blank",
  all.filter((r) => !(r.kind === "assessed" && r.health.serving)).every((r) => r.marker === "?"));
check("no rendering contains a bare 'unknown'",
  all.every((r) => !/\bunknown\b/i.test(renderDeliveryRow(r))));
check("every rendering is non-empty", all.every((r) => renderDeliveryRow(r).length > 0));

// ---- staleness reaches the row: an observation older than the card's bound loses its tick.
// Injected by advancing `now` between the observation and the report.
let calls = 0;
const stale = await deliveryRow({
  mintCaller: () => Promise.resolve({ check: () => Promise.resolve(serving) }),
  now: () => (++calls === 1 ? AT : AT + 60_000),
});
check("a SERVING observation older than the card's freshness bound LOSES its ✓", stale.marker === "?");
check("and the row says the reading is not current rather than hiding it",
  stale.kind === "assessed" && /NOT current/.test(stale.text));

console.log(
  fail === 0
    ? `\nDELIVERY-ROW SMOKE OK ✅  (${pass} passed, ${fail} failed)\n`
    : `\nDELIVERY-ROW SMOKE FAILED ❌  (${pass} passed, ${fail} failed)\n`,
);
if (fail > 0) process.exitCode = 1;
if (pass === 0) {
  console.error("NOTHING WAS MEASURED — 0 cells executed. Reporting this as a decline, not a pass.");
  process.exitCode = 3;
}
