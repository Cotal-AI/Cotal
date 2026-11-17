/** Dark mode and the phone layout (mock sections E and F). The theme: the Settings menu offers
 *  System, Light and Dark, and each choice is applied at once and kept for the next load (the boot
 *  script and the built stylesheet's color-scheme are smoke:web-client-build's). The phone, below
 *  768px: a bottom tab bar in place of the rail, with the waiting count on Agents; the panel, closed
 *  until asked for, then a modal sheet, handing focus back to its opener; and the places sheet behind
 *  the header's sidebar button, which holds focus and closes on Escape, on the overlay and on a new
 *  route. The app is mounted in jsdom with a window width and a `matchMedia` the suite controls and a
 *  fake dashboard that seeds the store; each cell reads the DOM React wrote, by role and name. Menus,
 *  sheets and tooltips are drawn in a portal on the page's body, so those cells read the document.
 *  The palette's colours and the phone's geometry are CSS only and are left to the browser check. */
import { closeDom, dom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { createElement } from "react";
import type { RosterEntry } from "../client/src/api/types.js";
import { App } from "../client/src/App.tsx";
import { formatRoute } from "../client/src/lib/route.js";
import type { RouteHost } from "../client/src/routeWatch.js";
import type { Controller } from "../client/src/state/controller.js";
import type { Store } from "../client/src/state/store.js";
import { initialState, type DashboardState } from "../client/src/state/types.js";
import { PANEL_KEY } from "../client/src/ui/panel/RightPanel.tsx";
import { mount, type Mounted } from "./mount.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const same = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });
const textOf = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const key = (target: EventTarget, k: string, shiftKey = false) =>
  target.dispatchEvent(new (dom.window.KeyboardEvent as typeof KeyboardEvent)("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }));
const root = document.documentElement;

// ── The page's width, as the suite says ──────────────────────────────────────────────────────────
// shadcn's useIsMobile reads the window's width and listens on a width query for changes.
let phoneNow = false;
let darkNow = false;
const watchers = new Set<() => void>();
const schemeWatchers = new Set<() => void>();
const asked: string[] = [];
Object.defineProperty(window, "innerWidth", { configurable: true, get: () => (phoneNow ? 390 : 1440) });
(window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => {
  asked.push(q);
  const scheme = q === "(prefers-color-scheme: dark)";
  const heard = scheme ? schemeWatchers : watchers;
  return { get matches() { return scheme ? darkNow : phoneNow; }, media: q, addEventListener: (_t: string, l: () => void) => heard.add(l), removeEventListener: (_t: string, l: () => void) => heard.delete(l) };
};
/** Let the timers Radix sets run: as a layer opens, so it hears a press outside, and as it closes,
 *  since it gives focus back from a timeout. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
/** The text of the Tooltip open on the page, if any. */
const tooltip = () => textOf(document.querySelector('[role="tooltip"]'));
/** The elements `el`'s aria-describedby names, read as text. */
const description = (el: Element | null | undefined) =>
  (el?.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => textOf(document.getElementById(id))).join(" ");

// ── The app, over a fake dashboard that seeds the store ──────────────────────────────────────────
const entry = (id: string, name: string, status: RosterEntry["status"]): RosterEntry =>
  ({ card: { id, name, kind: "agent", role: "reviewer", meta: { connector: "codex" } }, status, ts: 1 }) as RosterEntry;
const seed: Partial<DashboardState> = {
  ...structuredClone(initialState),
  space: "main",
  roster: [entry("local.rev", "reviewer", "working"), entry("local.rv2", "reviewer_2", "waiting"), entry("local.pln", "planner", "waiting")],
  channels: [{ channel: "review", messages: 1 }],
};
const listeners = new Set<() => void>();
const host: RouteHost = {
  location: { hash: "#/channel/review", pathname: "/" },
  history: { replaceState: () => undefined },
  addEventListener: (_t, l) => void listeners.add(l),
  removeEventListener: (_t, l) => void listeners.delete(l),
};
const go = (hash: string) => {
  host.location.hash = hash;
  listeners.forEach((l) => l());
};
const controller = { open: async () => undefined, openSession: () => undefined, closeSession: () => undefined } as unknown as Controller;
let patch: Partial<DashboardState> = seed;
const start = (s: Store<DashboardState>) => {
  s.set(patch);
  return { controller, stop: () => undefined };
};
const app = (hash: string) => {
  host.location.hash = hash;
  return mount(createElement(App, { host, start }));
};

// ── 1. The theme ─────────────────────────────────────────────────────────────────────────────────
// The saved choice reaches the root element before the first paint through the classic boot script,
// which smoke:web-client-build runs from the build. These cells cover the Settings menu that changes it.
/** The rail's Settings button, by its name. */
const settingsIn = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('[role="navigation"][aria-label="Views"] button')).find((b) => textOf(b) === "Settings") as HTMLButtonElement;
/** Open a menu button from the keyboard, as Enter on the focused button does. */
const openWithKeys = (el: HTMLElement) => {
  el.focus();
  key(el, "Enter");
};
{
  const m = await app("#/activity");
  const settings = () => settingsIn(m.container);
  const menu = () => document.querySelector("[role=menu]");
  const items = () => Array.from(menu()?.querySelectorAll("[role=menuitemradio]") ?? []) as HTMLElement[];
  const checked = () => items().filter((i) => i.getAttribute("aria-checked") === "true").map(textOf);
  const groupName = () => textOf(document.getElementById(menu()?.querySelector("[role=group]")?.getAttribute("aria-labelledby") ?? ""));
  ok("1.1 Settings is live in the app and its menu starts closed", !settings().disabled && settings().getAttribute("aria-expanded") === "false" && menu() === null);
  await m.run(() => openWithKeys(settings()));
  same("1.2 it opens a menu whose Theme group offers System, Light and Dark, the current choice checked",
    [groupName(), items().map(textOf), checked(), settings().getAttribute("aria-expanded")], ["Theme", ["System", "Light", "Dark"], ["System"], "true"]);
  ok("1.3 focus moves to the first item, which is the checked one, and the checked item carries a tick, not colour alone",
    document.activeElement === items()[0] && items()[0].querySelector("svg") !== null && items()[1].querySelector("svg") === null, textOf(document.activeElement));
  // Radix moves focus between a menu's items on the next task, so each key waits for it.
  const arrow = async (k: string) => {
    await m.run(() => key(document.activeElement!, k));
    await m.run(tick);
  };
  await arrow("ArrowDown");
  ok("1.4 Down moves to the next item", document.activeElement === items()[1], textOf(document.activeElement));
  await arrow("ArrowUp");
  await arrow("ArrowUp");
  ok("1.5 and Up wraps from the first to the last", document.activeElement === items()[2], textOf(document.activeElement));
  const cycle: string[][] = [];
  for (const choice of ["Dark", "Light", "System"]) {
    if (menu() === null) await m.run(() => openWithKeys(settings()));
    await m.run(() => items().find((i) => textOf(i) === choice)!.click());
    await m.run(tick);
    cycle.push([choice, root.className, localStorage.getItem("cotal.theme") ?? "", String(menu() === null), String(document.activeElement === settings())]);
  }
  same("1.6 each choice in turn is applied to the root element at once, saved for the next load, and closes the menu with focus back on Settings",
    cycle, [["Dark", "dark", "dark", "true", "true"], ["Light", "light", "light", "true", "true"], ["System", "light", "system", "true", "true"]]);
  const follows: string[] = [];
  for (const dark of [true, false]) {
    darkNow = dark;
    await m.run(() => schemeWatchers.forEach((l) => l()));
    follows.push(root.className);
  }
  same("1.6b while System is chosen the root element follows the OS setting as it changes", follows, ["dark", "light"]);
  await m.run(() => openWithKeys(settings()));
  await m.run(() => items().find((i) => textOf(i) === "Dark")!.click());
  await m.unmount();
  const again = await app("#/activity");
  await again.run(() => openWithKeys(settingsIn(again.container)));
  same("1.7 a new load reads the saved choice: Dark is the checked item",
    Array.from(document.querySelectorAll("[role=menuitemradio][aria-checked=true]")).map(textOf), ["Dark"]);
  await again.run(() => key(document.activeElement!, "Escape"));
  await again.run(tick);
  ok("1.8 Escape closes the menu and puts focus back on Settings",
    document.querySelector("[role=menu]") === null && document.activeElement === settingsIn(again.container));
  await again.run(() => openWithKeys(settingsIn(again.container)));
  await again.run(tick);
  await again.run(() => document.body.dispatchEvent(new (dom.window.Event as typeof Event)("pointerdown", { bubbles: true })));
  ok("1.9 a press outside the menu closes it", document.querySelector("[role=menu]") === null);
  await again.unmount();
  localStorage.removeItem("cotal.theme");
}

// ── 2. The phone: the tab bar ────────────────────────────────────────────────────────────────────
phoneNow = true;
localStorage.setItem(PANEL_KEY, "1");
let m: Mounted = await app("#/channel/review");
{
  ok("2.1 the app asks the window whether it is phone width, below 768px", asked.includes("(max-width: 767px)") && window.innerWidth < 768, asked);
  const main = m.container.querySelector("main");
  const tabbar = m.container.querySelector('nav[aria-label="Sections"]');
  ok("2.2 on a phone there is no rail and no sidebar column: the centre sits over the tab bar",
    m.container.querySelector('[role="navigation"][aria-label="Views"]') === null && document.querySelector('[role="complementary"][aria-label="Space"]') === null
      && main !== null && tabbar !== null && main.nextElementSibling === tabbar, main?.parentElement?.innerHTML.slice(0, 200));
  /** A tab's own word, which is the tab's text outside its icon, count and descriptions. */
  const word = (t: Element) => Array.from(t.childNodes).filter((c) => c.nodeType === 3).map((c) => c.textContent).join("").trim();
  const tabs = () => Array.from(tabbar?.children ?? []).map((t) => {
    const count = Array.from(t.querySelectorAll('[aria-hidden="true"]')).map(textOf).filter(Boolean).join("");
    const holder = t.querySelector('[aria-hidden="true"]:not(svg)')?.parentElement;
    return {
      text: word(t),
      current: t.getAttribute("aria-current"),
      href: t.getAttribute("href"),
      count,
      said: count && holder ? textOf(holder).replace(count, "") : null,
    };
  });
  same("2.3 the tab bar holds Channels, DMs, Agents and Activity, Agents carrying the count of agents waiting, said in words to a screen reader, and the open channel's tab is current",
    tabs().map((t) => [t.text, t.current, t.count, t.said]),
    [["Channels", "page", "", null], ["DMs", null, "", null], ["Agents", null, "2", "2 agents waiting"], ["Activity", null, "", null]]);
  same("2.4 each tab leads where the rail would", tabs().map((t) => t.href), [formatRoute({ view: "channel", channel: "review" }), null, "#/agents", "#/activity"]);
  const dms = tabbar!.children[1] as HTMLElement;
  const said = description(dms);
  await m.run(() => dms.focus());
  same("2.5 a tab with nowhere to go is a disabled button named by its word and described by the empty state, which its Tooltip shows",
    [dms.tagName.toLowerCase(), dms.getAttribute("aria-label") ?? dms.textContent, dms.getAttribute("aria-disabled"), said, tooltip()],
    ["button", "DMs", "true", "No direct messages yet.", "No direct messages yet."]);
  await m.run(() => dms.blur());
  await m.run(() => go("#/needs"));
  same("2.6 the Needs route draws the Agents view, so Agents is the current tab", tabs().filter((t) => t.current === "page").map((t) => t.text), ["Agents"]);
  await m.run(() => go("#/channel/review"));
}

// A keyboard reader presses the button it has focused, which is what a trap hands focus back to.
const press = (el: HTMLElement | null) => {
  el?.focus();
  el?.click();
};

// ── 3. The phone: the panel, a sheet ─────────────────────────────────────────────────────────────
{
  /** The open dialog named `name`, if any. */
  const dialog = (name: string) => Array.from(document.querySelectorAll("[role=dialog]"))
    .find((d) => textOf(document.getElementById(d.getAttribute("aria-labelledby") ?? "")) === name) as HTMLElement | undefined;
  const pane = () => dialog("Details");
  const stack = () => Array.from(m.container.querySelectorAll("main header button")).find((b) => /^\d+ members?$/.test(b.getAttribute("aria-label") ?? "")) as HTMLElement | undefined ?? null;
  ok("3.1 the panel starts closed on a phone, though the wide layout's saved choice is open", pane() === undefined && localStorage.getItem(PANEL_KEY) === "1");
  await m.run(() => press(stack()));
  ok("3.2 the member stack opens it as a dialog named Details, on its Members tab",
    pane() !== undefined && textOf(pane()?.querySelector("[role=tab][aria-selected=true]")) === "Members", pane()?.outerHTML.slice(0, 200));
  ok("3.3 focus moves into it", pane()?.contains(document.activeElement) === true, textOf(document.activeElement));
  await m.run(() => key(document.activeElement!, "Escape"));
  await m.run(tick);
  ok("3.4 Escape closes it, and the wide layout's saved choice is untouched", pane() === undefined && localStorage.getItem(PANEL_KEY) === "1");
  ok("3.5 and focus goes back to the member stack that opened it", stack() !== null && document.activeElement === stack(), textOf(document.activeElement));
  const panelButton = () => m.container.querySelector('main header button[aria-label="Open agent panel"]') as HTMLElement | null;
  await m.run(() => panelButton()?.focus());
  const tip = tooltip();
  await m.run(() => panelButton()?.click());
  ok("3.6 the header's panel button, named Open agent panel as in mock F with a Tooltip that says so, opens it too",
    tip === "Open agent panel" && pane() !== undefined, { tip, button: panelButton()?.outerHTML.slice(0, 160) });
  await m.run(() => (pane()?.querySelector('[aria-label="Close panel"]') as HTMLElement | null)?.click());
  ok("3.7 and its close button closes it, again without saving", pane() === undefined && localStorage.getItem(PANEL_KEY) === "1");
  await m.run(() => press(stack()));
  await m.run(() => go("#/channel/general"));
  ok("3.8 a new route closes it, even another channel that has a panel to show", pane() === undefined && textOf(m.container.querySelector("main header h1")) === "# general");
  await m.run(() => go("#/channel/review"));
}

// ── 4. The phone: the places sheet ───────────────────────────────────────────────────────────────
{
  const menuButton = () => m.container.querySelector('main header [data-sidebar="trigger"]') as HTMLButtonElement | null;
  const sheet = () => document.querySelector('[role=dialog][data-sidebar="sidebar"]') as HTMLElement | null;
  ok("4.1 the header opens with the sidebar button, named Open sidebar, and the sheet starts closed",
    menuButton()?.getAttribute("aria-label") === "Open sidebar" && menuButton()!.getAttribute("aria-haspopup") === "dialog" && menuButton()!.getAttribute("aria-expanded") === "false"
      && sheet() === null && m.container.querySelector("main header")?.firstElementChild === menuButton());
  await m.run(() => press(menuButton()));
  ok("4.2 the sidebar button opens the places sheet, a dialog holding the places",
    sheet() !== null && sheet()?.querySelector("[aria-label=Places]") !== null && menuButton()!.getAttribute("aria-expanded") === "true", sheet()?.outerHTML.slice(0, 160));
  ok("4.3 focus moves into the sheet", sheet()?.contains(document.activeElement) === true, textOf(document.activeElement));
  const focusables = () => Array.from(sheet()!.querySelectorAll("a[href], button:not([disabled]), [tabindex]:not([tabindex='-1'])")) as HTMLElement[];
  await m.run(() => focusables().at(-1)!.focus());
  await m.run(() => key(document.activeElement!, "Tab"));
  ok("4.4 Tab from the sheet's last control wraps to its first: focus stays in the sheet", document.activeElement === focusables()[0], textOf(document.activeElement));
  await m.run(() => key(document.activeElement!, "Tab", true));
  ok("4.5 and Shift Tab from the first wraps to the last", document.activeElement === focusables().at(-1), textOf(document.activeElement));
  await m.run(() => key(document.activeElement!, "Escape"));
  await m.run(tick);
  ok("4.6 Escape closes the sheet and puts focus back on the sidebar button", sheet() === null && document.activeElement === menuButton());
  await m.run(() => press(menuButton()));
  await m.run(tick);
  await m.run(() => document.querySelector('[data-slot="sheet-overlay"]')!.dispatchEvent(new (dom.window.Event as typeof Event)("pointerdown", { bubbles: true })));
  ok("4.7 a press on the overlay closes it", sheet() === null);
  await m.run(() => press(menuButton()));
  await m.run(() => go("#/activity"));
  await m.run(() => go("#/channel/review"));
  ok("4.8 a new route, as following a place does, closes it", sheet() === null && menuButton()?.getAttribute("aria-expanded") === "false");
}

// ── 5. Back to the wide layout ───────────────────────────────────────────────────────────────────
{
  await m.run(() => {
    phoneNow = false;
    watchers.forEach((l) => l());
  });
  ok("5.1 when the window widens past 768px the rail, the sidebar and the saved panel come back, and the tab bar goes and the sidebar button collapses the sidebar instead",
    m.container.querySelector('[role="navigation"][aria-label="Views"]') !== null && m.container.querySelector('[role="complementary"][aria-label="Space"]') !== null
      && m.container.querySelector('section[aria-label="Details"]') !== null && document.querySelector("[role=dialog]") === null
      && m.container.querySelector('nav[aria-label="Sections"]') === null
      && m.container.querySelector('main header [data-sidebar="trigger"]')?.getAttribute("aria-label") === "Toggle sidebar");
  await m.unmount();
  ok("5.2 unmounting stops watching the width", watchers.size === 0, watchers.size);
}

patch = seed;
localStorage.clear();
await closeDom();
console.log(`layout: ${n} checks passed`);
