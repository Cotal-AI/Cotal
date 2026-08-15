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

  /** Flush an accumulator as one line, if it has anything in it. */
  const flush = (map: Map<string, string>, id: string, fmt: (s: string) => string): void => {
    const acc = map.get(id);
    if (acc !== undefined && acc.length > 0) lines.push(fmt(acc));
    map.delete(id);
  };

  for (const e of events) {
    const type = str(e.type);
    switch (type) {
      case AGUI_EVENT_TYPE.RUN_STARTED:
        lines.push(`▸ run ${str(e.runId) ?? "?"} started`);
        break;
      case AGUI_EVENT_TYPE.RUN_FINISHED: {
        // `outcome` is optional by the real schema — a turn that merely ended says nothing more, and
        // manufacturing "success" would assert something the source never said.
        const outcome = str((e.outcome as LooseEvent | undefined)?.type);
        lines.push(`◂ run ${str(e.runId) ?? "?"} finished${outcome ? ` (${outcome})` : ""}`);
        break;
      }
      case AGUI_EVENT_TYPE.RUN_ERROR: {
        const code = str(e.code);
        lines.push(`✗ run error${code ? ` [${code}]` : ""}: ${str(e.message) ?? "(no message)"}`);
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
        flush(text, str(e.messageId) ?? "", (s) => s);
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
        flush(reasoning, str(e.messageId) ?? "", (s) => `(thinking) ${s}`);
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
        lines.push(`⚙ ${toolName.get(id) ?? "?"}(${toolArgs.get(id) ?? ""})`);
        toolName.delete(id);
        toolArgs.delete(id);
        break;
      }
      case AGUI_EVENT_TYPE.TOOL_CALL_RESULT:
        lines.push(`  ↳ ${str(e.content) ?? "(no content)"}`);
        break;

      case AGUI_EVENT_TYPE.CUSTOM:
        lines.push(`• custom ${str(e.name) ?? "(unnamed)"}`);
        break;

      // An event whose `type` this build does not know. NAMED, never skipped — a skipped event is a
      // hole in a transcript that still looks complete, which is `parseAguiFrame`'s own stated
      // reason for refusing one. Here the surface is a reader rather than a parser, so it is shown.
      default:
        lines.push(`• unrecognised event ${JSON.stringify(type ?? null)}`);
    }
  }

  // A stream that ended without its END event still has content a reader needs. Dropping it would
  // make a truncated turn indistinguishable from a silent one — the exact failure the mirror had.
  for (const id of [...text.keys()]) flush(text, id, (s) => `${s} …`);
  for (const id of [...reasoning.keys()]) flush(reasoning, id, (s) => `(thinking) ${s} …`);
  for (const id of [...toolName.keys()]) lines.push(`⚙ ${toolName.get(id) ?? "?"}(${toolArgs.get(id) ?? ""}) …`);

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
