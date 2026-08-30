/**
 * THE DASHBOARD MUST NAME A BLIND OBSERVER, NOT EMPTY THE ONLINE LIST.
 *
 * A stalled presence watch is a fact about THIS window onto the mesh. The sidebar is an
 * online-only list by design (David: that stands). So the honest page keeps last-known
 * online rows and marks the roster source stale. These cells drive the shipped
 * `applyPresenceView` from both pages, and the server event the pages listen for.
 *
 * WHAT THIS DOES NOT CLAIM. No broker, no stall, no pixels. The endpoint verdict lives in
 * `smoke:presence-watch-stall`. This file is the surface: a `presence-view` event reaches
 * the same stale pill the polls already use, and a poll cannot erase that mark.
 *
 * Run: pnpm smoke:web-presence-view
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const webSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) return;
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};

const appJs = readFileSync(join(webSrc, "web/app.js"), "utf8");
const graphJs = readFileSync(join(webSrc, "web/graph.js"), "utf8");
const webTs = readFileSync(join(webSrc, "web.ts"), "utf8");

ok("0.1 the server maps /app.js and /graph.js in PAGE (a module no route reaches is a module no page runs)",
  /"\/app\.js": \{ path: join\(here, "web\/app\.js"/.test(webTs)
    && /"\/graph\.js": \{ path: join\(here, "web\/graph\.js"/.test(webTs));

const extract = (src: string, name: string): string | null => {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const brace = src.indexOf("{", start);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
};

const drive = (src: string, filename: string) => {
  const fn = extract(src, "applyPresenceView");
  ok(`1.${filename} ships applyPresenceView (a restated copy would not be the page)`, Boolean(fn));
  if (!fn) return { marks: [] as unknown[] };
  const marks: unknown[] = [];
  const ctx = createContext({
    marks,
    markStale: (name: string, entry: unknown) => { marks.push({ name, entry }); },
    Date,
  });
  runInContext(`${fn}; applyPresenceView({ fresh: false, staleSince: 1 }); applyPresenceView({ fresh: true });`, ctx, { filename });
  return { marks };
};

const app = drive(appJs, "app.js");
ok("1.1 Monitor: a stale view marks the roster source, not a peer",
  app.marks[0]?.name === "roster" && app.marks[0]?.entry?.name === "roster"
    && /observer presence watch silent since/.test(app.marks[0]?.entry?.reason ?? ""),
  app.marks[0]);
ok("1.2 Monitor: a fresh view CLEARS that mark (recovery is per source)",
  app.marks[1]?.name === "roster" && app.marks[1]?.entry == null, app.marks[1]);

const graph = drive(graphJs, "graph.js");
ok("1.3 Graph: the same stale view marks roster",
  graph.marks[0]?.name === "roster" && graph.marks[0]?.entry?.name === "roster", graph.marks[0]);
ok("1.4 Graph: a fresh view clears it",
  graph.marks[1]?.name === "roster" && graph.marks[1]?.entry == null, graph.marks[1]);

ok("2.1 both pages listen for the presence-view SSE event",
  /addEventListener\("presence-view"/.test(appJs) && /addEventListener\("presence-view"/.test(graphJs));
ok("2.2 the server broadcasts presence-view from the endpoint event (not a restated poll)",
  /ep\.on\("presence-view"/.test(webTs) && /broadcast\("presence-view"/.test(webTs));
ok("2.3 a new /feed client is seeded with the current view, not only the roster",
  /send\(res, "presence-view", ep\.presenceView\(\)\)/.test(webTs));
ok("2.4 roster pushes are trailing-edge debounced so a replay burst is one render",
  /const pushRoster = debounce\(\(\) => broadcast\("roster", rosterSnapshot\(\)\), 150\)/.test(webTs)
    && /ep\.on\("presence", \(\) => pushRoster\(\)\)/.test(webTs));
ok("2.5 a poll cannot erase the observer-view mark: both pages keep a roster entry across setStale",
  /const rosterView = staleNow\.find\(\(s\) => s\.name === "roster"\)/.test(appJs)
    && /const rosterView = staleNow\.find\(\(s\) => s\.name === "roster"\)/.test(graphJs));
ok("2.6 the sidebar filter is still online-only (this change does not gray rows out)",
  /filter\(\(p\) => p\.status !== "offline"\)/.test(appJs));

console.log(`\nweb presence-view smoke: ${cells - failed} passed, ${failed} failed`);
if (failed) process.exit(1);
