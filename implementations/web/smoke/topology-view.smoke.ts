/** The topology view and its graph, drawn. Sections 1 and 2 render `TopologyView` on the server over
 *  seeded stores and read the SVG: which nodes and links are drawn, which are hot, the badge, the
 *  Hide offline button, the membership pill. A force layout is not drawn at fixed coordinates, so
 *  these cells read structure (nodes, links, classes) and never a position. Section 3 mounts the
 *  graph in jsdom, where the frame loop and the zoom run: the nodes get positions, the layout heats
 *  only when the node or link set changes, a wheel zooms, and unmounting stops everything. The
 *  model's own rules (what is a node, what is hot) are in topology.smoke.ts. */
import { closeDom, dom } from "./dom-globals.js";
import { strict as assert } from "node:assert";
import { createElement, useState } from "react";
import { renderToString } from "react-dom/server";
import type { ChannelInfo, CotalMessage, MembershipSnapshot, RosterEntry } from "../client/src/api/types.js";
import { topologyModel, type TopoModel } from "../client/src/lib/topology.js";
import type { Route } from "../client/src/lib/route.js";
import { createStore } from "../client/src/state/store.js";
import { initialState, type DashboardState } from "../client/src/state/types.js";
import { ForceLayout } from "../client/src/ui/graph/layout.js";
import { TopologyGraph } from "../client/src/ui/graph/TopologyGraph.tsx";
import { TopologyView } from "../client/src/ui/views/TopologyView.tsx";
import { renderShell } from "./render-shell.js";
import { errorsDuring, mount } from "./mount.js";

let n = 0;
const ok = (name: string, cond: unknown, detail?: unknown) => {
  assert.ok(cond, `${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
  console.log(`  ok ${++n} ${name}`);
};

const NOW = 1_700_000_000_000;
const agent = (id: string, name: string, status: RosterEntry["status"], connector?: string): RosterEntry =>
  ({ card: { id, name, kind: "agent", ...(connector ? { meta: { connector } } : {}) }, status, ts: NOW }) as unknown as RosterEntry;
const chan = (channel: string): ChannelInfo => ({ channel, messages: 0, replay: false, deliveryClass: "live" });
const member = (id: string, live: string[], durable: string[] = []) => ({ id, live, durable, observedAt: 1 });
const feed = (members: ReturnType<typeof member>[], asOf = NOW): { snapshot: MembershipSnapshot } => ({ snapshot: { asOf, members } });
const msgOf = (from: string, ts: number, extra: object = {}): CotalMessage =>
  ({ id: `m${ts}`, ts, space: "s", from: { id: from, name: "payload-name" }, parts: [], ...extra }) as unknown as CotalMessage;

const ROSTER = [agent("A", "ana", "working", "claude-code"), agent("B", "bo", "idle", "codex"), agent("C", "cy", "offline")];
const MEMBERS = feed([member("A", ["alerts"]), member("B", [], ["ops"]), member("C", ["alerts"])]);
const CHANNELS = [chan("alerts"), chan("ops")];

type Patch = Partial<DashboardState>;
const seed = (patch: Patch = {}) => createStore<DashboardState>({ ...initialState, roster: ROSTER, channels: CHANNELS, membership: MEMBERS, ...patch });
const view = (patch: Patch = {}, props: { clock?: () => number; initialHideOffline?: boolean } = {}) =>
  renderToString(createElement(TopologyView, { store: seed(patch), clock: () => NOW, ...props }));

/** `html` parsed into a DOM, so a cell asks for elements and classes instead of matching text. */
const parse = (html: string): HTMLElement => {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d;
};
const nodeIds = (root: ParentNode) => [...root.querySelectorAll("[data-node]")].map((e) => e.getAttribute("data-node")).sort();
const lines = (root: ParentNode, cls: string) => root.querySelectorAll(`line.${cls}`).length;
const text = (root: ParentNode, sel: string) => [...root.querySelectorAll(sel)].map((e) => e.textContent);

// 1. What is drawn: the nodes
{
  const d = parse(view({}, { initialHideOffline: false }));
  ok("1.1 each roster agent is a node, and each channel is one", nodeIds(d).join() === "#alerts,#ops,A,B,C", nodeIds(d));
  ok("1.2 an agent is labelled with its roster name", text(d, ".ui-ta-name").sort().join() === "ana,bo,cy", text(d, ".ui-ta-name"));
  ok("1.3 a channel is a rounded #name pill", text(d, ".ui-tn text").sort().join() === "#alerts,#ops" && d.querySelector(".ui-tn rect")?.getAttribute("rx") === "8"
    && d.querySelector('[data-node="#alerts"] rect')?.getAttribute("width") === String(14 + "alerts".length * 7));
  ok("1.4 an agent is drawn as its character through the art seam", d.querySelectorAll(".ui-ta svg").length === 3 && /<g/.test(d.querySelector(".ui-ta svg")!.innerHTML));
  const chat = parse(view({ activity: [{ mode: "chat", channel: "alerts", senderId: "A", msg: msgOf("A", NOW - 60_000) }] }, { initialHideOffline: false }));
  ok("1.5 a sender is named by the roster and never by the payload's own name", !chat.textContent!.includes("payload-name") && text(chat, ".ui-ta-name").includes("ana"));
  const bare = parse(view({ activity: [{ mode: "chat", channel: "alerts", msg: msgOf("B", NOW - 60_000) }] }, { initialHideOffline: false }));
  ok("1.6 a backfilled message with no verified sender falls back to the id in the message", nodeIds(bare).includes("B") && lines(bare, "ui-tl-traffic") === 1, nodeIds(bare));
  ok("1.7 a channel with no members is hidden while the membership feed is authoritative",
    !nodeIds(parse(view({ channels: [...CHANNELS, chan("quiet")] }, { initialHideOffline: false }))).includes("#quiet"));
  ok("1.8 and drawn when the feed is traffic-only, where no member could ever be known",
    nodeIds(parse(view({ channels: [...CHANNELS, chan("quiet")], membership: {} }))).includes("#quiet"));
  const solo = parse(view({ activity: [{ mode: "chat", channel: "solo", senderId: "A", msg: msgOf("B", NOW - 60_000) }], membership: {} }, { initialHideOffline: false }));
  ok("1.9 a message is attributed to its verified sender and never to the id in its payload",
    solo.querySelector('line[data-link="A>#solo"]') !== null && solo.querySelector('line[data-link="B>#solo"]') === null, [...solo.querySelectorAll("line")].map((l) => l.getAttribute("data-link")));
}

// 2. What is drawn: links, hot links, the badge, the toggle, the pill
{
  const d = parse(view({}, { initialHideOffline: false }));
  ok("2.1 a live subscription is a member link and a durable one a durable link", lines(d, "ui-tl-member") === 2 && lines(d, "ui-tl-durable") === 1, d.querySelectorAll("line").length);
  ok("2.2 an offline agent's links are dashed", d.querySelectorAll("line.ui-tl-off").length === 1);
  ok("2.3 an offline agent's node is greyscale at half opacity, and a live one is not",
    d.querySelector('[data-node="C"]')!.classList.contains("ui-ta-off") && !d.querySelector('[data-node="A"]')!.classList.contains("ui-ta-off"));
  ok("2.4 nothing is hot with no message", lines(d, "ui-tl-hot") === 0 && d.querySelectorAll(".ui-tn-hot").length === 0);

  const entry = (ts: number) => ({ activity: [{ mode: "chat" as const, channel: "alerts", senderId: "A", msg: msgOf("A", ts) }] });
  const within = parse(view(entry(NOW - 1999), { initialHideOffline: false }));
  ok("2.5 a link is hot within 2 seconds of a message on its channel", lines(within, "ui-tl-hot") >= 1, lines(within, "ui-tl-hot"));
  ok("2.6 and the channel's pill shows it", within.querySelector('[data-node="#alerts"]')!.classList.contains("ui-tn-hot") && !within.querySelector('[data-node="#ops"]')!.classList.contains("ui-tn-hot"));
  const after = parse(view(entry(NOW - 2000), { initialHideOffline: false }));
  ok("2.7 and cold after 2 seconds", lines(after, "ui-tl-hot") === 0 && after.querySelectorAll(".ui-tn-hot").length === 0);
  const later = parse(renderToString(createElement(TopologyView, { store: seed(entry(NOW - 1999)), clock: () => NOW + 1, initialHideOffline: false })));
  ok("2.8 hot or cold is the clock's reading and nothing else: one more millisecond cools it", lines(later, "ui-tl-hot") === 0);

  const wide = parse(view({ membership: feed([member("A", [">"]), member("B", ["alerts"])]) }, { initialHideOffline: false }));
  ok("2.9 a reader of everything gets the all-channels badge and no link to each channel",
    text(wide, ".ui-wide text").join() === "all channels" && wide.querySelector('[data-node="A"] .ui-wide') !== null
      && [...wide.querySelectorAll("line")].length === 1, { badges: text(wide, ".ui-wide text"), lines: wide.querySelectorAll("line").length });
  ok("2.10 and an agent that reads one channel has no badge", wide.querySelector('[data-node="B"] .ui-wide') === null);

  const dflt = parse(view());
  ok("2.11 Hide offline is on by default: the offline agent and its links are gone", !nodeIds(dflt).includes("C") && dflt.querySelectorAll("line.ui-tl-off").length === 0, nodeIds(dflt));
  const button = [...dflt.querySelectorAll("button")].find((b) => b.textContent === "Hide offline");
  ok("2.12 the button reads Hide offline and says it is pressed", button?.getAttribute("aria-pressed") === "true");
  ok("2.13 with it off the button says so", [...parse(view({}, { initialHideOffline: false })).querySelectorAll("button")].find((b) => b.textContent === "Hide offline")?.getAttribute("aria-pressed") === "false");

  const unread = parse(view({ membership: { ...MEMBERS, unreadable: "membership read failed" } }, { initialHideOffline: false }));
  ok("2.14 an unreadable feed draws no membership links", lines(unread, "ui-tl-member") === 0 && lines(unread, "ui-tl-durable") === 0, unread.querySelectorAll("line").length);
  ok("2.15 and no all-channels badge", parse(view({ membership: { ...feed([member("A", [">"])]), unreadable: "x" } })).querySelector(".ui-wide") === null);
  ok("2.16 and the agents still draw from the roster", nodeIds(unread).includes("A") && nodeIds(unread).includes("B"));

  const pill = (patch: Patch) => parse(view(patch)).querySelector(".ui-mpill");
  ok("2.17 the pill reads Membership: live for a fresh feed, with the daemon tooltip",
    pill({})?.textContent === "Membership: live" && pill({})?.getAttribute("title") === "From broker membership, served by the delivery daemon" && pill({})?.classList.contains("ui-mpill-live") === true);
  ok("2.18 stale for an old one", pill({ membership: feed([member("A", ["alerts"])], NOW - 60_000) })?.textContent === "Membership: stale" && pill({ membership: feed([], NOW - 60_000) })?.classList.contains("ui-mpill-stale") === true);
  ok("2.19 traffic-only for no feed, with its tooltip",
    pill({ membership: {} })?.textContent === "Membership: traffic-only" && pill({ membership: {} })?.getAttribute("title") === "No delivery daemon on an open mesh, so members come from who has posted"
      && pill({ membership: {} })?.classList.contains("ui-mpill-traffic") === true);
  ok("2.20 unreadable for a failed read", pill({ membership: { unreadable: "x" } })?.textContent === "Membership: unreadable" && pill({ membership: { unreadable: "x" } })?.classList.contains("ui-mpill-unread") === true);

  ok("2.21 the legend names each line kind and the badge", text(dflt, ".ui-legend span").join("|") === "Member|Durable member|Posted here|Active now|all channelsReads every channel", text(dflt, ".ui-legend span"));
  ok("2.22 the graph is one labelled image", dflt.querySelectorAll('svg[role="img"][aria-label="Mesh topology"]').length === 1 && dflt.querySelector("h1")?.textContent === "Topology");
  ok("2.23 the first draw is at rest and reproducible: one model renders to the same markup twice", view() === view());

  const shell = parse(renderShell({ roster: ROSTER, channels: CHANNELS, membership: MEMBERS }, { view: "topology" } as Route));
  ok("2.24 the shell draws the topology view in its centre on the topology route", shell.querySelector("main.ui-center svg.ui-topo-svg") !== null && shell.querySelector("main.ui-center h1")?.textContent === "Topology");
  ok("2.25 and on no other route", parse(renderShell({ roster: ROSTER }, { view: "agents" } as Route)).querySelector("svg.ui-topo-svg") === null);
}

// 3. Mounted: the frame loop, the zoom, the clock and unmounting
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A frame source that runs on a zero timer, so a layout that takes 300 frames to settle does so in
 *  well under a second, and that records what was asked of it. */
const raf = { requested: 0, ran: 0, pending: new Map<number, ReturnType<typeof setTimeout>>(), next: 0 };
const g = globalThis as unknown as { requestAnimationFrame: (cb: (t: number) => void) => number; cancelAnimationFrame: (id: number) => void };
g.requestAnimationFrame = (cb) => {
  const id = ++raf.next;
  raf.requested++;
  raf.pending.set(id, setTimeout(() => { raf.pending.delete(id); raf.ran++; cb(0); }, 0));
  return id;
};
g.cancelAnimationFrame = (id) => {
  clearTimeout(raf.pending.get(id));
  raf.pending.delete(id);
};
const idle = async () => { for (let i = 0; i < 500 && raf.pending.size > 0; i++) await sleep(10); };

/** Every listener added to and removed from a graph's SVG, which is where the zoom puts its own. */
const listeners = { added: 0, removed: 0 };
const proto = (dom.window as unknown as { EventTarget: { prototype: EventTarget } }).EventTarget.prototype;
const realAdd = proto.addEventListener;
const realRemove = proto.removeEventListener;
const onGraph = (t: unknown) => (t as Element | undefined)?.classList?.contains("ui-topo-svg") === true;
proto.addEventListener = function (this: EventTarget, ...a: Parameters<EventTarget["addEventListener"]>) { if (onGraph(this)) listeners.added++; return realAdd.apply(this, a); };
proto.removeEventListener = function (this: EventTarget, ...a: Parameters<EventTarget["removeEventListener"]>) { if (onGraph(this)) listeners.removed++; return realRemove.apply(this, a); };

const model = (over: Partial<Parameters<typeof topologyModel>[0]> = {}): TopoModel =>
  topologyModel({ roster: ROSTER, channels: CHANNELS, membership: MEMBERS, recent: [], hideOffline: false, hideEmpty: true, now: NOW, ...over });
let setModel!: (m: TopoModel) => void;
const Harness = ({ initial }: { initial: TopoModel }) => {
  const [m, set] = useState(initial);
  setModel = set;
  return createElement(TopologyGraph, { model: m });
};
const transforms = (root: ParentNode) => Object.fromEntries([...root.querySelectorAll("[data-node]")].map((e) => [e.getAttribute("data-node")!, e.getAttribute("transform")!]));
const finite = (t: string) => { const m = /^translate\((-?[\d.e+-]+) (-?[\d.e+-]+)\)$/.exec(t); return m !== null && Number.isFinite(+m[1]) && Number.isFinite(+m[2]); };

{
  const base = model();
  const more = model({ roster: [...ROSTER, agent("D", "di", "idle")], membership: feed([member("A", ["alerts"]), member("B", [], ["ops"]), member("C", ["alerts"]), member("D", ["ops"])]) });
  const m = await mount(createElement(Harness, { initial: base }));
  const first = transforms(m.container);
  ok("3.1 a mounted graph positions every node, with no NaN", Object.keys(first).length === 5 && Object.values(first).every(finite), first);
  ok("3.2 the nodes do not sit on one another", new Set(Object.values(first)).size === 5, first);
  ok("3.3 the first draw is at rest: no frame is asked for", raf.requested === 0, raf.requested);

  await m.run(() => setModel(more));
  const added = transforms(m.container);
  ok("3.4 a node that joins is drawn at once, before the layout has moved it", Object.keys(added).length === 6 && finite(added["D"]), added);
  ok("3.5 and adding it asks for frames", raf.requested > 0, raf.requested);
  await m.run(() => idle());
  const settled = transforms(m.container);
  ok("3.6 the frame loop moves the new node to a place of its own, still with no NaN", Object.values(settled).every(finite) && settled["D"] !== added["D"], { added: added["D"], settled: settled["D"] });
  ok("3.7 and comes to rest: no frame is left pending", raf.pending.size === 0);

  const asked = raf.requested;
  const hotter = model({ roster: [...ROSTER, agent("D", "di", "idle")], membership: feed([member("A", ["alerts"]), member("B", [], ["ops"]), member("C", ["alerts"]), member("D", ["ops"])]),
    recent: [{ mode: "chat", channel: "ops", senderId: "B", msg: msgOf("B", NOW), ts: NOW }] });
  await m.run(() => setModel(hotter));
  await m.run(() => sleep(100));
  ok("3.8 a link going hot moves nothing and asks for no frame", m.container.querySelectorAll(".ui-tl-hot").length > 0 && raf.requested === asked, { hot: m.container.querySelectorAll(".ui-tl-hot").length, asked, now: raf.requested });
  ok("3.9 and no node has moved", JSON.stringify(transforms(m.container)) === JSON.stringify(settled));

  const relinked = model({ roster: [...ROSTER, agent("D", "di", "idle")], membership: feed([member("A", ["alerts", "ops"]), member("B", [], ["ops"]), member("C", ["alerts"]), member("D", ["ops"])]) });
  await m.run(() => setModel(relinked));
  ok("3.10 a link joining two nodes already drawn asks for frames", raf.requested > asked, { asked, now: raf.requested });
  await m.run(() => idle());
  const fewer = model();
  const before = raf.requested;
  await m.run(() => setModel(fewer));
  ok("3.11 so does a node leaving", raf.requested > before && Object.keys(transforms(m.container)).length === 5, { before, now: raf.requested });
  await m.run(() => idle());
  await m.unmount();
}

// The zoom: a wheel turn on the graph scales its content
const DomWheelEvent = (dom.window as unknown as { WheelEvent: typeof WheelEvent }).WheelEvent;
{
  const m = await mount(createElement(Harness, { initial: model() }));
  const svg = m.container.querySelector("svg.ui-topo-svg") as SVGSVGElement;
  // jsdom has no SVG geometry. The zoom reads the drawing's `viewBox` from it, so give it one.
  Object.defineProperty(svg, "viewBox", { value: { baseVal: { x: 0, y: 0, width: 400, height: 420 } } });
  const scale = () => /scale\(([\d.]+)\)/.exec(m.container.querySelector("svg.ui-topo-svg > g")!.getAttribute("transform")!)?.[1];
  ok("3.12 the graph starts at scale 1", scale() === "1", scale());
  await m.run(() => void svg.dispatchEvent(new DomWheelEvent("wheel", { deltaY: -200, clientX: 100, clientY: 100, bubbles: true, cancelable: true })));
  await m.run(() => sleep(50));
  ok("3.13 a wheel turn zooms the content in", Number(scale()) > 1, scale());
  const added = listeners.added;
  ok("3.14 the zoom put listeners on the graph", added > 0, added);
  await m.unmount();
  ok("3.15 unmounting takes every one of them off", listeners.removed === listeners.added, listeners);
}

// Unmounting stops the frame loop
{
  const m = await mount(createElement(Harness, { initial: model() }));
  await m.run(() => setModel(model({ roster: [...ROSTER, agent("D", "di", "idle")] })));
  const running = raf.pending.size;
  await m.unmount();
  const ranBefore = raf.ran;
  const askedBefore = raf.requested;
  await sleep(100);
  ok("3.16 a frame was waiting when the graph was unmounted", running === 1, running);
  ok("3.17 unmounting cancels it: no frame runs and none is asked for after", raf.pending.size === 0 && raf.ran === ranBefore && raf.requested === askedBefore, { pending: raf.pending.size, ran: raf.ran - ranBefore, asked: raf.requested - askedBefore });
}

// The view, mounted: the toggle and the clock
{
  const store = seed({ activity: [{ mode: "chat", channel: "alerts", senderId: "A", msg: msgOf("A", NOW) }] });
  let clockNow = NOW + 1000;
  let reads = 0;
  const errors = await errorsDuring(async () => {
    const m = await mount(createElement(TopologyView, { store, clock: () => { reads++; return clockNow; } }));
    const button = () => [...m.container.querySelectorAll("button")].find((b) => b.textContent === "Hide offline")!;
    ok("3.18 Hide offline starts pressed, with the offline agent gone", button().getAttribute("aria-pressed") === "true" && !nodeIds(m.container).includes("C"), nodeIds(m.container));
    await m.run(() => button().click());
    ok("3.19 pressing it shows the offline agent again", button().getAttribute("aria-pressed") === "false" && nodeIds(m.container).includes("C"), nodeIds(m.container));
    await m.run(() => button().click());
    ok("3.20 and pressing it again hides it", button().getAttribute("aria-pressed") === "true" && !nodeIds(m.container).includes("C"));

    ok("3.21 a link is hot a second after its message", m.container.querySelectorAll(".ui-tl-hot").length > 0);
    clockNow = NOW + 5000;
    await m.run(() => sleep(700));
    ok("3.22 with no other event, the view draws again and the link goes cold on its own", m.container.querySelectorAll(".ui-tl-hot").length === 0, m.container.querySelectorAll(".ui-tl-hot").length);
    await m.unmount();
    const after = reads;
    await sleep(700);
    ok("3.23 unmounting stops the view's timer", reads === after, { after, now: reads });
  });
  ok("3.24 none of it raised a React warning", errors.length === 0, errors);
}

// 4. The layout on its own, with no React and no frames
{
  const one = new ForceLayout(400, 420);
  const more = model({ roster: [...ROSTER, agent("D", "di", "idle")] });
  one.sync(model());
  one.warm();
  const placed = one.at("A");
  ok("4.1 the layout is at rest after it warms, and heats when asked", one.settled && (one.reheat(), !one.settled));
  const fresh = new ForceLayout(400, 420);
  fresh.sync(model());
  fresh.warm();
  ok("4.2 one model rests in the same places every time", JSON.stringify(placed) === JSON.stringify(fresh.at("A")) && fresh.at("B") !== undefined && JSON.stringify(fresh.at("B")) === JSON.stringify(one.at("B")), { a: placed, b: fresh.at("A") });
  ok("4.3 a model with the same nodes and links changes nothing and a different one does", !one.sync(model({ recent: [{ mode: "chat", channel: "ops", senderId: "B", msg: msgOf("B", NOW), ts: NOW }] })) && one.sync(more));
  ok("4.4 a node already placed keeps its place when another joins", JSON.stringify(one.at("A")) === JSON.stringify(placed), { before: placed, after: one.at("A") });
  ok("4.5 and the one that joined has a place", one.at("D") !== undefined && Number.isFinite(one.at("D")!.x));
  ok("4.6 the layout has no place for an id it was not given", one.at("nobody") === undefined);
}

await closeDom();
console.log(`topology-view: ${n} checks passed`);
