/**
 * The overflow valve never gives up on a directed message.
 *
 * #793 stopped the overflow valve acking a directed message it evicts, so the broker can redeliver
 * it once there is room instead of destroying it. #807 then counted evictions per id and, after
 * five, acked the message and logged the drop, to stop a full inbox cycling it forever. That cycle
 * is already paced by the broker: an un-acked message comes back only after its durable's ack wait.
 * The give-up was the loss: a live, rostered seat whose turn ran long lost its oldest DMs after the
 * sender saw them stored, with one stderr line as the only trace (#2215).
 *
 * The rule: however often a directed message is evicted, the buffer never acks it. It stays pending
 * on the recipient's durable and lands once a redelivery finds room.
 */
import assert from "node:assert/strict";
import { MeshAgent } from "../src/agent.js";
import type { InboxItem } from "../src/agent.js";

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
const EVICTIONS = 12; // well past the five evictions after which the old valve gave up

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
  // The old valve announced its give-up on stderr. Capture the stream so a returning drop shows here.
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
      // The ingest seam mints recvKey (= the wire id for real ids) before buffer() ever sees an
      // item; fabricating below that seam means carrying the invariant here too.
      recvKey: id,
    } as unknown as InboxItem;
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

console.log("\n1. a directed message evicted again and again is never acked");
{
  const h = harness();
  for (let i = 0; i < MAX_INBOX; i++) h.push(`fill-${i}`);
  const victim = "dm-victim";
  h.push(victim);
  cycle(h, victim, EVICTIONS);
  check("a directed message evicted twelve times is NOT acked (redelivery can still land it)", !h.acked.has(victim));
  check("no drop was reported, because nothing was dropped", !h.errors.some((e) => e.includes(victim)), h.errors.slice(0, 2));
}

console.log("\n2. it lands once there is room");
{
  const h = harness();
  for (let i = 0; i < MAX_INBOX; i++) h.push(`fill-${i}`);
  const victim = "dm-survivor";
  h.push(victim);
  cycle(h, victim, EVICTIONS);
  // The host drains, then the broker's redelivery finds room.
  (h.agent as unknown as { drainInbox: () => unknown }).drainInbox();
  h.push(victim);
  check("the redelivered message is buffered", h.has(victim));
  (h.agent as unknown as { drainInboxDeliveries: (keys: string[]) => unknown }).drainInboxDeliveries([victim]);
  check("and handling it is what acks it", h.acked.has(victim) && !h.has(victim));
}

console.log("\n3. #793's guarantee is intact: channel volume still cannot silence a DM");
{
  const h = harness();
  h.push("dm-protected");
  for (let i = 0; i < 400; i++) h.push(`chan-${i}`, "channel");
  check("the DM survives a channel flood", h.has("dm-protected"));
  check("the DM was not acked", !h.acked.has("dm-protected"));
  check("evicted channel ambient IS still acked", h.acked.size > 0);
}

console.log("\n4. a sustained flood of distinct directed ids acks none of them");
{
  const h = harness();
  for (let i = 0; i < MAX_INBOX; i++) h.push(`fill-${i}`);
  for (let i = 0; i < 2000; i++) h.push(`churn-${i}`);
  check("no evicted directed message was acked", h.acked.size === 0, { acked: h.acked.size });
}

console.log(`\noverflow churn bound: ${pass} cells OK, ${failures.length} failed`);
if (failures.length) {
  assert.fail(`overflow churn bound: ${failures.length} cell(s) failed\n  - ${failures.join("\n  - ")}`);
}
