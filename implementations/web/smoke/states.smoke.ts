/** The states of mock section B, and the rail and panel fixes carried into the same task: skeleton
 *  rows until the first roster and channel reads land; the stale marker's second line, in the notes'
 *  words, from what the controller now keeps (when each source last landed, when the observer's
 *  presence watch went silent, a partial page's counts); the partial banner in the Activity view; the
 *  retry that makes "Retrying." true; a closed feed that stays closed; rail items with nowhere to go
 *  that are disabled buttons titled with the empty state; Channels and Direct messages landing on the
 *  last place visited, a conversation named by both parties; the panel's Tab stop when the selected tab is disabled; and an Agents row
 *  marked only while the panel shows that agent. Each cell renders the real components over a seeded
 *  store, on the server or mounted in jsdom, or drives the controller and the boot over a fake Api,
 *  and reads what they drew or wrote. */
import { closeDom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { createElement, useState } from "react";
import { renderToString } from "react-dom/server";
import type { FeedHandlers } from "../client/src/api/feed.js";
import type { CotalMessage, RosterEntry } from "../client/src/api/types.js";
import { App } from "../client/src/App.tsx";
import { presenceViewMark } from "../client/src/lib/roster.js";
import { formatRoute, type Route } from "../client/src/lib/route.js";
import type { StaleMark } from "../client/src/lib/snapshot.js";
import type { RouteHost } from "../client/src/routeWatch.js";
import { Shell } from "../client/src/Shell.tsx";
import { RETRY_MAX_MS, RETRY_MS, startDashboard, type RetryTimer } from "../client/src/state/boot.js";
import { createController, type Api, type Controller } from "../client/src/state/controller.js";
import { createStore, type Store } from "../client/src/state/store.js";
import { initialState, type DashboardState } from "../client/src/state/types.js";
import { RightPanel, type Panel } from "../client/src/ui/panel/RightPanel.tsx";
import { StaleMarker } from "../client/src/ui/StaleMarker.tsx";
import { bootReads, gate, page, unusedApi } from "./controller-harness.js";
import { mount, type Mounted } from "./mount.js";
import { renderShell } from "./render-shell.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const same = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
const settle = () => new Promise((r) => setTimeout(r, 0));

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────
const entry = (id: string, name: string, status: RosterEntry["status"]): RosterEntry =>
  ({ card: { id, name, kind: "agent", meta: { connector: "codex" } }, status, ts: 1 }) as RosterEntry;
const roster: RosterEntry[] = [entry("local.rev", "reviewer", "working"), entry("local.rv2", "reviewer_2", "waiting"), entry("local.dav", "david", "idle")];
/** Today at hh:mm:ss in the reader's own clock, which is the clock the marker writes times in. */
const at = (h: number, m: number, s = 0) => {
  const d = new Date();
  d.setHours(h, m, s, 0);
  return d.getTime();
};
const textOf = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const parse = (html: string): HTMLElement => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
};
/** The stale marker drawn over `marks`: its label and its sentences, in order. */
const marker = (marks: StaleMark[]) => {
  const el = parse(renderToString(createElement(StaleMarker, { store: createStore<DashboardState>({ ...initialState, stale: marks }) })));
  return { label: textOf(el.querySelector(".ui-stale b")), lines: Array.from(el.querySelectorAll(".ui-stale span")).map(textOf), title: el.querySelector(".ui-stale")?.getAttribute("title") };
};
const dmMsg = (id: string, from: string, to: string, ts: number) =>
  ({ msg: { id, ts, space: "main", from: { id: from }, to, parts: [{ kind: "text", text: "hi" }] } as unknown as CotalMessage, senderId: from });

// ── 1. Loading: skeleton rows until the first roster and channel reads land ──────────────────────
{
  const rosterRead = gate<RosterEntry[]>();
  const channelsRead = gate<{ channel: string; messages: number }[]>();
  const api: Api = { ...unusedApi, ...bootReads, roster: () => rosterRead.promise, channels: () => channelsRead.promise as never } as Api;
  let handlers!: FeedHandlers;
  const start = (s: Store<DashboardState>, onArrival: () => void) => startDashboard({ store: s, api, openFeed: (h) => ((handlers = h), () => undefined), onArrival });
  const host: RouteHost = { location: { hash: "#/activity", pathname: "/" }, addEventListener: () => undefined, removeEventListener: () => undefined };
  const m = await mount(createElement(App, { host, start }));
  const side = () => m.container.querySelector("aside.ui-side") as HTMLElement;
  const view = () => m.container.querySelector("section.ui-view") as HTMLElement;
  const skeleton = () => ({
    places: side().querySelectorAll("nav[aria-busy=true] .ui-skel-row").length,
    rows: side().querySelectorAll("a.ui-row").length,
    centre: view().querySelectorAll(".ui-skel-msg").length,
    title: textOf(view().querySelector("h1")),
  });
  same("1.1 before the first reads answer, the sidebar draws the mock's six skeleton rows in a busy list and the centre two skeleton messages, with no place and no view",
    skeleton(), { places: 6, rows: 0, centre: 2, title: "" });
  const heads = Array.from(side().querySelectorAll("nav[aria-busy=true] .ui-sec")).map(textOf);
  same("1.2 the skeleton keeps the Channels and Direct messages headings, as the mock draws them", heads, ["Channels", "Direct messages"]);
  await m.run(() => handlers.roster(roster));
  same("1.3 the roster arriving on the feed does not end the wait while the channel read is still out", skeleton(), { places: 6, rows: 0, centre: 2, title: "" });
  await m.run(async () => {
    channelsRead.resolve([{ channel: "general", messages: 1 }]);
    rosterRead.resolve(roster);
    await settle();
  });
  const done = skeleton();
  ok("1.4 once both have landed the skeleton goes: the places and the routed view are drawn",
    done.places === 0 && done.centre === 0 && done.rows > 0 && done.title === "Activity" && side().querySelector("[aria-busy]") === null, done);
  await m.unmount();

  // The controller's half, with no boot: a store that starts waiting, and what clears each wait.
  const waiting = () => createStore<DashboardState>({ ...structuredClone(initialState), loading: { roster: true, channels: true } });
  const fed = waiting();
  createController(fed, { ...unusedApi }).onRoster(roster);
  same("1.5 a roster event from the feed clears the roster wait and leaves the channel wait", fed.get().loading, { roster: false, channels: true });
  const read = waiting();
  await createController(read, { ...unusedApi, ...bootReads }).refresh();
  same("1.6 a refresh whose roster and channel reads land clears both", read.get().loading, { roster: false, channels: false });
  const refused = waiting();
  await createController(refused, { ...unusedApi, ...bootReads, channels: async () => { throw new Error("channels refused with HTTP 503"); } }).refresh();
  ok("1.7 a refused channel read leaves its wait standing, and the marker says why",
    refused.get().loading.channels && !refused.get().loading.roster && refused.get().stale.some((s) => s.name === "channels"), { loading: refused.get().loading, stale: refused.get().stale });
  const plain = parse(renderShell({ roster }));
  ok("1.8 a store with nothing outstanding draws no skeleton", plain.querySelector(".ui-skel") === null && plain.querySelector("aside nav[aria-label=Places] a.ui-row") !== null);
  const boot = createStore<DashboardState>(structuredClone(initialState));
  const never = new Promise<never>(() => undefined);
  const dash = startDashboard({ store: boot, api: { ...unusedApi, ...bootReads, roster: () => never, channels: () => never } as Api, openFeed: () => () => undefined });
  same("1.9 starting the dashboard marks both first reads outstanding before anything lands", boot.get().loading, { roster: true, channels: true });
  dash.stop();
}

// ── 2. The stale marker's second line ────────────────────────────────────────────────────────────
{
  const one = marker([{ kind: "refused", name: "peers", reason: "HTTP 503 from /api/roster", lastRead: at(10, 51) }]);
  same("2.1 a refused read says when its source last landed, in the notes' words", one.lines, ["Showing what we last read at 10:51. Retrying."]);
  const two = marker([
    { kind: "refused", name: "peers", reason: "HTTP 503 from /api/roster", lastRead: at(10, 51) },
    { kind: "refused", name: "activity", reason: "the read failed: connection reset", lastRead: at(10, 48) },
  ]);
  same("2.2 with two refused sources it names the older read, so neither is claimed fresher than it is, under the mock's label and tooltip",
    two, { label: "stale: peers, activity", lines: ["Showing what we last read at 10:48. Retrying."], title: "peers: HTTP 503 from /api/roster\nactivity: the read failed: connection reset" });
  same("2.3 a source that has never read says only that it is retrying: nothing on screen came from it",
    marker([{ kind: "refused", name: "channels", reason: "HTTP 503" }]).lines, ["Retrying."]);
  const deaf = presenceViewMark({ state: "stale", fresh: false, staleSince: at(10, 52, 14) })!;
  ok("2.4 the observer's silent watch carries the time it went silent", deaf.since === at(10, 52, 14) && deaf.name === "roster", deaf);
  same("2.5 and the marker says it as the notes do, with no retry claim, since no read repairs a silent watch",
    marker([deaf]), { label: "stale: roster", lines: ["No presence updates since 10:52:14. Showing the last roster we heard."], title: `roster: ${deaf.reason}` });
  const loading = presenceViewMark({ state: "unpopulated", fresh: false })!;
  same("2.6 a watch still loading has no silent-since time, so there is no sentence and the reason stays in the tooltip",
    [loading.since, marker([loading]).lines], [undefined, []]);
  same("2.7 a partial read says how many sources answered", marker([{ kind: "partial", name: "activity", reason: "direct messages: timeout", read: 1, of: 2, missing: ["direct messages"] }]),
    { label: "partial: activity", lines: ["1 of 2 sources answered"], title: "activity: direct messages: timeout" });
  same("2.8 refused and partial together draw one sentence each, refused first",
    marker([{ kind: "partial", name: "activity", reason: "x", read: 1, of: 2 }, { kind: "refused", name: "peers", reason: "y", lastRead: at(9, 5) }]).lines,
    ["Showing what we last read at 09:05. Retrying.", "1 of 2 sources answered"]);

  // What the controller keeps for those sentences.
  let now = at(10, 51);
  let rosterUp = true;
  const store = createStore<DashboardState>(structuredClone(initialState));
  const ctl = createController(store, {
    ...unusedApi,
    ...bootReads,
    roster: async () => { if (!rosterUp) throw new Error("peers refused with HTTP 503"); return roster; },
    channels: async () => { throw new Error("channels refused with HTTP 503"); },
  }, { clock: () => now });
  await ctl.refresh();
  now = at(10, 53);
  rosterUp = false;
  await ctl.refresh();
  const peers = store.get().stale.find((s) => s.name === "peers");
  const channels = store.get().stale.find((s) => s.name === "channels");
  ok("2.9 the controller stamps a refusal with when its source last landed", peers?.lastRead === at(10, 51), peers);
  ok("2.10 and a source that never landed carries no time", channels !== undefined && channels.lastRead === undefined, channels);

  const partialStore = createStore<DashboardState>(structuredClone(initialState));
  await createController(partialStore, {
    ...unusedApi,
    ...bootReads,
    activity: async () => ({ ...page(), partial: true, read: 1, of: 2, missing: ["direct messages"], reasons: { "direct messages": "the read did not finish within 8000ms" } }),
  }).refresh();
  const partial = partialStore.get().stale.find((s) => s.kind === "partial");
  same("2.11 a partial page's mark carries its counts and its missing sources",
    partial && { read: partial.read, of: partial.of, missing: partial.missing }, { read: 1, of: 2, missing: ["direct messages"] });
  same("2.12 and its tooltip reads as the mock's: each missing source with its reason",
    marker(partialStore.get().stale).title, "activity: direct messages: the read did not finish within 8000ms");

  let historyUp = true;
  now = at(11, 2);
  const histStore = createStore<DashboardState>(structuredClone(initialState));
  const hist = createController(histStore, { ...unusedApi, history: async () => { if (!historyUp) throw new Error("history refused with HTTP 500"); return []; } }, { clock: () => now });
  await hist.open("review");
  historyUp = false;
  now = at(11, 9);
  await hist.open(null);
  await hist.open("review");
  same("2.13 a refused channel history says when that channel's history last landed",
    marker(histStore.get().stale).lines, ["Showing what we last read at 11:02. Retrying."]);
}

// ── 3. The partial banner in the Activity view ───────────────────────────────────────────────────
{
  const banner = (marks: StaleMark[]) => {
    const el = parse(renderShell({ roster, stale: marks }, { view: "activity" })).querySelector("section.ui-view .s-banner");
    return el && { title: el.getAttribute("title"), label: textOf(el.querySelector("b")), spans: Array.from(el.querySelectorAll("span")).map(textOf), role: el.getAttribute("role") };
  };
  const dm: StaleMark = { kind: "partial", name: "activity", reason: "direct messages: the read did not finish within 8000ms", read: 1, of: 2, missing: ["direct messages"] };
  same("3.1 a page missing its direct messages carries the mock's banner: the marker, the count, the half it shows, the reason on hover",
    banner([dm]), {
      title: "direct messages: the read did not finish within 8000ms",
      label: "partial: activity",
      spans: ["1 of 2 sources answered", "Direct messages didn't load in time, so this page shows channel messages only."],
      role: "status",
    });
  same("3.2 a page missing its channel messages says the other half",
    banner([{ ...dm, reason: "chat: x", missing: ["chat"] }])?.spans, ["1 of 2 sources answered", "Channel messages didn't load in time, so this page shows direct messages only."]);
  same("3.3 with both sources missing there is no half to name", banner([{ ...dm, read: 0, missing: ["chat", "direct messages"] }])?.spans, ["0 of 2 sources answered"]);
  ok("3.4 a whole page, or a refusal that is not partial, has no banner",
    banner([]) === null && banner([{ kind: "refused", name: "activity", reason: "x" }]) === null);
  const first = parse(renderShell({ roster, stale: [dm] }, { view: "activity" })).querySelector("section.ui-view .ui-col")?.firstElementChild;
  ok("3.5 the banner heads the list, above the rows", first?.classList.contains("s-banner") === true, first?.className);
  const bar = (marks: StaleMark[]) => parse(renderShell({ roster, stale: marks }, { view: "activity" })).querySelector("section.ui-view header.ui-bar");
  ok("3.6 while the page is partial the Activity header carries only its title, as mock B's partial frame does: the sidebar marker and the banner say it",
    bar([dm])?.querySelector(".ui-stale") === null && textOf(bar([dm])?.querySelector("h1")) === "Activity"
      && bar([{ kind: "refused", name: "peers", reason: "x" }])?.querySelector(".ui-stale") !== null);
}

// ── 4. The boot: a closed feed stays closed, and refused reads are retried ───────────────────────
{
  const store = createStore<DashboardState>(structuredClone(initialState));
  let handlers!: FeedHandlers;
  const dash = startDashboard({ store, api: { ...unusedApi, ...bootReads } as Api, openFeed: (h) => ((handlers = h), () => undefined) });
  handlers.open();
  handlers.closed();
  handlers.error();
  ok("4.1 an error after the browser closed the feed for good leaves the pill on Disconnected, not Reconnecting", store.get().connection === "closed", store.get().connection);
  dash.stop();

  // A fake timer: what is pending, and the way to fire it.
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  const cleared: number[] = [];
  const timer: RetryTimer = { set: (fn, ms) => (pending.set(++next, { fn, ms }), next), clear: (h) => { cleared.push(h as number); pending.delete(h as number); } };
  const fire = async () => {
    const [[id, t]] = [...pending];
    pending.delete(id);
    t.fn();
    await settle();
    await settle();
  };
  let reads = 0;
  let up = false;
  const flaky = createStore<DashboardState>(structuredClone(initialState));
  const retrying = startDashboard({
    store: flaky,
    api: { ...unusedApi, ...bootReads, channels: async () => { reads++; if (!up) throw new Error("channels refused with HTTP 503"); return []; } } as Api,
    openFeed: () => () => undefined,
    timer,
  });
  await settle();
  await settle();
  same("4.2 a refused read arms one retry, RETRY_MS later", [...pending.values()].map((t) => t.ms), [RETRY_MS]);
  flaky.set({ space: "main" });
  ok("4.3 further store changes while it is pending do not arm a second", pending.size === 1, pending.size);
  await fire();
  ok("4.4 when it fires the dashboard reads again, and a read still refused arms the next retry", reads === 2 && pending.size === 1, { reads, pending: pending.size });
  up = true;
  await fire();
  ok("4.5 a retry that lands clears the mark and arms nothing more", reads === 3 && pending.size === 0 && !flaky.get().stale.some((s) => s.name === "channels"), { reads, pending: pending.size, stale: flaky.get().stale });
  flaky.set({ stale: [{ kind: "refused", name: "roster", reason: "observer presence watch silent since x" }, { kind: "partial", name: "activity", reason: "y" }] });
  ok("4.6 the observer's silent watch and a partial page arm no retry: no read repairs either", pending.size === 0, pending.size);
  up = false;
  flaky.set({ stale: [{ kind: "refused", name: "#review history", reason: "history refused" }] });
  ok("4.7 a refused channel history arms one too, since the retry reopens the open channel", pending.size === 1, pending.size);
  const armed = [...pending.keys()][0];
  retrying.stop();
  ok("4.8 stopping the dashboard cancels the pending retry", pending.size === 0 && cleared.includes(armed), { pending: pending.size, cleared });
  flaky.set({ stale: [{ kind: "refused", name: "channels", reason: "z" }] });
  ok("4.9 and a stopped dashboard arms nothing", pending.size === 0, pending.size);

  // The backoff: each retry still refused doubles the wait, to a cap, and a read that lands resets it.
  const waits: number[] = [];
  const queue = new Map<number, () => void>();
  let id = 0;
  const backoff: RetryTimer = { set: (fn, ms) => (waits.push(ms), queue.set(++id, fn), id), clear: (h) => void queue.delete(h as number) };
  const fireNext = async () => {
    const [[key, fn]] = [...queue];
    queue.delete(key);
    fn();
    await settle();
    await settle();
  };
  let ok2 = false;
  const down = createStore<DashboardState>(structuredClone(initialState));
  const slow = startDashboard({
    store: down,
    api: { ...unusedApi, ...bootReads, channels: async () => { if (!ok2) throw new Error("channels refused with HTTP 503"); return []; } } as Api,
    openFeed: () => () => undefined,
    timer: backoff,
  });
  await settle();
  await settle();
  for (let i = 0; i < 5; i++) await fireNext();
  same("4.10 while a read stays refused the wait doubles from 5 s to the 60 s cap: 5, 10, 20, 40, 60, 60",
    [waits, RETRY_MS, RETRY_MAX_MS], [[5000, 10000, 20000, 40000, 60000, 60000], 5000, 60000]);
  ok2 = true;
  await fireNext();
  ok2 = false;
  await slow.controller.refresh();
  await settle();
  same("4.11 a read that lands cancels the pending retry and resets the wait, so the next refusal waits 5 s again",
    [waits.at(-1), queue.size], [5000, 1]);
  slow.stop();
  ok("4.12 stopping clears the one pending retry", queue.size === 0, queue.size);
}

// ── 5. The rail: disabled items, their titles, and the last place visited ────────────────────────
{
  const railItems = (el: ParentNode) => Array.from(el.querySelectorAll("nav.ui-rail .ui-rail-btn")).map((i) => ({
    tag: i.tagName.toLowerCase(),
    label: i.getAttribute("aria-label"),
    href: i.getAttribute("href"),
    type: i.getAttribute("type"),
    disabled: i.getAttribute("aria-disabled"),
    title: i.getAttribute("title"),
  }));
  const bare = railItems(parse(renderShell({ space: "main" })));
  same("5.1 Channels and Direct messages with nowhere to go are buttons marked disabled, not bare links, so the keyboard still reaches them",
    bare.slice(1, 3).map((i) => [i.tag, i.type, i.disabled, i.href]), [["button", "button", "true", null], ["button", "button", "true", null]]);
  same("5.2 each is titled with the empty state the reader would find, keeping its name as its label",
    bare.slice(1, 3).map((i) => [i.label, i.title]), [["Channels", "No channels yet. One appears with its first message."], ["Direct messages", "No direct messages yet."]]);
  ok("5.3 an item with somewhere to go is a link titled with its name", bare[0].tag === "a" && bare[0].title === "Activity" && bare[0].disabled === null, bare[0]);

  let goTo!: (r: Route) => void;
  const store = createStore<DashboardState>({
    ...structuredClone(initialState),
    roster,
    channels: [{ channel: "general", messages: 1 }, { channel: "review", messages: 1 }],
    dms: [dmMsg("d1", "local.rev", "local.dav", 10), dmMsg("d2", "local.rv2", "local.dav", 20)],
  });
  const Harness = () => {
    const [route, setRoute] = useState<Route>({ view: "channel", channel: "review" });
    goTo = setRoute;
    return createElement(Shell, { store, controller: null, route, paneOpen: false, msgPerSecond: () => 0 });
  };
  const m = await mount(createElement(Harness));
  const href = (label: string) => m.container.querySelector(`nav.ui-rail [aria-label="${label}"]`)?.getAttribute("href");
  await m.run(() => goTo({ view: "dm", peer: "local.rev", with: "local.dav" }));
  await m.run(() => goTo({ view: "activity" }));
  same("5.4 Channels lands on the channel last visited, not the first one", href("Channels"), formatRoute({ view: "channel", channel: "review" }));
  same("5.5 Direct messages lands on the conversation last visited, both parties kept, not the newest one",
    href("Direct messages"), formatRoute({ view: "dm", peer: "local.rev", with: "local.dav" }));
  await m.run(() => store.set({ channels: [{ channel: "general", messages: 1 }] }));
  same("5.6 a last channel that is gone falls back to the first there is", href("Channels"), formatRoute({ view: "channel", channel: "general" }));
  const fresh = railItems(parse(renderShell({ roster, channels: [{ channel: "general", messages: 1 }], dms: [dmMsg("d2", "local.rv2", "local.dav", 20)] })));
  same("5.7 before any visit they land on the first channel and on the newest conversation, both parties named",
    fresh.slice(1, 3).map((i) => i.href), [formatRoute({ view: "channel", channel: "general" }), formatRoute({ view: "dm", peer: "local.dav", with: "local.rv2" })]);
  await m.run(() => goTo({ view: "dm", peer: "local.rev" }));
  await m.run(() => goTo({ view: "activity" }));
  same("5.8 a Message visit names only the agent, so with the operator's id unknown Direct messages lands on the newest conversation, both parties named",
    href("Direct messages"), formatRoute({ view: "dm", peer: "local.dav", with: "local.rv2" }));
  await m.run(() => store.set({ operatorId: "local.op" }));
  same("5.9 once the operator's id is known that visit is the operator's conversation with the agent, both parties named",
    href("Direct messages"), formatRoute({ view: "dm", peer: "local.rev", with: "local.op" }));
  await m.unmount();
}

// ── 6. The panel: a Tab stop when the selected tab is disabled, and the Agents row mark ──────────
{
  const noop = () => undefined;
  const panel = (p: Partial<Panel>): Panel => ({ open: true, tab: "members", agent: null, setTab: noop, selectAgent: noop, showMembers: noop, close: noop, toggle: noop, ...p });
  const stops = (p: Panel, channel: string | null) =>
    Array.from(parse(renderToString(createElement(RightPanel, { store: createStore<DashboardState>(structuredClone(initialState)), controller: null, channel, panel: p, clock: () => 0 }))).querySelectorAll("[role=tab]"))
      .map((t) => [textOf(t), t.getAttribute("tabindex")]);
  same("6.1 when the selected tab is disabled the first enabled tab is the list's Tab stop, so the keyboard does not skip the list",
    stops(panel({ tab: "agent", agent: null }), "review"), [["Members", "0"], ["Agent", "-1"], ["Topology", "-1"]]);
  same("6.2 off a channel that is Topology", stops(panel({ tab: "members" }), null), [["Members", "-1"], ["Agent", "-1"], ["Topology", "0"]]);
  same("6.3 an enabled selected tab stays the Tab stop", stops(panel({ tab: "agent", agent: "local.rev" }), "review"), [["Members", "-1"], ["Agent", "0"], ["Topology", "-1"]]);

  localStorage.clear();
  const store = createStore<DashboardState>({ ...structuredClone(initialState), roster });
  const m: Mounted = await mount(createElement(Shell, { store, controller: null, route: { view: "agents", group: "status" }, paneOpen: false, msgPerSecond: () => 0 }));
  const marked = () => Array.from(m.container.querySelectorAll('.v3-arow[aria-current="true"]')).map((r) => textOf(r.querySelector("b")));
  const tab = (label: string) => Array.from(m.container.querySelectorAll("section.ui-pane [role=tab]")).find((t) => textOf(t) === label) as HTMLElement | undefined;
  const row = Array.from(m.container.querySelectorAll(".v3-arow")).find((r) => textOf(r.querySelector("b")) === "david") as HTMLElement;
  await m.run(() => row.click());
  same("6.4 picking a row opens the panel on that agent and marks the row", marked(), ["david"]);
  await m.run(() => tab("Topology")?.click());
  same("6.5 while the panel shows another tab the row is not marked", marked(), []);
  await m.run(() => tab("Agent")?.click());
  same("6.6 back on the Agent tab it is marked again", marked(), ["david"]);
  await m.run(() => (m.container.querySelector('section.ui-pane [aria-label="Close panel"]') as HTMLElement).click());
  same("6.7 a closed panel marks nothing", marked(), []);
  await m.unmount();
}

await closeDom();
console.log(`states: ${n} checks passed`);
