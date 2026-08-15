// The browser renderer for `ag-ui.frame` parts — the dashboard's half of the AG-UI display path.
//
// WHY A SECOND IMPLEMENTATION EXISTS AT ALL, since duplication is what this tree normally refuses.
// `src/web/*.js` are classic <script> files served to a browser. They cannot import
// `@cotal-ai/core`, so they cannot reach `extensions/connector-core/src/agui-render.ts`, which is
// the same renderer for every other surface. There is no seam that makes one implementation serve
// both — the constraint is the module system, not a design choice — so the two are kept in step by
// an EQUIVALENCE INSTRUMENT rather than by intent. "We will keep them in sync" was explicitly
// refused as a plan; a cell that reddens when they diverge is the only version that survives us.
//
// THE OUTPUT MUST MATCH `agui-render.ts` BYTE FOR BYTE over the same frame. Every glyph, prefix and
// fallback string below is chosen to match it, not to look right here. If you change one, you are
// changing a contract that another file also implements.
//
// ── THE LINE-START INVARIANT, WHICH IS NOT COSMETIC ─────────────────────────────────────────────
//
// Every line this emits begins with a prefix carrying a non-space glyph inside the first three
// columns, and payload NEVER starts a line. That is load-bearing on this surface specifically:
// `app.js` pipes body text through `MD.render` (marked, gfm + breaks), so a payload line beginning
// `- ` or `# ` opens a markdown block. Measured on the shipped pipeline: a tool result whose second
// line began `- ` opened a list that CAPTURED the frame's own `run finished` terminator into a list
// item the payload created. Payload restructured scaffolding.
//
// Leading spaces do NOT establish a line start — markdown recognises a heading under up to three of
// them, and four spaces means a code block instead. A non-space glyph is the only prefix that is
// inert in both directions.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────────────────────
//
// It does not validate. The frame arrives over the wire and every field read here is guarded: a
// malformed event degrades to a named marker rather than throwing. A renderer is the wrong place to
// discover a producer's bug and a very good place to make one visible.
//
// It registers itself rather than being wired in by `parts.js`, so the dispatcher keeps knowing
// nothing about AG-UI. A failed or absent registration degrades to
// `[unrenderable part kind "ag-ui.frame" …]` — TRUE and NAMED — which is the honest-refusal property
// that file exists for and the reason this is not a branch inside it.
(() => {
  const KIND = "ag-ui.frame";

  // Created if absent, so this file and `parts.js` may load in either order. Script order is
  // load-bearing on this surface for other reasons; it must not also be load-bearing for this.
  window.COTAL_PART_RENDERERS = window.COTAL_PART_RENDERERS || {};

  const CONT = "  · ";
  const TEXT_PREFIX = "» ";
  const THINK_PREFIX = "(thinking) ";
  const TOOL_PREFIX = "⚙ ";
  const RESULT_PREFIX = "  ↳ ";

  const str = (v) => (typeof v === "string" ? v : undefined);

  // Prefix EVERY line, not just the first. Payload values are multi-line — a tool result is the
  // common case, but pretty-printed args, a multi-paragraph message and an error body all are — and
  // emitting one as a single string puts its second and later lines at column 0 with nothing of the
  // renderer's in front of them.
  function emit(lines, first, cont, body) {
    const parts = String(body).split("\n");
    lines.push(first + parts[0]);
    for (let i = 1; i < parts.length; i += 1) lines.push(cont + parts[i]);
  }

  function flush(lines, map, id, first, cont, suffix) {
    const acc = map.get(id);
    if (acc !== undefined && acc.length > 0) emit(lines, first, cont, acc + (suffix || ""));
    map.delete(id);
  }

  // Deltas are ACCUMULATED rather than printed one per line: content arrives as a stream of
  // fragments, and a renderer that printed each would turn a sentence into a column. Keyed by
  // messageId / toolCallId so two interleaved streams do not braid — the ids exist because
  // interleaving is legal.
  //
  // `Map`, NOT a plain object, and this is the one structural decision in the file that a reader
  // would otherwise "simplify" back into a bug. Ids come off the wire, so they are attacker- and
  // accident-shaped, and a plain object diverges from `agui-render.ts`'s Maps on two of them:
  //   - an INTEGER-LIKE id ("2", "10") is an array index to an object, so `Object.keys` returns it
  //     in ascending NUMERIC order regardless of insertion — two unterminated streams flush in the
  //     wrong order, on one surface only;
  //   - `__proto__` never becomes an own key at all, so that stream is silently DROPPED.
  // Both are invisible in the ordinary case and both are pinned by cells in the parity suite.
  function renderEvents(events) {
    const lines = [];
    const text = new Map();
    const reasoning = new Map();
    const toolName = new Map();
    const toolArgs = new Map();

    for (const e of events) {
      const type = str(e.type);
      switch (type) {
        case "RUN_STARTED":
          emit(lines, "▸ ", CONT, `run ${str(e.runId) || "?"} started`);
          break;
        case "RUN_FINISHED": {
          // `outcome` is optional by the real schema. A turn that merely ended says nothing more,
          // and manufacturing "success" would assert something the source never said.
          const outcome = e.outcome && str(e.outcome.type);
          emit(lines, "◂ ", CONT, `run ${str(e.runId) || "?"} finished${outcome ? ` (${outcome})` : ""}`);
          break;
        }
        case "RUN_ERROR": {
          const code = str(e.code);
          emit(lines, "✗ ", CONT, `run error${code ? ` [${code}]` : ""}: ${str(e.message) || "(no message)"}`);
          break;
        }

        case "TEXT_MESSAGE_START":
          text.set(str(e.messageId) || "", "");
          break;
        case "TEXT_MESSAGE_CONTENT": {
          const id = str(e.messageId) || "";
          text.set(id, (text.get(id) || "") + (str(e.delta) || ""));
          break;
        }
        case "TEXT_MESSAGE_END":
          flush(lines, text, str(e.messageId) || "", TEXT_PREFIX, TEXT_PREFIX);
          break;

        case "REASONING_MESSAGE_START":
          reasoning.set(str(e.messageId) || "", "");
          break;
        case "REASONING_MESSAGE_CONTENT": {
          const id = str(e.messageId) || "";
          reasoning.set(id, (reasoning.get(id) || "") + (str(e.delta) || ""));
          break;
        }
        case "REASONING_MESSAGE_END":
          flush(lines, reasoning, str(e.messageId) || "", THINK_PREFIX, CONT);
          break;

        case "TOOL_CALL_START": {
          const id = str(e.toolCallId) || "";
          toolName.set(id, str(e.toolCallName) || "?");
          toolArgs.set(id, "");
          break;
        }
        case "TOOL_CALL_ARGS": {
          const id = str(e.toolCallId) || "";
          toolArgs.set(id, (toolArgs.get(id) || "") + (str(e.delta) || ""));
          break;
        }
        case "TOOL_CALL_END": {
          const id = str(e.toolCallId) || "";
          emit(lines, TOOL_PREFIX, CONT, `${toolName.get(id) || "?"}(${toolArgs.get(id) || ""})`);
          toolName.delete(id);
          toolArgs.delete(id);
          break;
        }
        case "TOOL_CALL_RESULT":
          emit(lines, RESULT_PREFIX, CONT, str(e.content) || "(no content)");
          break;

        case "CUSTOM":
          emit(lines, "• ", CONT, `custom ${str(e.name) || "(unnamed)"}`);
          break;

        // An event whose type this build does not know. NAMED, never skipped — a skipped event is a
        // hole in a transcript that still looks complete.
        default:
          emit(lines, "• ", CONT, `unrecognised event ${JSON.stringify(type === undefined ? null : type)}`);
      }
    }

    // A stream that ended without its END event still has content a reader needs. Dropping it would
    // make a truncated turn indistinguishable from a silent one.
    for (const id of [...text.keys()]) flush(lines, text, id, TEXT_PREFIX, TEXT_PREFIX, " …");
    for (const id of [...reasoning.keys()]) flush(lines, reasoning, id, THINK_PREFIX, CONT, " …");
    for (const id of [...toolName.keys()]) {
      emit(lines, TOOL_PREFIX, CONT, `${toolName.get(id) || "?"}(${toolArgs.get(id) || ""}) …`);
    }

    return lines;
  }

  window.COTAL_PART_RENDERERS[KIND] = function renderAguiFrame(p) {
    // Defensive rather than trusting, mirroring `agui-render.ts`: the dispatcher resolved us BY
    // KIND, so this cannot fire through `parts.js` today — but a renderer is a plain function on a
    // global map and anything can call it. Without this, a non-frame part is told it is a frame
    // "carrying no events", which is a false statement about the part rather than a refusal to draw
    // it. Found by the parity suite, not by reading: node refused and the browser did not.
    if (typeof p !== "object" || p === null || p.kind !== KIND) return "[not an AG-UI frame]";
    const events = p.events;
    if (!Array.isArray(events) || events.length === 0) return "[AG-UI frame carrying no events]";
    const lines = renderEvents(events);
    // Impossible today (every branch pushes), but a future branch returning nothing must not become
    // the silent empty string this whole exercise exists to remove.
    return lines.length > 0
      ? lines.join("\n")
      : `[AG-UI frame with ${events.length} event(s) and nothing to show]`;
  };
})();
