// Rendering message parts as the flat text the dashboard displays.
//
// WHY THIS FILE EXISTS. `app.js` and `graph.js` each carried their own copy of
//   (msg.parts || []).map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ")
// and that expression DELETES any part it cannot draw. `JSON.stringify(undefined)` returns the
// VALUE `undefined` — not the string "undefined" — and `Array.prototype.join` coerces that to the
// empty string. So a part with no `data` field (any extension kind, `ag-ui.frame` among them)
// rendered as nothing: a stray separator between its neighbours, or a completely blank body when it
// was the only part. A surface that draws nothing is telling the operator that nothing arrived.
// That is not a gap, it is a false statement, and it is the one thing a monitoring surface must
// never do. Naming the kind is an honest gap; the empty string was the lie.
//
// A literal "undefined" in a message body would have been reported the day it shipped. An empty
// body never is — which is part of why this survived in two surfaces at once.
//
// ONE renderer for both pages, not two copies, for the reason core's own `partsToText` gives: the
// duplicated form broke identically everywhere when a new part kind appeared, because each copy had
// to be found and fixed separately. `index.html` and `graph.html` both load this file BEFORE their
// page script, and `web.ts` serves it from the PAGE allow-list — a file missing from that map is a
// 404 no matter what the HTML says.
//
// DELIBERATELY AHEAD OF CORE, AND THAT IS NOT AN OVERSIGHT. This mirrors the contract of core's
// `partsToText`, but core's copy on this branch still has the vanishing `JSON.stringify(p.data)`
// fallback and prints no marker; the marker-bearing version lives on an unmerged branch. So this is
// NOT "adopting the shared renderer" — adopting it as it stands here would have changed nothing
// for the case this file exists to fix. The browser runs ahead on purpose, and converges to core's
// wording when that lands. The strings below are the contract under test.
//
// SCOPE, and nothing wider: this makes an undrawable part SAY SO. It does not teach either page to
// RENDER an AG-UI frame and it adds no `events.*` filter. Both are separate, unowned work.
//
// Neither page republishes this text — `graph.js` only issues GETs and `app.js`'s single POST is
// `/api/channel/delete`, which carries a channel name — so the marker is safe to place in the body
// itself. If either page ever gains a republish path, the marker must move beside the text rather
// than inside it, or it will be replayed to the mesh as though an agent had typed it.
window.COTAL_PARTS = (() => {
  function partText(p) {
    if (p.kind === "text") return p.text;
    // The digest is verbose and not optional: it is the only handle a reader can act on to fetch
    // the bytes. Name and size come from the publisher, so they are shown as its claims.
    if (p.kind === "artifact") return `[artifact ${p.name} (${p.mediaType}, ${p.size} bytes) ${p.digest}]`;
    if (p.kind === "data") {
      const encoded = JSON.stringify(p.data);
      // A `data` part carrying no data hits the same vanishing act as an unknown kind, so it needs
      // its own marker. Named separately from the kind marker below because "a data part with
      // nothing in it" and "a kind this build cannot draw" are different facts, and a reader who
      // sees one must not conclude the other.
      return encoded === undefined ? "[empty data part]" : encoded;
    }
    // An extension kind. Not drawable here and not silently droppable either: name the kind, so a
    // reader who meets one knows exactly which renderer is missing instead of seeing a message that
    // looks like it was sent blank.
    return `[unrenderable part kind ${JSON.stringify(p.kind)} — no renderer for it on this surface]`;
  }

  /** A message's parts as one flat string, space-joined. */
  function partsToText(parts) {
    return (parts || []).map(partText).join(" ");
  }

  return { partsToText };
})();
