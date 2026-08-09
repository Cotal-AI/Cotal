/**
 * delivery shards-reject smoke. The partition() seam ships at N=1 only; operating sharded delivery is
 * deferred (a hash partition isn't expressible as a NATS sub.allow/durable filter under the flat chat
 * grammar — see core-sub-fabric.md). `cotal deliver --shards >1` (or a non-zero --shard) must THROW
 * loudly at the entrypoint, before connecting or binding anything. No broker needed — the guard is the
 * first thing runDelivery does.
 *
 * Run: pnpm smoke:delivery-shards-reject
 */
import { runDelivery } from "../src/delivery.js";

let pass = 0,
  fail = 0;
/** `runDelivery` takes the PARSED args (`{ values }`), not an argv array. It was called with an
 *  array here, and an array HAS a `.values` — `Array.prototype.values`, the iterator — so `v` was a
 *  function, every option read `undefined`, the shard check saw the defaults `shard=0 shards=1` and
 *  passed, and the run died later on the missing space. The suite then reported "threw the wrong
 *  error" and exited 1 rather than crashing, so it looked like a product defect for as long as
 *  nobody ran it. It pinned nothing. Build the shape the function actually takes. */
const rejects = async (name: string, values: Record<string, string>) => {
  try {
    await runDelivery({ values, positionals: [] } as unknown as Parameters<typeof runDelivery>[0]);
    fail++;
    console.log(`  ✗ FAIL: ${name} — expected a throw, got none`);
  } catch (e) {
    const ok = /shards|N=1|not supported|sharded/i.test((e as Error).message);
    if (ok) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ FAIL: ${name} — threw the wrong error: ${(e as Error).message}`); }
  }
};

// The refusal must beat the SPACE check, which is the next thing runDelivery does — so these pass a
// space deliberately: a rejection that only happened because the space was missing would prove
// nothing about sharding, and that is exactly the hole this suite spent months in.
await rejects("--shards 2 is rejected before binding", { space: "x", shards: "2" });
await rejects("--shard 1 (non-zero) is rejected before binding", { space: "x", shard: "1" });
// And the shard check must come FIRST, not merely somewhere: with NO space at all, a sharded run
// still has to refuse for SHARDING rather than for the missing space.
await rejects("--shards 2 refuses for SHARDING even with no space (the check is first, not just present)", { shards: "2" });

console.log(`\nDELIVERY-SHARDS-REJECT SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
