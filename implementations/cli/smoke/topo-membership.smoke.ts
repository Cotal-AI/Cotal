/**
 * Topology membership smoke (no NATS, no test runner): pnpm --filter @cotal-ai/cli test
 *
 * Two halves. The FOLD: `foldTopo` overlays the broker-authoritative membership feed onto the
 * traffic graph (silent subscribers become nodes, subscriptions become live/durable links, wide
 * readers are badged rather than spoked, bounded wildcards expand against known channels, a member
 * that also has traffic is not double-counted, and an absent feed leaves the fold as it was). The
 * MODEL: `MeshView` reads and watches the feed through a stub endpoint and classifies what it saw
 * into the four states the header pill can honestly say, with the error path driven for real: a
 * failed read is `unreadable` with its reason and its overlay withheld, an absent bucket is
 * `traffic-only`, a later successful read clears the reason, a failed watch is named as such.
 */
import { EventEmitter } from "node:events";
import type { CotalEndpoint, MembershipSnapshot, Presence } from "@cotal-ai/core";
import type { FeedEntry } from "../src/console/mesh.js";
import { MeshView, type MembershipView } from "../src/view/mesh-view.js";
import { foldTopo, membershipFreshness } from "../src/console/ui/topo/model.js";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) { failures++; if (extra !== undefined) console.log("   ", extra); }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NOW = 1_000_000_000_000;
const agent = (id: string, name: string, status: Presence["status"] = "idle"): Presence => ({
  card: { id, name, kind: "agent", role: name }, status, ts: NOW,
});
const feedMsg = (fromName: string, channel: string): FeedEntry => ({
  id: fromName + channel, ts: NOW - 1000, from: { id: "ID_" + fromName, name: fromName },
  delivery: "multicast", channel, text: "hi",
});

console.log("1. the fold overlays a readable snapshot");
// Roster: alice is present and has traffic; the feed also names a SILENT subscriber (bea, no
// traffic, not on the roster), a durable-offline member (cid), a wide reader, and a bounded wildcard.
const agents: Presence[] = [agent("ID_alice", "alice", "working")];
const feed: FeedEntry[] = [feedMsg("alice", "general")];
const snapshot: MembershipSnapshot = {
  asOf: NOW,
  members: [
    { id: "ID_alice", live: ["general"], durable: [], observedAt: NOW },
    { id: "ID_bea", live: ["general"], durable: [], observedAt: NOW },
    { id: "ID_cid", live: [], durable: ["backend"], observedAt: NOW },
    { id: "ID_wide", live: [">"], durable: [], observedAt: NOW },
    { id: "ID_team", live: ["team.>"], durable: [], observedAt: NOW },
  ],
};
const knownChannels = ["general", "backend", "team.build", "team.qa"];
const nameOf = (id: string) => id.replace(/^ID_/, "");
const g = foldTopo(feed, agents, { membership: { snapshot }, knownChannels, now: NOW, nameOf });
const node = (name: string) => g.byKey.get("a:" + name);
const links = (name: string) => g.memberships.filter((m) => m.agent === "a:" + name);
check("silent subscriber becomes a node (member, lastTs 0)", node("bea")?.member === true && node("bea")?.lastTs === 0);
check("silent subscriber gets a live link to its channel", links("bea").some((l) => l.channel === "c:general" && l.state === "live"));
check("silent channel hub materialized", g.byKey.has("c:general"));
check("durable-offline member gets a durable link", links("cid").some((l) => l.channel === "c:backend" && l.state === "durable"));
check("durable channel hub materialized", g.byKey.has("c:backend"));
check("wide reader flagged, no per-hub spoke", node("wide")?.wide === true && links("wide").length === 0);
check("bounded wildcard expands to both concretes (live)", (() => {
  const l = links("team").map((m) => m.channel).sort();
  return l.length === 2 && l[0] === "c:team.build" && l[1] === "c:team.qa" && links("team").every((m) => m.state === "live");
})());
const aliceNodes = g.nodes.filter((n) => n.key === "a:alice");
check("a member with traffic is one node, member:true", aliceNodes.length === 1 && aliceNodes[0].member === true);
check("a member with traffic keeps its traffic edge", g.edges.some((e) => e.src === "a:alice" && e.dst === "c:general"));

console.log("2. the fold withholds an overlay it could not read, and degrades cleanly when there is none");
const disowned = foldTopo(feed, agents, { membership: { snapshot, unreadable: "permissions violation" }, knownChannels, now: NOW, nameOf });
check("an unreadable feed draws NO membership links, even with a last snapshot in hand", disowned.memberships.length === 0);
check("...and adds no phantom nodes", disowned.nodes.filter((n) => n.kind === "agent").length === 1);
const bare = foldTopo(feed, agents, { now: NOW });
check("no feed at all: no memberships, no phantom nodes", bare.memberships.length === 0 && bare.nodes.filter((n) => n.kind === "agent").length === 1);

console.log("3. the four pill states, in the order that keeps them honest");
const fresh = (m: MembershipView, now = NOW) => membershipFreshness(now, m);
check("a snapshot with a young heartbeat reads live", fresh({ snapshot }).label === "live");
check("a snapshot older than 45 s reads stale", fresh({ snapshot }, NOW + 60_000).label === "stale");
check("a snapshot with members but no heartbeat reads stale (no freshness to claim)", fresh({ snapshot: { asOf: undefined, members: snapshot.members } }).label === "stale");
check("an empty, never-written feed reads traffic-only", fresh({ snapshot: { asOf: undefined, members: [] } }).label === "traffic-only");
check("no read yet reads traffic-only", fresh({}).label === "traffic-only");
const un = fresh({ snapshot, unreadable: "permissions violation" });
check("a failing read reads unreadable WITH its reason, even over a live snapshot", un.label === "unreadable" && un.reason === "permissions violation", un);
// The two cases that pin the ORDER rather than just the labels: an unreadable feed whose snapshot
// is empty or missing satisfies the traffic-only test too, so only checking `unreadable` FIRST
// keeps "we could not read it" from being reported as "the mesh has no daemon writing one".
check(
  "a failing read over an empty snapshot reads unreadable, not traffic-only",
  fresh({ snapshot: { asOf: undefined, members: [] }, unreadable: "permissions violation" }).label === "unreadable",
  fresh({ snapshot: { asOf: undefined, members: [] }, unreadable: "permissions violation" }),
);
check(
  "a failing read with no snapshot at all reads unreadable, not traffic-only",
  fresh({ unreadable: "permissions violation" }).label === "unreadable",
  fresh({ unreadable: "permissions violation" }),
);

console.log("4. MeshView classifies what its endpoint answers (the error path driven for real)");
/** The smallest endpoint MeshView.start() touches, with the two membership calls scripted. */
class StubEndpoint extends EventEmitter {
  space = "stub";
  readAnswer: () => Promise<MembershipSnapshot> = () => Promise.resolve({ asOf: NOW, members: [] });
  watchAnswer: (cb: () => void) => Promise<{ stop(): Promise<void> }> = (cb) => { this.onChange = cb; return Promise.resolve({ stop: async () => {} }); };
  onChange?: () => void;
  async start() {}
  async stop() {}
  getRoster(): Presence[] { return []; }
  tap() {}
  async listChannels() { return []; }
  async dmHistory() { return []; }
  ref() { return { id: "stub", name: "stub" }; }
  readMembership() { return this.readAnswer(); }
  watchMembership(cb: () => void) { return this.watchAnswer(cb); }
}
async function viewOver(stub: StubEndpoint): Promise<{ view: MeshView; m: () => MembershipView }> {
  const view = new MeshView(stub as unknown as CotalEndpoint, {});
  await view.start();
  await wait(50);
  return { view, m: () => view.snapshot().membership };
}
{
  const stub = new StubEndpoint();
  stub.readAnswer = () => Promise.reject(new Error("permissions violation for subscription to KV_cotal_membership_stub"));
  const { view, m } = await viewOver(stub);
  check("a read that throws lands as unreadable, reason kept", m().unreadable !== undefined && /permissions violation/.test(m().unreadable ?? ""), m());
  check("...and never as a connection error", view.snapshot().status.error === undefined, view.snapshot().status);
  check("...and the pill says unreadable", membershipFreshness(NOW, m()).label === "unreadable");
  // The watch fires, the read now succeeds: the reason clears and the snapshot is live.
  stub.readAnswer = () => Promise.resolve(snapshot);
  stub.onChange?.();
  await wait(300);
  check("a later successful read clears the reason and carries the snapshot", m().unreadable === undefined && m().snapshot?.asOf === NOW, m());
  await view.stop();
}
{
  const stub = new StubEndpoint();
  const missing = Object.assign(new Error("stream not found"), { api_error: { err_code: 10059 }, code: 404 });
  stub.readAnswer = () => Promise.reject(missing);
  stub.watchAnswer = () => Promise.reject(missing);
  const { view, m } = await viewOver(stub);
  check("an absent bucket (no daemon) is traffic-only, not unreadable", m().unreadable === undefined && membershipFreshness(NOW, m()).label === "traffic-only", m());
  await view.stop();
}
{
  const stub = new StubEndpoint();
  stub.watchAnswer = () => Promise.reject(new Error("watch refused"));
  const { view, m } = await viewOver(stub);
  check("a failing WATCH over a readable feed is named as the watch's failure", /^watch: watch refused/.test(m().unreadable ?? ""), m());
  await view.stop();
}
{
  const stub = new StubEndpoint();
  stub.readAnswer = () => Promise.resolve(snapshot);
  const { view, m } = await viewOver(stub);
  check("a readable feed is carried as the snapshot, no reason", m().unreadable === undefined && m().snapshot?.members.length === 5, m());
  await view.stop();
}

console.log(`\n${failures === 0 ? "TOPO-MEMBERSHIP SMOKE OK ✅" : "TOPO-MEMBERSHIP SMOKE FAILED ❌"} (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
