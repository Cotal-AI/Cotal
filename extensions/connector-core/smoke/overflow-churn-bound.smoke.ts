/**
 * The un-ack reprieve has to end.
 *
 * #793 stopped the overflow valve acking a directed message it evicts, so the broker can redeliver
 * it once there is room instead of destroying it. That turned unrecoverable loss into a delay - but
 * a delay only helps if it terminates. An un-acked id is one JetStream may hand straight back into
 * an inbox that is still full, to be evicted again, forever: throughput spent on a message that
 * never lands, while every seat involved reports healthy (#807).
 *
 * Same defect shape as #790, where `drive()` retries a failed turn with no backoff and no cap. This
 * suite exists because I shipped that shape one layer up after filing it against someone else.
 *
 * The rule: count evictions per id, and after OVERFLOW_REDELIVERY_LIMIT give up and ack, recording
 * the loss loudly. A message lost with a log line beats a mesh that quietly stops moving.
 */
import assert from "node:assert/strict";
import { MeshAgent } from "../src/agent.js";
import type { InboxItem } from "../src/types.js";

let pass = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    return;
  }
  const detail = `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`;
  failures.push(detail);
  console.log(`  ✗ ${detail}`);
};

const MAX_INBOX = 200;
const LIMIT = 5; // OVERFLOW_REDELIVERY_LIMIT

interface H {
  agent: MeshAgent;
  acked: Set<string>;
  errors: string[];
  push: (id: string, kind?: string) => void;
  has: (id: string) => boolean;
}

function harness(): H {
  const agent = new MeshAgent({ name: "victim", space: "main", connector: "test" } as never);
  const acked = new Set<string>();
  const errors: string[] = [];
  // The give-up notice goes to stderr, not to an "error" event. That is deliberate: an EventEmitter
  // with no listener turns emit("error") into an unhandled exception, so announcing a dropped
  // message would kill the very seat that was surviving the flood. Capture the stream instead.
  const realWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: (c: string) => boolean }).write = (chunk: string) => {
    if (typeof chunk === "string" && chunk.includes("overflow: dropping directed message")) errors.push(chunk);
    return realWrite(chunk as never);
  };
  const push = (id: string, kind = "dm"): void => {
    const item = {
      id,
      kind,
      channel: kind === "channel" ? "team" : "",
      from: "peer",
      text: `${id}: body`,
      mentionsMe: false,
      historical: false,
    } as InboxItem;
    (agent as unknown as { buffer: (i: InboxItem, a: () => void, p: boolean) => void }).buffer(
      item,
      () => acked.add(id),
      false,
    );
  };
  const has = (id: string): boolean =>
    (agent as unknown as { inbox: { item: InboxItem }[] }).inbox.some((p) => p.item.id === id);
  return { agent, acked, errors, push, has };
}

/** Fill to capacity with throwaway DMs, then redeliver `id` and let it be evicted again. */
function cycle(h: H, id: string, times: number): void {
  for (let n = 0; n < times; n++) {
    h.push(id); // the redelivery
    // one more arrival evicts the oldest, which is the redelivered id once it is at the head
    while (h.has(id)) h.push(`filler-${n}-${Math.random().toString(36).slice(2, 8)}`);
  }
}

console.log("\n1. the reprieve still applies while it is plausible");
{
  const h = harness();
  for (let i = 0; i < MAX_INBOX; i++) h.push(`fill-${i}`);
  const victim = "dm-victim";
  h.push(victim);
  // Evict it a couple of times: well under the cap, so it must stay recoverable.
  cycle(h, victim, 2);
  check("a directed message evicted twice is NOT acked (redelivery can still help)", !h.acked.has(victim));
  check("no give-up error was emitted that early", !h.errors.some((e) => e.includes(victim)), h.errors);
}

console.log("\n2. the reprieve ENDS: a message that never lands is finally acked");
{
  const h = harness();
  for (let i = 0; i < MAX_INBOX; i++) h.push(`fill-${i}`);
  const victim = "dm-doomed";
  h.push(victim);
  cycle(h, victim, LIMIT + 1);
  check("after the limit the churning message IS acked (the cycle stops)", h.acked.has(victim));
  check(
    "and the loss is reported, not silent",
    h.errors.some((e) => e.includes(victim) && /evictions/.test(e)),
    h.errors.slice(0, 2),
  );
  check(
    "the report does NOT ride an error event (that would crash a seat with no listener)",
    h.agent.listenerCount("error") === 0,
  );
}

console.log("\n3. landing the message clears its history");
{
  const h = harness();
  for (let i = 0; i < MAX_INBOX; i++) h.push(`fill-${i}`);
  const victim = "dm-survivor";
  cycle(h, victim, LIMIT - 1); // four evictions: close to the cap, not over
  const tally = (): number | undefined =>
    (h.agent as unknown as { overflowEvictions: Map<string, number> }).overflowEvictions.get(victim);
  check("evictions accumulate toward the cap", tally() === LIMIT - 1, { tally: tally() });

  h.push(victim);
  (h.agent as unknown as { drainInboxIds: (ids: string[]) => unknown }).drainInboxIds([victim]);
  // Assert the TALLY, not the ack set. `drainInboxIds` acks a handled message by design, so
  // "was it acked" cannot distinguish a successful delivery from a give-up - an earlier version of
  // this cell made exactly that mistake and failed against correct code.
  check("handling the message clears its eviction history", tally() === undefined, { tally: tally() });

  cycle(h, victim, 2);
  check("and it starts counting from zero again, not from the old total", tally() === 2, { tally: tally() });
}

console.log("\n4. #793's guarantee is intact: channel volume still cannot silence a DM");
{
  const h = harness();
  h.push("dm-protected");
  for (let i = 0; i < 400; i++) h.push(`chan-${i}`, "channel");
  check("the DM survives a channel flood", h.has("dm-protected"));
  check("the DM was not acked", !h.acked.has("dm-protected"));
  check("evicted channel ambient IS still acked", h.acked.size > 0);
}

console.log("\n5. the bookkeeping cannot become its own leak");
{
  const h = harness();
  for (let i = 0; i < MAX_INBOX; i++) h.push(`fill-${i}`);
  // Thousands of distinct one-shot evictions: the tally map must stay bounded.
  for (let i = 0; i < 2000; i++) h.push(`churn-${i}`);
  const size = (h.agent as unknown as { overflowEvictions: Map<string, number> }).overflowEvictions.size;
  check("the eviction tally stays bounded under a flood of distinct ids", size <= 4 * MAX_INBOX, { size });
}

console.log(`\noverflow churn bound: ${pass} cells OK, ${failures.length} failed`);
if (failures.length) {
  assert.fail(`overflow churn bound: ${failures.length} cell(s) failed\n  - ${failures.join("\n  - ")}`);
}
