// Rendering message parts as the flat text the dashboard displays.
//
// WHY THIS FILE EXISTS. `app.js` and `graph.js` each carried their own copy of
//   (msg.parts || []).map((p) => (p.kind === "text" ? p.text : JSON.stringify(p.data))).join(" ")
// and that expression DELETES any part it cannot draw. `JSON.stringify(undefined)` returns the
// VALUE `undefined` — not the string "undefined" — and `Array.prototype.join` coerces that to the
// empty string. So a part with no `data` field — `ag-ui.frame` among them, but NOT every extension
// kind, since a data-bearing one rendered its JSON perfectly well — vanished: a stray separator
// between its neighbours, or an empty string when it was the only part. In every case the KIND went
// unnamed, so a reader could not tell which renderer was missing. Those two are what this file
// fixes, and they are the claims to hold it to.
//
// THE CONSEQUENCE DIFFERS BY SURFACE, AND AN EARLIER VERSION OF THIS COMMENT GOT IT WRONG. It said
// both surfaces told the operator that nothing arrived. That is true of ONE of them:
//   - `app.js` renders the body through `bodyBlock`, i.e. `MD.render(text || "")`, so an empty
//     rendering really does produce a blank body — absence reported as calm.
//   - `graph.js`'s detail row renders `esc(m.text).slice(0, 160) || "—"`, so an empty rendering
//     became a VISIBLE DASH inside a row still carrying mode, sender and channel/target. The graph
//     showed a message with an unreadable body. It never claimed nothing arrived.
// Overstating a defect is the same class of error as understating one: it describes a property
// nothing recomputes, and it makes the fix look like it closes more than it does.
//
// A literal "undefined" in a message body would have been reported the day it shipped; a blank one
// is not, which is part of why this survived. But note the graph placeholder cuts the other way —
// it was the more visible of the two and still went unfixed, so visibility alone was not enough.
//
// ONE renderer for both pages, not two copies, for the reason core's own `partsToText` gives: the
// duplicated form broke identically everywhere when a new part kind appeared, because each copy had
// to be found and fixed separately.
//
// AND ON THIS SURFACE NOTHING ELSE WOULD HAVE CAUGHT IT. `implementations/web/tsconfig.json` sets
// `"exclude": ["src/web"]`, so every file in this directory is plain JS that `tsc` never reads. The
// two copies of the broken expression were the same mistake, in the same words, in two files, and
// **no compiler in this repo could see either one**. That is not an argument about style; it is why
// the checks on this directory have to be executable cells that run the shipped file, because they
// are the only enforcement this surface has. `index.html` and `graph.html` both load this file BEFORE their
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
// SCOPE: this makes an undrawable part SAY SO, preserves everything that was already visible, and
// CONSULTS a per-kind renderer registry so a surface can be taught to draw a kind without this file
// learning what the kind is. It does not itself know how to render an AG-UI frame — `agui-frame.js`
// does, and it registers — and it still adds no `events.*` filter, which remains separate, unowned
// work. An earlier version of this line read "and nothing wider", which was FALSE while the
// extension branch discarded data — the scope sentence was wider than the code in one direction and
// narrower in the other. It then read "does not teach either page to RENDER an AG-UI frame", which
// went false in the other direction the moment the lookup landed: the page can now draw one, via a
// file this one has never heard of. A scope sentence is only worth having if it is re-read every
// time the code under it moves.
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
    // An extension kind. A surface may have been TAUGHT to draw one, by registering a function
    // under its kind in `window.COTAL_PART_RENDERERS` (see `agui-frame.js`). Consulted here, first,
    // because a renderer that exists is strictly more specific than either fallback below.
    //
    // READ AT CALL TIME, not when this closure was built, so registration may happen in any script
    // order. That is the whole reason this is a lookup and not an import: this file stays ignorant of
    // every kind anyone teaches it, which is what keeps the dispatcher a dispatcher.
    //
    // A THROWING RENDERER MUST NOT TAKE THE PAGE DOWN, and must not silently become a blank body
    // either — that is precisely the failure this file exists to remove, and re-introducing it
    // through the extension seam would be the same bug with a new door. It degrades to a NAMED
    // marker carrying the error, and the data fallback below is not reached: a renderer that
    // registered and then failed is a different fact from no renderer at all, and a reader who sees
    // raw JSON would conclude the second.
    const renderers = window.COTAL_PART_RENDERERS;
    const render = renderers && renderers[p.kind];
    if (typeof render === "function") {
      let out;
      try {
        out = render(p);
      } catch (err) {
        return `[renderer for part kind ${JSON.stringify(p.kind)} failed: ${err && err.message ? err.message : String(err)}]`;
      }
      // A renderer returning a non-string would put `undefined` or `[object Object]` into the body
      // through the same coercion described at the top of this file. Its contract is a string.
      if (typeof out === "string") return out;
      return `[renderer for part kind ${JSON.stringify(p.kind)} returned ${typeof out}, expected a string]`;
    }

    // No renderer for this kind. Not drawable here, and not silently droppable either.
    //
    // BUT DATA-BEARING EXTENSIONS MUST KEEP THEIR DATA. The first version of this file sent every
    // non-core kind straight to the marker, which THREW AWAY content the old expression had been
    // showing: `{kind:"com.acme.snapshot", data:{x:1}}` rendered `{"x":1}` before and the marker
    // after. That is a regression wearing a fix's clothes — it removes information while claiming
    // to add it, and it made this file's own "scope is nothing wider" claim false. Core is explicit
    // that an unknown extension kind still falls back to its `data` and that this is deliberate
    // (`packages/core/src/parts.ts:12-13`); that behaviour is preserved here.
    //
    // So: name the kind AND keep the data. That is strictly more than either did alone — the old
    // expression showed the data but never said what it was, and the marker alone said what it was
    // while discarding it.
    const encoded = JSON.stringify(p.data);
    if (encoded !== undefined) return `[${p.kind}] ${encoded}`;
    // No data to keep. This is the case the file exists for: name the kind, so a reader knows which
    // renderer is missing instead of seeing a message that looks like it was sent blank.
    return `[unrenderable part kind ${JSON.stringify(p.kind)} — no renderer for it on this surface]`;
  }

  /** A message's parts as one flat string, space-joined. */
  function partsToText(parts) {
    return (parts || []).map(partText).join(" ");
  }

  return { partsToText };
})();
