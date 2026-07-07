/**
 * Topology membership smoke (no NATS, no test runner) — run with: pnpm smoke:topo-membership
 *
 * Asserts foldTopo overlays the broker-authoritative membership feed onto the traffic graph:
 * silent subscribers become nodes, subscriptions become live/durable links, wide readers are
 * badged (no per-hub spoke), bounded wildcards expand against known channels, a member that also
 * has traffic is NOT double-counted, and an absent feed degrades to exactly the pre-change fold.
 */
import type { MembershipSnapshot, Presence } from "@cotal-ai/core";
import type { FeedEntry } from "../src/console/mesh.js";
import { foldTopo, membershipFreshness } from "../src/console/ui/topo/model.js";

let failures = 0;
function check(label: string, cond: boolean): void {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures++;
}

const NOW = 1_000_000_000_000;
const agent = (id: string, name: string, status: Presence["status"] = "idle"): Presence => ({
  card: { id, name, kind: "agent", role: name }, status, ts: NOW,
});
const feedMsg = (fromName: string, channel: string): FeedEntry => ({
  id: fromName + channel, ts: NOW - 1000, from: { id: "ID_" + fromName, name: fromName },
  delivery: "multicast", channel, text: "hi",
});

// Roster: alice is present + will have traffic; the membership feed also names a SILENT subscriber
// (bea, no traffic, not in roster) and a durable-offline member (cid) and a wide reader (wide).
const agents: Presence[] = [agent("ID_alice", "alice", "working")];
const feed: FeedEntry[] = [feedMsg("alice", "general")];
const membership: MembershipSnapshot = {
  asOf: NOW,
  members: [
    { id: "ID_alice", live: ["general"], durable: [], observedAt: NOW }, // also has traffic → must merge
    { id: "ID_bea", live: ["general"], durable: [], observedAt: NOW }, // SILENT subscriber
    { id: "ID_cid", live: [], durable: ["backend"], observedAt: NOW }, // durable-offline member
    { id: "ID_wide", live: [">"], durable: [], observedAt: NOW }, // wide reader
    { id: "ID_team", live: ["team.>"], durable: [], observedAt: NOW }, // bounded wildcard
  ],
};
const knownChannels = ["general", "backend", "team.build", "team.qa"];

// nameOf resolves the extra members (not in roster) to stable short names.
const nameOf = (id: string) => id.replace(/^ID_/, "");
const g = foldTopo(feed, agents, { membership, knownChannels, now: NOW, nameOf });

const node = (name: string) => g.byKey.get("a:" + name);
const links = (name: string) => g.memberships.filter((m) => m.agent === "a:" + name);

check("silent subscriber becomes a node (member, lastTs 0)", node("bea")?.member === true && node("bea")?.lastTs === 0);
check("silent subscriber → live link to its channel", links("bea").some((l) => l.channel === "c:general" && l.state === "live"));
check("silent channel hub materialized", g.byKey.has("c:general"));
check("durable-offline member → durable link", links("cid").some((l) => l.channel === "c:backend" && l.state === "durable"));
check("durable channel hub materialized", g.byKey.has("c:backend"));
check("wide reader flagged, no per-hub spoke", node("wide")?.wide === true && links("wide").length === 0);
check("bounded wildcard expands to both concretes (live)", (() => {
  const l = links("team").map((m) => m.channel).sort();
  return l.length === 2 && l[0] === "c:team.build" && l[1] === "c:team.qa" && links("team").every((m) => m.state === "live");
})());

// No double-count: alice has traffic AND membership → exactly one node, member:true, edge preserved.
const aliceNodes = g.nodes.filter((n) => n.key === "a:alice");
check("member with traffic → single node, member:true", aliceNodes.length === 1 && aliceNodes[0].member === true);
check("member with traffic keeps its traffic edge", g.edges.some((e) => e.src === "a:alice" && e.dst === "c:general"));

// Freshness pill.
check("freshness: available + fresh asOf → live", membershipFreshness(NOW, g.membership).label === "live");
check("freshness: available + old asOf → stale", membershipFreshness(NOW + 60_000, g.membership).label === "stale");

// Degrade: no membership → identical to the pre-change fold (regression guard).
const bare = foldTopo(feed, agents, { now: NOW });
check("degrade: no membership → empty memberships", bare.memberships.length === 0);
check("degrade: membership.available false", bare.membership.available === false);
check("degrade: freshness reads traffic-only", membershipFreshness(NOW, bare.membership).label === "traffic-only");
check("degrade: node set matches a plain fold (no phantom nodes)", bare.nodes.filter((n) => n.kind === "agent").length === 1);

console.log(`\n${failures === 0 ? "TOPO-MEMBERSHIP SMOKE OK ✅" : "TOPO-MEMBERSHIP SMOKE FAILED ❌"} (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
