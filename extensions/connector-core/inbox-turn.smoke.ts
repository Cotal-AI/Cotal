/**
 * Smoke test for the InboxTurn ack-on-surface helper (no NATS/LLM needed): drives it against
 * a fake inbox — including the MAX_INBOX front-eviction the real MeshAgent does — and asserts
 * the surface/ack invariants the embed adapters rely on.
 *
 *   pnpm smoke:inbox
 */
import { InboxTurn, type InboxSource } from "./src/inbox-turn.js";
import type { InboxItem } from "./src/agent.js";

function item(id: string, fromId: string, kind: InboxItem["kind"] = "dm"): InboxItem {
  return { id, ts: 0, fromId, fromName: fromId, kind, mentionsMe: false, text: id };
}

/** A fake inbox that mirrors MeshAgent: ingest force-acks + evicts from the front past `cap`,
 *  drainInbox acks by position, ackInbox acks by id (no-op for an absent id). */
class FakeInbox implements InboxSource {
  items: InboxItem[] = [];
  acked: InboxItem[] = [];
  constructor(private cap = Infinity) {}
  ingest(it: InboxItem): void {
    this.items.push(it);
    if (this.items.length > this.cap) {
      for (const ev of this.items.splice(0, this.items.length - this.cap)) this.acked.push(ev);
    }
  }
  peekInbox(): InboxItem[] {
    return [...this.items];
  }
  drainInbox(limit?: number): InboxItem[] {
    const n = limit && limit > 0 ? Math.min(limit, this.items.length) : this.items.length;
    const taken = this.items.splice(0, n);
    this.acked.push(...taken);
    return taken;
  }
  ackInbox(ids: string[]): InboxItem[] {
    const wanted = new Set(ids);
    const taken: InboxItem[] = [];
    this.items = this.items.filter((p) => {
      if (!wanted.has(p.id)) return true;
      this.acked.push(p);
      taken.push(p);
      return false;
    });
    return taken;
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

const ids = (xs: InboxItem[]): string => xs.map((x) => x.id).join(",");
const sameScope = (a: InboxItem, b: InboxItem): boolean =>
  a.fromId === b.fromId && a.kind === b.kind;

// 1) drop leading non-actionable, start on the front, commit acks exactly the origin
{
  const fake = new FakeInbox();
  fake.items = [item("echo", "self"), item("b", "alice")];
  const turn = new InboxTurn(fake);
  turn.drop((i) => i.fromId === "self");
  assert(ids(fake.acked) === "echo", "drop ack-drops the self echo");
  assert(turn.start()?.id === "b", "start surfaces the front actionable");
  assert(turn.count === 1, "surfaced exactly the origin");
  turn.commit();
  assert(ids(fake.acked) === "echo,b", "commit acks the origin");
  assert(fake.items.length === 0 && !turn.inFlight, "inbox drained, turn idle");
}

// 2) extend folds the front-contiguous same-scope run, stops at a different-scope gap
{
  const fake = new FakeInbox();
  fake.items = [item("1", "alice"), item("2", "alice"), item("3", "bob"), item("4", "alice")];
  const turn = new InboxTurn(fake);
  assert(turn.start()?.id === "1", "origin = 1");
  assert(ids(turn.extend(sameScope)) === "2", "folds only contiguous same-scope #2, stops at #3");
  assert(turn.count === 2, "surfaced the 2-message run");
  turn.commit();
  assert(ids(fake.acked) === "1,2", "commit acks exactly the surfaced run [1,2]");
  assert(ids(fake.items) === "3,4", "cross-scope #3 and gapped #4 stay on the stream");
}

// 3) abandon acks nothing — the surfaced run redelivers
{
  const fake = new FakeInbox();
  fake.items = [item("x", "alice")];
  const turn = new InboxTurn(fake);
  turn.start();
  turn.abandon();
  assert(fake.acked.length === 0, "abandon acks nothing");
  assert(ids(fake.items) === "x" && !turn.inFlight, "item stays on the stream; turn idle");
}

// 4) 200+ ambient burst mid-turn: the overflow evicts the in-flight prefix from the front;
//    ack-by-id no-ops the evicted origin, acks the surviving folded peer, and never touches
//    the newer messages that took the prefix's place
{
  const fake = new FakeInbox(200);
  fake.ingest(item("origin", "alice"));
  const turn = new InboxTurn(fake);
  assert(turn.start()?.id === "origin", "origin surfaced");
  fake.ingest(item("peer", "alice"));
  assert(ids(turn.extend(sameScope)) === "peer", "folds the same-scope peer");
  for (let i = 0; i < 199; i++) fake.ingest(item(`amb${i}`, "bob", "channel")); // 201 → evict 1
  assert(
    fake.acked.some((x) => x.id === "origin") && fake.items.some((x) => x.id === "peer"),
    "overflow evicted+acked the origin; the folded peer survived",
  );
  const before = fake.acked.length;
  turn.commit(); // ackInbox(["origin","peer"])
  assert(fake.acked.length === before + 1, "commit acks only the survivor — evicted origin no-ops");
  assert(!fake.items.some((x) => x.id === "peer"), "the survivor was acked by id");
  assert(
    fake.items.length === 199 && fake.items.every((x) => x.id.startsWith("amb")),
    "all 199 newer ambient messages left untouched — none mis-acked",
  );
}

console.log("INBOX-TURN SMOKE OK ✅");
