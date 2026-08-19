/**
 * AN EMPTY MESSAGE ID IS NEVER A DEDUP KEY (Cotal #624).
 *
 * THE DEFECT: MeshAgent.ingest coalesces by message id on three read sites (already-handled,
 * protected disposition, still-pending). An id of "" satisfies every one of them as a key, so two
 * DISTINCT messages that each carry an empty id read as duplicates of each other: the first is
 * buffered, the second is silently dropped, and once the first is drained the id lands in
 * handledIds and every later empty-id message is dropped on arrival. Silent message loss, measured
 * live on a broker below.
 *
 * WHY A RAW PUBLISHER: the first-party publish APIs mint a fresh id per message, so an empty id can
 * only arrive from a foreign client on the wire. The receiver side is where the collapse lives, so
 * the repro publishes real bytes on the real chat subject with a conformant payload (from.id equals
 * the subject sender) and lets the real endpoint subscription and the real ingest deliver them.
 *
 * THE CHOICE THIS FIX MAKES, so a later reader can check it rather than trust it: an empty id is
 * treated as NO id (never a dedup key, in either direction), not as a refusal at ingest. Refusing
 * would trade the loss for a different one, since the bars of this fix are that two distinct
 * empty-id messages must BOTH be delivered. The cost is stated, not hidden: with no id there is no
 * coalescing either, so a redelivered copy of an empty-id message can surface twice. That is the
 * wire contract's at-least-once stance (conforming delivery on this seam), and it is the same stance every
 * conformant message already has on the transport below this layer.
 *
 * THE SEAM MECHANISM: a per-delivery opaque RECEIVE key, assigned where a
 * wire message becomes an inbox item. It is the wire id when there is one and a minted key when
 * the id is empty, and the exact-id drains plus in-flight protection select by it. Without it an
 * id-less delivery could never be individually drained or acked: it would be re-shown on every
 * inbox read and redelivered forever on the durable path. It is never dedup authority - nothing
 * coalesces on it - so a redelivered copy of an id-less message mints its own key and surfaces
 * again, which is the same disclosed at-least-once cost, not a new one.
 *
 * WHAT WOULD MAKE THIS THE WRONG EXPERIMENT:
 *
 *   - If the cells only counted inbox entries, a fix that double-buffered one message would pass.
 *     Every count cell is paired with a content cell: the drained texts are asserted by value.
 *   - If no cell exercised the post-drain path, a fix that only guarded the pending lookup would
 *     pass while handledIds kept collapsing every empty-id message after the first drain. Cell 2
 *     drains FIRST, then publishes a third empty-id message and asserts it arrives.
 *   - If no cell exercised real ids, a fix that disabled id dedup entirely would pass. Cells 3 and
 *     4 hold the other side: the same real id twice still collapses to one entry, and two distinct
 *     real ids are both delivered.
 *
 * Run: pnpm smoke:empty-id-ingest   (spins its own nats-server)
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { chatSubject, isReachable, mintLifecycleUid, seedChannelRegistry } from "@cotal-ai/core";
import { MeshAgent, afterRecallMark } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import type { InboxItem } from "../src/agent.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "emptyidsmoke";
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
/** Poll until pred holds, or fail with what the inbox actually held (the observation, not just "red"). */
const waitFor = async (pred: () => boolean, what: string, ms = 6000): Promise<void> => {
  for (let i = 0; i < ms / 100; i++) {
    if (pred()) return;
    await sleep(100);
  }
  const observed = {
    inbox: agent.inboxCount(),
    bufferedTexts: (agent as unknown as { inbox: { item: InboxItem }[] }).inbox.map((p) => p.item.text),
    incomingFired: incoming.length,
  };
  assert.ok(pred(), `timed out waiting for ${what}: observed ${JSON.stringify(observed)}`);
};

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? `: ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const cfg: AgentConfig = {
  space,
  name: "Otto",
  role: "generalist",
  servers,
  subscribe: ["ch"],
  allowSubscribe: ["ch"],
  allowPublish: ["ch"],
  kind: "agent",
  tls: false,
  id: "otto_agent",
  lifecycleUid: mintLifecycleUid(),
};

const agent = new MeshAgent(cfg);
agent.on("error", () => {});
const incoming: InboxItem[] = [];
agent.on("incoming", (i: InboxItem) => incoming.push(i));

// The foreign publisher: a raw client with no Cotal layer, exactly the shape an empty id can only
// come from. Its principal rides the subject (local.rawpub), and from.id matches it, so the
// receiver's authenticity guard passes and the message reaches ingest like any conformant one.
const PUB_OWNER = "local", PUB_ACTOR = "rawpub";
const subject = chatSubject(space, PUB_OWNER, PUB_ACTOR, "ch");
const rawMsg = (id: string, text: string) =>
  JSON.stringify({
    id,
    ts: Date.now(),
    space,
    from: { id: `${PUB_OWNER}.${PUB_ACTOR}`, name: "RawPub", kind: "agent" },
    channel: "ch",
    parts: [{ kind: "text", text }],
  });
const meta: MessageMeta = { historical: false, kind: "channel" };
/** A conformant-shaped message for the ep.emit-driven durable cells (the cross-path-dedup house
 *  pattern): the race needs counting acks, which only a durable Delivery exposes. */
const msg = (id: string, text: string): CotalMessage => ({
  id,
  ts: Date.now(),
  space,
  from: { id: `${PUB_OWNER}.${PUB_ACTOR}`, name: "RawPub", kind: "agent" },
  channel: "ch",
  parts: [{ kind: "text", text }],
});

/** A buffered id-less delivery shaped like toInboxItem produces (minted receive key). */
const emptyDelivery = (text: string, pullOnlyIgnored = false): InboxItem => ({
  id: "", recvKey: `rx${++deliverySeq}`, ts: Date.now(), fromId: "peer", fromName: "Peer",
  kind: "channel", channel: "ch", mentionsMe: false, historical: false, text,
});
let deliverySeq = 0;

// The raw connection and the agent are closed in the FINALLY, not on the success path: a red run
// throws at its first assertion, and an open socket or an unstopped endpoint each keep the process
// alive long after the FAILED line, which hangs whatever invoked the suite.
let nc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) break; await sleep(200); }
  await seedChannelRegistry({ servers, space, file: { defaults: { replay: false }, channels: {} } });

  agent.start();
  for (let i = 0; i < 50; i++) { if (agent.connected) break; await sleep(200); }
  check("agent connected", agent.connected === true);
  await sleep(300);

  nc = await connect({ servers, maxReconnectAttempts: 0 });
  const publish = async (id: string, text: string) => {
    nc.publish(subject, enc.encode(rawMsg(id, text)));
    await nc.flush();
  };
  const drainedTexts = (): string[] => agent.drainInbox().map((i) => i.text);

  // ---- Cell 1: THE REPRO: two distinct messages, each with an EMPTY id ----
  await publish("", "empty-a");
  await publish("", "empty-b");
  await waitFor(() => agent.inboxCount() === 2, "both empty-id messages to buffer");
  check("two distinct messages with EMPTY ids are both delivered (both buffered)", agent.inboxCount() === 2, { inbox: agent.inboxCount() });
  const c1 = drainedTexts();
  check("two distinct messages with EMPTY ids are both delivered (both surfaced, by text)", c1.includes("empty-a") && c1.includes("empty-b") && c1.length === 2, c1);

  // ---- Cell 2: post-drain: a third empty-id message must not hit the handled-id wall ----
  await publish("", "empty-c");
  await waitFor(() => agent.inboxCount() === 1, "the third empty-id message to buffer");
  const c2 = drainedTexts();
  check("a third empty-id message still delivers after the first two were handled", c2.length === 1 && c2[0] === "empty-c", c2);

  // ---- Cell 3: dedup for REAL ids is not weakened: same id twice collapses to one ----
  await publish("dup-real", "dup-1");
  await publish("dup-real", "dup-2");
  await waitFor(() => agent.inboxCount() >= 1, "the duplicated real id to buffer");
  await sleep(400); // let any (wrong) second copy land before asserting the count
  check("the same REAL id twice still collapses to one entry", agent.inboxCount() === 1, { inbox: agent.inboxCount() });
  const c3 = drainedTexts();
  check("the collapsed REAL-id entry is the first copy", c3.length === 1 && c3[0] === "dup-1", c3);

  // ---- Cell 4: two distinct REAL ids are both delivered ----
  await publish("real-a", "ra");
  await publish("real-b", "rb");
  await waitFor(() => agent.inboxCount() === 2, "both distinct real-id messages to buffer");
  const c4 = drainedTexts();
  check("two distinct REAL ids are both delivered", c4.includes("ra") && c4.includes("rb") && c4.length === 2, c4);

  // ---- Cell 5: THE RACE (framed in review): empty-b arrives after empty-a's snapshot, before its verdict ----
  // The receive key is what makes this safe: the host frame holds empty-a's key, a LATER distinct
  // empty-id arrival mints its own, and the exact drain selects the DELIVERY, not an id value two
  // messages share. Durable deliveries (counting acks) so "neither drained nor acked" is observable.
  {
    const ackA = { n: 0 }, ackB = { n: 0 };
    agent.ep.emit("message", msg("", "race-a"), { ack: () => ackA.n++, nak: () => {}, durable: true }, meta);
    const snapshot = agent.peekInbox("all");
    check("the race: the snapshot holds exactly empty-a", snapshot.length === 1 && snapshot[0].text === "race-a", snapshot.map((i) => i.text));
    agent.ep.emit("message", msg("", "race-b"), { ack: () => ackB.n++, nak: () => {}, durable: true }, meta); // arrives after the snapshot
    await waitFor(() => agent.inboxCount() === 2, "both race messages to buffer");
    const drained = agent.drainInboxDeliveries(snapshot.map((i) => i.recvKey)); // the verdict: drain exactly what was surfaced
    check("the race: the verdict drains exactly the snapshot's delivery", drained.items.length === 1 && drained.items[0].text === "race-a", drained.items.map((i) => i.text));
    check("the race: the later arrival is neither drained nor acked", agent.inboxCount() === 1 && ackB.n === 0, { inbox: agent.inboxCount(), ackB: ackB.n });
    check("the race: the snapshot's delivery was acked exactly once", ackA.n === 1, ackA);
    const again = agent.peekInbox("all");
    check("a drained empty-id item is not re-shown on the next read", again.length === 1 && again[0].text === "race-b", again.map((i) => i.text));
    const close = agent.drainInboxDeliveries(again.map((i) => i.recvKey));
    check("the seam can still ack the id-less delivery by its receive key (no redelivery loop)", close.items.length === 1 && close.items[0].text === "race-b" && ackB.n === 1, { items: close.items.length, ackB: ackB.n });
  }

  // ---- Cell 7: eviction classification does not bleed between id-less deliveries (finding (e2)) ----
  // evictedClassifications keyed "" would let one evicted empty-id item's pull-only classification
  // decide the NEXT distinct empty-id message's lane. The guard skips recording empty ids entirely;
  // the cell drives two evictions and asserts the second arrives with its own receive-time lane.
  {
    // Drive it through the REAL ingest: "a" arrives (would be pull-only if it inherited), is
    // recorded as evicted-pull-only through the real rememberEvicted, then "b" arrives and its
    // lane must be decided by ITS OWN receive-time classification, not by a's memory.
    const a = emptyDelivery("evict-a"); // pull-only (quiet classification)
    const b = emptyDelivery("evict-b"); // automatic
    const agentInner = agent as unknown as { rememberEvicted: (p: { item: InboxItem; pullOnly: boolean }) => void };
    agentInner.rememberEvicted({ item: a, pullOnly: true }); // a's eviction memory, keyed by wire id ""
    (agent as unknown as { inbox: { item: InboxItem; ack: () => void; pullOnly: boolean }[] }).inbox.push({ item: b, ack: () => {}, pullOnly: false });
    const lane = agent.inboxScope(b.recvKey);
    check("an evicted id-less delivery's classification does not bleed onto the next one", lane === "automatic", lane);
    // and the real ingest path for a LATER empty-id arrival reads no remembered classification:
    // emulate the ingest read the guard protects (agent.ts remembered lookup) is ""-blind.
    const later = emptyDelivery("evict-c");
    (agent as unknown as { inbox: { item: InboxItem; ack: () => void; pullOnly: boolean }[] }).inbox.push({ item: later, ack: () => {}, pullOnly: false });
    check("a later id-less arrival inherits nothing from the evicted empty id", agent.inboxScope(later.recvKey) === "automatic");
    agent.drainInboxDeliveries([b.recvKey, later.recvKey]); // leave the buffer clean for the sweep cell
  }

  // ---- Cell 8: in-flight holds do not merge across id-less deliveries (finding (f)) ----
  {
    const x = emptyDelivery("fl-a", false);
    const y = emptyDelivery("fl-b", false);
    check("distinct id-less deliveries hold independently", agent.holdInFlight([x.recvKey]) && agent.holdInFlight([y.recvKey]));
    check("each key is individually in flight", agent.isInFlight(x.recvKey) && agent.isInFlight(y.recvKey));
    agent.releaseInFlight([x.recvKey]);
    check("releasing one leaves the other held", !agent.isInFlight(x.recvKey) && agent.isInFlight(y.recvKey));
    agent.releaseInFlight([y.recvKey]);
  }

  // ---- Cell 9: scope lookup resolves the DELIVERY, not the first empty id in the buffer (finding (i)) ----
  {
    const quiet = emptyDelivery("scope-quiet", true);
    const auto = emptyDelivery("scope-auto", false);
    (agent as unknown as { inbox: { item: InboxItem; ack: () => void; pullOnly: boolean }[] }).inbox.push({ item: quiet, ack: () => {}, pullOnly: true });
    (agent as unknown as { inbox: { item: InboxItem; ack: () => void; pullOnly: boolean }[] }).inbox.push({ item: auto, ack: () => {}, pullOnly: false });
    check("each id-less delivery resolves its own lane", agent.inboxScope(quiet.recvKey) === "pull-only" && agent.inboxScope(auto.recvKey) === "automatic");
    const drained9 = agent.drainInboxDeliveries([quiet.recvKey, auto.recvKey]);
    check("both id-less deliveries drain by their own keys", drained9.items.length === 2, drained9.items.map((i) => i.text));
  }

  // ---- Cell 10: an id-less recall twin is never "never-recalled" (finding (g)) ----
  check("the recall tie-break does not order an empty id against itself", afterRecallMark({ ts: 100, id: "" }, { ts: 100, id: "" }) === false);
  check("an id-less item still advances past an earlier mark by time", afterRecallMark({ ts: 200, id: "" }, { ts: 100, id: "" }) === true);
  // ---- Cell 11: the REAL eviction path does not bleed an empty id's classification (K6, write+read) ----
  // Overfill the inbox past the valve so an empty-id pull-only item is evicted through the REAL
  // rememberEvicted (write side), then deliver a fresh empty-id ambient through the REAL ingest and
  // assert its lane is its own receive-time classification, not the evicted item's memory (read side).
  {
    const agentInbox = agent as unknown as { inbox: { item: InboxItem; ack: () => void; pullOnly: boolean }[] };
    // The evictee must be the OLDEST entry: the valve evicts from the front, so a newest-staged
    // pull-only item is never chosen. Stage it FIRST, then overflow behind it.
    const pullEvictee = emptyDelivery("evicted-pull");
    agentInbox.inbox.push({ item: pullEvictee, ack: () => {}, pullOnly: true });
    for (let i = 0; i < 205; i++) agentInbox.inbox.push({ item: emptyDelivery(`fill-${i}`), ack: () => {}, pullOnly: false });
    // Trigger the valve through the real buffer() entry point: deliver one more via the endpoint event.
    agent.ep.emit("message", msg("", "overflow-trigger"), { ack: () => {}, nak: () => {}, durable: false }, meta);
    await sleep(200);
    const survived = agentInbox.inbox.map((p) => p.item.text);
    check("the overflow valve evicted the oldest entries (the path ran)", survived.length <= 200, survived.length);
    // Fresh empty-id ambient through the REAL ingest: must be automatic, not inherited pull-only.
    agent.ep.emit("message", msg("", "fresh-after-evict"), { ack: () => {}, nak: () => {}, durable: false }, meta);
    await sleep(100);
    const fresh = agentInbox.inbox.find((p) => p.item.text === "fresh-after-evict");
    check("a fresh empty-id arrival inherits no evicted classification (both guards, real path)", fresh !== undefined && fresh.pullOnly === false, { fresh: fresh?.pullOnly });
    agent.drainInbox();
  }

  // ---- Cell 12: absent and non-string ids never reach the receiver's machinery (D16) ----
  // A foreign client can publish an envelope whose id is absent or a non-string; SPEC sec 5 makes
  // both malformed, and the pumps reject them per delivery class (live drop, so nothing buffers)
  // instead of letting an undefined key flow into the id-keyed lanes.
  {
    agent.drainInbox(); // clear anything cells 7-10 staged directly
    const before = incoming.length;
    const envelope = JSON.parse(rawMsg("", "absent-id")) as Record<string, unknown>;
    delete envelope.id;
    nc.publish(subject, enc.encode(JSON.stringify(envelope)));
    nc.publish(subject, enc.encode(JSON.stringify({ ...JSON.parse(rawMsg("", "nonstring-id")), id: 42 })));
    await nc.flush();
    await sleep(600);
    check("an absent or non-string id is dropped at the live pump (never buffered)", agent.inboxCount() === 0 && incoming.length === before, { inbox: agent.inboxCount(), incoming: incoming.length });
  }

  await publish("", "sweep-a");
  await publish("", "sweep-b");
  await publish("", "sweep-c");
  await waitFor(() => agent.inboxCount() === 3, "three empty-id messages to buffer");
  const exact = agent.drainInboxDeliveries([""]);
  check("drainInboxDeliveries([\"\"]) selects nothing: no item's receive key is the empty string", agent.inboxCount() === 3 && exact.items.length === 0, { inbox: agent.inboxCount(), items: exact.items.length });
  const c6 = drainedTexts();
  check("a scope drain still delivers all three empty-id messages", c6.length === 3 && c6.includes("sweep-a") && c6.includes("sweep-b") && c6.includes("sweep-c"), c6);

  console.log(`\nEMPTY-ID INGEST SMOKE OK ✅  (${pass} checks)`);
} catch (e) {
  console.error(`\nEMPTY-ID INGEST SMOKE FAILED ❌  ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  try { await agent.stop(); } catch { /* already down or never up */ }
  try { if (nc) await nc.drain(); } catch { /* broker already gone */ }
  releaseBroker();
  srv.kill("SIGKILL");
  await awaitExit(srv);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
