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
// IT WAS AHEAD OF CORE, AND CORE HAS SINCE CAUGHT UP. This mirrors the contract of core's
// `partsToText`. When this file was written, core's copy still had the vanishing
// `JSON.stringify(p.data)` fallback and printed no marker, so the browser ran ahead on purpose;
// core now carries the marker and a per-kind renderer seam of its own. The two remain SEPARATE
// implementations because this surface cannot import core at all, and they are held together by
// `bin/smoke/agui-render-parity.smoke.ts` rather than by anyone's intention. One difference is
// deliberate and survives: an extension kind carrying `data` renders its JSON here (see below) and
// goes straight to the marker in core.
//
// SCOPE: this makes an undrawable part SAY SO, preserves everything that was already visible, and
// CONSULTS a per-kind renderer registry so a surface can be taught to draw a kind without this file
// learning what the kind is. It does not itself know how to render an AG-UI frame; `agui-frame.js`
// does, and it registers. An earlier version of this line read "and nothing wider", which was FALSE
// while the extension branch discarded data: the scope sentence was wider than the code in one
// direction and narrower in the other. It then read "does not teach either page to RENDER an AG-UI
// frame", which went false in the other direction the moment the lookup landed, because the page
// can now draw one via a file this one has never heard of. A scope sentence is only worth having if
// it is re-read every time the code under it moves.
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
    // order. That is the whole reason this is a lookup and not an import: this file stays ignorant
    // of every kind anyone teaches it, which is what keeps the dispatcher a dispatcher.
    //
    // A THROWING RENDERER MUST NOT TAKE THE PAGE DOWN, and must not silently become a blank body
    // either, which is precisely the failure this file exists to remove; re-introducing it through
    // the extension seam would be the same bug with a new door. It degrades to a NAMED marker
    // carrying the error, and the data fallback below is not reached: a renderer that registered
    // and then failed is a different fact from no renderer at all, and a reader who saw raw JSON
    // would conclude the second.
    // OWN PROPERTIES ONLY. `p.kind` comes off the wire, and a plain object inherits `toString`,
    // `valueOf` and `constructor` from `Object.prototype` — every one of them a function. A bare
    // `renderers[p.kind]` therefore RESOLVES for a part whose kind is `"toString"`, passes the
    // `typeof === "function"` test, and gets called unbound: the body renders `[object Window]`,
    // which names no kind and reports no failure. Core's dispatcher is keyed by a `Map` and never
    // had this door; a plain object on `window` does, so it is closed explicitly here.
    const renderers = window.COTAL_PART_RENDERERS;
    const render =
      renderers && Object.prototype.hasOwnProperty.call(renderers, p.kind) ? renderers[p.kind] : undefined;
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
    // to add it, and it made this file's own "scope is nothing wider" claim false.
    //
    // THIS IS THE DELIBERATE DIFFERENCE FROM CORE ANNOUNCED AT THE TOP OF THIS FILE, NOT AGREEMENT
    // WITH IT. Core's `partsToText` renders a data-bearing extension kind as the marker alone and
    // keeps nothing (driven, not read: a part `{kind:"com.acme.snapshot", data:{x:1}}` through core
    // returns only the unrenderable marker). The difference is justified by the SURFACE, not by
    // core: this file replaces an expression that was already showing that JSON, and core's
    // equivalent never did, so keeping it is a regression here and would be an addition there.
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
