/**
 * A FAILED MEMBERSHIP READ MUST NOT BE SERVED AS A SUCCESSFUL EMPTY ONE.
 *
 * The observer's `/api/membership` route answered a read failure with
 * `{asOf: undefined, members: []}` and a 200. `JSON.stringify` DROPS a key whose value is
 * `undefined`, so those bytes are `{"members":[]}` — byte-identical to a successful read of a space
 * where nobody is subscribed. The one field that might have separated the two never reached the
 * wire. Downstream, the graph's pill read that as `membership: traffic-only`, which is a CLAIM
 * ABOUT THE MESH (no membership feed is being published) standing in for a fact about US (we could
 * not find out). The operator's own viewer reported traffic-only against a mesh that had a feed and
 * nothing on the page could have revealed the difference.
 *
 * Two silences fed the same display and both are covered here: the HTTP route, and the browser's
 * own `.catch(() => ({members: []}))` at boot, which manufactured the same empty snapshot when the
 * fetch itself failed.
 *
 * WHAT IS DRIVEN. The shipped statements are EXTRACTED from the files that ship them and EXECUTED —
 * the route block and `json` out of `web.ts`, the pill out of `graph.js`. Neither file can be
 * imported whole (the route closes over a live endpoint; the page drives the DOM at load), so this
 * follows the extraction precedent already in this directory. A substring check would prove a line
 * was TYPED; it goes red on a reformat and stays green on a statement that stopped doing what its
 * name says.
 *
 * The HTTP status and the response bytes are read off a recording `ServerResponse`, not off the
 * arguments passed to a stubbed helper — the shipped `json` sets the status, so stubbing it would
 * have left the 503 unmeasured.
 *
 * NOT DRIVEN, and no cell implies it: that a live broker with no membership stream makes
 * `readMembership` reject. These cells stand on the narrower fact that WHEN it rejects, the refusal
 * is distinguishable from data at every surface that carries it.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { MEMBERSHIP_READ_FAILED } from "../src/web.js";

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Lift a braced construct out of shipped source by matching braces from an anchor. Returns null
 *  when the anchor is absent — see the positive control below, which proves that miss is real. */
const lift = (src: string, anchor: string): string | null => {
  const start = src.indexOf(anchor);
  if (start === -1) return null;
  let i = src.indexOf("{", start), depth = 0;
  if (i === -1) return null;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1);
  }
  return null;
};

const webTs = read("../src/web.ts");
const graphJs = read("../src/web/graph.js");

const routeBlock = lift(webTs, 'if (path === "/api/membership")');
const jsonHelper = lift(webTs, "function json(res: ServerResponse");
const pill = lift(graphJs, "function setFeed()");

// ── NON-VACUITY, before anything executes ───────────────────────────────────────────────────────
check("the /api/membership route block was lifted out of web.ts", Boolean(routeBlock), { len: routeBlock?.length });
check("the json helper was lifted out of web.ts", Boolean(jsonHelper), { len: jsonHelper?.length });
check("the membership pill was lifted out of graph.js", Boolean(pill), { len: pill?.length });

// POSITIVE CONTROL on the lifter: an anchor that is not in the file must come back null, so the
// three successes above are matches rather than a lifter that cannot miss.
check("CONTROL: an absent anchor lifts nothing (the miss is reachable)",
  lift(webTs, 'if (path === "/api/definitely-not-a-route")') === null);

// ── The server surface, executed ────────────────────────────────────────────────────────────────
type Recorded = { status: number; body: string };

/** Run the SHIPPED route block against a readMembership of our choosing and record what a browser
 *  would actually receive: the status line and the response bytes. */
const serve = async (readMembership: () => Promise<unknown>): Promise<Recorded> => {
  const rec: Recorded = { status: 0, body: "" };
  const res = {
    writeHead: (status: number) => { rec.status = status; },
    end: (body: string) => { rec.body = body; },
  };
  const source = ts.transpileModule(
    `${jsonHelper}\nglobalThis.__run = async () => { ${routeBlock} };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const ctx: Record<string, unknown> = {
    path: "/api/membership",
    res,
    ep: { readMembership },
    MEMBERSHIP_READ_FAILED,
    globalThis: undefined,
    console,
  };
  ctx.globalThis = ctx;
  runInContext(source, createContext(ctx), { filename: "web.ts (route)" });
  await (ctx.__run as () => Promise<void>)();
  return rec;
};

const okFull = await serve(async () => ({ asOf: 1700000000000, members: [{ id: "a", live: true }] }));
check("a successful read is served 200", okFull.status === 200, okFull.status);
check("a successful read carries its members", okFull.body.includes('"id":"a"'), okFull.body);

const okEmpty = await serve(async () => ({ members: [] }));
check("a successful EMPTY read is still 200", okEmpty.status === 200, okEmpty.status);
check('a successful EMPTY read is the bytes {"members":[]}', okEmpty.body === '{"members":[]}', okEmpty.body);

const failed = await serve(async () => { throw new Error("membership stream not found"); });
check("a FAILED read is not served 200", failed.status !== 200, failed.status);
check("a FAILED read is served 503", failed.status === 503, failed.status);
check("a FAILED read NAMES its condition, using the exported token rather than a restated string",
  JSON.parse(failed.body).error === MEMBERSHIP_READ_FAILED, failed.body);

// THE CELL THE DEFECT IS ABOUT. Everything above could hold while the two responses were still
// indistinguishable to a client that reads only the body — which is exactly what shipped.
check("THE REFUSAL AND THE EMPTY SUCCESS ARE DIFFERENT BYTES (the defect, stated directly)",
  failed.body !== okEmpty.body, { failed: failed.body, empty: okEmpty.body });
check("…and different statuses, so a client that checks only the status also cannot confuse them",
  failed.status !== okEmpty.status, { failed: failed.status, empty: okEmpty.status });

// ── The browser surface, executed ───────────────────────────────────────────────────────────────
/** Run the SHIPPED pill against a feed state and return the text the operator reads. */
const pillText = (feed: Record<string, unknown>): string => {
  let text = "";
  const el = { hidden: true, className: "", querySelector: () => ({ set textContent(v: string) { text = v; } }) };
  const ctx = {
    feed,
    FEED_STALE_MS: 45000,
    now: () => 1700000000000,
    $: (id: string) => (id === "feed" ? el : null),
  };
  runInContext(`${pill}\nsetFeed();`, createContext(ctx), { filename: "graph.js (pill)" });
  return text;
};

check("an unreadable feed says so", pillText({ unreadable: true }) === "membership: unreadable", pillText({ unreadable: true }));
check("a mesh with no feed still reads traffic-only (the honest use of that phrase is preserved)",
  pillText({ available: false }) === "membership: traffic-only", pillText({ available: false }));
check("a fresh feed still reads live (the pill's other states are not collateral damage)",
  pillText({ available: true, asOf: 1700000000000 }) === "membership: live", pillText({ available: true, asOf: 1700000000000 }));

check("THE PILL DISTINGUISHES 'could not read' FROM 'nothing to read' (the display half of the defect)",
  pillText({ unreadable: true }) !== pillText({ available: false }));
// Order matters: `unreadable` arrives with no members, so a pill testing `available` first would
// report traffic-only for it and this cell is what holds that ordering in place.
check("an unreadable feed reports unreadable EVEN THOUGH it is also unavailable (ordering is load-bearing)",
  pillText({ unreadable: true, available: false }) === "membership: unreadable",
  pillText({ unreadable: true, available: false }));

console.log(`\nMEMBERSHIP REFUSAL SMOKE OK ✅  (${pass} passed, 0 failed)`);
