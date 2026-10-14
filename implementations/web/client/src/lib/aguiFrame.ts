// The browser renderer for `ag-ui.frame` parts, the dashboard's half of the AG-UI display path.
//
// Why a second implementation exists at all, since duplication is what this tree normally refuses.
// The client is bundled for a browser and imports nothing from `@cotal-ai/*` at runtime, so it
// cannot reach `extensions/connector-core/src/agui-render.ts`, which is the same renderer for every
// other surface. There is no seam that makes one implementation serve both: the constraint is the
// tier rule, not a design choice. So the two are kept in step by an equivalence instrument rather
// than by intent. "We will keep them in sync" was explicitly refused as a plan; a cell that reddens
// when they diverge is the only version that survives us. That cell is
// `bin/smoke/agui-render-parity.smoke.ts`, and it earned its place before this file shipped: an
// earlier draft of this pair used `||` here against `??` there, so an event carrying an empty
// string for `content`, `runId` or `toolCallName` rendered one way in the console and another way in
// the browser. Every fallback below therefore keys on `undefined` and never on falsiness, which is
// what `str()` returning `undefined` for a non-string is for.
//
// The output must match `agui-render.ts` over the same frame. Every glyph, prefix and fallback
// string below is chosen to match it, not to look right here. If you change one, you are changing a
// contract that another file also implements.
//
// The line-start invariant, which is not cosmetic. Every line this emits begins with a prefix
// carrying a non-space glyph inside the first three columns, and payload never starts a line. That
// matters here because message bodies are rendered as Markdown (gfm + breaks), so a payload line
// beginning `- ` or `# ` opens a markdown block. Measured on the shipped pipeline: a tool result
// whose second line began `- ` opened a list that captured the frame's own `run finished`
// terminator into a list item the payload created. Payload restructured scaffolding. Leading spaces
// do not establish a line start: markdown recognises a heading under up to three of them, and four
// spaces means a code block instead. A non-space glyph is the only prefix that is inert in both
// directions.
//
// What it does not do: validate. The frame arrives over the wire and every field read here is
// guarded, so a malformed event degrades to a named marker rather than throwing. A renderer is the
// wrong place to discover a producer's bug and a very good place to make one visible.
//
// It registers itself rather than being wired in by `parts.ts`, so the dispatcher keeps knowing
// nothing about AG-UI. A failed or absent registration degrades to
// `[unrenderable part kind "ag-ui.frame" ...]`, true and named, which is the honest-refusal property
// that module exists for and the reason this is not a branch inside it.
import { registerPartRenderer } from "./parts.js";

const KIND = "ag-ui.frame";

const CONT = "  · ";
const TEXT_PREFIX = "» ";
const THINK_PREFIX = "(thinking) ";
const TOOL_PREFIX = "⚙ ";
const RESULT_PREFIX = "  ↳ ";

/** An event off the wire. Nothing about its shape is trusted. */
type Wire = Record<string, any>;

// `undefined` for anything that is not a string, so a caller can tell ABSENT from EMPTY. Every
// fallback below uses `??` on this, never `||`: an event carrying `content: ""` reported a tool that
// returned nothing, and printing `(no content)` for it would state something the producer did not.
// `agui-render.ts` draws exactly this distinction and the parity suite pins it.
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// Prefix every line, not just the first. Payload values are multi-line (a tool result is the common
// case, but pretty-printed args, a multi-paragraph message and an error body all are) and emitting
// one as a single string puts its second and later lines at column 0 with nothing of the renderer's
// in front of them.
// `body` is a string at every call site (a template literal, a `str() ?? fallback`, or an
// accumulator concat), so it is not coerced here. A `String(body)` would be the only difference
// between this fold and the node one, and a difference whose whole purpose is to absorb a case that
// cannot arrive is the kind that survives until the case does arrive and then diverges silently.
function emit(lines: string[], first: string, cont: string, body: string): void {
  const parts = body.split("\n");
  lines.push(first + parts[0]);
  for (let i = 1; i < parts.length; i += 1) lines.push(cont + parts[i]);
}

function flush(lines: string[], map: Map<string, string>, id: string, first: string, cont: string, suffix?: string): void {
  const acc = map.get(id);
  if (acc !== undefined && acc.length > 0) emit(lines, first, cont, acc + (suffix || ""));
  map.delete(id);
}

/** Draw a frame's events as the lines the dashboard shows.
 *
 *  Deltas are accumulated rather than printed one per line: content arrives as a stream of
 *  fragments, and printing each would turn a sentence into a column. Keyed by messageId or
 *  toolCallId so two interleaved streams do not braid, since the ids exist because interleaving is
 *  legal.
 *
 *  A `Map`, not a plain object, and this is the one structural decision here that a reader would
 *  otherwise "simplify" back into a bug. Ids come off the wire, so they are attacker- and
 *  accident-shaped, and a plain object diverges from `agui-render.ts`'s Maps on two of them: an
 *  integer-like id ("2", "10") is an array index to an object, so `Object.keys` returns it in
 *  ascending numeric order regardless of insertion and two unterminated streams flush in the wrong
 *  order on one surface only; and `__proto__` never becomes an own key at all, so that stream is
 *  silently dropped. Both are invisible in the ordinary case and both are pinned by cells in the
 *  parity suite. */
export function renderEvents(events: unknown[]): string[] {
  const lines: string[] = [];
  const text = new Map<string, string>();
  const reasoning = new Map<string, string>();
  const toolName = new Map<string, string>();
  const toolArgs = new Map<string, string>();

  for (const ev of events) {
    // The element itself is untrusted, not just its fields. `events` is an array off the wire and
    // nothing upstream checks that each element is an object, so `null` reaches here and a bare
    // `e.type` throws on it. `parts.ts` would catch that into a named marker, which means one null
    // element would delete every other event in the frame from the reader's view. Named per element
    // instead, matching `agui-render.ts`, so one malformed event costs one line.
    const e = ev as Wire;
    const type = typeof e === "object" && e !== null ? str(e.type) : undefined;
    switch (type) {
      case "RUN_STARTED":
        emit(lines, "▸ ", CONT, `run ${str(e.runId) ?? "?"} started`);
        break;
      case "RUN_FINISHED": {
        // `outcome` is optional by the real schema. A turn that merely ended says nothing more, and
        // manufacturing "success" would assert something the source never said.
        const outcome = str(e.outcome?.type);
        emit(lines, "◂ ", CONT, `run ${str(e.runId) ?? "?"} finished${outcome ? ` (${outcome})` : ""}`);
        break;
      }
      case "RUN_ERROR": {
        const code = str(e.code);
        emit(lines, "✗ ", CONT, `run error${code ? ` [${code}]` : ""}: ${str(e.message) ?? "(no message)"}`);
        break;
      }

      case "TEXT_MESSAGE_START":
        text.set(str(e.messageId) ?? "", "");
        break;
      case "TEXT_MESSAGE_CONTENT": {
        const id = str(e.messageId) ?? "";
        text.set(id, (text.get(id) ?? "") + (str(e.delta) ?? ""));
        break;
      }
      case "TEXT_MESSAGE_END":
        flush(lines, text, str(e.messageId) ?? "", TEXT_PREFIX, TEXT_PREFIX);
        break;

      case "REASONING_MESSAGE_START":
        reasoning.set(str(e.messageId) ?? "", "");
        break;
      case "REASONING_MESSAGE_CONTENT": {
        const id = str(e.messageId) ?? "";
        reasoning.set(id, (reasoning.get(id) ?? "") + (str(e.delta) ?? ""));
        break;
      }
      case "REASONING_MESSAGE_END":
        flush(lines, reasoning, str(e.messageId) ?? "", THINK_PREFIX, CONT);
        break;

      case "TOOL_CALL_START": {
        const id = str(e.toolCallId) ?? "";
        toolName.set(id, str(e.toolCallName) ?? "?");
        toolArgs.set(id, "");
        break;
      }
      case "TOOL_CALL_ARGS": {
        const id = str(e.toolCallId) ?? "";
        toolArgs.set(id, (toolArgs.get(id) ?? "") + (str(e.delta) ?? ""));
        break;
      }
      case "TOOL_CALL_END": {
        const id = str(e.toolCallId) ?? "";
        emit(lines, TOOL_PREFIX, CONT, `${toolName.get(id) ?? "?"}(${toolArgs.get(id) ?? ""})`);
        toolName.delete(id);
        toolArgs.delete(id);
        break;
      }
      case "TOOL_CALL_RESULT":
        emit(lines, RESULT_PREFIX, CONT, str(e.content) ?? "(no content)");
        break;

      case "CUSTOM":
        emit(lines, "• ", CONT, `custom ${str(e.name) ?? "(unnamed)"}`);
        break;

      // An event whose type this build does not know. Named, never skipped: a skipped event is a
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
    emit(lines, TOOL_PREFIX, CONT, `${toolName.get(id) ?? "?"}(${toolArgs.get(id) ?? ""}) …`);
  }

  return lines;
}

/** Draw one `ag-ui.frame` part as text. */
export function renderAguiFrame(p: unknown): string {
  // Defensive rather than trusting, mirroring `agui-render.ts`: the dispatcher resolved us by kind,
  // so this cannot fire through `parts.ts` today, but a renderer is a plain function and anything
  // can call it. Without this, a non-frame part is told it is a frame "carrying no events", which is
  // a false statement about the part rather than a refusal to draw it. Found by the parity suite,
  // not by reading: node refused and the browser did not.
  const part = p as Wire | null;
  if (typeof part !== "object" || part === null || part.kind !== KIND) return "[not an AG-UI frame]";
  const events = part.events;
  if (!Array.isArray(events) || events.length === 0) return "[AG-UI frame carrying no events]";
  const lines = renderEvents(events);
  // Impossible today (every branch pushes), but a future branch returning nothing must not become
  // the silent empty string this whole exercise exists to remove.
  return lines.length > 0
    ? lines.join("\n")
    : `[AG-UI frame with ${events.length} event(s) and nothing to show]`;
}

registerPartRenderer(KIND, renderAguiFrame);
