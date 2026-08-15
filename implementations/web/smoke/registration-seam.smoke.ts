/**
 * THE SEAM A LATER RENDERER REGISTERS THROUGH, asserted before anything registers through it.
 *
 * `parts.js` names an undrawable part instead of deleting it. The next step is for a surface to
 * acquire a real renderer for one of those kinds, published into `window.COTAL_PARTS` by a separate
 * served file. That file does not exist yet, and these cells exist so it cannot land wrong.
 *
 * TWO WAYS THIS SURFACE BREAKS, BOTH ALREADY OBSERVED ON IT:
 *
 *   1. `web.ts`'s `PAGE` map is the real router. A file the HTML requests but the map does not
 *      list is a 404 — the page renders, the script is simply absent, and nothing anywhere says so.
 *   2. Script order is load-bearing. A registrant that runs BEFORE `parts.js` writes into an object
 *      that does not exist yet; a registrant that runs AFTER the page script registers too late for
 *      the first render. Neither throws. The visible result of both is
 *      `[unrenderable part kind "…" — no renderer for it on this surface]` — a TRUE message about a
 *      FALSE cause, which is the worst failure this seam can produce: an honest refusal that
 *      misattributes, and therefore sends the reader to look for a missing renderer that is present.
 *
 * WHY THESE CELLS ARE NAME-FREE. The registrant's filename is not known here and is another lane's
 * to choose. Asserting a name would either block on that choice or bake in a guess. Instead the
 * cells derive their subjects from the two page HTMLs and from `PAGE` itself, so a file added later
 * is covered on the day it is added, by cells nobody has to remember to update.
 *
 * The load-order cell works by pinning the WINDOW rather than the occupant: `/parts.js` opens it and
 * the page script closes it. A script appended after the page script is outside the window and
 * reddens cell 4 even though this file has never heard its name.
 *
 * `implementations/web/tsconfig.json` excludes `src/web`, so no compiler in this repo reads any file
 * these cells are about. Executable cells over the shipped bytes are the only enforcement here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE } from "../src/web.js";

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, "..", "src", "web");

let cells = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  cells++;
  assert.ok(cond, `${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  console.log(`  ok  ${name}`);
};

/** Every `src="/…"` in document order. The browser executes classic scripts in exactly this order. */
const scriptsOf = (html: string): string[] =>
  [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);

const PAGES = [
  { page: "index.html", consumer: "/app.js" },
  { page: "graph.html", consumer: "/graph.js" },
] as const;

// ── NON-VACUITY, before any cell that quantifies over the scripts ────────────────────────────────
// Every assertion below is a `.every()` or an index comparison over this list. An empty list makes
// all of them pass while proving nothing, so the count is asserted first and printed — a renamed
// file or a changed tag shape shows up here rather than as a silent green further down.
const loaded = new Map<string, string[]>();
for (const { page } of PAGES) {
  const scripts = scriptsOf(readFileSync(join(webSrc, page), "utf8"));
  loaded.set(page, scripts);
  ok(`NON-VACUITY: ${page} loads at least one script (scan found tags to quantify over)`,
    scripts.length > 0, { found: scripts.length });
  console.log(`      ${page}: ${scripts.join(" ")}`);
}

// ── CELL 1: the allow-list is the router, so every requested script must have a row ──────────────
for (const { page } of PAGES) {
  const missing = loaded.get(page)!.filter((src) => PAGE[src] === undefined);
  ok(`${page}: every script it requests has a PAGE row (a missing row is a 404, whatever the HTML says)`,
    missing.length === 0, { missing });
}

// ── POSITIVE CONTROL on cell 1's lookup ──────────────────────────────────────────────────────────
// `PAGE[src] === undefined` returning nothing for every entry is the same output as a lookup that
// cannot miss. This proves the miss is reachable, so the zero above is an absence rather than a
// broken predicate.
ok("CONTROL: a path that is not served IS absent from PAGE (the miss is reachable)",
  PAGE["/definitely-not-served.js"] === undefined);

// ── CELL 2: the dispatcher is served at all ──────────────────────────────────────────────────────
ok("web.ts serves /parts.js from its allow-list (the registration target must be reachable)",
  PAGE["/parts.js"] !== undefined);

// ── CELL 3: the window OPENS before the consumer runs ────────────────────────────────────────────
for (const { page, consumer } of PAGES) {
  const scripts = loaded.get(page)!;
  const parts = scripts.indexOf("/parts.js");
  const own = scripts.indexOf(consumer);
  ok(`${page}: /parts.js loads before ${consumer} (later leaves the dispatcher undefined at first use)`,
    parts !== -1 && own !== -1 && parts < own, { parts, own });
}

// ── CELL 4: the window CLOSES at the consumer, so a later file lands inside it ───────────────────
// This is the cell that covers a registrant nobody has named. A new script tag is appended in
// practice; if it is appended AFTER the page script it registers too late for the first render and
// the page shows an honest refusal for a renderer that is present. Requiring the consumer to be
// LAST turns that mistake into a red cell instead of a misattributed message.
for (const { page, consumer } of PAGES) {
  const scripts = loaded.get(page)!;
  ok(`${page}: ${consumer} is the LAST script (so anything added later lands inside the window /parts.js opened)`,
    scripts[scripts.length - 1] === consumer, { last: scripts[scripts.length - 1] });
}

console.log(`\nREGISTRATION SEAM SMOKE OK ✅  (${cells} passed, 0 failed)`);
