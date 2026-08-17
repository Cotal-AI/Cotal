/**
 * The AG-UI frame's identity on the wire: the part kind, the event `type` discriminators, and the
 * routing predicate.
 *
 * WHY THIS IS IN CORE AND NOT IN A CONNECTOR, because the file it was cut out of is an extension.
 * Cotal ADOPTED the AG-UI event vocabulary as the way it streams agent events; the transport stays
 * Cotal. A vocabulary the standard adopts is a standard concept. The test is not where the code
 * happened to be written — it is **whether one adapter's choices could change it while the others
 * are unaffected**, and `ag-ui.frame` fails that test in the direction that matters: every connector
 * emits it, it travels on the wire, and no adapter may redefine it unilaterally. A shape all
 * adapters must agree on is a protocol shape.
 *
 * Its previous home in `@cotal-ai/connector-core` was an artifact of where the EMITTER was built,
 * not a judgement that the kind belongs to an adapter. The emitter, the constructors, the zod
 * validation and the frame envelope all stay there. **Only the identity moves** — the part of the
 * vocabulary a READER needs in order to recognise and draw a frame without knowing who produced it.
 *
 * WHAT IS DELIBERATELY NOT HERE. `AGUI_PROTOCOL` (the envelope version) and every event
 * CONSTRUCTOR remain in `connector-core`. They are producer-side, and nothing in core needs them to
 * recognise or render a frame. The line is drawn at what a consumer requires; moving more would
 * widen core for no reader's benefit.
 *
 * THE ZOD BOUNDARY IS THE REASON THIS FILE IS PLAIN LITERALS. `@ag-ui/core` is a types-only,
 * exact-pinned `devDependency` of `connector-core` specifically so that no zod copy reaches a
 * bundled connector — and it is **not resolvable from `packages/core` at all** (verified:
 * `MODULE_NOT_FOUND` from here, resolvable from `connector-core`). So core structurally cannot
 * depend on the AG-UI package, and pnpm's isolation makes that a build failure rather than a silent
 * regression. Nothing below imports it, and nothing below may.
 */

/** The frame's `kind`, distinguishing it from every other part a Cotal message can carry. */
export const AGUI_FRAME_KIND = "ag-ui.frame";

/**
 * The `type` discriminators, as literals.
 *
 * `EventType` in `@ag-ui/core` is a real (non-const) enum, so reading `EventType.RUN_STARTED` as a
 * VALUE would be a runtime import of a package this module is forbidden to depend on — and, since
 * the move into core, one it cannot even resolve. So the literals are written out.
 *
 * **They are still checked against the real enum, and that check did not move.** The conformance
 * smoke lives in `connector-core`, where `@ag-ui/core` IS available, and asserts each literal
 * against its enum member. That relationship is the whole reason these are safe to hand-write:
 * a hand-copied literal that nothing compares to its source is exactly the drift this lane has
 * already shipped once. If that smoke is ever deleted, these become unverified copies.
 */
export const AGUI_EVENT_TYPE = Object.freeze({
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
  REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
  REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
  CUSTOM: "CUSTOM",
} as const);

/**
 * Is this part an AG-UI frame? A boolean, never a throw.
 *
 * The routing question and the validity question are deliberately separate. This answers "should the
 * frame renderer draw this?" and cannot fail; `parseAguiFrame` (in `connector-core`) answers "is this
 * well formed?" and throws with the offending field named. Collapsing them would make a version skew
 * look exactly like someone else's message, and a renderer would show an empty pane for a stream it
 * is actively failing to parse.
 */
export function isAguiFramePart(part: unknown): boolean {
  if (typeof part !== "object" || part === null) return false;
  // READING A PROPERTY CAN THROW, AND "NEVER THROWS" HAS TO SURVIVE THAT TO BE A PROMISE. A getter
  // or a Proxy trap runs arbitrary code on a plain `.kind`, and this predicate is called on every
  // part of every message a surface renders, so one hostile object would take the surface down over
  // somebody else's mail.
  //
  // STATED HONESTLY: no wire input can be such an object. Parts arrive through `JSON.parse`, which
  // produces plain data with no accessors, so this is not a live attack being defended. It is a
  // signature taking `unknown` being made to mean it, because a function that accepts `unknown` and
  // throws on some of it is a trap for the next caller, and the contract this file implements says
  // "never throws" in those words.
  //
  // Returning `false` here is not a silent degrade, which is the thing this project refuses: `false`
  // is the correct routing answer for an object whose kind cannot be read, and the loud half of the
  // pair is `parseAguiFrame`, which refuses by name. Routing quietly and validating loudly is the
  // whole reason these are two functions.
  try {
    return (part as { kind?: unknown }).kind === AGUI_FRAME_KIND;
  } catch {
    return false;
  }
}
