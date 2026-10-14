/** The mesh graph's model: which agents and channels are nodes, which links join them and which are
 *  hot. Ported from the old graph.js (`updateRoster`, `onMessage`, `isHidden`, `recomputeHubEmpty`).
 *  Pure, so a link is hot or cold by the `now` the test passes and no cell sleeps.
 *
 *  Restores the graph-boot G5 rule that the foundation phase deferred: a unicast never creates a
 *  node. Also covers `memberChannels` and `patternMatches`, which no suite covered until now. */
import type { ChannelInfo, CotalMessage, MembershipSnapshot, RosterEntry } from "../client/src/api/types.js";
import { memberChannels, patternMatches } from "../client/src/lib/membership.js";
import { topologyModel, type TopoLink, type TopoModel } from "../client/src/lib/topology.js";

let cells = 0, failed = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  cells++;
  if (cond) return console.log(`  ok ${cells} ${name}`);
  failed++;
  console.log(`  x FAIL ${cells} ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

const NOW = 1_000_000;
const agent = (id: string, name: string, status: RosterEntry["status"] = "idle", extra: Partial<RosterEntry["card"]> = {}): RosterEntry =>
  ({ card: { id, name, kind: "agent", ...extra }, status, ts: NOW } as unknown as RosterEntry);
const chan = (channel: string): ChannelInfo => ({ channel, messages: 0, replay: false, deliveryClass: "live" });
const entry = (id: string, live: string[], durable: string[] = []) => ({ id, live, durable, observedAt: 1 });
const feed = (members: ReturnType<typeof entry>[], asOf = NOW): { snapshot: MembershipSnapshot } => ({ snapshot: { asOf, members } });
const msgOf = (from: string, extra: object): CotalMessage => ({ id: "m", ts: NOW, space: "s", from: { id: from, name: "payload-name" }, parts: [], ...extra }) as unknown as CotalMessage;
const chat = (channel: string, sender: string, ts = NOW) => ({ mode: "chat", channel, senderId: sender, msg: msgOf(sender, { channel }), ts });
const unicast = (sender: string, to: string, ts = NOW) => ({ mode: "unicast", senderId: sender, msg: msgOf(sender, { to }), ts });
const anycast = (sender: string, ts = NOW) => ({ mode: "anycast", senderId: sender, msg: msgOf(sender, { toService: "reviewer" }), ts });

type Input = Parameters<typeof topologyModel>[0];
const model = (over: Partial<Input> = {}): TopoModel =>
  topologyModel({ roster: [], channels: [], membership: {}, recent: [], hideOffline: false, hideEmpty: false, now: NOW, ...over });
const node = (m: TopoModel, id: string) => m.nodes.find((n) => n.id === id);
const link = (m: TopoModel, source: string, target: string): TopoLink | undefined => m.links.find((l) => l.source === source && l.target === target);
const ids = (m: TopoModel) => m.nodes.map((n) => n.id).sort();

const ROSTER = [agent("A", "ana", "working", { meta: { connector: "claude" } }), agent("B", "bo"), agent("C", "cy")];

// 1. nodes: names are labels, ids are keys
{
  const m = model({ roster: [agent("A", "same"), agent("B", "same")], channels: [chan("alerts")] });
  ok("agent nodes are keyed by roster id, so two agents with one name stay two nodes", ids(m).filter((i) => i === "A" || i === "B").length === 2, ids(m));
  ok("an agent node is labelled by its roster name", node(m, "A")?.label === "same" && node(m, "A")?.kind === "agent");
  const v = model({ roster: ROSTER });
  ok("an agent node carries its vendor from the card's connector", node(v, "A")?.vendor === "claude" && node(v, "B")?.vendor === undefined, v.nodes);
  ok("an agent node carries its roster status", node(v, "A")?.status === "working" && node(v, "B")?.status === "idle");
  const e = model({ roster: [agent("E", "endpoint-thing", "idle", { kind: "endpoint" } as never), agent("A", "ana")] });
  ok("an endpoint in the roster is not a node", node(e, "E") === undefined && node(e, "A") !== undefined, ids(e));
  ok("a channel node is labelled by its name and is not an agent", model({ channels: [chan("alerts")] }).nodes.every((n) => n.kind === "channel" && n.label === "alerts"));
}

// 2. membership links
{
  const m = model({ roster: ROSTER, channels: [chan("alerts"), chan("ops"), chan("team.web")], membership: feed([entry("A", ["alerts", "team.>"]), entry("B", [], ["ops"])]) });
  const alerts = m.nodes.find((n) => n.kind === "channel" && n.label === "alerts")!;
  const ops = m.nodes.find((n) => n.kind === "channel" && n.label === "ops")!;
  const web = m.nodes.find((n) => n.kind === "channel" && n.label === "team.web")!;
  ok("a live subscription is a member link", link(m, "A", alerts.id)?.kind === "member", m.links);
  ok("a durable-only subscription is a durable link", link(m, "B", ops.id)?.kind === "durable", m.links);
  ok("a bounded wildcard links to the listed channels it matches", link(m, "A", web.id)?.kind === "member", m.links);
  ok("an agent with no subscription has no link", !m.links.some((l) => l.source === "C"), m.links);
  ok("every membership link is cold when nothing flowed", m.links.every((l) => !l.hot), m.links);
  const stale = model({ roster: ROSTER, channels: [chan("alerts")], membership: { ...feed([entry("A", ["alerts"])]), unreadable: "read failed" } });
  ok("an unreadable feed draws no membership overlay", stale.links.length === 0, stale.links);
  const heldWide = model({ roster: ROSTER, channels: [chan("alerts")], membership: { ...feed([entry("A", [">"]), entry("B", ["solo"])]), unreadable: "read failed" } });
  const absent = model({ roster: ROSTER, channels: [chan("alerts")], membership: {} });
  ok("an unreadable feed holding a snapshot yields the same nodes and links as an absent feed", JSON.stringify(heldWide) === JSON.stringify(absent), heldWide);
  ok("an unreadable feed marks no wide badge and draws no channel of its own", node(heldWide, "A")?.wide !== true && !heldWide.nodes.some((n) => n.label === "solo"), heldWide.nodes);
  const staleGhost = model({ roster: ROSTER, membership: { ...feed([entry("Z", ["alerts"])]), unreadable: "read failed" } });
  ok("an unreadable feed brings in no member the roster lacks", node(staleGhost, "Z") === undefined, staleGhost.nodes);
  const staleChat = model({ roster: ROSTER, membership: { ...feed([entry("A", ["alerts"])]), unreadable: "read failed" }, recent: [chat("alerts", "A")] });
  ok("chat still draws under an unreadable feed, as a traffic link", staleChat.links.length === 1 && staleChat.links[0]!.kind === "traffic", staleChat.links);
  const unlisted = model({ roster: ROSTER, membership: feed([entry("A", ["solo"])]) });
  ok("a concrete subscription to an unlisted channel still draws its channel", unlisted.nodes.some((n) => n.kind === "channel" && n.label === "solo") && unlisted.links.length === 1, unlisted);
  const ghost = model({ roster: ROSTER, membership: feed([entry("Z", ["alerts"])]) });
  ok("a member the roster never announced is a node labelled by a short id, not a payload name", node(ghost, "Z")?.kind === "agent" && node(ghost, "Z")?.label === "Z", ghost.nodes);
  ok("and it reads as offline, since no presence backs it", node(ghost, "Z")?.status === "offline");
}

// 3. a `>` reader is wide and gets no per-channel links
{
  const m = model({ roster: ROSTER, channels: [chan("alerts"), chan("ops")], membership: feed([entry("A", [">"]), entry("B", ["alerts"])]) });
  ok("a > reader is marked wide", node(m, "A")?.wide === true, node(m, "A"));
  ok("a > reader has no per-channel links", !m.links.some((l) => l.source === "A"), m.links);
  ok("an agent that is not a wide reader is not marked wide", node(m, "B")?.wide !== true);
  const star = model({ roster: ROSTER, membership: feed([entry("A", ["*"])]) });
  ok("a * reader is marked wide too", node(star, "A")?.wide === true);
}

// 4. traffic never invents a node, except a chat on a channel
{
  const base = model({ roster: ROSTER, channels: [chan("alerts")] });
  const uni = model({ roster: ROSTER, channels: [chan("alerts")], recent: [unicast("A", "B")] });
  ok("a unicast between two known agents adds no node", ids(uni).join() === ids(base).join(), ids(uni));
  ok("a unicast between two known agents adds no link", uni.links.length === 0, uni.links);
  const stranger = model({ roster: ROSTER, recent: [unicast("S", "R"), unicast("A", "R")] });
  ok("a unicast naming an unknown sender and recipient adds no node", ids(stranger).join() === "A,B,C", ids(stranger));
  const tagged = model({ roster: ROSTER, recent: [{ ...unicast("A", "B"), channel: "ghost" }] });
  ok("a unicast never creates a channel node", !tagged.nodes.some((n) => n.kind === "channel"), tagged.nodes);
  const any = model({ roster: ROSTER, recent: [anycast("A"), anycast("S")] });
  ok("an anycast adds no node and no link", ids(any).join() === "A,B,C" && any.links.length === 0, any);
  const anyTagged = model({ roster: ROSTER, recent: [{ ...anycast("A"), channel: "ghost" }] });
  ok("an anycast never creates a channel node", !anyTagged.nodes.some((n) => n.kind === "channel"));
  const posted = model({ roster: ROSTER, recent: [chat("fresh", "A")] });
  ok("a chat message on an unlisted channel creates its channel node", posted.nodes.some((n) => n.kind === "channel" && n.label === "fresh"), posted.nodes);
  ok("and the poster gets a traffic link to it", posted.links.length === 1 && posted.links[0]!.kind === "traffic" && posted.links[0]!.source === "A", posted.links);
  const unk = model({ recent: [chat("fresh", "S")] });
  ok("a chat sender the roster never announced becomes a node labelled by id, not by the payload name", node(unk, "S")?.label === "S" && unk.nodes.length === 2, unk.nodes);
  const member = model({ roster: ROSTER, channels: [chan("alerts")], membership: feed([entry("A", ["alerts"])]), recent: [chat("alerts", "A")] });
  ok("a poster who is a member keeps its member link, with no second link", member.links.length === 1 && member.links[0]!.kind === "member", member.links);
  const blank = model({ roster: ROSTER, recent: [chat("fresh", "")] });
  ok("a chat with a blank sender id makes no agent node", ids(blank).every((i) => i !== ""), ids(blank));
}

// 5. hide offline
{
  const roster = [agent("A", "ana", "working"), agent("D", "dee", "offline")];
  const membership = feed([entry("A", ["alerts"]), entry("D", ["alerts"], ["ops"])]);
  const shown = model({ roster, channels: [chan("alerts")], membership, hideOffline: false });
  const hidden = model({ roster, channels: [chan("alerts")], membership, hideOffline: true });
  ok("an offline agent is shown when hideOffline is off", node(shown, "D") !== undefined);
  ok("an offline agent is hidden when hideOffline is on", node(hidden, "D") === undefined, ids(hidden));
  ok("the online agent stays", node(hidden, "A") !== undefined);
  ok("a hidden agent's links go with it", !hidden.links.some((l) => l.source === "D"), hidden.links);
  const durable = model({ roster: [agent("A", "ana", "working")], membership: feed([entry("A", ["alerts"], ["ops"])]), hideOffline: true });
  ok("a durable-only link of an online agent is hidden by hideOffline", !durable.links.some((l) => l.kind === "durable") && durable.links.some((l) => l.kind === "member"), durable.links);
  const durableShown = model({ roster: [agent("A", "ana", "working")], membership: feed([entry("A", ["alerts"], ["ops"])]), hideOffline: false });
  ok("the same durable link shows when hideOffline is off", durableShown.links.some((l) => l.kind === "durable"), durableShown.links);
  const gone = model({ membership: feed([entry("Z", ["alerts"])]), hideOffline: true });
  ok("a member with no presence is hidden by hideOffline", node(gone, "Z") === undefined, ids(gone));
}

// 6. hide empty
{
  const roster = [agent("A", "ana", "working")];
  const channels = [chan("alerts"), chan("quiet")];
  const authoritative = feed([entry("A", ["alerts"])]);
  const m = model({ roster, channels, membership: authoritative, hideEmpty: true });
  ok("a channel with no members is hidden when hideEmpty and the feed is authoritative", !m.nodes.some((n) => n.label === "quiet"), ids(m));
  ok("a channel with a member stays", m.nodes.some((n) => n.label === "alerts"));
  ok("hideEmpty off keeps the empty channel", model({ roster, channels, membership: authoritative, hideEmpty: false }).nodes.some((n) => n.label === "quiet"));
  const traffic = model({ roster, channels, membership: {}, hideEmpty: true });
  ok("a channel with no members is not hidden when the feed is traffic-only", traffic.nodes.some((n) => n.label === "quiet"), ids(traffic));
  const unreadable = model({ roster, channels, membership: { ...authoritative, unreadable: "read failed" }, hideEmpty: true });
  ok("nor when the feed is unreadable, even though it holds the last snapshot", unreadable.nodes.some((n) => n.label === "quiet"), ids(unreadable));
  const onlyOffline = [agent("D", "dee", "offline")];
  const offlineOnly = feed([entry("D", ["alerts"])]);
  ok("a channel whose only member is offline is empty while offline agents are hidden",
    !model({ roster: onlyOffline, channels: [chan("alerts")], membership: offlineOnly, hideOffline: true, hideEmpty: true }).nodes.some((n) => n.label === "alerts"));
  ok("and is not empty while offline agents are shown",
    model({ roster: onlyOffline, channels: [chan("alerts")], membership: offlineOnly, hideOffline: false, hideEmpty: true }).nodes.some((n) => n.label === "alerts"));
  const wideOnly = model({ roster, channels: [chan("alerts")], membership: feed([entry("A", [">"])]), hideEmpty: true });
  ok("a wide reader does not keep a channel from being empty", !wideOnly.nodes.some((n) => n.label === "alerts"), ids(wideOnly));
  const hiddenTarget = model({ roster, channels: [chan("quiet")], membership: authoritative, recent: [chat("quiet", "A")], hideEmpty: true });
  ok("a link to a hidden channel is dropped with it", !hiddenTarget.nodes.some((n) => n.label === "quiet") && !hiddenTarget.links.some((l) => l.target === "#quiet"), hiddenTarget);
}

// 7. hot links
{
  const roster = ROSTER;
  const membership = feed([entry("A", ["alerts"]), entry("B", ["alerts"]), entry("C", ["ops"])]);
  const at = (age: number) => model({ roster, channels: [chan("alerts"), chan("ops")], membership, recent: [chat("alerts", "A", NOW - age)] });
  const hot = (m: TopoModel, who: string) => m.links.find((l) => l.source === who && l.target.endsWith("alerts"))?.hot;
  ok("the poster's link is hot just after the message", hot(at(0), "A") === true, at(0).links);
  ok("and hot at 1999 ms", hot(at(1999), "A") === true);
  ok("and cold at 2000 ms", hot(at(2000), "A") === false);
  ok("and cold long after", hot(at(60_000), "A") === false);
  ok("another member's link on the same channel is hot too, as the post fans out", hot(at(500), "B") === true, at(500).links);
  ok("a link on another channel stays cold", at(500).links.find((l) => l.source === "C")?.hot === false);
  const trafficHot = model({ roster, recent: [chat("fresh", "A", NOW - 100)] });
  ok("a traffic link is hot after its post and cold after 2 seconds", trafficHot.links[0]!.hot === true && model({ roster, recent: [chat("fresh", "A", NOW - 2500)] }).links[0]!.hot === false);
  const nobody = model({ roster, channels: [chan("alerts")], membership, recent: [chat("alerts", "")] });
  ok("a post with no sender id heats nothing", nobody.links.every((l) => !l.hot), nobody.links);
  const dm = model({ roster, channels: [chan("alerts")], membership, recent: [unicast("A", "B", NOW), anycast("A", NOW)] });
  ok("a unicast or an anycast heats no link", dm.links.every((l) => !l.hot), dm.links);
  ok("heat follows the now argument, with no clock read", model({ roster, membership, channels: [chan("alerts")], recent: [chat("alerts", "A", NOW)], now: NOW + 5000 }).links.every((l) => !l.hot));
}

// 8. memberChannels and patternMatches, which no suite covered
{
  const known = ["team.backend", "team.web", "team", "alerts"];
  const mc = memberChannels(["team.>", "alerts"], [], known);
  ok("a bounded wildcard expands against the known channels", mc.channels.get("team.backend") === "live" && mc.channels.get("team.web") === "live", [...mc.channels]);
  ok("a bounded wildcard does not reach its bare prefix", !mc.channels.has("team"), [...mc.channels]);
  ok("a concrete subscription stands alone, known or not", memberChannels(["solo"], [], known).channels.get("solo") === "live");
  ok("a wildcard expands to nothing when no channel is known", memberChannels(["team.>"], [], []).channels.size === 0);
  ok("a > pattern sets wide and expands to no channel", (() => { const r = memberChannels([">"], [], known); return r.wide && r.channels.size === 0; })());
  ok("a * pattern sets wide and expands to no channel", (() => { const r = memberChannels(["*"], [], known); return r.wide && r.channels.size === 0; })());
  ok("no whole-breadth pattern leaves wide false", !memberChannels(["team.>", "alerts"], ["ops"], known).wide);
  ok("live beats durable for the same channel", memberChannels(["alerts"], ["alerts"], known).channels.get("alerts") === "live");
  ok("a durable channel the live arm lacks is durable", memberChannels(["alerts"], ["ops"], known).channels.get("ops") === "durable");
  ok("a * inside a pattern matches exactly one token", patternMatches("team.*", "team.web") && !patternMatches("team.*", "team.web.deep") && !patternMatches("team.*", "team"));
  ok("a trailing > matches one or more tokens", patternMatches("team.>", "team.web") && patternMatches("team.>", "team.web.deep") && !patternMatches("team.>", "team"));
  ok("a concrete pattern matches only itself", patternMatches("alerts", "alerts") && !patternMatches("alerts", "alerts.x") && !patternMatches("alerts.x", "alerts"));
}

console.log(`topology: ${cells - failed}/${cells} checks passed`);
if (failed) process.exit(1);
