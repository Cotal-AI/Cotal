/**
 * THE LIVE FEED IS NOT GATED BEHIND THE SLOW BOOTSTRAP READ.
 *
 * The graph page's connection pill is driven by ONE thing: `EventSource("/feed")` opening. Until it
 * does, the pill sits in its `down` state: `connecting` as the page ships it, and `disconnected`
 * once an error has fired. The page booted as
 *
 *     load().catch((err) => console.error(err)).then(connect);
 *
 * so the feed was not opened until the ENTIRE bootstrap settled, and that bootstrap reads
 * `/api/activity?limit=400` and `/api/dms?limit=400`, both bounded by the aggregation deadline. On a
 * slow link the pill therefore stays down for the whole load window and only then goes live.
 * Reported from a real deployment observed across a WAN link: "always showing disconnected, and
 * taking long to show the graph".
 *
 * MEASURED IN A REAL BROWSER, both arms on one link and one corpus: Chrome, a local broker behind
 * 80ms each way, 40 channels with history. Chained, the feed's `EventSource` was constructed at
 * t=8050ms and open at 8052ms, which is when the pill first said `live`; the slowest bootstrap read
 * answered at 8044ms, so the pill tracked the bootstrap exactly. Concurrent, it was constructed at
 * t=62ms and open at 88ms, with the pill `live` at 89ms while that same read still ran to 8066ms.
 * A reviewer noted that a browser can queue an `EventSource` behind six pending same-origin reads;
 * it does not queue this one, because `connect()` runs before the reads are issued.
 *
 * An earlier fix made `load()` never REJECT, so `connect()` always RUNS, and its comment says
 * "Nothing here can prevent `connect()` from running". That is true and it is not the property
 * needed: nothing stopped connect from being DELAYED. The same comment states the intent it misses,
 * "the live feed is exactly what a page showing stale data needs most".
 *
 * The Monitor page next door already gets this right: `app.js` ends with `refresh(); connect();`,
 * concurrent, not chained. The graph page was the outlier.
 *
 * WHAT THIS RUNS. The two REAL served files, `snapshot.js` and `graph.js`, executed verbatim in a vm
 * context with the browser surface they touch stubbed (4 `document` uses, one canvas, one
 * `EventSource`, `fetch`, `requestAnimationFrame`). It is the shipped boot path, not a restatement
 * of it: a cell over a hand-written copy of the boot line would pass whatever the real file did.
 *
 * Run: pnpm smoke:web-graph-boot
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..", "src", "web");

let cells = 0, failed = 0;
function ok(name: string, cond: boolean, detail?: unknown) {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
}

/** The bootstrap read is deliberately slower than any sane "did it connect yet" threshold, because
 *  the whole defect is the feed waiting on it. 1200ms models a slow link without costing wall clock. */
const READ_MS = 1200;
/** connect() is concurrent or it is not. A real chained boot answers at >= READ_MS; a concurrent one
 *  answers in single-digit ms. 300ms sits in neither's neighbourhood, so the cell cannot be flaky. */
const CONCURRENT_MS = 300;

function stubEl(drawn?: string[]) {
  const el: Record<string, unknown> = {
    textContent: "", hidden: false, title: "", width: 800, height: 600, onclick: null,
    style: {}, dataset: {},
    classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
    addEventListener: () => {}, removeEventListener: () => {}, appendChild: () => {},
    getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
    // The canvas records the TEXT it is asked to draw. `ctx.fillText(a.name, ...)` is how an agent
    // appears on the graph, so "is this agent drawn" is answerable without reaching into a closure.
    getContext: () => new Proxy({}, {
      get: (_t, k) => (k === "fillText" ? (s: unknown) => { drawn?.push(String(s)); }
        : k === "measureText" ? () => ({ width: 10 })
        : k === "canvas" ? { width: 800, height: 600 }
        // createLinearGradient / createRadialGradient must return something with addColorStop, or
        // the very first frame dies in the starfield before a single label is drawn.
        : typeof k === "string" && k.startsWith("create") ? () => ({ addColorStop: () => {} })
        : () => {}),
      set: () => true,
    }),
  };
  const kids = new Map<string, Record<string, unknown>>();
  el.querySelector = (sel: string) => { if (!kids.has(sel)) kids.set(sel, stubEl()); return kids.get(sel)!; };
  el.querySelectorAll = () => [];
  return el;
}

/** The response a read REFUSES with, rather than answers. `readJson` turns a non-200 into a throw,
 *  `refreshAll` records that source stale, and the bootstrap's own failure path is reached. */
const REFUSED = Symbol("refused");

/** A FRESH PAGE: its own vm context, its own feed, its own bootstrap timing. A section that needs a
 *  different boot ordering than the section before it cannot reuse a settled page, and one that
 *  quietly did would be asserting about a page whose bootstrap had already applied. */
function newPage(opts: { refuseMembershipRead?: boolean } = {}) {
  const openedAt: number[] = [];
  const fetchedAt: number[] = [];
  const state: { feed: { listeners: Record<string, (e: { data: string }) => void> } | null } = { feed: null };
  const thrown: string[] = [];
  const rafs: ((t: number) => void)[] = [];
  const drawn: string[] = [];

  // THE STALE BOOTSTRAP IS NOT EMPTY, IT IS OLD. A REST snapshot captured before the live agent
  // joined still HAS content: an agent that has since gone. An empty-list bootstrap can be beaten
  // by a defence as narrow as "ignore an empty roster", so a suite built on one proves less than it
  // reads; an OLDER NON-EMPTY snapshot can only be beaten by ordering. `local.O` is in the
  // bootstrap and absent from the live roster, and the live roster is a FULL snapshot on every
  // presence event (`ep.on("presence", () => broadcast("roster", ep.getRoster()))`, web.ts:462,
  // the same call `/api/roster` serves), so it supersedes rather than merges: `local.O` is gone.
  const STALE_ROSTER = [{ card: { id: "local.O", name: "old", kind: "agent" }, status: "waiting", ts: 1 }];
  const STALE_MEMBERS = { asOf: 1, members: [{ id: "local.O", live: ["general"], durable: [] }] };
  const payload = (u: string) => {
    if (u.includes("/api/meta")) return { space: "s" };
    if (u.includes("/api/channels")) return [{ channel: "general", messages: 1, replay: true, deliveryClass: "durable" }];
    if (u.includes("/api/roster")) return STALE_ROSTER;
    if (u.includes("/api/membership")) return opts.refuseMembershipRead ? REFUSED : STALE_MEMBERS;
    if (u.includes("/api/activity")) return { entries: [], partial: false, read: 1, of: 1, missing: [], deadlineMs: 8000 };
    return [];
  };

  const t0 = Date.now();
  const sandbox: Record<string, unknown> = {
    console,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: (fn: (t: number) => void) => { rafs.push(fn); return rafs.length; },
    // THE SLOW BOOTSTRAP. Every REST read the page makes answers only after READ_MS.
    fetch: (u: string) =>
      new Promise((res) => setTimeout(() => {
        fetchedAt.push(Date.now() - t0);
        const v = payload(u);
        if (v === REFUSED) res({ ok: false, status: 503, json: async () => ({ error: "membership read refused" }) });
        else res({ ok: true, status: 200, json: async () => v });
      }, READ_MS)),
    // THE FEED. Constructing it is exactly what turns the pill from `disconnected` to live.
    EventSource: class {
      onopen: unknown; onerror: unknown;
      constructor(_url: string) { openedAt.push(Date.now() - t0); state.feed = this as never; }
      listeners: Record<string, (e: { data: string }) => void> = {};
      addEventListener(kind: string, fn: (e: { data: string }) => void) { this.listeners[kind] = fn; }
    },
  };
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.matchMedia = () => ({ matches: false, addEventListener: () => {} });
  sandbox.location = { search: "", href: "http://localhost/graph" };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // STABLE ELEMENTS. `getElementById` returning a NEW stub per call throws away every write the page
  // makes, so any assertion over the DOM would be reading an object the page never touched.
  const els = new Map<string, Record<string, unknown>>();
  const byId = (id: string) => { if (!els.has(id)) els.set(id, stubEl(drawn)); return els.get(id)!; };
  sandbox.document = { getElementById: byId, addEventListener: () => {},
    querySelector: () => byId("_q"), querySelectorAll: () => [], title: "" };
  sandbox.devicePixelRatio = 1;
  // A VIEWPORT, because `resize()` reads `window.innerWidth`/`innerHeight` and nothing else sets W
  // and H. Without them W is undefined, `cam.x` is NaN, and every node's screen position is NaN, so
  // the viewport cull rejects the whole graph and the ONLY label the page ever draws is the one the
  // `a.status === "waiting"` escape hatch forces. A suite reading that as "the node is on the
  // graph" is reading one gate of three. With a real viewport the on-screen footprint gate
  // (`inView && foot >= 8`) is live, which is the path a browser always takes.
  sandbox.innerWidth = 1440;
  sandbox.innerHeight = 900;
  sandbox.performance = { now: () => Date.now() - t0 };

  // LOAD WHAT THE PAGE LOADS, IN THE PAGE'S ORDER, read out of graph.html rather than listed here,
  // so a script added to the page cannot silently go missing from this harness. An earlier draft
  // loaded only snapshot.js and graph.js; the page also loads harness.js, parts.js and
  // agui-frame.js, and the gap surfaced as `window.COTAL_PARTS` being undefined when a message
  // event was handled. That was the harness failing to be the page, not the page failing.
  const html = readFileSync(join(web, "graph.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="\/([^"]+\.js)"><\/script>/g)].map((m) => m[1]);
  // The list below is a TRIPWIRE, not the source: the harness runs whatever graph.html names, so a
  // sixth script would be loaded here automatically. What the literal pins is that the stub surface
  // in this file was chosen against THESE five. The last time that set changed under a hardcoded
  // harness the gap surfaced as an undefined global in the middle of an unrelated cell rather than
  // as a failure naming its cause. `graph.js` LAST matters on its own: its boot line runs at parse
  // time and reads globals the other four define, so a different order is a different program.
  const ctx = vm.createContext(sandbox);
  for (const s of scripts)
    vm.runInContext(readFileSync(join(web, s), "utf8"), ctx, { filename: s });

  /** Deliver one SSE event through the listener THE PAGE registered, and record a throw rather than
   *  letting it escape, so "did this break the page" is an assertion and not a crashed suite. */
  const deliver = (kind: string, data: unknown) => {
    const fn = state.feed?.listeners[kind];
    if (!fn) { thrown.push(`${kind}: no listener registered`); return; }
    try { fn({ data: typeof data === "string" ? data : JSON.stringify(data) }); }
    catch (e) { thrown.push(`${kind}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  /** Render one frame on demand and return the labels it drew. A copy, because the next frame
   *  clears the buffer and a caller holding the live array would watch its evidence disappear. */
  const frame = (t: number) => { drawn.length = 0; for (const fn of rafs.splice(0)) fn(t); return [...drawn]; };
  /** The text of a header pill, which is what a reader actually sees the page claim. */
  const pillText = (id: string) =>
    String((byId(id).querySelector as (s: string) => { textContent: unknown })(".t").textContent);

  return { openedAt, fetchedAt, thrown, rafs, drawn, byId, scripts, state, deliver, frame, pillText };
}

const PAGE_SCRIPTS = ["snapshot.js", "harness.js", "parts.js", "agui-frame.js", "graph.js"];

async function main() {
  console.log("0. the harness is the page, not a subset of it");
  const { fetchedAt, openedAt, thrown, rafs, drawn, byId, scripts, state, deliver, frame, pillText } = newPage();
  ok("0.1 the harness loads EXACTLY the scripts graph.html names, in the page's order, graph.js last",
    JSON.stringify(scripts) === JSON.stringify(PAGE_SCRIPTS), { scripts, expected: PAGE_SCRIPTS });

  console.log("1. the feed opens without waiting for the bootstrap read");
  await new Promise((r) => setTimeout(r, CONCURRENT_MS));
  const openedEarly = openedAt.length > 0;
  ok("1.1 THE FEED IS OPEN while the bootstrap read is still in flight, so the pill is not stuck at disconnected",
    openedEarly, { openedAt, fetchedSoFar: fetchedAt.length, waitedMs: CONCURRENT_MS, readTakesMs: READ_MS });
  ok("1.2 and it opened BEFORE any bootstrap read had answered, not merely early",
    openedEarly && fetchedAt.length === 0, { openedAt, fetchedAt });

  // ── 2. OPENING FIRST MUST NOT BREAK WHAT OPENING LAST PROTECTED ──────────────────────────────
  //
  // Connecting BEFORE the bootstrap means live events can now arrive while the structures they
  // mutate are still empty, which the chained boot made impossible by construction. That is the
  // hazard this change introduces, so it gets a cell rather than a reading of the source: drive a
  // roster, a membership and a message event in while every REST read is still in flight, and
  // require the page to survive all three.
  console.log("2. a live event that arrives before the bootstrap finishes does not break the page");
  const early = { roster: '[{"card":{"id":"local.X","name":"aa","kind":"agent"},"status":"waiting"}]',
                  membership: JSON.stringify({ asOf: Date.now(), members: [{ id: "local.X", live: ["general"], durable: [] }] }),
                  message: '{"mode":"chat","channel":"general","msg":{"id":"m","ts":1,"from":{"id":"local.X","name":"aa"},"parts":[{"kind":"text","text":"hi"}]}}' };
  for (const [kind, data] of Object.entries(early)) deliver(kind, data);
  ok("2.1 a roster, membership and message event delivered BEFORE any read answered are all survived",
    thrown.length === 0, thrown);
  ok("2.2 and the feed had registered a handler for each of them, so 2.1 is not vacuous",
    Object.keys(early).every((k) => !!state.feed?.listeners[k]),
    { registered: Object.keys(state.feed?.listeners ?? {}) });
  ok("2.3 the reads were still in flight while those events were handled, which is the whole point",
    fetchedAt.length === 0, { fetchedAt });

  // POSITIVE CONTROL: the arm has to be able to observe a feed that opens at all, or 1.1 would pass
  // vacuously on a page that never connects. Wait past the read and confirm the reads did land, so
  // the timing above was a real race and not a dead harness.
  await new Promise((r) => setTimeout(r, READ_MS));
  ok("1.3 control: the bootstrap reads DID answer, so 1.1 measured a race and not a broken harness",
    fetchedAt.length > 0, { fetchedAt: fetchedAt.length });
  ok("1.4 control: the feed was opened exactly once, not re-opened per read",
    openedAt.length === 1, { openedAt });

  // ── 3. EARLY LIVE TRUTH MUST SURVIVE THE LATE BOOTSTRAP ──────────────────────────────────────
  //
  // Surviving the event is not the same as keeping it, and this is the half the first version of
  // this suite missed. `refreshAll` awaits EVERY read and only then applies each one, and the feed
  // and the bootstrap call the SAME `updateRoster` / `applyMembership` with a full snapshot. So a
  // snapshot requested BEFORE a live event lands is applied AFTER it and silently wins. An empty
  // bootstrap roster then sets `present = false` and deletes the agent outright unless it is still
  // a feed member, and an empty membership clears `memberOf`, so the agent the feed just told us
  // about disappears from the graph. Opening the feed first is what creates this ordering; the
  // chained boot could not produce it, so the fix has to carry the rule rather than inherit it.
  console.log("3. the live snapshot is not overwritten by an older bootstrap snapshot");
  const afterBootstrap = frame(1000);
  ok("3.1 THE AGENT THE FEED ANNOUNCED IS STILL ON THE GRAPH after every bootstrap read has applied",
    afterBootstrap.includes("aa"), { drawnLabels: afterBootstrap.slice(0, 12) });
  // CONTROL: prove the renderer draws agent labels at all, or 3.1 could pass by never drawing
  // anything and never failing for the reason it names.
  deliver("roster", '[{"card":{"id":"local.Y","name":"zz","kind":"agent"},"status":"waiting"}]');
  const afterLate = frame(1001);
  ok("3.2 control: a roster delivered AFTER the bootstrap does render, so 3.1 tests ordering and not a dead renderer",
    afterLate.includes("zz"), { drawnLabels: afterLate.slice(0, 12) });
  // MEMBERSHIP IS A SECOND, INDEPENDENT HALF OF THE SAME RULE, and 3.1 is blind to it: with the
  // roster half guarded the agent stays on the graph even when its membership has been wrongly
  // cleared, so a mutation of the membership half SURVIVED until this cell existed. The pill is the
  // right observable because a reverted membership reads exactly like the symptom that started this
  // work: a live feed reported as traffic-only or stale.
  ok("3.3 the membership PILL still reports the live feed, not the older bootstrap's stale snapshot",
    pillText("feed") === "membership: live", { pill: pillText("feed") });
  // AND THE RULE IS DROP, NOT MERGE, which 3.1 alone cannot tell apart. The bootstrap here is not
  // empty, it is OLD: it names an agent the live snapshot no longer carries. Since the feed sends
  // the WHOLE roster on every presence event, an agent missing from it is genuinely gone, so an
  // implementation that merged the two snapshots instead of dropping the older one would keep 3.1
  // green and resurrect a departed agent onto the graph. Read off the SAME frame as 3.1.
  ok("3.4 and the agent only the STALE bootstrap knew about is not resurrected onto the graph",
    !afterBootstrap.includes("old"), { drawnLabels: afterBootstrap.slice(0, 12) });

  // ── 4. A UNICAST NAMING SOMEONE THE GRAPH HAS NEVER SEEN INVENTS NOTHING ─────────────────────
  //
  // Opening the feed first lets a message name a recipient before any roster has introduced them,
  // which the chained boot made impossible by construction. The page reads the recipient with
  // `agents.get` and falls back to the raw id for the label; it deliberately does NOT `ensureAgent`
  // them, so an unknown recipient neither crashes the handler nor becomes a node. The second half
  // is worth more than tidiness: a node conjured out of a message's own metadata is a node no
  // presence ever vouched for. Both halves are DRIVEN here, not read off the source.
  console.log("4. a unicast naming an unknown recipient neither crashes nor invents a node");
  const ABSENT = "local.UZZ7QK4A5MHTKC3PZWL6RGYD4XN2VJBQF5HSEMR7TW6YUAO3IPCD";
  const before = thrown.length;
  deliver("message", { mode: "unicast", msg: { id: "u", ts: Date.now(),
    from: { id: "local.Y", name: "zz" }, to: ABSENT, parts: [{ kind: "text", text: "hi" }] } });
  ok("4.1 the handler survives a recipient no roster has ever introduced", thrown.length === before,
    thrown.slice(before));
  // Both hide filters ship ON, and an invented node would be offline AND edgeless, so it would be
  // hidden and 4.2 would pass for the wrong reason. Turn them off through the page's OWN controls,
  // which is what a reader does when they want to see everything.
  (byId("hideOffline").onclick as () => void)();
  (byId("hideEmpty").onclick as () => void)();
  const afterUnicast = frame(1002);
  ok("4.2 and the unknown recipient did NOT become a node on the graph",
    !afterUnicast.includes(ABSENT), { drawnLabels: afterUnicast.slice(0, 12) });
  // CONTROL: the SAME id, announced by a roster whose card carries no name, takes the raw id as its
  // label and is drawn. So 4.2 goes red when a node is invented, rather than passing because a node
  // labelled by a raw id is something this arm could never have seen in the first place.
  deliver("roster", [{ card: { id: ABSENT, kind: "agent" }, status: "waiting", ts: 1 }]);
  const afterAnnounce = frame(1003);
  ok("4.3 control: that same id, once a roster announces it, IS drawn under its raw id",
    afterAnnounce.includes(ABSENT), { drawnLabels: afterAnnounce.slice(0, 12) });

  // ── 5. THE MEMBERSHIP SOURCE SPEAKS TWICE, AND BOTH SENTENCES OBEY THE ORDERING RULE ─────────
  //
  // `membership` is not one signal. It is a source with TWO live sentences and TWO bootstrap ones:
  // a snapshot, and a REFUSAL. Section 3 covers the snapshot pair, and the rule was written onto
  // the apply wrappers, which is exactly where a snapshot lands and where a refusal does not. So
  // both refusals slip past it, in opposite directions, and each puts a false claim into the header
  // pill: the one place this page is asked to say how far to trust what it is showing.
  //
  // Two pages, booted together and read twice: once the instant the live sentence lands, once after
  // the bootstrap has settled on top of it. The first read of each pair is what makes the second
  // one mean something.
  console.log("5. a membership REFUSAL obeys the same ordering rule as a membership snapshot");
  // 5a: the LIVE sentence is the refusal. The server tells the feed it could not read membership;
  // the `/api/membership` read was issued BEFORE that and answers after it, and `applyMembership`
  // opens with `feed.unreadable = false`, so an older success erases a newer refusal.
  const liveRefused = newPage();
  // 5b: the MIRROR, which is where a one-directional rule always breaks next. The live snapshot is
  // good and the BOOTSTRAP read refuses. Its failure path runs after every read settles and calls
  // `membershipUnreadable()` OUTSIDE the apply wrapper, so a page whose feed is delivering
  // membership perfectly well announces that it cannot read membership at all. On the slow link
  // this whole lane is about, that read is the one most likely to refuse.
  const bootRefused = newPage({ refuseMembershipRead: true });
  liveRefused.deliver("membership-read-failed", {});
  bootRefused.deliver("membership", { asOf: Date.now(), members: [{ id: "local.X", live: ["general"], durable: [] }] });
  ok("5.1 the live REFUSAL reaches the pill at once, so 5.2 has something to survive with",
    liveRefused.pillText("feed") === "membership: unreadable", { pill: liveRefused.pillText("feed") });
  ok("5.3 the live SNAPSHOT reaches the pill at once, so 5.4 has something to survive with",
    bootRefused.pillText("feed") === "membership: live", { pill: bootRefused.pillText("feed") });
  await new Promise((r) => setTimeout(r, READ_MS + CONCURRENT_MS));
  ok("5.2 AND THE REFUSAL SURVIVES the older successful bootstrap read landing on top of it",
    liveRefused.pillText("feed") === "membership: unreadable", { pill: liveRefused.pillText("feed") });
  ok("5.4 AND THE SNAPSHOT SURVIVES the bootstrap read refusing after it, which is a fact about that one read",
    bootRefused.pillText("feed") === "membership: live", { pill: bootRefused.pillText("feed") });
}

await main();
console.log(failed === 0 ? `web graph boot: ${cells} cells OK` : `web graph boot: ${failed}/${cells} FAILED`);
process.exit(failed === 0 ? 0 : 1);
