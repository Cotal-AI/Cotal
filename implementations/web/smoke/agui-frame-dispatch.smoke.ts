/**
 * The dashboard can DISPLAY an AG-UI frame — served, loaded, registered, dispatched.
 *
 * `parts.js` names a kind it cannot draw; that is a refusal, not a rendering, and it was never the
 * end state. `agui-frame.js` teaches this surface to draw `ag-ui.frame` by registering a renderer
 * into `window.COTAL_PART_RENDERERS`, which `parts.js` consults before its fallbacks. This suite
 * measures the SEAM: that the file is served, loaded in an order that works, registered under the
 * right kind, and actually reached by the dispatcher — plus how the seam fails.
 *
 * THE SPLIT, because three suites now touch this path and each owns exactly one claim:
 *   · `parts-non-silence.smoke.ts` — the NO-RENDERER fallbacks (a kind nothing taught this surface).
 *   · `bin/smoke/agui-render-parity.smoke.ts` — that the text produced here is BYTE-IDENTICAL to the
 *     renderer every other surface uses. No parity cell lives in this file.
 *   · this file — that a frame reaches the renderer at all on this surface.
 * A single suite asserting all three would let one green light stand for three different facts.
 *
 * WHAT IT DRIVES. Both files are READ OFF DISK and evaluated in a `vm` context with a stub `window`,
 * exactly as classic `<script>`s run, in the same context and the same order the pages load them.
 * The route table is the REAL `PAGE` export. Nothing is restated, so no cell can pass against a
 * version that no longer ships.
 *
 * WHAT IT DOES NOT CLAIM. It does not open a browser and asserts no DOM. `app.js` renders through
 * `MD.render` and `graph.js` through `esc(...).slice(0, 160)`, and neither last hop is measured
 * here. So: the text is produced and the producer is wired in — not that it survives to the pixels.
 * That gap is the same one `parts-non-silence.smoke.ts` names, and it is still open.
 *
 * Run: pnpm smoke:agui-frame-dispatch
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { PAGE } from "../src/web.js";

const here = dirname(fileURLToPath(import.meta.url));
const webSrc = join(here, "..", "src", "web");

let cells = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  cells++;
  assert.ok(cond, `${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  console.log(`  ok  ${name}`);
};

const KIND = "ag-ui.frame";
const MARKER = `[unrenderable part kind ${JSON.stringify(KIND)} — no renderer for it on this surface]`;
const partsSource = readFileSync(join(webSrc, "parts.js"), "utf8");
const frameSource = readFileSync(join(webSrc, "agui-frame.js"), "utf8");

/** A page-like context: the given files, in the given order, as classic scripts. */
function page(...sources: [string, string][]) {
  const ctx: { window: Record<string, unknown> } = { window: {} };
  const c = createContext(ctx);
  for (const [name, src] of sources) runInContext(src, c, { filename: name });
  const api = ctx.window.COTAL_PARTS as { partsToText(parts: unknown[]): string };
  return { ctx, render: (parts: unknown[]) => api.partsToText(parts) };
}

const FRAME = {
  kind: KIND, protocol: "ag-ui/1", threadId: "t1", runId: "r1", epoch: 3, seq: 7,
  events: [
    { type: "RUN_STARTED", runId: "r1" },
    { type: "TEXT_MESSAGE_START", messageId: "m1" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: "m1", delta: "hello" },
    { type: "TEXT_MESSAGE_END", messageId: "m1" },
    { type: "RUN_FINISHED", runId: "r1", outcome: { type: "success" } },
  ],
};

// ── NEGATIVE CONTROL FIRST: the surface WITHOUT the renderer ─────────────────────────────────────
// This is the state main shipped in, and it is the control that gives every cell below its meaning.
// Without it, "a frame renders its text" could be true because parts.js was always able to draw one
// — which would make the new file decorative. The refusal must be real before the fix can be.
const bare = page(["parts.js", partsSource]);
ok("CONTROL: with agui-frame.js NOT loaded, a frame is refused by name (the state before this change)",
  bare.render([FRAME]) === MARKER, { got: bare.render([FRAME]) });

// ── The seam, loaded as the pages load it ────────────────────────────────────────────────────────
const taught = page(["parts.js", partsSource], ["agui-frame.js", frameSource]);
ok("agui-frame.js registers a function under EXACTLY the frame kind",
  typeof (taught.ctx.window.COTAL_PART_RENDERERS as Record<string, unknown>)?.[KIND] === "function",
  { keys: Object.keys((taught.ctx.window.COTAL_PART_RENDERERS as object) ?? {}) });

const drawn = taught.render([FRAME]);
ok("a frame is now DRAWN, not refused (the marker is gone)", drawn !== MARKER, { isMarker: drawn === MARKER });
ok("and the drawing carries the frame's actual content",
  drawn.includes("hello") && drawn.includes("r1"), { len: drawn.length });
ok("the run is bracketed — started and finished both visible",
  drawn.includes("started") && drawn.includes("finished"), { len: drawn.length });

// A frame carries NO text part by design, so this is the whole point of the file: content that was
// unreachable through `parts.js` alone is now reachable.
ok("REGRESSION ORACLE: the frame carries no `text` part, so nothing else could have shown this",
  !("text" in FRAME) && (FRAME as { data?: unknown }).data === undefined);

// ── SCRIPT ORDER MUST NOT MATTER, and that is a property of the code, not a hope ─────────────────
// `parts.js` reads the registry at CALL time and `agui-frame.js` creates the map if absent, so
// either order works. Asserted both ways: an order-dependent seam is a bug that only appears when
// someone reorders two <script> tags, which is the least reviewed edit anyone makes.
const reversed = page(["agui-frame.js", frameSource], ["parts.js", partsSource]);
ok("registration BEFORE the dispatcher also works (order-independent seam)",
  reversed.render([FRAME]) === drawn, { same: reversed.render([FRAME]) === drawn });

// ── HOW THE SEAM FAILS, which is the half nobody writes ──────────────────────────────────────────
// A renderer that throws must not blank the body — that is the exact failure `parts.js` exists to
// remove, and re-introducing it through the extension seam would be the same bug with a new door.
const boom = page(["parts.js", partsSource]);
(boom.ctx.window as { COTAL_PART_RENDERERS?: Record<string, unknown> }).COTAL_PART_RENDERERS = {
  [KIND]: () => { throw new Error("renderer exploded"); },
};
const boomed = boom.render([FRAME]);
ok("a THROWING renderer degrades to a named marker, not a blank body",
  boomed.includes(KIND) && boomed.includes("failed"), { got: boomed });
ok("and it does not fall through to the raw-data fallback (a different fact, wrongly reported)",
  !boomed.includes("RUN_STARTED"), { got: boomed });
ok("a throwing renderer does not take the whole message down (neighbouring text survives)",
  boom.render([{ kind: "text", text: "before" }, FRAME]).startsWith("before "));

const wrong = page(["parts.js", partsSource]);
(wrong.ctx.window as { COTAL_PART_RENDERERS?: Record<string, unknown> }).COTAL_PART_RENDERERS = {
  [KIND]: () => ({ not: "a string" }) as unknown as string,
};
const wronged = wrong.render([FRAME]);
ok("a renderer returning a NON-STRING is named, not coerced into [object Object]",
  wronged.includes(KIND) && wronged.includes("expected a string") && !wronged.includes("[object Object]"),
  { got: wronged });

// A registered non-function must not be called, and must not be mistaken for a renderer.
const bogus = page(["parts.js", partsSource]);
(bogus.ctx.window as { COTAL_PART_RENDERERS?: Record<string, unknown> }).COTAL_PART_RENDERERS = { [KIND]: "nope" };
ok("a non-function registration falls through to the fallbacks instead of throwing",
  bogus.render([FRAME]) === MARKER, { got: bogus.render([FRAME]) });

// ── THE INHERITED-PROPERTY DOOR, which a plain object on `window` opens and a Map does not ──────
// `p.kind` comes off the wire. A plain object inherits `toString`, `valueOf` and `constructor` from
// `Object.prototype`, and every one of them is a function, so an unguarded `renderers[p.kind]`
// RESOLVES for a part whose kind is `"toString"`, passes the `typeof === "function"` test, and gets
// called unbound. The body then renders `[object Undefined]` or similar: no kind named, no failure
// reported, which is the vanishing act in a new costume. Core's dispatcher is keyed by a `Map` and
// never had this door, so this is a divergence the browser copy introduced and has to close itself.
for (const inherited of ["toString", "valueOf", "constructor", "hasOwnProperty", "__proto__"]) {
  const got = taught.render([{ kind: inherited }]);
  ok(`an inherited property name (\`${inherited}\`) is NOT mistaken for a registered renderer`,
    got === `[unrenderable part kind ${JSON.stringify(inherited)} — no renderer for it on this surface]`,
    { got });
}
// The control: the guard must not have broken ordinary resolution on the way past.
ok("CONTROL: an OWN registration still resolves after the inherited-property guard",
  taught.render([FRAME]) === drawn);

// ── OTHER KINDS ARE UNAFFECTED, so the seam did not become a new vanishing act ───────────────────
ok("a plain text part is untouched by the lookup", taught.render([{ kind: "text", text: "hi" }]) === "hi");
ok("a data-bearing extension kind still keeps its data and its name",
  taught.render([{ kind: "com.acme.snapshot", data: { x: 1 } }]) === '[com.acme.snapshot] {"x":1}',
  { got: taught.render([{ kind: "com.acme.snapshot", data: { x: 1 } }]) });
ok("an unknown kind with no data is still refused by name",
  taught.render([{ kind: "com.acme.void" }])
    === '[unrenderable part kind "com.acme.void" — no renderer for it on this surface]');
ok("a frame between text parts is drawn in place, neighbours intact",
  taught.render([{ kind: "text", text: "A" }, FRAME, { kind: "text", text: "B" }])
    === `A ${drawn} B`);

// ── REACH: a renderer no page loads is dead code that passes every cell above ────────────────────
// The route table is the real exported map, so a missing row fails here exactly as the browser
// would 404 — and a 404 is invisible in these vm cells, which is precisely why this is asserted.
const served = PAGE["/agui-frame.js"];
ok("web.ts SERVES /agui-frame.js from its allow-list (a missing row is a 404 for both pages)",
  Boolean(served) && served.type.startsWith("text/javascript"), { served: served ?? null });
ok("and the row points at the file this suite just evaluated",
  Boolean(served) && readFileSync(served.path, "utf8") === frameSource, { path: served?.path });

// BOTH pages, because a kind that draws on one surface and shows a marker on the other is worse
// than one that shows a marker on both: it makes the gap look like a data problem.
const PAGES = [["index.html", "app.js"], ["graph.html", "graph.js"]] as const;
ok("both pages are covered (a short table would silently check fewer)", PAGES.length === 2, { n: PAGES.length });
for (const [file, consumer] of PAGES) {
  const html = readFileSync(join(webSrc, file), "utf8");
  const frameAt = html.indexOf('src="/agui-frame.js"');
  const consumerAt = html.indexOf(`src="/${consumer}"`);
  ok(`${file} loads /agui-frame.js`, frameAt !== -1, { frameAt });
  // Registration must complete before the page script renders anything. The seam is order-tolerant
  // between parts.js and agui-frame.js (asserted above), but NOT relative to the consumer that
  // draws on load — a page that rendered before registration would show the marker for one frame
  // and the rendering for the next, which reads as an intermittent data fault.
  ok(`${file} loads it BEFORE ${consumer} (a page drawing before registration shows the marker)`,
    frameAt !== -1 && consumerAt !== -1 && frameAt < consumerAt, { frameAt, consumerAt });
}

// The build ships `src/web` by copying the directory, so a new file needs no build edit — but that
// is a property of the build script, and if it ever stops being true this file silently stops
// shipping while every cell above stays green. Asserted against the real script text.
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
ok("the build copies the whole src/web directory (so a new browser file ships without a build edit)",
  /cp -R src\/web dist\/web/.test(pkg.scripts.build), { build: pkg.scripts.build });

console.log(`\n${cells} cells green`);
