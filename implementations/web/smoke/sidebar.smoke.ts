/** The sidebar (mock section D): the space name with no menu, Needs you with its gold count,
 *  Activity with the message rate, the channels with their unread counts, one row per direct
 *  message conversation, and the operator footer with the connection pill. Each cell server-renders
 *  the shell over a seeded store and reads the HTML by role, name and text; the Tooltips, which are
 *  drawn only once they open, are read from the places mounted in jsdom. Three cells run the wiring: the feed reports
 *  every arrival to the dashboard's `onArrival`, the mounted app turns those arrivals into the
 *  rate, and the one-second tick that redraws the rate stops on unmount.
 *
 *  What is pinned, beyond the markup: every name comes from the roster by id and never from a
 *  payload; an event channel (`run.*`) is the one row drawn with the plug icon; no footer line
 *  claims the operator's place on the roster before `/api/meta` has said what the dashboard can post
 *  as (compose.smoke.ts pins the lines it draws after); and no DM row reads "to you". The direct
 *  messages list the ten most recent conversations and the open one, then a "Show all" button that
 *  lists the rest in place, and a roster change redraws the names without regrouping the DMs. A
 *  channel row counts its working members from the broker's membership and presence alone, never
 *  from the event plane or from who posted, and a DM row's parties draw their status dots. */
import { closeDom, dom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { Plug01Icon } from "@hugeicons/core-free-icons";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { FeedHandlers } from "../client/src/api/feed.js";
import type { CotalMessage, FeedMessage, MembershipSnapshot, RosterEntry } from "../client/src/api/types.js";
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
import { DM_ROWS, Sidebar } from "../client/src/ui/Sidebar.tsx";
import { mount } from "./mount.js";
import { inShell } from "./providers.js";
import { parseHtml, renderShell } from "./render-shell.js";

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

// ── Reading the sidebar ──────────────────────────────────────────────────────────────────────────
const textOf = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
/** What a screen reader reads in `el`: its text without what is hidden from assistive tech. */
const spoken = (el: Element | null | undefined): string => {
  if (!el) return "";
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((h) => h.remove());
  return textOf(copy);
};
const side = (html: string) => parseHtml(html).querySelector('[role="complementary"][aria-label="Space"]');
const placesIn = (html: string) => side(html)?.querySelector('[role="navigation"][aria-label="Places"]') ?? null;
interface Row { a: HTMLAnchorElement; href: string | null; current: string | null; label: string; name: string; badge?: string }
/** A place's row: its link, the words it shows, the name a screen reader reads, and the count at its
 *  end, which sits beside the link and is hidden from assistive tech. */
const rowOf = (a: HTMLAnchorElement): Row => {
  const label = Array.from(a.children).find((c) => c.tagName === "SPAN" && c.getAttribute("aria-hidden") !== "true" && !c.matches(".ui-sr, [data-slot=tooltip-trigger]"));
  const badge = a.closest("li")?.querySelector('[data-sidebar="menu-badge"]');
  return { a, href: a.getAttribute("href"), current: a.getAttribute("aria-current"), label: textOf(label), name: spoken(a), badge: badge ? textOf(badge) : undefined };
};
const rowsIn = (el: Element | null | undefined): Row[] => Array.from(el?.querySelectorAll("a") ?? []).map((a) => rowOf(a as HTMLAnchorElement));
/** The places group under the heading `name`. */
const section = (html: string, name: string) =>
  Array.from(placesIn(html)?.querySelectorAll('[data-sidebar="group"]') ?? []).find((g) => textOf(g.querySelector('[data-sidebar="group-label"]')) === name);
const head = (html: string) => side(html)?.querySelector('[data-sidebar="header"]') ?? null;
const foot = (html: string) => side(html)?.querySelector('[data-sidebar="footer"]') ?? null;
const needs = (html: string) => rowsIn(placesIn(html)).find((r) => r.label === "Needs you");
const activity = (html: string) => rowsIn(placesIn(html)).find((r) => r.label === "Activity");
const channels = (html: string) => rowsIn(section(html, "Channels"));
const dms = (html: string) => rowsIn(section(html, "Direct messages"));
const rateOf = (html: string) => activity(html)?.badge;
/** `html` parsed, as the first element it holds. */
const elementOf = (html: string) => parseHtml(html).body.firstElementChild;
/** The Tooltip each element shows when it takes the focus, from the places mounted over `patch`. */
const tipsOn = async (patch: Partial<DashboardState>, pick: (places: Element) => (Element | null | undefined)[]): Promise<string[]> => {
  const store = createStore<DashboardState>({ ...initialState, ...patch });
  const m = await mount(inShell(createElement(Sidebar, { store, route: { view: "activity" }, msgPerSecond: () => 0 })));
  const places = m.container.querySelector('[aria-label="Places"]')!;
  const tips: string[] = [];
  for (const el of pick(places)) {
    // A Tooltip on a part inside a link opens on the part, which does not take the focus; the pointer opens it.
    const target = el as HTMLElement;
    if (target?.matches("a")) await m.run(() => target.focus());
    else {
      await m.run(() => target?.dispatchEvent(new PointerEvent("pointermove", { bubbles: true })));
      await m.run(() => new Promise<void>((r) => setTimeout(r, 0)));
    }
    tips.push(textOf(document.querySelector('[role="tooltip"]')));
    if (target?.matches("a")) await m.run(() => target.blur());
    else await m.run(() => document.dispatchEvent(new (dom.window.KeyboardEvent as typeof KeyboardEvent)("keydown", { key: "Escape", bubbles: true })));
  }
  await m.unmount();
  return tips;
};

// ── 1. The head: the space name, no menu ─────────────────────────────────────────────────────────
{
  const html = renderShell({ space: "main", roster, connection: "connected" });
  ok("1.1 the head names the space", textOf(head(html)) === "main", head(html)?.outerHTML);
  ok("1.2 and has no menu: no button, no link, no chevron icon",
    head(html)?.querySelector("button, a, svg") === null, head(html)?.outerHTML);
  ok("1.3 before the first read names the space nothing is drawn for it, not a placeholder",
    head(renderShell({ space: null })) !== null && textOf(head(renderShell({ space: null }))) === "", head(renderShell({ space: null }))?.outerHTML);
}

// ── 2. Needs you ─────────────────────────────────────────────────────────────────────────────────
{
  const two = needs(renderShell({ roster }));
  ok("2.1 Needs you is a link to the needs view", two?.href === formatRoute({ view: "needs" }), two?.href);
  ok("2.2 it carries a count of the agents waiting: two here, and only the waiting ones", two?.badge === "2", two?.badge);
  ok("2.3 which a screen reader hears in words", two?.name === "Needs you 2 agents waiting", two?.name);
  const one = needs(renderShell({ roster: roster.filter((p) => p.card.id !== "local.pln") }));
  ok("2.4 and says \"1 agent waiting\" for one", one?.badge === "1" && one.name === "Needs you 1 agent waiting", one);
  const none = needs(renderShell({ roster: roster.filter((p) => p.status !== "waiting") }));
  ok("2.5 with nobody waiting the row stays and shows no count", none !== undefined && none.badge === undefined && none.name === "Needs you", none?.name);
  const empty = needs(renderShell({}));
  ok("2.6 an empty mesh shows the row with no count, not a zero", empty !== undefined && empty.badge === undefined && !textOf(empty.a.closest("li")).includes("0"), empty?.name);
  ok("2.7 the row is current on the needs route and not elsewhere",
    needs(renderShell({ roster }, { view: "needs" }))?.current === "page" && two?.current === null);
  same("2.8 its Tooltip counts the agents waiting in words, and with nobody waiting it has none",
    [await tipsOn({ roster }, (p) => [p.querySelector('a[href="#/needs"]')]), await tipsOn({ roster: roster.filter((r) => r.status !== "waiting") }, (p) => [p.querySelector('a[href="#/needs"]')])],
    [["2 agents waiting"], [""]]);
}

// ── 3. Activity and the message rate ─────────────────────────────────────────────────────────────
{
  const NOW = 100_000;
  const rate = createRate(10_000);
  for (let i = 0; i < 8; i++) rate.hit(NOW - i * 1000);
  const html = renderShell({ roster }, { view: "activity" }, false, () => rate.perSecond(NOW));
  ok("3.1 Activity is a link to the activity view, current on that route",
    activity(html)?.href === formatRoute({ view: "activity" }) && activity(html)?.current === "page", activity(html)?.href);
  ok("3.2 it shows the rate the sidebar was handed, to one decimal: 0.8 msg/s, and a screen reader hears it in the row's name",
    rateOf(html) === "0.8 msg/s" && activity(html)?.name === "Activity 0.8 msg/s", activity(html)?.name);
  ok("3.3 with no messages it says 0 msg/s", rateOf(renderShell({ roster })) === "0 msg/s", rateOf(renderShell({ roster })));
  ok("3.4 and it is not current off the activity route", activity(renderShell({ roster }, { view: "agents", group: "status" }))?.current === null);
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
  const hash = elementOf(renderToString(createElement(RailIcon, { name: "hash" })));
  ok("4.2 an ordinary channel opens with the round 2 hash icon",
    hash !== null && rows[0].a.firstElementChild?.isEqualNode(hash) === true && rows[1].a.firstElementChild?.isEqualNode(hash) === true, rows[0].a.innerHTML.slice(0, 120));
  same("4.3 each row links to its channel route, the name encoded",
    rows.map((r) => r.href), seed.channels.map((c) => formatRoute({ view: "channel", channel: c.channel })));
  same("4.4 the open channel is the current one", rows.map((r) => r.current), [null, "page", null, null, null]);
  ok("4.5 an unread count shows at the row's end, and a screen reader hears it in the row's name", rows[1].badge === "3" && rows[1].name === "team.backend 3", rows[1].name);
  same("4.6 a channel with none unread, counted zero or not at all, has no count",
    rows.filter((_, i) => i !== 1).map((r) => [r.badge ?? null, r.name]),
    [[null, "general"], [null, "run.build-0412 Events from run build-0412"], [null, "runner"], [null, "a b/c"]]);
  const plug = elementOf(renderToString(createElement(Icon, { icon: Plug01Icon })));
  ok("4.7 an event channel (run.*) is the one row drawn with the Hugeicons plug",
    plug !== null && rows[2].a.firstElementChild?.isEqualNode(plug) === true && rows.filter((r) => r.a.firstElementChild?.isEqualNode(plug)).length === 1, rows[2].a.innerHTML.slice(0, 120));
  ok("4.8 and it names the run to a screen reader: Events from run build-0412", rows[2].name === "run.build-0412 Events from run build-0412", rows[2].name);
  ok("4.9 only the run. prefix makes an event channel: runner is an ordinary channel named by itself",
    rows[3].name === "runner" && rows[3].a.firstElementChild?.isEqualNode(hash) === true && rows[0].name === "general", rows[3].name);
  same("4.10 the Tooltip names the run, and an ordinary channel has none",
    await tipsOn(seed, (p) => [p.querySelector('a[href="#/channel/run.build-0412"]'), p.querySelector('a[href="#/channel/runner"]')]), ["Events from run build-0412", ""]);
  const bare = section(renderShell({ roster }), "Channels");
  ok("4.11 with no channels the section says so, in the notes' words",
    textOf(bare).includes("No channels yet. One appears with its first message.") && rowsIn(bare).length === 0, textOf(bare));
  ok("4.12 and says nothing of the kind once a channel exists", !textOf(section(html, "Channels")).includes("No channels yet"));
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
    rows.map((r) => r.href), [
      formatRoute({ view: "dm", peer: "local.rv2", with: "local.sco" }),
      formatRoute({ view: "dm", peer: "local.rev", with: "local.dav" }),
      formatRoute({ view: "dm", peer: "local.rv2", with: "local.dav" }),
      formatRoute({ view: "dm", peer: "local.sco", with: "local.ghost" }),
    ]);
  same("5.2 each row is named from the roster by id, the sender of its first message first, as the mock writes \"reviewer_2, david\": the payload's own name never shows",
    rows.map((r) => r.label), ["reviewer_2, scout", "reviewer, david", "reviewer_2, david", "scout, local.ghost"]);
  ok("5.3 no row or page text carries the payload's name", !html.includes("mallory"));
  const inner = (r: Row) => r.a.innerHTML;
  same("5.4 each row shows two small avatars, one per party, and a status dot for each party the roster holds, so a working one's dot breathes",
    [rows.map((r) => (inner(r).match(/<span class="ui-av[ "]/g) ?? []).length), rows.map((r) => (inner(r).match(/class="ui-st ui-st-/g) ?? []).length), inner(rows[1]).includes("ui-st ui-st-working"), rows[0].a.querySelector(".ui-stack") !== null],
    [[2, 2, 2, 2], [2, 2, 2, 1], true, true]);
  ok("5.5 a party not on the roster is drawn offline, as the roster's own offline agents are",
    (inner(rows[3]).match(/ui-av-off/g) ?? []).length === 2 && (inner(rows[0]).match(/ui-av-off/g) ?? []).length === 1 && !inner(rows[1]).includes("ui-av-off"), inner(rows[3]).slice(0, 300));
  const at = (route: Route) => dms(renderShell({ roster, dms: dmRows }, route)).map((r) => r.current);
  same("5.6 the row whose pair is open is current, whichever party the address names first",
    [at({ view: "dm", peer: "local.rev", with: "local.dav" }), at({ view: "dm", peer: "local.dav", with: "local.rev" })], [[null, "page", null, null], [null, "page", null, null]]);
  same("5.7 a route that names one peer marks no row", at({ view: "dm", peer: "local.dav" }), [null, null, null, null]);
  ok("5.8 no row reads \"to you\": the page does not know which id is the operator", !textOf(section(html, "Direct messages")).includes("to you"));
  ok("5.9 with no conversations the heading stays and no row follows", dms(renderShell({ roster })).length === 0 && section(renderShell({ roster }), "Direct messages") !== undefined);
  /** The row's name after the two names it shows: the unverified mark, read with its reason, or nothing. */
  const rest = (r: Row) => r.name.slice(r.label.length).trim();
  const marks = rows.map((r) => (rest(r) === `unverified ${UNVERIFIED}` ? [UNVERIFIED] : []));
  same("5.10 a conversation holding a history row, whose sender nothing checked, says unverified with the message rows' reason, and only that one",
    marks, [[], [UNVERIFIED], [], []]);
  ok("5.11 each row's avatars are hidden from assistive tech, so its dots do not change the row's name",
    rows.every((r) => r.a.querySelectorAll(".ui-av").length === 2 && Array.from(r.a.querySelectorAll(".ui-av")).every((av) => av.closest('[aria-hidden="true"]') !== null))
      && rows.every((r) => r.name.startsWith(r.label) && (rest(r) === "" || marks[rows.indexOf(r)].length === 1)), rows.map((r) => r.name));
}

// ── 6. The operator footer and the connection pill ───────────────────────────────────────────────
{
  const up = foot(renderShell({ roster, connection: "connected" }));
  ok("6.1 the footer names the operator with the OP initials",
    textOf(up?.querySelector('[data-slot="avatar"]')) === "OP" && textOf(up?.querySelector('[data-slot="item-title"]')) === "operator", up?.outerHTML.slice(0, 300));
  /** The pill: the word it shows, what a screen reader hears, its variant and its dot's mark. */
  const pill = (f: Element | null) => {
    const el = f?.querySelector('[data-slot="item-actions"] > *');
    return el ? {
      word: Array.from(el.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join("").trim(),
      said: spoken(el),
      variant: el.getAttribute("data-variant"),
      dot: el.querySelector("i")?.className,
    } : undefined;
  };
  const p = pill(up);
  ok("6.2 a live feed reads Connected, and says what it is connected to", p?.word === "Connected" && p.said === "Connected Connected to cotal web", p);
  const down = pill(foot(renderShell({ roster, connection: "reconnecting" })));
  ok("6.3 and its dot is not the dot of a feed that is down", p?.dot !== undefined && down?.dot !== undefined && p.dot !== down.dot, { up: p?.dot, down: down?.dot });
  ok("6.4 a feed that dropped reads Reconnecting, never Connected", down?.word === "Reconnecting" && down.said === "Reconnecting Reconnecting to cotal web", down);
  ok("6.5 and the dot takes its own shape, so the state is not colour alone", down?.dot !== p?.dot && down?.variant === p?.variant, { up: p, down });
  const first = pill(foot(renderShell({ roster })));
  ok("6.4b before the feed first opens it reads Connecting, says so in words, and not Reconnecting",
    first?.word === "Connecting" && first.said === "Connecting Connecting to cotal web" && first.dot === down?.dot, first);
  ok("6.4c while the browser is still trying, the page does not say it is disconnected", !/Disconnected|Not connected|will not retry/.test(textOf(foot(renderShell({ roster }))) + textOf(foot(renderShell({ roster, connection: "reconnecting" })))));
  const gone = pill(foot(renderShell({ roster, connection: "closed" })));
  ok("6.4d a feed the browser closed for good reads Disconnected, says why and what to do, keeps the down shape and turns destructive",
    gone?.word === "Disconnected" && gone.dot === down?.dot && gone.variant === "destructive"
      && gone.said === "Disconnected The live feed closed and will not retry. Reload the page, or open the link cotal web printed when it started.", gone);
  ok("6.6 no footer line claims the operator's place on the roster: the mesh's mode is not known here",
    !/On the roster|Not on the roster|Read only/.test(textOf(up)), textOf(up));
}

// ── 7. The sidebar's place in the shell ──────────────────────────────────────────────────────────
{
  const html = renderShell({ space: "main", roster, connection: "connected", stale: [{ kind: "refused", name: "peers", reason: "HTTP 503" }] });
  const s = side(html);
  const parts = [s?.querySelector('[data-sidebar="header"]'), s?.querySelector("#stale"), s?.querySelector('[aria-label="Places"]'), s?.querySelector('[data-sidebar="footer"]')];
  ok("7.1 the head comes first, then the stale marker, then the places, then the footer",
    parts.every((x) => x) && parts.every((x, k) => k === 0 || (parts[k - 1]!.compareDocumentPosition(x!) & 4) !== 0), parts.map((x) => x?.tagName));
  const text = textOf(placesIn(html));
  ok("7.2 the places hold Needs you, Activity, then Channels and Direct messages, in that order",
    text.indexOf("Needs you") >= 0 && text.indexOf("Needs you") < text.indexOf("Activity") && text.indexOf("Activity") < text.indexOf("Channels")
    && text.indexOf("Channels") < text.indexOf("Direct messages"), text);
}

// ── 8. The arrivals the rate counts ──────────────────────────────────────────────────────────────
{
  const emptyApi: Api = {
    meta: async () => ({ space: "main", pid: 1, post: { mode: "participant" as const } }),
    roster: async () => [],
    channels: async () => [],
    activity: async () => ({ entries: [], partial: false, read: 1, of: 1, missing: [], reasons: {}, deadlineMs: 1 }),
    dms: async () => [],
    history: async () => [],
    membership: async () => ({ members: [] }) as never,
    deleteChannel: async (channel) => ({ ok: true, channel, purged: 0 }),
    send: async () => { throw new Error("send not expected here"); },
    agentEvents: async () => { throw new Error("agentEvents not expected here"); },
    watch: async () => { throw new Error("watch not expected here"); },
    unwatch: async () => { throw new Error("unwatch not expected here"); },
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
  const host: RouteHost = { location: { hash: "#/activity", pathname: "/" }, history: { replaceState: () => undefined }, addEventListener: () => undefined, removeEventListener: () => undefined };
  const g = globalThis as unknown as { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  const realSet = g.setInterval;
  const realClear = g.clearInterval;
  const live = new Map<unknown, () => void>();
  g.setInterval = ((fn: () => void, ms?: number) => { const id = realSet(fn, ms); live.set(id, fn); return id; }) as typeof setInterval;
  g.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => { live.delete(id); realClear(id); }) as typeof clearInterval;
  try {
    const m = await mount(createElement(App, { host, start: start as never, clock }));
    const shown = () => m.container.querySelector('[aria-label="Places"] a[href="#/activity"]')?.closest("li")?.querySelector('[data-sidebar="menu-badge"]')?.textContent;
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

// ── 10. A long list of conversations ─────────────────────────────────────────────────────────────
// Twelve conversations, each david with another agent, the newest first: c0 is the newest, c11 the oldest.
{
  const many = Array.from({ length: 12 }, (_, i) => entry(`local.a${i}`, `agent${i}`, "idle"));
  const people = [...roster, ...many];
  const talk = many.map((p, i) => dm(`c${i}`, p.card.id, "local.dav", 1000 - i, p.card.id));
  const routeTo = (i: number): Route => ({ view: "dm", peer: `local.a${i}`, with: "local.dav" });
  const toggle = (html: string) => section(html, "Direct messages")?.querySelector("button[aria-expanded]") ?? undefined;
  const html = renderShell({ roster: people, dms: talk });
  same("10.1 with twelve conversations the sidebar lists the ten most recent, newest first",
    dms(html).map((r) => r.href), Array.from({ length: DM_ROWS }, (_, i) => formatRoute(routeTo(i))));
  ok("10.2 then a Show all button with the count, collapsed",
    toggle(html)?.getAttribute("type") === "button" && toggle(html)?.getAttribute("aria-expanded") === "false" && textOf(toggle(html)) === "Show all 12", toggle(html)?.outerHTML);
  const openOld = renderShell({ roster: people, dms: talk }, routeTo(11));
  same("10.3 an open conversation older than the ten is listed too, after them, and is the current row",
    dms(openOld).map((r) => [r.href, r.current]).slice(DM_ROWS - 1),
    [[formatRoute(routeTo(9)), null], [formatRoute(routeTo(11)), "page"]]);
  const ten = renderShell({ roster: people, dms: talk.slice(0, DM_ROWS) });
  ok("10.4 with ten conversations every one is listed and there is no button", dms(ten).length === DM_ROWS && toggle(ten) === undefined, toggle(ten));

  const store = createStore<DashboardState>({ ...initialState, roster: people, dms: talk });
  const m = await mount(inShell(createElement(Sidebar, { store, route: { view: "activity" }, msgPerSecond: () => 0 })));
  const listed = () => m.container.querySelectorAll('[aria-label="Places"] a[href^="#/dm"]').length;
  const button = () => m.container.querySelector('[aria-label="Places"] button[aria-expanded]') as HTMLButtonElement | null;
  await m.run(() => button()?.click());
  ok("10.5 Show all lists every conversation in place, and the button then reads Show fewer, expanded",
    listed() === 12 && button()?.getAttribute("aria-expanded") === "true" && button()?.textContent === "Show fewer", { listed: listed(), button: button()?.outerHTML });
  await m.run(() => button()?.click());
  ok("10.6 and Show fewer goes back to the ten, collapsed, with the count",
    listed() === DM_ROWS && button()?.getAttribute("aria-expanded") === "false" && button()?.textContent === "Show all 12", { listed: listed(), button: button()?.outerHTML });
  await m.unmount();

  // The conversations are grouped from the DMs alone. A list that counts how often it is walked
  // shows whether a roster change, which comes with every heartbeat, grouped them again.
  let walks = 0;
  const counted = talk.slice() as StoredMessage[];
  const walk = Array.prototype[Symbol.iterator];
  counted[Symbol.iterator] = function (this: StoredMessage[]) { walks++; return walk.call(this); };
  const live = createStore<DashboardState>({ ...initialState, roster: people, dms: counted });
  const shown = await mount(inShell(createElement(Sidebar, { store: live, route: { view: "activity" }, msgPerSecond: () => 0 })));
  const before = walks;
  const renamed = people.map((p) => (p.card.id === "local.dav" ? { ...p, card: { ...p.card, name: "dave" }, ts: 2 } : { ...p, ts: 2 }));
  await shown.run(() => live.set({ roster: renamed }));
  const firstDm = shown.container.querySelector('[aria-label="Places"] a[href^="#/dm"]');
  const firstLabel = firstDm ? rowOf(firstDm as HTMLAnchorElement).label : undefined;
  ok("10.7 a roster change does not group the DMs again", before > 0 && walks === before, { before, after: walks });
  ok("10.8 and the rows take their names from the new roster", firstLabel === "agent0, dave", firstLabel);
  await shown.unmount();
}

// ── 11. Working members on a channel row ─────────────────────────────────────────────────────────
{
  const crew: RosterEntry[] = [entry("local.rev", "reviewer", "working", "codex"), entry("local.dav", "david", "working", "claude-code"), entry("local.rv2", "reviewer_2", "waiting", "opencode")];
  const feed: MembershipSnapshot = {
    asOf: Date.now(),
    members: [
      { id: "local.rev", live: ["general", "team.backend"], durable: [], observedAt: 1 },
      { id: "local.dav", live: [], durable: ["general"], observedAt: 1 },
      { id: "local.rv2", live: ["general", "ops"], durable: [], observedAt: 1 },
    ],
  } as unknown as MembershipSnapshot;
  const chans = [{ channel: "general", messages: 3 }, { channel: "team.backend", messages: 1 }, { channel: "ops", messages: 1 }];
  /** A channel row's working count: the spokes and the number it shows, and the names a screen reader hears. */
  const spokes = (r: Row | undefined) => Array.from(r?.a.querySelectorAll('[data-slot="tooltip-trigger"]') ?? []).find((t) => t.querySelector("svg") !== null);
  const working = (r: Row | undefined) => {
    const w = spokes(r);
    return w ? { title: spoken(w), text: textOf(w.querySelector('[aria-hidden="true"]:not(svg)')), spins: w.querySelector("svg")?.classList.contains("ox-spin") === true } : undefined;
  };
  const rows = channels(renderShell({ roster: crew, channels: chans, membership: { snapshot: feed }, unread: { general: 3 } }));
  same("11.1 a channel with working members shows the turning spokes and how many, from the broker's membership and presence, titled with their names",
    working(rows[0]), { title: "2 members working: reviewer, david", text: "2", spins: true });
  const unreadBadge = rows[0]?.a.closest("li")?.querySelector('[data-sidebar="menu-badge"]');
  ok("11.2 the count comes before the unread count", spokes(rows[0]) !== undefined && unreadBadge != null && (spokes(rows[0])!.compareDocumentPosition(unreadBadge) & 4) !== 0, rows[0]?.a.outerHTML);
  same("11.3 one working member reads 1 member working", working(rows[1]), { title: "1 member working: reviewer", text: "1", spins: true });
  ok("11.4 a channel whose members are waiting or idle shows no count", rows[2] !== undefined && working(rows[2]) === undefined && rows[2].name === "ops", rows[2]?.name);
  same("11.4b the spokes' Tooltip names the members working",
    await tipsOn({ roster: crew, channels: chans, membership: { snapshot: feed } }, (p) => [spokes(rowOf(p.querySelector('a[href="#/channel/general"]') as HTMLAnchorElement))]),
    ["2 members working: reviewer, david"]);
  // The event plane says reviewer is running a command; presence says idle. The count follows presence.
  const ts = Date.now() - 5000;
  const plane = { views: 1, frames: [{ id: "f1", ts, live: true, events: [{ type: "RUN_STARTED", threadId: "t", runId: "r1", timestamp: ts }, { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "Bash", timestamp: ts }] }], posts: [], load: "ok" as const, more: false, limit: 200 };
  const idle = crew.map((p) => ({ ...p, status: "idle" as const }));
  const quiet = channels(renderShell({ roster: idle, channels: chans, membership: { snapshot: feed }, sessions: { "local.rev": plane } }));
  ok("11.5 the count reads presence alone: an idle roster with a working frame on the event plane shows no count", quiet.length === 3 && quiet.every((r) => working(r) === undefined), quiet.map((r) => r.name));
  const posted: StoredMessage[] = [{ msg: { id: "p1", ts, space: "main", from: { id: "local.rev", name: "mallory" }, channel: "general", parts: [{ kind: "text", text: "hi" }] } as unknown as CotalMessage, senderId: "local.rev" }];
  const traffic = channels(renderShell({ roster: crew, channels: chans, membership: {}, open: { channel: "general", messages: posted } }));
  ok("11.6 with no authoritative membership feed no channel shows a count, though a working agent posted there", traffic.length === 3 && traffic.every((r) => working(r) === undefined), traffic.map((r) => r.name));
}

await closeDom();
console.log(`sidebar: ${n} checks passed`);
