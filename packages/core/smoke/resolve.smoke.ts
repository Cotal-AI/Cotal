/**
 * Pure-function smoke for peer name resolution + validation (no NATS) — run with: pnpm -r test
 * Asserts the deterministic, fail-loud rules in src/resolve.ts.
 */
import assert from "node:assert/strict";
import { resolvePeer, sharedNameIds, AmbiguousPeerError, assertValidName } from "../src/resolve.js";
import type { Presence, PresenceStatus } from "../src/types.js";

let seq = 0;
function p(name: string, status: PresenceStatus = "idle", id = `id-${++seq}`): Presence {
  return { card: { id, name, kind: "agent" }, status, ts: 0 };
}
function expectAmbiguous(fn: () => unknown, count: number): void {
  assert.throws(fn, (e: unknown) => e instanceof AmbiguousPeerError && e.candidates.length === count);
}

// exact id beats a same-name peer
{
  const a = p("bob", "idle", "ID1");
  const b = p("bob", "idle", "ID2");
  assert.equal(resolvePeer([a, b], "ID2")?.card.id, "ID2");
}

// unique live name resolves (case-insensitively)
{
  const a = p("Alice");
  assert.equal(resolvePeer([a, p("bob")], "alice")?.card.id, a.card.id);
}

// 2 live same-name → throws with both candidates
expectAmbiguous(() => resolvePeer([p("bob"), p("bob")], "bob"), 2);

// 1 live + 1 stale offline → resolves the live one (reconnect grace)
{
  const live = p("bob", "working", "LIVE");
  const ghost = p("bob", "offline", "GHOST");
  assert.equal(resolvePeer([ghost, live], "bob")?.card.id, "LIVE");
}

// unique offline → resolves (best-effort convenience)
assert.equal(resolvePeer([p("bob", "offline", "OFF")], "bob")?.card.id, "OFF");

// 2 offline same-name → throws (stale ghosts don't mask a real ambiguity)
expectAmbiguous(() => resolvePeer([p("bob", "offline"), p("bob", "offline")], "bob"), 2);

// self is excluded; no other match → undefined
assert.equal(resolvePeer([p("me", "idle", "ME")], "me", { selfId: "ME" }), undefined);

// no match → undefined
assert.equal(resolvePeer([p("alice")], "nobody"), undefined);

// sharedNameIds uses resolvePeer's comparison: trimmed, then case-insensitive, every row.
{
  const a = p("Bob", "idle", "A");
  const b = p(" bob ", "offline", "B");
  const c = p("solo", "idle", "C");
  const shared = sharedNameIds([a, b, c]);
  assert.deepEqual([...shared].sort(), ["A", "B"]);
  assert.equal(sharedNameIds([c]).size, 0);
  assert.equal(sharedNameIds([]).size, 0);
}

// name validation: accept human display names + roster names; reject reserved/edge shapes
assert.doesNotThrow(() => assertValidName("review-general"));
assert.doesNotThrow(() => assertValidName("Ada Lovelace"));
for (const bad of ["", " bob", "bob ", "a/b", "a\nb"]) assert.throws(() => assertValidName(bad));

console.log("resolve.smoke: all assertions passed");
