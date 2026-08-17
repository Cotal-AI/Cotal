/**
 * The dashboard must never render a message part as nothing.
 *
 * `app.js` and `graph.js` each carried
 *   (msg.parts || []).map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ")
 * and `JSON.stringify(undefined)` returns the VALUE `undefined`, which `join` coerces to "". So a
 * part with no `data` field vanished, and its KIND was never named. A data-BEARING extension part
 * was not affected — it rendered its JSON — which is why the fix must preserve that data rather than
 * replace it with a marker.
 *
 * The downstream consequence differed by surface, and saying "both showed a blank line" was wrong:
 * `app.js` renders through `MD.render(text || "")`, so an empty rendering really is a blank body,
 * while `graph.js`'s detail row renders `esc(m.text).slice(0, 160) || "—"` and showed a visible dash
 * in a row still carrying mode, sender and channel. Both failed to name the kind; only one looked
 * like nothing had arrived.
 *
 * WHAT THESE CELLS DRIVE, AND WHY IT IS NOT A RESTATEMENT OF THE FIX. The renderer under test is
 * READ OFF DISK AND EVALUATED — the actual `src/web/parts.js` the browser is served, in a `vm`
 * context with a stub `window`, exactly as a classic `<script>` would run it. Nothing here
 * re-declares the renderer, so a cell cannot pass against a version of the function that no longer
 * exists. The route table is likewise the REAL `PAGE` export from `web.ts`, not a copy of its keys.
 *
 * WHAT THEY DO NOT CLAIM. These cells measure the NO-RENDERER path, the fallbacks `parts.js` takes
 * for a kind nothing has taught it, and that is now a precondition rather than the only case, since
 * `parts.js` consults a renderer registry and `agui-frame.js` registers into it. The precondition is
 * asserted below, not assumed. Frame RENDERING and its parity with the node renderer belong to
 * `agui-frame-dispatch.smoke.ts` and `bin/smoke/agui-render-parity.smoke.ts`. The dashboard's
 * `events.*` filter is still separate, unbuilt work: the console's filter lives in `MeshView`, which
 * these pages do not use. Nothing here says how a frame should be drawn.
 *
 * AND THE EXACT EDGE OF THE REACH CLAIM, because it moved once already and could be overread again.
 * Three things are checked and they are not the same thing: the shared renderer is SERVED and LOADED
 * before its consumers; each consumer's own declaration, executed, RETURNS the marker; and each
 * consumer is actually CALLED downstream. That last cell exists because a review replaced all five
 * downstream calls with "" and the executed-declaration cells stayed green — a correct helper nobody
 * invokes. What is still NOT measured is the last hop: `bodyBlock`/`MD.render` in `app.js` and
 * `recentRows` in `graph.js` turn that text into DOM, and no cell here opens a browser or asserts
 * rendered HTML. So these cells prove the marker is produced and the producer is wired in — not that
 * it survives to the pixels.
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

// THE REAL FRAME SHAPE, not the reduced fixture above. A sibling lane measured an actual AG-UI
// frame and reported its key set — kind, protocol, threadId, runId, epoch, seq, events — with NO
// `data` field anywhere, which is exactly why the old expression erased it. The fixture above is a
// simplification, and a simplification is a place for a defect to hide, so the reported shape gets
// its own cell. Re-measured here rather than taken on report: the old expression yields a
// zero-length string for this input.
//
// The frame's `events` are deliberately NOT rendered and that is not a second defect. They were
// never visible — the old expression produced "" — so naming the kind is a strict improvement and
// showing the run's contents would be RENDERING a frame, which is separate, unowned work. This is
// the line between an honest gap and a regression: preserve what was visible, do not invent what
// was not.
const realFrame = {
  kind: "ag-ui.frame", protocol: "ag-ui/1", threadId: "t1", runId: "r1", epoch: 3, seq: 7,
  events: [{ type: "RUN_STARTED" }, { type: "TEXT_MESSAGE_CONTENT", delta: "hi" }, { type: "RUN_FINISHED" }],
};
ok("a REAL ag-ui frame carries no `data` field (the precondition the old expression tripped on)",
  (realFrame as { data?: unknown }).data === undefined);
// The old expression itself, applied — not a conditional standing in for it.
const oldExpression = (parts: { kind: string; text?: string; data?: unknown }[]) =>
  parts.map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ");
ok("REGRESSION ORACLE: the old expression renders a real frame as ZERO characters",
  oldExpression([realFrame]).length === 0, { got: oldExpression([realFrame]) });
ok("a real frame is NAMED by the shipped renderer instead of vanishing",
  render([realFrame]) === '[unrenderable part kind "ag-ui.frame" — no renderer for it on this surface]',
  { got: render([realFrame]) });

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

// REGRESSION VECTOR. A data-bearing EXTENSION kind was already visible through the old expression,
// which rendered `{"x":1}` for this exact part. A first version of the renderer sent every non-core
// kind straight to the marker and threw that away — removing information while claiming to add it.
// Core is explicit that an unknown extension kind still falls back to its `data` on purpose
// (`packages/core/src/parts.ts:12-13`). The cell pins BOTH halves, because either alone passes on a
// defect: the data must survive, and the kind must be named beside it.
const ext = render([{ kind: "com.acme.snapshot", data: { x: 1 } }]);
ok("a data-bearing extension keeps its data (it was visible before; dropping it is a regression)",
  ext.includes('{"x":1}'), { got: ext });
ok("and that extension is also NAMED, which the old expression never did",
  ext.includes("com.acme.snapshot"), { got: ext });
ok("an artifact part renders its actionable digest form",
  render([{ kind: "artifact", name: "x.txt", mediaType: "text/plain", size: 3, digest: "sha256:ab" }])
    === "[artifact x.txt (text/plain, 3 bytes) sha256:ab]");
ok("no parts at all is still the empty string (absence of content, not a dropped part)",
  render([]) === "" && api!.partsToText(undefined as unknown as unknown[]) === "");

// ── REACH: a shared renderer no page loads is dead code that still passes every cell above ───────
// The route table is the real exported map, so a missing row fails here exactly as the browser
// would 404.
//
// NON-VACUITY IS PINNED BY COUNTING, NOT ASSERTED. An earlier version of this comment claimed
// `.some()` was "used throughout" and was the mechanism — the suite contains no `.some()` call at
// all, so the only occurrence of that word was the sentence claiming it. Both tables below are
// fixed literals and their lengths are checked before the loops run, so a table that lost an entry
// fails instead of quietly iterating fewer times.
const served = PAGE["/parts.js"];
ok("web.ts SERVES /parts.js from its allow-list (a missing row is a 404 for both pages)",
  Boolean(served) && served.type.startsWith("text/javascript"), { served });
ok("and the row points at the file this suite just evaluated",
  Boolean(served) && readFileSync(served.path, "utf8") === partsSource, { path: served?.path });

// Both pages must load it, and load it BEFORE the script that calls it: a classic script reading a
// global defined by a LATER script gets `undefined` and throws in the browser only.
const PAGES = [["index.html", "app.js"], ["graph.html", "graph.js"]] as const;
ok("both pages are covered (a short table would silently check fewer)", PAGES.length === 2, { n: PAGES.length });
for (const [page, consumer] of PAGES) {
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
// A substring check proves the shared call was TYPED, not that the consumer reaches the marker. So
// each consumer's own declaration is LIFTED OUT OF THE SHIPPED FILE and executed against the real
// renderer. Neither page can be evaluated whole — both drive the DOM at load — so the declaration
// is extracted rather than the module imported; it is still the shipped text, never a copy of it.
const CONSUMERS = [["app.js", "bodyText"], ["graph.js", "partsText"]] as const;
ok("both consumers are covered (a short table would silently check fewer)",
  CONSUMERS.length === 2, { n: CONSUMERS.length });
for (const [file, callsite] of CONSUMERS) {
  const src = readFileSync(join(webSrc, file), "utf8");
  const decl = new RegExp(`const ${callsite} = [^;]*;`).exec(src)?.[0];
  ok(`${file} declares ${callsite} in one extractable statement`, Boolean(decl), { decl });

  // DOWNSTREAM REACH. Executing the declaration proves the helper is correct, NOT that anything
  // calls it: with every downstream call replaced by "", the extracted cells below still return the
  // marker and this suite was green. So the helper must also be REACHED. The declaration spells
  // `const <name> = (`, so `<name>(` matches call sites only.
  const calls = [...src.matchAll(new RegExp(`\\b${callsite}\\(`, "g"))].length;
  ok(`${file} actually CALLS ${callsite} downstream (a dead helper passes every renderer cell)`,
    calls > 0, { calls });

  // The consumer runs in a context holding the REAL renderer, so this executes the exact path the
  // browser takes: page expression → shared renderer → text.
  const ctx: { window: Record<string, unknown>; out?: string } = { window: {} };
  const c = createContext(ctx);
  runInContext(partsSource, c, { filename: "parts.js" });
  runInContext(`${decl}\nout = ${callsite}({ parts: [{ kind: "ag-ui.frame", frame: {} }] });`, c,
    { filename: `${file} (${callsite})` });
  ok(`${file}'s own ${callsite} renders the marker for a frame (the shipped expression, executed)`,
    ctx.out === '[unrenderable part kind "ag-ui.frame" — no renderer for it on this surface]',
    { got: ctx.out });

  // Matched on the vanishing FALLBACK, not on the whole expression: that is the part that erased
  // the message, and a reformatted copy would still carry it.
  ok(`${file} no longer carries the vanishing JSON.stringify(p.data) fallback`,
    !/JSON\.stringify\(p\.data\)/.test(src), { file });
}

console.log(`\n${cells} cells green`);
