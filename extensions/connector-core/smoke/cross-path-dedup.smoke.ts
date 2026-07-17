/**
 * Cross-path dedup commit invariant (no broker) — drives MeshAgent.ingest directly via the endpoint
 * "message" event to prove the live/durable transition window cannot drop a durable commit.
 *
 * When the SAME message id arrives on both paths, ingest keeps one inbox entry and must retain an
 * ACKABLE handle: a live copy's no-op ack must NEVER overwrite a durable copy's real ack, in either
 * arrival order. Otherwise drainInbox "acks" via the no-op, the durable copy is never committed,
 * JetStream redelivers it after ack_wait, and it double-surfaces — the exact regression the
 * coverage-partition can't close in the transition window.
 *
 * Run: pnpm smoke:cross-path-dedup   (pure in-process — no nats-server needed)
 */
import { strict as assert } from "node:assert";
import type { CotalMessage, Delivery, MessageMeta } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const cfg: AgentConfig = {
  space: "dedupsmoke",
  name: "Otto",
  role: "generalist",
  servers: "nats://127.0.0.1:1", // never connected — we only drive the "message" event
  subscribe: ["ch"],
  allowSubscribe: ["ch"],
  allowPublish: ["ch"],
  kind: "agent",
  tls: false,
  id: "otto_agent",
};

const agent = new MeshAgent(cfg);
agent.on("error", () => {});
const incoming = new Map<string, number>();
agent.on("incoming", (item) => incoming.set(item.id, (incoming.get(item.id) ?? 0) + 1));

const meta: MessageMeta = { historical: false, kind: "channel" };
const msg = (id: string): CotalMessage => ({
  id,
  ts: 1,
  space: cfg.space,
  from: { id: "peer", name: "Peer", kind: "agent" },
  channel: "ch",
  parts: [{ kind: "text", text: "hi" }],
});
// Counting deliveries: each ack bumps its own counter, so after drainInbox we can see exactly WHICH
// handle was committed (the live one mirrors the endpoint's no-op, but we count it to prove it was NOT
// the retained handle).
const mkDelivery = (durable: boolean, c: { n: number }): Delivery => ({ ack: () => c.n++, nak: () => {}, durable });

try {
  // ── Case 1 — durable FIRST, live SECOND (the trap): the late live no-op must not clobber the ack ──
  {
    const dc = { n: 0 };
    const lc = { n: 0 };
    agent.ep.emit("message", msg("m1"), mkDelivery(true, dc), meta);
    agent.ep.emit("message", msg("m1"), mkDelivery(false, lc), meta); // same id, live second
    check("durable-first/live-second: single inbox entry (no double-surface)", agent.inboxCount() === 1);
    check("durable-first/live-second: a live duplicate does not re-announce", incoming.get("m1") === 1, incoming.get("m1"));
    const items = agent.drainInbox();
    check("durable-first/live-second: exactly one surfaced", items.length === 1);
    check("durable-first/live-second: the DURABLE ack committed, the live no-op did NOT overwrite it", dc.n === 1 && lc.n === 0, { dc, lc });
  }

  // ── Case 2 — live FIRST, durable SECOND: the durable copy must UPGRADE the retained handle ──
  {
    const dc = { n: 0 };
    const lc = { n: 0 };
    agent.ep.emit("message", msg("m2"), mkDelivery(false, lc), meta);
    agent.ep.emit("message", msg("m2"), mkDelivery(true, dc), meta); // durable second
    check("live-first/durable-second: single inbox entry", agent.inboxCount() === 1);
    check("live-first/durable-second: the durable pending duplicate re-announces through incoming", incoming.get("m2") === 2, incoming.get("m2"));
    agent.drainInbox();
    check("live-first/durable-second: the DURABLE ack committed (upgraded from the live no-op)", dc.n === 1 && lc.n === 0, { dc, lc });
  }

  // ── Case 3 — durable redelivery (same path, both durable): take the FRESHEST handle ──
  {
    const first = { n: 0 };
    const second = { n: 0 };
    agent.ep.emit("message", msg("m3"), mkDelivery(true, first), meta);
    agent.ep.emit("message", msg("m3"), mkDelivery(true, second), meta); // redelivery, fresh handle
    check("durable redelivery: single inbox entry", agent.inboxCount() === 1);
    check("durable redelivery: the pending item re-announces through incoming", incoming.get("m3") === 2, incoming.get("m3"));
    agent.drainInbox();
    check("durable redelivery: the FRESHEST durable handle is committed", second.n === 1 && first.n === 0, { first, second });
  }

  // ── Case 4 — two live copies (both no-op): still dedups to one surface ──
  {
    agent.ep.emit("message", msg("m4"), mkDelivery(false, { n: 0 }), meta);
    agent.ep.emit("message", msg("m4"), mkDelivery(false, { n: 0 }), meta);
    check("two live copies: single inbox entry (deduped)", agent.inboxCount() === 1);
    check("two live copies: the duplicate does not re-announce", incoming.get("m4") === 1, incoming.get("m4"));
    const items = agent.drainInbox();
    check("two live copies: exactly one surfaced", items.length === 1);
  }

  // Durable retry reuses the existing receive-time lane; it must not turn quiet ambient into an
  // automatic wake merely because JetStream supplied another delivery opportunity.
  {
    const a2 = new MeshAgent({ ...cfg, id: "quiet_redelivery", quiet: ["ch"] });
    a2.on("error", () => {});
    a2.ep.emit("message", msg("quiet-redelivery"), mkDelivery(true, { n: 0 }), meta);
    a2.ep.emit("message", msg("quiet-redelivery"), mkDelivery(true, { n: 0 }), meta);
    check("quiet durable redelivery remains pull-only", a2.inboxCount("automatic") === 0 && a2.inboxCount("pull-only") === 1);
    check("quiet durable redelivery remains non-waking", a2.pendingWake() === 0);
  }

  // ── Case 5 — live FIRST, DRAINED/surfaced, durable SECOND (the post-drain trap) ──
  // The first copy is already handled and removed from the inbox when the durable copy arrives, so the
  // pending-inbox check alone wouldn't catch it. It must NOT re-surface, and the durable copy must be
  // COMMITTED (its logical message was already handled) so JetStream stops redelivering.
  {
    const lc = { n: 0 };
    const dc = { n: 0 };
    agent.ep.emit("message", msg("m5"), mkDelivery(false, lc), meta);
    check("live-first/drain: surfaced on first drain", agent.drainInbox().length === 1);
    agent.ep.emit("message", msg("m5"), mkDelivery(true, dc), meta); // durable copy AFTER the drain
    check("live-first/drain/durable-second: durable duplicate does NOT re-buffer", agent.inboxCount() === 0);
    check("live-first/drain/durable-second: nothing re-surfaces", agent.drainInbox().length === 0);
    check("live-first/drain/durable-second: the durable duplicate is COMMITTED (acked, not lost)", dc.n === 1, { dc });
  }

  // ── Case 6 — durable FIRST, DRAINED/surfaced, live SECOND: live duplicate drops, no re-surface ──
  {
    const dc = { n: 0 };
    const lc = { n: 0 };
    agent.ep.emit("message", msg("m6"), mkDelivery(true, dc), meta);
    agent.drainInbox(); // surfaces + commits the durable copy (dc.n → 1)
    agent.ep.emit("message", msg("m6"), mkDelivery(false, lc), meta); // live copy AFTER the drain
    check("durable-first/drain/live-second: live duplicate does NOT re-buffer", agent.inboxCount() === 0);
    check("durable-first/drain/live-second: nothing re-surfaces", agent.drainInbox().length === 0);
    check("durable-first/drain/live-second: durable committed once, live no-op added nothing", dc.n === 1 && lc.n === 0, { dc, lc });
  }

  // ── Case 7 (Item 8A) — handledIds 4096-WINDOW ROTATION: a prev-window id is still deduped/committed ──
  // markHandled rotates when handledIds.size >= 4096 (handledIdsPrev = handledIds; handledIds = new Set()),
  // so the lookup horizon is TWO windows. Surface+drain >4096 distinct ids to force at least one rotation,
  // leaving an early id X (m-0) ONLY in handledIdsPrev. A durable copy of X must still be recognized as
  // already-handled: NOT re-buffered, and acked so JetStream stops redelivering. Regression caught: if
  // rotation dropped the previous window (single window, or cleared without keeping prev), X would no
  // longer be found → its durable duplicate would re-buffer and double-surface, and would NOT be acked.
  {
    const X = "m-0"; // an early id, drained long before the rotation
    const total = 5000; // comfortably past the 4096 cap → guaranteed ≥1 rotation, X lands in handledIdsPrev
    const batch = 100; // MUST be ≤ MAX_INBOX (200): a larger batch would overflow the inbox, and overflow is
    // acked-and-dropped WITHOUT markHandled — those ids would never enter a window, so no rotation ever fires.
    // Surface + drain distinct ids in batches (keeps the inbox small/fast); each drain fills handledIds.
    for (let base = 0; base < total; base += batch) {
      for (let i = base; i < base + batch && i < total; i++) {
        agent.ep.emit("message", msg(`m-${i}`), mkDelivery(true, { n: 0 }), meta);
      }
      agent.drainInbox(); // marks this batch's ids as handled, advancing toward (and past) rotation
    }
    check("rotation: inbox fully drained before the dedup probe", agent.inboxCount() === 0); // catches a leak that would mask the re-buffer check below

    // Durable copy of the prev-window id X.
    const dc = { n: 0 };
    agent.ep.emit("message", msg(X), mkDelivery(true, dc), meta);
    // Re-buffer would mean rotation lost the prev window and X is now unknown (single-window regression).
    check("rotation: prev-window id X (durable) does NOT re-buffer", agent.inboxCount() === 0);
    check("rotation: prev-window id X surfaces nothing on drain", agent.drainInbox().length === 0);
    // No ack ⇒ JetStream keeps redelivering a long-ago-handled message forever (the prev-window must stay ackable).
    check("rotation: prev-window id X (durable) IS committed (acked, not lost)", dc.n === 1, { dc });

    // Strengthening: a LIVE copy of X is dropped with NO ack and no re-buffer (live duplicate is never acked).
    const lc = { n: 0 };
    agent.ep.emit("message", msg(X), mkDelivery(false, lc), meta);
    check("rotation: prev-window id X (live) does NOT re-buffer", agent.inboxCount() === 0); // catches X falling out of the lookup horizon (would re-surface)
    check("rotation: prev-window id X (live) is dropped without an ack", lc.n === 0, { lc }); // catches a spurious ack on the no-op live path
  }

  // ── Exact completion survives overflow: absent confirmed ids become handled, but overflow alone
  //    does not. A later durable copy must be committed without double-surfacing. ──
  {
    const a2 = new MeshAgent({ ...cfg, id: "exact_agent" });
    a2.on("error", () => {});
    a2.ep.emit("message", msg("surfaced-overflow"), mkDelivery(false, { n: 0 }), meta);
    for (let i = 0; i < 200; i++) a2.ep.emit("message", msg(`fill-${i}`), mkDelivery(false, { n: 0 }), meta);
    check("exact completion setup overflow-evicts the surfaced id", !a2.peekInbox().some((i) => i.id === "surfaced-overflow"));
    a2.drainInboxIds(["surfaced-overflow"]);
    const late = { n: 0 };
    a2.ep.emit("message", msg("surfaced-overflow"), mkDelivery(true, late), meta);
    check("exact completion marks an absent requested id handled", !a2.peekInbox().some((i) => i.id === "surfaced-overflow"));
    check("late durable copy of the absent confirmed id is committed", late.n === 1, late);
  }

  // ── Receive-time quiet classification survives overflow and classification-cap exhaustion.
  //    Once the bounded evicted map fills, unknown ambient fails closed to pull-only for the session. ──
  {
    const a2 = new MeshAgent({ ...cfg, id: "quiet_overflow_agent", quiet: ["ch"] });
    a2.on("error", () => {});
    a2.ep.emit("message", msg("quiet-original"), mkDelivery(false, { n: 0 }), meta);
    // Keep overflowing quiet ambient past the 4096 evicted-classification cap.
    for (let i = 0; i < 4300; i++) a2.ep.emit("message", msg(`quiet-fill-${i}`), mkDelivery(false, { n: 0 }), meta);
    await a2.setChannelMode("ch", "normal");
    const late = { n: 0 };
    a2.ep.emit("message", msg("quiet-original"), mkDelivery(true, late), meta);
    check("classification-cap exhaustion never reclassifies a late quiet copy as automatic", !a2.peekInbox("automatic").some((i) => i.id === "quiet-original"));
    check("classification-cap exhaustion fails closed to pull-only", a2.peekInbox("pull-only").some((i) => i.id === "quiet-original"));

    await a2.setChannelMode("ch", "muted");
    a2.ep.emit("message", msg("unsafe-muted"), mkDelivery(true, { n: 0 }), meta);
    check("muted hard-drop still wins under fail-closed classification", !a2.peekInbox().some((i) => i.id === "unsafe-muted"));

    await a2.setChannelMode("ch", "normal");
    (a2 as unknown as { _attention: string })._attention = "focus";
    a2.ep.emit("message", msg("unsafe-focus"), mkDelivery(true, { n: 0 }), meta);
    check("normal focus ack-drop still wins under fail-closed classification", !a2.peekInbox().some((i) => i.id === "unsafe-focus"));

    await a2.setChannelMode("ch", "quiet");
    const mention = { ...msg("unsafe-quiet-mention"), mentions: ["otto"] };
    a2.ep.emit("message", mention, mkDelivery(true, { n: 0 }), meta);
    check("a quiet @mention remains automatic under fail-closed classification", a2.peekInbox("automatic").some((i) => i.id === "unsafe-quiet-mention"));
  }

  // ── Receive-time hard drops survive the live→durable transition after modes change. ──
  {
    const muted = new MeshAgent({ ...cfg, id: "muted_transition", muted: ["ch"] });
    muted.on("error", () => {});
    muted.ep.emit("message", msg("muted-live"), mkDelivery(false, { n: 0 }), meta);
    await muted.setChannelMode("ch", "normal");
    const durable = { n: 0 };
    muted.ep.emit("message", msg("muted-live"), mkDelivery(true, durable), meta);
    check("live muted drop stays dropped after muted→normal before durable copy", muted.inboxCount() === 0 && durable.n === 1);

    const focused = new MeshAgent({ ...cfg, id: "focus_transition" });
    focused.on("error", () => {});
    (focused as unknown as { _attention: string })._attention = "focus";
    focused.ep.emit("message", msg("focus-live"), mkDelivery(false, { n: 0 }), meta);
    (focused as unknown as { _attention: string })._attention = "open";
    const focusDurable = { n: 0 };
    focused.ep.emit("message", msg("focus-live"), mkDelivery(true, focusDurable), meta);
    check("live focus drop stays dropped after focus→open before durable copy", focused.inboxCount() === 0 && focusDurable.n === 1);
  }

  // ── A handled quiet id cannot become automatic after both ordinary handled windows rotate.
  //    Protected-disposition capacity degrades to session-long classificationUnsafe first. ──
  {
    const a2 = new MeshAgent({ ...cfg, id: "handled_quiet_rotation", quiet: ["ch"] });
    a2.on("error", () => {});
    a2.ep.emit("message", msg("handled-quiet-original"), mkDelivery(false, { n: 0 }), meta);
    a2.drainInbox(undefined, "pull-only");
    for (let i = 0; i < 8500; i++) {
      a2.ep.emit("message", msg(`handled-quiet-${i}`), mkDelivery(false, { n: 0 }), meta);
      a2.drainInbox(undefined, "pull-only");
    }
    await a2.setChannelMode("ch", "normal");
    a2.ep.emit("message", msg("handled-quiet-original"), mkDelivery(true, { n: 0 }), meta);
    check("handled-window rotation never turns a late quiet copy automatic", !a2.peekInbox("automatic").some((i) => i.id === "handled-quiet-original"));
    check("handled-disposition exhaustion fails closed to pull-only", a2.peekInbox("pull-only").some((i) => i.id === "handled-quiet-original"));
  }

  // ── Pull-only capacity cannot activate the independent hard-drop fail-closed state. ──
  {
    const a2 = new MeshAgent({ ...cfg, id: "mixed_protected_caps", muted: ["ch"] });
    a2.on("error", () => {});
    a2.ep.emit("message", msg("one-hard-drop"), mkDelivery(false, { n: 0 }), meta);
    await a2.setChannelMode("ch", "quiet");
    for (let i = 0; i < 4100; i++) {
      a2.ep.emit("message", msg(`mixed-pull-${i}`), mkDelivery(false, { n: 0 }), meta);
      a2.drainInbox(undefined, "pull-only");
    }
    await a2.setChannelMode("ch", "normal");
    a2.ep.emit("message", { ...msg("mixed-mention"), mentions: ["otto"] }, mkDelivery(false, { n: 0 }), meta);
    check("pull-only cap exhaustion does not activate hard-drop unsafe", a2.peekInbox("automatic").some((i) => i.id === "mixed-mention"));
    const droppedDurable = { n: 0 };
    a2.ep.emit("message", msg("one-hard-drop"), mkDelivery(true, droppedDurable), meta);
    check("the independent hard-drop disposition remains protected", droppedDurable.n === 1 && !a2.peekInbox().some((i) => i.id === "one-hard-drop"));
  }

  // ── Traffic retained while the asynchronous focus watermark is captured cannot also be recalled. ──
  for (const quiet of [false, true]) {
    const a2 = new MeshAgent({ ...cfg, id: `focus_transition_${quiet}`, quiet: quiet ? ["ch"] : [] });
    a2.on("error", () => {});
    (a2 as unknown as { _connected: boolean })._connected = true;
    let release!: (sequence: number) => void;
    const frontier = new Promise<number>((resolve) => { release = resolve; });
    (a2.ep as unknown as { chatFrontier(): Promise<number> }).chatFrontier = () => frontier;
    (a2.ep as unknown as { setAttention(mode: string): Promise<void> }).setAttention = async () => {};
    const focusing = a2.setAttention("focus");
    await Promise.resolve();
    const id = quiet ? "focus-transition-quiet" : "focus-transition-normal";
    a2.ep.emit("message", msg(id), mkDelivery(false, { n: 0 }), meta);
    release(0);
    await focusing;
    (a2.ep as unknown as { joinedChannels(): string[] }).joinedChannels = () => ["ch"];
    (a2.ep as unknown as { recallChannel(channel: string, since: number): Promise<{ messages: CotalMessage[]; dropped: boolean }> }).recallChannel =
      async () => ({ messages: [msg(id)], dropped: false });
    const recall = await a2.recallAmbient();
    check(`focus-entry ${quiet ? "quiet" : "normal"} buffer is excluded from recall`, !recall.items.some((i) => i.id === id));
    check(`focus-entry ${quiet ? "quiet" : "normal"} item remains in its receive-time lane`, a2.peekInbox(quiet ? "pull-only" : "automatic").some((i) => i.id === id));
  }

  // ── Focus-exclusion overflow fails closed per channel while unrelated normal recall continues. ──
  {
    const a2 = new MeshAgent({ ...cfg, id: "focus_exclusion_cap", quiet: ["ch"] });
    a2.on("error", () => {});
    (a2 as unknown as { _attention: string; focusSince: number })._attention = "focus";
    (a2 as unknown as { _attention: string; focusSince: number }).focusSince = 0;
    for (let i = 0; i < 4100; i++) a2.ep.emit("message", msg(`focus-excluded-${i}`), mkDelivery(false, { n: 0 }), meta);
    (a2.ep as unknown as { joinedChannels(): string[] }).joinedChannels = () => ["ch", "other"];
    (a2.ep as unknown as { recallChannel(channel: string, since: number): Promise<{ messages: CotalMessage[]; dropped: boolean }> }).recallChannel =
      async (channel) => ({ messages: channel === "other" ? [{ ...msg("other-normal"), channel: "other" }] : [], dropped: false });
    const recall = await a2.recallAmbient();
    check("focus-exclusion cap reports the affected channel fail-closed", recall.droppedChannels.includes("ch"));
    check("focus-exclusion cap does not block unrelated normal recall", recall.items.some((i) => i.id === "other-normal"));
    check("focus-exclusion cap never recalls excluded quiet traffic", !recall.items.some((i) => i.id.startsWith("focus-excluded-")));
  }

  // ── Pending durable-leave SURFACING (ux/security): a channel in refused-sub durable cleanup can have
  //    NO traffic and no registry entry, so endpoint.listChannels() omits it. cotal_channels must STILL
  //    show it as `durableUnclosed`, never ordinary absence — MeshAgent.listChannels() unions it in. ──
  {
    const a2 = new MeshAgent({ ...cfg, id: "surf_agent" });
    a2.on("error", () => {});
    // Fake endpoint: "ghost" is pending durable cleanup but absent from listChannels() (no traffic/config);
    // "seen" is a normal listed channel.
    (a2 as unknown as { ep: Record<string, unknown> }).ep = {
      joinedChannels: () => [],
      pendingDurableLeaves: () => ["ghost"],
      listChannels: async () => [{ channel: "seen", messages: 3, config: undefined }],
      channelReplay: () => false,
    };
    const rows = await a2.listChannels();
    const ghost = rows.find((r) => r.channel === "ghost");
    check("pending durable-leave on an UNSEEN channel is surfaced in cotal_channels (not omitted)", ghost !== undefined, rows.map((r) => r.channel));
    check("...as durableUnclosed + not joined + messages 0", ghost?.durableUnclosed === true && ghost?.joined === false && ghost?.messages === 0, ghost);
    check("a normal listed channel is NOT marked durableUnclosed", rows.find((r) => r.channel === "seen")?.durableUnclosed === false, rows);
  }

  console.log(`\nCROSS-PATH DEDUP SMOKE OK ✅  (${pass} passed, 0 failed)`);
  process.exit(0);
} catch (e) {
  console.error(`\nCROSS-PATH DEDUP SMOKE FAILED ❌  ${(e as Error).message}`);
  process.exit(1);
}
