/** Dark mode and the phone layout (mock sections E and F). The theme: the Settings menu offers
 *  System, Light and Dark, and each choice is applied at once and kept for the next load (the boot
 *  script and the built stylesheet's color-scheme are smoke:web-client-build's). The phone, below
 *  768px: a bottom tab bar in place of the rail, with the waiting count on Agents; the panel, closed
 *  until asked for, then full screen and modal, handing focus back to its opener; and the places
 *  sheet behind the channel header's menu button, which holds focus and closes on Escape, on the
 *  scrim and on a new route. The app is mounted in jsdom with a `matchMedia` the suite controls and a fake
 *  dashboard that seeds the store; each cell reads the DOM React wrote. The palette's colours and the
 *  phone's geometry are CSS only and are left to the browser check. */
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
import { PHONE_QUERY } from "../client/src/viewport.ts";
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
let phoneNow = false;
const watchers = new Set<() => void>();
const asked: string[] = [];
(window as unknown as { matchMedia: (q: string) => unknown }).matchMedia = (q: string) => {
  asked.push(q);
  return { get matches() { return phoneNow; }, media: q, addEventListener: (_t: string, l: () => void) => watchers.add(l), removeEventListener: (_t: string, l: () => void) => watchers.delete(l) };
};

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
{
  const m = await app("#/activity");
  const settings = () => m.container.querySelector('nav.ui-rail button[aria-label="Settings"]') as HTMLButtonElement;
  const menu = () => m.container.querySelector("nav.ui-rail [role=menu]");
  const items = () => Array.from(menu()?.querySelectorAll("[role=menuitemradio]") ?? []) as HTMLElement[];
  const checked = () => items().filter((i) => i.getAttribute("aria-checked") === "true").map(textOf);
  ok("1.1 Settings is live in the app and its menu starts closed", !settings().disabled && settings().getAttribute("aria-expanded") === "false" && menu() === null);
  await m.run(() => settings().click());
  same("1.2 it opens a Theme menu offering System, Light and Dark, the current choice checked",
    [menu()?.getAttribute("aria-label"), items().map(textOf), checked(), settings().getAttribute("aria-expanded")], ["Theme", ["System", "Light", "Dark"], ["System"], "true"]);
  ok("1.3 focus moves to the checked item, and the checked item carries a tick, not colour alone",
    document.activeElement === items()[0] && items()[0].querySelector("svg") !== null && items()[1].querySelector("svg") === null);
  await m.run(() => key(document.activeElement!, "ArrowDown"));
  ok("1.4 Down moves to the next item", document.activeElement === items()[1], textOf(document.activeElement));
  await m.run(() => key(document.activeElement!, "ArrowUp"));
  await m.run(() => key(document.activeElement!, "ArrowUp"));
  ok("1.5 and Up wraps from the first to the last", document.activeElement === items()[2], textOf(document.activeElement));
  const cycle: string[][] = [];
  for (const choice of ["Dark", "Light", "System"]) {
    if (menu() === null) await m.run(() => settings().click());
    await m.run(() => items().find((i) => textOf(i) === choice)!.click());
    cycle.push([choice, root.dataset.theme ?? "", localStorage.getItem("cotal.theme") ?? "", String(menu() === null), String(document.activeElement === settings())]);
  }
  same("1.6 each choice in turn is applied to the root element at once, saved for the next load, and closes the menu with focus back on Settings",
    cycle, [["Dark", "dark", "dark", "true", "true"], ["Light", "light", "light", "true", "true"], ["System", "system", "system", "true", "true"]]);
  await m.run(() => settings().click());
  await m.run(() => items().find((i) => textOf(i) === "Dark")!.click());
  await m.unmount();
  const again = await app("#/activity");
  await again.run(() => (again.container.querySelector('nav.ui-rail button[aria-label="Settings"]') as HTMLElement).click());
  same("1.7 a new load reads the saved choice: Dark is the checked item",
    Array.from(again.container.querySelectorAll("[role=menuitemradio][aria-checked=true]")).map(textOf), ["Dark"]);
  await again.run(() => key(document.activeElement!, "Escape"));
  ok("1.8 Escape closes the menu and puts focus back on Settings",
    again.container.querySelector("[role=menu]") === null && document.activeElement === again.container.querySelector('button[aria-label="Settings"]'));
  await again.run(() => (again.container.querySelector('button[aria-label="Settings"]') as HTMLElement).click());
  await again.run(() => document.body.dispatchEvent(new (dom.window.Event as typeof Event)("pointerdown", { bubbles: true })));
  ok("1.9 a press outside the menu closes it", again.container.querySelector("[role=menu]") === null);
  await again.unmount();
  localStorage.removeItem("cotal.theme");
}

// ── 2. The phone: the tab bar ────────────────────────────────────────────────────────────────────
phoneNow = true;
localStorage.setItem(PANEL_KEY, "1");
let m: Mounted = await app("#/channel/review");
{
  ok("2.1 the app asks the window whether it is phone width, below 768px", asked.includes(PHONE_QUERY) && PHONE_QUERY === "(max-width: 767.98px)", asked);
  const shell = m.container.querySelector(".ui-app");
  ok("2.2 on a phone there is no rail and no sidebar column: the centre sits over the tab bar",
    shell?.classList.contains("ui-phone") === true && m.container.querySelector("nav.ui-rail") === null && m.container.querySelector("aside.ui-side") === null
      && shell.children[0]?.matches("main.ui-center") === true && shell.children[1]?.matches("nav.v3-tabbar") === true, shell?.className);
  const tabs = () => Array.from(m.container.querySelectorAll("nav.v3-tabbar[aria-label=Sections] > *")).map((t) => ({
    text: textOf(t),
    current: t.getAttribute("aria-current"),
    href: t.getAttribute("href"),
    badge: t.querySelector(".ui-badge-gold")?.getAttribute("title") ?? null,
  }));
  same("2.3 the tab bar holds Channels, DMs, Agents and Activity, Agents carrying the gold count of agents waiting, and the open channel's tab is current",
    tabs().map((t) => [t.text, t.current, t.badge]), [["Channels", "page", null], ["DMs", null, null], ["Agents2", null, "2 agents waiting"], ["Activity", null, null]]);
  same("2.4 each tab leads where the rail would", tabs().map((t) => t.href), [formatRoute({ view: "channel", channel: "review" }), null, "#/agents", "#/activity"]);
  const dms = m.container.querySelectorAll("nav.v3-tabbar > *")[1];
  same("2.5 a tab with nowhere to go is a disabled button titled with the empty state",
    [dms.tagName.toLowerCase(), dms.getAttribute("aria-disabled"), dms.getAttribute("title")], ["button", "true", "No direct messages yet."]);
  await m.run(() => go("#/needs"));
  same("2.6 the Needs route draws the Agents view, so Agents is the current tab", tabs().filter((t) => t.current === "page").map((t) => t.text), ["Agents2"]);
  await m.run(() => go("#/channel/review"));
}

// A keyboard reader presses the button it has focused, which is what a trap hands focus back to.
const press = (el: HTMLElement | null) => {
  el?.focus();
  el?.click();
};

// ── 3. The phone: the panel, full screen ─────────────────────────────────────────────────────────
{
  const pane = () => m.container.querySelector("section.ui-pane");
  const stack = () => m.container.querySelector("main header button.ui-members") as HTMLElement | null;
  ok("3.1 the panel starts closed on a phone, though the wide layout's saved choice is open", pane() === null && localStorage.getItem(PANEL_KEY) === "1");
  await m.run(() => press(stack()));
  ok("3.2 the member stack opens it full screen, as a modal dialog marked full",
    pane()?.classList.contains("ui-pane-full") === true && pane()?.getAttribute("data-full") === "true" && pane()?.getAttribute("role") === "dialog" && pane()?.getAttribute("aria-modal") === "true"
      && textOf(pane()?.querySelector("[role=tab][aria-selected=true]")) === "Members", pane()?.outerHTML.slice(0, 200));
  ok("3.3 focus moves into it", pane()?.contains(document.activeElement) === true, textOf(document.activeElement));
  await m.run(() => key(document.activeElement!, "Escape"));
  ok("3.4 Escape closes it, and the wide layout's saved choice is untouched", pane() === null && localStorage.getItem(PANEL_KEY) === "1");
  ok("3.5 and focus goes back to the member stack that opened it", stack() !== null && document.activeElement === stack(), textOf(document.activeElement));
  const panelButton = () => m.container.querySelector('main header button[aria-label="Open agent panel"]') as HTMLElement | null;
  await m.run(() => press(panelButton()));
  ok("3.6 the header's panel button, titled Open agent panel as in mock F, opens it too",
    panelButton()?.getAttribute("title") === "Open agent panel" && pane()?.getAttribute("data-full") === "true", panelButton()?.outerHTML.slice(0, 160));
  await m.run(() => (pane()?.querySelector('[aria-label="Close panel"]') as HTMLElement | null)?.click());
  ok("3.7 and its close button closes it, again without saving", pane() === null && localStorage.getItem(PANEL_KEY) === "1");
  await m.run(() => press(stack()));
  await m.run(() => go("#/channel/general"));
  ok("3.8 a new route closes it, even another channel that has a panel to show", pane() === null && textOf(m.container.querySelector("main header h1")) === "# general");
  await m.run(() => go("#/channel/review"));
}

// ── 4. The phone: the places sheet ───────────────────────────────────────────────────────────────
{
  const menuButton = () => m.container.querySelector('main header button[aria-label="Open sidebar"]') as HTMLButtonElement | null;
  const sheet = () => m.container.querySelector("aside.ui-side.ui-sheet");
  ok("4.1 the channel header opens with the menu button, and the sheet starts closed",
    menuButton() !== null && menuButton()!.getAttribute("aria-expanded") === "false" && sheet() === null && m.container.querySelector("main header")?.firstElementChild === menuButton());
  await m.run(() => press(menuButton()));
  ok("4.2 the menu button opens the places sheet, a modal dialog holding the sidebar",
    sheet()?.getAttribute("role") === "dialog" && sheet()?.getAttribute("aria-modal") === "true" && sheet()?.querySelector("nav[aria-label=Places]") !== null
      && menuButton()!.getAttribute("aria-expanded") === "true", sheet()?.outerHTML.slice(0, 160));
  const focusables = () => Array.from(sheet()!.querySelectorAll("a[href], button")) as HTMLElement[];
  ok("4.3 focus moves into the sheet, to its first place", document.activeElement === focusables()[0], textOf(document.activeElement));
  await m.run(() => focusables().at(-1)!.focus());
  await m.run(() => key(document.activeElement!, "Tab"));
  ok("4.4 Tab from the last place wraps to the first: focus stays in the sheet", document.activeElement === focusables()[0], textOf(document.activeElement));
  await m.run(() => key(document.activeElement!, "Tab", true));
  ok("4.5 and Shift Tab from the first wraps to the last", document.activeElement === focusables().at(-1), textOf(document.activeElement));
  await m.run(() => key(document.activeElement!, "Escape"));
  ok("4.6 Escape closes the sheet and puts focus back on the menu button", sheet() === null && document.activeElement === menuButton());
  await m.run(() => press(menuButton()));
  await m.run(() => (m.container.querySelector(".ui-sheet-scrim") as HTMLElement).click());
  ok("4.7 a click on the scrim closes it", sheet() === null);
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
  ok("5.1 when the window widens past 768px the rail, the sidebar and the saved panel come back, and the tab bar and the menu button go",
    m.container.querySelector("nav.ui-rail") !== null && m.container.querySelector("aside.ui-side:not(.ui-sheet)") !== null && m.container.querySelector("section.ui-pane:not(.ui-pane-full)") !== null
      && m.container.querySelector("nav.v3-tabbar") === null && m.container.querySelector('button[aria-label="Open sidebar"]') === null);
  await m.unmount();
  ok("5.2 unmounting stops watching the width", watchers.size === 0, watchers.size);
}

patch = seed;
localStorage.clear();
await closeDom();
console.log(`layout: ${n} checks passed`);
