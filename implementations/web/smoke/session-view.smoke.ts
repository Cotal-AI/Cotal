/** The agent page at `#/agent/<id>` (overhaul mock B1, C, D and E), mounted in jsdom over a store
 *  seeded through `Partial<DashboardState>` and a fake controller that records what it is asked.
 *
 *  Section 1 pairs `openSession` with `closeSession`. Section 2 renders every Work state's words.
 *  Section 3 is the tabs: a tab change writes the route, Messages lists the agent's own posts and
 *  direct messages, and Profile says whether it publishes work events. Section 4 is Load earlier
 *  and the cap, section 5 the composer and the header, section 6 the arrival at a message and the
 *  new-steps button, and
 *  section 7 which steps rise, fade or fold in. Section 8 mounts `App` with a fake address to read
 *  where the crumb goes back to and to see an old link rewritten. Section 9 mounts `Shell` to hold
 *  that the Agent tab keeps the agent's work open only while an open panel shows it.
 *
 *  The DOM is jsdom, installed first: the prose renders through `lib/md.ts`, whose sanitizer needs a
 *  window, and React's client reads `window` when it loads. */
import { closeDom, dom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { createElement } from "react";
import type { CotalMessage, RosterEntry } from "../client/src/api/types.js";
import { App } from "../client/src/App.tsx";
import type { AgentTab } from "../client/src/lib/route.js";
import type { SessionFrame } from "../client/src/lib/session.js";
import type { RouteHost } from "../client/src/routeWatch.js";
import type { Controller } from "../client/src/state/controller.js";
import { createStore, type Store } from "../client/src/state/store.js";
import { initialState, type DashboardState, type SessionState, type StoredMessage } from "../client/src/state/types.js";
import { loadAgentPage, Shell } from "../client/src/Shell.tsx";
import { Compose } from "../client/src/ui/Composer.tsx";
import { AgentPage } from "../client/src/ui/views/AgentPage.tsx";
import { mount } from "./mount.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const same = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const all = (el: ParentNode, sel: string) => [...el.querySelectorAll(sel)] as HTMLElement[];
/** Text with runs of whitespace collapsed, as a reader sees it. */
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
/** Click an element as a reader would. */
const click = (el: Element | null | undefined) => {
  assert.ok(el, "nothing to click");
  (el as HTMLElement).click();
};
/** Press a tab as a mouse does: Radix selects a tab on mousedown, not on click. */
const press = (el: Element | null | undefined) => {
  assert.ok(el, "nothing to press");
  el.dispatchEvent(new (dom.window.MouseEvent as typeof MouseEvent)("mousedown", { bubbles: true, cancelable: true, button: 0 }));
};
/** Type into a React-controlled textarea: set the value through the prototype, then fire input. */
const type = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
  el.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
};

const ENGINE = "local.engine";
const LEAD = "local.lead";
const T = new Date(2026, 9, 17, 10, 58).getTime();
const MIN = 60_000;

/** A controller that records the session calls and the composer's drafts, and does nothing else. */
const fake = () => {
  const calls: string[] = [];
  const say = (name: string) => (...args: unknown[]) => void calls.push(`${name}(${args.map((a) => JSON.stringify(a)).join(",")})`);
  const ctl = {
    openSession: say("openSession"),
    closeSession: say("closeSession"),
    loadEarlier: async (id: string) => say("loadEarlier")(id),
    reloadSession: async (id: string) => say("reloadSession")(id),
    draft: say("draft"),
    send: async (...a: unknown[]) => say("send")(...a),
    open: async () => undefined,
  } as unknown as Controller;
  return { ctl, calls, named: (name: string) => calls.filter((c) => c.startsWith(`${name}(`)) };
};

/** engine on the roster. `events` is its card's `ai.cotal.events`, left out when undefined. */
const entry = (status: RosterEntry["status"], events?: "on" | "off"): RosterEntry =>
  ({
    card: { id: ENGINE, name: "engine", kind: "agent", role: "engine", meta: { connector: "claude-code", ...(events ? { "ai.cotal.events": events } : {}) } },
    status,
    ts: T,
  }) as unknown as RosterEntry;
const lead = { card: { id: LEAD, name: "lead", kind: "agent", role: "lead", meta: { connector: "claude-code" } }, status: "idle", ts: T } as unknown as RosterEntry;
const session = (over: Partial<SessionState> = {}): SessionState => ({ views: 1, frames: [], posts: [], load: "ok", more: false, limit: 200, ...over });
const seed = (patch: Partial<DashboardState>): Store<DashboardState> => createStore<DashboardState>({ ...initialState, ...patch });

/** One whole paragraph of the agent's text, as a frame. */
const said = (id: string, body: string, ts = T, live = false): SessionFrame => ({
  id, ts, live,
  events: [
    { type: "TEXT_MESSAGE_START", messageId: id, timestamp: ts },
    { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: body, timestamp: ts },
    { type: "TEXT_MESSAGE_END", messageId: id, timestamp: ts },
  ],
});
/** One tool call, START and END, as a frame. */
const called = (id: string, name: string, ts = T, live = false): SessionFrame => ({
  id, ts, live,
  events: [{ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name, timestamp: ts }, { type: "TOOL_CALL_END", toolCallId: id, timestamp: ts }],
});
/** A turn's start or its end, as a frame. */
const started = (id: string, ts: number): SessionFrame => ({ id, ts, live: false, events: [{ type: "RUN_STARTED", threadId: "t", runId: id, timestamp: ts }] });
const finished = (id: string, ts: number): SessionFrame => ({ id, ts, live: false, events: [{ type: "RUN_FINISHED", threadId: "t", runId: id, timestamp: ts }] });
/** engine's own verified post on #team. */
const posted = (id: string, body: string, ts = T): StoredMessage => ({
  msg: { id, ts, space: "main", from: { id: ENGINE, name: "engine" }, channel: "team", parts: [{ kind: "text", text: body }] } as unknown as CotalMessage,
  senderId: ENGINE,
});
/** engine's direct message to lead, verified unless `history`, which carries no sender. */
const dmd = (id: string, body: string, ts = T, history = false): StoredMessage => ({
  msg: { id, ts, space: "main", from: { id: ENGINE, name: "engine" }, to: LEAD, parts: [{ kind: "text", text: body }] } as unknown as CotalMessage,
  ...(history ? {} : { senderId: ENGINE }),
});

const TEAM = { label: "#team", route: { view: "channel", channel: "team" } } as const;
/** The page for engine on `tab`, with the fake controller as the composer's too. */
const view = (store: Store<DashboardState>, ctl: Controller, opts: { at?: string; tab?: AgentTab; phone?: boolean } = {}) =>
  createElement(Compose.Provider, { value: ctl }, createElement(AgentPage, {
    store, controller: ctl, id: ENGINE, tab: opts.tab ?? "work", back: TEAM, panelOpen: false, onTogglePanel: () => undefined,
    ...(opts.at === undefined ? {} : { at: opts.at }), ...(opts.phone ? { phone: true } : {}),
  }));
/** Mount the page over `patch` and hand back its root, the recorder and the store. */
const open = async (patch: Partial<DashboardState>, opts: { at?: string; tab?: AgentTab; phone?: boolean } = {}) => {
  const f = fake();
  const store = seed(patch);
  const m = await mount(view(store, f.ctl, opts));
  return { f, store, m, root: m.container };
};
/** Replace engine's session in the store, as the controller would. */
const putSession = (store: Store<DashboardState>, edit: (s: SessionState) => SessionState) =>
  store.set((st) => ({ sessions: { ...st.sessions, [ENGINE]: edit(st.sessions[ENGINE]!) } }));
// The shell loads the agent page on demand; sections 8 and 9 draw it through the shell.
await loadAgentPage();
/** The Work tab's panel. */
const work = (root: ParentNode) => root.querySelector('[role=tabpanel][data-state=active]');

// ── 1. One open, one close ──────────────────────────────────────────────────────────────────────
{
  const { f, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ frames: [said("f1", "Hello")] }) } });
  const mounted = [...f.named("openSession"), ...f.named("closeSession")];
  await m.unmount();
  const unmounted = [...f.named("openSession"), ...f.named("closeSession")];
  same("1.1 mounting calls openSession once and unmounting calls closeSession once",
    { mounted, unmounted },
    { mounted: [`openSession("${ENGINE}")`], unmounted: [`openSession("${ENGINE}")`, `closeSession("${ENGINE}")`] });
}

// ── 2. Work's states ────────────────────────────────────────────────────────────────────────────
{
  const { root, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ load: "loading" }) } });
  const busy = root.querySelector('[aria-busy="true"]');
  ok("2.1 loading draws the skeleton rows, busy, under the real header and tabs",
    busy !== null && all(busy, ".ui-skel").length === 6 && text(root.querySelector(".ox-head h1")) === "engine"
      && all(root, "[role=tab]").length === 3 && root.querySelector(".ox-work") === null,
    root.innerHTML.slice(0, 400));
  await m.unmount();
}
{
  const reason = "permissions violation for subscription to <b>events.mohamed.lead</b>";
  const grant = "cotal actor grant <reader> --owner mohamed --scope '' --allow-subscribe 'events.mohamed.lead' --allow-publish ''";
  const { root, m } = await open({ roster: [entry("idle", "on")], sessions: { [ENGINE]: session({ load: "refused", reason, grant }) } });
  const empty = root.querySelector(".ui-sess-empty");
  same("2.2 refused names the agent's work, quotes the broker's reason as text and offers the grant to copy",
    {
      title: text(empty?.querySelector("b")),
      paras: all(empty ?? root, "p").map(text),
      markup: (empty?.querySelectorAll("p b").length ?? -1),
      grant: text(empty?.querySelector(".ui-cmd code")),
    },
    {
      title: "This dashboard can't read engine's work",
      paras: [`The broker refused it: ${reason}.`, "The mesh owner can grant a read on that channel:"],
      markup: 0,
      grant,
    });
  await m.unmount();
}
{
  const { root, f, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ load: "failed", reason: "engine events refused with HTTP 502" }) } });
  const empty = root.querySelector(".ui-sess-empty");
  const retry = all(root, "button").find((b) => text(b) === "Try again");
  await m.run(() => click(retry));
  same("2.3 failed with nothing held says the work didn't load, gives the reason, and Try again reloads it",
    { title: text(empty?.querySelector("b")), reason: text(empty?.querySelector("p")), calls: f.named("reloadSession") },
    { title: "engine's work didn't load", reason: "engine events refused with HTTP 502", calls: [`reloadSession("${ENGINE}")`] });
  await m.unmount();
}
{
  const { root, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ load: "failed", reason: "boom", frames: [said("f1", "Hello from before")] }) } });
  const col = work(root)?.querySelector(".ox-col");
  const kids = [...(col?.children ?? [])] as HTMLElement[];
  const line = kids.findIndex((k) => k.classList.contains("ui-plane") && text(k).startsWith("engine's work didn't load. boom"));
  const list = kids.findIndex((k) => k.classList.contains("ox-work"));
  ok("2.4 failed with steps held keeps the list and says it didn't load above it",
    line !== -1 && list > line && text(kids[list]).includes("Hello from before") && root.querySelector(".ui-sess-empty") === null,
    { line, list, html: col?.innerHTML.slice(0, 300) });
  await m.unmount();
}
{
  const { root, m } = await open({ roster: [entry("idle", "off")], sessions: { [ENGINE]: session({ posts: [posted("m-1", "Plan: two-player chess")] }) } });
  same("2.5 with the plane off Work says so, how agents publish them, and shows only the agent's posts",
    {
      notes: all(work(root) ?? root, ".ui-plane").map(text),
      code: all(work(root) ?? root, ".ui-plane code").map(text),
      post: text(root.querySelector(".ox-post .ox-post-h span")),
      body: text(root.querySelector(".ox-post .ui-tx")),
    },
    {
      notes: ["engine publishes no work events, so Work shows only what engine posted. Agents started with cotal spawn publish them unless started with --no-events."],
      code: ["cotal spawn", "--no-events"],
      post: "Posted in #team",
      body: "Plan: two-player chess",
    });
  await m.unmount();
}
{
  const { root, m } = await open({ roster: [entry("idle", "on")], sessions: { [ENGINE]: session() } });
  const empty = root.querySelector(".ui-sess-empty");
  same("2.6 with the plane on and no steps it says the agent hasn't started a turn yet",
    { title: text(empty?.querySelector("b")), p: text(empty?.querySelector("p")) },
    { title: "engine hasn't started a turn yet", p: "Its first turn shows here as soon as it starts." });
  await m.unmount();
}
{
  const { root, m } = await open({ roster: [entry("idle")], sessions: { [ENGINE]: session() } });
  const empty = root.querySelector(".ui-sess-empty");
  same("2.7 with the card silent and no steps it says nothing has arrived, and why that may be",
    { title: text(empty?.querySelector("b")), p: text(empty?.querySelector("p")), code: all(empty ?? root, "p code").map(text) },
    {
      title: "Nothing has arrived from engine yet",
      p: "Agents started with cotal spawn publish one unless started with --no-events. An agent you started yourself may not publish one at all.",
      code: ["cotal spawn", "--no-events"],
    });
  await m.unmount();
}
{
  const { root, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ load: "loading", frames: [said("f1", "Held while it reloads")] }) } });
  ok("2.8 a reload that holds frames keeps them on screen with a quiet loading line, not skeleton rows",
    root.querySelector('[aria-busy="true"]') === null && root.querySelector(".ui-skel") === null
      && text(root.querySelector(".ox-work")).includes("Held while it reloads") && text(root.querySelector('.ui-cutoff[role="status"]')) === "Loading",
    root.innerHTML.slice(0, 400));
  await m.unmount();
}
{
  const on = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ frames: [said("f1", "Hello")] }) } });
  const notes = all(work(on.root) ?? on.root, ".ui-plane").length;
  const list = text(on.root.querySelector(".ox-work")).includes("Hello");
  await on.m.unmount();
  same("2.9 with the plane on, Work holds no note about the plane, only the work", { notes, list }, { notes: 0, list: true });
}

// ── 3. The tabs ─────────────────────────────────────────────────────────────────────────────────
const messagesSeed = (): Partial<DashboardState> => ({
  operatorId: "local.op",
  roster: [entry("working", "on"), lead],
  sessions: { [ENGINE]: session({ posts: [posted("m-1", "Board drawn", T - 3 * MIN), posted("m-2", "Tests pass", T - MIN)] }) },
  dms: [dmd("d-1", "Wall: game over?", T - 2 * MIN), dmd("d-0", "From history", T - 4 * MIN, true)],
});
{
  const { root, m } = await open(messagesSeed(), { tab: "messages" });
  const panel = work(root);
  const markers = all(panel ?? root, "[data-slot=marker]").map(text);
  const rows = all(panel ?? root, ".ox-msg").map((r) => [
    text(r.querySelector(".ui-mh b")), text(r.querySelector(".ui-role")), text(r.querySelector(".ui-tx")), text(r.querySelector(".ox-act")), r.querySelector(".ox-act")?.getAttribute("href"),
  ]);
  same("3.1 Messages lists the agent's verified posts and direct messages by place, newest first, each linking where it went, and no history row",
    { markers, rows, more: text(panel?.querySelector(".ox-msgs-more")) },
    {
      markers: ["#team · 2 posts", "Direct messages · 1 with lead"],
      rows: [
        ["engine", "in #team", "Tests pass", "Open in #team", "#/channel/team"],
        ["engine", "in #team", "Board drawn", "Open in #team", "#/channel/team"],
        ["engine", "to lead", "Wall: game over?", "Open conversation", `#/dm/${ENGINE}/${LEAD}`],
      ],
      more: "Older messages are in each channel's history.",
    });
  await m.unmount();
}
{
  location.hash = "";
  const { root, m } = await open(messagesSeed());
  const tabs = all(root, "[role=tablist] [role=tab]").map((t) => [text(t), t.getAttribute("aria-selected")]);
  const list = root.querySelector("[role=tablist]")?.getAttribute("aria-label");
  await m.run(() => press(all(root, "[role=tab]").find((t) => text(t).startsWith("Messages"))));
  const toMessages = location.hash;
  await m.run(() => press(all(root, "[role=tab]").find((t) => text(t) === "Profile")));
  const toProfile = location.hash;
  same("3.2 the tabs are Work, Messages with its count and Profile, named for the agent, and a tab change writes the route",
    { tabs, list, toMessages, toProfile },
    {
      tabs: [["Work", "true"], ["Messages 3", "false"], ["Profile", "false"]],
      list: "engine",
      toMessages: `#/agent/${ENGINE}/messages`,
      toProfile: `#/agent/${ENGINE}/profile`,
    });
  await m.unmount();
  location.hash = "";
}
{
  const { root, m } = await open({ roster: [entry("idle", "on")], sessions: { [ENGINE]: session() } }, { tab: "messages" });
  same("3.3 Messages with nothing sent says so, and the count is 0",
    [text(work(root)?.querySelector(".ui-sess-empty b")), text(all(root, "[role=tab]")[1])],
    ["No messages from engine on this page yet", "Messages 0"]);
  await m.unmount();
}
{
  const { root, m } = await open({ roster: [entry("idle", "on")], sessions: { [ENGINE]: session({ posts: [posted("m-1", "Only one")] }) } }, { tab: "messages" });
  same("3.4 one post in a channel reads 1 post", text(work(root)?.querySelector("[data-slot=marker]")), "#team · 1 post");
  await m.unmount();
}
{
  const workEvents = async (events?: "on" | "off") => {
    const { root, m } = await open({ roster: [entry("idle", events)], sessions: { [ENGINE]: session() } }, { tab: "profile" });
    const dt = all(work(root) ?? root, "dl.ui-kv dt").find((d) => text(d) === "Work events");
    const got = [text(dt?.nextElementSibling), dt?.nextElementSibling?.className ?? ""];
    await m.unmount();
    return got;
  };
  same("3.5 Profile says whether the agent publishes work events: published for on, not published for off, not reported when the card is silent",
    [await workEvents("on"), await workEvents("off"), await workEvents()],
    [["Published. Tool names, status and times only.", ""], ["Not published", ""], ["not reported", "ui-nr"]]);
}
{
  const { root, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session() } }, { tab: "profile" });
  const panel = work(root);
  same("3.6 Profile is the agent's card at reading width: the character at 88px, the status line and the commands to copy",
    {
      big: (panel?.querySelector(".ui-big .ui-av") as HTMLElement | null)?.style.getPropertyValue("--s") === "88px",
      status: text(panel?.querySelector(".ui-sline .v3-spill")),
      commands: all(panel ?? root, ".ui-actions .ui-cmd code").map(text),
    },
    { big: true, status: "Working", commands: ["cotal attach --name engine", "cotal stop --name engine"] });
  await m.unmount();
}
{
  location.hash = "";
  const { root, m } = await open(messagesSeed());
  const tabs = all(root, "[role=tablist] [role=tab]");
  await m.run(() => tabs[0]!.focus());
  await m.run(() => { tabs[0]!.dispatchEvent(new (dom.window.KeyboardEvent as typeof KeyboardEvent)("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
  await m.run(() => new Promise<void>((done) => setTimeout(done, 20)));
  same("3.7 an arrow key on the tabs moves focus to the next tab and writes no route, so it adds no history entry",
    [text(document.activeElement), location.hash], ["Messages 3", ""]);
  await m.unmount();
  location.hash = "";
}

// ── 4. Load earlier and the cap ─────────────────────────────────────────────────────────────────
{
  const { root, f, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ more: true, frames: [said("f1", "Hello")] }) } });
  const button = all(root, "button").find((b) => text(b) === "Load earlier");
  await m.run(() => click(button));
  same("4.1 Load earlier shows while the channel holds more, and calls loadEarlier",
    { shown: button !== undefined, calls: f.named("loadEarlier"), cap: text(root).includes("Showing the newest 2,000 events") },
    { shown: true, calls: [`loadEarlier("${ENGINE}")`], cap: false });
  await m.unmount();
}
{
  // 2,000 events in one frame: 1,000 calls, each a START and an END.
  const events: unknown[] = [];
  for (let i = 0; i < 1000; i++) events.push({ type: "TOOL_CALL_START", toolCallId: `c${i}`, toolCallName: "Bash", timestamp: T }, { type: "TOOL_CALL_END", toolCallId: `c${i}`, timestamp: T });
  const { root, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ more: true, limit: 400, frames: [{ id: "big", ts: T, live: false, events }] }) } });
  same("4.2 at 2,000 events the cap line replaces Load earlier",
    { button: all(root, "button").some((b) => text(b) === "Load earlier"), cap: all(root, ".ui-cutoff").map(text).includes("Showing the newest 2,000 events") },
    { button: false, cap: true });
  await m.unmount();
}

// ── 5. The composer and the header ──────────────────────────────────────────────────────────────
{
  const { root, f, m } = await open({ roster: [entry("working", "on")], post: { mode: "participant" }, sessions: { [ENGINE]: session() } });
  const box = root.querySelector(".ui-dock textarea") as HTMLTextAreaElement | null;
  const mode = text(root.querySelector(".ui-dock .ui-crow"));
  await m.run(() => box && type(box, "hi"));
  same("5.1 the dock is engine's direct message composer",
    { placeholder: box?.getAttribute("placeholder"), mode: mode.includes("to engine · direct message"), draft: f.named("draft") },
    { placeholder: "Message engine", mode: true, draft: [`draft({"kind":"dm","to":"${ENGINE}"},"hi")`] });
  await m.unmount();
}
{
  const { root, m } = await open({ roster: [entry("working", "on")], post: { mode: "off", reason: "Posting is off on this mesh." }, sessions: { [ENGINE]: session() } }, { tab: "profile" });
  const card = root.querySelector(".ui-dock .ui-composer");
  ok("5.2 with posting off the dock holds the read-only composer on every tab, as the DM view does",
    card?.getAttribute("aria-disabled") === "true" && root.querySelector(".ui-dock textarea") === null && text(card).includes("Posting is off on this mesh."),
    card?.outerHTML.slice(0, 300));
  await m.unmount();
}
{
  const unknown = { ...entry("working", "on"), progress: { kind: "unknown" } } as RosterEntry;
  const { root, m } = await open({ roster: [unknown], sessions: { [ENGINE]: session() } });
  const badge = text(root.querySelector("header.ox-head [data-slot=badge]"));
  ok("5.3 the header Badge says the status presence reports, Working, for an agent whose progress is unknown, with no progress claim", badge === "Working", badge);
  await m.unmount();
}
{
  const { root, m } = await open({ operatorId: "local.op", roster: [entry("working", "on")], sessions: { [ENGINE]: session() } });
  const head = root.querySelector("header.ox-head");
  const message = head?.querySelector("a[data-slot=button]");
  same("5.4 the header is the crumb, the name, role and harness, the status Badge and Message to the operator's conversation",
    {
      crumb: [text(head?.querySelector(".ui-crumb")), head?.querySelector(".ui-crumb")?.getAttribute("title")],
      name: text(head?.querySelector("h1")),
      topic: text(head?.querySelector(".ui-topic")),
      badge: [text(head?.querySelector("[data-slot=badge]")), head?.querySelector("[data-slot=badge]")?.classList.contains("ox-badge-working")],
      message: [text(message), message?.getAttribute("href")],
      panel: head?.querySelector("button.ui-tool")?.getAttribute("title"),
    },
    {
      crumb: ["#team", "Back to #team"],
      name: "engine",
      topic: "engine · Claude Code",
      badge: ["Working", true],
      message: ["Message", `#/dm/${ENGINE}/local.op`],
      panel: "Open panel",
    });
  await m.unmount();
}
{
  const { root, m } = await open({ roster: [entry("waiting", "on")], sessions: { [ENGINE]: session() } }, { phone: true });
  const head = root.querySelector("header.ox-head");
  same("5.5 on a phone the crumb is the back tool, Message is a tool titled for the agent, the Badge stays and the tabs stay under the header",
    {
      tools: all(head ?? root, "a.ui-tool").map((a) => [a.getAttribute("title"), a.getAttribute("aria-label")]),
      crumb: head?.querySelector(".ui-crumb") ?? null,
      topic: head?.querySelector(".ui-topic") ?? null,
      badge: text(head?.querySelector("[data-slot=badge]")),
      tabs: head?.nextElementSibling?.querySelector("[role=tablist]") !== null,
    },
    {
      tools: [["Back to #team", "Back to #team"], ["Message engine", "Message engine"]],
      crumb: null,
      topic: null,
      badge: "Waiting",
      tabs: true,
    });
  await m.unmount();
}

// ── 6. Arriving at a message, and the new-steps button ──────────────────────────────────────────
/** Run `fn` with jsdom given just enough layout: a scroll box 100px high over 1,000px of content.
 *  Each scrollIntoView is logged by the post it was called on, and each scroll of the Work scroller
 *  as `end:<top>:<behavior>`. `reduce` makes the page report reduced motion. */
const withLayout = async (fn: (log: string[]) => Promise<void>, reduce = false) => {
  const log: string[] = [];
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const g = globalThis as Record<string, unknown>;
  const keys = ["scrollIntoView", "scrollTo", "scrollHeight", "clientHeight"];
  const saved = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)]));
  const savedMedia = g.matchMedia;
  Object.defineProperty(proto, "scrollIntoView", { configurable: true, writable: true, value(this: HTMLElement, opts?: { block?: string }) { log.push(`${this.getAttribute("data-post")}:${opts?.block}`); } });
  Object.defineProperty(proto, "scrollTo", { configurable: true, writable: true, value(this: HTMLElement, opts?: { top?: number; behavior?: string }) { if (this.classList.contains("ox-viewport")) log.push(`end:${opts?.top}:${opts?.behavior}`); } });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 100 });
  if (reduce) g.matchMedia = (media: string) => ({ matches: media.includes("reduce"), media, addEventListener: () => undefined, removeEventListener: () => undefined });
  try {
    await fn(log);
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d);
      else delete proto[k];
    }
    g.matchMedia = savedMedia;
  }
};
/** The log without the scroller's own scrolls to the end. */
const posts = (log: string[]) => log.filter((l) => !l.startsWith("end:"));
/** The new-steps button as a reader meets it: its words, whether it is live, and whether it is inert. */
const newSteps = (root: ParentNode) => {
  const b = root.querySelector(".ox-newsteps");
  return { words: text(b), active: b?.getAttribute("data-active") ?? null, inert: b?.hasAttribute("inert") ?? null };
};
/** Two turns: the post sits in the first, which is closed by default, and the second is the last. */
const twoTurns = () => [
  started("r1", T - 10 * MIN), said("f1", "Telling the team", T - 9 * MIN), finished("r1", T - 7 * MIN),
  started("r2", T - 5 * MIN), said("f2", "Next round", T - 4 * MIN), finished("r2", T - 3 * MIN),
];
await withLayout(async (log) => {
  const { root, store, m } = await open(
    { roster: [entry("working", "on")], sessions: { [ENGINE]: session({ load: "loading", frames: twoTurns(), posts: [posted("m-1", "app/chess.js is ready", T - 8 * MIN)] }) } },
    { at: "m-1" },
  );
  const loading = posts(log);
  await m.run(() => putSession(store, (s) => ({ ...s, load: "ok" })));
  const marked = all(root, ".ox-post").map((p) => [p.getAttribute("data-post"), p.classList.contains("ox-post-hl")]);
  const turns = all(root, ".ox-work > .ox-step > [data-slot=trace-collapsible]").map((c) => c.getAttribute("data-state"));
  const arrived = posts(log);
  await m.run(() => putSession(store, (s) => ({ ...s, frames: [...s.frames, said("f3", "Arrived live", T, true)] })));
  same("6.1 arriving with at waits for the read in flight, then opens that post's turn, marks the post and scrolls it to the middle once",
    { loading, marked, turns, arrived, after: posts(log) },
    { loading: [], marked: [["m-1", true]], turns: ["open", "closed"], arrived: ["m-1:center"], after: ["m-1:center"] });
  const raised = newSteps(root);
  const before = log.length;
  await m.run(() => click(root.querySelector(".ox-newsteps")));
  same("6.2 and following stops, so a live step after it raises the new-steps button, live, whose click scrolls the work to its end",
    { raised, clicked: log.slice(before) }, { raised: { words: "1 new step", active: "true", inert: false }, clicked: ["end:900:smooth"] });
  await m.unmount();
});
await withLayout(async (log) => {
  const frames = [started("r1", T - 10 * MIN), said("f1", "Telling the team", T - 9 * MIN), finished("r1", T - 7 * MIN)];
  const { root, store, m } = await open(
    { roster: [entry("working", "on")], sessions: { [ENGINE]: session({ frames, posts: [posted("m-1", "app/chess.js is ready", T - 8 * MIN)] }) } },
    { at: "m-1" },
  );
  const arrived = posts(log);
  await m.run(() => putSession(store, (s) => ({ ...s, frames: [...s.frames, said("f3", "Arrived live", T, true)] })));
  const raised = newSteps(root);
  const before = log.length;
  await m.run(() => click(root.querySelector(".ox-newsteps")));
  same("6.3 arriving at a post already held when the page opens, a live step raises the button, live, and under reduced motion its click scrolls to the end at once",
    { arrived, raised, clicked: log.slice(before) },
    { arrived: ["m-1:center"], raised: { words: "1 new step", active: "true", inert: false }, clicked: ["end:900:auto"] });
  await m.unmount();
}, true);
{
  const { root, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ frames: [said("f1", "Hello")], posts: [posted("m-1", "A post")] }) } }, { at: "m-404" });
  ok("6.4 with no such post the page opens on Work with nothing marked", root.querySelector(".ox-post-hl") === null && text(root.querySelector(".ox-work")).includes("Hello"));
  await m.unmount();
}

// ── 7. Which steps rise in ──────────────────────────────────────────────────────────────────────
{
  const { root, store, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ more: true, frames: [said("f2", "The newest page", T)] }) } });
  // Load earlier lands: an older page from history, frames not live.
  await m.run(() => putSession(store, (s) => ({ ...s, frames: [said("f1", "An older page", T - MIN), ...s.frames] })));
  const steps = () => all(root, ".ox-work > div").filter((d) => !d.classList.contains("ox-foot"));
  same("7.1 steps a history read adds after mount carry no ui-in, nor do the steps of the first paint",
    steps().map((d) => [text(d), d.classList.contains("ui-in")]), [["An older page", false], ["The newest page", false]]);
  await m.run(() => putSession(store, (s) => ({ ...s, frames: [...s.frames, said("f3", "Arrived live", T + MIN, true)] })));
  same("7.2 a step appended live after mount carries ui-in, and the held steps still do not",
    steps().map((d) => [text(d), d.classList.contains("ui-in")]),
    [["An older page", false], ["The newest page", false], ["Arrived live", true]]);
  await m.unmount();
}
{
  // An open turn: a finished run of two already grouped, a paragraph, then two calls that run. Their
  // result markers then arrive live, and the two lines fold into a group.
  const ended = (id: string, ts: number, live = false): SessionFrame => ({
    id: `m-${id}`, ts, live, events: [{ type: "CUSTOM", name: "cotal.toolResult", value: { toolCallId: id, isError: false }, timestamp: ts }],
  });
  const { root, store, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({
    frames: [
      started("r1", T - 3 * MIN),
      called("c0", "Read", T - 2 * MIN), called("c1", "Read", T - 2 * MIN), ended("c0", T - 2 * MIN + 100), ended("c1", T - 2 * MIN + 200),
      said("p1", "Running the tests", T - MIN), called("c2", "Bash", T), called("c3", "Bash", T),
    ],
  }) } });
  const groups = () => all(root, ".ox-turn [data-slot=trace-collapsible]");
  const before = { groups: groups().length, running: all(root, ".ox-turn [data-slot=trace-line][data-status=running]").length };
  await m.run(() => putSession(store, (s) => ({ ...s, frames: [...s.frames, ended("c2", T + 1000, true), ended("c3", T + 2000, true)] })));
  same("7.3 a run of calls that ends folds into a group that fades in, and a group there at first paint does not fade",
    { before, fades: groups().map((g) => g.classList.contains("ui-xfade")), folding: all(root, ".ox-fold [data-slot=trace-line]").length },
    { before: { groups: 1, running: 1 }, fades: [false, true], folding: 1 });
  await m.unmount();
}

// ── 8. The address: where the crumb goes back to, and an old link ───────────────────────────────
const rig = (hash: string) => {
  const controller = { open: async () => undefined, openSession: () => undefined, closeSession: () => undefined } as unknown as Controller;
  const listeners = new Set<() => void>();
  const replaced: string[] = [];
  const host: RouteHost = {
    location: { hash, pathname: "/" },
    history: { replaceState: (_data, _unused, url) => { replaced.push(url); host.location.hash = url; } },
    addEventListener: (_type, l) => void listeners.add(l),
    removeEventListener: (_type, l) => void listeners.delete(l),
  };
  const start = () => ({ controller, stop: () => undefined });
  return { host, start, replaced, go: (h: string) => { host.location.hash = h; listeners.forEach((l) => l()); } };
};
{
  const crumb = (root: HTMLElement) => {
    const a = root.querySelector(".ox-head .ui-crumb");
    return { href: a?.getAttribute("href"), title: a?.getAttribute("title"), label: text(a) };
  };
  const r = rig("#/channel/team");
  const m = await mount(createElement(App, { host: r.host, start: r.start }));
  await m.run(() => r.go(`#/agent/${ENGINE}`));
  same("8.1 the crumb links back to the channel the reader came from",
    crumb(m.container), { href: "#/channel/team", title: "Back to #team", label: "#team" });
  same("8.2 the rail marks Agents current on an agent's page",
    m.container.querySelector('.ui-rail [aria-current="page"]')?.getAttribute("aria-label"), "Agents");
  await m.unmount();
  const fresh = rig(`#/agent/${ENGINE}`);
  const m2 = await mount(createElement(App, { host: fresh.host, start: fresh.start }));
  same("8.3 with no place visited the crumb goes back to Agents, and the current address is left alone",
    [crumb(m2.container), fresh.replaced], [{ href: "#/agents", title: "Back to Agents", label: "Agents" }, []]);
  await m2.unmount();
  const via = rig("#/channel/team");
  const m3 = await mount(createElement(App, { host: via.host, start: via.start }));
  await m3.run(() => via.go("#/activity"));
  await m3.run(() => via.go(`#/agent/${ENGINE}`));
  same("8.4 the crumb goes back to the last place that was not an agent's page, with its label, not to the last channel",
    crumb(m3.container), { href: "#/activity", title: "Back to Activity", label: "Activity" });
  await m3.unmount();
}
{
  const r = rig(`#/agent/${ENGINE}/m-1`);
  const m = await mount(createElement(App, { host: r.host, start: r.start }));
  same("8.5 an old link to a message is replaced in place by the new form, and opens Work",
    [r.replaced, text(m.container.querySelector("[role=tab][aria-selected=true]"))], [[`#/agent/${ENGINE}/work/m-1`], "Work"]);
  await m.unmount();
}
{
  location.hash = "";
  const r = rig(`#/agent/${ENGINE}`);
  const m = await mount(createElement(App, { host: r.host, start: r.start }));
  await m.run(() => press(all(m.container, "[role=tab]").find((t) => text(t).startsWith("Messages"))));
  same("8.6 inside App a tab change writes the address App was given, not the page's own",
    [r.host.location.hash, location.hash], [`#/agent/${ENGINE}/messages`, ""]);
  await m.unmount();
}

// ── 9. The Agent tab holds the agent's work only while it shows ─────────────────────────────────
{
  // The shipped shell on #team, wide, with the panel open: engine's verified post gives the reader
  // its name to pick. Picking opens the Agent tab, and the tab holds engine's work while it shows.
  localStorage.clear();
  const f = fake();
  const store = seed({
    connection: "connected",
    roster: [entry("working", "on")],
    channels: [{ channel: "team", messages: 1 }],
    open: { channel: "team", messages: [posted("m-1", "app/chess.js is ready")] },
  } as Partial<DashboardState>);
  const m = await mount(createElement(Shell, { store, controller: f.ctl, route: { view: "channel", channel: "team" }, paneOpen: true, msgPerSecond: () => 0, clock: () => T }));
  const sessionCalls = () => f.calls.filter((c) => /^(open|close)Session\(/.test(c));
  const before = sessionCalls();
  await m.run(() => click(all(m.container, "main .ui-msg .ui-mh button.ui-who").find((b) => text(b) === "engine")));
  const picked = sessionCalls();
  await m.run(() => click(m.container.querySelector("section.ui-pane button[aria-label='Close panel']")));
  same("9.1 picking an agent opens its work once with the Agent tab, and closing the panel closes it, so a closed panel holds nothing",
    { before, picked, closed: sessionCalls(), pane: m.container.querySelector("section.ui-pane") === null },
    { before: [], picked: [`openSession("${ENGINE}")`], closed: [`openSession("${ENGINE}")`, `closeSession("${ENGINE}")`], pane: true });
  await m.run(() => click(m.container.querySelector("header button[title='Toggle panel']")));
  const reopened = sessionCalls();
  await m.run(() => click(all(m.container, "section.ui-pane [role=tab]").find((t) => text(t) === "Members")));
  same("9.2 the panel opened again on the Agent tab reads the work again, and moving to another tab closes it",
    { reopened, members: sessionCalls() },
    {
      reopened: [`openSession("${ENGINE}")`, `closeSession("${ENGINE}")`, `openSession("${ENGINE}")`],
      members: [`openSession("${ENGINE}")`, `closeSession("${ENGINE}")`, `openSession("${ENGINE}")`, `closeSession("${ENGINE}")`],
    });
  await m.unmount();
  localStorage.clear();
}

console.log(`session-view: ${n} checks passed`);
await closeDom();
