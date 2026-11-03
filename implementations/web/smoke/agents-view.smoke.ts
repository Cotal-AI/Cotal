/** The Agents view (mock section A1 and the Agents frame of section D) and the Needs route. Sections
 *  1 to 4 render `Shell` on the server over seeded stores and read the DOM it drew: the groups in
 *  order with their icons and counts, hidden empty groups, the rows, the attention badges and their
 *  tooltips, the endpoints, the heartbeat line, the host grouping, the Needs route's focused Waiting
 *  group and the empty space. Section 5 mounts the view in jsdom: the Status and Host toggle and its
 *  saving (with storage blocked too), a row click reaching the caller and, in the shell, opening the
 *  Agent tab on that agent, a row that moves group keeping its selection and focus, and the heartbeat
 *  ages redrawing on their own and stopping on unmount.
 *
 *  What is pinned, beyond the markup: a status the wire carries outside the four is listed, never
 *  dropped; an offline agent's old heartbeat never counts toward the live agents' oldest; a working
 *  agent that reports no progress never reads "No current activity". Section 11 mounts the view over
 *  a fake controller: the first 12 working rows in display order hold their agents' work open and the
 *  rest show presence only, a row that stops working and the view's unmount close what they held, a
 *  running call draws the row's live step, and View work sits beside the row's button. */
import { closeDom, dom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { HourglassIcon, Loading03Icon, Moon02Icon, NotificationOff01Icon, Plug01Icon, ServerStack01Icon, Target02Icon, UnavailableIcon } from "@hugeicons/core-free-icons";
import { createElement, useState } from "react";
import { renderToString } from "react-dom/server";
import type { RosterEntry } from "../client/src/api/types.js";
import { Icon } from "../client/src/icons/Icon.tsx";
import { formatRoute, type Route } from "../client/src/lib/route.js";
import type { Controller } from "../client/src/state/controller.js";
import { Shell } from "../client/src/Shell.tsx";
import { createStore } from "../client/src/state/store.js";
import { initialState, type DashboardState } from "../client/src/state/types.js";
import { AgentsView } from "../client/src/ui/views/AgentsView.tsx";
import { errorsDuring, mount } from "./mount.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const same = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────
const at = (h: number, m: number) => new Date(2026, 9, 15, h, m, 0, 0).getTime();
const NOW = at(11, 0);

interface Extra { connector?: string; role?: string; host?: string; activity?: string; attention?: string; statusSince?: number; ts?: number; kind?: string; progress?: { kind: "unknown" } }
const entry = (id: string, name: string, status: string, x: Extra = {}): RosterEntry =>
  ({
    card: { id, name, kind: x.kind ?? "agent", role: x.role, meta: { ...(x.connector ? { connector: x.connector } : {}), ...(x.host ? { host: x.host } : {}) } },
    status,
    ts: x.ts ?? NOW - 1000,
    activity: x.activity,
    attention: x.attention,
    statusSince: x.statusSince,
    progress: x.progress,
  }) as unknown as RosterEntry;

const ROSTER: RosterEntry[] = [
  entry("local.rv2", "reviewer_2", "waiting", { connector: "opencode", role: "reviewer", host: "build-box", attention: "dnd", activity: "Needs approval to run pnpm smoke:ci", statusSince: at(10, 49), ts: NOW - 2000 }),
  entry("local.dav", "david", "working", { connector: "claude-code", role: "engineer", host: "mbp-david", activity: "Editing packages/core/src/presence.ts", ts: NOW - 500 }),
  entry("local.rev", "reviewer", "working", { connector: "codex", role: "reviewer", host: "build-box", activity: "Reviewing the presence TTL diff", ts: NOW - 1500 }),
  entry("local.pln", "planner", "idle", { connector: "pi", role: "planner", host: "mbp-david", attention: "focus", ts: NOW - 1000 }),
  entry("local.sve", "sven", "idle", { connector: "hermes", role: "guide", host: "mbp-david", attention: "open", ts: NOW - 1200 }),
  entry("local.sco", "scout", "offline", { connector: "gemini", role: "researcher", host: "build-box", ts: at(9, 12) }),
  entry("local.mgr", "manager", "working", { kind: "endpoint", role: "manager", host: "mbp-david" }),
  entry("local.del", "delivery", "idle", { kind: "endpoint", role: "delivery daemon", host: "mbp-david" }),
];
const AGENTS_ROUTE: Route = { view: "agents", group: "status" };
const HOST_ROUTE: Route = { view: "agents", group: "host" };
const NEEDS_ROUTE: Route = { view: "needs" };

const seed = (patch: Partial<DashboardState> = {}) => createStore<DashboardState>({ ...initialState, space: "main", roster: ROSTER, ...patch });
const html = (patch: Partial<DashboardState>, route: Route): string =>
  renderToString(createElement(Shell, { store: seed(patch), controller: null, route, paneOpen: false, msgPerSecond: () => 0, clock: () => NOW }));
const parse = (s: string): HTMLElement => {
  const el = document.createElement("div");
  el.innerHTML = s;
  return el;
};
const view = (patch: Partial<DashboardState> = {}, route: Route = AGENTS_ROUTE) => parse(html(patch, route));
const without = (...ids: string[]) => ROSTER.filter((p) => !ids.includes(p.card.id));
const textOf = (el: Element | null | undefined): string => el?.textContent ?? "";
const gone = (): HTMLElement => document.createElement("div");

/** The inner markup of the first `<svg>` under `el`, which is how one icon is told from another. */
const svgOf = (el: Element | null | undefined): string => el?.querySelector("svg")?.innerHTML ?? "";
const iconMarkup = (icon: Parameters<typeof Icon>[0]["icon"]): string => svgOf(parse(renderToString(createElement(Icon, { icon, size: 16 }))));

interface Section { label: string; count: string; head: Element; rows: Element[] }
/** The list's sections in document order: each header with the rows after it. */
function sections(root: ParentNode): Section[] {
  const list = root.querySelector(".v3-by-status, .v3-by-host");
  const out: Section[] = [];
  for (const el of Array.from(list?.children ?? [])) {
    if (el.classList.contains("v3-ghead")) out.push({ label: textOf(el.querySelector("span:not(.v3-count)")), count: textOf(el.querySelector(".v3-count")), head: el, rows: [] });
    else if (el.classList.contains("ox-arow")) {
      const row = el.querySelector(":scope > .v3-arow");
      if (row) out.at(-1)?.rows.push(row);
    }
  }
  return out;
}
/** The right panel's selected tab, and the name its Agent tab shows, read from the shell's panel. */
const panelTab = (root: ParentNode): string => textOf(root.querySelector("section.ui-pane [role=tab][aria-selected=true]"));
const panelAgent = (root: ParentNode): string => textOf(root.querySelector("section.ui-pane .ox-peek-who b"));
const rowByName = (root: ParentNode, name: string): Element => Array.from(root.querySelectorAll(".v3-arow")).find((r) => textOf(r.querySelector("b")) === name) ?? gone();
const names = (s: Section) => s.rows.map((r) => textOf(r.querySelector("b")));
const activity = (row: Element) => textOf(row.querySelector(".v3-aact"));

// 1. The status grouping
{
  const d = view();
  const s = sections(d);
  same("1.1 the groups are Waiting, Working, Idle and Offline in that order, each with its count", s.map((x) => `${x.label} ${x.count}`), ["Waiting 1", "Working 2", "Idle 2", "Offline 1"]);
  same("1.2 each header draws its own status icon: hourglass, loading spokes, moon, struck circle",
    s.map((x) => svgOf(x.head)), [HourglassIcon, Loading03Icon, Moon02Icon, UnavailableIcon].map(iconMarkup));
  same("1.3 each header takes its status colour class", s.map((x) => x.head.className), ["v3-ghead v3-s-waiting", "v3-ghead v3-s-working", "v3-ghead v3-s-idle", "v3-ghead v3-s-offline"]);
  same("1.4 a group holds its own agents, by name", s.map(names), [["reviewer_2"], ["david", "reviewer"], ["planner", "sven"], ["scout"]]);
  same("1.5 the page is headed Agents with the live and offline counts, endpoints left out",
    [textOf(d.querySelector("main .ui-bar h1")), textOf(d.querySelector("main .ui-bar .ui-topic"))], ["Agents", "5 live, 1 offline on main"]);
  const noOffline = sections(view({ roster: without("local.sco") }));
  const noWaiting = sections(view({ roster: without("local.rv2") }));
  ok("1.6 a group with no agents is not drawn, whichever it is",
    noOffline.map((x) => x.label).join() === "Waiting,Working,Idle" && noWaiting.map((x) => x.label).join() === "Working,Idle,Offline", [noOffline.map((x) => x.label), noWaiting.map((x) => x.label)]);
  const odd = sections(view({ roster: [...ROSTER, entry("local.odd", "oddity", "hibernating", { host: "mbp-david" })] }));
  ok("1.7 a status outside the four is listed in a group of its own after Offline, never dropped",
    odd.map((x) => `${x.label} ${x.count}`).join() === "Waiting 1,Working 2,Idle 2,Offline 1,Hibernating 1" && names(odd[4]).join() === "oddity" && svgOf(odd[4].head) === "", odd.map((x) => x.label));
}

// 2. The rows
{
  const d = view();
  const david = rowByName(d, "david");
  ok("2.1 a row is a button with the agent's id, its character and its name", david.tagName === "BUTTON" && david.getAttribute("data-agent") === "local.dav" && david.querySelector(".ui-av svg") !== null && textOf(david.querySelector("b")) === "david");
  same("2.2 under the name sits role · harness, the harness named as the brand names it and an unknown connector as it reports itself",
    ["david", "reviewer", "planner", "sven", "scout"].map((x) => textOf(rowByName(d, x).querySelector(".v3-aname span"))),
    ["engineer · Claude Code", "reviewer · Codex", "planner · Pi", "guide · Hermes", "researcher · gemini"]);
  same("2.3 a working agent says its own activity", [activity(david), activity(rowByName(d, "reviewer"))], ["Editing packages/core/src/presence.ts", "Reviewing the presence TTL diff"]);
  same("2.4 an idle agent with none says No current activity", activity(rowByName(d, "planner")), "No current activity");
  same("2.5 a waiting agent says what it reported and when, in the waiting ink", [activity(rowByName(d, "reviewer_2")), rowByName(d, "reviewer_2").querySelector(".v3-aact")?.getAttribute("style")],
    ["Needs approval to run pnpm smoke:ci. Reported 10:49.", "color:var(--gold-ink)"]);
  same("2.6 an offline agent says when its last heartbeat was", activity(rowByName(d, "scout")), "Last heartbeat 09:12");
  same("2.7 a row with no waiting status draws no waiting ink", rowByName(d, "david").querySelector(".v3-aact")?.getAttribute("style"), null);
  const quiet = view({ roster: [entry("local.q", "quill", "working", { connector: "codex" }), entry("local.p", "pell", "working", { connector: "codex", progress: { kind: "unknown" } }), entry("local.w", "wade", "waiting", { connector: "codex" })] });
  same("2.8 a working agent with no activity says its status, Working, never No current activity",
    [activity(rowByName(quiet, "quill")), activity(rowByName(quiet, "pell"))], ["Working", "Working"]);
  ok("2.9 a waiting agent that reported nothing says so too, never an invented reason", activity(rowByName(quiet, "wade")) === "No current activity", activity(rowByName(quiet, "wade")));

  const unsure = view({ roster: [entry("local.u", "ursa", "working", { connector: "codex", activity: "Reviewing the diff", progress: { kind: "unknown" } }), entry("local.k", "kit", "working", { connector: "codex", activity: "Editing the spec" })] });
  same("2.17 a working agent with activity says the activity alone, with no progress suffix",
    [activity(rowByName(unsure, "ursa")), activity(rowByName(unsure, "kit"))], ["Reviewing the diff", "Editing the spec"]);

  const dnd = rowByName(d, "reviewer_2").querySelector(".v3-meta[title]");
  const focus = rowByName(d, "planner").querySelector(".v3-meta[title]");
  same("2.10 Do not disturb shows its icon, its words and the tooltip that says what it does",
    [textOf(dnd), dnd?.getAttribute("title"), svgOf(dnd) === iconMarkup(NotificationOff01Icon)],
    ["Do not disturb", "Channel messages wait for its next turn. DMs and mentions still wake it.", true]);
  same("2.11 Focus shows its icon, its words and its tooltip",
    [textOf(focus), focus?.getAttribute("title"), svgOf(focus) === iconMarkup(Target02Icon)],
    ["Focus", "Channel messages stay in the channel. DMs and role requests still reach it.", true]);
  const open = [rowByName(d, "sven"), rowByName(d, "david")];
  ok("2.12 an open agent, and one that reports no attention, show no badge", open.every((r) => r.querySelector(".v3-meta[title]") === null));
  const sven = rowByName(d, "sven");
  same("2.13 the host ends each row that is not working, behind the server icon, and the status word is not repeated",
    [textOf(sven.querySelector(".v3-meta")), svgOf(sven.querySelector(".v3-meta")) === iconMarkup(ServerStack01Icon), sven.querySelector(".v3-spill") === null], ["mbp-david", true, true]);
  same("2.13b a working row draws no host: View work takes its place, beside the row's button",
    [david.querySelector(".v3-meta"), textOf(david.parentElement?.querySelector(":scope > a.ox-act")), david.parentElement?.classList.contains("ox-arow-w")], [null, "View work", true]);
  ok("2.14 an offline row is dimmed", rowByName(d, "scout").classList.contains("v3-arow-off") && !david.classList.contains("v3-arow-off") && d.querySelector(".v3-arow-off .ui-av-off") !== null);
  const hostless = view({ roster: [entry("local.h", "hollow", "idle", { connector: "pi" })] });
  ok("2.15 an agent that reports no host shows none", rowByName(hostless, "hollow").querySelector(".v3-meta") === null);
  const picked = parse(renderToString(createElement(AgentsView, { store: seed(), selected: "local.rev", clock: () => NOW })));
  ok("2.16 the row an address or the panel selected is marked, and no other", rowByName(picked, "reviewer").getAttribute("aria-current") === "true"
    && picked.querySelectorAll('.v3-arow[aria-current="true"]').length === 1 && david.getAttribute("aria-current") === null);
}

// 3. Endpoints and the heartbeat line
{
  const d = view();
  const col = d.querySelector("main .ui-col")!;
  const list = col.querySelector(".v3-by-status")!;
  const ep = col.querySelector(".v3-epsec")!;
  ok("3.1 the endpoints come last, after every status group", col.lastElementChild === ep && list.nextElementSibling === ep);
  same("3.2 under an Endpoints header with its count and the plug icon, each endpoint is a name and its role and host",
    [textOf(ep.querySelector(".v3-ghead")), svgOf(ep.querySelector(".v3-ghead")) === iconMarkup(Plug01Icon), Array.from(ep.querySelectorAll(".v3-eprow")).map((r) => `${textOf(r.querySelector("b"))} | ${textOf(r.querySelector("span:not(.ui-av)"))}`)],
    ["Endpoints2", true, ["manager | manager · mbp-david", "delivery | delivery daemon · mbp-david"]]);
  ok("3.3 an endpoint is in no status group, so the counts are the agents'", !textOf(list).includes("manager") && !textOf(list).includes("delivery"));
  const off = view({ roster: ROSTER.map((p) => (p.card.id === "local.del" ? { ...p, status: "offline" } : p)) });
  ok("3.4 an endpoint the roster holds offline says so", textOf(off.querySelector(".v3-epsec")).includes("delivery daemon · mbp-david · Offline") && off.querySelector(".v3-epsec .ui-av-off") !== null);

  const line = (root: ParentNode) => Array.from(root.querySelectorAll(".v3-by-status .v3-eprow")).map((e) => textOf(e));
  same("3.5 under the groups the oldest heartbeat among live agents is said, counted from the clock", line(d), ["Oldest heartbeat among live agents: 2s ago"]);
  ok("3.6 it is the last thing in the list, after Offline", list.lastElementChild?.classList.contains("v3-eprow") === true && list.lastElementChild?.previousElementSibling?.querySelector(":scope > .v3-arow-off") != null);
  const longAgo = view({ roster: ROSTER.map((p) => (p.card.id === "local.rv2" ? { ...p, ts: NOW - 7 * 60_000 } : p)) });
  same("3.7 an offline agent's old heartbeat does not count: only a live agent's can be the oldest", line(longAgo), ["Oldest heartbeat among live agents: 7m ago"]);
  const hours = view({ roster: ROSTER.map((p) => (p.card.id === "local.rv2" ? { ...p, ts: NOW - 3 * 3_600_000 } : p)) });
  same("3.8 it reads in the largest whole unit", line(hours), ["Oldest heartbeat among live agents: 3h ago"]);
  const ahead = view({ roster: ROSTER.map((p) => ({ ...p, ts: NOW + 5000 })) });
  same("3.9 a heartbeat stamped ahead of this page's clock reads 0s, not a negative age", line(ahead), ["Oldest heartbeat among live agents: 0s ago"]);
  same("3.10 with no live agent there is no line", line(view({ roster: ROSTER.filter((p) => p.status === "offline" || p.card.kind !== "agent") })), []);
  const deaf = view({ stale: [{ kind: "refused", name: "roster", reason: "observer presence watch silent since 2026-10-15T10:52:14.000Z" }] });
  same("3.11 when the observer's presence watch is silent the header says last seen, the rows dim and the heartbeat line goes",
    [textOf(deaf.querySelector("main .ui-bar .ui-topic")), deaf.querySelector("main .ui-col")?.classList.contains("s-lastseen"), line(deaf)], ["5 last seen", true, []]);
  ok("3.12 and any other stale source leaves the header alone", textOf(view({ stale: [{ kind: "refused", name: "activity", reason: "x" }] }).querySelector("main .ui-bar .ui-topic")) === "5 live, 1 offline on main");
  same("3.13 before the first read names the space the header names none", textOf(view({ space: null }).querySelector("main .ui-bar .ui-topic")), "5 live, 1 offline");
}

// 4. The host grouping
{
  const moved = ROSTER.map((p) => (p.card.id === "local.rv2" ? entry("local.rv2", "reviewer_2", "waiting", { connector: "opencode", role: "reviewer", host: "zeta-box", attention: "dnd", activity: "Needs approval to run pnpm smoke:ci", statusSince: at(10, 49), ts: NOW - 2000 }) : p));
  const d = view({ roster: moved }, HOST_ROUTE);
  const s = sections(d);
  ok("4.1 the host route groups by host, hosts in name order, each header with its count", d.querySelector(".v3-by-host") !== null && d.querySelector(".v3-by-status") === null
    && s.map((x) => `${x.label} ${x.count}`).join() === "build-box 2,mbp-david 3,zeta-box 1", s.map((x) => `${x.label} ${x.count}`));
  ok("4.2 a host header draws the server icon", s.every((x) => svgOf(x.head) === iconMarkup(ServerStack01Icon)));
  same("4.3 within a host the waiting agent comes first", s.map(names), [["reviewer", "scout"], ["david", "planner", "sven"], ["reviewer_2"]]);
  const pills = Array.from(d.querySelectorAll(".v3-arow")).map((r) => `${textOf(r.querySelector("b"))}: ${r.querySelector(".v3-spill")?.className} ${textOf(r.querySelector(".v3-spill"))}`);
  same("4.4 each row ends in its status icon and word, and no row repeats its host", pills, [
    "reviewer: v3-spill v3-s-working Working", "scout: v3-spill v3-s-offline Offline", "david: v3-spill v3-s-working Working",
    "planner: v3-spill v3-s-idle Idle", "sven: v3-spill v3-s-idle Idle", "reviewer_2: v3-spill v3-s-waiting Waiting",
  ]);
  same("4.5 the pill's icon is the status's own", Array.from(d.querySelectorAll(".v3-spill")).map((p) => svgOf(p)).slice(0, 2), [Loading03Icon, UnavailableIcon].map(iconMarkup));
  const unknown = view({ roster: [entry("local.p", "pell", "working", { host: "h1", progress: { kind: "unknown" } })] }, HOST_ROUTE);
  same("4.6 a working agent's pill says Working when no progress is reported", textOf(unknown.querySelector(".v3-spill")), "Working");
  same("4.7 a waiting agent's text carries no Reported time here, as in the mock", activity(rowByName(d, "reviewer_2")), "Needs approval to run pnpm smoke:ci");
  ok("4.8 the attention badges stay in this grouping", textOf(rowByName(d, "planner").querySelector(".v3-meta[title]")) === "Focus" && textOf(rowByName(d, "reviewer_2").querySelector(".v3-meta[title]")) === "Do not disturb");
  ok("4.9 the heartbeat line belongs to the status grouping, and the endpoints stay last here too", d.querySelector(".v3-eprow[style]") === null
    && d.querySelector("main .ui-col")?.lastElementChild?.classList.contains("v3-epsec") === true);
  const hostless = sections(view({ roster: [...ROSTER, entry("local.h", "hollow", "idle", { connector: "pi" })] }, HOST_ROUTE));
  ok("4.10 an agent that reports no host is in a last group of its own", hostless.at(-1)?.label === "No host reported" && names(hostless.at(-1)!).join() === "hollow" && hostless.length === 3, hostless.map((x) => x.label));
  ok("4.11 an offline agent stays under its host, dimmed", rowByName(d, "scout").classList.contains("v3-arow-off") && activity(rowByName(d, "scout")) === "Last heartbeat 09:12");
  ok("4.12 the toggle says which grouping is on", Array.from(d.querySelectorAll(".v3-toggle button")).map((b) => `${textOf(b)}=${b.getAttribute("aria-pressed")}`).join() === "Status=false,Host=true");
}

{
  const unsure = view({ roster: [entry("local.u", "ursa", "working", { connector: "codex", host: "h1", activity: "Reviewing the diff", progress: { kind: "unknown" } })] }, HOST_ROUTE);
  same("4.13 the host grouping leaves the activity as the agent wrote it, beside the Working pill",
    [activity(rowByName(unsure, "ursa")), textOf(unsure.querySelector(".v3-spill"))], ["Reviewing the diff", "Working"]);
}

// 5. The Needs route
{
  const d = view({}, NEEDS_ROUTE);
  same("5.1 the Needs route draws the status grouping with Waiting first", sections(d).map((x) => x.label), ["Waiting", "Working", "Idle", "Offline"]);
  same("5.2 and marks the Waiting group as the one in focus", sections(d).map((x) => x.head.getAttribute("data-focused")), ["true", null, null, null]);
  ok("5.3 the Agents route marks none", sections(view()).every((x) => x.head.getAttribute("data-focused") === null));
  ok("5.4 with nobody waiting the Needs route has nothing to focus", sections(view({ roster: without("local.rv2") }, NEEDS_ROUTE)).every((x) => x.head.getAttribute("data-focused") === null));
  ok("5.5 the Waiting header can take focus, which a server render marks tabindex -1", sections(d)[0].head.getAttribute("tabindex") === "-1");
}

// 6. The empty space
{
  const none = view({ roster: [] });
  ok("6.1 with no agent the empty space stands in, naming the space", textOf(none.querySelector(".ui-empty b")) === "No agents on main yet." && none.querySelector(".v3-by-status") === null && none.querySelector(".v3-toggle") === null);
  same("6.2 and still heads the page Agents", textOf(none.querySelector("main .ui-bar h1")), "Agents");
  ok("6.3 endpoints alone are no agents, so the empty space still stands in, with the endpoints below it", view({ roster: ROSTER.filter((p) => p.card.kind !== "agent") }).querySelector(".ui-empty") !== null
    && textOf(view({ roster: ROSTER.filter((p) => p.card.kind !== "agent") }).querySelector(".v3-epsec")).includes("manager"));
  ok("6.4 an offline agent is still an agent, so the list stands", view({ roster: ROSTER.filter((p) => p.status === "offline") }).querySelector(".ui-empty") === null);
  same("6.5 the Needs route shows the empty space too", textOf(view({ roster: [] }, NEEDS_ROUTE).querySelector(".ui-empty b")), "No agents on main yet.");
}

// 7. Mounted: the toggle and its saving
const KEY = "cotal.agents.group";
const pressed = (root: ParentNode) => Array.from(root.querySelectorAll(".v3-toggle button")).map((b) => `${textOf(b)}=${b.getAttribute("aria-pressed")}`).join();
const click = (root: ParentNode, label: string) => (Array.from(root.querySelectorAll(".v3-toggle button")).find((b) => textOf(b) === label) as HTMLButtonElement).click();
const labels = (root: ParentNode) => sections(root).map((x) => x.label).join();
{
  localStorage.clear();
  const store = seed();
  const m = await mount(createElement(AgentsView, { store, clock: () => NOW }));
  ok("7.1 with nothing saved the view opens grouped by status", pressed(m.container) === "Status=true,Host=false" && labels(m.container) === "Waiting,Working,Idle,Offline", labels(m.container));
  await m.run(() => click(m.container, "Host"));
  ok("7.2 Host regroups by host and each row takes its status word", pressed(m.container) === "Status=false,Host=true" && labels(m.container) === "build-box,mbp-david" && m.container.querySelectorAll(".v3-spill").length === 6, labels(m.container));
  ok("7.3 the choice is saved in this browser", localStorage.getItem(KEY) === "host", localStorage.getItem(KEY));
  await m.run(() => click(m.container, "Status"));
  ok("7.4 Status goes back, and that is saved too", labels(m.container) === "Waiting,Working,Idle,Offline" && localStorage.getItem(KEY) === "status", localStorage.getItem(KEY));
  await m.run(() => click(m.container, "Host"));
  await m.unmount();
  const again = await mount(createElement(AgentsView, { store, clock: () => NOW }));
  ok("7.5 a reload opens in the saved grouping", pressed(again.container) === "Status=false,Host=true" && labels(again.container) === "build-box,mbp-david", pressed(again.container));
  await again.unmount();
  const addressed = await mount(createElement(AgentsView, { store, group: "status", focusWaiting: true, clock: () => NOW }));
  ok("7.6 a view the address pins to status ignores the saved host (the Needs route)", labels(addressed.container) === "Waiting,Working,Idle,Offline", labels(addressed.container));
  await addressed.unmount();
  localStorage.setItem(KEY, "status");
  const hostRoute = await mount(createElement(AgentsView, { store, group: "host", clock: () => NOW }));
  ok("7.7 and one the address pins to host ignores the saved status", labels(hostRoute.container) === "build-box,mbp-david", labels(hostRoute.container));
  await hostRoute.unmount();
  localStorage.setItem(KEY, "sideways");
  const junk = await mount(createElement(AgentsView, { store, clock: () => NOW }));
  ok("7.8 a saved value that is neither grouping is ignored", pressed(junk.container) === "Status=true,Host=false", pressed(junk.container));
  await junk.unmount();
  localStorage.clear();
  const routed = await mount(createElement(Shell, { store, controller: null, route: HOST_ROUTE, paneOpen: false, msgPerSecond: () => 0, clock: () => NOW }));
  ok("7.9 the Shell hands the host route's grouping down", labels(routed.container) === "build-box,mbp-david", labels(routed.container));
  await routed.unmount();
  localStorage.setItem(KEY, "host");
  const needsShell = await mount(createElement(Shell, { store, controller: null, route: NEEDS_ROUTE, paneOpen: false, msgPerSecond: () => 0, clock: () => NOW }));
  ok("7.10 the Shell draws the Needs route by status whatever grouping is saved", labels(needsShell.container) === "Waiting,Working,Idle,Offline", labels(needsShell.container));
  await needsShell.unmount();
  localStorage.clear();
}
{
  const g = globalThis as unknown as Record<string, unknown>;
  const real = Object.getOwnPropertyDescriptor(g, "localStorage");
  Object.defineProperty(g, "localStorage", { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } });
  try {
    let m: Awaited<ReturnType<typeof mount>> | undefined;
    let crashed: unknown;
    const errors = await errorsDuring(async () => {
      try {
        m = await mount(createElement(AgentsView, { store: seed(), clock: () => NOW }));
        await m.run(() => click(m!.container, "Host"));
      } catch (e) {
        crashed = e;
      }
    });
    ok("7.11 with storage blocked the view still draws, and the toggle still regroups for this page",
      crashed === undefined && m !== undefined && labels(m.container) === "build-box,mbp-david" && errors.length === 0, { labels: m && labels(m.container), errors, crashed: String(crashed) });
    ok("7.12 and a server render with no storage at all draws the groups", parse(renderToString(createElement(AgentsView, { store: seed(), clock: () => NOW }))).querySelector(".v3-by-status") !== null);
    await m?.unmount();
  } finally {
    if (real) Object.defineProperty(g, "localStorage", real);
  }
}

// 8. Mounted: the Needs route's focus
{
  const scrolled: { on: Element; arg: unknown }[] = [];
  const proto = (dom.window as unknown as { HTMLElement: { prototype: { scrollIntoView?: (arg?: unknown) => void } } }).HTMLElement.prototype;
  proto.scrollIntoView = function (this: Element, arg?: unknown) { scrolled.push({ on: this, arg }); };
  try {
    const m = await mount(createElement(AgentsView, { store: seed(), group: "status", focusWaiting: true, clock: () => NOW }));
    const head = sections(m.container)[0].head;
    ok("8.1 the Needs route scrolls the Waiting group into view", scrolled.length === 1 && scrolled[0].on === head && JSON.stringify(scrolled[0].arg) === '{"block":"start"}', scrolled.length);
    ok("8.2 and focuses it, so the keyboard starts there", document.activeElement === head);
    await m.unmount();
    scrolled.length = 0;
    const plain = await mount(createElement(AgentsView, { store: seed(), clock: () => NOW }));
    ok("8.3 the Agents route does neither", scrolled.length === 0 && document.activeElement === document.body);
    await plain.unmount();
    const empty = await mount(createElement(AgentsView, { store: seed({ roster: without("local.rv2") }), group: "status", focusWaiting: true, clock: () => NOW }));
    ok("8.4 with nobody waiting there is nothing to scroll to", scrolled.length === 0);
    const lateStore = seed({ roster: without("local.rv2") });
    await empty.unmount();
    const later = await mount(createElement(AgentsView, { store: lateStore, group: "status", focusWaiting: true, clock: () => NOW }));
    const toggle = later.container.querySelector(".v3-toggle button") as HTMLButtonElement;
    toggle.focus();
    await later.run(() => lateStore.set({ roster: ROSTER }));
    ok("8.5 an agent that starts waiting after the arrival neither scrolls nor takes the reader's focus", scrolled.length === 0 && document.activeElement === toggle && sections(later.container)[0].label === "Waiting", { scrolled: scrolled.length, active: document.activeElement?.tagName });
    await later.run(() => lateStore.set({ roster: [] }));
    await later.run(() => lateStore.set({ roster: ROSTER }));
    ok("8.6 nor does a roster that empties and fills again", scrolled.length === 0 && document.activeElement !== sections(later.container)[0].head, scrolled.length);
    await later.unmount();

    const loadStore = seed({ roster: [] });
    const loading = await mount(createElement(AgentsView, { store: loadStore, group: "status", focusWaiting: true, clock: () => NOW }));
    await loading.run(() => loadStore.set({ roster: ROSTER }));
    const loadedHead = sections(loading.container)[0].head;
    ok("8.7 a roster still loading when the Needs route opens is waited for: the Waiting group is focused once it arrives", scrolled.length === 1 && scrolled[0].on === loadedHead && document.activeElement === loadedHead, scrolled.length);
    await loading.unmount();

    let setOn: (on: boolean) => void = () => undefined;
    const reentry = createStore<DashboardState>({ ...initialState, space: "main", roster: ROSTER });
    const Flip = () => {
      const [on, set] = useState(true);
      setOn = set;
      return createElement(AgentsView, { store: reentry, group: "status", focusWaiting: on, clock: () => NOW });
    };
    scrolled.length = 0;
    const flipped = await mount(createElement(Flip));
    await flipped.run(() => setOn(false));
    (flipped.container.querySelector(".v3-toggle button") as HTMLButtonElement).focus();
    await flipped.run(() => setOn(true));
    ok("8.8 leaving the route and arriving on it again focuses the Waiting group again", scrolled.length === 2 && document.activeElement === sections(flipped.container)[0].head, scrolled.length);
    await flipped.unmount();
  } finally {
    delete proto.scrollIntoView;
  }
}

// 9. Mounted: picking a row, and a row that moves
{
  const picked: string[] = [];
  const store = seed();
  const m = await mount(createElement(AgentsView, { store, onPick: (id) => picked.push(id), clock: () => NOW }));
  await m.run(() => (rowByName(m.container, "sven") as HTMLButtonElement).click());
  await m.run(() => (rowByName(m.container, "reviewer_2") as HTMLButtonElement).click());
  same("9.1 a click on a row tells the caller which agent, by id", picked, ["local.sve", "local.rv2"]);
  await m.unmount();
  const bare = await mount(createElement(AgentsView, { store, clock: () => NOW }));
  let failed: unknown;
  try { await bare.run(() => (rowByName(bare.container, "david") as HTMLButtonElement).click()); } catch (e) { failed = e; }
  ok("9.2 a row with nobody listening still clicks", failed === undefined);
  await bare.unmount();
  const shell = await mount(createElement(Shell, { store, controller: null, route: AGENTS_ROUTE, paneOpen: false, msgPerSecond: () => 0, clock: () => NOW }));
  await shell.run(() => (rowByName(shell.container, "planner") as HTMLButtonElement).click());
  const marked = Array.from(shell.container.querySelectorAll('.v3-arow[aria-current="true"]')).map((r) => textOf(r.querySelector("b")));
  same("9.3 clicking an agent row in #/agents opens the Agent tab for that id, and marks that row and no other",
    [panelTab(shell.container), panelAgent(shell.container), marked], ["Agent", "planner", ["planner"]]);
  await shell.unmount();
  const needs = await mount(createElement(Shell, { store, controller: null, route: NEEDS_ROUTE, paneOpen: false, msgPerSecond: () => 0, clock: () => NOW }));
  await needs.run(() => (rowByName(needs.container, "david") as HTMLButtonElement).click());
  same("9.4 and on the Needs route", [panelTab(needs.container), panelAgent(needs.container)], ["Agent", "david"]);
  await needs.unmount();
}
{
  const store = seed();
  const m = await mount(createElement(AgentsView, { store, selected: "local.dav", clock: () => NOW }));
  const row = rowByName(m.container, "david") as HTMLButtonElement;
  row.focus();
  const errors = await errorsDuring(async () => {
    await m.run(() => store.set({ roster: ROSTER.map((p) => (p.card.id === "local.dav" ? { ...p, status: "idle", activity: undefined } : p)) }));
  });
  const moved = rowByName(m.container, "david");
  const where = sections(m.container).find((x) => names(x).includes("david"))?.label;
  ok("9.5 when its agent changes status the row moves to the new group, still selected", where === "Idle" && moved.getAttribute("aria-current") === "true", where);
  ok("9.6 and it is the same element, so it keeps keyboard focus through the move, with no key warning", moved === row && document.activeElement === moved && errors.length === 0, { errors, active: document.activeElement?.tagName });
  await m.unmount();
}

// 10. Mounted: the heartbeat ages move on their own
{
  let clock = NOW;
  const line = (root: ParentNode) => textOf(root.querySelector(".v3-by-status .v3-eprow"));
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const live = new Set<unknown>();
  globalThis.setInterval = ((fn: () => void, ms?: number) => { const id = realSet(fn, ms); live.add(id); return id; }) as typeof setInterval;
  globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => { live.delete(id); realClear(id); }) as typeof clearInterval;
  try {
    const m = await mount(createElement(AgentsView, { store: seed(), clock: () => clock }));
    same("10.1 the line starts at the age of the stalest live heartbeat", line(m.container), "Oldest heartbeat among live agents: 2s ago");
    clock += 3000;
    await m.run(() => new Promise<void>((resolve) => setTimeout(resolve, 1200)));
    same("10.2 and with no message to cause a render it ages by itself", line(m.container), "Oldest heartbeat among live agents: 5s ago");
    ok("10.3 the view holds a timer while mounted", live.size > 0, live.size);
    await m.unmount();
    ok("10.4 and unmounting stops every timer it started", live.size === 0, live.size);
    const offline = await mount(createElement(AgentsView, { store: seed({ roster: ROSTER.filter((p) => p.status === "offline" || p.card.kind !== "agent") }), clock: () => clock }));
    ok("10.5 a view with no heartbeat line to redraw holds no timer", live.size === 0 && line(offline.container) === "", live.size);
    await offline.unmount();
    const host = await mount(createElement(AgentsView, { store: seed(), group: "host", clock: () => clock }));
    ok("10.6 nor does the host grouping, which draws none", live.size === 0, live.size);
    await host.unmount();
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
}

// 11. Mounted: the live step, read from at most 12 working agents' event planes
{
  /** A controller that records which agents' work is held open, and does nothing else. */
  const watcher = () => {
    const calls: string[] = [];
    const controller = {
      openSession: (id: string) => void calls.push(`open ${id}`),
      closeSession: (id: string) => void calls.push(`close ${id}`),
    } as unknown as Controller;
    const held = () => {
      const n = new Map<string, number>();
      for (const c of calls) {
        const [kind, id] = c.split(" ") as [string, string];
        n.set(id, (n.get(id) ?? 0) + (kind === "open" ? 1 : -1));
      }
      return [...n].filter(([, v]) => v > 0).map(([id]) => id);
    };
    return { controller, calls, held };
  };
  const pad = (i: number) => String(i).padStart(2, "0");
  const crew = Array.from({ length: 14 }, (_, i) => entry(`local.w${pad(i)}`, `worker${pad(i)}`, "working", { connector: "claude-code", host: "box", activity: `Task ${i}` }));
  const first12 = crew.slice(0, 12).map((p) => p.card.id);

  const a = watcher();
  const m = await mount(createElement(AgentsView, { store: seed({ roster: crew }), controller: a.controller, clock: () => NOW }));
  same("11.1 fourteen working agents hold the work of twelve open, the first twelve in display order, each once",
    [a.held(), a.calls.length], [first12, 12]);
  await m.unmount();
  same("11.2 unmounting the view closes every one it held", [a.held(), a.calls.filter((c) => c.startsWith("close")).length], [[], 12]);

  const b = watcher();
  const store = seed({ roster: crew });
  const n = await mount(createElement(AgentsView, { store, controller: b.controller, clock: () => NOW }));
  await n.run(() => store.set({ roster: crew.map((p) => (p.card.id === "local.w03" ? { ...p, status: "idle" as const } : p)) }));
  same("11.3 a working agent that turns idle closes its work, and the next working row takes its place",
    [b.calls.includes("close local.w03"), b.held()], [true, [...first12.filter((id) => id !== "local.w03"), "local.w12"]]);
  await n.unmount();

  const ts = Date.now() - 5000;
  const session = (events: unknown[]) => ({ views: 1, frames: [{ id: "f1", ts, live: true, events: [{ type: "RUN_STARTED", threadId: "t", runId: "r1", timestamp: ts }, ...events] }], posts: [], load: "ok" as const, more: false, limit: 200 });
  const start = { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "Bash", timestamp: ts };
  const dav = ROSTER.filter((p) => p.card.id === "local.dav");
  const c = watcher();
  const live = await mount(createElement(AgentsView, { store: seed({ roster: dav, sessions: { "local.dav": session([start]) } }), controller: c.controller, clock: () => NOW }));
  const row = rowByName(live.container, "david");
  const step = row.querySelector(".ox-now");
  const link = row.parentElement?.querySelector(":scope > a.ox-act") ?? null;
  same("11.4 a working row with a running call shows it under the activity line, with the spinner, the title and the tool with its seconds, and View work sits beside the button",
    [textOf(step?.querySelector('[data-slot="trace-title"]')), /^Bash · \d+s$/.test(textOf(step?.querySelector('[data-slot="trace-description"]'))), step?.querySelector('[data-slot="spinner"]') !== null,
      step?.parentElement?.previousElementSibling?.classList.contains("v3-aact"), textOf(link), link?.getAttribute("href"), row.querySelector("a") === null, c.held()],
    ["Running a command", true, true, true, "View work", formatRoute({ view: "agent", id: "local.dav", tab: "work" }), true, ["local.dav"]]);
  ok("11.4b the step is hidden from assistive tech, so no live region sits inside the row's button and the button's name holds still",
    step !== null && step.parentElement?.getAttribute("aria-hidden") === "true" && [...row.querySelectorAll('[role="status"]')].every((e) => e.closest('[aria-hidden="true"]') !== null));
  ok("11.5 the activity line above it is presence's own text and never shimmers",
    textOf(row.querySelector(".v3-aact")) === "Editing packages/core/src/presence.ts" && row.querySelector(".v3-aact.ox-shimmer, .v3-aact .ox-shimmer") === null);
  await live.unmount();
  const ended = { type: "CUSTOM", name: "cotal.toolResult", value: { toolCallId: "c1", isError: false }, timestamp: ts + 1000 };
  const done = await mount(createElement(AgentsView, { store: seed({ roster: dav, sessions: { "local.dav": session([start, ended]) } }), controller: watcher().controller, clock: () => NOW }));
  const quiet = rowByName(done.container, "david");
  ok("11.6 a working row whose call has finished shows no step line, and keeps View work", quiet.querySelector(".ox-now") === null && textOf(quiet.parentElement?.querySelector(":scope > a.ox-act")) === "View work");
  await done.unmount();
  const heads = sections(view());
  same("11.7 the Working group's spokes turn and no other group's icon does",
    heads.map((h) => [h.label, h.head.querySelector("svg")?.classList.contains("ox-spin") ?? false]), [["Waiting", false], ["Working", true], ["Idle", false], ["Offline", false]]);
  const e = watcher();
  const stale = await mount(createElement(AgentsView, { store: seed({ roster: crew, stale: [{ kind: "refused", name: "roster", reason: "observer presence watch silent" }] }), controller: e.controller, clock: () => NOW }));
  same("11.8 while the roster is only last seen no row reads its agent's work, since presence cannot say who works now", [e.calls.length, e.held()], [0, []]);
  await stale.unmount();
}

await closeDom();
console.log(`agents-view: ${n} checks passed`);
