/**
 * A peer flooding a channel must not be able to silence directed mail.
 *
 * The overflow valve sacrifices `pullOnly` entries first, and `pullOnly` is
 * `!mentionsMe && historical`. `mentionsMe` comes from the payload `mentions` field, which the code
 * itself calls forgeable. A hostile peer stamping the victim's name on every flooded message made
 * none of its traffic pull-only, so `findIndex` returned -1 and eviction fell through to index 0 -
 * the OLDEST entry, i.e. the DM that had been waiting longest. It was spliced out and `ack()`ed
 * without being marked handled, so JetStream never redelivered it: silent, unrecoverable loss (#791).
 *
 * Plain ambient channel traffic at volume did the same thing with no forgery at all.
 *
 * This suite crosses the real valve. The suite shipped with #776 buffered 120 items against a
 * MAX_INBOX of 200, so it never reached the overflow path it was meant to cover.
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

interface Harness {
  agent: MeshAgent;
  acked: Set<string>;
  push: (item: Partial<InboxItem> & { id: string }, opts?: { pullOnly?: boolean }) => void;
  ids: () => string[];
}

function harness(): Harness {
  const agent = new MeshAgent({ name: "victim", space: "main", connector: "test" } as never);
  const acked = new Set<string>();
  const push: Harness["push"] = (partial, opts) => {
    const item = {
      kind: "channel",
      channel: "team.noise",
      from: "flooder",
      text: "x",
      mentionsMe: false,
      historical: false,
      ...partial,
    } as InboxItem;
    // Reach the private valve directly: this suite grades eviction, not ingest classification.
    (agent as unknown as { buffer: (i: InboxItem, a: () => void, p: boolean) => void }).buffer(
      item,
      () => acked.add(item.id),
      opts?.pullOnly ?? (!item.mentionsMe && item.historical),
    );
  };
  const ids = () =>
    (agent as unknown as { inbox: { item: InboxItem }[] }).inbox.map((p) => p.item.id);
  return { agent, acked, push, ids };
}

console.log("\n1. the attack: a forged-mention flood must not evict a waiting DM");
{
  const h = harness();
  h.push({ id: "dm-1", kind: "dm", channel: "", from: "colleague", text: "the answer is 4" });
  // Every flooded message claims to mention the victim, so none of it is pullOnly.
  for (let i = 0; i < 400; i++) h.push({ id: `flood-${i}`, mentionsMe: true, historical: true });

  check("the inbox stayed bounded", h.ids().length <= MAX_INBOX, h.ids().length);
  check("the waiting DM is STILL PRESENT after the flood", h.ids().includes("dm-1"));
  check("the waiting DM was never acked (redelivery stays possible)", !h.acked.has("dm-1"));
}

console.log("\n2. the no-forgery case: plain live ambient channel traffic at volume");
{
  const h = harness();
  h.push({ id: "dm-2", kind: "dm", channel: "", from: "colleague", text: "ping" });
  for (let i = 0; i < 400; i++) h.push({ id: `ambient-${i}` });

  check("the DM survives ordinary ambient volume", h.ids().includes("dm-2"));
  check("the DM was not acked", !h.acked.has("dm-2"));
}

console.log("\n3. anycast is directed too and gets the same protection");
{
  const h = harness();
  h.push({ id: "any-1", kind: "anycast", channel: "", from: "dispatcher", text: "claim me" });
  for (let i = 0; i < 300; i++) h.push({ id: `f-${i}`, mentionsMe: true, historical: true });

  check("an anycast task survives a mention-forged flood", h.ids().includes("any-1"));
  check("the anycast task was not acked", !h.acked.has("any-1"));
}

console.log("\n4. channel ambient is still what gets sacrificed, and is still acked");
{
  const h = harness();
  for (let i = 0; i < 260; i++) h.push({ id: `c-${i}` });

  check("the inbox is capped", h.ids().length === MAX_INBOX, h.ids().length);
  check("evicted channel traffic WAS acked (replaying it is the history flood)", h.acked.size === 60, h.acked.size);
  check("the oldest channel items are the ones dropped", !h.ids().includes("c-0"));
}

console.log("\n5. pull-only backlog is still sacrificed before anything else");
{
  const h = harness();
  h.push({ id: "keep-live", text: "live ambient" });
  for (let i = 0; i < 250; i++) h.push({ id: `hist-${i}`, historical: true });

  check("a live channel item outlives historical backlog", h.ids().includes("keep-live"));
  check("historical backlog absorbed the eviction", h.acked.size > 0);
}

console.log("\n6. an all-directed inbox still bounds memory (no attacker advantage)");
{
  const h = harness();
  for (let i = 0; i < 260; i++) h.push({ id: `dm-${i}`, kind: "dm", channel: "", from: "peer" });

  check("the inbox is still capped when everything is directed", h.ids().length === MAX_INBOX, h.ids().length);
  check(
    "sacrificed DMs are NOT acked, so the broker can redeliver them",
    h.acked.size === 0,
    [...h.acked].slice(0, 3),
  );
}

console.log(`\ninbox overflow directed: ${pass} cells OK, ${failures.length} failed`);
if (failures.length) {
  assert.fail(`inbox overflow directed: ${failures.length} cell(s) failed\n  - ${failures.join("\n  - ")}`);
}
