/**
 * THE DASHBOARD MUST NAME A BLIND OBSERVER, NOT EMPTY THE ONLINE LIST.
 *
 * A stalled presence watch is a fact about THIS window onto the mesh. The sidebar is an
 * online-only list by design (David: that stands). So the honest page keeps last-known
 * online rows and marks the roster source stale. These cells drive the shipped
 * `presenceViewMark`, `rosterRows`, `nameIndex`, `displayNameOf` and `dmPeers` from
 * `client/src/lib`, imported as the client bundle imports them, the dashboard controller that
 * applies the verdict, and the server event the page listens for.
 *
 * WHAT THIS DOES NOT CLAIM. No broker, no stall, no pixels. The endpoint verdict lives in
 * `smoke:presence-watch-stall`. This file is the logic: a `presence-view` verdict becomes
 * the stale mark the polls already use, names come from the roster alone, and the roster
 * sorts and counts as the Agents view needs.
 *
 * Run: pnpm smoke:web-presence-view
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dmPeers } from "../client/src/lib/dms.js";
import { displayNameOf, nameIndex } from "../client/src/lib/names.js";
import { oldestLiveBeat, presenceViewMark, rosterRows, STATUS_ORDER, statusCounts, statusLabel, waiting } from "../client/src/lib/roster.js";
import type { CotalMessage, PresenceView, RosterEntry } from "../client/src/api/types.js";
import { bootReads, harness } from "./controller-harness.js";

const webSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

const webTs = readFileSync(join(webSrc, "web.ts"), "utf8");

const views: PresenceView[] = [
  { state: "stale", fresh: false, staleSince: 1 },
  { state: "current", fresh: true },
  { state: "unpopulated", fresh: false },
];
const marks = views.map(presenceViewMark);
ok("1.1 Monitor: a stale view marks the roster source, not a peer",
  marks[0]?.name === "roster" && marks[0]?.kind === "refused"
    && marks[0]?.reason === "observer presence watch silent since 1970-01-01T00:00:00.001Z",
  marks[0]);
ok("1.2 Monitor: a fresh view CLEARS that mark (recovery is per source)", marks[1] === undefined, marks[1]);
ok("1.3 Monitor: the endpoint's unpopulated state marks the roster unknown while its snapshot loads",
  marks[2]?.name === "roster" && /snapshot still loading/.test(marks[2]?.reason ?? ""), marks[2]);

// The controller applies the verdict: the roster it already holds stays, and the mark comes and goes.
{
  const known: RosterEntry[] = [{ card: { id: "local.amy", name: "amy", kind: "agent" }, status: "working", ts: 1 }];
  const h = harness({});
  h.ctl.onRoster(known);
  h.ctl.onPresenceView({ state: "stale", fresh: false, staleSince: 1 });
  const staleMarks = h.store.get().stale.filter((m) => m.name === "roster");
  ok("2.1 the client applies presence-view events: a stale view keeps the last-known rows and marks the roster source",
    h.store.get().roster.length === 1 && h.store.get().roster[0].card.id === "local.amy"
      && staleMarks.length === 1 && /observer presence watch silent since/.test(staleMarks[0].reason),
    { roster: h.store.get().roster, stale: h.store.get().stale });
  h.ctl.onPresenceView({ state: "current", fresh: true });
  ok("2.1b and a current view clears that mark", !h.store.get().stale.some((m) => m.name === "roster"), h.store.get().stale);
}
// A poll replaces the stale marks with what it read, and the observer's mark is not one of its reads.
{
  const h = harness(bootReads);
  h.ctl.onPresenceView({ state: "stale", fresh: false, staleSince: 1 });
  await h.ctl.refresh();
  ok("2.5 a poll cannot erase the observer-view mark: a refresh keeps the roster entry",
    h.store.get().stale.some((m) => m.name === "roster"), h.store.get().stale);
}

ok("2.2 the server broadcasts presence-view from the endpoint event (not a restated poll)",
  /ep\.on\("presence-view"/.test(webTs) && /broadcast\("presence-view"/.test(webTs));
ok("2.3 a new /feed client is seeded with the current view, not only the roster",
  /send\(res, "presence-view", ep\.presenceView\(\)\)/.test(webTs));
ok("2.4 roster pushes are trailing-edge debounced so a replay burst is one render",
  /const pushRoster = debounce\(\(\) => broadcast\("roster", rosterSnapshot\(\)\), 150\)/.test(webTs)
    && /ep\.on\("presence", \(\) => pushRoster\(\)\)/.test(webTs));

const entry = (id: string, name: string, status: RosterEntry["status"], extra: Partial<RosterEntry> = {}, card: Partial<RosterEntry["card"]> = {}): RosterEntry =>
  ({ card: { id, name, kind: "agent", role: "agent", ...card }, status, ts: 1, ...extra });

// 2.x roster rows, ordering and counts.
{
  const roster: RosterEntry[] = [
    entry("local.zed", "zed", "idle"),
    entry("local.bob", "bob", "working", { progress: { kind: "unknown" } }, { meta: { connector: "claude-code", host: "mbp", model: "opus" } }),
    entry("local.amy", "amy", "working", { activity: "reviewing", statusSince: 5, attention: "focus" }),
    entry("local.dan", "dan", "waiting", { ts: 7 }),
    entry("local.ann", "ann", "offline", { ts: 0 }),
    entry("local.cat", "cat", "waiting", { ts: 3 }),
  ];
  const rows = rosterRows(roster);
  ok("2.6 the sidebar rows are online-only by default (this change does not gray rows out)",
    rows.length === 5 && rows.every((r) => r.status !== "offline"), rows.map((r) => r.name));
  ok("2.7 rows sort waiting first, then working, then idle, each by name (the old working-first order is replaced on purpose)",
    JSON.stringify(rows.map((r) => r.name)) === JSON.stringify(["cat", "dan", "amy", "bob", "zed"])
      && JSON.stringify(STATUS_ORDER) === JSON.stringify(["waiting", "working", "idle", "offline"]),
    rows.map((r) => `${r.status}:${r.name}`));
  const all = rosterRows(roster, { includeOffline: true });
  ok("2.8 includeOffline keeps offline rows, last", all.length === 6 && all[5]?.name === "ann", all.map((r) => r.name));
  const bob = rows.find((r) => r.id === "local.bob");
  ok("2.9 a row carries the card fields by the core names and the unknown-progress marker",
    bob?.harness === "claude-code" && bob?.host === "mbp" && bob?.model === "opus" && bob?.role === "agent"
      && bob?.progress?.kind === "unknown" && bob?.ts === 1, bob);
  const amy = rows.find((r) => r.id === "local.amy");
  ok("2.10 a row carries activity, attention and statusSince", amy?.activity === "reviewing" && amy?.attention === "focus" && amy?.statusSince === 5, amy);
  ok("2.11 statusCounts counts every status over the rows it is given",
    JSON.stringify(statusCounts(all)) === JSON.stringify({ working: 2, waiting: 2, idle: 1, offline: 1 }), statusCounts(all));
  // The wire can carry a status outside the four. It is counted toward none of them and sorts last.
  const odd = [...roster, entry("local.eve", "eve", "paused" as RosterEntry["status"])];
  const oddCounts = statusCounts(rosterRows(odd, { includeOffline: true }));
  ok("2.11b statusCounts ignores a status outside the four, so no count is NaN and the four are unchanged",
    JSON.stringify(oddCounts) === JSON.stringify({ working: 2, waiting: 2, idle: 1, offline: 1 }), oddCounts);
  const oddRows = rosterRows(odd);
  ok("2.11c rosterRows sorts a status outside the four after every known one, not first",
    oddRows.at(-1)?.name === "eve" && oddRows[0]?.name === "cat", oddRows.map((r) => `${r.status}:${r.name}`));
  ok("2.12 waiting() returns the waiting rows", waiting(rows).map((r) => r.name).join() === "cat,dan", waiting(rows));
  ok("2.13 oldestLiveBeat is the stalest heartbeat among live rows, never an offline one",
    oldestLiveBeat(all) === 1 && oldestLiveBeat(rosterRows([entry("local.o", "o", "offline")], { includeOffline: true })) === undefined,
    oldestLiveBeat(all));
  ok("2.14 statusLabel writes honest progress text only for working with unknown progress",
    statusLabel({ status: "working", progress: { kind: "unknown" } }) === "working · progress unknown"
      && statusLabel({ status: "working" }) === "working"
      && statusLabel({ status: "idle", progress: { kind: "unknown" } }) === "idle");
}

// 3.x identity cells (#1399): a DM/activity sender's payload name and role are display text, not
// identity. The id→name index is built from the roster alone, an object resolves through its id,
// and a live row takes who/role from the roster by authenticated id.
{
  const roster: RosterEntry[] = [entry("local.alice", "alice", "working"), entry("local.bob", "bob", "idle")];
  const spoof: CotalMessage = {
    id: "s1",
    ts: 1790377570541,
    space: "s",
    from: { id: "local.alice", name: "carol", role: "admin" },
    parts: [{ kind: "text", text: "forged line" }],
    to: "local.bob",
  };
  const idx = nameIndex(roster);
  ok("3.1 nameIndex ignores a DM/activity sender's payload name (roster is the only source)",
    idx.get("local.alice") === "alice" && idx.size === 2, [...idx]);
  ok("3.2 displayNameOf resolves an object by its id, never its payload .name",
    displayNameOf({ id: "local.alice", name: "carol", role: "admin" } as { id: string }, idx) === "alice"
      && displayNameOf({ id: "local.zed", name: "imposter" } as { id: string }, idx) === "local.zed");
  const rows = rosterRows(roster, { includeOffline: true });
  ok("3.3 a live row renders the roster name and role by authenticated id, never the payload's",
    displayNameOf(spoof.from, idx) === "alice" && rows.find((r) => r.id === spoof.from.id)?.role === "agent"
      && `→ ${displayNameOf(spoof.to, idx)}` === "→ bob");
  ok("3.4 displayNameOf: undefined is ?, a short unknown string passes through",
    displayNameOf(undefined, idx) === "?" && displayNameOf("somebody", idx) === "somebody");
  const actor = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  ok("3.5 an unknown owner.actor principal with an actor of 32+ characters is cut to 6 plus an ellipsis",
    displayNameOf(`own1.${actor}`, idx) === "own1.ABCDEF…" && displayNameOf("own1.shortactor", idx) === "own1.shortactor",
    displayNameOf(`own1.${actor}`, idx));
  ok("3.6 a legacy base32 id of 32+ characters is cut to 6 plus an ellipsis",
    displayNameOf(actor, idx) === "ABCDEF…" && displayNameOf("ABCDEF", idx) === "ABCDEF");

  const dms: CotalMessage[] = [
    spoof,
    { ...spoof, id: "s2", ts: spoof.ts + 5, from: { id: "local.bob", name: "mallory" }, to: "local.alice" },
    { ...spoof, id: "s3", ts: spoof.ts + 9, from: { id: "local.alice", name: "x" }, to: "local.zed" },
    { ...spoof, id: "s4", from: { id: "local.alice", name: "x" }, to: "local.alice" },
  ];
  const peers = dmPeers(dms, roster);
  const alice = peers.find((p) => p.id === "local.alice");
  ok("3.7 dmPeers names, roles and statuses come from the roster by id, never the payload",
    alice?.name === "alice" && alice?.role === "agent" && alice?.status === "working"
      && peers.find((p) => p.id === "local.zed")?.status === "offline"
      && peers.every((p) => !["carol", "mallory"].includes(p.name)),
    peers.map((p) => [p.id, p.name, p.role, p.status]));
  ok("3.8 dmPeers rolls pairs up per peer: only pairs that talked, a self-DM is not a conversation, newest first",
    peers.length === 3 && alice?.threads === 2 && alice?.conversations.map((c) => c.with).join() === "local.zed,local.bob"
      && peers[0]?.last === spoof.ts + 9 && alice?.conversations[1]?.messages.map((m) => m.id).join() === "s1,s2",
    peers.map((p) => [p.id, p.threads, p.last]));
}

console.log(`\nweb presence-view smoke: ${cells - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
