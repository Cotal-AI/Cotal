/**
 * The ready card's delivery row, driven directly.
 *
 * THE LOAD-BEARING ASSERTION is `marker`. It is the one output a reader takes at a glance, and `✓`
 * is the only glyph that says "delivery is working". It is asserted as a PROPERTY over every state
 * below, not case-by-case, so a state added later cannot quietly acquire a tick — the same discipline
 * `manager-claim.smoke.ts` applies to `startHint` for the same reason.
 *
 * What is NOT covered here: whether any real credential profile can perform the read and the
 * round-trip. That is an open measurement, recorded outside this repo, and the row takes its
 * caller mint as a required parameter precisely so this suite cannot silently assume one.
 *
 * Run: pnpm exec tsx bin/smoke/delivery-row.smoke.ts
 */
import { deliveryRow, deliveryRowText, renderDeliveryRow, type DeliveryRow } from "../../implementations/cli/src/lib/delivery-row.js";
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

// ---- no-caller: the mint failed. A fact about US, not about the daemon — and WHICH fact matters.
const na = await deliveryRow({
  mintCaller: () => Promise.resolve({ condition: "no-credential" as const, detail: "no caller credential could be built" }),
  now: () => AT,
});
check("no-caller: a failed mint does NOT probe and does NOT claim anything about the daemon", na.kind === "no-caller");
check("no-caller: it says so explicitly — 'this surface was never able to ask'",
  na.kind === "no-caller" && /never able to ask/.test(na.detail));
check("no-caller: and it does NOT render a tick", na.marker !== "✓");

// The two no-caller conditions are DIFFERENT FACTS and must not share a message. An unreachable
// broker once rendered as "no caller credential could be built" — a claim about credentials for a
// failure about reachability, which is this surface's own defect class committed by this surface.
const unreach = await deliveryRow({
  mintCaller: () => Promise.resolve({ condition: "unreachable" as const, detail: "the broker at nats://127.0.0.1:1 could not be reached" }),
  now: () => AT,
});
check("no-caller: an unreachable broker is condition `unreachable`, not `no-credential`",
  unreach.kind === "no-caller" && unreach.condition === "unreachable");
check("no-caller: and its text names the BROKER without mentioning a credential",
  unreach.kind === "no-caller" && /could not be reached/.test(unreach.detail) && !/credential/i.test(unreach.detail));
check("no-caller: the two conditions do NOT render the same text — the distinction survives to the operator",
  na.kind === "no-caller" && unreach.kind === "no-caller" && na.detail !== unreach.detail);

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

// ---- THE CARD SEAM: the marker and the text must be separable WITHOUT slicing a rendered line.
// The card renders the marker in its own column, so it needs the text alone. Taking it by
// `renderDeliveryRow(row).slice(2)` encodes the render format in a second place and silently eats
// the first characters of the message the moment a marker is not one unit wide — and on this
// surface the message IS the refusal, so losing its head is the worst available failure.
check("every row composes as marker + ' ' + text, so the two have ONE definition between them",
  all.every((r) => renderDeliveryRow(r) === `${r.marker} ${deliveryRowText(r)}`));
check("the text alone NEVER begins with a marker — the card would print it twice",
  all.every((r) => !/^[✓?!○·]/.test(deliveryRowText(r))));
// The naive implementation this replaced. Asserted as a NEGATIVE so the cell fails if someone
// reintroduces the slice: for a multi-unit marker the two disagree, and that disagreement is the
// defect. A positive control on the same data proves the comparison can distinguish at all.
const widened = all.map((r) => ({ ...r, marker: "??" }) as typeof r);
check("POSITIVE CONTROL: with a 2-unit marker, slice(2) and deliveryRowText DISAGREE — the comparison discriminates",
  widened.some((r) => renderDeliveryRow(r).slice(2) !== deliveryRowText(r)));
check("and with the real 1-unit markers the two agree, so this suite is not asserting a permanent inequality",
  all.every((r) => renderDeliveryRow(r).slice(2) === deliveryRowText(r)));

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
