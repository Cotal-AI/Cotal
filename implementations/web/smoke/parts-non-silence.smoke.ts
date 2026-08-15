/**
 * The dashboard must never render a message part as nothing.
 *
 * `app.js` and `graph.js` each carried
 *   (msg.parts || []).map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ")
 * and `JSON.stringify(undefined)` returns the VALUE `undefined`, which `join` coerces to "". So a
 * part with no `data` field vanished: a stray separator between neighbours, or a blank body when it
 * was the only part. A surface that draws nothing says nothing arrived. These cells exist to make
 * that specific lie impossible to reintroduce silently.
 *
 * WHAT THESE CELLS DRIVE, AND WHY IT IS NOT A RESTATEMENT OF THE FIX. The renderer under test is
 * READ OFF DISK AND EVALUATED — the actual `src/web/parts.js` the browser is served, in a `vm`
 * context with a stub `window`, exactly as a classic `<script>` would run it. Nothing here
 * re-declares the renderer, so a cell cannot pass against a version of the function that no longer
 * exists. The route table is likewise the REAL `PAGE` export from `web.ts`, not a copy of its keys.
 *
 * WHAT THEY DO NOT CLAIM. Rendering an AG-UI frame, and the `events.*` filter, are separate work
 * and untouched. These cells prove non-silence and reach; they prove nothing about how a frame
 * should eventually be drawn.
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

// ── The renderer, loaded the way the browser loads it ────────────────────────────────────────────
// A classic script assigning to `window`. If parts.js ever became an ES module, or stopped
// publishing `COTAL_PARTS`, this throws here rather than silently leaving `partsToText` undefined.
const partsSource = readFileSync(join(webSrc, "parts.js"), "utf8");
const sandbox: { window: Record<string, unknown> } = { window: {} };
runInContext(partsSource, createContext(sandbox), { filename: "parts.js" });
const api = sandbox.window.COTAL_PARTS as { partsToText(parts: unknown[]): string } | undefined;
ok("parts.js publishes COTAL_PARTS.partsToText on window (classic-script contract)",
  typeof api?.partsToText === "function", { got: typeof api?.partsToText });
const render = (parts: unknown[]) => api!.partsToText(parts);

// ── POSITIVE CONTROL on the detector, before any absence-shaped claim ────────────────────────────
// If the renderer could not produce the ordinary case, every marker cell below would be measuring a
// broken instrument rather than the property it names.
ok("CONTROL: a plain text part still renders its text verbatim",
  render([{ kind: "text", text: "hello" }]) === "hello", { got: render([{ kind: "text", text: "hello" }]) });

// ── THE DEFECT, stated as the exact string that used to appear ───────────────────────────────────
// `ag-ui.frame` is the kind that motivated this, and it carries no `data` field — the precise shape
// the old expression erased. CONTENT is asserted, not merely non-emptiness: a marker that named the
// wrong kind would be just as useless to a reader as the empty string was.
const frame = { kind: "ag-ui.frame", frame: { type: "RUN_STARTED" } };
const frameOnly = render([frame]);
ok("a frame-only message names the kind it cannot draw",
  frameOnly === '[unrenderable part kind "ag-ui.frame" — no renderer for it on this surface]',
  { got: frameOnly });
ok("that rendering is not empty and not whitespace (the exact old failure)",
  frameOnly.trim().length > 0, { got: frameOnly });

// The old expression's other visible symptom: a frame BETWEEN two text parts collapsed to a double
// space, so the message looked merely oddly spaced rather than incomplete. Pin both that the marker
// is present and that the neighbouring text survives it.
const mixed = render([{ kind: "text", text: "before" }, frame, { kind: "text", text: "after" }]);
ok("a frame between text parts is marked, not collapsed into a double space",
  mixed === 'before [unrenderable part kind "ag-ui.frame" — no renderer for it on this surface] after',
  { got: mixed });
ok("REGRESSION ORACLE: the old expression really did erase it (mutant non-equivalence, computed here)",
  ["before", frame, "after"].map((p) =>
    typeof p === "string" ? p : JSON.stringify((p as { data?: unknown }).data)).join(" ") === "before  after",
  { old: ["before", frame, "after"].map((p) => typeof p === "string" ? p : JSON.stringify((p as { data?: unknown }).data)).join(" ") });

// ── The adjacent vanishing case, named separately on purpose ─────────────────────────────────────
// A `data` part carrying no data disappeared the same way, but it is a different fact about the
// message and must not be reported as an unknown kind.
ok("a data part with no data is marked as empty, not as an unknown kind",
  render([{ kind: "data" }]) === "[empty data part]", { got: render([{ kind: "data" }]) });
ok("a data part WITH data still renders its JSON (unchanged behaviour)",
  render([{ kind: "data", data: { a: 1 } }]) === '{"a":1}', { got: render([{ kind: "data", data: { a: 1 } }]) });
ok("an artifact part renders its actionable digest form",
  render([{ kind: "artifact", name: "x.txt", mediaType: "text/plain", size: 3, digest: "sha256:ab" }])
    === "[artifact x.txt (text/plain, 3 bytes) sha256:ab]");
ok("no parts at all is still the empty string (absence of content, not a dropped part)",
  render([]) === "" && api!.partsToText(undefined as unknown as unknown[]) === "");

// ── REACH: a shared renderer no page loads is dead code that still passes every cell above ───────
// The route table is the real exported map, so a missing row fails here exactly as the browser
// would 404. `.some()` is used throughout: it fails safely on an empty collection, where `.every()`
// would pass vacuously.
const served = PAGE["/parts.js"];
ok("web.ts SERVES /parts.js from its allow-list (a missing row is a 404 for both pages)",
  Boolean(served) && served.type.startsWith("text/javascript"), { served });
ok("and the row points at the file this suite just evaluated",
  Boolean(served) && readFileSync(served.path, "utf8") === partsSource, { path: served?.path });

// Both pages must load it, and load it BEFORE the script that calls it: a classic script reading a
// global defined by a LATER script gets `undefined` and throws in the browser only.
for (const [page, consumer] of [["index.html", "app.js"], ["graph.html", "graph.js"]] as const) {
  const html = readFileSync(join(webSrc, page), "utf8");
  const partsAt = html.indexOf('src="/parts.js"');
  const consumerAt = html.indexOf(`src="/${consumer}"`);
  ok(`${page} loads /parts.js`, partsAt !== -1, { partsAt });
  ok(`${page} loads /parts.js BEFORE ${consumer} (later would leave the global undefined)`,
    partsAt !== -1 && consumerAt !== -1 && partsAt < consumerAt, { partsAt, consumerAt });
}

// ── The copies are actually GONE, read from the shipped files rather than assumed ─────────────────
// Deleting the duplicated expression is the point of the change; a surface that still carries its
// own copy is unfixed no matter what the shared renderer does.
for (const [file, callsite] of [["app.js", "bodyText"], ["graph.js", "partsText"]] as const) {
  const src = readFileSync(join(webSrc, file), "utf8");
  ok(`${file} routes ${callsite} through the shared renderer`,
    src.includes("window.COTAL_PARTS.partsToText"), { file });
  // Matched on the vanishing FALLBACK, not on the whole expression: that is the part that erased
  // the message, and a reformatted copy would still carry it.
  ok(`${file} no longer carries the vanishing JSON.stringify(p.data) fallback`,
    !/JSON\.stringify\(p\.data\)/.test(src), { file });
}

console.log(`\n${cells} cells green`);
