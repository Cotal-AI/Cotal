/** The right panel (mock section D, the panel; section B, the delete dialog and the agent states):
 *  its tabs and their defaults, the Members tab with its pill and channel details, the Agent tab's
 *  peek and the Profile its fields and commands moved to, the delete dialog, the Topology tab at
 *  panel size, and the picker, `selectAgent`, that the views call. Each cell renders the real shell or a tab over a seeded store,
 *  on the server or mounted in jsdom when it needs a click, and reads the DOM it drew.
 *
 *  What is pinned, beyond the markup: Model says "not reported" when the card has none; only Do not
 *  disturb and Focus show; the heartbeat is labelled as a heartbeat ("Heartbeat 2s ago"); the delete
 *  button waits for the exact name and a refusal stays in the dialog; the panel's open state survives
 *  a reload and blocked storage; and a graph honours a new size on the same mount. The peek's "Now"
 *  shows the current turn's last three steps, or the last turn's, and the peek holds the agent's work
 *  open while it is drawn, except when the card says the event plane is off; "Now" is left out beside
 *  that agent's own page in the centre. */
import { closeDom, dom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { createElement, useState } from "react";
import { renderToString } from "react-dom/server";
import type { ChannelInfo, CotalMessage, MembershipSnapshot, RosterEntry } from "../client/src/api/types.js";
import { formatRoute, type Route } from "../client/src/lib/route.js";
import type { SessionFrame } from "../client/src/lib/session.js";
import { topologyModel, type TopoModel } from "../client/src/lib/topology.js";
import { Shell } from "../client/src/Shell.tsx";
import type { Controller } from "../client/src/state/controller.js";
import { createStore } from "../client/src/state/store.js";
import { initialState, type DashboardState, type SessionState, type StoredMessage } from "../client/src/state/types.js";
import { ForceLayout } from "../client/src/ui/graph/layout.js";
import { TopologyGraph } from "../client/src/ui/graph/TopologyGraph.tsx";
import { AgentProfile } from "../client/src/ui/agent/AgentProfile.tsx";
import { AgentTab } from "../client/src/ui/panel/AgentTab.tsx";
import { DeleteChannelDialog } from "../client/src/ui/panel/DeleteChannelDialog.tsx";
import { PANEL_KEY } from "../client/src/ui/panel/RightPanel.tsx";
import { TopologyTab } from "../client/src/ui/panel/TopologyTab.tsx";
import { harness } from "./controller-harness.js";
import { errorsDuring, mount, type Mounted } from "./mount.js";
import { renderShell } from "./render-shell.js";

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const same = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────
const NOW = Date.now();
const at = (h: number, m: number) => {
  const d = new Date(NOW);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
type Extra = {
  connector?: string; role?: string; activity?: string; statusSince?: number; model?: string; host?: string;
  attention?: string; ts?: number; progress?: { kind: "unknown" }; channelModes?: Record<string, string>; skills?: string[];
};
const entry = (id: string, name: string, status: RosterEntry["status"], x: Extra = {}): RosterEntry =>
  ({
    card: {
      id, name, kind: "agent", role: x.role,
      meta: { ...(x.connector ? { connector: x.connector } : {}), ...(x.model ? { model: x.model } : {}), ...(x.host ? { host: x.host } : {}) },
      ...(x.skills ? { skills: x.skills.map((s) => ({ id: `skill-${s}`, name: s })) } : {}),
    },
    status,
    ts: x.ts ?? NOW - 2000,
    activity: x.activity,
    statusSince: x.statusSince,
    attention: x.attention,
    progress: x.progress,
    channelModes: x.channelModes,
  }) as RosterEntry;
const roster: RosterEntry[] = [
  entry("local.dav", "david", "working", { connector: "claude-code", role: "engineer", activity: "Editing packages/core/src/presence.ts" }),
  entry("local.rev", "reviewer", "working", {
    connector: "codex", role: "reviewer", activity: "Reviewing the presence TTL diff", statusSince: at(10, 43), model: "gpt-5.5-codex", host: "build-box",
    attention: "dnd", channelModes: { general: "quiet", ops: "loud" }, skills: ["code-review", "typescript", "spec"],
  }),
  entry("local.rv2", "reviewer_2", "waiting", { connector: "opencode", role: "reviewer", activity: "Needs approval to run pnpm smoke:ci", statusSince: at(10, 49), host: "build-box" }),
  entry("local.pln", "planner", "idle", { connector: "pi", role: "planner", attention: "focus" }),
  entry("local.sco", "scout", "offline", { connector: "gemini", role: "researcher" }),
];
const msg = (id: string, from: string, text: string, ts: number, channel = "review"): CotalMessage =>
  ({ id, ts, space: "main", from: { id: from, name: "mallory" }, channel, parts: [{ kind: "text", text }] }) as unknown as CotalMessage;
const review: ChannelInfo = { channel: "review", messages: 9, description: "Review requests. Send them to the reviewer role.", replay: true, replayWindow: "24h", deliveryClass: "durable" };
const general: ChannelInfo = { channel: "general", messages: 1, replay: false, deliveryClass: "live" };
const snapshot = (members: { id: string; live?: string[]; durable?: string[] }[]): MembershipSnapshot =>
  ({ asOf: NOW, members: members.map((m) => ({ live: [], durable: [], observedAt: 1, ...m })) }) as unknown as MembershipSnapshot;
const reviewMembers = snapshot([
  { id: "local.rev", live: ["review"] },
  { id: "local.dav", durable: ["review"] },
  { id: "local.rv2", live: ["review"] },
  { id: "local.pln", live: ["general"] },
]);
const reviewMessages: StoredMessage[] = [
  { msg: msg("m1", "local.dav", "Pushed the presence TTL change.", at(10, 42)), senderId: "local.dav" },
  { msg: msg("m3", "local.rev", "This fails on empty input.", at(10, 44)), senderId: "local.rev" },
  { msg: msg("m4", "local.rev", "Read from history.", at(10, 45)) },
  { msg: msg("m5", "local.rev", "Also from history.", at(10, 46)) },
];
const seed = (patch: Partial<DashboardState> = {}): Partial<DashboardState> => ({
  space: "main",
  roster,
  channels: [review, general],
  membership: { snapshot: reviewMembers },
  open: { channel: "review", messages: reviewMessages },
  ...patch,
});
const inReview: Route = { view: "channel", channel: "review" };

const parse = (html: string): HTMLElement => {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
};
/** An empty element in place of one that failed to draw, so the cell fails on its assertion. */
const none = (): HTMLElement => document.createElement("div");
const textOf = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const all = (el: ParentNode, sel: string) => [...el.querySelectorAll(sel)] as HTMLElement[];
const pane = (el: ParentNode) => (el.querySelector("section.ui-pane") as HTMLElement | null) ?? none();
const tabs = (el: ParentNode) => all(pane(el), ".ui-tabs [role=tab]").map((t) => [textOf(t), t.getAttribute("aria-selected"), (t as HTMLButtonElement).disabled]);
const kv = (el: ParentNode) => all(el, "dl.ui-kv dt").map((dt) => [textOf(dt), textOf(dt.nextElementSibling)]);
const storeOf = (patch: Partial<DashboardState> = {}) => createStore<DashboardState>({ ...initialState, ...seed(patch) });
const agentTab = (id: string, patch: Partial<DashboardState> = {}) =>
  parse(renderToString(createElement(AgentTab, { store: storeOf(patch), id })));
/** The Profile tab of the agent's page, which holds what the Agent tab held before its peek. */
const profile = (id: string, patch: Partial<DashboardState> = {}) =>
  parse(renderToString(createElement(AgentProfile, { store: storeOf(patch), id, clock: () => NOW })));

// ── 1. The panel in the shell and its tab defaults ───────────────────────────────────────────────
{
  const open = parse(renderShell(seed(), inReview, true));
  same("1.1 beside a channel the panel opens on Members, with Agent disabled until someone is picked",
    tabs(open), [["Members", "true", false], ["Agent", "false", true], ["Topology", "false", false]]);
  ok("1.2 its body is the Members tab for the route's channel", textOf(pane(open).querySelector(".v3-mhead > span")) === "#review · 3 members", textOf(pane(open).querySelector(".v3-mhead")));
  const close = pane(open).querySelector(".ui-tabs button.ui-tool") as HTMLElement | null;
  ok("1.3 the tab bar ends with the Close panel button", close?.getAttribute("aria-label") === "Close panel" && close.title === "Close panel", close?.outerHTML);
  const off = parse(renderShell(seed(), { view: "activity" }, false));
  ok("1.4 off a channel, with nobody picked, there is no panel and the grid drops its column",
    off.querySelector("section.ui-pane") === null && (off.querySelector(".ui-app")?.className ?? "").split(" ").includes("no-pane"));
  const toggle = open.querySelector("header.ui-bar button[title='Toggle panel']");
  ok("1.5 the channel header carries Toggle panel, pressed while the panel is open", toggle?.getAttribute("aria-pressed") === "true", toggle?.outerHTML);
}

// ── 2. The Members tab ───────────────────────────────────────────────────────────────────────────
{
  const members = (patch: Partial<DashboardState>) => pane(parse(renderShell(seed(patch), inReview, true)));
  const rows = (p: HTMLElement) => all(p, "button.v3-mrow").map((r) => [r.dataset.member, r.dataset.source]);
  const live = members({});
  same("2.1 an authoritative feed gives the channel's members from membership, in roster order, waiting first",
    rows(live), [["local.rv2", "membership"], ["local.dav", "membership"], ["local.rev", "membership"]]);
  const pill = live.querySelector(".ui-mpill") as HTMLElement;
  same("2.2 the pill reads Membership: live with the notes' tooltip", [textOf(pill), pill?.title], ["Membership: live", "From broker membership, served by the delivery daemon"]);
  same("2.3 each row is the character, the name and role, and the status word",
    all(live, "button.v3-mrow").map((r) => [textOf(r.querySelector(".v3-mname")), textOf(r.querySelector(".v3-spill")), r.querySelector(".ui-av .ui-st") !== null]),
    [["reviewer_2reviewer", "Waiting", true], ["davidengineer", "Working", true], ["reviewerreviewer", "Working", true]]);
  const traffic = members({ membership: {} });
  same("2.4 with no membership feed the members are who posted here, from traffic", rows(traffic), [["local.dav", "traffic"], ["local.rev", "traffic"]]);
  const tp = traffic.querySelector(".ui-mpill") as HTMLElement;
  same("2.5 and the pill says traffic-only with its tooltip", [textOf(tp), tp?.title], ["Membership: traffic-only", "No delivery daemon on an open mesh, so members come from who has posted"]);
  const unread = members({ membership: { snapshot: reviewMembers, unreadable: "403 permissions violation" } });
  const up = unread.querySelector(".ui-mpill") as HTMLElement;
  same("2.6 an unreadable feed says so with the reason, and falls back to traffic",
    [textOf(up), up?.title, rows(unread).map((r) => r[1])], ["Membership: unreadable", "the read failed: 403 permissions violation", ["traffic", "traffic"]]);
  const stranger = members({ membership: { snapshot: snapshot([{ id: "local.zzz", live: ["review"] }, { id: "local.rv2", live: ["review"] }]) } });
  same("2.7 a member the roster does not know is listed last by its id, with no status to show",
    all(stranger, "button.v3-mrow").map((r) => [textOf(r.querySelector(".v3-mname")), r.querySelector(".v3-spill") === null]), [["reviewer_2reviewer", false], ["local.zzz", true]]);
  const one = members({ membership: { snapshot: snapshot([{ id: "local.rv2", live: ["review"] }]) } });
  ok("2.8 one member reads 1 member", textOf(one.querySelector(".v3-mhead > span")) === "#review · 1 member", textOf(one.querySelector(".v3-mhead > span")));
  same("2.9 the channel's details are its topic, its delivery and its message count", kv(live),
    [["Topic", "Review requests. Send them to the reviewer role."], ["Delivery", "durable, replay 24h"], ["Messages", "9"]]);
  const plain = pane(parse(renderShell(seed({ channels: [{ ...general, channel: "review" }] }), inReview, true)));
  same("2.10 a live channel with replay off reads live, and with no topic has no Topic row", kv(plain), [["Delivery", "live"], ["Messages", "1"]]);
  const bare = pane(parse(renderShell(seed({ channels: [{ channel: "review", messages: 4 }] as ChannelInfo[] }), inReview, true)));
  same("2.11 a channel whose policy the server has not sent says nothing about delivery", kv(bare), [["Messages", "4"]]);
  const del = live.querySelector("button.ui-btn-danger") as HTMLElement | null;
  ok("2.12 Delete channel closes the tab, and no dialog is drawn until it is clicked", textOf(del) === "Delete channel" && live.querySelector("[role=dialog]") === null, del?.outerHTML);
  const unknownDot = all(stranger, "button.v3-mrow").map((r) => r.querySelector(".ui-av .ui-st") !== null);
  same("2.13 a member the roster does not know draws no status dot, as it shows no status word", unknownDot, [true, false]);
}

// ── 3. The Agent tab's peek, and the Profile tab that holds the rest ─────────────────────────────
{
  const rev = agentTab("local.rev");
  const card = profile("local.rev");
  same("3.1 the peek is the name and role · harness", [textOf(rev.querySelector(".ox-peek-who b")), textOf(rev.querySelector(".ox-peek-who .ui-sub"))], ["reviewer", "reviewer · Codex"]);
  const big = card.querySelector(".ui-big .ui-av") as HTMLElement | null;
  ok("3.2 Profile draws the character at 88px with no status dot", big?.getAttribute("style")?.includes("--s:88px") === true && big.querySelector(".ui-st") === null, big?.outerHTML.slice(0, 120));
  const sline = rev.querySelector(".ui-sline") ?? none();
  same("3.3 the peek's status line is the status word, the activity, and when it reported",
    [textOf(sline.querySelector(".v3-spill")), textOf(sline.querySelector(":scope > span:not(.v3-spill)")), textOf(sline.querySelector("small"))],
    ["Working", "Reviewing the presence TTL diff", "Reported 10:43"]);
  const message = rev.querySelector(".ui-actions a[data-variant=outline]") as HTMLAnchorElement | null;
  same("3.4 the peek's Message opens the DM view with this agent", [textOf(message), message?.getAttribute("href")], ["Message", formatRoute({ view: "dm", peer: "local.rev" })]);
  same("3.5 Profile's attach and stop are commands to copy, by the agent's name, each led by its icon",
    all(card, ".ui-actions .ui-cmd").map((c) => [c.firstElementChild?.tagName, textOf(c.querySelector("code"))]), [["svg", "cotal attach --name reviewer"], ["svg", "cotal stop --name reviewer"]]);
  const beat = all(card, "dl.ui-kv dt").find((dt) => textOf(dt) === "Heartbeat");
  ok("3.6 the heartbeat is labelled as a heartbeat: Heartbeat 2s ago", `${textOf(beat)} ${textOf(beat?.nextElementSibling)}` === "Heartbeat 2s ago", textOf(card.querySelector("dl.ui-kv")));
  same("3.7 Profile's details are harness, model, host, attention, heartbeat and work events", kv(card),
    [["Harness", "Codex"], ["Model", "gpt-5.5-codex"], ["Host", "build-box"], ["Attention", "Do not disturb"], ["Heartbeat", "2s ago"], ["Work events", "not reported"]]);
  const dnd = card.querySelector("dl.ui-kv .v3-meta") as HTMLElement | null;
  ok("3.8 Do not disturb carries its icon and the notes' tooltip",
    dnd?.title === "Channel messages wait for its next turn. DMs and mentions still wake it." && dnd.querySelector("svg") !== null, dnd?.outerHTML.slice(0, 160));
  const model = all(profile("local.rv2"), "dl.ui-kv dt").find((dt) => textOf(dt) === "Model")?.nextElementSibling as HTMLElement | undefined;
  ok("3.9 a card with no model reads Model not reported", textOf(model) === "not reported" && model?.className === "ui-nr", model?.outerHTML);
  const focus = profile("local.pln").querySelector("dl.ui-kv .v3-meta") as HTMLElement | null;
  same("3.10 Focus shows with its own tooltip", [textOf(focus), focus?.title], ["Focus", "Channel messages stay in the channel. DMs and role requests still reach it."]);
  const attention = (a: string | undefined) => kv(profile("local.dav", { roster: [entry("local.dav", "david", "working", { attention: a })] })).map((r) => r[0]);
  same("3.11 open attention, an unknown mode and none show no Attention row", [attention("open"), attention("away"), attention(undefined)],
    [["Model", "Heartbeat", "Work events"], ["Model", "Heartbeat", "Work events"], ["Model", "Heartbeat", "Work events"]]);
  const unknown = agentTab("local.dav", { roster: [entry("local.dav", "david", "working", { progress: { kind: "unknown" } })] });
  same("3.12 working with no reported progress reads Working, and no activity or time reads as none",
    [textOf(unknown.querySelector(".ui-sline .v3-spill")), textOf(unknown.querySelector(".ui-sline > span:not(.v3-spill)")), unknown.querySelector(".ui-sline small")],
    ["Working", "No current activity", null]);
  const channelRows = (el: HTMLElement) => all(el, ".ui-chrow").map((r) => [...r.children].map(textOf));
  same("3.13 Channels are the agent's from membership, sorted, with its quiet or muted mode and no other", channelRows(card), [["#general", "quiet"], ["#review", ""]]);
  const wide = profile("local.rev", { membership: { snapshot: snapshot([{ id: "local.rev", live: [">"] }]) } });
  same("3.14 a reader of every channel says so instead of listing each", channelRows(wide), [["Reads every channel", ""], ["#general", "quiet"]]);
  const posted = profile("local.dav", {
    membership: {},
    activity: [{ mode: "chat", channel: "ops", msg: msg("a1", "local.dav", "hi", 1, "ops") }, { mode: "chat", channel: "review", msg: msg("a2", "local.rev", "hi", 2) }],
  });
  same("3.15 with no membership feed the channels are where the agent has posted", channelRows(posted), [["#ops", ""]]);
  same("3.16 Skills are the card's", all(card, ".ui-tags .ui-chip").map(textOf), ["code-review", "typescript", "spec"]);
  ok("3.17 the peek holds no commands, details, channels, skills or recent messages: Profile and Messages have them",
    rev.querySelector(".ui-cmd, dl.ui-kv, .ui-chrow, .ui-tags, .ui-mini") === null, rev.innerHTML.slice(0, 300));
  same("3.18 an id the roster does not hold reads Not on the roster, in the peek and in Profile",
    [textOf(agentTab("local.nobody")), textOf(profile("local.nobody"))], ["Not on the roster", "Not on the roster"]);
  const heartbeatAt = (age: number) => {
    const tab = profile("local.dav", { roster: [entry("local.dav", "david", "working", { ts: NOW - age })] });
    return textOf(all(tab, "dl.ui-kv dt").find((dt) => textOf(dt) === "Heartbeat")?.nextElementSibling);
  };
  same("3.19 the heartbeat reads its age in the largest whole unit, a clock ahead as now, and no time as not reported",
    [0, 1999, 59_999, 60_000, 3_599_999, 3_600_000, 86_400_000, -5, Number.NaN].map(heartbeatAt),
    ["0s ago", "1s ago", "59s ago", "1m ago", "59m ago", "1h ago", "1d ago", "0s ago", "not reported"]);
  let t = NOW;
  const ticking = await mount(createElement(AgentProfile, { store: storeOf(), id: "local.rev", clock: () => t }));
  const beatNow = () => textOf(all(ticking.container, "dl.ui-kv dt").find((dt) => textOf(dt) === "Heartbeat")?.nextElementSibling);
  const first = beatNow();
  t += 5000;
  await ticking.run(() => sleep(1100));
  ok("3.20 the heartbeat's age moves on by itself, every second", first === "2s ago" && beatNow() === "7s ago", [first, beatNow()]);
  await ticking.unmount();
}

// ── 4. The delete dialog's markup ────────────────────────────────────────────────────────────────
const dialogHtml = (space: string | null = "main") =>
  parse(renderToString(createElement(DeleteChannelDialog, { channel: "review", space, controller: null, onClose: () => undefined })));
{
  const d = dialogHtml();
  const box = d.querySelector("[role=dialog]") as HTMLElement | null;
  const title = all(box ?? none(), "[id]").find((e) => e.id === box?.getAttribute("aria-labelledby"));
  ok("4.1 the dialog is a modal named by its title, Delete #review?", box?.getAttribute("aria-modal") === "true" && title?.tagName === "H4" && textOf(title) === "Delete #review?", box?.outerHTML.slice(0, 200));
  ok("4.2 its body is the notes' sentence, with the channel and the space",
    textOf(box?.querySelector("p")) === "This deletes every message in #review for everyone on main. You can't undo it. If anyone posts to #review again, it comes back empty.", textOf(box?.querySelector("p")));
  ok("4.3 the field asks for the name: Type review to confirm", textOf(box?.querySelector("label > span")) === "Type review to confirm" && box?.querySelector("label input.ui-field") !== null);
  same("4.4 the buttons are Keep channel and Delete #review, the destructive one disabled and not yet red",
    all(box ?? none(), ".ui-btns button").map((b) => [textOf(b), (b as HTMLButtonElement).disabled, b.className]), [["Keep channel", false, "ui-btn"], ["Delete #review", true, "ui-btn"]]);
  ok("4.5 the dialog sits on a scrim, in the mock's fixed-size card", box?.parentElement?.className === "ui-scrim" && box?.className === "ui-card ui-dialog");
}

// ── 5. Mounted: tabs, picking an agent, closing and remembering ──────────────────────────────────
const KeyboardEventOf = dom.window.KeyboardEvent as typeof KeyboardEvent;
const click = (el: Element | null | undefined) => (el as HTMLElement | null)?.click();
const key = (el: Element | null | undefined, k: string, shift = false) =>
  el?.dispatchEvent(new KeyboardEventOf("keydown", { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
const typeInto = (input: Element | null | undefined, value: string) => {
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor((dom.window.HTMLInputElement as typeof HTMLInputElement).prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new (dom.window.Event as typeof Event)("input", { bubbles: true }));
};
/** A controller that records each delete and answers with `answer`. */
const fakeController = (answer: () => Promise<void> = async () => undefined) => {
  const deleted: string[] = [];
  const controller = { open: async () => undefined, deleteChannel: (c: string) => (deleted.push(c), answer()) } as unknown as Controller;
  return { controller, deleted };
};
let goTo!: (r: Route) => void;
const Harness = ({ store, controller, initial }: { store: ReturnType<typeof storeOf>; controller: Controller | null; initial: Route }) => {
  const [route, setRoute] = useState(initial);
  goTo = setRoute;
  return createElement(Shell, { store, controller, route, paneOpen: route.view === "channel", msgPerSecond: () => 0, clock: () => NOW });
};
/** Live traffic in #review, which the Activity view draws with its verified senders. */
const liveTraffic: DashboardState["activity"] = [{ mode: "chat", channel: "review", senderId: "local.dav", msg: msg("f1", "local.dav", "Live from david.", at(10, 50)) }];
const mountShell = async (controller: Controller | null = null, patch: Partial<DashboardState> = {}) =>
  mount(createElement(Harness, { store: storeOf({ activity: liveTraffic, ...patch }), controller, initial: inReview }));
const tabBy = (m: Mounted, label: string) => all(pane(m.container), "[role=tab]").find((t) => textOf(t) === label);
const selected = (m: Mounted) => textOf(pane(m.container).querySelector("[role=tab][aria-selected=true]"));

localStorage.clear();
{
  const m = await mountShell();
  await m.run(() => click(tabBy(m, "Topology")));
  ok("5.1 clicking Topology selects it and draws the graph", selected(m) === "Topology" && pane(m.container).querySelector(".ui-pane-body svg.ui-topo-svg") !== null, selected(m));
  await m.run(() => click(tabBy(m, "Members")));
  ok("5.2 and clicking Members goes back to the members", selected(m) === "Members" && pane(m.container).querySelector("button.v3-mrow") !== null, selected(m));
  await m.run(() => click(pane(m.container).querySelector("button.v3-mrow[data-member='local.dav']")));
  ok("5.3 picking a member opens the Agent tab on that agent", selected(m) === "Agent" && textOf(pane(m.container).querySelector(".ox-peek-who b")) === "david", selected(m));
  await m.run(() => click(tabBy(m, "Topology")));
  await m.run(() => click(m.container.querySelector("header button.ui-members")));
  ok("5.4 the channel's member stack opens the Members tab", selected(m) === "Members" && (m.container.querySelector("header button.ui-members") as HTMLButtonElement).disabled === false, selected(m));
  await m.run(() => click(m.container.querySelector(".ui-dock .ui-btns > button")));
  ok("5.5 the Needs card's View agent opens the Agent tab on the waiting agent", selected(m) === "Agent" && textOf(pane(m.container).querySelector(".ox-peek-who b")) === "reviewer_2", selected(m));
  const name = all(m.container, "main .ui-msg .ui-mh button.ui-who").map(textOf);
  ok("5.6 a verified sender's name in the channel is a button, and a history row's is not", JSON.stringify(name) === JSON.stringify(["david", "reviewer"]), name);
  await m.run(() => click(all(m.container, "main .ui-msg .ui-mh button.ui-who").find((b) => textOf(b) === "reviewer")));
  ok("5.7 clicking a sender's name opens its Agent tab", selected(m) === "Agent" && textOf(pane(m.container).querySelector(".ox-peek-who b")) === "reviewer", selected(m));
  const faces = all(m.container, "main .ui-msg .ui-gut button.ui-who");
  await m.run(() => click(faces[0]));
  ok("5.8 a verified sender's avatar opens it too, and is not a second tab stop",
    selected(m) === "Agent" && textOf(pane(m.container).querySelector(".ox-peek-who b")) === "david" && JSON.stringify(faces.map((f) => [f.getAttribute("aria-label"), f.tabIndex])) === JSON.stringify([["david", -1], ["reviewer", -1]]),
    faces.map((f) => [f.getAttribute("aria-label"), f.tabIndex]));
  await m.run(() => click(all(m.container, "main .ui-msg .ui-mh button.ui-who").find((b) => textOf(b) === "reviewer")));
  await m.run(() => goTo({ view: "channel", channel: "general" }));
  same("5.9 a new channel route goes back to Members and keeps the pick one click away", tabs(m.container), [["Members", "true", false], ["Agent", "false", false], ["Topology", "false", false]]);
  await m.run(() => goTo({ view: "activity" }));
  ok("5.10 a route with no panel drops the pick, so no panel is drawn", m.container.querySelector("section.ui-pane") === null);
  await m.run(() => click(m.container.querySelector("main .ui-msg .ui-mh button.ui-who")));
  same("5.11 off a channel, picking a sender opens the panel on the Agent tab, with Members disabled",
    [tabs(m.container), textOf(pane(m.container).querySelector(".ox-peek-who b"))], [[["Members", "false", true], ["Agent", "true", false], ["Topology", "false", false]], "david"]);
  await m.run(() => goTo(inReview));
  await m.run(() => click(pane(m.container).querySelector("button[aria-label='Close panel']")));
  ok("5.12 Close panel hides the panel and saves that", m.container.querySelector("section.ui-pane") === null && localStorage.getItem(PANEL_KEY) === "0", localStorage.getItem(PANEL_KEY));
  await m.unmount();

  const again = await mountShell();
  const toggle = again.container.querySelector("header button[title='Toggle panel']");
  ok("5.13 a new page keeps the panel closed, and Toggle panel says it is", again.container.querySelector("section.ui-pane") === null && toggle?.getAttribute("aria-pressed") === "false", toggle?.outerHTML);
  await again.run(() => click(toggle));
  ok("5.14 Toggle panel opens it again and saves that", again.container.querySelector("section.ui-pane") !== null && localStorage.getItem(PANEL_KEY) === "1", localStorage.getItem(PANEL_KEY));
  await again.run(() => click(pane(again.container).querySelector("button[aria-label='Close panel']")));
  await again.run(() => click(again.container.querySelector(".ui-dock .ui-btns > button")));
  ok("5.15 picking an agent opens a closed panel on the Agent tab", selected(again) === "Agent" && localStorage.getItem(PANEL_KEY) === "1", selected(again));
  await again.unmount();
  localStorage.clear();
}
{
  const g = globalThis as Record<string, unknown>;
  const real = Object.getOwnPropertyDescriptor(g, "localStorage");
  Object.defineProperty(g, "localStorage", { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } });
  try {
    let m: Mounted | undefined;
    let opened = false;
    let crashed: unknown;
    const errors = await errorsDuring(async () => {
      try {
        m = await mountShell();
        opened = m.container.querySelector("section.ui-pane") !== null;
        await m.run(() => click(pane(m!.container).querySelector("button[aria-label='Close panel']")));
      } catch (e) {
        crashed = e;
      }
    });
    ok("5.16 with storage blocked the panel still opens, and closing it still works for this page",
      crashed === undefined && opened && m?.container.querySelector("section.ui-pane") === null && errors.length === 0, { errors, crashed: String(crashed) });
    await m?.unmount();
  } finally {
    if (real) Object.defineProperty(g, "localStorage", real);
  }
}

{
  const m = await mountShell();
  const roving = () => all(pane(m.container), "[role=tab]").map((t) => [textOf(t), t.tabIndex]);
  same("5.17 the selected tab is the list's one Tab stop", roving(), [["Members", 0], ["Agent", -1], ["Topology", -1]]);
  tabBy(m, "Members")?.focus();
  await m.run(() => key(document.activeElement, "ArrowRight"));
  ok("5.18 Right moves to the next enabled tab and selects it, skipping a disabled one",
    selected(m) === "Topology" && document.activeElement === tabBy(m, "Topology"), [selected(m), textOf(document.activeElement)]);
  const walk: string[] = [];
  for (const k of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
    await m.run(() => key(document.activeElement, k));
    walk.push(`${k} ${selected(m)} ${textOf(document.activeElement)}`);
  }
  same("5.19 Right and Left wrap, Home and End go to the ends, and focus follows the selection",
    walk, ["ArrowRight Members Members", "ArrowLeft Topology Topology", "Home Members Members", "End Topology Topology"]);
  same("5.20 and the Tab stop moves with it", roving(), [["Members", -1], ["Agent", -1], ["Topology", 0]]);
  await m.unmount();
}

// ── 6. Mounted: the delete dialog ────────────────────────────────────────────────────────────────
{
  const { controller, deleted } = fakeController();
  const m = await mountShell(controller);
  const trigger = pane(m.container).querySelector("button.ui-btn-danger");
  await m.run(() => click(trigger));
  const box = () => m.container.querySelector("[role=dialog]");
  const field = () => box()?.querySelector("input");
  const destroy = () => all(box() ?? none(), ".ui-btns button")[1] as HTMLButtonElement | undefined;
  const shape = () => [box()?.className, [...(box()?.children ?? [])].map((c) => `${c.tagName}.${c.className}`)];
  const FIXED = ["ui-card ui-dialog", ["H4.", "P.", "LABEL.", "SPAN.ui-dialog-err", "DIV.ui-btns"]];
  ok("6.1 Delete channel opens the dialog with the field focused", box() !== null && document.activeElement === field(), document.activeElement?.outerHTML);
  const before = JSON.stringify(shape());
  const states: [string, boolean | undefined][] = [];
  for (const v of ["revie", "Review", "review ", "review"]) {
    await m.run(() => typeInto(field(), v));
    states.push([v, destroy()?.disabled]);
  }
  same("6.2 the destructive button waits for the exact name", states, [["revie", true], ["Review", true], ["review ", true], ["review", false]]);
  ok("6.3 the dialog keeps its shape before and after typing, with the error row always there",
    before === JSON.stringify(FIXED) && JSON.stringify(shape()) === before && destroy()?.className === "ui-btn ui-btn-danger-solid", { before, after: shape() });
  destroy()?.focus();
  key(destroy(), "Tab");
  ok("6.4 Tab from the last control wraps to the field", document.activeElement === field(), document.activeElement?.outerHTML);
  key(field(), "Tab", true);
  ok("6.5 and Shift+Tab from the field wraps to the last control", document.activeElement === destroy(), document.activeElement?.outerHTML);
  await m.run(() => key(document.activeElement, "Escape"));
  ok("6.6 Escape closes the dialog and focus returns to Delete channel", box() === null && document.activeElement === trigger, document.activeElement?.outerHTML);
  ok("6.7 closing deletes nothing", deleted.length === 0, deleted);
  await m.run(() => click(trigger));
  await m.run(() => click(all(box() ?? none(), ".ui-btns button")[0]));
  ok("6.8 Keep channel closes it too, with focus back on the trigger", box() === null && document.activeElement === trigger);
  await m.run(() => click(trigger));
  await m.run(() => typeInto(field(), "review"));
  await m.run(() => click(destroy()));
  await m.run(() => sleep(0));
  ok("6.9 confirming deletes the channel by name, once, and closes the dialog", JSON.stringify(deleted) === JSON.stringify(["review"]) && box() === null && document.activeElement === trigger, deleted);
  await m.run(() => click(trigger));
  (document.activeElement as HTMLElement | null)?.blur();
  const scrim = box()?.parentElement;
  await m.run(() => {
    scrim?.dispatchEvent(new (dom.window.MouseEvent as typeof MouseEvent)("mousedown", { bubbles: true, cancelable: true }));
    click(scrim);
  });
  const kept = document.activeElement === field();
  await m.run(() => key(document.activeElement, "Escape"));
  ok("6.10 a click on the scrim keeps focus in the dialog, so Escape still closes it", kept && box() === null && document.activeElement === trigger, { kept, open: box() !== null });
  await m.unmount();

  const refused = fakeController(async () => { throw new Error("delete #review: permissions violation for publish"); });
  const r = await mountShell(refused.controller);
  await r.run(() => click(pane(r.container).querySelector("button.ui-btn-danger")));
  const rbox = () => r.container.querySelector("[role=dialog]");
  await r.run(() => typeInto(rbox()?.querySelector("input"), "review"));
  await r.run(() => click(all(rbox() ?? none(), ".ui-btns button")[1]));
  await r.run(() => sleep(0));
  ok("6.11 a refusal keeps the dialog open and shows the server's error in it",
    rbox() !== null && textOf(rbox()?.querySelector("[role=alert]")) === "delete #review: permissions violation for publish" && refused.deleted.length === 1, textOf(rbox()));
  ok("6.12 and the button can be pressed again", (all(rbox() ?? none(), ".ui-btns button")[1] as HTMLButtonElement | undefined)?.disabled === false);
  await r.unmount();
}

// ── 7. The Topology tab and a graph that changes size ────────────────────────────────────────────
/** A frame source on a zero timer, so a layout that takes hundreds of frames settles in well under a second. */
const frames = new Map<number, ReturnType<typeof setTimeout>>();
let frameId = 0;
const fg = globalThis as unknown as { requestAnimationFrame: (cb: (t: number) => void) => number; cancelAnimationFrame: (id: number) => void };
fg.requestAnimationFrame = (cb) => {
  const id = ++frameId;
  frames.set(id, setTimeout(() => { frames.delete(id); cb(0); }, 0));
  return id;
};
fg.cancelAnimationFrame = (id) => { clearTimeout(frames.get(id)); frames.delete(id); };
const idle = async () => { for (let i = 0; i < 500 && frames.size > 0; i++) await sleep(10); };
{
  const t = parse(renderToString(createElement(TopologyTab, { store: storeOf(), clock: () => NOW })));
  same("7.1 the Topology tab draws the pill, Hide offline on, and the graph at the panel's 360 by 420",
    [textOf(t.querySelector(".ui-mpill")), t.querySelector("button[aria-pressed]")?.getAttribute("aria-pressed"), t.querySelector("svg.ui-topo-svg")?.getAttribute("viewBox")],
    ["Membership: live", "true", "0 0 360 420"]);
  const model: TopoModel = topologyModel({ roster, channels: [review, general], membership: { snapshot: reviewMembers }, recent: [], hideOffline: true, hideEmpty: true, now: NOW });
  const layout = new ForceLayout(360, 420);
  layout.sync(model);
  layout.warm();
  ok("7.2 a layout told its own size again changes nothing, and a new size refits it", layout.resize(360, 420) === false && layout.resize(720, 420) === true && layout.resize(720, 420) === false);

  let setSize!: (s: { width: number; height: number }) => void;
  const Sized = () => {
    const [s, set] = useState({ width: 360, height: 420 });
    setSize = set;
    return createElement(TopologyGraph, { model, width: s.width, height: s.height });
  };
  const xs = (root: ParentNode) => all(root, "[data-node]").map((e) => Number(/^translate\((-?[\d.e+-]+) /.exec(e.getAttribute("transform") ?? "")?.[1]));
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const g = await mount(createElement(Sized));
  const narrow = mean(xs(g.container));
  await g.run(() => setSize({ width: 1080, height: 420 }));
  await g.run(() => idle());
  const wide = mean(xs(g.container));
  ok("7.3 a graph given a new size on the same mount moves its nodes to the new middle",
    g.container.querySelector("svg")?.getAttribute("viewBox") === "0 0 1080 420" && Math.abs(narrow - 180) < 60 && Math.abs(wide - 540) < 60, { narrow, wide });
  await g.unmount();
}

// ── 8. The peek's Now, Open <name>'s page, and the work it holds open ─────────────────────────────
/** reviewer's card saying its event plane is `events`, with the rest of its entry as above. */
const withPlane = (events: "on" | "off", over: Partial<RosterEntry> = {}): RosterEntry => {
  const rev = roster.find((p) => p.card.id === "local.rev")!;
  return { ...rev, ...over, card: { ...rev.card, meta: { ...rev.card.meta, "ai.cotal.events": events } } } as RosterEntry;
};
const othersAnd = (rev: RosterEntry) => roster.map((p) => (p.card.id === "local.rev" ? rev : p));
const sessionOf = (over: Partial<SessionState> = {}): SessionState => ({ views: 1, frames: [], posts: [], load: "ok", more: false, limit: 200, ...over });
/** A frame of one event, or of a paragraph of reviewer's text. */
const frame = (id: string, ts: number, events: unknown[]): SessionFrame => ({ id, ts, live: false, events });
const run = (id: string, ts: number) => frame(id, ts, [{ type: "RUN_STARTED", threadId: "t", runId: id, timestamp: ts }]);
const done = (id: string, ts: number) => frame(id, ts, [{ type: "RUN_FINISHED", threadId: "t", runId: id, timestamp: ts }]);
const para = (id: string, body: string, ts: number) => frame(id, ts, [
  { type: "TEXT_MESSAGE_START", messageId: id, timestamp: ts },
  { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: body, timestamp: ts },
  { type: "TEXT_MESSAGE_END", messageId: id, timestamp: ts },
]);
const call = (id: string, name: string, ts: number, isError?: boolean) => frame(id, ts, [
  { type: "TOOL_CALL_START", toolCallId: id, toolCallName: name, timestamp: ts }, { type: "TOOL_CALL_END", toolCallId: id, timestamp: ts },
  ...(isError === undefined ? [] : [{ type: "CUSTOM", name: "cotal.toolResult", value: { toolCallId: id, isError }, timestamp: ts + 1000 }]),
]);
/** An open turn three minutes old: a command that failed, then four paragraphs. */
const openTurn = (): SessionFrame[] => {
  const t0 = NOW - 3 * 60_000;
  return [run("r1", t0), call("c1", "Bash", t0 + 1000, true), ...[1, 2, 3, 4].map((i) => para(`p${i}`, `step ${i}`, t0 + i * 10_000))];
};
/** One frame holding two tool calls with no text between, each with its result marker, which fold
 *  into one group. */
const twoCalls = (): SessionFrame => {
  const ts = at(10, 30);
  const ended = (id: string) => ({ type: "CUSTOM", name: "cotal.toolResult", value: { toolCallId: id, isError: false }, timestamp: ts + 1000 });
  return {
    id: "f-tools", ts, live: false,
    events: [
      { type: "RUN_STARTED", threadId: "t", runId: "r0", timestamp: ts },
      { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "Bash", timestamp: ts }, { type: "TOOL_CALL_END", toolCallId: "c1", timestamp: ts },
      { type: "TOOL_CALL_START", toolCallId: "c2", toolCallName: "Read", timestamp: ts }, { type: "TOOL_CALL_END", toolCallId: "c2", timestamp: ts },
      ended("c1"), ended("c2"),
    ],
  };
};
/** A controller that records the session calls and does nothing else. */
const sessionController = () => {
  const calls: string[] = [];
  const controller = {
    open: async () => undefined,
    openSession: (id: string) => void calls.push(`open ${id}`),
    closeSession: (id: string) => void calls.push(`close ${id}`),
  } as unknown as Controller;
  return { controller, calls };
};
const tabWith = (rev: RosterEntry, patch: Partial<DashboardState> = {}, route?: Route) =>
  parse(renderToString(createElement(AgentTab, { store: storeOf({ roster: othersAnd(rev), ...patch }), id: "local.rev", route })));
const steps = (tab: HTMLElement) => all(tab, ".ox-compact > .ox-step").map(textOf);
{
  const rev = agentTab("local.rev");
  same("8.1 the peek ends with Open <name>'s page, to the agent's page, then Message",
    all(rev, ".ui-actions > a").map((a) => [textOf(a), a.getAttribute("href"), a.getAttribute("data-variant")]),
    [["Open reviewer's page", "#/agent/local.rev", "default"], ["Message", formatRoute({ view: "dm", peer: "local.rev" }), "outline"]]);

  const working = tabWith(withPlane("on"), { sessions: { "local.rev": sessionOf({ frames: openTurn() }) } });
  same("8.2 for a working agent the peek shows Now, with Working for on the right, over the open turn's last three steps, and no footer",
    {
      head: textOf(working.querySelector(".ox-now-head h5")),
      title: /^Working for \d+m \d+s,/.test(textOf(working.querySelector(".ox-now-t"))),
      steps: steps(working),
      foot: working.querySelector(".ox-foot"),
      after: working.querySelector(".ui-sline")?.nextElementSibling?.classList.contains("ox-now-head"),
    },
    { head: "Now", title: true, steps: ["step 2", "step 3", "step 4"], foot: null, after: true });
  ok("8.3 Now's title counts the failed call of the whole turn, though that step is not among the three shown",
    textOf(working.querySelector(".ox-now-t")).endsWith(", 1 command failed"), textOf(working.querySelector(".ox-now-t")));

  const t0 = NOW - 10 * 60_000;
  const idle = tabWith(withPlane("on", { status: "idle" }), { sessions: { "local.rev": sessionOf({ frames: [run("r1", t0), para("p1", "wrapped up", t0 + 1000), done("r1", t0 + 220_000)] }) } });
  same("8.4 for an idle agent the peek shows Last turn, with how long it worked",
    [textOf(idle.querySelector(".ox-now-head h5")), textOf(idle.querySelector(".ox-now-t")), steps(idle)],
    ["Last turn", "Worked for 3m 40s", ["wrapped up"]]);

  const off = tabWith(withPlane("off"), { sessions: { "local.rev": sessionOf({ frames: openTurn() }) } });
  same("8.5 with the plane off the peek holds only the note that the agent publishes no work events",
    [all(off, ".ox-peek > .ui-plane").map(textOf), off.querySelector(".ox-now-head"), off.querySelector(".ox-compact")],
    [["reviewer publishes no work events."], null, null]);

  const offSpy = sessionController();
  const offTab = await mount(createElement(AgentTab, { store: storeOf({ roster: othersAnd(withPlane("off")) }), controller: offSpy.controller, id: "local.rev" }));
  await offTab.unmount();
  same("8.6 with the plane off the peek opens nothing", offSpy.calls, []);

  const onSpy = sessionController();
  const onTab = await mount(createElement(AgentTab, { store: storeOf({ roster: othersAnd(withPlane("on")) }), controller: onSpy.controller, id: "local.rev" }));
  const whileOpen = [...onSpy.calls];
  await onTab.unmount();
  same("8.7 with the plane on the peek opens the agent's work on mount and closes it on unmount, once each",
    [whileOpen, onSpy.calls], [["open local.rev"], ["open local.rev", "close local.rev"]]);

  const held = { roster: othersAnd(withPlane("on")), sessions: { "local.rev": sessionOf({ frames: openTurn() }) } };
  const beside = parse(renderShell(seed(held), { view: "agent", id: "local.rev", tab: "work" }, true));
  const ownPage = pane(beside);
  const elsewhere = tabWith(withPlane("on"), { sessions: held.sessions }, { view: "agent", id: "local.dav", tab: "work" });
  ok("8.8 beside that agent's own page the peek has no Now, and beside another agent's it does",
    textOf(ownPage.querySelector(".ox-peek-who b")) === "reviewer" && ownPage.querySelector(".ox-now-head") === null && ownPage.querySelector(".ox-compact") === null
      && textOf(elsewhere.querySelector(".ox-now-head h5")) === "Now",
    textOf(ownPage).slice(0, 200));
  const fullFoot = textOf(beside.querySelector("main .ox-work > .ox-foot"));
  ok("8.9 beside the peek, the agent's page ends its work with the full footer: the status presence reports, with its activity",
    fullFoot === "reviewer is working Reviewing the presence TTL diff. Reported 10:43.", fullFoot);

  const tools = tabWith(withPlane("on"), { sessions: { "local.rev": sessionOf({ frames: [twoCalls()] }) } });
  const stops = all(tools, "a[href], button").map((el) => (el.hasAttribute("aria-expanded") ? `group ${textOf(el)}` : textOf(el)));
  same("8.10 in the peek a run of calls is its group's title line, with nothing to open, so Tab goes Open <name>'s page, then Message",
    [steps(tools), stops], [["Ran a command, read a file"], ["Open reviewer's page", "Message"]]);
}
{
  // The shipped controller over a fake Api that records the watch, the read and the unwatch, under
  // the real shell. reviewer's peek is open beside #review, then the reader opens reviewer's page.
  const calls: string[] = [];
  const h = harness({
    agentEvents: async (id, limit) => {
      calls.push(`read ${id} ${limit}`);
      return { frames: [], more: false };
    },
    watch: async (id, feed) => void calls.push(`watch ${id} ${feed}`),
    unwatch: async (id, feed) => void calls.push(`unwatch ${id} ${feed}`),
  });
  h.store.set(() => seed({ roster: othersAnd(withPlane("on")) }));
  h.ctl.onHello("feed-1");
  const controller = { ...h.ctl, open: async () => undefined } as Controller;
  const m = await mount(createElement(Harness, { store: h.store, controller, initial: inReview }));
  await m.run(() => click(all(m.container, "main .ui-msg .ui-mh button.ui-who").find((b) => textOf(b) === "reviewer")));
  await m.run(() => sleep(0));
  const before = [...calls];
  await m.run(() => goTo({ view: "agent", id: "local.rev", tab: "work" }));
  await m.run(() => sleep(0));
  same("8.11 opening the agent's page beside its peek keeps the work the peek holds: no unwatch, no second watch or read, and two views",
    [before, calls.slice(before.length), h.store.get().sessions["local.rev"]?.views, pane(m.container).querySelector(".ox-now-head")],
    [["watch local.rev feed-1", "read local.rev 200"], [], 2, null]);
  await m.unmount();
}

await closeDom();
