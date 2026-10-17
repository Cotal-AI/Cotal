/** The session view at `#/agent/<id>` (agents mock S3, C, D and G), mounted in jsdom over a store
 *  seeded through `Partial<DashboardState>` and a fake controller that records what it is asked.
 *
 *  Section 1 pairs `openSession` with `closeSession`. Section 2 renders every state's words. Section 3
 *  is the plane note, section 4 Load earlier and the cap, section 5 the composer, section 6 the Live
 *  chip, section 7 the arrival at a message, and section 8 which steps rise or fade in. Section 9
 *  mounts `App` with a fake address to read where the crumb goes back to.
 *
 *  The DOM is jsdom, installed first: the prose renders through `lib/md.ts`, whose sanitizer needs a
 *  window, and React's client reads `window` when it loads. */
import { closeDom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { createElement } from "react";
import type { CotalMessage, RosterEntry } from "../client/src/api/types.js";
import { App } from "../client/src/App.tsx";
import type { SessionFrame } from "../client/src/lib/session.js";
import type { RouteHost } from "../client/src/routeWatch.js";
import type { Controller } from "../client/src/state/controller.js";
import { createStore, type Store } from "../client/src/state/store.js";
import { initialState, type DashboardState, type SessionState, type StoredMessage } from "../client/src/state/types.js";
import { Compose } from "../client/src/ui/Composer.tsx";
import { SessionView } from "../client/src/ui/views/SessionView.tsx";
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
/** Type into a React-controlled textarea: set the value through the prototype, then fire input. */
const type = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")!.set!.call(el, value);
  el.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
};

const ENGINE = "local.engine";
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
/** engine's own verified post on #team. */
const posted = (id: string, body: string, ts = T): StoredMessage => ({
  msg: { id, ts, space: "main", from: { id: ENGINE, name: "engine" }, channel: "team", parts: [{ kind: "text", text: body }] } as unknown as CotalMessage,
  senderId: ENGINE,
});

const TEAM = { label: "#team", route: { view: "channel", channel: "team" } } as const;
/** The view for engine, with the fake controller as the composer's too. */
const view = (store: Store<DashboardState>, ctl: Controller, at?: string) =>
  createElement(Compose.Provider, { value: ctl }, createElement(SessionView, { store, controller: ctl, id: ENGINE, back: TEAM, ...(at === undefined ? {} : { at }) }));
/** Mount the view over `patch` and hand back its root, the recorder and the store. */
const open = async (patch: Partial<DashboardState>, at?: string) => {
  const f = fake();
  const store = seed(patch);
  const m = await mount(view(store, f.ctl, at));
  return { f, store, m, root: m.container };
};
/** Replace engine's session in the store, as the controller would. */
const putSession = (store: Store<DashboardState>, edit: (s: SessionState) => SessionState) =>
  store.set((st) => ({ sessions: { ...st.sessions, [ENGINE]: edit(st.sessions[ENGINE]!) } }));

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

// ── 2. The states ───────────────────────────────────────────────────────────────────────────────
{
  const { root, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ load: "loading" }) } });
  const busy = root.querySelector('.ui-col[aria-busy="true"]');
  ok("2.1 loading draws the skeleton rows, busy, under the real header",
    busy !== null && all(busy, ".ui-skel").length === 8 && text(root.querySelector(".ui-bar h1")) === "engine" && root.querySelector(".ui-sess") === null,
    root.innerHTML.slice(0, 400));
  await m.unmount();
}
{
  const reason = "permissions violation for subscription to <b>events.mohamed.lead</b>";
  const grant = "cotal actor grant <reader> --owner mohamed --scope '' --allow-subscribe 'events.mohamed.lead' --allow-publish ''";
  const { root, m } = await open({ roster: [entry("idle", "on")], sessions: { [ENGINE]: session({ load: "refused", reason, grant }) } });
  const empty = root.querySelector(".ui-sess-empty");
  const paras = all(empty ?? root, "p").map(text);
  same("2.2 refused names the session, quotes the broker's reason as text and offers the grant to copy",
    {
      title: text(empty?.querySelector("b")),
      paras,
      markup: (empty?.querySelectorAll("p b").length ?? -1),
      grant: text(empty?.querySelector(".ui-cmd code")),
      live: root.querySelector(".ui-livechip") !== null,
    },
    {
      title: "This dashboard can't read engine's session",
      paras: [`The broker refused it: ${reason}.`, "The mesh owner can grant a read on that channel:"],
      markup: 0,
      grant,
      live: false,
    });
  await m.unmount();
}
{
  const { root, f, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ load: "failed", reason: "engine events refused with HTTP 502" }) } });
  const empty = root.querySelector(".ui-sess-empty");
  const retry = all(root, "button").find((b) => text(b) === "Try again");
  await m.run(() => click(retry));
  same("2.3 failed with nothing held says the session didn't load, gives the reason, and Try again reloads it",
    { title: text(empty?.querySelector("b")), reason: text(empty?.querySelector("p")), calls: f.named("reloadSession") },
    { title: "engine's session didn't load", reason: "engine events refused with HTTP 502", calls: [`reloadSession("${ENGINE}")`] });
  await m.unmount();
}
{
  const { root, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ load: "failed", reason: "boom", frames: [said("f1", "Hello from before")] }) } });
  const col = root.querySelector(".ui-scroll .ui-col");
  const kids = [...(col?.children ?? [])] as HTMLElement[];
  const line = kids.findIndex((k) => k.classList.contains("ui-plane") && text(k).startsWith("engine's session didn't load"));
  const list = kids.findIndex((k) => k.classList.contains("ui-sess"));
  ok("2.4 failed with frames held keeps the list and says it didn't load above it",
    line !== -1 && list > line && text(kids[list]).includes("Hello from before") && root.querySelector(".ui-sess-empty") === null,
    { line, list, html: col?.innerHTML.slice(0, 300) });
  await m.unmount();
}
{
  const { root, m } = await open({ roster: [entry("idle", "off")], sessions: { [ENGINE]: session({ posts: [posted("m-1", "Plan: two-player chess")] }) } });
  const notes = all(root, ".ui-plane").map(text);
  same("2.5 with the plane off the view says so and shows only the agent's posts",
    { notes, post: text(root.querySelector(".ui-post .ui-post-h span")), body: text(root.querySelector(".ui-post .ui-tx")) },
    { notes: ["engine publishes no session events, so this view shows only what engine posted."], post: "Posted in #team", body: "Plan: two-player chess" });
  await m.unmount();
}
{
  const { root, m } = await open({ roster: [entry("idle", "on")], sessions: { [ENGINE]: session() } });
  const empty = root.querySelector(".ui-sess-empty");
  same("2.6 with the plane on and no steps it says no turns yet",
    { title: text(empty?.querySelector("b")), p: text(empty?.querySelector("p")) },
    { title: "No turns yet", p: "engine's first turn shows here as soon as it starts." });
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
      && text(root.querySelector(".ui-sess")).includes("Held while it reloads") && text(root.querySelector('[role="status"]')) === "Loading",
    root.innerHTML.slice(0, 400));
  await m.unmount();
}

// ── 3. The plane note ───────────────────────────────────────────────────────────────────────────
{
  const on = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ frames: [said("f1", "Hello")] }) } });
  const onNote = text(on.root.querySelector(".ui-plane"));
  await on.m.unmount();
  const unknown = await open({ roster: [entry("working")], sessions: { [ENGINE]: session({ frames: [said("f1", "Hello")] }) } });
  const unknownNotes = all(unknown.root, ".ui-plane").length;
  const unknownList = text(unknown.root.querySelector(".ui-sess")).includes("Hello");
  await unknown.m.unmount();
  same("3.1 the plane note shows for on and not for unknown",
    { onNote, unknownNotes, unknownList },
    {
      onNote: "What engine publishes on its event plane: its text, the names of the tools it calls, and where each turn starts and ends. It doesn't publish tool inputs, tool results or reasoning.",
      unknownNotes: 0,
      unknownList: true,
    });
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

// ── 5. The composer ─────────────────────────────────────────────────────────────────────────────
{
  const { root, f, m } = await open({ roster: [entry("working", "on")], post: { mode: "participant" }, sessions: { [ENGINE]: session() } });
  const box = root.querySelector(".ui-dock textarea") as HTMLTextAreaElement | null;
  const mode = text(root.querySelector(".ui-dock .ui-crow"));
  await m.run(() => box && type(box, "hi"));
  same("5.1 the composer is engine's direct message composer",
    { placeholder: box?.getAttribute("placeholder"), mode: mode.includes("to engine · direct message"), draft: f.named("draft") },
    { placeholder: "Message engine", mode: true, draft: [`draft({"kind":"dm","to":"${ENGINE}"},"hi")`] });
  await m.unmount();
}
{
  const { root, m } = await open({ roster: [entry("working", "on")], post: { mode: "off", reason: "Posting is off on this mesh." }, sessions: { [ENGINE]: session() } });
  const card = root.querySelector(".ui-dock .ui-composer");
  ok("5.2 with posting off the dock holds the read-only composer, as the DM view does",
    card?.getAttribute("aria-disabled") === "true" && root.querySelector(".ui-dock textarea") === null && text(card).includes("Posting is off on this mesh."),
    card?.outerHTML.slice(0, 300));
  await m.unmount();
}

// ── 6. The Live chip ────────────────────────────────────────────────────────────────────────────
{
  const off = await open({ connection: "connected", roster: [entry("offline", "on")], sessions: { [ENGINE]: session({ frames: [said("f1", "Hello")] }) } });
  const offline = off.root.querySelector(".ui-livechip") !== null;
  await off.m.unmount();
  const on = await open({ connection: "connected", roster: [entry("working", "on")], sessions: { [ENGINE]: session({ frames: [said("f1", "Hello")] }) } });
  const working = text(on.root.querySelector(".ui-bar .ui-livechip"));
  await on.m.unmount();
  same("6.1 Live is absent for an offline agent, and shown for a working one", { offline, working }, { offline: false, working: "Live" });
}
{
  // The same working agent and the same good read, with the feed down: no new step can arrive.
  const seen: [string, boolean][] = [];
  for (const connection of ["reconnecting", "closed", "connecting"] as const) {
    const v = await open({ connection, roster: [entry("working", "on")], sessions: { [ENGINE]: session({ frames: [said("f1", "Hello")] }) } });
    seen.push([connection, v.root.querySelector(".ui-livechip") !== null]);
    await v.m.unmount();
  }
  same("6.2 Live is absent while the feed is down, though the read went through and the agent is working",
    seen, [["reconnecting", false], ["closed", false], ["connecting", false]]);
}

// ── 7. Arriving at a message ────────────────────────────────────────────────────────────────────
{
  const { root, m } = await open(
    { roster: [entry("working", "on")], sessions: { [ENGINE]: session({ frames: [said("f1", "Telling the team", T - MIN)], posts: [posted("m-1", "app/chess.js is ready"), posted("m-2", "Later", T + MIN)] }) } },
    "m-1",
  );
  same("7.1 with at naming a held post, that post is marked and no other",
    all(root, ".ui-post").map((p) => [p.getAttribute("data-post"), p.classList.contains("ui-post-hl")]),
    [["m-1", true], ["m-2", false]]);
  await m.unmount();
}

{
  // jsdom has no layout, so the scroll box reports a fixed height and every scroll is logged: a
  // write of scrollTop on the list (the pin taking the view to the bottom) and a scrollIntoView.
  const log: string[] = [];
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const keys = ["scrollIntoView", "scrollTop", "scrollHeight", "clientHeight"];
  const saved = new Map(keys.map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)]));
  Object.defineProperty(proto, "scrollIntoView", { configurable: true, writable: true, value(this: HTMLElement) { log.push(`into:${this.getAttribute("data-post")}`); } });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 1000 });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 100 });
  Object.defineProperty(proto, "scrollTop", { configurable: true, get: () => 0, set(this: HTMLElement, v: number) { if (this.classList.contains("ui-scroll")) log.push(`top:${v}`); } });
  try {
    const { root, store, m } = await open(
      { roster: [entry("working", "on")], sessions: { [ENGINE]: session({ load: "loading", posts: [posted("m-1", "app/chess.js is ready"), posted("m-2", "Later", T + MIN)] }) } },
      "m-1",
    );
    const loading = [...log];
    // The history read lands, then a step arrives live.
    await m.run(() => putSession(store, (s) => ({ ...s, load: "ok", frames: [said("f1", "Telling the team", T - MIN)] })));
    await m.run(() => putSession(store, (s) => ({ ...s, frames: [...s.frames, said("f2", "Arrived live", T + 2 * MIN, true)] })));
    same("7.2 arriving while the read is in flight waits for it, scrolls to the post after the pin, and stops following",
      { loading, after: log, jump: text(root.querySelector(".ui-bar .ui-jump")) },
      { loading: ["top:1000"], after: ["top:1000", "top:1000", "into:m-1"], jump: "1 new step" });
    await m.unmount();
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(proto, k, d);
      else delete proto[k];
    }
  }
}

// ── 8. Which steps rise in ──────────────────────────────────────────────────────────────────────
{
  const { root, store, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({ more: true, frames: [said("f2", "The newest page", T)] }) } });
  // Load earlier lands: an older page from history, frames not live.
  await m.run(() => putSession(store, (s) => ({ ...s, frames: [said("f1", "An older page", T - MIN), ...s.frames] })));
  const steps = () => all(root, ".ui-sess > div").filter((d) => !d.classList.contains("ui-sess-foot"));
  const history = steps().map((d) => [text(d), d.classList.contains("ui-in")]);
  same("8.1 steps a history read adds after mount carry no ui-in, nor do the steps of the first paint",
    history, [["An older page", false], ["The newest page", false]]);
  await m.run(() => putSession(store, (s) => ({ ...s, frames: [...s.frames, said("f3", "Arrived live", T + MIN, true)] })));
  same("8.2 a step appended live after mount carries ui-in, and the held steps still do not",
    steps().map((d) => [text(d), d.classList.contains("ui-in")]),
    [["An older page", false], ["The newest page", false], ["Arrived live", true]]);
  await m.unmount();
}
{
  // A group of two already there, a paragraph, then one call; a second call then joins that one.
  const { root, store, m } = await open({ roster: [entry("working", "on")], sessions: { [ENGINE]: session({
    frames: [called("c0", "Read", T - 2 * MIN), called("c1", "Read", T - 2 * MIN), said("p1", "Running the tests", T - MIN), called("c2", "Bash", T)],
  }) } });
  const before = { groups: all(root, ".ui-tg").length, row: text(root.querySelector(".ui-sess > div > .ui-tc-line code")) };
  await m.run(() => putSession(store, (s) => ({ ...s, frames: [...s.frames, called("c3", "cotal_inbox", T + MIN, true)] })));
  same("8.3 a call that joins a single one fades the new group in, and a group there at first paint does not fade",
    { before, fades: all(root, ".ui-tg").map((g) => g.classList.contains("ui-xfade")) },
    { before: { groups: 1, row: "Bash" }, fades: [false, true] });
  await m.unmount();
}

// ── 9. Where the crumb goes back to ──────────────────────────────────────────────────────────────
{
  const rig = (hash: string) => {
    const controller = { open: async () => undefined, openSession: () => undefined, closeSession: () => undefined } as unknown as Controller;
    const listeners = new Set<() => void>();
    const host: RouteHost = {
      location: { hash, pathname: "/" },
      addEventListener: (_type, l) => void listeners.add(l),
      removeEventListener: (_type, l) => void listeners.delete(l),
    };
    const start = () => ({ controller, stop: () => undefined });
    return { host, start, go: (h: string) => { host.location.hash = h; listeners.forEach((l) => l()); } };
  };
  const crumb = (root: HTMLElement) => {
    const a = root.querySelector(".ui-bar .ui-crumb");
    return { href: a?.getAttribute("href"), title: a?.getAttribute("title"), label: text(a) };
  };
  const r = rig("#/channel/team");
  const m = await mount(createElement(App, { host: r.host, start: r.start }));
  await m.run(() => r.go(`#/agent/${ENGINE}`));
  same("9.1 the crumb links back to the channel the reader came from",
    crumb(m.container), { href: "#/channel/team", title: "Back to #team", label: "#team" });
  same("9.2 the rail marks Agents current on an agent's session",
    m.container.querySelector('.ui-rail [aria-current="page"]')?.getAttribute("aria-label"), "Agents");
  await m.unmount();
  const fresh = rig(`#/agent/${ENGINE}`);
  const m2 = await mount(createElement(App, { host: fresh.host, start: fresh.start }));
  same("9.3 with no channel visited the crumb goes back to Agents",
    crumb(m2.container), { href: "#/agents", title: "Back to Agents", label: "Agents" });
  await m2.unmount();
  const via = rig("#/channel/team");
  const m3 = await mount(createElement(App, { host: via.host, start: via.start }));
  await m3.run(() => via.go("#/activity"));
  await m3.run(() => via.go(`#/agent/${ENGINE}`));
  same("9.4 the crumb goes back to the last place that was not a session, with its label, not to the last channel",
    crumb(m3.container), { href: "#/activity", title: "Back to Activity", label: "Activity" });
  await m3.unmount();
}

console.log(`session-view: ${n} checks passed`);
await closeDom();
