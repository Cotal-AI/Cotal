/**
 * Pure-function smoke for the roster display surfaces (no NATS, no fs) — run with: pnpm smoke:offline-display
 *
 * Guards the display half of issue #286: presence retains `activity`/`ts` on offline BY DESIGN
 * (`toOffline` keeps them), so an offline row must read as dead — `last seen <relative>` derived
 * from the retained heartbeat ts, and any retained activity qualified as `was: …` — never a bare
 * activity that looks live next to `⨯ offline` (a dead agent's last "retrying: Rate limit
 * exceeded…" used to render exactly like a live one's).
 */
import assert from "node:assert/strict";
import type { Presence } from "@cotal-ai/core";
import { printEndpoints } from "../src/commands/endpoints.js";
import { offlineDetail, relativeTime } from "../src/ui.js";

// ---- relativeTime is pure (injectable clock) ------------------------------------------------
const NOW = 1_700_000_000_000;
assert.equal(relativeTime(NOW - 2_000, NOW), "just now");
assert.equal(relativeTime(NOW - 42_000, NOW), "42s ago");
assert.equal(relativeTime(NOW - 5 * 60_000, NOW), "5m ago");
assert.equal(relativeTime(NOW - 3 * 3_600_000, NOW), "3h ago");
assert.equal(relativeTime(NOW - 49 * 3_600_000, NOW), "2d ago");
assert.equal(relativeTime(NOW + 60_000, NOW), "just now"); // clock skew must never render negative
assert.equal(relativeTime(Number.NaN, NOW), "unknown"); // a malformed ts must not render "NaNd ago"
assert.equal(relativeTime(0, NOW), "unknown"); // …nor an epoch-zero ts as ~19700d ago
console.log("  ✓ relativeTime buckets (s/m/h/d, skew-safe, unknown on bad ts)");

// ---- offlineDetail is the ONE offline qualifier every surface shares -------------------------
assert.equal(
  offlineDetail({ ts: Date.now() - 5 * 60_000, activity: "retrying: Rate limit exceeded (attempt 5)" }),
  "last seen 5m ago · was: retrying: Rate limit exceeded (attempt 5)",
);
assert.equal(offlineDetail({ ts: Date.now() - 49 * 3_600_000 }), "last seen 2d ago"); // no was: without activity
console.log("  ✓ offlineDetail (last seen + optional was:)");

// ---- printEndpoints: offline rows are qualified, live rows unchanged ------------------------
const presence = (over: Partial<Presence> & { card: Presence["card"] }): Presence => ({
  status: "idle",
  ts: Date.now(),
  ...over,
});
const roster: Presence[] = [
  presence({
    card: { id: "local.busy_beaver", name: "busy-beaver", role: "worker", kind: "agent" },
    status: "working",
    activity: "Bash",
  }),
  presence({
    card: { id: "local.worker_dead", name: "worker-dead", role: "worker", kind: "agent" },
    status: "offline",
    activity: "retrying: Rate limit exceeded (attempt 5)",
    ts: Date.now() - 5 * 60_000,
  }),
  presence({
    card: { id: "local.quiet_ghost", name: "quiet-ghost", kind: "agent" },
    status: "offline",
    ts: Date.now() - 49 * 3_600_000,
  }),
];

const lines: string[] = [];
const orig = console.log;
console.log = (...args: unknown[]) => void lines.push(args.join(" "));
try {
  printEndpoints(roster, "smoketest");
} finally {
  console.log = orig;
}
// eslint-disable-next-line no-control-regex
const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
// The strip must eat the WHOLE escape sequence: a residual ESC byte would sit invisibly inside the
// stripped text and defang the negative assertions below (they would pass even against broken output).
assert.ok(!plain.join("\n").includes("\x1b"), `ANSI strip left a residual ESC byte:\n${JSON.stringify(plain)}`);
const row = (name: string): string => {
  const line = plain.find((l) => l.includes(name));
  assert.ok(line, `no roster row rendered for ${name} — got:\n${plain.join("\n")}`);
  return line;
};

const liveRow = row("busy-beaver");
assert.ok(liveRow.includes("● working") && liveRow.includes("Bash"), `live row unchanged: ${liveRow}`);
assert.ok(!liveRow.includes("was:") && !liveRow.includes("last seen"), `live row must not be qualified: ${liveRow}`);
console.log("  ✓ live rows still render bare activity");

const deadRow = row("worker-dead");
assert.ok(deadRow.includes("⨯ offline"), `offline badge: ${deadRow}`);
assert.ok(deadRow.includes(offlineDetail(roster[1])), `offline row renders the shared offlineDetail qualifier: ${deadRow}`);
assert.ok(deadRow.includes("last seen 5m ago"), `offline row shows last seen from retained ts: ${deadRow}`);
assert.ok(deadRow.includes("was: retrying: Rate limit exceeded (attempt 5)"), `retained activity is qualified with was:: ${deadRow}`);
assert.ok(!/offline\s{2,}retrying:/.test(deadRow), `retained activity must not render bare (looks live): ${deadRow}`);
console.log("  ✓ offline rows read as dead (last seen + was:)");

const ghostRow = row("quiet-ghost");
assert.ok(ghostRow.includes("last seen 2d ago"), `offline row without activity still shows last seen: ${ghostRow}`);
assert.ok(!ghostRow.includes("was:"), `no was: without retained activity: ${ghostRow}`);
console.log("  ✓ offline rows without retained activity show last seen only");

console.log("\nOFFLINE-DISPLAY TEST PASSED ✅");
