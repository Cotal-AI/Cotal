import assert from "node:assert/strict";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { epRequestSubject, type EpCaller } from "@cotal-ai/core";
import { RunCancelObservations } from "../src/run-cancel-observation.js";

let now = 100;
let pass = 0;
const check = (name: string, value: unknown): void => { assert.ok(value, name); pass++; console.log(`  ok ${name}`); };
const space = "cancel-observation";
const instanceId = "i".repeat(26);
const runId = `run-${"a".repeat(32)}`;
const caller = (owner = "local", actor = "a", generation = "1".repeat(32)): EpCaller => ({ owner, actor, uid: "u".repeat(26), generation }) as EpCaller;
const subject = (nonce: string, who = caller()) => epRequestSubject(space, { endpoint: "manager", command: "run-cancel", caller: who,
  route: { mode: "inst", instanceId }, nonce });
const bytes = (overrides: Record<string, unknown> = {}) => new TextEncoder().encode(JSON.stringify({
  v: 1, id: "same-envelope", op: { endpoint: "manager", command: "run-cancel", inputDigest: `sha256:${"1".repeat(64)}`, outputDigest: `sha256:${"2".repeat(64)}` },
  class: "ephemeral", replyExpected: true, deadlineMs: 1_000, bind: { instanceId, epoch: 1 },
  from: { id: "local.a", name: "a" }, args: { runId, reason: "stop" }, ...overrides,
}));
const table = new RunCancelObservations(space, { caller: 2, owner: 4, total: 6 }, () => now);
const a = subject("a".repeat(24));
table.observe(a, bytes());
check("first body is observed", table.inspect(a).reason === "stop");
now = 500;
table.observe(a, bytes());
check("equal redelivery does not extend original deadline", table.inspect(a).requestEndsAt === 1_100);
const claim = table.claim(a);
check("claim excludes another commit", table.refusal(a).kind === "outcome-unknown");
assert.throws(() => table.claim(a));
check("claimed subject cannot be inspected as authority", (() => { try { table.inspect(a); return false; } catch { return true; } })());
table.observe(a, bytes({ args: { runId, reason: "changed" } }));
check("changed body poisons a live claim", (() => { try { claim.dispatch(); return false; } catch { return true; } })());
claim.finish();
check("poison before dispatch is definite only after claim ends", table.refusal(a).kind === "refused-before-dispatch");
table.observe(a, bytes());
check("original redelivery does not resurrect conflict", (() => { try { table.inspect(a); return false; } catch { return true; } })());

const b = subject("b".repeat(24));
table.observe(b, bytes());
const bClaim = table.claim(b);
bClaim.dispatch();
bClaim.finish();
check("possible dispatch is sticky after consumption", table.refusal(b).kind === "outcome-unknown");
table.observe(b, bytes({ id: "different-envelope" }));
check("changed envelope id cannot clear possible dispatch", table.refusal(b).kind === "outcome-unknown");
const c = subject("c".repeat(24), caller("local", "a", "2".repeat(32)));
table.observe(c, bytes());
check("generation change does not escape caller quota", table.refusal(c).code === "resource-exhausted");

const sibling = subject("d".repeat(24), caller("local", "b"));
table.observe(sibling, bytes({ from: { id: "local.b", name: "b" } }));
check("same-owner sibling has its own remaining quota", table.inspect(sibling).id === "same-envelope");
const sibling2 = subject("e".repeat(24), caller("local", "b"));
table.observe(sibling2, bytes({ from: { id: "local.b", name: "b" } }));
const ownerFull = subject("f".repeat(24), caller("local", "c"));
table.observe(ownerFull, bytes({ from: { id: "local.c", name: "c" } }));
check("different caller cannot escape exhausted owner quota", table.refusal(ownerFull).code === "resource-exhausted");
const other = subject("g".repeat(24), caller("other", "a"));
table.observe(other, bytes({ from: { id: "other.a", name: "a" } }));
check("another owner still has allowance", table.inspect(other).runId === runId);
const other2 = subject("h".repeat(24), caller("other", "b"));
table.observe(other2, bytes({ from: { id: "other.b", name: "b" } }));
const globalFull = subject("j".repeat(24), caller("third", "a"));
table.observe(globalFull, bytes({ from: { id: "third.a", name: "a" } }));
check("aggregate lifetime exhaustion refuses new owners without eviction", table.refusal(globalFull).code === "resource-exhausted");

const expiry = new RunCancelObservations(space, undefined, () => now);
expiry.observe(a, bytes());
const late = expiry.claim(a);
now += 1_001;
check("deadline guard refuses dispatch after awaited preparation", (() => { try { late.dispatch(); return false; } catch { return true; } })());
late.finish();
check("expired no-dispatch claim reports deadline", expiry.refusal(a).kind === "refused-before-dispatch" && expiry.refusal(a).code === "deadline-exceeded");
expiry.observe(a, bytes());
check("expired original subject never becomes available again", (() => { try { expiry.inspect(a); return false; } catch { return true; } })());
const invalid = subject("k".repeat(24));
expiry.observe(invalid, bytes({ args: { runId, reason: "\ud800" } }));
check("unpaired surrogate gives no observed authority", expiry.refusal(invalid).code === "permission-denied");
assert.throws(() => new RunCancelObservations(space, { caller: 3, owner: 2, total: 4 }));
check("invalid quota ordering refuses construction", true);
emitSentinel({ passed: pass, failed: 0 });
