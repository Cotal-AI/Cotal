/** The presence facts the dashboard shows under a row's status, dated by the same rule as the CLI.
 *  Drives the client's own helpers under Node, against core's canonical formatter. No broker or
 *  pixel claims. Run: pnpm smoke:web-presence-ages. */
import assert from "node:assert/strict";
import { formatAge, presenceAges } from "@cotal-ai/core/presence-ages";
import { ageText } from "../client/src/lib/age.js";
import { presenceFacts as factsOf } from "../client/src/lib/presence.js";

/** The fixtures below are shaped as presence states them, not as the row type spells them. */
const presenceFacts = (p: object, at: number): string => factsOf(p as Parameters<typeof factsOf>[0], at);

const now = 1_800_000_000_000;
let cells = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  assert.deepEqual(actual, expected, name);
  cells++;
}
for (const [ms, text] of [[0, "0s"], [999, "0s"], [1000, "1s"], [44999, "44s"],
  [59999, "59s"], [60000, "1m"], [90000, "1m"], [119999, "1m"], [120000, "2m"],
  [3599999, "59m"], [3600000, "1h"], [7199999, "1h"], [86399999, "23h"],
  [86400000, "1d"], [172799999, "1d"], [172800000, "2d"]] as const) {
  eq(`canonical boundary ${ms}`, ageText(ms), text);
  eq(`browser/core agreement ${ms}`, ageText(ms), formatAge(ms));
}
eq("a negative span reads 0s, as core clamps it", ageText(-1000), formatAge(0));

// The facts: which stamps count, and in which order, agree with core's `presenceAges`.
const full = { activity: "work", condition: { code: "rate_limit", since: now - 5000 }, statusSince: now - 65_000, activitySince: now - 3_600_000, activeAt: now - 90_000 };
const ages = presenceAges(full, now);
eq("every dated fact, in the order condition, status, active, activity",
  presenceFacts(full, now),
  `rate_limit for ${formatAge(ages.conditionSince!)} · unchanged for ${formatAge(ages.statusSince!)} · active ${formatAge(ages.activeAt!)} ago · activity set ${formatAge(ages.activitySince!)} ago`);
eq("the full line reads as the roster prints it", presenceFacts(full, now), "rate_limit for 5s · unchanged for 1m · active 1m ago · activity set 1h ago");
eq("missing presence ages omitted", presenceFacts({}, now), "");
eq("cleared activity does not keep its old age", presenceFacts({ activity: "", activitySince: now - 1000 }, now), "");
eq("core agrees a cleared activity has no age", presenceAges({ activity: "", activitySince: now - 1000 }, now).activitySince, undefined);
eq("condition with unknown stamp stays undated", presenceFacts({ condition: { code: "rate_limit", since: null as unknown as number } }, now), "rate_limit");
for (const stamp of [null, NaN, Infinity, -Infinity, "12"] as unknown[])
  eq(`invalid statusSince ${String(stamp)} is no stamp`, presenceFacts({ statusSince: stamp as number }, now), "");
eq("future facts clamp", presenceFacts({ activity: "work", condition: { code: "rate_limit", since: now + 1 }, statusSince: now + 1, activitySince: now + 1, activeAt: now + 1 }, now),
  "rate_limit for 0s · unchanged for 0s · active 0s ago · activity set 0s ago");
eq("a status alone dates only itself", presenceFacts({ statusSince: now - 120_000 }, now), "unchanged for 2m");

console.log(`presence-ages smoke: ${cells} cells passed`);
