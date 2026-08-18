/**
 * A DESTRUCTIVE READ MAY ONLY CLEAR WHAT IT ACTUALLY HANDED OVER (Cotal #603).
 *
 * The defect is a COMPOSITION, and no one of its three parts is wrong on its own:
 *
 *   1. `cotal_inbox` clears what it returns, which is fine in steady state;
 *   2. recovery is when the payload is LARGEST, because reconnecting brings a channel-history
 *      replay with it;
 *   3. a payload can exceed what the caller can receive, because the host caps a tool result.
 *
 * Composed, the recovery read consumes a real direct message inside a response the caller never
 * gets. Measured on this box before the fix, with the occupant below: one call returned 463,788
 * chars, marked all 200 messages read, and left the inbox at 0, including a live DM whose sender
 * had to resend it first-party.
 *
 * THE OCCUPANT IS THE MEASURED ONE, not a convenient one: 199 replayed channel messages at ~2.3 KB
 * each (451 KB / 200, the real reconnect's shape) with one live DM among them.
 *
 * WHAT WOULD MAKE THIS THE WRONG EXPERIMENT, stated so a later reader can check it rather than
 * trust it:
 *
 *   • If the cells asserted only "the response is small", a fix that TRUNCATED the text would pass
 *     while still acking the messages it cut off. So every size cell is paired with a possession
 *     cell: what is not in the response is still in the buffer, by id.
 *   • If the cells only ever put ONE DM in the window, "mail before replay" would be indistinguish-
 *     able from luck. Cell 3 therefore overflows the window with DMs alone and walks the buffer to
 *     empty, asserting each DM is delivered exactly once and none is dropped.
 *   • If no cell exercised a small inbox, a fix that held mail back forever would also pass. Cell 4
 *     is that inverse control: below the window, one call still returns everything and clears it.
 *   • These cells drive the tool spec's own `run` against a real MeshAgent, not a copy of the
 *     selection logic. A suite that re-implemented `windowInbox` would grade its own arithmetic.
 *
 * Run: pnpm smoke:inbox-window   (pure in-process, no nats-server needed)
 */
import { strict as assert } from "node:assert";
import type { CotalMessage, Delivery, MessageMeta } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { cotalToolSpecs, INBOX_WINDOW_CHARS, type ToolResult } from "../src/tool-specs.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const cfg: AgentConfig = {
  space: "inboxwindow",
  name: "Otto",
  role: "generalist",
  servers: "nats://127.0.0.1:1", // never connected: we drive the "message" event directly
  subscribe: ["general"],
  allowSubscribe: ["general"],
  allowPublish: ["general"],
  kind: "agent",
  tls: false,
  id: "otto_agent",
};

/** ~2.3 KB per replayed message: 451 KB over 200 messages, the measured reconnect. */
const BODY = "x".repeat(2_300);
const DM_MARK = "<<<the-one-real-dm>>>";

const replayMeta: MessageMeta = { historical: true, kind: "channel" };
const dmMeta: MessageMeta = { historical: false, kind: "dm" };
const noop = (): Delivery => ({ ack: () => {}, nak: () => {}, durable: true });

const replayMsg = (n: number): CotalMessage => ({
  id: `h-${n}`,
  ts: n,
  space: cfg.space,
  from: { id: "peer", name: `peer-${n % 7}`, kind: "agent" },
  channel: "general",
  parts: [{ kind: "text", text: BODY }],
});

const dmMsg = (id: string, text: string): CotalMessage => ({
  id,
  ts: 10_000,
  space: cfg.space,
  from: { id: "orch", name: "Ada", role: "orchestrator", kind: "agent" },
  parts: [{ kind: "text", text }],
});

const inboxSpec = () => {
  const spec = cotalToolSpecs(cfg).find((s) => s.name === "cotal_inbox");
  assert.ok(spec, "cotal_inbox spec not found, so the suite is grading nothing");
  return spec;
};

const textOf = (r: ToolResult | string): string => (typeof r === "string" ? r : r.text);

try {
  // ── 1) THE OCCUPANT: a reconnect replay with one live DM inside it ─────────────────────────────
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    for (let n = 0; n < 199; n++) agent.ep.emit("message", replayMsg(n), noop(), replayMeta);
    agent.ep.emit("message", dmMsg("real-dm", `ruling: ${DM_MARK}`), noop(), dmMeta);
    check("the recovery buffer holds the measured occupant: 199 replayed + 1 live DM", agent.inboxCount() === 200, agent.inboxCount());

    const before = new Set(agent.peekInbox().map((i) => i.id));
    const text = textOf(await inboxSpec().run(agent, cfg, {}));

    check("the response is inside the receivable window, not 463,788 chars", text.length <= INBOX_WINDOW_CHARS, {
      chars: text.length,
      window: INBOX_WINDOW_CHARS,
    });
    check("the real DM is IN the response the caller can receive", text.includes(DM_MARK));
    check("what did not fit was NOT consumed: the buffer still holds the rest", agent.inboxCount() > 0, agent.inboxCount());

    // The possession cell. Size alone would also pass for a fix that truncated the text while
    // acking everything it cut off, which is the defect wearing a smaller number.
    const after = new Set(agent.peekInbox().map((i) => i.id));
    const cleared = [...before].filter((id) => !after.has(id));
    const rendered = (text.match(/\[#general/g) ?? []).length + (text.includes(DM_MARK) ? 1 : 0);
    check("the number of messages cleared is exactly the number the response rendered",
      cleared.length === rendered, { cleared: cleared.length, rendered, held: after.size });
    check("the DM was cleared because it was DELIVERED, not because it was swallowed",
      !after.has("real-dm") && text.includes(DM_MARK));
  }

  // ── 2) The second call continues where the first stopped, and loses nothing on the way ─────────
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    for (let n = 0; n < 199; n++) agent.ep.emit("message", replayMsg(n), noop(), replayMeta);
    agent.ep.emit("message", dmMsg("real-dm", `ruling: ${DM_MARK}`), noop(), dmMeta);

    const seen = new Set<string>();
    let calls = 0;
    let dmSeen = 0;
    while (agent.inboxCount() > 0) {
      const held = new Set(agent.peekInbox().map((i) => i.id));
      const text = textOf(await inboxSpec().run(agent, cfg, {}));
      assert.ok(text.length <= INBOX_WINDOW_CHARS, `call ${calls} overflowed the window at ${text.length} chars`);
      if (text.includes(DM_MARK)) dmSeen++;
      for (const id of held) if (!agent.peekInbox().some((p) => p.id === id)) assert.ok(!seen.has(id), `${id} was surfaced twice`), seen.add(id);
      calls++;
      assert.ok(calls < 50, "the buffer is not draining, so the window never advances");
    }
    check("walking the buffer to empty delivers all 200 messages exactly once", seen.size === 200, { seen: seen.size, calls });
    check("...and the DM was delivered on exactly one of those calls", dmSeen === 1, dmSeen);
  }

  // ── 3) MAIL BEFORE REPLAY, tested where it is not free: more DMs than one window can carry ─────
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    // Replay first, so receive order alone would put every DM behind 199 channel messages.
    for (let n = 0; n < 199; n++) agent.ep.emit("message", replayMsg(n), noop(), replayMeta);
    for (let n = 0; n < 40; n++) agent.ep.emit("message", dmMsg(`dm-${n}`, `${BODY} dm-${n}`), noop(), dmMeta);

    const text = textOf(await inboxSpec().run(agent, cfg, {}));
    const dmsShown = [...Array(40).keys()].filter((n) => text.includes(` dm-${n}`)).length;
    const replayShown = (text.match(/\[#general/g) ?? []).length;
    check("the first response is mail, not backfill: DMs occupy the window ahead of replayed history",
      dmsShown > 0 && replayShown === 0, { dmsShown, replayShown });
    check("the DMs that did not fit are still buffered, not acked behind the ones that did",
      agent.peekInbox().filter((i) => i.kind === "dm").length === 40 - dmsShown, {
        dmsShown,
        stillBuffered: agent.peekInbox().filter((i) => i.kind === "dm").length,
      });
  }

  // ── 4) INVERSE CONTROL: below the window, nothing changes and one call takes it all ────────────
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    for (let n = 0; n < 3; n++) agent.ep.emit("message", replayMsg(n), noop(), replayMeta);
    agent.ep.emit("message", dmMsg("small-dm", `small ${DM_MARK}`), noop(), dmMeta);
    const text = textOf(await inboxSpec().run(agent, cfg, {}));
    check("a small inbox is returned in full and cleared in full, so the window is not a throttle",
      agent.inboxCount() === 0 && text.includes(DM_MARK) && (text.match(/\[#general/g) ?? []).length === 3,
      { remaining: agent.inboxCount() });
    check("...and it carries no held-messages note, because nothing was held", !text.includes("held ("), text.slice(-120));
  }

  // ── 5) peek still clears nothing, and is now receivable, which is why it was the workaround ────
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    for (let n = 0; n < 199; n++) agent.ep.emit("message", replayMsg(n), noop(), replayMeta);
    agent.ep.emit("message", dmMsg("real-dm", `ruling: ${DM_MARK}`), noop(), dmMeta);
    const text = textOf(await inboxSpec().run(agent, cfg, { peek: true }));
    check("peek clears nothing at all", agent.inboxCount() === 200, agent.inboxCount());
    check("...and its response is inside the window too: the documented workaround could overflow as well",
      text.length <= INBOX_WINDOW_CHARS, text.length);
    check("...and it says what it is holding back", text.includes("held ("), text.slice(-160));
  }

  // ── 6) FOCUS: the response carries two lanes, and only one of them is destructive ──────────────
  //
  // In focus mode the reply mixes the live buffer (DMs/anycast, clearable) with read-only channel
  // recall pulled back from the stream. Passing a recall id to drainInboxIds would not merely be
  // untidy: ids are marked HANDLED there, so a later live copy of that message would be dropped as
  // a duplicate: mail lost by a read that never owned it.
  //
  // WHAT THIS CELL DOES AND DOES NOT GRADE, so it is not read as more than it is: it stubs the
  // agent's attention and `recallAmbient`, because both need a live broker, and grades the TOOL's
  // handling of whatever recall returns. The agent's own focus machinery (the frontier, the
  // exclusion list, what recall is allowed to replay) is graded in attention.smoke.ts against a
  // real broker; nothing here stands in for that.
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    Object.defineProperty(agent, "attention", { get: () => "focus" });
    const recalled = [0, 1, 2].map((n) => ({
      id: `recall-${n}`,
      ts: 500 + n,
      fromId: "peer",
      fromName: "Peer",
      kind: "channel" as const,
      channel: "general",
      mentionsMe: false,
      historical: false,
      text: `recalled chatter ${n}`,
    }));
    (agent as unknown as { recallAmbient: () => Promise<unknown> }).recallAmbient = async () => ({
      items: recalled,
      droppedChannels: [],
    });
    for (let n = 0; n < 5; n++) agent.ep.emit("message", dmMsg(`fdm-${n}`, `focus dm ${n}`), noop(), dmMeta);

    const text = textOf(await inboxSpec().run(agent, cfg, {}));
    check("focus: the reply carries both lanes", text.includes("focus dm 0") && text.includes("recalled chatter 0"));
    check("focus: the buffered lane was cleared, because it was delivered", agent.inboxCount() === 0, agent.inboxCount());

    // The sharp one: a recall id must not have been marked handled by a read that only displayed it.
    agent.ep.emit("message", { ...replayMsg(0), id: "recall-1" }, noop(), { historical: false, kind: "channel" });
    check("focus: a recall id was NOT marked handled, so a later live copy of it still buffers",
      agent.peekInbox().some((i) => i.id === "recall-1"), agent.peekInbox().map((i) => i.id));
  }

  // ── 7) FOCUS + PEEK: the workaround has to hold on the two-lane path too ──────────────────────
  //
  // Cell 5 grades peek on the ordinary path and cell 6 grades the focus lanes without peek, so the
  // intersection was covered by neither: a focus reply that cleared the buffered lane while peeking
  // would break the peek contract with both other cells still green.
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    Object.defineProperty(agent, "attention", { get: () => "focus" });
    (agent as unknown as { recallAmbient: () => Promise<unknown> }).recallAmbient = async () => ({
      items: [{
        id: "recall-p",
        ts: 700,
        fromId: "peer",
        fromName: "Peer",
        kind: "channel" as const,
        channel: "general",
        mentionsMe: false,
        historical: false,
        text: "recalled chatter while peeking",
      }],
      droppedChannels: [],
    });
    for (let n = 0; n < 4; n++) agent.ep.emit("message", dmMsg(`pdm-${n}`, `peeked dm ${n}`), noop(), dmMeta);

    const text = textOf(await inboxSpec().run(agent, cfg, { peek: true }));
    check("focus + peek: the reply still carries both lanes", text.includes("peeked dm 0") && text.includes("recalled chatter while peeking"));
    check("focus + peek: the buffered lane is NOT cleared", agent.inboxCount() === 4, agent.inboxCount());
  }

  // ── 8) AN ITEM TOO LARGE FOR ANY RESPONSE IS HELD, NOT SHOWN ALONE AND ACKED ──────────────────
  //
  // The first shape of this fix let an oversized item ride alone, reasoning that refusing it would
  // wedge the inbox. Measured, that was #603 in miniature: a 60,000-character DM produced a 60,026
  // character response, past the bound this code advertises, and ACKED it. Reported by the second
  // review lens with a working repro, reproduced here before the repair.
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    let acked = 0;
    agent.ep.emit("message", dmMsg("huge", "z".repeat(60_000)), { ack: () => { acked++; }, nak: () => {}, durable: true }, dmMeta);

    const text = textOf(await inboxSpec().run(agent, cfg, {}));
    check("an oversized message does not blow the window it advertises", text.length <= INBOX_WINDOW_CHARS, text.length);
    check("...and is NOT consumed: still buffered, never acked", agent.inboxCount() === 1 && acked === 0, { held: agent.inboxCount(), acked });
    check("...and the reply names it rather than leaving it silently stuck",
      text.includes("cannot be delivered by this tool at all") && text.includes("Ada"), text.slice(0, 400));
  }

  // ── 9) ...and holding it wedges nothing: the rest of the buffer still flows past it ────────────
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    agent.ep.emit("message", dmMsg("huge", "z".repeat(60_000)), noop(), dmMeta);
    for (let n = 0; n < 3; n++) agent.ep.emit("message", dmMsg(`ord-${n}`, `ordinary ${n}`), noop(), dmMeta);

    const text = textOf(await inboxSpec().run(agent, cfg, {}));
    const delivered = [0, 1, 2].every((n) => text.includes(`ordinary ${n}`));
    check("ordinary mail is delivered past an item that can never fit", delivered && agent.inboxCount() === 1,
      { remaining: agent.peekInbox().map((i) => i.id) });
  }

  // ── 10) THE BUDGET IS THE WHOLE RESPONSE, not the items in it ─────────────────────────────────
  //
  // Also from the second lens: the window budgeted `fmtItem` only, so the head line and the
  // held-note rode outside the bound. Measured at 48,135 characters for 47,971 of messages.
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    agent.ep.emit("message", dmMsg("near", "y".repeat(47_950)), noop(), dmMeta);
    agent.ep.emit("message", dmMsg("second", "s".repeat(500)), noop(), dmMeta);

    const text = textOf(await inboxSpec().run(agent, cfg, {}));
    check("the head line and the held-note are inside the budget, not outside it",
      text.length <= INBOX_WINDOW_CHARS, { chars: text.length, window: INBOX_WINDOW_CHARS });
  }

  // ── 11) HELD-BUT-NOTHING-SHOWN IS NOT AN EMPTY INBOX ──────────────────────────────────────────
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    agent.ep.emit("message", dmMsg("huge", "z".repeat(60_000)), noop(), dmMeta);
    const text = textOf(await inboxSpec().run(agent, cfg, {}));
    check("a buffer holding only undeliverable mail does not report an empty inbox",
      !text.includes("Inbox empty") && text.includes("stays buffered and uncleared"), text.slice(0, 200));
  }

  // ── 12) THE NOTE ABOUT UNDELIVERABLE MAIL IS ITSELF BOUNDED ───────────────────────────────────
  //
  // Named by the second lens while the repair was being written: naming every stuck message lets a
  // steady stream of oversized mail fill each reply with metadata about mail it cannot carry, which
  // is the same overflow one layer up. The note names a few and counts the rest.
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    for (let n = 0; n < 12; n++) agent.ep.emit("message", dmMsg(`huge-${n}`, "z".repeat(60_000)), noop(), dmMeta);

    const text = textOf(await inboxSpec().run(agent, cfg, {}));
    const named = (text.match(/chars\)/g) ?? []).length;
    check("twelve undeliverable messages do not produce twelve lines of metadata",
      named <= 3 && text.includes("and 9 more"), { named, tail: text.slice(-200) });
    check("...and the reply stays inside the window while nothing is cleared",
      text.length <= INBOX_WINDOW_CHARS && agent.inboxCount() === 12, { chars: text.length, held: agent.inboxCount() });
    check("...and it does not promise that calling again will deliver them",
      text.includes("calling again will not produce them") && !text.includes("next batch"), text.slice(-240));
  }

  console.log(`\nINBOX WINDOW SMOKE OK ✅  (${pass} passed, 0 failed)`);
  process.exit(0);
} catch (e) {
  console.error(`\nINBOX WINDOW SMOKE FAILED ❌  ${(e as Error).message}`);
  process.exit(1);
}
