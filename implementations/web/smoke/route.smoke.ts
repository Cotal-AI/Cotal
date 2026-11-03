/** The dashboard's hash routes: a hash (and the page path) parses to one view, formatRoute writes the
 *  same route back, a channel name survives encoding, and nothing a user can type throws. An agent's
 *  page has a route per tab and one for Work at a message, the old message link opens Work at that
 *  message and is written back in the new form, and an agent's event channel opens its page. */
import { strict as assert } from "node:assert";
import { DEFAULT_ROUTE, formatRoute, parseRoute, type Route } from "../client/src/lib/route.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const same = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

same("the default route is the activity feed", DEFAULT_ROUTE, { view: "activity" });
same("a channel hash gives the channel route", parseRoute("#/channel/team.backend", "/"), { view: "channel", channel: "team.backend" });
same("a dm hash with two ids gives peer and with", parseRoute("#/dm/local.ab/local.cd", "/"), { view: "dm", peer: "local.ab", with: "local.cd" });
same("a dm hash with one id gives the peer alone", parseRoute("#/dm/local.ab", "/"), { view: "dm", peer: "local.ab" });
same("the activity hash gives activity", parseRoute("#/activity", "/"), { view: "activity" });
same("the topology hash gives topology", parseRoute("#/topology", "/"), { view: "topology" });
same("the needs hash gives needs", parseRoute("#/needs", "/"), { view: "needs" });
same("the bare agents hash defaults to the status group", parseRoute("#/agents", "/"), { view: "agents", group: "status" });
same("the agents status hash gives the status group", parseRoute("#/agents/status", "/"), { view: "agents", group: "status" });
same("the agents host hash gives the host group", parseRoute("#/agents/host", "/"), { view: "agents", group: "host" });

same("the /graph path with an empty hash gives topology", parseRoute("", "/graph"), { view: "topology" });
same("the /graph path with a bare # gives topology", parseRoute("#", "/graph"), { view: "topology" });
same("the /graph path with an unknown hash gives topology", parseRoute("#/nowhere", "/graph"), { view: "topology" });
same("a known hash wins over the /graph path", parseRoute("#/needs", "/graph"), { view: "needs" });
same("an empty hash on / gives the default route", parseRoute("", "/"), DEFAULT_ROUTE);
same("an unknown hash gives the default route", parseRoute("#/nowhere", "/"), DEFAULT_ROUTE);
same("an unknown agents group gives the default route", parseRoute("#/agents/rack", "/"), DEFAULT_ROUTE);
same("a channel hash with no name gives the default route", parseRoute("#/channel/", "/"), DEFAULT_ROUTE);
same("a hash with extra segments gives the default route", parseRoute("#/channel/a/b", "/"), DEFAULT_ROUTE);

same("an encoded channel name is decoded", parseRoute("#/channel/team%20%2F%20a", "/"), { view: "channel", channel: "team / a" });
const bad = (() => { try { return { value: parseRoute("#/channel/%E0%A4%A", "/") }; } catch (e) { return { threw: String(e) }; } })();
ok("an undecodable channel name does not throw", bad.threw === undefined, bad);
same("a dm hash with three ids gives the default route", parseRoute("#/dm/a/b/c", "/"), DEFAULT_ROUTE);
same("an undecodable channel name gives the default route", bad.value, DEFAULT_ROUTE);
same("an undecodable dm peer gives the default route", parseRoute("#/dm/%E0%A4%A", "/"), DEFAULT_ROUTE);

same("an agent hash gives the agent's page on Work", parseRoute("#/agent/local.abc", "/"), { view: "agent", id: "local.abc", tab: "work" });
same("an agent hash with a tab gives that tab",
  ["work", "messages", "profile"].map((t) => parseRoute(`#/agent/local.abc/${t}`, "/")),
  [{ view: "agent", id: "local.abc", tab: "work" }, { view: "agent", id: "local.abc", tab: "messages" }, { view: "agent", id: "local.abc", tab: "profile" }]);
same("an agent hash on Work with a message id gives Work at that message", parseRoute("#/agent/local.abc/work/m-1", "/"), { view: "agent", id: "local.abc", tab: "work", at: "m-1" });
same("the old agent hash with a message id gives Work at that message", parseRoute("#/agent/local.abc/m-1", "/"), { view: "agent", id: "local.abc", tab: "work", at: "m-1" });
ok("the old agent hash is written back in the new form", formatRoute(parseRoute("#/agent/local.abc/m-1", "/")) === "#/agent/local.abc/work/m-1", formatRoute(parseRoute("#/agent/local.abc/m-1", "/")));
same("an undecodable agent id gives the default route", parseRoute("#/agent/%E0%A4%A", "/"), DEFAULT_ROUTE);
same("an undecodable message id gives the default route",
  [parseRoute("#/agent/local.abc/%E0%A4%A", "/"), parseRoute("#/agent/local.abc/work/%E0%A4%A", "/")], [DEFAULT_ROUTE, DEFAULT_ROUTE]);
same("an agent hash with a message under another tab, or a fourth segment, gives the default route",
  ["#/agent/x.y/bogus/extra", "#/agent/x.y/messages/m-1", "#/agent/x.y/work/m-1/more", "#/agent/x.y/work/"].map((h) => parseRoute(h, "/")),
  [DEFAULT_ROUTE, DEFAULT_ROUTE, DEFAULT_ROUTE, DEFAULT_ROUTE]);
same("an agent id outside <owner>.<actor> gives the default route",
  ["#/agent/team", "#/agent/a.b.c", "#/agent/a%20b.c", "#/agent/.abc", "#/agent/a-b.c/m-1"].map((h) => parseRoute(h, "/")),
  [DEFAULT_ROUTE, DEFAULT_ROUTE, DEFAULT_ROUTE, DEFAULT_ROUTE, DEFAULT_ROUTE]);
same("an event channel hash opens that agent's page on Work", parseRoute("#/channel/events.local.abc", "/"), { view: "agent", id: "local.abc", tab: "work" });
same("a channel named events.standup stays a channel", parseRoute("#/channel/events.standup", "/"), { view: "channel", channel: "events.standup" });
ok("formatRoute encodes the agent id and the message id", formatRoute({ view: "agent", id: "a/b", tab: "work", at: "m 1#" }) === "#/agent/a%2Fb/work/m%201%23", formatRoute({ view: "agent", id: "a/b", tab: "work", at: "m 1#" }));
same("formatRoute writes Work with no message as the bare page, and another tab by name",
  (["work", "messages", "profile"] as const).map((tab) => formatRoute({ view: "agent", id: "local.abc", tab })),
  ["#/agent/local.abc", "#/agent/local.abc/messages", "#/agent/local.abc/profile"]);

ok("formatRoute writes a channel as #/channel/<name>", formatRoute({ view: "channel", channel: "review" }) === "#/channel/review");
ok("formatRoute encodes the channel name with encodeURIComponent", formatRoute({ view: "channel", channel: "a b/c" }) === "#/channel/a%20b%2Fc");
ok("formatRoute encodes both dm ids with encodeURIComponent", formatRoute({ view: "dm", peer: "a/b%c", with: "x y?#" }) === "#/dm/a%2Fb%25c/x%20y%3F%23", formatRoute({ view: "dm", peer: "a/b%c", with: "x y?#" }));
const valid: Route[] = [
  { view: "channel", channel: "review" },
  { view: "channel", channel: "team / a?b#c%d" },
  { view: "activity" },
  { view: "dm", peer: "local.ab" },
  { view: "dm", peer: "local.ab", with: "local.cd" },
  { view: "dm", peer: "a/b%c", with: "x y?#" },
  { view: "dm", peer: "a/b%c" },
  { view: "agents", group: "status" },
  { view: "agents", group: "host" },
  { view: "topology" },
  { view: "needs" },
  { view: "agent", id: "local.abc", tab: "work" },
  { view: "agent", id: "local.abc", tab: "messages" },
  { view: "agent", id: "local.abc", tab: "profile" },
  { view: "agent", id: "local.abc", tab: "work", at: "m-1" },
  { view: "agent", id: "local.abc", tab: "work", at: "x y?#" },
];
for (const r of valid) same(`parseRoute reads back formatRoute for ${JSON.stringify(r)}`, parseRoute(formatRoute(r), "/"), r);
for (const hash of ["#/channel/team.backend", "#/dm/local.ab/local.cd", "#/agents", "#/agents/host", "#/activity", "#/topology", "#/needs", "#/agent/local.abc", "#/agent/local.abc/messages", "#/agent/local.abc/profile", "#/agent/local.abc/work/m-1"]) {
  ok(`formatRoute(parseRoute(${hash})) is ${hash}`, formatRoute(parseRoute(hash, "/")) === hash);
}
console.log(`route: ${n} checks passed`);
