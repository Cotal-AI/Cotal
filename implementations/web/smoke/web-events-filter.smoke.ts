/**
 * The dashboard lists and backfills CHAT, and an agent's event channel is not chat.
 *
 * WHAT THE DEFECT WAS. `/api/channels` and `/api/activity` both walked `listChannels()` with no
 * classifier: the sidebar listed one row per agent that has ever run, the graph page grew a hub node
 * for each, and the activity route issued one `channelHistory` round trip PER EVENT CHANNEL and then
 * merged the results into a global top-N nobody reading chat asked for. `listChannels()` derives a
 * row from every retained concrete subject and the chat stream caps per subject rather than by age,
 * so those rows never age out: the cost scales with the number of agents ever run.
 *
 * THE CLAIM THIS SUITE EXISTS TO MAKE IS ABOUT ORDER, NOT ABOUT OUTPUT. Filtering the merged result
 * would produce the same JSON while still paying every round trip. So the load-bearing cell is not
 * "no event channel appears in the answer" but "no event channel was ever ASKED FOR", and the mock
 * records exactly that. A suite that only checked the output would pass against the version this
 * change replaces.
 *
 * IT USES THE REAL CLASSIFIER, NOT A LOCAL PREFIX TEST. `isEventChannel` is a full derivation rather
 * than `startsWith("events.")`, and the difference is a silent chat loss: a human channel called
 * `events.standup` is not principal-shaped, so it must stay in the sidebar. Those near-misses are in
 * the fixture data below and asserted in both directions, because a filter that is too eager deletes
 * a person's messages from the view they were sent to.
 *
 * WHAT IS DELIBERATELY NOT FILTERED is asserted here too, as SOURCE-SHAPE cells and labelled as
 * such: the live SSE tap (frames are marked, never dropped) and `/api/channels/<name>/history` (a
 * caller naming an event channel gets it, or the surface could render a frame it could never fetch).
 * Those two are pinned by reading the shipped source rather than by executing a request, because the
 * request handler is a closure inside `web()` and no seam reaches it. Stated as the weaker evidence
 * it is, so a later reader does not mistake it for a behavioural test.
 *
 * Run: pnpm smoke:web-events-filter
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CotalMessage } from "@cotal-ai/core";
import { activityBackfill, chatOnly, type ActivitySource } from "../src/web.js";

const here = dirname(fileURLToPath(import.meta.url));

let cells = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

// The channel list a real mesh hands back once a few agents have run: two channels a human talks on,
// three per-agent event channels, and the two near-misses a bare prefix test also swallowed.
const CHANNELS = [
  { channel: "general", messages: 12 },
  { channel: "fix-lane", messages: 4 },
  { channel: "events.local.alice", messages: 900 },
  { channel: "events.local.bob", messages: 850 },
  { channel: "events.acme.carol", messages: 77 },
  { channel: "events.standup", messages: 3 },
  { channel: "events.my-team.notes", messages: 2 },
];
const EVENT_CHANNELS = ["events.local.alice", "events.local.bob", "events.acme.carol"];
const KEPT = ["general", "fix-lane", "events.standup", "events.my-team.notes"];

let n = 0;
const msg = (channel: string, ts: number): CotalMessage =>
  ({
    id: `m${++n}`,
    ts,
    space: "filter-test",
    from: { id: "ID_A", name: "alice", role: "agent" },
    parts: [{ kind: "text", text: `on ${channel}` }],
    channel,
  }) as CotalMessage;

/** Records every channel history was ASKED for. That list is the order-of-operations evidence. */
class Source implements ActivitySource {
  readonly historyAsked: string[] = [];
  readonly limitsSeen: number[] = [];
  dmAsked = 0;
  constructor(private readonly rows = CHANNELS) {}
  async listChannels() {
    return this.rows.map((r) => ({ ...r }));
  }
  async channelHistory(channel: string, opts: { limit: number }): Promise<CotalMessage[]> {
    this.historyAsked.push(channel);
    this.limitsSeen.push(opts.limit);
    // Two messages per channel, timestamps spread so the merge order is observable.
    const base = 1000 + this.historyAsked.length * 10;
    return [msg(channel, base), msg(channel, base + 1)];
  }
  async dmHistory(opts: { limit: number }): Promise<CotalMessage[]> {
    this.dmAsked++;
    this.limitsSeen.push(opts.limit);
    return [msg("dm", 5000)];
  }
}

console.log("web-events-filter smoke");

// ── 1. the classifier, in both directions ────────────────────────────────────────────────────────
{
  const kept = chatOnly(CHANNELS).map((c) => c.channel);
  ok("1.1 every per-agent event channel is dropped", EVENT_CHANNELS.every((c) => !kept.includes(c)), kept);
  ok("1.2 the chat channels are kept", kept.includes("general") && kept.includes("fix-lane"));
  ok("1.3 `events.standup` STAYS: prefix-shaped, not principal-shaped", kept.includes("events.standup"));
  ok("1.4 `events.my-team.notes` STAYS: a hyphen is not an owner token", kept.includes("events.my-team.notes"));
  ok("1.5 exactly the expected set, no more and no fewer", JSON.stringify(kept) === JSON.stringify(KEPT), kept);
  ok("1.6 order is preserved", kept[0] === "general");

  // CONTROL. Without this, 1.3 and 1.4 could pass against a filter that is simply broken, and the
  // whole point of using the derivation over a prefix test would be unmeasured.
  const naive = CHANNELS.filter((c) => !c.channel.startsWith("events.")).map((c) => c.channel);
  ok("1.7 CONTROL: a bare prefix test would have deleted both near-misses", naive.length === 2 && !naive.includes("events.standup"), naive);

  ok("1.8 an empty list yields an empty list", chatOnly([]).length === 0);
}

// ── 2. the backfill asks only for chat, and asks BEFORE it merges ────────────────────────────────
{
  const src = new Source();
  const out = await activityBackfill(src, 200);

  ok("2.1 no event channel was ever ASKED for", EVENT_CHANNELS.every((c) => !src.historyAsked.includes(c)), src.historyAsked);
  ok("2.2 history was asked for exactly the chat channels", JSON.stringify(src.historyAsked) === JSON.stringify(KEPT), src.historyAsked);
  ok("2.3 four round trips, not seven", src.historyAsked.length === 4, src.historyAsked.length);
  ok("2.4 the limit is passed down", src.limitsSeen.every((l) => l === 200));
  ok("2.5 DM history is still read", src.dmAsked === 1);

  const chatRows = out.filter((e) => e.mode === "chat") as { mode: "chat"; channel: string; msg: CotalMessage }[];
  ok("2.6 no event-channel message reaches the feed", chatRows.every((e) => !EVENT_CHANNELS.includes(e.channel)));
  ok("2.7 chat rows are tagged with the channel the SERVER requested", chatRows.every((e) => e.channel === e.msg.channel));
  ok("2.8 DMs are merged as unicast", out.some((e) => e.mode === "unicast"));
  ok("2.9 oldest first", out.every((e, i) => i === 0 || out[i - 1].msg.ts <= e.msg.ts));
  ok("2.10 the DM is newest, so it survives the cap", out[out.length - 1]?.mode === "unicast");
}

// ── 3. the cap keeps the NEWEST, which is what a top-N means ─────────────────────────────────────
{
  const src = new Source();
  const out = await activityBackfill(src, 3);
  ok("3.1 capped to the limit", out.length === 3, out.length);
  ok("3.2 and it is the newest three, not the first three", out[out.length - 1]?.mode === "unicast");
}

// ── 4. a mesh with nothing but event channels ────────────────────────────────────────────────────
{
  const src = new Source(EVENT_CHANNELS.map((channel) => ({ channel, messages: 10 })));
  const out = await activityBackfill(src, 200);
  ok("4.1 no history round trip at all", src.historyAsked.length === 0, src.historyAsked);
  ok("4.2 the feed is DMs only, not an error", out.every((e) => e.mode === "unicast"));
}

// ── 5. what is NOT filtered, pinned as SOURCE-SHAPE claims ──────────────────────────────────────
// Weaker evidence than the cells above, and labelled so: the request handler is a closure inside
// `web()`, so these read the shipped source instead of issuing a request.
{
  const src = readFileSync(join(here, "..", "src", "web.ts"), "utf8");
  // Two call sites: the channel list and the activity backfill. The declaration carries a type
  // parameter (`chatOnly<T extends ...>`) so it does not match this pattern and is not counted. A
  // third call site is a behaviour change this cell should force someone to look at.
  const calls = src.split("chatOnly(").length - 1;
  ok("5.1 SOURCE-SHAPE: chatOnly has exactly two call sites", calls === 2, calls);

  const byName = src.slice(src.indexOf('path.startsWith("/api/channels/")'));
  const routeBody = byName.slice(0, byName.indexOf("}"));
  ok("5.2 SOURCE-SHAPE: the by-name history route applies no filter", !routeBody.includes("chatOnly"), routeBody.slice(0, 200));
  ok("5.3 SOURCE-SHAPE: it still serves whatever channel is named", routeBody.includes("channelHistory"));

  const tap = src.slice(src.indexOf("ep.tap("), src.indexOf("ep.tap(") + 200);
  ok("5.4 SOURCE-SHAPE: the live tap is not filtered, so frames stay visible", !tap.includes("chatOnly"), tap.slice(0, 120));
}

console.log(`web-events-filter smoke: ${cells - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
