// Rendering message parts as the flat text the dashboard displays, and escaping text for its HTML.
//
// Why this module exists. The old pages each carried their own copy of
//   (msg.parts || []).map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ")
// and that expression deleted any part it could not draw. `JSON.stringify(undefined)` returns the
// value `undefined`, not the string "undefined", and `Array.prototype.join` coerces it to the empty
// string. So a part with no `data` field (`ag-ui.frame` among them, though not every extension kind,
// since a data-bearing one rendered its JSON well enough) vanished: a stray separator between its
// neighbours, or an empty string when it was the only part. In every case the kind went unnamed, so
// a reader could not tell which renderer was missing. These two are what this module fixes, and they
// are the claims to hold it to.
//
// The consequence differed by surface. The console rendered the body as Markdown, so an empty
// rendering was a blank body: absence reported as calm. The graph's detail row showed a visible dash
// inside a row still carrying mode, sender and channel, so it never claimed nothing arrived.
// Overstating a defect is the same class of error as understating one.
//
// One renderer for every surface, not copies, for the reason core's own `partsToText` gives: the
// duplicated form broke identically everywhere when a new part kind appeared, because each copy had
// to be found and fixed separately.
//
// This mirrors the contract of core's `partsToText`, as a separate implementation because the
// client imports nothing from `@cotal-ai/*` at runtime. `bin/smoke/agui-render-parity.smoke.ts`
// holds the two together rather than anyone's intention. One difference is deliberate and survives:
// an extension kind carrying `data` renders its JSON here (see below) and goes straight to the
// marker in core.
//
// Scope: this makes an undrawable part say so, preserves everything that was already visible, and
// consults a per-kind renderer registry so a surface can be taught to draw a kind without this
// module learning what the kind is. It does not know how to render an AG-UI frame; `aguiFrame.ts`
// does, and registers. A scope sentence is only worth having if it is re-read every time the code
// under it moves.
//
// Nothing republishes this text, so the marker is safe to place in the body itself. If a surface
// ever gains a republish path, the marker must move beside the text rather than inside it, or it
// will be replayed to the mesh as though an agent had typed it.

/** Draws one part of a registered kind as text. Its contract is a string. */
export type PartRenderer = (part: Record<string, unknown>) => string;

/** Keyed by a `Map` and read with `has`: a part kind comes off the wire, and a plain object would
 *  resolve `"toString"`, `"valueOf"` and `"constructor"` to inherited functions that then get called
 *  unbound, rendering `[object Undefined]` with no kind named and no failure reported. */
const renderers = new Map<string, PartRenderer>();

/** Teach this surface to draw a part kind. Read at call time, so registration may happen at any
 *  point and in any module order. */
export function registerPartRenderer(kind: string, r: PartRenderer): void {
  renderers.set(kind, r);
}

function partText(p: Record<string, unknown>): string {
  if (p.kind === "text") return p.text as string;
  // The digest is verbose and not optional: it is the only handle a reader can act on to fetch the
  // bytes. Name and size come from the publisher, so they are shown as its claims.
  if (p.kind === "artifact") return `[artifact ${p.name} (${p.mediaType}, ${p.size} bytes) ${p.digest}]`;
  if (p.kind === "data") {
    const encoded = JSON.stringify(p.data) as string | undefined;
    // A `data` part carrying no data vanishes the same way an unknown kind does, so it gets its own
    // marker. "A data part with nothing in it" and "a kind this build cannot draw" are different
    // facts, and a reader who sees one must not conclude the other.
    return encoded === undefined ? "[empty data part]" : encoded;
  }
  // An extension kind. A surface may have been taught to draw one by registering a function under
  // its kind. Consulted first, because a renderer that exists is strictly more specific than either
  // fallback below.
  //
  // A throwing renderer must not take the page down, and must not silently become a blank body,
  // which is the failure this module exists to remove. It degrades to a named marker carrying the
  // error, and the data fallback below is not reached: a renderer that registered and then failed is
  // a different fact from no renderer at all, and a reader who saw raw JSON would conclude the
  // second.
  const kind = p.kind as string;
  const render = renderers.has(kind) ? renderers.get(kind) : undefined;
  if (typeof render === "function") {
    let out: unknown;
    try {
      out = render(p);
    } catch (err) {
      const e = err as { message?: string } | null;
      return `[renderer for part kind ${JSON.stringify(kind)} failed: ${e && e.message ? e.message : String(err)}]`;
    }
    // A renderer returning a non-string would put `undefined` or `[object Object]` into the body
    // through the same coercion described at the top. Its contract is a string.
    if (typeof out === "string") return out;
    return `[renderer for part kind ${JSON.stringify(kind)} returned ${typeof out}, expected a string]`;
  }

  // No renderer for this kind. Not drawable here, and not silently droppable either.
  //
  // Data-bearing extensions must keep their data. A first version sent every non-core kind straight
  // to the marker, which threw away content the old expression had been showing:
  // `{kind:"com.acme.snapshot", data:{x:1}}` rendered `{"x":1}` before and the marker after. That is
  // a regression wearing a fix's clothes. This is the deliberate difference from core, which renders
  // a data-bearing extension kind as the marker alone. It is justified by this surface, not by core:
  // the expression this replaced was already showing that JSON, and core's equivalent never did.
  //
  // So: name the kind and keep the data. That is strictly more than either did alone.
  const encoded = JSON.stringify(p.data) as string | undefined;
  if (encoded !== undefined) return `[${kind}] ${encoded}`;
  // No data to keep. This is the case the module exists for: name the kind, so a reader knows which
  // renderer is missing instead of seeing a message that looks like it was sent blank.
  return `[unrenderable part kind ${JSON.stringify(kind)} \u2014 no renderer for it on this surface]`;
}

/** A message's parts as one flat string, space-joined. */
export function partsToText(parts: unknown[] | undefined): string {
  return (parts || []).map((p) => partText(p as Record<string, unknown>)).join(" ");
}

/** Text escaped for HTML. `"` is escaped because values also land inside double-quoted attributes,
 *  and an absent value is empty text because the graph passes a nameless sender as is. */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
}
