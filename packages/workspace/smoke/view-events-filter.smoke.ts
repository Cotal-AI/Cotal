/**
 * THE `events.*` FILTER IN `MeshView`, and the cost argument it exists for.
 *
 * WHY A FILTER AT ALL. `listChannels()` derives an entry from every RETAINED CONCRETE SUBJECT, and
 * the chat stream caps per subject rather than by age or count, so a session's last frames are
 * retained indefinitely and the channel list grows by one row per agent that has ever run. Left
 * unfiltered, the tab strip buries the handful of channels a human talks on under one row per
 * historical agent.
 *
 * WHY THE ORDER IS THE LOAD-BEARING PART, and why one cell here counts calls rather than results.
 * Filtering AFTER the history fetch would enumerate every event channel, issue a `channelHistory`
 * round trip for each, and throw the results away: unbounded work to display nothing. That is a
 * performance defect, and it is invisible to any assertion about the final snapshot, because a
 * fetch-then-filter implementation produces exactly the same tabs and the same feed. The only way
 * to tell the two apart is to count what the endpoint was ASKED for, so this endpoint records every
 * `channelHistory` call and a cell asserts an event channel was never among them.
 *
 * WHAT THE FILTER DELIBERATELY DOES NOT DO: drop event traffic from the live feed. The channel list
 * and the feed are different questions. Hiding the rows would delete the only traffic this release
 * taught the console to draw, and delete it silently. Feed entries are MARKED instead, and a cell
 * below pins that they are still there.
 *
 * Run: pnpm smoke:view-events-filter
 */
import { EventEmitter } from "node:events";
import { MeshView } from "../src/view/mesh-view.js";
import { chatSubject, DEV_OWNER, type CotalEndpoint, type CotalMessage, type Presence } from "@cotal-ai/core";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

const space = "events-filter-test";
const AGENT = "ID_AGENT";

// The channel list a real mesh hands back once a few agents have run. Two chat channels a human
// talks on, three per-agent event channels, and the two near-misses the old prefix test also
// swallowed: a human channel under the `events.` prefix, and one whose remainder is not a principal.
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

function msg(id: string, channel: string, text: string): CotalMessage {
  return {
    id,
    ts: Date.now(),
    space,
    from: { id: AGENT, name: "alice", role: "agent" },
    parts: [{ kind: "text", text }],
    channel,
  } as CotalMessage;
}

class MockEndpoint extends EventEmitter {
  readonly space = space;
  tapHandler?: (subject: string, m: CotalMessage | undefined) => void;
  /** Every channel `channelHistory` was ASKED for. The order-of-operations evidence. */
  readonly historyAsked: string[] = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getRoster(): Presence[] { return []; }
  tap(handler: (subject: string, m: CotalMessage | undefined) => void): void { this.tapHandler = handler; }
  async listChannels(): Promise<{ channel: string; messages: number }[]> { return CHANNELS; }
  async channelHistory(channel: string): Promise<CotalMessage[]> {
    this.historyAsked.push(channel);
    return [msg(`h-${channel}`, channel, `history on ${channel}`)];
  }
  async dmHistory(): Promise<CotalMessage[]> { return []; }
}

const mock = new MockEndpoint();
const view = new MeshView(mock as unknown as CotalEndpoint);
await view.start();
await wait(150); // let the async prefill and the first channel poll settle

// ── THE ORDER, which is the only cell that can tell a filter from a post-filter ───────────────
c("channelHistory was asked for at least one channel (else every cell below is vacuous)",
  mock.historyAsked.length > 0, mock.historyAsked);
c("NO event channel was ever asked for history (the filter runs BEFORE the fetch)",
  EVENT_CHANNELS.every((e) => !mock.historyAsked.includes(e)), mock.historyAsked);
c("every kept channel WAS asked for history (the filter did not over-reach)",
  KEPT.every((k) => mock.historyAsked.includes(k)), mock.historyAsked);
c("exactly the kept channels were fetched, no more",
  mock.historyAsked.length === KEPT.length, mock.historyAsked);

// ── THE TAB STRIP ─────────────────────────────────────────────────────────────────────────────
const snap = view.snapshot();
const tabs = snap.channels.map((x) => x.channel);
c("event channels are not tabs", EVENT_CHANNELS.every((e) => !tabs.includes(e)), tabs);
c("chat channels are still tabs", ["general", "fix-lane"].every((k) => tabs.includes(k)), tabs);
c("`events.standup` is a tab: a human channel under the prefix is NOT machine traffic",
  tabs.includes("events.standup"), tabs);
c("`events.my-team.notes` is a tab: `-` is legal in a channel segment and illegal in a principal token",
  tabs.includes("events.my-team.notes"), tabs);

// ── THE LIVE FEED: marked, never dropped ──────────────────────────────────────────────────────
const tap = mock.tapHandler!;
tap(chatSubject(space, DEV_OWNER, AGENT, "general"), msg("live-chat", "general", "hello team"));
tap(chatSubject(space, DEV_OWNER, AGENT, "events.local.alice"), msg("live-evt", "events.local.alice", "frame"));
await wait(150);

const after = view.snapshot();
const chatRow = after.feed.find((e) => e.id === "live-chat");
const evtRow = after.feed.find((e) => e.id === "live-evt");
c("a live event-channel message still reaches the feed", evtRow !== undefined);
c("it is MARKED as event traffic", evtRow?.events === true, evtRow);
c("an ordinary chat row is not marked", chatRow !== undefined && chatRow.events === undefined, chatRow);

// ── AND A LIVE ARRIVAL DOES NOT CREATE A TAB ──────────────────────────────────────────────────
// The third filter site. Without it an event channel appears as a tab the moment a frame lands and
// disappears at the next poll, which reads as a flickering bug rather than as a filter.
const tabsAfter = after.channels.map((x) => x.channel);
c("a live frame on an event channel does not add a tab", !tabsAfter.includes("events.local.alice"), tabsAfter);
c("CONTROL: a live message on a NEW chat channel DOES add a tab", (() => {
  tap(chatSubject(space, DEV_OWNER, AGENT, "brand-new"), msg("live-new", "brand-new", "hi"));
  return true;
})());
await wait(150);
c("the new chat channel became a tab (so the cell above measures the filter, not a dead code path)",
  view.snapshot().channels.map((x) => x.channel).includes("brand-new"),
  view.snapshot().channels.map((x) => x.channel));

await view.stop();
console.log(`\nview-events-filter smoke: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
