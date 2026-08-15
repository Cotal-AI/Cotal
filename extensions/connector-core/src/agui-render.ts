/**
 * THE FIRST RENDERER THAT CAN DISPLAY AN AG-UI FRAME.
 *
 * A frame carries **no text part by design** — its content is a list of AG-UI events — so every
 * surface that renders a message as flat text has shown nothing for one since the day frames started
 * being published. This is the provider that fixes that for the console family: a core
 * {@link PartRenderer} of kind `part-renderer`, named for the part kind it draws, self-registering on
 * import exactly as the tmux terminal provider does.
 *
 * **CORE NEVER LEARNS AG-UI.** It resolves a renderer by the part's own kind and calls it. The
 * knowledge of what a `TOOL_CALL_ARGS` means lives here, in the extension that defined the vocabulary,
 * which is where `AGENTS.md` requires it to stay.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────────────
 *
 * **It does not print raw event-type tokens.** A reader wants `bash({"cmd":"ls"}) -> ok`, not
 * `TOOL_CALL_START TOOL_CALL_ARGS TOOL_CALL_RESULT`. The renderer-precondition suite asserts the
 * tokens in a set of cells that are deliberately NOT gates, for exactly this reason: gating on the
 * token would fail a correct renderer. **Those cells are expected to stay red against this
 * implementation and that is the designed outcome, not a regression** — they are reported apart from
 * the gate so the distinction survives.
 *
 * **It does not validate the frame as a schema.** `parseAguiFrame` checks the envelope and that each
 * event's `type` is in the vocabulary, and NOTHING ELSE — measured. So this renderer treats event
 * fields as untrusted: every field access is guarded and a malformed event degrades to a named
 * marker rather than throwing. A renderer is the wrong place to discover a producer's bug, but it is
 * a very good place to make one visible.
 *
 * ── WHY IT REFUSES RATHER THAN GUESSES ──────────────────────────────────────────────────────────
 *
 * **Two formats share one channel.** `events.<owner>.<actor>` carries AG-UI frames from the Claude
 * connector and the OLD condensed text mirror from the codex and opencode connectors, which publish
 * plain text parts to the same subject. That is the transcript-mirror abolition being half-done, and
 * this renderer is the first thing that sees both. It is registered for `ag-ui.frame` ONLY, so a text
 * line from the old mirror renders as the text part it actually is and **never as a degenerate
 * frame** — the two cannot be confused, because the routing is on the part kind and not on a guess
 * about shape.
 */
import type { Part } from "@cotal-ai/core";
import { registry, type PartRenderer } from "@cotal-ai/core";
import { AGUI_FRAME_KIND, AGUI_EVENT_TYPE, isAguiFramePart } from "./agui.js";

/** One event, as untrusted input. Every read is guarded; nothing here trusts a producer. */
type LooseEvent = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Line prefixes. **Every one of these starts with a non-space glyph within the first three columns,
 * and that is a requirement rather than a style choice.** Leading spaces do not establish a line
 * start — they indent one — so a prefix of spaces alone leaves the payload's first character still
 * the first character of the line. `CONT` therefore carries `·`, and no prefix here may be widened
 * past three leading spaces without re-deriving {@link LINE_START_SAFE}.
 */
const CONT = "  · ";
const TEXT_PREFIX = "» ";
const THINK_PREFIX = "(thinking) ";
const TOOL_PREFIX = "⚙ ";
const RESULT_PREFIX = "  ↳ ";

/**
 * A line this renderer is allowed to emit: one that cannot open a block construct.
 *
 * **This is exported so the suite asserts the invariant against the SAME expression the renderer is
 * documented by, rather than a second copy of it that can drift.** It is a property of the emitted
 * lines and nothing more — deliberately not a claim about what any consumer does downstream, which
 * would be an assertion outside this module that no test here could hold up.
 *
 * The constructs are the block-level openers: ATX heading, bullet list, ordered list, blockquote,
 * table row, and the four-space indented code block — each of which is recognised with up to three
 * leading spaces, which is exactly why three is the ceiling above.
 */
export const LINE_START_SAFE = (line: string): boolean =>
  !/^ {0,3}(?:#|[-*+>|]|\d+[.)])(?:\s|$)/.test(line) && !/^ {4}/.test(line);

/**
 * Fold a frame's events into display lines.
 *
 * Deltas are ACCUMULATED rather than printed one per line: `TEXT_MESSAGE_CONTENT` arrives as a
 * stream of fragments, and a renderer that printed each one would turn a sentence into a column.
 * They are keyed by `messageId`/`toolCallId` so two interleaved streams do not braid into each other
 * — the ids exist precisely because interleaving is legal.
 */
function renderEvents(events: readonly LooseEvent[]): string[] {
  const lines: string[] = [];
  const text = new Map<string, string>();
  const reasoning = new Map<string, string>();
  const toolName = new Map<string, string>();
  const toolArgs = new Map<string, string>();

  /**
   * Emit a payload as lines, prefixing EVERY line — not just the first.
   *
   * **THE STRUCTURAL INVARIANT THIS EXISTS FOR: no emitted line begins with a payload character.**
   * Payload values are multi-line (a tool result is the common case, but pretty-printed args, a
   * multi-paragraph message and an error body all are), and pushing one of them as a single string
   * put its second and later lines at column 0 with nothing of the renderer's in front of them.
   *
   * At that point the payload is no longer inside the scaffolding — it IS scaffolding, and a
   * consumer that reads line starts cannot tell which lines the renderer wrote. **Measured: a tool
   * result whose second line began `- ` captured the frame's own `◂ run … finished` terminator into
   * a list the payload had opened.** The invariant is asserted over this function's output in the
   * suite; it is deliberately stated as a property of what is emitted here, not as a claim about
   * what any particular consumer does with it.
   *
   * `cont` carries a non-space glyph for the same reason `first` does: leading spaces alone do not
   * establish a line start, they only indent one.
   */
  const emit = (first: string, cont: string, body: string): void => {
    const [head, ...rest] = body.split("\n");
    lines.push(first + head);
    for (const l of rest) lines.push(cont + l);
  };

  /** Flush an accumulator, if it has anything in it. */
  const flush = (map: Map<string, string>, id: string, first: string, cont: string, suffix = ""): void => {
    const acc = map.get(id);
    if (acc !== undefined && acc.length > 0) emit(first, cont, acc + suffix);
    map.delete(id);
  };

  for (const e of events) {
    const type = str(e.type);
    switch (type) {
      case AGUI_EVENT_TYPE.RUN_STARTED:
        emit("▸ ", CONT, `run ${str(e.runId) ?? "?"} started`);
        break;
      case AGUI_EVENT_TYPE.RUN_FINISHED: {
        // `outcome` is optional by the real schema — a turn that merely ended says nothing more, and
        // manufacturing "success" would assert something the source never said.
        const outcome = str((e.outcome as LooseEvent | undefined)?.type);
        emit("◂ ", CONT, `run ${str(e.runId) ?? "?"} finished${outcome ? ` (${outcome})` : ""}`);
        break;
      }
      case AGUI_EVENT_TYPE.RUN_ERROR: {
        const code = str(e.code);
        emit("✗ ", CONT, `run error${code ? ` [${code}]` : ""}: ${str(e.message) ?? "(no message)"}`);
        break;
      }

      case AGUI_EVENT_TYPE.TEXT_MESSAGE_START:
        text.set(str(e.messageId) ?? "", "");
        break;
      case AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT: {
        const id = str(e.messageId) ?? "";
        text.set(id, (text.get(id) ?? "") + (str(e.delta) ?? ""));
        break;
      }
      case AGUI_EVENT_TYPE.TEXT_MESSAGE_END:
        flush(text, str(e.messageId) ?? "", TEXT_PREFIX, TEXT_PREFIX);
        break;

      case AGUI_EVENT_TYPE.REASONING_MESSAGE_START:
        reasoning.set(str(e.messageId) ?? "", "");
        break;
      case AGUI_EVENT_TYPE.REASONING_MESSAGE_CONTENT: {
        const id = str(e.messageId) ?? "";
        reasoning.set(id, (reasoning.get(id) ?? "") + (str(e.delta) ?? ""));
        break;
      }
      case AGUI_EVENT_TYPE.REASONING_MESSAGE_END:
        flush(reasoning, str(e.messageId) ?? "", THINK_PREFIX, CONT);
        break;

      case AGUI_EVENT_TYPE.TOOL_CALL_START: {
        const id = str(e.toolCallId) ?? "";
        toolName.set(id, str(e.toolCallName) ?? "?");
        toolArgs.set(id, "");
        break;
      }
      case AGUI_EVENT_TYPE.TOOL_CALL_ARGS: {
        const id = str(e.toolCallId) ?? "";
        toolArgs.set(id, (toolArgs.get(id) ?? "") + (str(e.delta) ?? ""));
        break;
      }
      case AGUI_EVENT_TYPE.TOOL_CALL_END: {
        const id = str(e.toolCallId) ?? "";
        emit(TOOL_PREFIX, CONT, `${toolName.get(id) ?? "?"}(${toolArgs.get(id) ?? ""})`);
        toolName.delete(id);
        toolArgs.delete(id);
        break;
      }
      case AGUI_EVENT_TYPE.TOOL_CALL_RESULT:
        emit(RESULT_PREFIX, CONT, str(e.content) ?? "(no content)");
        break;

      case AGUI_EVENT_TYPE.CUSTOM:
        emit("• ", CONT, `custom ${str(e.name) ?? "(unnamed)"}`);
        break;

      // An event whose `type` this build does not know. NAMED, never skipped — a skipped event is a
      // hole in a transcript that still looks complete, which is `parseAguiFrame`'s own stated
      // reason for refusing one. Here the surface is a reader rather than a parser, so it is shown.
      default:
        emit("• ", CONT, `unrecognised event ${JSON.stringify(type ?? null)}`);
    }
  }

  // A stream that ended without its END event still has content a reader needs. Dropping it would
  // make a truncated turn indistinguishable from a silent one — the exact failure the mirror had.
  for (const id of [...text.keys()]) flush(text, id, TEXT_PREFIX, TEXT_PREFIX, " …");
  for (const id of [...reasoning.keys()]) flush(reasoning, id, THINK_PREFIX, CONT, " …");
  for (const id of [...toolName.keys()]) emit(TOOL_PREFIX, CONT, `${toolName.get(id) ?? "?"}(${toolArgs.get(id) ?? ""}) …`);

  return lines;
}

/**
 * The registered provider. `name` IS the part kind, which is how core resolves it without knowing
 * what the kind means.
 */
export const aguiFramePartRenderer: PartRenderer = {
  kind: "part-renderer",
  name: AGUI_FRAME_KIND,
  render(part: Part): string {
    // Defensive rather than trusting: core resolved us by kind, but a caller can hand us anything.
    if (!isAguiFramePart(part)) return `[not an AG-UI frame]`;
    const events = (part as unknown as { events?: unknown }).events;
    if (!Array.isArray(events) || events.length === 0) return `[AG-UI frame carrying no events]`;
    const lines = renderEvents(events as LooseEvent[]);
    // An events array that produced no lines is impossible today (every branch pushes), but if a
    // future branch returns nothing this must not become the silent empty string that the whole
    // exercise exists to remove.
    return lines.length > 0 ? lines.join("\n") : `[AG-UI frame with ${events.length} event(s) and nothing to show]`;
  },
};

registry.register(aguiFramePartRenderer);
