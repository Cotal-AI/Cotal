/**
 * MeshView smoke test (no NATS, no test runner) — run with: pnpm smoke:view
 *
 * Drives a mock observer endpoint through MeshView and asserts the normalization the surfaces
 * depend on: delivery classification, same-sender/same-text unicast burst coalescing, the
 * status-sorted roster split, and the derived operator signals (counts + DM roll-up).
 */
import { EventEmitter } from "node:events";
import { MeshView } from "../src/view/mesh-view.js";
import {
  chatSubject,
  unicastSubject,
  anycastSubject,
  DEV_OWNER,
  type CotalEndpoint,
  type CotalMessage,
  type Presence,
} from "@cotal-ai/core";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

const space = "view-test";
const ids = { alice: "ID_ALICE", bob: "ID_BOB", carol: "ID_CAROL", con: "ID_CON" };

function presence(id: string, name: string, kind: "agent" | "endpoint", status: Presence["status"]): Presence {
  return { card: { id, name, kind, role: name }, status, ts: Date.now() };
}
const roster: Presence[] = [
  presence(ids.alice, "alice", "agent", "working"),
  presence(ids.bob, "bob", "agent", "waiting"),
  presence(ids.carol, "carol", "agent", "idle"),
  presence(ids.con, "console", "endpoint", "idle"),
];

type Routing = { channel: string } | { to: string } | { toService: string };
function msg(from: string, fromName: string, target: Routing, text: string, id: string): CotalMessage {
  return {
    id,
    ts: Date.now(),
    space,
    from: { id: from, name: fromName, role: fromName },
    parts: [{ kind: "text", text }],
    ...target,
  };
}

// ---- a mock observer endpoint: captures the tap, replays roster on demand ----
class MockEndpoint extends EventEmitter {
  readonly space = space;
  tapHandler?: (subject: string, m: CotalMessage | undefined) => void;
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getRoster(): Presence[] {
    return roster;
  }
  tap(handler: (subject: string, m: CotalMessage | undefined) => void): void {
    this.tapHandler = handler;
  }
  async listChannels(): Promise<{ channel: string; messages: number }[]> {
    return [];
  }
  async channelHistory(): Promise<CotalMessage[]> {
    return [];
  }
  async dmHistory(): Promise<CotalMessage[]> {
    return [];
  }
}

const mock = new MockEndpoint();
const view = new MeshView(mock as unknown as CotalEndpoint);
await view.start();

const tap = mock.tapHandler!;
// multicast + anycast pass through immediately; the unicast burst (same sender+text, 3
// recipients) coalesces into ONE entry over the 400ms window.
tap(chatSubject(space, DEV_OWNER, ids.alice, "general"), msg(ids.alice, "alice", { channel: "general" }, "hello team", "m1"));
tap(anycastSubject(space, "reviewer", DEV_OWNER, ids.alice), msg(ids.alice, "alice", { toService: "reviewer" }, "review pls", "m2"));
tap(unicastSubject(space, DEV_OWNER, ids.bob, DEV_OWNER, ids.alice), msg(ids.alice, "alice", { to: ids.bob }, "ping", "m3"));
tap(unicastSubject(space, DEV_OWNER, ids.carol, DEV_OWNER, ids.alice), msg(ids.alice, "alice", { to: ids.carol }, "ping", "m4"));
tap(unicastSubject(space, DEV_OWNER, ids.bob, DEV_OWNER, ids.alice), msg(ids.alice, "alice", { to: ids.bob }, "ping", "m5"));
// a control frame → deliveryOf null → must NOT enter the feed
tap(`cotal.${space}.ctl.manager.${DEV_OWNER}.${ids.alice}`, msg(ids.alice, "alice", { to: ids.bob }, "ignored", "m6"));

await wait(550); // let the unicast burst flush
const s = view.snapshot();

const chat = s.feed.find((e) => e.id === "m1");
const any = s.feed.find((e) => e.id === "m2");
const uni = s.feed.find((e) => e.delivery === "unicast");

check("feed has exactly 3 entries (control dropped, burst coalesced)", s.feed.length === 3);
check("multicast classified with channel", chat?.delivery === "multicast" && chat?.channel === "general");
check("anycast classified with service", any?.delivery === "anycast" && any?.toService === "reviewer");
check("unicast burst coalesced to one entry, count 3", uni?.count === 3);
check("unicast targets resolved to names", !!uni?.toNames?.includes("bob") && !!uni?.toNames?.includes("carol"));

check("roster split: 3 agents, 1 endpoint", s.agents.length === 3 && s.endpoints.length === 1);
check("agents status-sorted (working first, idle last)", s.agents[0].card.name === "alice" && s.agents[2].card.name === "carol");
check(
  "signals.counts over agents only",
  s.signals.counts.working === 1 && s.signals.counts.waiting === 1 && s.signals.counts.idle === 1 && s.signals.counts.offline === 0,
);
check("signals.waiting surfaces the blocked agent", s.signals.waiting.length === 1 && s.signals.waiting[0].card.name === "bob");

const aliceDm = s.signals.dms.find((p) => p.name === "alice");
check("DM roll-up: alice has 2 conversations (bob, carol)", aliceDm?.conversations.length === 2);
check("DM roll-up: 3 peers total (alice, bob, carol)", s.signals.dms.length === 3);
check("status bar: dmVisible true (open tap)", s.status.dmVisible === true && s.status.space === space);

await view.stop();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
