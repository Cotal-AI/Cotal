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

// a shared name marks every live id that carries it, and not a unique one
{
  const a = p("bob", "idle", "A");
  const b = p("Bob", "working", "B");
  const c = p("cara", "idle", "C");
  assert.deepEqual([...sharedNameIds([a, b, c])].sort(), ["A", "B"]);
}

// the caller's own id is left out of the comparison
{
  const me = p("twin", "idle", "ME");
  const other = p("twin", "idle", "OTHER");
  assert.deepEqual([...sharedNameIds([me, other], { selfId: "ME" })], []);
  assert.equal(sharedNameIds([me], { selfId: "ME" }).size, 0);
}

// a lone offline ghost beside one live peer is not marked; two live peers are
{
  const ghost = p("bob", "offline", "GHOST");
  const live = p("bob", "idle", "LIVE");
  const also = p("bob", "working", "ALSO");
  assert.equal(sharedNameIds([ghost, live]).size, 0);
  assert.deepEqual([...sharedNameIds([ghost, live, also])].sort(), ["ALSO", "LIVE"]);
}

// two offline copies of one name are still shared; one offline copy is not
{
  const a = p("bob", "offline", "A");
  const b = p("bob", "offline", "B");
  assert.deepEqual([...sharedNameIds([a, b])].sort(), ["A", "B"]);
  assert.equal(sharedNameIds([a]).size, 0);
}

// name validation: accept human display names + roster names; reject reserved/edge shapes
assert.doesNotThrow(() => assertValidName("review-general"));
assert.doesNotThrow(() => assertValidName("Ada Lovelace"));
for (const bad of ["", " bob", "bob ", "a/b", "a\nb"]) assert.throws(() => assertValidName(bad));

{
  const error = new AmbiguousPeerError("x", [
    { id: "local.a", name: "\n", status: "idle", ts: 0 },
    { id: "local.b", name: " ", status: "idle", ts: 0 },
  ]);
  assert.equal(error.message.includes("\n"), false);
  assert.equal(error.message.includes("local.a"), true);
  assert.equal(error.message.includes("local.b"), true);
  assert.equal(new AmbiguousPeerError("bob", [{ id: "ID1", name: "bob", status: "idle", ts: 0 }, { id: "ID2", name: "bob", status: "idle", ts: 0 }]).message.includes("bob (ID1, idle)"), true);
}

console.log("resolve.smoke: all assertions passed");
