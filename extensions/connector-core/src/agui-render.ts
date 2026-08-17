/**
 * THE FIRST RENDERER THAT CAN DISPLAY AN AG-UI FRAME.
 *
 * A frame carries **no text part by design** — its content is a list of AG-UI events — so every
 * surface that renders a message as flat text draws one as `[unrenderable part kind "ag-ui.frame"]`.
 * This is the provider that fixes that for the console family: a core {@link PartRenderer} of kind
 * `part-renderer`, named for the part kind it draws, self-registering on import exactly as a
 * terminal-layout provider does.
 *
 * **IT LANDS BEFORE ANY PRODUCER, AND THAT ORDERING IS THE POINT.** At this tip nothing in
 * production publishes a frame: no connector constructs an emitter and every connector still writes
 * its `tr-<name>` text mirror. So this renderer has no live traffic to draw yet, and saying that
 * plainly matters more than it sounds, because the alternative ordering is the one that fails. A
 * cutover shipped first would replace a mirror a human can read with a part every surface shows as a
 * marker, and the regression would be invisible to the change that caused it. Display first, then
 * the producer.
 *
 * **CORE NEVER LEARNS AG-UI.** `partsToText` resolves a renderer by the part's own kind and calls
 * it. The knowledge of what a `TOOL_CALL_ARGS` means lives here, in the package that defined the
 * vocabulary, which is where `AGENTS.md` requires an adapter's concepts to stay. What moved into
 * core is only the frame's IDENTITY (`agui-kind.ts`) and the channel's NAME (`event-channel.ts`),
 * both of which a reader needs to recognise a frame without knowing who produced it.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────────────
 *
 * **It does not print raw event-type tokens.** A reader wants `bash({"cmd":"ls"}) -> ok`, not
 * `TOOL_CALL_START TOOL_CALL_ARGS TOOL_CALL_RESULT`. So the suite must not assert the token either:
 * gating on `TOOL_CALL_ARGS` appearing in the output would fail a correct renderer, which is why the
 * cells assert the FOLD (name, arguments, result) rather than the vocabulary.
 *
 * **It does not validate the frame as a schema.** `parseAguiFrame` checks the envelope and that each
 * event's `type` is in the vocabulary, and nothing else, which is measured rather than assumed. So
 * this renderer treats event fields as untrusted: every field access is guarded and a malformed
 * event degrades to a named marker rather than throwing. A renderer is the wrong place to discover a
 * producer's bug, and a very good place to make one visible.
 *
 * ── WHY IT ROUTES ON THE KIND AND NEVER ON SHAPE ────────────────────────────────────────────────
 *
 * Two formats will share one channel for exactly as long as the cutover takes: `events.<owner>.<actor>`
 * is designed to carry frames, while the connectors that have not cut over still publish plain text
 * parts to their own mirror. Registration is for `ag-ui.frame` ONLY, so a text part renders as the
 * text it is and never as a degenerate frame. The two cannot be confused because the routing is on
 * the part kind and not on a guess about shape.
 */
import { AGUI_EVENT_TYPE, AGUI_FRAME_KIND, isAguiFramePart, registry, type Part, type PartRenderer } from "@cotal-ai/core";

/** One event, as untrusted input. Every read is guarded; nothing here trusts a producer. */
type LooseEvent = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Line prefixes. **Every one of these starts with a non-space glyph within the first three columns,
 * and that is a requirement rather than a style choice.** Leading spaces do not establish a line
 * start, they indent one, so a prefix of spaces alone leaves the payload's first character still the
 * first character of the line. `CONT` therefore carries `·`, and no prefix here may be widened past
 * three leading spaces without re-deriving {@link LINE_START_SAFE}.
 */
const CONT = "  · ";
const TEXT_PREFIX = "» ";
const THINK_PREFIX = "(thinking) ";
const TOOL_PREFIX = "⚙ ";
const RESULT_PREFIX = "  ↳ ";

/**
 * A line this renderer is allowed to emit: one that cannot open a block construct.
 *
 * **Exported so the suite asserts the invariant against the SAME expression the renderer is
 * documented by**, rather than a second copy of it that can drift. It is a property of the emitted
 * lines and nothing more, deliberately not a claim about what any consumer does downstream, which
 * would be an assertion outside this module that no test here could hold up.
 *
 * The constructs are the block-level openers: ATX heading, bullet list, ordered list, blockquote,
 * table row, and the four-space indented code block, each of which is recognised with up to three
 * leading spaces, which is exactly why three is the ceiling above.
 */
export const LINE_START_SAFE = (line: string): boolean =>
  !/^ {0,3}(?:#|[-*+>|]|\d+[.)])(?:\s|$)/.test(line) && !/^ {4}/.test(line);

/**
 * Fold a frame's events into display lines.
 *
 * Deltas are ACCUMULATED rather than printed one per line: `TEXT_MESSAGE_CONTENT` arrives as a
 * stream of fragments, and a renderer that printed each one would turn a sentence into a column.
 * They are keyed by `messageId`/`toolCallId` so two interleaved streams do not braid into each
 * other; the ids exist precisely because interleaving is legal.
 */
function renderEvents(events: readonly LooseEvent[]): string[] {
  const lines: string[] = [];
  const text = new Map<string, string>();
  const reasoning = new Map<string, string>();
  const toolName = new Map<string, string>();
  const toolArgs = new Map<string, string>();

  /**
   * Emit a payload as lines, prefixing EVERY line, not just the first.
   *
   * **THE STRUCTURAL INVARIANT THIS EXISTS FOR: no emitted line begins with a payload character.**
   * Payload values are multi-line (a tool result is the common case, but pretty-printed args, a
   * multi-paragraph message and an error body all are), and pushing one of them as a single string
   * put its second and later lines at column 0 with nothing of the renderer's in front of them.
   *
   * At that point the payload is no longer inside the scaffolding, it IS scaffolding, and a consumer
   * that reads line starts cannot tell which lines the renderer wrote. **Measured: a tool result
   * whose second line began `- ` captured the frame's own `◂ run … finished` terminator into a list
   * the payload had opened.** The invariant is asserted over this function's output in the suite.
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
    // THE ELEMENT ITSELF IS UNTRUSTED, not just its fields. `events` is an array off the wire and
    // `parseAguiFrame` does not check that each element is an object, so `null` reaches here and a
    // bare `e.type` throws on it. The throw was not fatal (core's dispatcher turns it into a named
    // marker) and that is exactly what made it worth guarding: the whole frame degraded to one
    // failure line, so a single null element deleted every other event in the frame from the
    // reader's view. Named per element instead, so one malformed event costs one line.
    const type = typeof e === "object" && e !== null ? str(e.type) : undefined;
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
  // make a truncated turn indistinguishable from a silent one, which is the exact failure the mirror
  // had.
  for (const id of [...text.keys()]) flush(text, id, TEXT_PREFIX, TEXT_PREFIX, " …");
  for (const id of [...reasoning.keys()]) flush(reasoning, id, THINK_PREFIX, CONT, " …");
  for (const id of [...toolName.keys()]) emit(TOOL_PREFIX, CONT, `${toolName.get(id) ?? "?"}(${toolArgs.get(id) ?? ""}) …`);

  return lines;
}

/**
 * The registered provider. `name` IS the part kind, which is how core resolves it without ever
 * learning what the kind means.
 */
export const aguiFramePartRenderer: PartRenderer = Object.freeze({
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
});

/**
 * Register the provider, once, however many copies of this module get loaded.
 *
 * **THIS PACKAGE LEGITIMATELY EXISTS TWICE IN ONE PROCESS, AND A BARE `register` CRASHES THERE.**
 * Measured, not anticipated: `cotal ext add <connector>` failed with
 * `extension already registered: part-renderer:ag-ui.frame`, and the mechanism is the extension
 * prefix's layout. The CLI imports this module from its OWN copy of `connector-core`. Materializing
 * an installed connector imports `connector-core` again, from the extension prefix's `node_modules`,
 * which is a different physical file and therefore a second module instance with its own top-level
 * evaluation. `@cotal-ai/core` is LINKED to the CLI's single copy (`ext add` writes that link on
 * purpose), so both instances see ONE registry, and `registry.register` throws on the duplicate
 * `kind:name`. That throw took down `ext add` for every connector.
 *
 * **WHY THIS IS NOT THE SILENT DEGRADE THE PROJECT REFUSES.** `register`'s refusal exists to catch
 * TWO EXTENSIONS CLAIMING ONE NAME, which is a genuine conflict nobody can adjudicate. This is one
 * extension arriving twice, which is not a conflict: `ag-ui.frame` is defined by this package, no
 * other package may claim it, and every copy of this file registers a provider that draws it the
 * same way. First one wins, deterministically, and the second is a no-op rather than a fatal error
 * on a path a customer runs. Skipping a duplicate self-registration is a different act from
 * swallowing a failure.
 *
 * It is a named function rather than a bare guard so the property is executable: a cell calls it
 * twice and asserts the second call neither throws nor displaces the first.
 */
export function registerAguiFramePartRenderer(): void {
  if (registry.has("part-renderer", AGUI_FRAME_KIND)) return;
  registry.register(aguiFramePartRenderer);
}

registerAguiFramePartRenderer();
