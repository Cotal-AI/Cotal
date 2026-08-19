/**
 * THE LIVE FEED IS NOT GATED BEHIND THE SLOW BOOTSTRAP READ.
 *
 * The graph page's connection pill is driven by ONE thing: `EventSource("/feed")` opening. Until it
 * does, the header reads `disconnected`. The page booted as
 *
 *     load().catch((err) => console.error(err)).then(connect);
 *
 * so the feed was not opened until the ENTIRE bootstrap settled, and that bootstrap reads
 * `/api/activity?limit=400` and `/api/dms?limit=400`, both bounded by the aggregation deadline. On a
 * slow link the page therefore reads `disconnected` for the whole load window and only then goes
 * live. Reported from a real deployment observed across a WAN link: "always showing disconnected,
 * and taking long to show the graph".
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
  el.querySelector = () => stubEl();
  el.querySelectorAll = () => [];
  return el;
}

console.log("0. the harness is the page, not a subset of it");
async function main() {
  const openedAt: number[] = [];
  const fetchedAt: number[] = [];
  let feed: { listeners: Record<string, (e: { data: string }) => void> } | null = null;
  const thrown: string[] = [];
  const rafs: ((t: number) => void)[] = [];
  const drawn: string[] = [];

  const payload = (u: string) => {
    if (u.includes("/api/meta")) return { space: "s" };
    if (u.includes("/api/channels")) return [];
    if (u.includes("/api/roster")) return [];
    if (u.includes("/api/membership")) return { members: [] };
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
        res({ ok: true, status: 200, json: async () => payload(u) });
      }, READ_MS)),
    // THE FEED. Constructing it is exactly what turns the pill from `disconnected` to live.
    EventSource: class {
      onopen: unknown; onerror: unknown;
      constructor(_url: string) { openedAt.push(Date.now() - t0); feed = this as never; }
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
  sandbox.performance = { now: () => Date.now() - t0 };

  // LOAD WHAT THE PAGE LOADS, IN THE PAGE'S ORDER, read out of graph.html rather than listed here,
  // so a script added to the page cannot silently go missing from this harness. An earlier draft
  // loaded only snapshot.js and graph.js; the page also loads harness.js, parts.js and
  // agui-frame.js, and the gap surfaced as `window.COTAL_PARTS` being undefined when a message
  // event was handled. That was the harness failing to be the page, not the page failing.
  const html = readFileSync(join(web, "graph.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="\/([^"]+\.js)"><\/script>/g)].map((m) => m[1]);
  ok("0.1 the harness loads every script the page loads, discovered from graph.html not hardcoded",
    scripts.length >= 4 && scripts.includes("graph.js"), { scripts });
  const ctx = vm.createContext(sandbox);
  for (const s of scripts)
    vm.runInContext(readFileSync(join(web, s), "utf8"), ctx, { filename: s });

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
                  membership: '{"members":[{"id":"local.X","live":["general"],"durable":[]}]}',
                  message: '{"mode":"chat","channel":"general","msg":{"id":"m","ts":1,"from":{"id":"local.X","name":"aa"},"parts":[{"kind":"text","text":"hi"}]}}' };
  for (const [kind, data] of Object.entries(early)) {
    const fn = feed?.listeners[kind];
    if (!fn) { thrown.push(`${kind}: no listener registered`); continue; }
    try { fn({ data }); } catch (e) { thrown.push(`${kind}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  ok("2.1 a roster, membership and message event delivered BEFORE any read answered are all survived",
    thrown.length === 0, thrown);
  ok("2.2 and the feed had registered a handler for each of them, so 2.1 is not vacuous",
    Object.keys(early).every((k) => !!feed?.listeners[k]),
    { registered: Object.keys(feed?.listeners ?? {}) });
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
  drawn.length = 0;
  for (const fn of rafs.splice(0)) fn(1000);
  ok("3.1 THE AGENT THE FEED ANNOUNCED IS STILL ON THE GRAPH after every bootstrap read has applied",
    drawn.includes("aa"), { drawnLabels: drawn.slice(0, 12) });
  // CONTROL: prove the renderer draws agent labels at all, or 3.1 could pass by never drawing
  // anything and never failing for the reason it names.
  const fn2 = feed?.listeners["roster"];
  if (fn2) fn2({ data: '[{"card":{"id":"local.Y","name":"zz","kind":"agent"},"status":"waiting"}]' });
  drawn.length = 0;
  for (const fn of rafs.splice(0)) fn(1001);
  ok("3.2 control: a roster delivered AFTER the bootstrap does render, so 3.1 tests ordering and not a dead renderer",
    drawn.includes("zz"), { drawnLabels: drawn.slice(0, 12) });
}

await main();
console.log(failed === 0 ? `web graph boot: ${cells} cells OK` : `web graph boot: ${failed}/${cells} FAILED`);
process.exit(failed === 0 ? 0 : 1);
