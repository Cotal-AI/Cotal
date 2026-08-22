/**
 * A JOIN BACKFILL IS CONTEXT, NOT INSTRUCTION (Cotal #775).
 *
 * The defect: the receive-time classifier buffered HISTORICAL channel ambient in the automatic
 * lane. Every host-mode drive loop (jcode, codex — same blueprint) consumes that lane as user
 * turns, so a seat joining a long-lived mesh received the channel backlog as a storm of
 * instructions. Measured on a real mesh before this fix: 119 injected history digests / 0
 * assistant turns inside a minute, provider-side emergency compaction at ~258k tokens, and the
 * one real work order (a DMed file-write) never executed. The live E2E suite could not see it:
 * its mesh is seconds old, so there is no history to replay.
 *
 * The rule this suite grades: historical channel ambient is PULL-ONLY — excluded from automatic
 * delivery and from the wake count, still recallable via the pull lane. Directed traffic is
 * exempt: a historical @mention and a historical DM stay automatic, because mail addressed to
 * you is never noise.
 *
 * WHAT WOULD MAKE THIS THE WRONG EXPERIMENT, stated so a later reader can check it:
 *
 *   • If it only asserted "automatic is small" after a backfill, a fix that DROPPED history would
 *     pass while destroying recall. Every exclusion cell is paired with a possession cell: the
 *     same ids are still present in the pull lane, by count and by id.
 *   • If it never delivered LIVE ambient, a fix that made ALL channel ambient pull-only would
 *     pass — that is silent degradation of open-mode wake, the opposite direction of the same
 *     coin. Cell 4 is that inverse control.
 *   • If it only used channel traffic, a regression that classified historical DMs as pull-only
 *     (mail lost to the noise rule) would be invisible. Cell 5 pins the DM exemption; cell 2
 *     pins the mention exemption.
 *   • The cells drive MeshAgent's own "message" event path, the same entry the endpoint uses —
 *     not a re-implementation of the classifier.
 *
 * Run: pnpm smoke:history-flood   (pure in-process, no nats-server needed)
 */
import { strict as assert } from "node:assert";
import type { CotalMessage, Delivery, MessageMeta } from "@cotal-ai/core";
import { MeshAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

const cfg: AgentConfig = {
  space: "historyflood",
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

const noop = (): Delivery => ({ ack: () => {}, nak: () => {}, durable: true });
const historicalChannel: MessageMeta = { historical: true, kind: "channel" };
const liveChannel: MessageMeta = { historical: false, kind: "channel" };
const historicalDm: MessageMeta = { historical: true, kind: "dm" };
const liveDm: MessageMeta = { historical: false, kind: "dm" };

const channelMsg = (id: string, text: string, mention = false): CotalMessage => ({
  id,
  ts: Number(id.replace(/\D/g, "") || 1),
  space: cfg.space,
  from: { id: "peer", name: "peer" },
  channel: "general",
  parts: [{ kind: "text", text }],
  ...(mention ? { mentions: ["otto"] } : {}),
});

const dmMsg = (id: string, text: string): CotalMessage => ({
  id,
  ts: 10_000,
  space: cfg.space,
  from: { id: "orch", name: "Ada", role: "orchestrator" },
  to: cfg.name,
  parts: [{ kind: "text", text }],
});

try {
  // ── 1) THE MEASURED OCCUPANT: a join backfill with one live work order inside it ──────────────
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    for (let n = 0; n < 119; n++)
      agent.ep.emit("message", channelMsg(`h-${n}`, `RESTART NOTICE: old traffic ${n}`), noop(), historicalChannel);
    agent.ep.emit("message", dmMsg("order-1", "create PROOF.txt"), noop(), liveDm);

    const auto = agent.peekInbox("automatic");
    check("automatic delivery after a 119-message backfill is EXACTLY the live work order", auto.length === 1 && auto[0].id === "order-1", auto.map((i) => i.id).slice(0, 5));
    check("the wake count agrees: one pending wake, not 120", agent.pendingWake() === 1, agent.pendingWake());
    check("history was not dropped: all 119 remain possessed in the pull lane", agent.peekInbox("pull-only").length === 119, agent.peekInbox("pull-only").length);
    check("...and the full buffer holds backfill + order", agent.inboxCount() === 120, agent.inboxCount());
  }

  // ── 2) A HISTORICAL @MENTION IS DIRECTED CATCH-UP, not noise ──────────────────────────────────
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    agent.ep.emit("message", channelMsg("h-plain", "ambient history"), noop(), historicalChannel);
    agent.ep.emit("message", channelMsg("h-mention", "@otto please rule on this", true), noop(), historicalChannel);
    const auto = agent.peekInbox("automatic");
    check("the historical mention stays automatic while plain history does not", auto.length === 1 && auto[0].id === "h-mention", auto.map((i) => i.id));
  }

  // ── 3) POSSESSION: the pull lane serves the backfill on request, marked historical ────────────
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    for (let n = 0; n < 7; n++)
      agent.ep.emit("message", channelMsg(`h-${n}`, `backfill ${n}`), noop(), historicalChannel);
    const pulled = agent.peekInbox("pull-only");
    check("every backfilled item is recallable from the pull lane", pulled.length === 7, pulled.length);
    check("...each still carries its historical marking", pulled.every((i) => i.historical));
  }

  // ── 4) INVERSE CONTROL: LIVE channel ambient still wakes (open mode is not degraded) ──────────
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    agent.ep.emit("message", channelMsg("live-1", "a live peer speaks"), noop(), liveChannel);
    const auto = agent.peekInbox("automatic");
    check("live channel ambient remains automatic under open attention", auto.length === 1 && auto[0].id === "live-1", auto.map((i) => i.id));
    check("...and counts as a pending wake", agent.pendingWake() === 1, agent.pendingWake());
  }

  // ── 5) MAIL IS NEVER NOISE: a historical DM stays automatic ───────────────────────────────────
  {
    const agent = new MeshAgent(cfg);
    agent.on("error", () => {});
    agent.ep.emit("message", dmMsg("dm-h", "backfilled direct order"), noop(), historicalDm);
    const auto = agent.peekInbox("automatic");
    check("a historical DM is delivered automatically", auto.length === 1 && auto[0].id === "dm-h", auto.map((i) => i.id));
  }

  console.log(`\nhistory-flood smoke: ${pass} checks passed`);
} catch (err) {
  console.error(`\nhistory-flood smoke: FAILED after ${pass} checks`);
  throw err;
}
