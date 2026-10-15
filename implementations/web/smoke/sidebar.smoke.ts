/** The sidebar (mock section D): the space name with no menu, Needs you with its gold count,
 *  Activity with the message rate, the channels with their unread counts, one row per direct
 *  message conversation, and the operator footer with the connection pill. Each cell server-renders
 *  the shell over a seeded store and reads the HTML. Three cells run the wiring: the feed reports
 *  every arrival to the dashboard's `onArrival`, the mounted app turns those arrivals into the
 *  rate, and the one-second tick that redraws the rate stops on unmount.
 *
 *  What is pinned, beyond the markup: every name comes from the roster by id and never from a
 *  payload; an event channel (`run.*`) is the one row drawn with the plug icon; no footer line
 *  claims the operator's place on the roster, because the page cannot know the mesh's mode; and no
 *  DM row reads "to you", because the page cannot know which id is the operator. */
import { closeDom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { Plug01Icon } from "@hugeicons/core-free-icons";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { FeedHandlers } from "../client/src/api/feed.js";
import type { CotalMessage, FeedMessage, RosterEntry } from "../client/src/api/types.js";
import { App } from "../client/src/App.tsx";
import { Icon } from "../client/src/icons/Icon.tsx";
import { RailIcon } from "../client/src/icons/rail.tsx";
import { createRate } from "../client/src/lib/rate.js";
import { formatRoute, type Route } from "../client/src/lib/route.js";
import type { RouteHost } from "../client/src/routeWatch.js";
import { rateText } from "../client/src/lib/shellText.js";
import { startDashboard } from "../client/src/state/boot.js";
import type { Api, Controller } from "../client/src/state/controller.js";
import { createStore } from "../client/src/state/store.js";
import { initialState, type DashboardState, type StoredMessage } from "../client/src/state/types.js";
import { UNVERIFIED } from "../client/src/ui/MessageRow.tsx";
import { mount } from "./mount.js";
import { renderShell, startTags, unescapeHtml } from "./render-shell.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const same = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const entry = (id: string, name: string, status: RosterEntry["status"], connector?: string): RosterEntry =>
  ({ card: { id, name, kind: "agent", meta: connector ? { connector } : {} }, status, ts: 1 }) as RosterEntry;
const roster: RosterEntry[] = [
  entry("local.rev", "reviewer", "working", "codex"),
  entry("local.rv2", "reviewer_2", "waiting", "opencode"),
  entry("local.dav", "david", "idle", "claude-code"),
  entry("local.pln", "planner", "waiting", "pi"),
  entry("local.sco", "scout", "offline", "gemini"),
];
/** A direct message from `from` to `to`. The payload names its sender "mallory", which no row may show. */
const dm = (id: string, from: string, to: string, ts: number, senderId?: string): StoredMessage => ({
  msg: { id, ts, space: "main", from: { id: from, name: "mallory" }, to, parts: [{ kind: "text", text: "hi" }] } as unknown as CotalMessage,
  senderId,
});

// ── Reading the sidebar's HTML ───────────────────────────────────────────────────────────────────
const strip = (html: string) => unescapeHtml(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, ""));
const side = (html: string) => /<aside class="ui-side" aria-label="Space">([\s\S]*?)<\/aside>/.exec(html)?.[1] ?? "";
const scroll = (html: string) => /<nav class="ui-side-scroll" aria-label="Places">([\s\S]*?)<\/nav>/.exec(side(html))?.[1] ?? "";
interface Row { attrs: Record<string, string>; inner: string; label: string; badge?: { cls: string; title?: string; text: string } }
const rowsOf = (html: string): Row[] =>
  [...html.matchAll(/<a ([^>]*class="ui-row[^"]*"[^>]*)>([\s\S]*?)<\/a>/g)].map((m) => {
    const b = /<span class="(ui-badge-(?:gold|blue))"([^>]*)>([^<]*)<\/span>/.exec(m[2]);
    return {
      attrs: startTags(`<a ${m[1]}>`, "a")[0],
      inner: m[2],
      label: strip(/<span class="ui-row-lbl">([\s\S]*?)<\/span>/.exec(m[2])?.[1] ?? ""),
      badge: b ? { cls: b[1], title: startTags(`<span ${b[2]}>`, "span")[0].title, text: b[3] } : undefined,
    };
  });
/** The part of the scroll area under the heading `name`, up to the next heading. */
const section = (html: string, name: string): string => {
  const parts = scroll(html).split(/<div class="ui-sec">/);
  return parts.find((p) => p.startsWith(`${name}</div>`)) ?? "";
};
const head = (html: string) => /<div class="ui-side-head">([\s\S]*?)<\/div>/.exec(side(html))?.[1] ?? "";
const foot = (html: string) => side(html).slice(Math.max(0, side(html).indexOf('<div class="ui-side-foot">')));
const needs = (html: string) => rowsOf(scroll(html)).find((r) => r.label === "Needs you");
const activity = (html: string) => rowsOf(scroll(html)).find((r) => r.label.startsWith("Activity"));
const channels = (html: string) => rowsOf(section(html, "Channels"));
const dms = (html: string) => rowsOf(section(html, "Direct messages"));
const rateOf = (html: string) => /<span class="ui-row-n">([^<]*)<\/span>/.exec(activity(html)?.inner ?? "")?.[1];

// ── 1. The head: the space name, no menu ─────────────────────────────────────────────────────────
{
  const html = renderShell({ space: "main", roster, connection: "connected" });
  ok("1.1 the head names the space", /<span class="ui-space[^"]*">main/.test(head(html)), head(html));
  ok("1.2 and has no menu: no button, no link, no chevron icon",
    !/<(button|a)\b/.test(head(html)) && !head(html).includes("<svg"), head(html));
  ok("1.3 before the first read names the space nothing is drawn for it, not a placeholder",
    !/null|undefined/.test(head(renderShell({ space: null }))) && strip(head(renderShell({ space: null }))).trim() === "");
}

// ── 2. Needs you ─────────────────────────────────────────────────────────────────────────────────
{
  const two = needs(renderShell({ roster }));
  ok("2.1 Needs you is a link to the needs view", two?.attrs.href === formatRoute({ view: "needs" }), two?.attrs);
  ok("2.2 it carries a gold count of the agents waiting: two here, and only the waiting ones",
    two?.badge?.cls === "ui-badge-gold" && two.badge.text === "2", two?.badge);
  ok("2.3 whose tooltip counts them in words", two?.badge?.title === "2 agents waiting", two?.badge);
  const one = needs(renderShell({ roster: roster.filter((p) => p.card.id !== "local.pln") }));
  ok("2.4 and says \"1 agent waiting\" for one", one?.badge?.text === "1" && one.badge.title === "1 agent waiting", one?.badge);
  const none = needs(renderShell({ roster: roster.filter((p) => p.status !== "waiting") }));
  ok("2.5 with nobody waiting the row stays and shows no count", none !== undefined && none.badge === undefined, none);
  const empty = needs(renderShell({}));
  ok("2.6 an empty mesh shows the row with no count, not a zero", empty !== undefined && empty.badge === undefined && !/>0</.test(empty.inner), empty);
  ok("2.7 the row is current on the needs route and not elsewhere",
    needs(renderShell({ roster }, { view: "needs" }))?.attrs["aria-current"] === "page" && two?.attrs["aria-current"] === undefined);
}

// ── 3. Activity and the message rate ─────────────────────────────────────────────────────────────
{
  const NOW = 100_000;
  const rate = createRate(10_000);
  for (let i = 0; i < 8; i++) rate.hit(NOW - i * 1000);
  const html = renderShell({ roster }, { view: "activity" }, false, () => rate.perSecond(NOW));
  ok("3.1 Activity is a link to the activity view, current on that route",
    activity(html)?.attrs.href === formatRoute({ view: "activity" }) && activity(html)?.attrs["aria-current"] === "page", activity(html)?.attrs);
  ok("3.2 it shows the rate the sidebar was handed, to one decimal: 0.8 msg/s", rateOf(html) === "0.8 msg/s", rateOf(html));
  ok("3.3 with no messages it says 0 msg/s", rateOf(renderShell({ roster })) === "0 msg/s", rateOf(renderShell({ roster })));
  ok("3.4 and it is not current off the activity route", activity(renderShell({ roster }, { view: "agents", group: "status" }))?.attrs["aria-current"] === undefined);
  same("3.5 the text rounds to one decimal and drops a trailing .0",
    [0, 0.84, 0.86, 4, 12.34, 0.04].map(rateText), ["0 msg/s", "0.8 msg/s", "0.9 msg/s", "4 msg/s", "12.3 msg/s", "0 msg/s"]);
}

// ── 4. Channels ──────────────────────────────────────────────────────────────────────────────────
{
  const seed = {
    roster,
    channels: [{ channel: "general", messages: 3 }, { channel: "team.backend", messages: 9 }, { channel: "run.build-0412", messages: 2 }, { channel: "runner", messages: 1 }, { channel: "a b/c", messages: 1 }],
    unread: { "team.backend": 3, general: 0 },
  };
  const html = renderShell(seed, { view: "channel", channel: "team.backend" });
  const rows = channels(html);
  same("4.1 one row per channel, in the store's order", rows.map((r) => r.label), ["general", "team.backend", "run.build-0412", "runner", "a b/c"]);
  const hash = renderToString(createElement(RailIcon, { name: "hash", size: 18 }));
  ok("4.2 an ordinary channel opens with the round 2 hash icon", rows[0].inner.startsWith(hash) && rows[1].inner.startsWith(hash), rows[0].inner.slice(0, 120));
  same("4.3 each row links to its channel route, the name encoded",
    rows.map((r) => r.attrs.href), seed.channels.map((c) => formatRoute({ view: "channel", channel: c.channel })));
  same("4.4 the open channel is the current one", rows.map((r) => r.attrs["aria-current"]), [undefined, "page", undefined, undefined, undefined]);
  ok("4.5 an unread count is a blue badge on a bold row", rows[1].badge?.cls === "ui-badge-blue" && rows[1].badge.text === "3" && rows[1].attrs.class.includes("ui-row-bold"), rows[1]);
  ok("4.6 a channel with none unread, counted zero or not at all, has no badge and is not bold",
    rows.filter((_, i) => i !== 1).every((r) => r.badge === undefined && !r.attrs.class.includes("ui-row-bold")), rows.map((r) => r.attrs.class));
  const plug = renderToString(createElement(Icon, { icon: Plug01Icon, size: 18, className: "ui-ic" }));
  ok("4.7 an event channel (run.*) is the one row drawn with the Hugeicons plug",
    rows[2].inner.startsWith(plug) && !rows[0].inner.includes(plug) && !rows[1].inner.includes(plug), rows[2].inner.slice(0, 120));
  ok("4.8 and its tooltip names the run: Events from run build-0412", rows[2].attrs.title === "Events from run build-0412", rows[2].attrs);
  ok("4.9 only the run. prefix makes an event channel: runner is an ordinary channel with no tooltip",
    rows[3].attrs.title === undefined && rows[3].inner.startsWith(hash) && rows[0].attrs.title === undefined, rows[3].attrs);
  const bare = section(renderShell({ roster }), "Channels");
  ok("4.10 with no channels the section says so, in the notes' words",
    strip(bare) === "ChannelsNo channels yet. One appears with its first message." || strip(bare).includes("No channels yet. One appears with its first message."), strip(bare));
  ok("4.11 and says nothing of the kind once a channel exists", !strip(section(html, "Channels")).includes("No channels yet"));
}

// ── 5. Direct messages ───────────────────────────────────────────────────────────────────────────
{
  const dmRows = [
    dm("d1", "local.rv2", "local.dav", 10, "local.rv2"),
    dm("d2", "local.dav", "local.rv2", 20, "local.dav"),
    dm("d3", "local.rev", "local.dav", 30),
    dm("d4", "local.sco", "local.ghost", 5, "local.sco"),
    dm("d5", "local.rv2", "local.sco", 40, "local.rv2"),
  ];
  const html = renderShell({ roster, dms: dmRows });
  const rows = dms(html);
  same("5.1 one row per conversation, newest first, though each talks under both its peers, linked opener first",
    rows.map((r) => r.attrs.href), [
      formatRoute({ view: "dm", peer: "local.rv2", with: "local.sco" }),
      formatRoute({ view: "dm", peer: "local.rev", with: "local.dav" }),
      formatRoute({ view: "dm", peer: "local.rv2", with: "local.dav" }),
      formatRoute({ view: "dm", peer: "local.sco", with: "local.ghost" }),
    ]);
  same("5.2 each row is named from the roster by id, the sender of its first message first, as the mock writes \"reviewer_2, david\": the payload's own name never shows",
    rows.map((r) => r.label), ["reviewer_2, scout", "reviewer, david", "reviewer_2, david", "scout, local.ghost"]);
  ok("5.3 no row or page text carries the payload's name", !html.includes("mallory"));
  ok("5.4 each row shows two small avatars, one per party, and no status dot",
    rows.every((r) => (r.inner.match(/<span class="ui-av[ "]/g) ?? []).length === 2 && !r.inner.includes("ui-st ")) && /<span class="ui-stack">/.test(rows[0].inner), rows[0].inner.slice(0, 200));
  ok("5.5 a party not on the roster is drawn offline, as the roster's own offline agents are",
    (rows[3].inner.match(/ui-av-off/g) ?? []).length === 2 && (rows[0].inner.match(/ui-av-off/g) ?? []).length === 1 && !rows[1].inner.includes("ui-av-off"), rows[3].inner.slice(0, 300));
  const at = (route: Route) => dms(renderShell({ roster, dms: dmRows }, route)).map((r) => r.attrs["aria-current"]);
  same("5.6 the row whose pair is open is current, whichever party the address names first",
    [at({ view: "dm", peer: "local.rev", with: "local.dav" }), at({ view: "dm", peer: "local.dav", with: "local.rev" })], [[undefined, "page", undefined, undefined], [undefined, "page", undefined, undefined]]);
  same("5.7 a route that names one peer marks no row", at({ view: "dm", peer: "local.dav" }), [undefined, undefined, undefined, undefined]);
  ok("5.8 no row reads \"to you\": the page does not know which id is the operator", !strip(section(html, "Direct messages")).includes("to you"));
  ok("5.9 with no conversations the heading stays and no row follows", dms(renderShell({ roster })).length === 0 && section(renderShell({ roster }), "Direct messages") !== "");
  const marks = rows.map((r) => startTags(r.inner, "span").filter((s) => s.class === "ui-unverified").map((s) => s.title));
  same("5.10 a conversation holding a history row, whose sender nothing checked, says unverified with the message rows' tooltip, and only that one",
    marks, [[], [UNVERIFIED], [], []]);
}

// ── 6. The operator footer and the connection pill ───────────────────────────────────────────────
{
  const up = foot(renderShell({ roster, connection: "connected" }));
  ok("6.1 the footer names the operator with the OP initials", /<span class="ui-me">OP<\/span>/.test(up) && /<b>operator<\/b>/.test(up), up);
  const pill = (html: string) => /<span class="(ui-live[^"]*)"([^>]*)>(<i><\/i>)?([^<]*)<\/span>/.exec(html);
  const titleOf = (p: RegExpExecArray | null) => (p ? startTags(`<span ${p[2]}>`, "span")[0].title : undefined);
  const p = pill(up);
  ok("6.2 a live feed reads Connected, with its tooltip", p?.[4] === "Connected" && titleOf(p) === "Connected to cotal web", p?.[0]);
  ok("6.3 and the pill is not in the down state", p?.[1] === "ui-live", p?.[1]);
  const down = pill(foot(renderShell({ roster, connection: "reconnecting" })));
  ok("6.4 a feed that dropped reads Reconnecting, never Connected", down?.[4] === "Reconnecting" && titleOf(down) === "Reconnecting to cotal web", down?.[0]);
  ok("6.5 and the dot takes its own shape (ui-live-down), so the state is not colour alone", down?.[1] === "ui-live ui-live-down" && down[3] === "<i></i>", down?.[0]);
  const first = pill(foot(renderShell({ roster })));
  ok("6.4b before the feed first opens it reads Connecting, with its tooltip, and not Reconnecting",
    first?.[4] === "Connecting" && titleOf(first) === "Connecting to cotal web" && first[1] === "ui-live ui-live-down", first?.[0]);
  ok("6.4c while the browser is still trying, the page does not say it is disconnected", !/Disconnected|Not connected|will not retry/.test(foot(renderShell({ roster })) + foot(renderShell({ roster, connection: "reconnecting" }))));
  const gone = pill(foot(renderShell({ roster, connection: "closed" })));
  ok("6.4d a feed the browser closed for good reads Disconnected, says why and what to do, and keeps the down shape",
    gone?.[4] === "Disconnected" && gone[1] === "ui-live ui-live-down"
      && titleOf(gone) === "The live feed closed and will not retry. Reload the page, or open the link cotal web printed when it started.", gone?.[0]);
  ok("6.6 no footer line claims the operator's place on the roster: the mesh's mode is not known here",
    !/On the roster|Not on the roster|Read only/.test(up), strip(up));
}

// ── 7. The sidebar's place in the shell ──────────────────────────────────────────────────────────
{
  const html = renderShell({ space: "main", roster, connection: "connected", stale: [{ kind: "refused", name: "peers", reason: "HTTP 503" }] });
  const s = side(html);
  const at = (needle: string) => s.indexOf(needle);
  ok("7.1 the head comes first, then the stale marker, then the places, then the footer",
    at('class="ui-side-head"') >= 0 && at('class="ui-side-head"') < at('id="stale"') && at('id="stale"') < at('class="ui-side-scroll"') && at('class="ui-side-scroll"') < at('class="ui-side-foot"'), s.slice(0, 200));
  const text = strip(scroll(html));
  ok("7.2 the places hold Needs you, Activity, then Channels and Direct messages, in that order",
    text.indexOf("Needs you") >= 0 && text.indexOf("Needs you") < text.indexOf("Activity") && text.indexOf("Activity") < text.indexOf("Channels")
    && text.indexOf("Channels") < text.indexOf("Direct messages"), text);
}

// ── 8. The arrivals the rate counts ──────────────────────────────────────────────────────────────
{
  const emptyApi: Api = {
    meta: async () => ({ space: "main", pid: 1 }),
    roster: async () => [],
    channels: async () => [],
    activity: async () => ({ entries: [], partial: false, read: 1, of: 1, missing: [], reasons: {}, deadlineMs: 1 }),
    dms: async () => [],
    history: async () => [],
    membership: async () => ({ members: [] }) as never,
    deleteChannel: async (channel) => ({ ok: true, channel, purged: 0 }),
  };
  const frame = (id: string): FeedMessage => ({ mode: "chat", channel: "general", senderId: "local.dav", msg: { id, ts: 1, space: "main", from: { id: "local.dav" }, parts: [{ kind: "text", text: "hi" }] } as unknown as CotalMessage });
  let handlers!: FeedHandlers;
  let arrivals = 0;
  const store = createStore<DashboardState>({ ...initialState });
  const dash = startDashboard({ store, api: emptyApi, openFeed: (h) => ((handlers = h), () => undefined), onArrival: () => void arrivals++ });
  handlers.message(frame("m1"));
  handlers.message(frame("m1"));
  handlers.message(frame("m2"));
  ok("8.1 every message the feed delivers is reported once, a duplicate delivery included", arrivals === 3, arrivals);
  await new Promise((r) => setTimeout(r, 20));
  ok("8.2 and the controller still takes each (a duplicate id is kept once)", store.get().activity.map((e) => e.msg.id).join() === "m1,m2", store.get().activity.map((e) => e.msg.id));
  dash.stop();
  const quietStore = createStore<DashboardState>({ ...initialState });
  const quiet = startDashboard({ store: quietStore, api: emptyApi, openFeed: (h) => ((handlers = h), () => undefined) });
  handlers.message(frame("m3"));
  await new Promise((r) => setTimeout(r, 20));
  ok("8.3 a dashboard started with no arrival listener takes messages as before", quietStore.get().activity.map((e) => e.msg.id).join() === "m3", quietStore.get().activity.map((e) => e.msg.id));
  quiet.stop();

  // The rate is messages per second ARRIVING. The bootstrap's activity page and a channel's history
  // are messages that arrived before the page looked, so counting them would report a burst that
  // never happened every time the feed reconnects.
  const old = (id: string, to?: string) => ({ id, ts: 1, space: "main", from: { id: "local.dav" }, to, parts: [{ kind: "text", text: "old" }] }) as unknown as CotalMessage;
  const fullApi: Api = {
    ...emptyApi,
    activity: async () => ({ entries: [{ mode: "chat", channel: "general", msg: old("h1") }, { mode: "unicast", msg: old("h2", "local.rev") }], partial: false, read: 2, of: 2, missing: [], reasons: {}, deadlineMs: 1 }),
    dms: async () => [old("h3", "local.rev")],
    history: async () => [old("h4"), old("h5")],
  };
  let readArrivals = 0;
  const readStore = createStore<DashboardState>({ ...initialState });
  const reads = startDashboard({ store: readStore, api: fullApi, openFeed: (h) => ((handlers = h), () => undefined), onArrival: () => void readArrivals++ });
  handlers.open();
  await reads.controller.refresh();
  await reads.controller.open("general");
  await reads.controller.refresh();
  await new Promise((r) => setTimeout(r, 20));
  ok("8.4 the bootstrap's activity page, the DM read and a channel's history are not arrivals: the rate counts only live messages",
    readArrivals === 0 && readStore.get().activity.length === 2 && readStore.get().open?.messages.length === 2, { readArrivals, activity: readStore.get().activity.length, open: readStore.get().open?.messages.length });
  reads.stop();
}

// ── 9. The mounted app: arrivals become the rate, and the tick stops with the page ───────────────
// The app's clock is injected and the tick is fired by hand, so no cell waits on a real timer.
{
  let arrive!: () => void;
  let stops = 0;
  let now = 1_000_000;
  const clock = () => now;
  const controller = { open: async () => undefined } as unknown as Controller;
  const start = (_store: unknown, onArrival: () => void) => ((arrive = onArrival), { controller, stop: () => void stops++ });
  const host: RouteHost = { location: { hash: "#/activity", pathname: "/" }, addEventListener: () => undefined, removeEventListener: () => undefined };
  const g = globalThis as unknown as { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  const realSet = g.setInterval;
  const realClear = g.clearInterval;
  const live = new Map<unknown, () => void>();
  g.setInterval = ((fn: () => void, ms?: number) => { const id = realSet(fn, ms); live.set(id, fn); return id; }) as typeof setInterval;
  g.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => { live.delete(id); realClear(id); }) as typeof clearInterval;
  try {
    const m = await mount(createElement(App, { host, start: start as never, clock }));
    const shown = () => m.container.querySelector(".ui-side .ui-row-n")?.textContent;
    ok("9.1 a freshly mounted app shows 0 msg/s", shown() === "0 msg/s", shown());
    ok("9.2 the app is ticking while mounted", live.size === 1, live.size);
    await m.run(() => { arrive(); arrive(); arrive(); });
    now += 5_000;
    await m.run(() => { for (const tick of live.values()) tick(); });
    ok("9.3 three arrivals reach the Activity row on the next tick, over the five seconds the page has watched: 0.6 msg/s", shown() === "0.6 msg/s", shown());
    await m.unmount();
    ok("9.4 unmounting stops the tick", live.size === 0, live.size);
    ok("9.5 and stops the dashboard", stops === 1, stops);
  } finally {
    g.setInterval = realSet;
    g.clearInterval = realClear;
  }
}

await closeDom();
console.log(`sidebar: ${n} checks passed`);
