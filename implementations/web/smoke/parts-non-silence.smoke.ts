/**
 * The dashboard must never render a message part as nothing.
 *
 * The old console and graph pages each carried
 *   (msg.parts || []).map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ")
 * and `JSON.stringify(undefined)` returns the VALUE `undefined`, which `join` coerces to "". So a
 * part with no `data` field vanished, and its KIND was never named. A data-BEARING extension part
 * was not affected — it rendered its JSON — which is why the fix must preserve that data rather than
 * replace it with a marker.
 *
 * The downstream consequence differed by surface, and saying "both showed a blank line" was wrong:
 * the console page rendered through `MD.render(text || "")`, so an empty rendering really was a
 * blank body, while the graph page's detail row rendered `esc(m.text).slice(0, 160) || "—"` and
 * showed a visible dash in a row still carrying mode, sender and channel. Both failed to name the kind; only one looked
 * like nothing had arrived.
 *
 * WHAT THESE CELLS DRIVE, AND WHY IT IS NOT A RESTATEMENT OF THE FIX. The renderer under test is
 * the actual `client/src/lib/parts.ts` module, imported as the client bundle imports it. Nothing
 * here re-declares the renderer, so a cell cannot pass against a version of the function that no
 * longer exists.
 *
 * WHAT THEY DO NOT CLAIM. These cells measure the NO-RENDERER path, the fallbacks `parts.ts` takes
 * for a kind nothing has taught it, and that is now a precondition rather than the only case, since
 * `parts.ts` consults a renderer registry and `aguiFrame.ts` registers into it. The precondition is
 * asserted below, not assumed. Frame RENDERING and its parity with the node renderer belong to
 * `agui-frame-dispatch.smoke.ts` and `agui-render-parity.smoke.ts`. The dashboard's
 * `events.*` filter is still separate, unbuilt work: the console's filter lives in `MeshView`, which
 * the dashboard client does not use. Nothing here says how a frame should be drawn.
 *
 * AND THE EXACT EDGE OF THE REACH CLAIM. Two things are checked and they are not the same thing: the
 * renderer RETURNS the marker, and the shell DRAWS it. That last pair of cells exists because a
 * review replaced all five downstream calls with "" and the cells over the declaration stayed green:
 * a correct helper nobody invokes. It renders the shell to HTML on the server (`render-shell.ts`,
 * `renderToString` over a seeded store) and checks that the message body in that HTML carries the
 * renderer's text and its marker. The body is drawn by `MessageRow`, which renders it as Markdown,
 * and the Markdown sanitizer needs a DOM, so jsdom is installed first (`dom-globals.ts`). That
 * DOM serves the sanitizer only: no cell here mounts the page or looks at pixels. So these cells
 * prove the marker is produced and is in the shell's server-rendered HTML, not that a browser
 * paints it.
 */
import { closeDom } from "./dom-globals.js";
import assert from "node:assert/strict";
import type { CotalMessage } from "../client/src/api/types.js";
import { partsToText } from "../client/src/lib/parts.js";
import { renderShell, unescapeHtml } from "./render-shell.js";

let cells = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  cells++;
  assert.ok(cond, `${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  console.log(`  ok  ${name}`);
};

// ── The renderer, imported the way the client bundle imports it ──────────────────────────────────
// `aguiFrame.ts` is deliberately NOT imported here: these cells measure the no-renderer fallbacks, so
// the registry must hold nothing for `ag-ui.frame`. `agui-frame-dispatch.smoke.ts` owns the case where
// it does.
const render = (parts: unknown[]) => partsToText(parts);

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
  render([]) === "" && partsToText(undefined) === "");

// ── REACH ─────────────────────────────────────────────────────────────────────────────────────────
// The old pages loaded `/parts.js` ahead of their scripts and the cells here checked that order; the
// client bundle orders its own modules, so there is no load order to assert. What is left to prove
// is that the shell, which draws message bodies, renders them through the shared renderer. A correct
// helper nobody invokes is the defect this cell exists for.
//
// The shell (`client/src/Shell.tsx`) is rendered on the server on a channel route, the channel open
// and holding one message, and its HTML is read: the body is the centre's `<main>`, drawn by the
// channel view through `ui/MessageRow.tsx`.
// This proves what the shell draws, not that its text survives to the pixels: no cell here opens a
// browser. `Shell` does not import `aguiFrame.ts`, so the registry stays empty for the cells above
// and below.
{
  const parts = [{ kind: "text", text: "before" }, { kind: "data" }, { kind: "text", text: "after" }];
  const msg = { id: "m1", from: { id: "alice" }, parts } as unknown as CotalMessage;
  const html = renderShell({ open: { channel: "general", messages: [{ msg }] } }, { view: "channel", channel: "general" });
  const body = unescapeHtml(/<main[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? "");
  ok("the shell renders message bodies through partsToText", body.includes(partsToText(parts)), { body, want: partsToText(parts) });
  ok("and what it draws is the shared renderer's text, marker included, not a body of its own",
    body.includes("[empty data part]") && !body.includes("undefined"), { body });
}

await closeDom();
console.log(`\n${cells} cells green`);
