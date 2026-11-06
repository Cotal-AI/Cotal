/** The app shell: the rail lists the five views and Settings in the mock's order with no runs link,
 *  the active item follows the route, a closed details panel is not drawn, a channel route shows that
 *  channel as the open one, and a route change reaches the controller. The shell is server-rendered
 *  over a seeded store and its HTML is read by role and name; the rail's Tooltips are read from the
 *  shell mounted in jsdom, since Tooltip content is drawn only once it opens. The hash listener and the
 *  open call are driven in Node over a fake location and a fake controller. The DOM shim is installed
 *  first, because a DM route draws message bodies, which render Markdown only through a working
 *  sanitizer. */
import { closeDom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { createElement } from "react";
import type { CotalMessage } from "../client/src/api/types.js";
import { mark } from "../client/src/art/index.ts";
import { openTarget, syncOpen } from "../client/src/lib/routeOpen.js";
import { formatRoute, type Route } from "../client/src/lib/route.js";
import { currentRoute, watchRoute, type RouteHost } from "../client/src/routeWatch.js";
import { Shell } from "../client/src/Shell.tsx";
import type { Controller } from "../client/src/state/controller.js";
import { createStore } from "../client/src/state/store.js";
import { initialState, type DashboardState } from "../client/src/state/types.js";
import { mount } from "./mount.js";
import { parseHtml, renderShell } from "./render-shell.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};
const same = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

const dm = { id: "d1", from: { id: "local.ab" }, to: "local.cd", ts: 1, parts: [{ kind: "text", text: "hi" }] } as unknown as CotalMessage;
const seed = {
  space: "main",
  channels: [{ channel: "general", messages: 1 }, { channel: "review", messages: 2 }],
  dms: [{ msg: dm }],
};

/** The Views landmark in a document. */
const viewsNav = (doc: Document) => doc.querySelector('[role="navigation"][aria-label="Views"]');
/** An element's accessible name as the rail gives it: its aria-label, or else its text. */
const nameOf = (el: Element) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";
/** The rail's items in document order: tag, accessible name, and the attributes. */
const rail = (html: string) => [...(viewsNav(parseHtml(html))?.querySelectorAll("a, button") ?? [])].map((el) => ({
  tag: el.tagName.toLowerCase(),
  name: nameOf(el),
  attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])) as Record<string, string>,
}));
const names = (html: string) => rail(html).map((i) => i.name);
const current = (html: string) => rail(html).filter((i) => i.attrs["aria-current"] === "page").map((i) => i.name);

// ── 1. The rail ──────────────────────────────────────────────────────────────────────────────────
{
  const html = renderShell(seed);
  ok("1.1 the rail has no Workflow runs item", !/Workflow runs/i.test(html) && !html.includes("#/runs"), names(html));
  same("1.2 the rail lists the five views and Settings, in the mock's order",
    names(html), ["Activity", "Channels", "Direct messages", "Agents", "Topology", "Settings"]);
  const items = rail(html);
  ok("1.3 the five views are links and Settings is a button",
    items.slice(0, 5).every((i) => i.tag === "a") && items[5].tag === "button", items.map((i) => i.tag));
  same("1.4 each view links to its route hash",
    items.slice(0, 5).map((i) => i.attrs.href),
    ["#/activity", "#/channel/general", "#/dm/local.ab/local.cd", "#/agents", "#/topology"]);
  const store = createStore<DashboardState>({ ...initialState, ...seed } as DashboardState);
  const m = await mount(createElement(Shell, { store, controller: null, route: { view: "activity" }, paneOpen: false, msgPerSecond: () => 0 }));
  const tips: string[] = [];
  const nav = viewsNav(m.container.ownerDocument)!;
  for (const item of [...nav.querySelectorAll("a, button")]) {
    // A disabled button takes no focus, so its Tooltip hangs on the span around it, which does.
    const target = (item as HTMLButtonElement).disabled ? item.closest('[tabindex="0"]') as HTMLElement : item as HTMLElement;
    await m.run(() => target.focus());
    tips.push(m.container.ownerDocument.querySelector('[role="tooltip"]')?.textContent ?? "");
    await m.run(() => target.blur());
  }
  await m.unmount();
  same("1.5 every item names itself in a Tooltip when it takes the focus", tips, ["Activity", "Channels", "Direct messages", "Agents", "Topology", "Settings"]);
  ok("1.6 the rail sits in the Views landmark", viewsNav(parseHtml(html)) !== null);
  ok("1.7 and the item count is exactly six", items.length === 6, items.length);
  const at = html.indexOf('aria-label="Views"');
  const markAt = html.indexOf(mark("currentColor"), at);
  ok("1.9 the rail opens with the Cotal mark, drawn through the art seam in the text colour, before its first view",
    at >= 0 && markAt > at && markAt < html.indexOf('href="#/activity"', at) && mark("currentColor").includes("<path"), { at, markAt });
}

// ── 2. The active item follows the route ─────────────────────────────────────────────────────────
{
  const at = (route: Route) => current(renderShell(seed, route));
  same("2.1 activity marks Activity", at({ view: "activity" }), ["Activity"]);
  same("2.2 a channel route marks Channels", at({ view: "channel", channel: "review" }), ["Channels"]);
  same("2.3 a dm route marks Direct messages", at({ view: "dm", peer: "local.ab" }), ["Direct messages"]);
  same("2.4 the agents status group marks Agents", at({ view: "agents", group: "status" }), ["Agents"]);
  same("2.5 the agents host group marks Agents too", at({ view: "agents", group: "host" }), ["Agents"]);
  same("2.6 topology marks Topology", at({ view: "topology" }), ["Topology"]);
  same("2.7 the needs view has no rail item, so none is marked", at({ view: "needs" }), []);
}

// ── 3. Where Channels and Direct messages lead ───────────────────────────────────────────────────
{
  const hrefs = (html: string) => rail(html).map((i) => i.attrs.href);
  same("3.1 on a channel route Channels links to that channel",
    hrefs(renderShell(seed, { view: "channel", channel: "review" }))[1], "#/channel/review");
  same("3.2 on a dm route Direct messages links to that conversation",
    hrefs(renderShell(seed, { view: "dm", peer: "local.cd", with: "local.ab" }))[2], formatRoute({ view: "dm", peer: "local.cd", with: "local.ab" }));
  const bare = rail(renderShell({ space: "main" }));
  ok("3.3 with no channel and no direct message the two items carry no href and say they are disabled",
    bare[1].attrs.href === undefined && bare[1].attrs["aria-disabled"] === "true"
      && bare[2].attrs.href === undefined && bare[2].attrs["aria-disabled"] === "true", bare.map((i) => i.attrs));
  ok("3.4 and the views that always exist keep their links", bare[0].attrs.href === "#/activity" && bare[3].attrs.href === "#/agents" && bare[4].attrs.href === "#/topology");
  same("3.5 on the host-grouped Agents view Agents keeps the host grouping",
    hrefs(renderShell(seed, { view: "agents", group: "host" }))[3], formatRoute({ view: "agents", group: "host" }));
  same("3.6 on a conversation with a peer that has none yet, Direct messages keeps that address rather than leaving for another peer",
    hrefs(renderShell(seed, { view: "dm", peer: "local.zz" }))[2], formatRoute({ view: "dm", peer: "local.zz" }));
}

// ── 4. The layout and the details panel ──────────────────────────────────────────────────────────
{
  const closed = parseHtml(renderShell(seed, { view: "activity" }, false));
  const open = parseHtml(renderShell(seed, { view: "channel", channel: "review" }, true));
  const panes = (doc: Document) => [...doc.querySelectorAll("section[aria-label]")].map((s) => s.getAttribute("aria-label"));
  same("4.3 a closed panel draws no panel region", panes(closed), []);
  same("4.4 an open panel draws the labelled panel", panes(open), ["Details"]);
  same("4.5 the sidebar and the centre are always labelled landmarks",
    [[...closed.querySelectorAll('[role="complementary"]')].map((a) => a.getAttribute("aria-label")), closed.querySelectorAll("main").length], [["Space"], 1]);
  const cols = [viewsNav(open), open.querySelector('[role="complementary"][aria-label="Space"]'), open.querySelector("main"), open.querySelector('section[aria-label="Details"]')];
  const inOrder = cols.every((c) => c !== null) && cols.every((c, k) => k === 0 || (cols[k - 1]!.compareDocumentPosition(c!) & 4) !== 0);
  ok("4.6 the four columns come in order: rail, sidebar, centre, panel", inOrder, cols.map((c) => c?.tagName));
}

// ── 5. A channel route shows that channel as the open one ────────────────────────────────────────
// The channel list is the sidebar's (Task 4); the centre draws the channel itself.
/** The channel links in the Space sidebar, in document order: their href and aria-current. */
const channelLinks = (html: string) =>
  [...(parseHtml(html).querySelector('[role="complementary"][aria-label="Space"]')?.querySelectorAll('a[href^="#/channel/"]') ?? [])]
    .map((a) => ({ href: a.getAttribute("href"), "aria-current": a.getAttribute("aria-current") ?? undefined }));
{
  const html = renderShell(seed, { view: "channel", channel: "review" });
  const links = channelLinks(html);
  same("5.1 the channel list links each channel to its route", links.map((a) => a.href), ["#/channel/general", "#/channel/review"]);
  same("5.2 and only the routed channel is the current one", links.filter((a) => a["aria-current"] === "page").map((a) => a.href), ["#/channel/review"]);
  same("5.3 the centre says which view it is showing", parseHtml(html).querySelector("main section[data-view]")?.getAttribute("data-view"), "channel");
  const elsewhere = channelLinks(renderShell(seed, { view: "topology" }));
  ok("5.4 off a channel route no channel is the current one", elsewhere.length === 2 && elsewhere.every((a) => a["aria-current"] === undefined), elsewhere);
  const encoded = renderShell({ channels: [{ channel: "team / a", messages: 0 }] }, { view: "channel", channel: "team / a" });
  same("5.5 a channel name is encoded in its link and matched back to the route",
    channelLinks(encoded).map((a) => [a.href, a["aria-current"]]), [["#/channel/team%20%2F%20a", "page"]]);
}

// ── 6. A route change reaches the controller ─────────────────────────────────────────────────────
const fake = () => {
  const calls: (string | null)[] = [];
  let reject = false;
  const controller = { open: (c: string | null) => { calls.push(c); return reject ? Promise.reject(new Error("boom")) : Promise.resolve(); } } as unknown as Controller;
  return { calls, controller, failNext: () => { reject = true; } };
};
{
  same("6.1 a channel route opens that channel", openTarget({ view: "channel", channel: "review" }), "review");
  same("6.2 every other route opens nothing", [
    { view: "activity" }, { view: "dm", peer: "a" }, { view: "agents", group: "host" }, { view: "topology" }, { view: "needs" },
  ].map((r) => openTarget(r as Route)), [null, null, null, null, null]);
  const f = fake();
  syncOpen(f.controller, "review");
  syncOpen(f.controller, null);
  same("6.3 syncOpen hands the target to controller.open, a null closes", f.calls, ["review", null]);
  const none = (() => { try { syncOpen(null, "review"); return undefined; } catch (e) { return String(e); } })();
  ok("6.4 before the dashboard has started there is no controller and nothing happens", none === undefined, none);
  const g = fake();
  g.failNext();
  const logged: unknown[][] = [];
  const unhandled: unknown[] = [];
  const realError = console.error;
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  console.error = (...a: unknown[]) => void logged.push(a);
  process.on("unhandledRejection", onUnhandled);
  try { syncOpen(g.controller, "review"); await new Promise((r) => setTimeout(r, 10)); } finally { console.error = realError; process.off("unhandledRejection", onUnhandled); }
  ok("6.5 a rejected open is logged, not left as an unhandled rejection",
    logged.length === 1 && String(logged[0]?.[0]).includes("opening") && unhandled.length === 0, { logged, unhandled: unhandled.map(String) });
}

// ── 7. The hash listener ─────────────────────────────────────────────────────────────────────────
{
  const host = (hash: string, pathname = "/") => {
    const listeners = new Set<() => void>();
    const h = {
      location: { hash, pathname },
      history: { replaceState: () => undefined },
      addEventListener: (type: "hashchange", l: () => void) => { assert.equal(type, "hashchange"); listeners.add(l); },
      removeEventListener: (type: "hashchange", l: () => void) => { assert.equal(type, "hashchange"); listeners.delete(l); },
    } satisfies RouteHost;
    return { h, fire: () => listeners.forEach((l) => l()), listeners };
  };
  same("7.1 the first route is the one in the address", currentRoute(host("#/channel/review").h), { view: "channel", channel: "review" });
  same("7.2 the old /graph path is topology", currentRoute(host("", "/graph").h), { view: "topology" });
  const w = host("#/activity");
  const seen: Route[] = [];
  const stop = watchRoute(w.h, (r) => seen.push(r));
  w.h.location.hash = "#/channel/review";
  w.fire();
  w.h.location.hash = "#/nowhere";
  w.fire();
  same("7.3 a hashchange reports the new route, and an unknown hash reports the default", seen, [{ view: "channel", channel: "review" }, { view: "activity" }]);
  stop();
  w.fire();
  ok("7.4 stopping removes the listener, so a later change reports nothing", w.listeners.size === 0 && seen.length === 2, seen);
}

await closeDom();
console.log(`\n${n} cells green`);
