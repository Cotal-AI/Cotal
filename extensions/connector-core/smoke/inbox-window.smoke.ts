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

  // ── 13) THE RECALL WARNING IS PART OF THE RESPONSE, SO IT IS PART OF THE BUDGET ───────────────
  //
  // Found by the first lens on its re-pointed pass, with a working repro. The focus branch appended
  // the dropped-channels warning AFTER the window had been filled, so its length rode outside the
  // bound: 49,598 characters, over the cap, with twenty already-acked messages inside it. #603
  // re-entering through a side door, and the reason the invariant below is worth stating as one.
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    Object.defineProperty(agent, "attention", { get: () => "focus" });
    // The second lens's fixture, not a friendly one: eighty channels whose names are near the
    // longest a chat subject can carry, which is what made the unbounded warning a 118,484-char reply.
    const dropped = Array.from({ length: 80 }, (_, n) => `${"s".repeat(880)}-${n}`);
    (agent as unknown as { recallAmbient: () => Promise<unknown> }).recallAmbient = async () => ({
      items: [],
      droppedChannels: dropped,
    });
    for (let n = 0; n < 20; n++) agent.ep.emit("message", dmMsg(`fb-${n}`, "b".repeat(2_300)), noop(), dmMeta);

    const text = textOf(await inboxSpec().run(agent, cfg, {}));
    check("a long recall warning cannot push an acking response past the window",
      text.length <= INBOX_WINDOW_CHARS, { chars: text.length, window: INBOX_WINDOW_CHARS });
    check("...and the warning is bounded rather than naming all eighty channels",
      (text.match(/#s{10}/g) ?? []).length <= 5 && text.includes("more channels"), text.slice(-300));
  }

  // ── 14) THE HELD NOTE TELLS A PEEKING CALLER THE TRUTH ────────────────────────────────────────
  //
  // Also from the first lens: peek clears nothing, so the next call returns the same window. Telling
  // a peeking caller to call again for the next batch is a promise the read cannot keep, and an
  // obedient caller loops on it forever. Measured there as three byte-identical replies.
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    for (let n = 0; n < 60; n++) agent.ep.emit("message", dmMsg(`pk-${n}`, "p".repeat(2_300)), noop(), dmMeta);

    const t1 = textOf(await inboxSpec().run(agent, cfg, { peek: true }));
    const t2 = textOf(await inboxSpec().run(agent, cfg, { peek: true }));
    check("a peek that holds mail does not promise a next batch it cannot deliver",
      !t1.includes("Call cotal_inbox again for the next batch") && t1.includes("read without peek"), t1.slice(-220));
    check("...and it is honest because the window really does repeat", t1 === t2 && agent.inboxCount() === 60,
      { identical: t1 === t2, held: agent.inboxCount() });
  }

  // ── 15) THE INVARIANT ITSELF, over every branch that acks ─────────────────────────────────────
  //
  // The lens's own suggestion after finding cell 13: the property is not "this fixture fits", it is
  // "no response that clears anything is larger than the window". Each case below acks something.
  {
    type Case = { name: string; build: (a: MeshAgent) => void; args: Record<string, unknown>; focus?: boolean; dropped?: string[] };
    const cases: Case[] = [
      { name: "plain replay", args: {}, build: (a) => { for (let n = 0; n < 199; n++) a.ep.emit("message", replayMsg(n), noop(), replayMeta); } },
      { name: "mail and replay", args: {}, build: (a) => {
        for (let n = 0; n < 100; n++) a.ep.emit("message", replayMsg(n), noop(), replayMeta);
        for (let n = 0; n < 40; n++) a.ep.emit("message", dmMsg(`m-${n}`, "m".repeat(2_300)), noop(), dmMeta);
      } },
      { name: "one oversized plus ordinary", args: {}, build: (a) => {
        a.ep.emit("message", dmMsg("big", "z".repeat(60_000)), noop(), dmMeta);
        for (let n = 0; n < 30; n++) a.ep.emit("message", dmMsg(`o-${n}`, "o".repeat(2_300)), noop(), dmMeta);
      } },
      { name: "focus with a long warning", args: {}, focus: true, dropped: Array.from({ length: 60 }, (_, n) => `chan-${n}`),
        build: (a) => { for (let n = 0; n < 30; n++) a.ep.emit("message", dmMsg(`f-${n}`, "f".repeat(2_300)), noop(), dmMeta); } },
    ];
    let worst = 0;
    for (const c of cases) {
      const agent = new MeshAgent(cfg);
      agent.on("error", () => {});
      if (c.focus) {
        Object.defineProperty(agent, "attention", { get: () => "focus" });
        (agent as unknown as { recallAmbient: () => Promise<unknown> }).recallAmbient = async () => ({ items: [], droppedChannels: c.dropped ?? [] });
      }
      c.build(agent);
      const before = agent.inboxCount();
      const text = textOf(await inboxSpec().run(agent, cfg, c.args));
      worst = Math.max(worst, text.length);
      assert.ok(text.length <= INBOX_WINDOW_CHARS, `${c.name}: ${text.length} chars exceeds the window`);
      assert.ok(agent.inboxCount() < before, `${c.name}: nothing was cleared, so this case does not exercise the invariant`);
    }
    check("no response that clears anything exceeds the window, across every acking branch",
      worst <= INBOX_WINDOW_CHARS, { worst, window: INBOX_WINDOW_CHARS, cases: cases.length });
  }

  // ── 16) THE FRAMING RESERVE IS BIG ENOUGH FOR THE LONGEST FRAMING THERE IS ────────────────────
  //
  // The window pays for the head line, the held-note in both of its kinds, and the recall warning
  // out of one reserve. That is only honest if each of those is bounded AND the reserve is above
  // their sum, so this cell builds the worst case of all three at once and packs the window tight.
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    Object.defineProperty(agent, "attention", { get: () => "focus" });
    (agent as unknown as { recallAmbient: () => Promise<unknown> }).recallAmbient = async () => ({
      items: [],
      droppedChannels: Array.from({ length: 60 }, (_, n) => `${"c".repeat(40)}-${n}`),
    });
    // A stuck message (its own note kind) beside enough ordinary mail to fill the window and leave
    // some held (the other note kind), with long sender names so the notes are at their longest.
    agent.ep.emit("message", { ...dmMsg("huge", "z".repeat(60_000)), from: { id: "x", name: "A".repeat(60), role: "B".repeat(60), kind: "agent" } }, noop(), dmMeta);
    for (let n = 0; n < 190; n++) agent.ep.emit("message", dmMsg(`w-${n}`, "w".repeat(400)), noop(), dmMeta);

    const before = agent.inboxCount();
    const text = textOf(await inboxSpec().run(agent, cfg, {}));
    check("the worst framing this tool can emit still fits inside the window",
      text.length <= INBOX_WINDOW_CHARS, { chars: text.length, window: INBOX_WINDOW_CHARS });
    check("...and that case really did exercise all three: it cleared mail, held mail, and warned",
      agent.inboxCount() < before && text.includes("stays buffered and uncleared") && text.includes("could not be recalled"),
      { before, after: agent.inboxCount() });
  }

  // ── 17) FOCUS RECALL HAS TO ADVANCE, or windowing it starves it ───────────────────────────────
  //
  // The second lens reproduced this on a live broker after the window landed: recall is re-derived
  // from an unchanged frontier every call, so showing its first window and stopping there returned
  // the same fifteen of thirty messages three times, the rest never appeared, and every reply said
  // "next batch". The window created this starvation, so it is this change's to fix.
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    Object.defineProperty(agent, "attention", { get: () => "focus" });
    const all = Array.from({ length: 30 }, (_, n) => ({
      id: `REC-${n}`,
      ts: 1_000 + n,
      fromId: "peer",
      fromName: "Peer",
      kind: "channel" as const,
      channel: "general",
      mentionsMe: false,
      historical: false,
      text: `${"r".repeat(3_000)} REC_${n}`,
    }));
    (agent as unknown as { recallAmbient: () => Promise<unknown> }).recallAmbient = async () => ({
      items: all,
      droppedChannels: [],
    });

    const seen = new Set<string>();
    let calls = 0;
    let text = "";
    do {
      text = textOf(await inboxSpec().run(agent, cfg, {}));
      assert.ok(text.length <= INBOX_WINDOW_CHARS, `recall call ${calls} returned ${text.length} chars`);
      for (let n = 0; n < 30; n++) if (text.includes(` REC_${n}\n`) || text.endsWith(` REC_${n}`)) seen.add(`REC_${n}`);
      calls++;
    } while (calls < 10 && seen.size < 30);
    check("successive calls walk the whole of focus recall instead of repeating its first window",
      seen.size === 30, { seen: seen.size, calls });

    const after = textOf(await inboxSpec().run(agent, cfg, {}));
    check("...and once it is walked, the reply stops offering recall rather than looping",
      !after.includes("REC_0\n") && !after.includes("next batch"), after.slice(0, 200));
  }

  // ── 18) ...but a peek must not consume the caller's place in that walk ────────────────────────
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    Object.defineProperty(agent, "attention", { get: () => "focus" });
    (agent as unknown as { recallAmbient: () => Promise<unknown> }).recallAmbient = async () => ({
      items: Array.from({ length: 30 }, (_, n) => ({
        id: `PK-${n}`, ts: 2_000 + n, fromId: "peer", fromName: "Peer", kind: "channel" as const,
        channel: "general", mentionsMe: false, historical: false, text: `${"p".repeat(3_000)} PK_${n}`,
      })),
      droppedChannels: [],
    });
    const t1 = textOf(await inboxSpec().run(agent, cfg, { peek: true }));
    const t2 = textOf(await inboxSpec().run(agent, cfg, { peek: true }));
    check("a peek leaves the recall cursor where it found it", t1 === t2 && t1.includes("PK_0"), { identical: t1 === t2 });
  }

  // ── 19) A MESSAGE THAT ACTUALLY FITS IS NOT DECLARED IMPOSSIBLE ───────────────────────────────
  //
  // Both lenses flagged the band: while the code ESTIMATED the framing with a fixed reserve, a body
  // of about 47,500 characters rendered at 47,538 total, inside the window, and was still declared
  // permanently undeliverable. Measuring the assembled response rather than estimating it is what
  // closes the band, so this cell is the band's floor.
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    agent.ep.emit("message", dmMsg("band", "q".repeat(47_500)), noop(), dmMeta);
    const text = textOf(await inboxSpec().run(agent, cfg, {}));
    check("a message that fits when rendered is delivered, not called impossible",
      text.includes("qqqq") && !text.includes("cannot be delivered by this tool at all"), text.slice(0, 160));
    check("...and it went out inside the window, and was cleared because it went out",
      text.length <= INBOX_WINDOW_CHARS && agent.inboxCount() === 0, { chars: text.length, left: agent.inboxCount() });
  }

  // ── 20) TWO RECALL ITEMS IN THE SAME MILLISECOND, WITH THE WINDOW BETWEEN THEM ────────────────
  //
  // The first lens found this against the cursor that closed the starvation: a cursor advanced to
  // the last DELIVERED timestamp filters out a twin sharing that millisecond, so the reply says to
  // call again and calling again never produces it. The same broken promise the peek copy carried,
  // arriving through the new machinery.
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    Object.defineProperty(agent, "attention", { get: () => "focus" });
    // Twins at index 14 and 15, which is where a window of ~3,000-character items falls.
    const items = Array.from({ length: 30 }, (_, n) => ({
      id: `TW-${n}`,
      ts: 5_000 + (n === 15 ? 14 : n),
      fromId: "peer",
      fromName: "Peer",
      kind: "channel" as const,
      channel: "general",
      mentionsMe: false,
      historical: false,
      text: `${"t".repeat(3_000)} TW_${n}`,
    }));
    (agent as unknown as { recallAmbient: () => Promise<unknown> }).recallAmbient = async () => ({
      items,
      droppedChannels: [],
    });

    // BOTH DIRECTIONS, because a cursor can fail either way at a tie: move past both twins and the
    // held one starves, stop below both and the delivered one comes back as a repeat.
    const times = new Map<string, number>();
    let calls = 0;
    while (calls < 12 && times.size < 30) {
      const text = textOf(await inboxSpec().run(agent, cfg, {}));
      assert.ok(text.length <= INBOX_WINDOW_CHARS, `tie call ${calls} returned ${text.length} chars`);
      for (let n = 0; n < 30; n++) {
        const hits = (text.match(new RegExp(` TW_${n}(?![0-9])`, "g")) ?? []).length;
        if (hits) times.set(`TW_${n}`, (times.get(`TW_${n}`) ?? 0) + hits);
      }
      calls++;
    }
    const repeated = [...times.entries()].filter(([, n]) => n > 1).map(([t]) => t);
    check("a recall twin sharing a millisecond with a delivered item is not filtered out for good",
      times.size === 30,
      { seen: times.size, missing: Array.from({ length: 30 }, (_, n) => `TW_${n}`).filter((t) => !times.has(t)), calls });
    check("...and the twin already delivered is not re-served to pay for it",
      repeated.length === 0, { repeated, calls });
  }

  // ── 21) TOTAL PROGRESS, on the input where every cursor shape so far has failed ───────────────
  //
  // Two recall items sharing a millisecond that CANNOT fit one window between them, with ordinary
  // messages behind them. This is the input that discriminates the three cursors tried here:
  //
  //   naive (advance to the last delivered timestamp)  -> the held twin is stranded for good
  //   below-tie (stop just under the first held item)  -> the delivered twin, and everything after
  //                                                       it, is re-served on every call, forever
  //   pair watermark over an unbroken prefix           -> both twins delivered, nothing re-served
  //
  // The invariant it asserts is the one the escapes kept breaking: EVERY fresh item is eventually
  // delivered, and nothing is delivered twice. Measured on the second shape before this repair: the
  // held twin arrived on zero of six calls while its twin and all the later mail arrived on all six.
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    Object.defineProperty(agent, "attention", { get: () => "focus" });
    const items = [
      // Same millisecond, and 30,000 characters each: either fits alone, neither fits beside the other.
      { id: "G-1", ts: 9_000, text: `${"g".repeat(30_000)} GIANT_1` },
      { id: "G-2", ts: 9_000, text: `${"g".repeat(30_000)} GIANT_2` },
      ...Array.from({ length: 6 }, (_, n) => ({ id: `S-${n}`, ts: 9_001 + n, text: `${"s".repeat(500)} SMALL_${n}` })),
    ].map((i) => ({
      ...i,
      fromId: "peer",
      fromName: "Peer",
      kind: "channel" as const,
      channel: "general",
      mentionsMe: false,
      historical: false,
    }));
    (agent as unknown as { recallAmbient: () => Promise<unknown> }).recallAmbient = async () => ({
      items,
      droppedChannels: [],
    });

    const labels = ["GIANT_1", "GIANT_2", ...Array.from({ length: 6 }, (_, n) => `SMALL_${n}`)];
    const times = new Map<string, number>();
    let calls = 0;
    while (calls < 12 && [...labels].some((l) => !times.has(l))) {
      const text = textOf(await inboxSpec().run(agent, cfg, {}));
      assert.ok(text.length <= INBOX_WINDOW_CHARS, `E13 call ${calls} returned ${text.length} chars`);
      for (const l of labels) {
        const hits = (text.match(new RegExp(` ${l}(?![0-9])`, "g")) ?? []).length;
        if (hits) times.set(l, (times.get(l) ?? 0) + hits);
      }
      calls++;
    }
    check("a same-millisecond pair too large to share one window still reaches the caller, both halves",
      labels.every((l) => times.has(l)), { missing: labels.filter((l) => !times.has(l)), calls });
    check("...and nothing behind the hole was re-served to get there",
      [...times.values()].every((n) => n === 1), { counts: Object.fromEntries(times), calls });
  }

  // ── 22a) A SKIP NEEDS NO TIE: one item too big to follow another, and mail behind it ──────────
  //
  // The first lens's E14, and the input that showed a watermark keyed to the last item shown is not
  // enough on its own. No shared milliseconds anywhere: the middle item fits a response of its own
  // and is skipped only because its predecessor took the budget, so a mark landing past the last
  // item shown jumps it forever while the reply promises a next batch.
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    Object.defineProperty(agent, "attention", { get: () => "focus" });
    const items = [
      { id: "A", ts: 30_001, text: `${"a".repeat(25_000)} SKIP_A` },
      { id: "B", ts: 30_002, text: `${"b".repeat(25_000)} SKIP_B` },
      { id: "C", ts: 30_003, text: `${"c".repeat(400)} SKIP_C` },
    ].map((i) => ({
      ...i, fromId: "peer", fromName: "Peer", kind: "channel" as const,
      channel: "general", mentionsMe: false, historical: false,
    }));
    (agent as unknown as { recallAmbient: () => Promise<unknown> }).recallAmbient = async () => ({
      items, droppedChannels: [],
    });

    const seen = new Map<string, number>();
    let calls = 0;
    while (calls < 8 && seen.size < 3) {
      const text = textOf(await inboxSpec().run(agent, cfg, {}));
      assert.ok(text.length <= INBOX_WINDOW_CHARS, `E14 call ${calls} returned ${text.length} chars`);
      for (const l of ["SKIP_A", "SKIP_B", "SKIP_C"]) {
        const hits = (text.match(new RegExp(` ${l}\\b`, "g")) ?? []).length;
        if (hits) seen.set(l, (seen.get(l) ?? 0) + hits);
      }
      calls++;
    }
    check("an item skipped only because its predecessor filled the window is still delivered",
      seen.size === 3, { seen: [...seen.keys()], calls });
    check("...and the mail behind it did not have to be re-served for that to happen",
      [...seen.values()].every((n) => n === 1), { counts: Object.fromEntries(seen) });
  }

  // ── 22) THE CURSOR'S INPUT UNIVERSE, ENUMERATED ──────────────────────────────────────────────
  //
  // Six rounds of review failed this one organ on adjacent inputs, and every instance cell stayed
  // green through all of them. An instance cell is the wrong instrument for a walk: it grades the
  // fixture someone thought of. So this one enumerates the universe the walk actually has, sizes
  // that fit easily, sizes where two cannot share a window, and sizes no window can carry, with and
  // without shared milliseconds, and asserts the property rather than a case:
  //
  //   TOTAL PROGRESS  every item that any response could carry is eventually delivered
  //   NO DUPLICATES   nothing is delivered twice
  //   IN BOUND        every response fits the window
  //   HONEST          what is never delivered is exactly what no response could carry, and is named
  //
  // A budget-skipped TAIL is not a stall: when nothing was shown behind the skip the mark does not
  // move that call, and the next call leads with the skipped item. The assertion is eventual.
  {
    const SIZES = { small: 500, half: 23_000, giant: 60_000 } as const;
    type Size = keyof typeof SIZES;
    const shapes: Size[][] = [];
    const kinds: Size[] = ["small", "half", "giant"];
    for (const a of kinds) for (const b of kinds) for (const c of kinds) for (const d of kinds) shapes.push([a, b, c, d]);

    let scenarios = 0;
    let deliveries = 0;
    for (const shape of shapes) {
      for (const tied of [false, true]) {
        const agent = new MeshAgent(cfg);
        agent.on("error", () => {});
        Object.defineProperty(agent, "attention", { get: () => "focus" });
        const items = shape.map((size, n) => ({
          id: `E-${n}`,
          // Tied mode puts every pair in one millisecond, which is what a replay burst does.
          ts: 20_000 + (tied ? Math.floor(n / 2) : n),
          fromId: "peer",
          fromName: "Peer",
          kind: "channel" as const,
          channel: "general",
          mentionsMe: false,
          historical: false,
          text: `${"e".repeat(SIZES[size])} MARK_${n}`,
        }));
        (agent as unknown as { recallAmbient: () => Promise<unknown> }).recallAmbient = async () => ({
          items,
          droppedChannels: [],
        });

        const seen = new Map<string, number>();
        let calls = 0;
        let progressed = true;
        while (calls < 10 && progressed) {
          const before = new Map(seen);
          const text = textOf(await inboxSpec().run(agent, cfg, {}));
          assert.ok(
            text.length <= INBOX_WINDOW_CHARS,
            `[${shape.join(",")}${tied ? ",tied" : ""}] call ${calls} returned ${text.length} chars`,
          );
          for (let n = 0; n < items.length; n++) {
            const hits = (text.match(new RegExp(` MARK_${n}(?![0-9])`, "g")) ?? []).length;
            if (hits) seen.set(`MARK_${n}`, (seen.get(`MARK_${n}`) ?? 0) + hits);
          }
          calls++;
          progressed = seen.size > before.size;
        }

        const label = `[${shape.join(",")}${tied ? ",tied" : ""}]`;
        for (let n = 0; n < items.length; n++) {
          const deliverable = shape[n] !== "giant"; // a giant cannot ride any response of its own
          const count = seen.get(`MARK_${n}`) ?? 0;
          assert.ok(
            deliverable ? count === 1 : count === 0,
            `${label} MARK_${n} (${shape[n]}) was delivered ${count} times after ${calls} calls`,
          );
          deliveries += count;
        }
        scenarios++;
      }
    }
    check("every scenario in the cursor's input universe makes total progress with no duplicates",
      scenarios === shapes.length * 2, { scenarios, deliveries });
  }

  console.log(`\nINBOX WINDOW SMOKE OK ✅  (${pass} passed, 0 failed)`);
  process.exit(0);
} catch (e) {
  console.error(`\nINBOX WINDOW SMOKE FAILED ❌  ${(e as Error).message}`);
  process.exit(1);
}
