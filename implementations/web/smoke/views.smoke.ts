/** The centre's views (mock section D and the Activity, DM and Empty space frames): the channel view
 *  with its header, chips, member stack, message list, working line and Needs card; the Activity view
 *  with its filter chips and destinations; the DM view; the Empty space state; and the reopen that
 *  must not draw an empty list. Each cell renders the real shell or a view over a seeded store, on
 *  the server or mounted in jsdom when it needs a click, and reads the DOM it drew.
 *
 *  What is pinned, beyond the markup: names come from the roster by id; a sender or a conversation
 *  nothing verified says so; the working line and the header chip name the working members of THIS
 *  channel, three at most and then how many more, and a conversation's working parties; a Needs card
 *  dismissal lasts until that agent's status changes and survives blocked storage; and a reopen keeps
 *  the rows and the scroll position while its history loads. A reload from history keeps the copy of
 *  a message the page saw verified live, in a channel, the DMs and Activity. The DMs are a window of
 *  the newest 500, and once it may not reach back to a conversation's start the DM view says so. A
 *  live row from a roster agent carries the View work action, and on touch a long press opens its
 *  sheet; a history row and a sender the roster does not hold get neither. On a phone a pick (a
 *  sender's name, an Agents view row, a topology node) goes to the agent's page; on a wide screen it
 *  opens the agent's peek. */
import { closeDom, dom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { ChannelInfo, CotalMessage, FeedMessage, MembershipSnapshot, RosterEntry } from "../client/src/api/types.js";
import { wave } from "../client/src/art/index.ts";
import { DM_WINDOW, dmPeers } from "../client/src/lib/dms.js";
import { badgeLookup } from "../client/src/ui/identity.js";
import { rosterRows } from "../client/src/lib/roster.js";
import { formatRoute, type Route } from "../client/src/lib/route.js";
import { Shell } from "../client/src/Shell.tsx";
import { createStore } from "../client/src/state/store.js";
import { initialState, type DashboardState, type StoredMessage } from "../client/src/state/types.js";
import { Avatar } from "../client/src/ui/Avatar.tsx";
import { UNVERIFIED } from "../client/src/ui/MessageRow.tsx";
import { NeedsCard } from "../client/src/ui/NeedsCard.tsx";
import { ChannelView } from "../client/src/ui/views/ChannelView.tsx";
import { bootReads, gate, harness, page } from "./controller-harness.js";
import { errorsDuring, mount } from "./mount.js";
import { inShell } from "./providers.js";
import { renderShell } from "./render-shell.js";

/** A scroll event from the DOM's own realm, which its `dispatchEvent` accepts. */
const scrolled = () => new (dom.window.Event as typeof Event)("scroll");

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const same = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────
const at = (h: number, m: number, daysAgo = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
const entry = (id: string, name: string, status: RosterEntry["status"], extra: { connector?: string; role?: string; activity?: string; statusSince?: number; kind?: string; progress?: { kind: "unknown" } } = {}): RosterEntry =>
  ({
    card: { id, name, kind: extra.kind ?? "agent", role: extra.role, meta: extra.connector ? { connector: extra.connector } : {} },
    status,
    ts: 1,
    activity: extra.activity,
    statusSince: extra.statusSince,
    progress: extra.progress,
  }) as RosterEntry;
const roster: RosterEntry[] = [
  entry("local.dav", "david", "working", { connector: "claude-code", role: "engineer", activity: "Editing packages/core/src/presence.ts" }),
  entry("local.rev", "reviewer", "working", { connector: "codex", role: "reviewer", activity: "Reviewing the presence TTL diff" }),
  entry("local.rv2", "reviewer_2", "waiting", { connector: "opencode", role: "reviewer", activity: "Needs approval to run pnpm smoke:ci", statusSince: at(10, 49) }),
  entry("local.pln", "planner", "idle", { connector: "pi", role: "planner" }),
  entry("local.sco", "scout", "offline", { connector: "gemini", role: "researcher" }),
];
const msg = (id: string, from: string, text: string, ts: number, extra: Partial<CotalMessage> = {}): CotalMessage =>
  ({ id, ts, space: "main", from: { id: from, name: "mallory" }, channel: "review", parts: [{ kind: "text", text }], ...extra }) as unknown as CotalMessage;
const review: ChannelInfo = { channel: "review", messages: 9, description: "Review requests. Send them to the reviewer role.", replay: true, replayWindow: "24h", deliveryClass: "durable" };
/** The broker's membership for #review, in the order the broker lists it: reviewer before david. */
const reviewMembers: MembershipSnapshot = {
  asOf: Date.now(),
  members: [
    { id: "local.rev", live: ["review"], durable: [], observedAt: 1 },
    { id: "local.dav", live: [], durable: ["review"], observedAt: 1 },
    { id: "local.rv2", live: ["review"], durable: [], observedAt: 1 },
    { id: "local.pln", live: ["general"], durable: [], observedAt: 1 },
  ],
} as unknown as MembershipSnapshot;
const reviewMessages: StoredMessage[] = [
  { msg: msg("m1", "local.dav", "Pushed the presence TTL change.", at(10, 42)), senderId: "local.dav" },
  { msg: msg("m2", "local.dav", "Review packages/core/src/presence.ts against SPEC 6.", at(10, 43)), senderId: "local.dav" },
  { msg: msg("m3", "local.rev", "This fails on empty input.", at(10, 44)), senderId: "local.rev" },
  { msg: msg("m4", "local.rev", "Read from history.", at(10, 45)) },
  { msg: msg("m5", "local.rev", "Also from history.", at(10, 46)) },
];
const channelSeed = (patch: Partial<DashboardState> = {}): Partial<DashboardState> => ({
  space: "main",
  roster,
  channels: [review, { channel: "general", messages: 1, replay: false, deliveryClass: "live" }],
  membership: { snapshot: reviewMembers },
  open: { channel: "review", messages: reviewMessages },
  ...patch,
});
const channelRoute: Route = { view: "channel", channel: "review" };

/** The shell's HTML, parsed into a detached element so a cell reads the DOM it drew. */
const parse = (html: string): HTMLElement => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
};
const shellDom = (patch: Partial<DashboardState>, route: Route) => parse(renderShell(patch, route, route.view === "channel"));
const centre = (el: HTMLElement) => el.querySelector("main") as HTMLElement;
/** An empty element in place of one a view failed to draw, so the cell that wanted it fails on its
 *  assertion instead of on a null. */
const none = (): HTMLElement => document.createElement("div");
const textOf = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const all = (el: Element, sel: string) => [...el.querySelectorAll(sel)] as HTMLElement[];
/** A header's policy chips, each as its label and the note its Tooltip shows, which it also carries
 *  for screen readers. */
const chipsIn = (root: Element) => all(root, 'header span[data-variant="outline"]').map((x) => [x.firstChild?.textContent ?? "", textOf(x.querySelector(".ui-sr"))]);
/** The day dividers in a list, by their words. */
const days = (root: Element) => all(root, '[data-slot="marker"][data-variant="separator"]').map(textOf);
/** Every message a view draws, in order. */
const rowsIn = (root: Element) => all(root, '[data-slot="message"]');
/** A message's body, as its bubble shows it. */
const bodyOf = (r: Element) => textOf(r.querySelector('[data-slot="bubble-content"]'));
/** The sender's name, which opens a message's header. */
const senderOf = (r: Element) => textOf(r.querySelector('[data-slot="message-header"] > :first-child'));
/** Whether a message joins the one above it in a run from one sender, under that one's header. */
const joins = (r: Element) => r.previousElementSibling?.getAttribute("data-slot") === "message" && r.querySelector('[data-slot="message-header"]') === null;
/** Whether `el` carries the unverified mark. */
const unverifiedIn = (el: Element | null | undefined) => all(el ?? none(), '[data-variant="outline"]').some((x) => x.firstChild?.textContent === "unverified");
/** The words `el` shows, leaving out the text it carries for screen readers only. */
const visibleText = (el: Element | null | undefined) => {
  const copy = el?.cloneNode(true) as Element | undefined;
  for (const sr of copy?.querySelectorAll(".ui-sr") ?? []) sr.remove();
  return textOf(copy);
};
/** Draw `el` at phone width: the Sidebar's own hook reads the window's width once it has mounted. */
const atPhoneWidth = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const wide = window.innerWidth;
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(window, "innerWidth", { value: wide, configurable: true });
  }
};
/** Where a message went, in the place its header gives the role (an Activity row's destination). */
const placeOf = (r: Element) => all(r, '[data-slot="message-header"] [data-variant="secondary"]').map(textOf);
/** A message header's harness chip: an outline Badge that is not the unverified mark. */
const harnessIn = (r: Element) => all(r, '[data-slot="message-header"] [data-variant="outline"]').filter((x) => x.firstChild?.textContent !== "unverified");
/** The Needs card in a view's dock. */
const needsIn = (root: Element) => root.querySelector('.ui-dock [data-slot="card"]');
/** What a Needs card says under its name: the activity and when it was reported. */
const detailOf = (card: Element | null) => textOf(card?.querySelector('[data-slot="card-description"]'));
/** A Needs card's dismiss button, by its name. */
const dismissIn = (root: Element) => root.querySelector('button[aria-label="Dismiss until the status changes"]') as HTMLButtonElement | null;
// MessageScroller moves its viewport with scrollTo, which jsdom's elements lack.
(HTMLElement.prototype as { scrollTo?: unknown }).scrollTo ??= function (this: HTMLElement, opts: { top?: number }) {
  if (typeof opts?.top === "number") this.scrollTop = opts.top;
};
/** The words of the Tooltip `trigger` opens when it takes the keyboard focus: the role=tooltip
 *  element Radix draws for it. */
const tipOf = async (m: Awaited<ReturnType<typeof mount>>, trigger: Element | null | undefined): Promise<string> => {
  await m.run(() => (trigger as HTMLElement | null)?.focus());
  const tip = textOf(document.querySelector('[role="tooltip"]'));
  await m.run(() => (trigger as HTMLElement | null)?.blur());
  return tip;
};
/** The header's member stack: the button named by its count in words. */
const stackIn = (root: Element) => root.querySelector('header button[aria-label$=" member"], header button[aria-label$=" members"]') as HTMLButtonElement | null;
/** The avatars in a member stack, which is hidden from assistive tech. */
const stackAvatars = (stack: Element | null) => all(stack ?? none(), ':scope > [aria-hidden="true"] > *');

// ── 1. The channel header ────────────────────────────────────────────────────────────────────────
{
  const c = centre(shellDom(channelSeed(), channelRoute));
  const bar = c.querySelector("header.ui-bar") ?? none();
  ok("1.1 the header names the channel as # review and shows its topic",
    textOf(bar.querySelector("h1")) === "# review" && textOf(bar.querySelector(".ui-topic")) === "Review requests. Send them to the reviewer role.", textOf(bar));
  same("1.2 a durable channel with a 24h replay shows both chips with the notes' tooltips",
    chipsIn(bar), [["durable", "Kept for members who are offline"], ["replay 24h", "New members see the last 24 hours"]]);
  const chipsFor = (info: ChannelInfo | { channel: string; messages: number }) =>
    chipsIn(centre(shellDom(channelSeed({ channels: [info as ChannelInfo] }), channelRoute)));
  same("1.3 a live channel with replay off shows neither chip", chipsFor({ ...review, deliveryClass: "live", replay: false }), []);
  same("1.4 the replay chip reads its own window, and a window of one unit reads as that unit",
    [chipsFor({ ...review, deliveryClass: "live", replayWindow: "30m" }), chipsFor({ ...review, deliveryClass: "live", replayWindow: "1h" }), chipsFor({ ...review, deliveryClass: "live", replayWindow: "7d" })],
    [[["replay 30m", "New members see the last 30 minutes"]], [["replay 1h", "New members see the last hour"]], [["replay 7d", "New members see the last 7 days"]]]);
  same("1.5 replay with no window says new members see everything the channel keeps",
    chipsFor({ ...review, deliveryClass: "live", replayWindow: undefined }), [["replay", "New members see every message the channel keeps"]]);
  same("1.6 a channel whose policy the server has not sent yet shows no chips, rather than guessing", chipsFor({ channel: "review", messages: 3 }), []);
  ok("1.7 a channel with no topic draws no topic", c.querySelector(".ui-topic") !== null
    && centre(shellDom(channelSeed({ channels: [{ ...review, description: undefined }] }), channelRoute)).querySelector("header .ui-topic") === null);

  const stack = stackIn(bar) as HTMLButtonElement;
  const avatars = stackAvatars(stack);
  ok("1.8 the member stack counts the broker's members of #review and says so in its name, which its tooltip repeats",
    textOf(stack).endsWith("3") && stack.getAttribute("aria-label") === "3 members" && avatars.length === 3, { text: textOf(stack), name: stack?.getAttribute("aria-label") });
  const lookup = badgeLookup(rosterRows(roster, { includeOffline: true }));
  const drawnAs = (id: string, vendor: string, status: RosterEntry["status"]) => parse(renderToString(createElement(Avatar, { vendor, status, size: 22, badge: lookup(id) }))).innerHTML;
  same("1.9 each member is drawn from the roster by id, in the broker's order, with its status dot",
    avatars.map((a) => a.outerHTML), [drawnAs("local.rev", "codex", "working"), drawnAs("local.dav", "claude-code", "working"), drawnAs("local.rv2", "opencode", "waiting")]);
  const traffic = stackIn(centre(shellDom(channelSeed({ membership: {} }), channelRoute)));
  ok("1.10 with no membership feed the stack is who posted here: david and reviewer, so 2",
    traffic !== null && textOf(traffic).endsWith("2") && traffic.getAttribute("aria-label") === "2 members", [textOf(traffic), traffic?.getAttribute("aria-label")]);
  const many: MembershipSnapshot = { asOf: Date.now(), members: ["a", "b", "c", "d", "e"].map((x) => ({ id: `local.${x}`, live: ["review"], durable: [], observedAt: 1 })) } as unknown as MembershipSnapshot;
  const five = stackIn(centre(shellDom(channelSeed({ membership: { snapshot: many } }), channelRoute))) as HTMLElement;
  ok("1.11 five members draw four avatars and the count 5", stackAvatars(five).length === 4 && textOf(five).endsWith("5") && five.getAttribute("aria-label") === "5 members", five?.outerHTML.slice(0, 200));
  const one: MembershipSnapshot = { asOf: Date.now(), members: [{ id: "local.rev", live: ["review"], durable: [], observedAt: 1 }] } as unknown as MembershipSnapshot;
  ok("1.12 one member reads 1 member", stackIn(centre(shellDom(channelSeed({ membership: { snapshot: one } }), channelRoute)))?.getAttribute("aria-label") === "1 member");
  const alone = parse(renderToString(inShell(createElement(ChannelView, { store: createStore<DashboardState>({ ...initialState, ...channelSeed() }), channel: "review" }))));
  const bare = stackIn(alone);
  ok("1.13 drawn with no Members tab to open, the stack is a disabled button", bare?.disabled === true && stack.disabled === false, bare?.outerHTML.slice(0, 120));
  const opened: string[] = [];
  const store = createStore<DashboardState>({ ...initialState, ...channelSeed() });
  const m = await mount(inShell(createElement(ChannelView, { store, channel: "review", onMembers: () => void opened.push("members") })));
  const live = stackIn(m.container) as HTMLButtonElement;
  await m.run(() => live.click());
  ok("1.14 given a Members tab, clicking the stack opens it", live.disabled === false && opened.join() === "members", opened);
  await m.unmount();
  ok("1.15 the stack is hidden from assistive tech, so its dots do not change the button's name, which stays its count",
    stack.firstElementChild?.getAttribute("aria-hidden") === "true" && stackAvatars(stack).length === 3 && textOf(stack.firstElementChild) === "");
}

// ── 2. The message list ──────────────────────────────────────────────────────────────────────────
{
  const c = centre(shellDom(channelSeed(), channelRoute));
  const col = c.querySelector('[role="log"]') ?? none();
  same("2.1 a Today divider opens today's messages", days(col), ["Today"]);
  const rows = rowsIn(col);
  same("2.2 consecutive rows from one verified sender group under one header, a new sender breaks the run, and a history row never joins one",
    rows.map(joins), [false, true, false, false, false]);
  ok("2.3 every row is drawn by MessageRow, its sender named from the roster", rows.length === 5 && senderOf(rows[0]) === "david" && !textOf(c).includes("mallory"));
  const older = [{ msg: msg("y1", "local.dav", "yesterday", at(9, 0, 1)), senderId: "local.dav" }, { msg: msg("y2", "local.dav", "today", at(9, 0)), senderId: "local.dav" }];
  const two = centre(shellDom(channelSeed({ open: { channel: "review", messages: older } }), channelRoute));
  same("2.4 a day change draws its own divider, and the divider breaks a run from one sender",
    [days(two), rowsIn(two).map(joins)], [["Yesterday", "Today"], [false, false]]);
  const week = centre(shellDom(channelSeed({ open: { channel: "review", messages: [{ msg: msg("w1", "local.dav", "x", new Date(2026, 0, 5, 9).getTime()), senderId: "local.dav" }] } }), channelRoute));
  same("2.5 an older day this year is written as its day and month", days(week), [new Date().getFullYear() === 2026 ? "5 January" : "5 January 2026"]);
  const lastYear = centre(shellDom(channelSeed({ open: { channel: "review", messages: [{ msg: msg("w0", "local.dav", "x", new Date(new Date().getFullYear() - 1, 9, 14, 9).getTime()), senderId: "local.dav" }] } }), channelRoute));
  same("2.5b a day in another year carries its year", days(lastYear), [`14 October ${new Date().getFullYear() - 1}`]);
  const store = createStore<DashboardState>({ ...initialState, ...channelSeed({ open: { channel: "review", messages: [{ msg: msg("long", "local.dav", "x".repeat(400), at(10, 1)), senderId: "local.dav" }] } }) });
  const m = await mount(inShell(createElement(ChannelView, { store, channel: "review" })));
  const more = all(m.container, '[data-slot="bubble-content"] button').find((b) => textOf(b) === "Show more") ?? null;
  const body = () => more?.closest('[data-slot="collapsible"]')?.querySelector('[data-slot="collapsible-content"]') ?? null;
  const before = [more?.getAttribute("aria-expanded"), body()?.getAttribute("data-state"), textOf(body()).length];
  await m.run(() => more?.click());
  same("2.6 a long body clamps with Show more, and Show more opens it in the view, where it reads Show less and names the body it opened",
    [before, [more?.getAttribute("aria-expanded"), body()?.getAttribute("data-state"), textOf(more), more?.getAttribute("aria-controls") === body()?.id]],
    [["false", "closed", 400], ["true", "open", "Show less", true]]);
  await m.unmount();
  // A sender whose clock is a day behind lands between two of today's rows, so "Today" is drawn twice.
  const skewed: StoredMessage[] = [
    { msg: msg("k1", "local.dav", "today", at(10, 0)), senderId: "local.dav" },
    { msg: msg("k2", "local.rev", "skewed", at(10, 1, 1)), senderId: "local.rev" },
    { msg: msg("k3", "local.dav", "today again", at(10, 2)), senderId: "local.dav" },
  ];
  const skewStore = createStore<DashboardState>({ ...initialState, ...channelSeed({ open: { channel: "review", messages: skewed } }) });
  let skewMount: Awaited<ReturnType<typeof mount>> | undefined;
  const skewErrors = await errorsDuring(async () => { skewMount = await mount(inShell(createElement(ChannelView, { store: skewStore, channel: "review" }))); });
  same("2.8 a repeated day label draws each divider with no duplicate-key warning",
    [days(skewMount!.container), skewErrors.filter((e) => /same key/i.test(e)).length], [["Today", "Yesterday", "Today"], 0]);
  await skewMount?.unmount();
  const elsewhere = centre(shellDom(channelSeed({ open: { channel: "general", messages: reviewMessages } }), channelRoute));
  ok("2.7 the view draws only the open channel's messages: another channel's list is not shown under this name", rowsIn(elsewhere).length === 0 && rowsIn(c).length === 5);
}

// ── 3. The working line and the header chip ──────────────────────────────────────────────────────
{
  const view = (patch: Partial<DashboardState>, route: Route = channelRoute) => centre(shellDom(channelSeed(patch), route));
  const lines = (root: Element) => all(root, ".ox-typing .ox-wline");
  const read = (l: Element) => [textOf(l.querySelector(".ox-wline-c")), textOf(l.querySelector("a")), l.querySelector("a")?.getAttribute("href")];
  const work = (id: string) => formatRoute({ view: "agent", id, tab: "work" });
  const c = view({});
  same("3.1 a channel with two working members and one waiting draws a working line for each working one, in the broker's order, with View work to its Work",
    lines(c).map(read), [
      ["reviewer is working Reviewing the presence TTL diff", "View work", work("local.rev")],
      ["david is working Editing packages/core/src/presence.ts", "View work", work("local.dav")],
    ]);
  const outside = view({ membership: { snapshot: { asOf: Date.now(), members: [{ id: "local.rv2", live: ["review"], durable: [], observedAt: 1 }] } as unknown as MembershipSnapshot } });
  ok("3.2 a working agent who is not in the channel is not named", outside.querySelector(".ox-typing") === null);
  const unknown = roster.map((p) => (p.card.id === "local.rev" ? { ...p, progress: { kind: "unknown" as const } } : p));
  const u = lines(view({ roster: unknown }))[0];
  ok("3.3 a member whose connector reports no progress reads working with its activity, with no moving dots",
    textOf(u?.querySelector(".ox-wline-c")) === "reviewer is working Reviewing the presence TTL diff" && u?.querySelector(".ui-dots") === null, textOf(u));
  const last = all(c.querySelector('[role="log"]') ?? none(), ':scope > [data-slot="message-scroller-item"]').at(-1);
  ok("3.4 the line sits in the list, after the last message",
    last?.querySelector(':scope > [role="status"]') === c.querySelector(".ox-typing") && last?.previousElementSibling?.querySelector('[data-slot="message"]') != null);
  const block = c.querySelector(".ox-typing");
  same("3.5 the lines are a polite live region, and each activity is presence's text, shimmering, with the name in bold",
    [block?.getAttribute("role"), block?.getAttribute("aria-live"), all(c, ".ox-wline .ox-shimmer").map(textOf), all(c, ".ox-wline b").map(textOf)],
    ["status", "polite", ["Reviewing the presence TTL diff", "Editing packages/core/src/presence.ts"], ["reviewer", "david"]]);
  const crowd = [...roster, entry("local.w1", "walker", "working", { connector: "pi", activity: "Walking" }), entry("local.w2", "worker", "working", { connector: "hermes" })];
  const four: MembershipSnapshot = { asOf: Date.now(), members: ["local.rev", "local.dav", "local.w1", "local.w2"].map((id) => ({ id, live: ["review"], durable: [], observedAt: 1 })) } as unknown as MembershipSnapshot;
  const many = view({ roster: crowd, membership: { snapshot: four } });
  same("3.6 four working members draw three lines and then and 1 more",
    [lines(many).map((l) => textOf(l.querySelector("b"))), textOf(many.querySelector(".ox-typing .ox-wmore"))], [["reviewer", "david", "walker"], "and 1 more"]);
  const chip = c.querySelector("header.ui-bar .ox-hchip");
  same("3.7 the header chip reads 2 working, with the turning spokes and the working names in its tooltip and screen reader text, before the member stack",
    [visibleText(chip), textOf(chip?.querySelector(".ui-sr")), chip?.querySelector("svg.ox-spin") !== null, chip?.nextElementSibling?.querySelector("button") === stackIn(c)],
    ["2 working", "Working now: reviewer, david", true, true]);
  const waitingOnly = view({ roster: roster.map((p) => (p.status === "working" ? { ...p, status: "idle" as const } : p)) });
  ok("3.8 a channel where only a waiting member is busy has no working line and no chip",
    waitingOnly.querySelector(".ox-typing") === null && waitingOnly.querySelector(".ox-hchip") === null && stackIn(waitingOnly) !== null);
  const tagged = view({ roster: roster.map((p) => (p.card.id === "local.rev" ? { ...p, activity: "<b>x</b>" } : p)) });
  const shim = tagged.querySelector(".ox-wline .ox-shimmer");
  ok("3.9 an activity holding markup is drawn as its text, escaped", textOf(shim) === "<b>x</b>" && shim?.querySelector("b") === null, shim?.innerHTML);
  const drawnOnPhone = await atPhoneWidth(async () => {
    const pm = await mount(createElement(Shell, { store: createStore<DashboardState>({ ...initialState, ...channelSeed() }), controller: null, route: channelRoute, paneOpen: false, msgPerSecond: () => 0, phone: true }));
    const phone = centre(pm.container);
    const got = [visibleText(phone.querySelector(".ox-hchip")), lines(phone).map((l) => [textOf(l.querySelector("a")), l.querySelector("a")?.getAttribute("href")])];
    await pm.unmount();
    return got;
  });
  same("3.10 on a phone the chip reads the count alone and each line's link reads View",
    drawnOnPhone, ["2", [["View", work("local.rev")], ["View", work("local.dav")]]]);
}

// ── 4. The Needs card ────────────────────────────────────────────────────────────────────────────
{
  const c = centre(shellDom(channelSeed(), channelRoute));
  const card = needsIn(c) ?? none();
  ok("4.1 the dock holds the waiting agent's card: reviewer_2 is waiting, with its activity and the time it reported",
    textOf(card.querySelector('[data-slot="card-title"]')) === "reviewer_2 is waiting" && detailOf(card) === "Needs approval to run pnpm smoke:ci. Reported 10:49.", textOf(card));
  const buttons = all(card, '[data-slot="card-footer"] > *').map((b) => [b.tagName, textOf(b), b.getAttribute("href")]);
  same("4.2 its buttons are View agent and Message reviewer_2, which opens the DM view", buttons, [["BUTTON", "View agent", null], ["A", "Message reviewer_2", formatRoute({ view: "dm", peer: "local.rv2" })]]);
  const tipped = await mount(inShell(createElement(NeedsCard, { row: rosterRows(roster)[0], onDismiss: () => undefined })));
  const tip = await tipOf(tipped, dismissIn(tipped.container));
  await tipped.unmount();
  ok("4.3 and a dismiss button named with the notes' words, which its tooltip shows", dismissIn(card) !== null && tip === "Dismiss until the status changes", tip);
  ok("4.4 the card draws the agent's character with its waiting dot", card.querySelector('[data-slot="card-title"] [role="img"][aria-label="Waiting"]') !== null);
  const calm = centre(shellDom(channelSeed({ roster: roster.filter((p) => p.status !== "waiting") }), channelRoute));
  ok("4.5 with nobody waiting there is no dock at all: no space is reserved", calm.querySelector(".ui-dock") === null && calm.querySelector('[data-slot="card"]') === null);
  const unreported = roster.map((p) => (p.card.id === "local.rv2" ? { ...p, statusSince: undefined } : p));
  const nd = detailOf(needsIn(centre(shellDom(channelSeed({ roster: unreported }), channelRoute))));
  ok("4.6 a card whose agent reported no time says no time", nd === "Needs approval to run pnpm smoke:ci." && !nd.includes("Reported"), nd);
  const quiet = roster.map((p) => (p.card.id === "local.rv2" ? { ...p, activity: undefined } : p));
  ok("4.7 a card with no activity text says only when it was reported", detailOf(needsIn(centre(shellDom(channelSeed({ roster: quiet }), channelRoute)))) === "Reported 10:49.");
  const lone = parse(renderToString(inShell(createElement(NeedsCard, { row: rosterRows(roster)[0], onDismiss: () => undefined }))));
  ok("4.8 drawn with no Agent tab to open, View agent is disabled, and in the shell it is not",
    (lone.querySelector('[data-slot="card-footer"] > button') as HTMLButtonElement | null)?.disabled === true && (card.querySelector('[data-slot="card-footer"] > button') as HTMLButtonElement).disabled === false);
  const viewed: string[] = [];
  const cm = await mount(inShell(createElement(NeedsCard, { row: rosterRows(roster)[0], onViewAgent: (id: string) => void viewed.push(id), onDismiss: () => undefined })));
  await cm.run(() => (cm.container.querySelector('[data-slot="card-footer"] > button') as HTMLButtonElement).click());
  ok("4.9 given an Agent tab, View agent opens it on that agent", viewed.join() === "local.rv2", viewed);
  await cm.unmount();
}

// ── 5. Dismissing a Needs card ───────────────────────────────────────────────────────────────────
const KEY = "cotal.needs.dismissed";
const twoWaiting = [...roster, entry("local.hel", "helper", "waiting", { connector: "hermes", activity: "Needs a token", statusSince: at(10, 50) })];
const cardName = (root: Element) => textOf(root.querySelector('[data-slot="card"] [data-slot="card-title"]'));
{
  localStorage.clear();
  const store = createStore<DashboardState>({ ...initialState, ...channelSeed({ roster: twoWaiting }) });
  const m = await mount(inShell(createElement(ChannelView, { store, channel: "review" })));
  const first = cardName(m.container);
  await m.run(() => dismissIn(m.container)?.click());
  const second = cardName(m.container);
  ok("5.1 dismissing the card shows the next waiting agent (helper sorts before reviewer_2)", first === "helper is waiting" && second === "reviewer_2 is waiting", { first, second });
  const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[];
  ok("5.2 the dismissal is kept in this browser, keyed by the agent's id and the time its status began", saved.length === 1 && saved[0] === `local.hel ${at(10, 50)}`, saved);
  await m.run(() => dismissIn(m.container)?.click());
  ok("5.3 with both dismissed the dock goes", m.container.querySelector(".ui-dock") === null);
  await m.unmount();
  const again = await mount(inShell(createElement(ChannelView, { store, channel: "review" })));
  ok("5.4 a reload remembers both dismissals", again.container.querySelector('[data-slot="card"]') === null);
  await again.run(() => store.set({ roster: twoWaiting.map((p) => (p.card.id === "local.hel" ? { ...p, statusSince: at(10, 55) } : p)) }));
  ok("5.5 a status change brings that agent's card back, and only that one", cardName(again.container) === "helper is waiting", cardName(again.container));
  await again.unmount();
  localStorage.clear();
}
{
  const g = globalThis as unknown as Record<string, unknown>;
  const real = Object.getOwnPropertyDescriptor(g, "localStorage");
  Object.defineProperty(g, "localStorage", { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } });
  try {
    // New status times, so the dismissals the cells above made on this page do not apply here.
    const later = twoWaiting.map((p) => (p.status === "waiting" ? { ...p, statusSince: (p.statusSince ?? 0) + 60_000 } : p));
    const store = createStore<DashboardState>({ ...initialState, ...channelSeed({ roster: later }) });
    let m: Awaited<ReturnType<typeof mount>> | undefined;
    let crashed: unknown;
    const errors = await errorsDuring(async () => {
      try {
        m = await mount(inShell(createElement(ChannelView, { store, channel: "review" })));
        await m.run(() => dismissIn(m!.container)?.click());
      } catch (e) {
        crashed = e;
      }
    });
    ok("5.6 with storage blocked the card still draws, and dismissing it still works for this page",
      crashed === undefined && m !== undefined && cardName(m.container) === "reviewer_2 is waiting" && errors.length === 0, { name: m && cardName(m.container), errors, crashed: String(crashed) });
    ok("5.7 and a server render with no storage at all draws the card", textOf(parse(renderToString(inShell(createElement(ChannelView, { store, channel: "review" })))).querySelector('[data-slot="card-title"]')) === "helper is waiting");
    await m?.unmount();
    const back = await mount(inShell(createElement(ChannelView, { store, channel: "review" })));
    ok("5.8 and the dismissal outlives a view switch that unmounts the card, though nothing could be stored",
      cardName(back.container) === "reviewer_2 is waiting", cardName(back.container));
    await back.unmount();
  } finally {
    if (real) Object.defineProperty(g, "localStorage", real);
  }
}

// ── 6. The Activity view ─────────────────────────────────────────────────────────────────────────
const feed = (id: string, mode: FeedMessage["mode"], senderId: string, extra: Partial<CotalMessage>, ts: number, channel?: string): FeedMessage =>
  ({ mode, senderId, channel, msg: msg(id, senderId, `${mode} ${id}`, ts, { channel, ...extra } as Partial<CotalMessage>) }) as FeedMessage;
const activity: DashboardState["activity"] = [
  { mode: "chat", channel: "review", msg: msg("a1", "local.rev", "from history", at(10, 40)) },
  feed("a2", "unicast", "local.dav", { to: "local.rv2", channel: undefined }, at(10, 41)),
  feed("a3", "anycast", "local.dav", { toService: "reviewer", channel: undefined }, at(10, 42)),
  // The payload claims #forged; the server took team.backend from the subject, and that is the one shown.
  feed("a4", "chat", "local.rev", { channel: "forged" }, at(10, 43), "team.backend"),
];
{
  const el = shellDom({ space: "main", roster, activity, stale: [{ kind: "refused", name: "peers", reason: "HTTP 503" }] }, { view: "activity" });
  const c = centre(el);
  const bar = c.querySelector("header.ui-bar") ?? none();
  const marker = bar.querySelector('[role="note"]');
  ok("6.1 the Activity header names the view and carries the stale marker", textOf(bar.querySelector("h1")) === "Activity" && textOf(marker?.querySelector('[data-slot="alert-title"]')) === "stale: peers");
  ok("6.2 the header's marker has no id of its own, so the page keeps one #stale", el.querySelectorAll("#stale").length === 1 && marker !== null && marker.id === "");
  same("6.3 the filter chips are All, Channels, Direct and Roles, with All checked",
    all(bar, '[role="radiogroup"][aria-label="Show"] [role="radio"]').map((b) => [textOf(b), b.getAttribute("aria-checked")]), [["All", "true"], ["Channels", "false"], ["Direct", "false"], ["Roles", "false"]]);
  const rows = rowsIn(c);
  same("6.4 newest first, each row says where it went: #channel, to <name> from the roster, to role <role>",
    rows.map((r) => placeOf(r).join()), ["#team.backend", "to role reviewer", "to reviewer_2", "#review"]);
  same("6.5 a row the feed delivered is verified and a backfill row is not", rows.map((r) => unverifiedIn(r.querySelector('[data-slot="message-header"]'))), [false, false, false, true]);
  ok("6.6 no row shows the payload's own name", !textOf(c).includes("mallory"));
  const store = createStore<DashboardState>({ ...initialState, space: "main", roster, activity });
  const m = await mount(createElement(Shell, { store, controller: null, route: { view: "activity" }, paneOpen: false, msgPerSecond: () => 0 }));
  const filters = () => all(m.container, 'main header [role="radiogroup"][aria-label="Show"] [role="radio"]');
  const press = (label: string) => m.run(() => (filters().find((b) => textOf(b) === label) as HTMLButtonElement).click());
  const shown = () => rowsIn(centre(m.container)).map(bodyOf);
  const pressed = () => filters().filter((b) => b.getAttribute("aria-checked") === "true").map(textOf);
  await press("Channels");
  same("6.7 Channels keeps the channel messages", [shown(), pressed()], [["chat a4", "from history"], ["Channels"]]);
  await press("Direct");
  same("6.8 Direct keeps the direct messages", [shown(), pressed()], [["unicast a2"], ["Direct"]]);
  await press("Roles");
  same("6.9 Roles keeps the role requests", [shown(), pressed()], [["anycast a3"], ["Roles"]]);
  await press("All");
  same("6.10 All brings every row back", [shown().length, pressed()], [4, ["All"]]);
  await m.unmount();
  const bare: DashboardState["activity"] = [
    { mode: "chat", senderId: "local.dav", msg: msg("b1", "local.dav", "no channel", at(10, 50), { channel: undefined }) } as FeedMessage,
    { mode: "anycast", senderId: "local.dav", msg: msg("b2", "local.dav", "no role", at(10, 51), { channel: undefined }) } as FeedMessage,
    { mode: "unicast", senderId: "local.dav", msg: msg("b3", "local.dav", "no recipient", at(10, 52), { channel: undefined }) } as FeedMessage,
  ];
  const blank = centre(shellDom({ space: "main", roster, activity: bare }, { view: "activity" }));
  ok("6.12 a row whose destination the wire did not send shows none, rather than a made-up one",
    rowsIn(blank).length === 3 && rowsIn(blank).every((r) => placeOf(r).length === 0) && !rowsIn(blank).some((r) => textOf(r).includes("?")), rowsIn(blank).map(textOf));
  ok("6.13 Activity rows carry no harness chip, as mock B draws them: the name, where it went and the time",
    rows.every((r) => harnessIn(r).length === 0) && all(c, '[data-slot="message"] [data-slot="message-header"] time').length === 4);
  const nothing = centre(shellDom({ space: "main", roster, activity: [] }, { view: "activity" }));
  ok("6.11 with agents and nothing yet sent, the list is empty and the empty-space state is not drawn", rowsIn(nothing).length === 0 && nothing.querySelector('[data-slot="empty"]') === null);
}

// ── 7. The DM view ───────────────────────────────────────────────────────────────────────────────
const dmRows: StoredMessage[] = [
  { msg: msg("d1", "local.rv2", "Can you run the gate?", at(10, 30), { to: "local.dav", channel: undefined }), senderId: "local.rv2" },
  { msg: msg("d2", "local.dav", "Running it now.", at(10, 31), { to: "local.rv2", channel: undefined }), senderId: "local.dav" },
  { msg: msg("d3", "local.rev", "From history.", at(10, 32), { to: "local.dav", channel: undefined }) },
  { msg: msg("d4", "local.rv2", "Later one.", at(10, 33), { to: "local.pln", channel: undefined }), senderId: "local.rv2" },
  { msg: msg("d5", "local.dav", "A live reply to the history row.", at(10, 34), { to: "local.rev", channel: undefined }), senderId: "local.dav" },
];
{
  same("7.1 a conversation is verified only when every message carries the sender the server checked",
    dmPeers(dmRows, roster).find((p) => p.id === "local.dav")?.conversations.map((c) => [c.with, c.verified]), [["local.rev", false], ["local.rv2", true]]);
  const view = (route: Route) => centre(shellDom({ space: "main", roster, dms: dmRows }, route));
  const c = view({ view: "dm", peer: "local.rv2", with: "local.dav" });
  const bar = c.querySelector("header.ui-bar") ?? none();
  ok("7.2 the header draws the peer's character, name, role and harness, and who it talks with",
    bar.querySelector(".ui-av svg") !== null && textOf(bar.querySelector("h1")) === "reviewer_2"
      && all(bar, ".ui-topic").map(textOf).join(" | ") === "reviewer · OpenCode | with david", textOf(bar));
  same("7.3 the list holds that conversation only, oldest first", rowsIn(c).map(bodyOf), ["Can you run the gate?", "Running it now."]);
  ok("7.4 a verified conversation carries no unverified mark", !unverifiedIn(bar) && rowsIn(c).length === 2);
  // A route that names only the peer is a Message button's: it opens the operator's conversation
  // with the peer, and none while there is none, never the peer's newest talk with another agent.
  same("7.5 a route naming only the peer opens no conversation of two other agents, and says there is none yet",
    [rowsIn(view({ view: "dm", peer: "local.rv2" })).map(bodyOf), textOf(view({ view: "dm", peer: "local.rv2" }).querySelector('[data-slot="empty"]'))],
    [[], "No direct messages with reviewer_2 yet."]);
  const hist = view({ view: "dm", peer: "local.dav", with: "local.rev" }).querySelector("header.ui-bar") ?? none();
  const mark = all(hist, '[data-variant="outline"]').find((x) => x.firstChild?.textContent === "unverified");
  ok("7.6 a conversation with a history row says unverified in its header, with the message rows' tooltip, which it carries for screen readers",
    textOf(mark?.querySelector(".ui-sr")) === UNVERIFIED, textOf(hist));
  const lonely = view({ view: "dm", peer: "local.sco" });
  ok("7.7 a peer with no direct messages gets its header and says there are none yet",
    textOf(lonely.querySelector("header h1")) === "scout" && textOf(lonely.querySelector('[data-slot="empty"]')) === "No direct messages with scout yet.", textOf(lonely));
  const stranger = view({ view: "dm", peer: "local.ghost" });
  ok("7.8 a peer off the roster is named by its id and drawn offline", textOf(stranger.querySelector("header h1")) === "local.ghost" && stranger.querySelector("header .ui-av.ui-av-off") !== null);
  const workingLines = all(c, ".ox-typing .ox-wline").map((l) => [textOf(l.querySelector(".ox-wline-c")), textOf(l.querySelector("a")), l.querySelector("a")?.getAttribute("href")]);
  ok("7.9 a conversation draws the working line for its working party only, after its messages",
    c.querySelector('section[data-view="dm"]') !== null
      && JSON.stringify(workingLines) === JSON.stringify([["david is working Editing packages/core/src/presence.ts", "View work", formatRoute({ view: "agent", id: "local.dav", tab: "work" })]])
      && all(c.querySelector('[role="log"]') ?? none(), ':scope > [data-slot="message-scroller-item"]').at(-1)?.querySelector(':scope > [role="status"]') === c.querySelector(".ox-typing")
      && c.querySelector(".ox-typing .ui-dots") === null,
    workingLines);
}

// ── 8. Empty space ───────────────────────────────────────────────────────────────────────────────
{
  const endpointsOnly = [entry("local.mgr", "manager", "idle", { kind: "endpoint" })];
  const emptyIn = (root: Element) => root.querySelector('[data-slot="empty"]');
  const titleOf = (root: Element) => textOf(emptyIn(root)?.querySelector('[data-slot="empty-title"]'));
  const empty = emptyIn(centre(shellDom({ space: "main", roster: endpointsOnly }, { view: "activity" }))) ?? none();
  ok("8.1 with no agents on the roster Activity says so in the notes' words",
    textOf(empty.querySelector('[data-slot="empty-title"]')) === "No agents on main yet." && textOf(empty.querySelector('[data-slot="empty-description"]')) === "Start one from your terminal. It shows up here when it joins.", textOf(empty));
  const content = empty.querySelector('[data-slot="empty-content"]') ?? none();
  same("8.2 the commands are copyable: cotal spawn, and cotal personas, which lists the others",
    [all(content, ".ui-cmd code").map(textOf), all(content, ".ui-cmd button").map(textOf), textOf(content.lastElementChild)],
    [["cotal spawn", "cotal personas"], ["Copy", "Copy"], "cotal personasCopy lists the others."]);
  const drawn = parse(`<svg viewBox="0 0 150 150" aria-hidden="true">${wave("claude")}</svg>`).querySelector("svg")?.innerHTML ?? "";
  const header = empty.querySelector('[data-slot="empty-header"]');
  ok("8.3 above them the waving character",
    header?.querySelector("[data-wave] svg")?.innerHTML === drawn && drawn.includes("<path") && header.firstElementChild?.hasAttribute("data-wave") === true && empty.firstElementChild === header);
  const agents = centre(shellDom({ space: "main", roster: [] }, { view: "agents", group: "status" }));
  ok("8.4 the Agents route draws it too, under an Agents header", textOf(agents.querySelector("header h1")) === "Agents" && titleOf(agents) === "No agents on main yet.");
  ok("8.5 before the space is read it names no space", titleOf(centre(shellDom({ space: null }, { view: "activity" }))) === "No agents here yet.");
  ok("8.6 with an agent on the roster neither view draws it",
    emptyIn(centre(shellDom({ space: "main", roster }, { view: "activity" }))) === null
      && emptyIn(centre(shellDom({ space: "main", roster }, { view: "agents", group: "status" }))) === null);
}

// ── 9. The centre follows the route ──────────────────────────────────────────────────────────────
{
  const seed = { ...channelSeed(), dms: dmRows, activity };
  const v = (route: Route) => centre(shellDom(seed, route)).querySelector("section.ui-view")?.getAttribute("data-view");
  same("9.1 the centre says which view it draws", [v(channelRoute), v({ view: "activity" }), v({ view: "dm", peer: "local.rv2" })], ["channel", "activity", "dm"]);
  const ch = centre(shellDom(seed, channelRoute));
  ok("9.2 a channel route draws the channel view and not the phase 1 lists", ch.querySelector("header h1")?.textContent === "# review" && ch.querySelector(".ui-chlink") === null && ch.querySelector('[aria-label="Roster"]') === null);
  ok("9.3 the activity route draws the Activity view, not the open channel", textOf(centre(shellDom(seed, { view: "activity" })).querySelector("header h1")) === "Activity");
  ok("9.4 a DM route draws the DM view", textOf(centre(shellDom(seed, { view: "dm", peer: "local.rv2" })).querySelector("header h1")) === "reviewer_2");
  const presence = (patch: Partial<DashboardState>) => shellDom({ ...seed, ...patch }, channelRoute).querySelector('[data-slot="sidebar-wrapper"]')?.getAttribute("data-presence") ?? null;
  same("9.5 while the roster is only last seen the shell marks itself stale, so every working mark stands still, and not otherwise",
    [presence({ stale: [{ kind: "refused", name: "roster", reason: "observer presence watch silent" }] }), presence({}), presence({ stale: [{ kind: "refused", name: "peers", reason: "HTTP 503" }] })], ["stale", null, null]);
}

// ── 10. A reopen keeps the rows and the scroll position ──────────────────────────────────────────
{
  const first: CotalMessage[] = [msg("h1", "local.dav", "one", at(10, 1)), msg("h2", "local.rev", "two", at(10, 2))];
  let pending = gate<CotalMessage[]>();
  let reads = 0;
  const h = harness({ history: async () => (reads++ === 0 ? first : pending.promise) });
  await h.ctl.open("review");
  const before = h.store.get().open!.messages;
  const reopen = h.ctl.open("review");
  const whileLoading = h.store.get().open!.messages;
  ok("10.1 while a reopen's history loads, the channel keeps the messages it had", h.store.get().open?.channel === "review" && h.store.get().open!.messages.map((m) => m.msg.id).join() === "h1,h2", h.store.get().open);
  const live: FeedMessage = { mode: "chat", channel: "review", senderId: "local.rv2", msg: msg("l1", "local.rv2", "live", at(10, 3)) };
  h.ctl.onMessage(live);
  pending.resolve([msg("h2", "local.rev", "two", at(10, 2)), msg("h3", "local.dav", "three", at(10, 2))]);
  await reopen;
  same("10.2 when it lands the list is the new history plus what arrived live during the read, and a held row the history no longer has is gone",
    h.store.get().open!.messages.map((m) => m.msg.id), ["h2", "h3", "l1"]);
  ok("10.3 and the live arrival keeps its verified sender", h.store.get().open!.messages.find((m) => m.msg.id === "l1")?.senderId === "local.rv2");
  pending = gate<CotalMessage[]>();
  const sw = h.ctl.open("general");
  ok("10.4 opening a different channel still starts empty: retention is per channel", h.store.get().open?.channel === "general" && h.store.get().open!.messages.length === 0);
  pending.resolve([]);
  await sw;
  ok("10.5 while it loaded, the view held the previous list itself, not a copy of it", whileLoading === before);

  // ONLY THE LATEST OPEN APPLIES ITS RESULT. A slow read of a channel the reader has left must not
  // land over the channel they are on.
  const slowA = gate<CotalMessage[]>();
  const q = harness({ history: async (key: string) => (key === "a" ? slowA.promise : [msg("b1", "local.dav", "in b", at(10, 7), { channel: "b" })]) });
  q.store.set({ roster, channels: [{ channel: "a", messages: 1 }, { channel: "b", messages: 1 }] });
  const qm = await mount(inShell(createElement(ChannelView, { store: q.store, channel: "b" })));
  let openA!: Promise<void>;
  await qm.run(() => { openA = q.ctl.open("a"); });
  await qm.run(() => q.ctl.open("b"));
  slowA.resolve([msg("a1", "local.rev", "in a", at(10, 6), { channel: "a" })]);
  await qm.run(() => openA);
  same("10.10 a slow read of a channel the reader left lands nowhere: the view still shows the channel they are on",
    [q.store.get().open?.channel, rowsIn(qm.container).map(bodyOf)], ["b", ["in b"]]);
  await qm.unmount();

  // The rendered half: the view mounted over the real controller, during a reopen that hangs.
  pending = gate<CotalMessage[]>();
  reads = 0;
  const v = harness({ history: async () => (reads++ === 0 ? first : pending.promise) });
  v.store.set({ roster, channels: [review] });
  await v.ctl.open("review");
  const m = await mount(inShell(createElement(ChannelView, { store: v.store, channel: "review" })));
  const viewport = () => m.container.querySelector('[role="region"][aria-label="Messages"]') as HTMLElement;
  const scroller = viewport();
  // The list grows 100px a message, so the bottom moves down as one lands.
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => 1000 + 100 * (rowsIn(m.container).length - 2) });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => 200 });
  scroller.scrollTop = 300;
  await m.run(() => scroller.dispatchEvent(scrolled()));
  const rowsBefore = rowsIn(m.container);
  const counts: number[] = [];
  const unsub = v.store.subscribe(() => counts.push(v.store.get().open?.messages.length ?? 0));
  let reopening!: Promise<void>;
  await m.run(() => { reopening = v.ctl.open("review"); });
  const during = rowsIn(m.container);
  ok("10.6 during the reopen the view draws the same rows, the same nodes, never an empty list",
    during.length === 2 && during.every((r, i) => r === rowsBefore[i]) && counts.every((c) => c > 0), { during: during.length, counts });
  pending.resolve(first);
  await m.run(() => reopening);
  unsub();
  ok("10.7 and when the same history lands the reader is still where they had scrolled", scroller.scrollTop === 300 && viewport() === scroller && counts.every((c) => c > 0), { top: scroller.scrollTop, counts });
  scroller.scrollTop = 800;
  await m.run(() => scroller.dispatchEvent(scrolled()));
  await m.run(() => v.ctl.onMessage({ mode: "chat", channel: "review", senderId: "local.dav", msg: msg("l2", "local.dav", "new", at(10, 5)) }));
  ok("10.8 a reader at the bottom follows a new message down, to the new bottom: 1100 high less the 200 shown", scroller.scrollTop === 900, scroller.scrollTop);
  scroller.scrollTop = 100;
  await m.run(() => scroller.dispatchEvent(scrolled()));
  await m.run(() => v.ctl.onMessage({ mode: "chat", channel: "review", senderId: "local.dav", msg: msg("l3", "local.dav", "newer", at(10, 6)) }));
  ok("10.9 and a reader scrolled up stays put while a new message lands below", scroller.scrollTop === 100 && rowsIn(m.container).map(bodyOf).at(-1) === "newer",
    { top: scroller.scrollTop, last: rowsIn(m.container).map(bodyOf).at(-1) });
  await m.unmount();
}

// ── 11. A reload keeps what the page saw verified ────────────────────────────────────────────────
// History rows carry no subject, so they read unverified. A message the page saw verified live keeps
// that copy when history reloads, and a history row with its id is never shown verified in its place.
const frame = (id: string, seq: number) =>
  msg(id, "local.dav", "", at(11, 5), { parts: [{ kind: "ag-ui.frame", seq, type: "RUN_STARTED" }] } as unknown as Partial<CotalMessage>);
{
  let next = gate<CotalMessage[]>();
  let reads = 0;
  const h = harness({ history: async () => (reads++ === 0 ? [] : next.promise) });
  h.store.set({ roster, channels: [review] });
  await h.ctl.open("review");
  const m = await mount(inShell(createElement(ChannelView, { store: h.store, channel: "review" })));
  const rows = () => rowsIn(m.container).map((r) => [bodyOf(r), !unverifiedIn(r)]);
  await m.run(() => h.ctl.onMessage({ mode: "chat", channel: "review", senderId: "local.dav", msg: msg("v1", "local.dav", "Seen live.", at(11, 1)) }));
  let reopening!: Promise<void>;
  await m.run(() => { reopening = h.ctl.open("review"); });
  next.resolve([msg("h0", "local.rev", "Never seen live.", at(11, 0)), msg("v1", "local.dav", "Seen live.", at(11, 1))]);
  await m.run(() => reopening);
  const reloaded = rows();
  same("11.1 a message received live and then reloaded from history still renders verified, and the history copy is not shown twice",
    reloaded.filter(([t]) => t === "Seen live."), [["Seen live.", true]]);
  same("11.2 a message the page never saw live renders unverified", reloaded.filter(([t]) => t === "Never seen live."), [["Never seen live.", false]]);
  next = gate<CotalMessage[]>();
  await m.run(() => { reopening = h.ctl.open("review"); });
  next.resolve([msg("h0", "local.rev", "Never seen live.", at(11, 0)), msg("v1", "local.dav", "Seen live, then edited.", at(11, 1))]);
  await m.run(() => reopening);
  same("11.3 a history row with a verified message's id and claimed sender but other text is not shown verified: the held live copy is shown in its place",
    rows(), [["Never seen live.", false], ["Seen live.", true]]);
  await m.unmount();
}
{
  let read: CotalMessage[] = [];
  const h = harness({ ...bootReads, dms: async () => read });
  h.ctl.onMessage({ mode: "unicast", senderId: "local.dav", msg: msg("dl1", "local.dav", "Running it now.", at(11, 10), { to: "local.rv2", channel: undefined }) });
  read = [
    msg("do1", "local.rev", "Never seen live.", at(11, 9), { to: "local.dav", channel: undefined }),
    msg("dl1", "local.dav", "Running it now, edited.", at(11, 10), { to: "local.rv2", channel: undefined }),
  ];
  await h.ctl.refresh();
  const view = (route: Route) => centre(shellDom({ space: "main", roster, dms: h.store.get().dms }, route));
  const seen = view({ view: "dm", peer: "local.dav", with: "local.rv2" });
  const never = view({ view: "dm", peer: "local.dav", with: "local.rev" });
  same("11.4 a direct message received live keeps its verified copy when a refresh reads the DMs back, and a conversation never seen live stays unverified",
    [rowsIn(seen).map(bodyOf), !unverifiedIn(seen.querySelector("header")), unverifiedIn(never.querySelector("header"))],
    [["Running it now."], true, true]);
}
{
  let entries: unknown[] = [];
  const h = harness({ ...bootReads, activity: async () => page(entries) });
  h.ctl.onMessage({ mode: "chat", channel: "review", senderId: "local.rev", msg: msg("al1", "local.rev", "Seen live.", at(11, 20)) });
  entries = [
    { mode: "chat", channel: "review", msg: msg("ao1", "local.dav", "Never seen live.", at(11, 19)) },
    { mode: "chat", channel: "review", msg: msg("al1", "local.rev", "Seen live, then edited.", at(11, 20)) },
  ];
  await h.ctl.refresh();
  const rows = rowsIn(centre(shellDom({ space: "main", roster, activity: h.store.get().activity }, { view: "activity" })))
    .map((r) => [bodyOf(r), !unverifiedIn(r.querySelector('[data-slot="message-header"]'))]);
  same("11.5 an Activity row received live keeps its verified copy, once, when a refresh reads Activity back, and a row never seen live stays unverified",
    rows, [["Seen live.", true], ["Never seen live.", false]]);
}
{
  const next = gate<CotalMessage[]>();
  let reads = 0;
  const h = harness({ history: async () => (reads++ === 0 ? [] : next.promise) });
  await h.ctl.open("review");
  const reopening = h.ctl.open("review");
  h.ctl.onMessage({ mode: "chat", channel: "review", senderId: "local.dav", msg: frame("f1", 1) });
  const heldBack = h.store.get().open?.messages.length;
  next.resolve([frame("f1", 1)]);
  await reopening;
  same("11.6 a frame the channel's order machine held back during a reopen keeps its verified copy when the history carries it too",
    [heldBack, h.store.get().open?.messages.map((m) => [m.msg.id, m.senderId ?? null])], [0, [["f1", "local.dav"]]]);
}
{
  const pg = gate<ReturnType<typeof page>>();
  const h = harness({ ...bootReads, activity: () => pg.promise });
  const refreshing = h.ctl.refresh();
  h.ctl.onMessage({ mode: "chat", channel: "review", senderId: "local.dav", msg: frame("f2", 1) });
  const heldBack = h.store.get().activity.length;
  pg.resolve(page([{ mode: "chat", channel: "review", msg: frame("f2", 1) }]));
  await refreshing;
  same("11.7 a frame the feed's order machine held back during a refresh keeps its verified copy when Activity's backfill carries it too",
    [heldBack, h.store.get().activity.map((e) => [e.msg.id, (e as FeedMessage).senderId ?? null])], [0, [["f2", "local.dav"]]]);
}

// ── 12. The DM window ────────────────────────────────────────────────────────────────────────────
// The page holds the newest `DM_WINDOW` direct messages space-wide, and knows when that window may not
// reach back to the start: a read that filled it, or a live DM that pushed the oldest out.
const unicast = (id: string, from = "local.dav", to = "local.rv2"): FeedMessage =>
  ({ mode: "unicast", senderId: from, msg: msg(id, from, `dm ${id}`, at(12, 0), { to, channel: undefined }) }) as FeedMessage;
const dmRead = (n: number, prefix = "r") =>
  Array.from({ length: n }, (_, i) => msg(`${prefix}${i}`, "local.rev", `read ${i}`, at(9, 0) + i, { to: "local.pln", channel: undefined }));
{
  const h = harness({});
  for (let i = 0; i < DM_WINDOW + 3; i++) h.ctl.onMessage(unicast(`l${i}`));
  const ids = h.store.get().dms.map((d) => d.msg.id);
  same("12.1 live DMs past the window keep the newest 500, as Activity keeps its newest",
    [ids.length, ids[0], ids.at(-1)], [DM_WINDOW, "l3", `l${DM_WINDOW + 2}`]);
}
{
  const h = harness({ ...bootReads, dms: async () => dmRead(3) });
  await h.ctl.refresh();
  h.ctl.onMessage(unicast("r1", "local.rev", "local.pln"));
  h.ctl.onMessage(unicast("n1"));
  h.ctl.onMessage(unicast("n1"));
  same("12.2 a DM the page already holds, read or live, is kept once when the feed delivers it again",
    h.store.get().dms.map((d) => d.msg.id), ["r0", "r1", "r2", "n1"]);
}
{
  const h = harness({ ...bootReads, dms: async () => dmRead(DM_WINDOW - 1) });
  await h.ctl.refresh();
  ok("12.3 a DM read that comes back short of the window held all the server had, so the window is not cut",
    h.store.get().dms.length === DM_WINDOW - 1 && h.store.get().dmsCut === false, h.store.get().dmsCut);
  h.ctl.onMessage(unicast("n1"));
  ok("12.3b and a live DM that only fills it drops nothing, so it is still not cut",
    h.store.get().dms.length === DM_WINDOW && h.store.get().dmsCut === false, h.store.get().dmsCut);
  h.ctl.onMessage(unicast("n2"));
  ok("12.5 a live DM that pushes the oldest out marks the window cut",
    h.store.get().dms.length === DM_WINDOW && h.store.get().dms[0].msg.id === "r1" && h.store.get().dmsCut === true, h.store.get().dmsCut);
}
{
  const h = harness({ ...bootReads, dms: async () => dmRead(DM_WINDOW) });
  await h.ctl.refresh();
  ok("12.4 a DM read that fills the window may have left older DMs on the server, so the window is cut",
    h.store.get().dms.length === DM_WINDOW && h.store.get().dmsCut === true, h.store.get().dmsCut);
}
{
  const h = harness({});
  for (let i = 0; i < DM_WINDOW; i++) h.ctl.onMessage(unicast(`l${i}`));
  h.ctl.onMessage(unicast("l500"));
  h.ctl.onMessage(unicast("l0"));
  const ids = h.store.get().dms.map((d) => d.msg.id);
  same("12.8 the window forgets an id it dropped: that DM delivered again is held again, as the newest",
    [ids.length, ids[0], ids.at(-1)], [DM_WINDOW, "l2", "l0"]);
}
{
  // Two conversations: rev and pln hold the window's oldest message, and dav and rv2 start later.
  const window: StoredMessage[] = [
    { msg: msg("w1", "local.rev", "Oldest in the window.", at(9, 0), { to: "local.pln", channel: undefined }), senderId: "local.rev" },
    { msg: msg("w2", "local.dav", "Starts later.", at(9, 5), { to: "local.rv2", channel: undefined }), senderId: "local.dav" },
    { msg: msg("w3", "local.rv2", "A reply.", at(9, 6), { to: "local.dav", channel: undefined }), senderId: "local.rv2" },
  ];
  const first = (cut: boolean, route: Route) => {
    // The list's first line: the cutoff is a plain Marker, where a day divider is a separator one.
    const line = centre(shellDom({ space: "main", roster, dms: window, dmsCut: cut }, route)).querySelector('[role="log"] > [data-slot="message-scroller-item"] > [data-slot="marker"]');
    return [line?.getAttribute("data-variant") === "separator" ? "day" : line ? "cutoff" : null, textOf(line)];
  };
  same("12.6 while the window is cut, every conversation opens on a quiet line saying earlier messages are not loaded, including one whose oldest message is not the window's oldest",
    [first(true, { view: "dm", peer: "local.rev", with: "local.pln" }), first(true, { view: "dm", peer: "local.dav", with: "local.rv2" })],
    [["cutoff", "Earlier messages aren't loaded"], ["cutoff", "Earlier messages aren't loaded"]]);
  ok("12.7 while the window holds all the server had, no conversation says so",
    [{ view: "dm", peer: "local.rev", with: "local.pln" }, { view: "dm", peer: "local.dav", with: "local.rv2" }].every((r) => first(false, r as Route)[0] === "day")
      && textOf(centre(shellDom({ space: "main", roster, dms: window, dmsCut: false }, { view: "dm", peer: "local.dav", with: "local.rv2" }))).includes("Starts later."));
}

// ── 13. The View work action on a message ───────────────────────────────────────────────────────
/** #review with one more live row, from an id the roster does not hold. */
const strangerRow: StoredMessage = { msg: msg("z1", "local.zzz", "From a stranger.", at(10, 47)), senderId: "local.zzz" };
const actionSeed = () => channelSeed({ open: { channel: "review", messages: [...reviewMessages, strangerRow] } });
/** The row whose body reads `body`. */
const rowWith = (root: Element, body: string) => rowsIn(root).find((r) => bodyOf(r) === body);
/** A row's View work link. */
const workLink = (r: Element | undefined) => (r ? all(r, "a").find((a) => textOf(a) === "View work") : undefined) as HTMLAnchorElement | undefined;
{
  const c = centre(shellDom(actionSeed(), channelRoute));
  const link = workLink(rowWith(c, "This fails on empty input."));
  const hint = link ? c.querySelector(`[id="${link.getAttribute("aria-describedby")}"]`) : null;
  same("13.1 a live row from a roster agent has the View work action, linking to its page's Work at that message, described with the name and time its tooltip shows",
    [textOf(link), link?.getAttribute("href"), textOf(hint)], ["View work", "#/agent/local.rev/work/m3", "View reviewer's work at 10:44"]);
  same("13.2 a row read from history has no View work action",
    ["Read from history.", "Also from history."].map((b) => [rowWith(c, b) !== undefined, workLink(rowWith(c, b)) ?? null]), [[true, null], [true, null]]);
  const stranger = rowWith(c, "From a stranger.");
  ok("13.3 a live row from an id the roster does not hold has no View work action", stranger !== undefined && workLink(stranger) === undefined && link !== undefined);
}
{
  const PointerEventOf = dom.window.PointerEvent as typeof PointerEvent;
  const KeyboardEventOf = dom.window.KeyboardEvent as typeof KeyboardEvent;
  const store = createStore<DashboardState>({ ...initialState, ...actionSeed() });
  const m = await mount(createElement(Shell, { store, controller: null, route: channelRoute, paneOpen: true, msgPerSecond: () => 0 }));
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  const body = () => rowWith(m.container, "This fails on empty input.")?.querySelector('[data-slot="bubble-content"]') ?? null;
  const pointer = (type: string, el: Element | null, x: number, y: number, pointerType = "touch") =>
    el?.dispatchEvent(new PointerEventOf(type, { bubbles: true, cancelable: true, pointerType, pointerId: 7, clientX: x, clientY: y }));
  /** Hold a pointer on reviewer's row past the long press, moving it `dx` first, then lift it. */
  const hold = async (pointerType = "touch", dx = 0) => {
    await m.run(() => { pointer("pointerdown", body(), 40, 40, pointerType); });
    if (dx !== 0) await m.run(() => { pointer("pointermove", body(), 40 + dx, 40, pointerType); });
    await m.run(() => sleep(560));
    await m.run(() => { pointer("pointerup", body(), 40 + dx, 40, pointerType); });
  };
  const sheet = () => document.querySelector('[role="dialog"]');
  const choices = () => all(sheet() ?? none(), '[data-slot="sheet-footer"] > *').map(textOf);
  const selected = () => textOf(m.container.querySelector('section[aria-label="Details"] [role=tab][aria-selected=true]'));

  await hold();
  // Radix's dialog opens on its first control that is not a link, so a stray Enter does not navigate.
  same("13.4 a touch held past 500ms on the row opens the sheet: the sender, when it was sent, and three choices, focus on the first that is not a link",
    [sheet()?.getAttribute("role"), textOf(sheet()?.querySelector('[data-slot="sheet-title"]')), textOf(sheet()?.querySelector('[data-slot="sheet-description"]')), choices(),
      sheet()?.querySelector('[data-slot="sheet-footer"] a')?.getAttribute("href"), document.activeElement === sheet()?.querySelector('[data-slot="sheet-footer"] button')],
    ["dialog", "reviewer", "Message at 10:44", ["View reviewer's work here", "View agent", "Copy text"], "#/agent/local.rev/work/m3", true]);
  await m.run(() => { document.dispatchEvent(new KeyboardEventOf("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  ok("13.5 Escape closes the sheet", sheet() === null);

  await hold();
  const scrim = document.querySelector('[data-slot="sheet-overlay"]');
  await m.run(() => {
    pointer("pointerdown", scrim, 5, 5);
    (scrim as HTMLElement | null)?.click();
  });
  ok("13.6 a tap on the scrim closes it", scrim !== null && sheet() === null);

  await hold();
  await m.run(() => (all(sheet() ?? none(), '[data-slot="sheet-footer"] > *').find((b) => textOf(b) === "View agent") as HTMLElement | undefined)?.click());
  ok("13.7 View agent closes the sheet and opens the sender's Agent tab",
    sheet() === null && selected() === "Agent" && textOf(m.container.querySelector('section[aria-label="Details"] .ox-peek-who b')) === "reviewer", selected());

  await hold("touch", 20);
  ok("13.8 a touch that moves 20px before 500ms is a scroll and opens nothing", sheet() === null);
  await hold("mouse");
  ok("13.9 a mouse held past 500ms opens nothing: the long press is for touch", sheet() === null);

  // A press that opened the sheet and was never followed by a click: the next click is a new one.
  await hold();
  await m.run(() => { document.dispatchEvent(new KeyboardEventOf("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await m.run(() => sleep(200));
  const link = workLink(rowWith(m.container, "This fails on empty input.")) ?? null;
  let reached: boolean | undefined;
  // The link's own listener: it sees the click only if the row let it through, and keeps jsdom from following the hash.
  link?.addEventListener("click", (e) => { reached = !e.defaultPrevented; e.preventDefault(); });
  await m.run(() => { link?.dispatchEvent(new (dom.window.MouseEvent as typeof MouseEvent)("click", { bubbles: true, cancelable: true })); });
  ok("13.10 after a press that fired with no click of its own, a later click on the row's View work link goes through", reached === true, reached);
  await m.unmount();
}

// ── 14. Picking an agent: its page on a phone, its peek on a wide screen ────────────────────────
{
  const pickOn = async (route: Route, phone: boolean, pickIt: (root: HTMLElement) => void) => {
    location.hash = "";
    localStorage.clear();
    const store = createStore<DashboardState>({ ...initialState, ...channelSeed() });
    const m = await mount(createElement(Shell, { store, controller: null, route, paneOpen: route.view === "channel", msgPerSecond: () => 0, phone }));
    await m.run(() => pickIt(m.container));
    const got = { hash: location.hash, peek: textOf(m.container.querySelector('section[aria-label="Details"] .ox-peek-who b')) };
    await m.unmount();
    location.hash = "";
    localStorage.clear();
    return got;
  };
  const byName = (root: HTMLElement) => (all(root, 'main [data-slot="message"] [data-slot="message-header"] button').find((b) => textOf(b) === "reviewer") as HTMLElement | undefined)?.click();
  const byRow = (root: HTMLElement) => (root.querySelector("main button.v3-arow[data-agent='local.rev']") as HTMLElement | null)?.click();
  const byNode = (root: HTMLElement) =>
    root.querySelector("main g[data-node='local.rev']")?.dispatchEvent(new (dom.window.MouseEvent as typeof MouseEvent)("click", { bubbles: true, cancelable: true }));
  same("14.1 on a phone a sender's name goes to that agent's page", await pickOn(channelRoute, true, byName), { hash: "#/agent/local.rev", peek: "" });
  same("14.2 on a phone an Agents view row goes to that agent's page", await pickOn({ view: "agents", group: "status" }, true, byRow), { hash: "#/agent/local.rev", peek: "" });
  same("14.3 on a phone a topology node goes to that agent's page", await pickOn({ view: "topology" }, true, byNode), { hash: "#/agent/local.rev", peek: "" });
  same("14.4 on a wide screen a topology node opens that agent's peek and leaves the address alone", await pickOn({ view: "topology" }, false, byNode), { hash: "", peek: "reviewer" });
  same("14.5 on a wide screen a sender's name opens that agent's peek and leaves the address alone", await pickOn(channelRoute, false, byName), { hash: "", peek: "reviewer" });
}

await closeDom();
console.log(`views: ${n} checks passed`);

