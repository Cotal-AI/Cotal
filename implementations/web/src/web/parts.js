// Cotal message parts → the flat text the dashboard displays. One source (window.COTAL_PARTS) for
// every surface in this payload, mirroring `partsToText` in `@cotal-ai/core`.
//
// WHY THIS IS A COPY AND NOT AN IMPORT. The browser half of this package is loaded as plain
// `<script src>` tags — no `import`, no `export`, no module resolution at runtime — which is what
// makes `@cotal-ai/web` a self-contained payload (see `scripts/copy-vendor.mjs`). A package
// specifier is therefore UNAVAILABLE here, even for a package this one already depends on. So this
// is deliberately a SECOND IMPLEMENTATION, and the only honest way to run it is to say so:
//
//   Source of truth: `packages/core/src/parts.ts` (`partText` / `partsToText`).
//   Adopters of that function: `extensions/connector-core/src/agent.ts`,
//   `implementations/cli/src/commands/join.ts`, `implementations/cli/src/view/mesh-view.ts`.
//   This file is the fourth renderer and cannot be the same function.
//
// If a future sweep finds this copy, it is not an oversight and consolidating it into core will not
// work — core is unreachable from here. Keep the OUTPUT identical to core's instead; the strings
// below are byte-for-byte what `partText` produces, and that is the contract worth holding.
//
// THE RULE THIS FILE ENFORCES: **no part renders as nothing.** A part kind that reaches neither a
// renderer nor a diagnostic is indistinguishable from a message that legitimately had nothing to
// show, so nobody ever reports it.
(function () {
  // A visible marker rather than a throw, for two reasons. A throw is swallowable: a caller that
  // wraps this and skips the message reinstates the silence one layer up, where it is harder to see.
  // And parts arrive from other agents, so throwing would let any peer blank the operator's
  // dashboard by sending one part kind this build does not know.
  function partText(p) {
    if (!p || typeof p !== "object") return "[malformed part]";
    if (p.kind === "text") return p.text;
    if (p.kind === "artifact") return `[artifact ${p.name} (${p.mediaType}, ${p.size} bytes) ${p.digest}]`;
    if (p.kind === "data") {
      const encoded = JSON.stringify(p.data);
      // `JSON.stringify(undefined)` returns the VALUE `undefined`, which `join` coerces to "" — the
      // original defect. Named separately from the kind marker below: "a data part with nothing in
      // it" and "a kind this build cannot render" are different facts, and a reader who sees one
      // must not conclude the other.
      return encoded === undefined ? "[empty data part]" : encoded;
    }
    return `[unrenderable part kind ${JSON.stringify(p.kind)} — no renderer for it on this surface]`;
  }

  function partsToText(parts) {
    if (parts == null) return "";
    if (!Array.isArray(parts)) throw new TypeError("COTAL_PARTS.partsToText: parts must be an array");
    return parts.map(partText).join(" ");
  }

  window.COTAL_PARTS = { partText, partsToText };
})();
