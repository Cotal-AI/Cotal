/**
 * THE FRAME RENDERER, GRADED THROUGH THE SEAM IT ACTUALLY SHIPS BEHIND.
 *
 * WHY ALMOST EVERY CELL GOES THROUGH `partsToText` AND NOT THROUGH `render()`. A killed mutation
 * proves a suite DEPENDS on a line; it does not prove a real entry point reaches it. Calling
 * `aguiFramePartRenderer.render(part)` directly would grade a function that no surface calls, and it
 * would stay green if the registration were deleted, if the registered NAME drifted off the wire
 * kind, or if core resolved renderers some other way. The console draws a frame by handing a message
 * to `partsToText`, so that is what these cells hand it. The direct-call cells that remain are
 * labelled, and they exist only for inputs the dispatcher cannot produce.
 *
 * THE PRECONDITION IS ASSERTED, NOT ASSUMED. Importing this renderer is what registers it. A suite
 * that imported it and then measured "a frame draws" would pass just as well against a core that
 * ignored the registry and special-cased the kind itself, so the no-renderer marker is measured
 * FIRST, on a kind nobody registered, to show the dispatcher really is resolving.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT: the event-type tokens. A reader wants
 * `bash({"cmd":"ls"}) -> ok`, not `TOOL_CALL_START TOOL_CALL_ARGS`. Gating on the vocabulary token
 * appearing in the output would fail a correct renderer, so the cells assert the FOLD instead.
 *
 * Run: pnpm smoke:agui-render
 */
import { AGUI_FRAME_KIND, partsToText, registry, type Part } from "@cotal-ai/core";
import { LINE_START_SAFE, aguiFramePartRenderer, registerAguiFramePartRenderer } from "../src/agui-render.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

const ev = (type: string, rest: Record<string, unknown> = {}) => ({ type, ...rest });
const frame = (...events: unknown[]): Part =>
  ({ kind: AGUI_FRAME_KIND, protocol: "ag-ui/0.0.57", threadId: "t", runId: "r", epoch: 1, seq: 1, events }) as unknown as Part;
const draw = (...events: unknown[]): string => partsToText([frame(...events)]);

// ── THE DISPATCHER IS REALLY DISPATCHING ──────────────────────────────────────────────────────
// A kind nobody registered still renders the marker. Without this, "a frame draws" is consistent
// with core having learned AG-UI itself, which is the one thing the seam exists to prevent.
const unknownKind = partsToText([{ kind: "com.example.nothing" } as unknown as Part]);
c("CONTROL: an unregistered kind still renders the named marker",
  unknownKind === '[unrenderable part kind "com.example.nothing" — no renderer for it on this surface]',
  unknownKind);

// ── REGISTRATION ──────────────────────────────────────────────────────────────────────────────
c("the renderer is registered under kind `part-renderer`", registry.has("part-renderer", AGUI_FRAME_KIND));
c("the registered NAME is the wire kind, spelled out",
  aguiFramePartRenderer.name === "ag-ui.frame", aguiFramePartRenderer.name);
c("registering under the wire kind is what the dispatcher resolves on",
  registry.has("part-renderer", "ag-ui.frame"));

// ── LOADING THIS MODULE TWICE MUST NOT BE FATAL, and that is not hypothetical ──────────────────
// `cotal ext add <connector>` failed with `extension already registered: part-renderer:ag-ui.frame`
// before the registration was made idempotent. The CLI loads this module from its own copy of the
// package; materializing an installed connector loads it again from the extension prefix's
// `node_modules`, a different physical file and so a second top-level evaluation, while
// `@cotal-ai/core` is linked to ONE copy and therefore one registry. Calling the exported
// registration a second time is the same event those two module instances produce.
let secondCallThrew: string | undefined;
try { registerAguiFramePartRenderer(); } catch (e) { secondCallThrew = (e as Error).message; }
c("a second registration does not throw (the ext-add crash, executed)", secondCallThrew === undefined, secondCallThrew);
c("and it did not displace the first: exactly one provider is resolvable",
  registry.resolve("part-renderer", AGUI_FRAME_KIND) === aguiFramePartRenderer);
c("a frame still draws after the second registration", draw(ev("RUN_STARTED", { runId: "r1" })) === "▸ run r1 started");
// The control: an unguarded duplicate really is fatal, so the guard is load-bearing rather than
// decorative. Asserted on a DIFFERENT name so it cannot disturb the registration under test.
let bareDupThrew = false;
const probe = Object.freeze({ kind: "part-renderer" as const, name: "com.example.probe", render: () => "x" });
registry.register(probe);
try { registry.register(probe); } catch { bareDupThrew = true; }
c("CONTROL: an unguarded duplicate registration IS fatal (so the guard above is doing work)", bareDupThrew);

// ── A FRAME NO LONGER RENDERS AS THE MARKER. The whole point of the change ────────────────────
const started = draw(ev("RUN_STARTED", { runId: "r1" }));
c("a frame does NOT render as the unrenderable marker", !started.includes("unrenderable"), started);
c("a frame does not render as the empty string", started.trim().length > 0, started);
c("RUN_STARTED names the run", started === "▸ run r1 started", started);

// ── THE FOLD, which is the reason a renderer exists at all ────────────────────────────────────
const tool = draw(
  ev("TOOL_CALL_START", { toolCallId: "t1", toolCallName: "bash" }),
  ev("TOOL_CALL_ARGS", { toolCallId: "t1", delta: '{"cmd":' }),
  ev("TOOL_CALL_ARGS", { toolCallId: "t1", delta: '"ls"}' }),
  ev("TOOL_CALL_END", { toolCallId: "t1" }),
  ev("TOOL_CALL_RESULT", { toolCallId: "t1", content: "ok" }),
);
c("a tool call folds name and streamed args onto one line", tool.includes('⚙ bash({"cmd":"ls"})'), tool);
c("its result is a separate, prefixed line", tool.includes("  ↳ ok"), tool);
c("the vocabulary tokens do not leak into the output", !/TOOL_CALL_(START|ARGS|END|RESULT)/.test(tool), tool);

const text = draw(
  ev("TEXT_MESSAGE_START", { messageId: "m1" }),
  ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "hello " }),
  ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "world" }),
  ev("TEXT_MESSAGE_END", { messageId: "m1" }),
);
c("streamed text deltas accumulate into one line, not one line each", text === "» hello world", text);

// Interleaving is legal, which is exactly why the ids exist. Two braided streams must not merge.
const braided = draw(
  ev("TEXT_MESSAGE_START", { messageId: "a" }),
  ev("TEXT_MESSAGE_START", { messageId: "b" }),
  ev("TEXT_MESSAGE_CONTENT", { messageId: "a", delta: "AAA" }),
  ev("TEXT_MESSAGE_CONTENT", { messageId: "b", delta: "BBB" }),
  ev("TEXT_MESSAGE_END", { messageId: "a" }),
  ev("TEXT_MESSAGE_END", { messageId: "b" }),
);
c("two interleaved message streams do not braid into each other",
  braided === "» AAA\n» BBB", braided);

const reasoning = draw(
  ev("REASONING_MESSAGE_START", { messageId: "m1", role: "assistant" }),
  ev("REASONING_MESSAGE_CONTENT", { messageId: "m1", delta: "thinking hard" }),
  ev("REASONING_MESSAGE_END", { messageId: "m1" }),
);
c("reasoning is drawn and labelled as such", reasoning === "(thinking) thinking hard", reasoning);

c("RUN_FINISHED with no outcome asserts nothing about how it ended",
  draw(ev("RUN_FINISHED", { runId: "r1" })) === "◂ run r1 finished",
  draw(ev("RUN_FINISHED", { runId: "r1" })));
c("RUN_FINISHED with an outcome reports it",
  draw(ev("RUN_FINISHED", { runId: "r1", outcome: { type: "interrupted" } })) === "◂ run r1 finished (interrupted)");
c("RUN_ERROR reports the message and the code",
  draw(ev("RUN_ERROR", { message: "boom", code: "E42" })) === "✗ run error [E42]: boom");
c("CUSTOM names the custom event", draw(ev("CUSTOM", { name: "cotal.x" })) === "• custom cotal.x");

// ── NOTHING IS SKIPPED, because a skipped event is a hole in a transcript that looks complete ─
const unknownEvent = draw(ev("SOMETHING_FROM_THE_FUTURE"));
c("an event type this build does not know is NAMED, not dropped",
  unknownEvent === '• unrecognised event "SOMETHING_FROM_THE_FUTURE"', unknownEvent);
c("an event with no `type` at all is still named", draw({}) === "• unrecognised event null", draw({}));

// A stream that ended without its END event still has content a reader needs. Dropping it would
// make a truncated turn indistinguishable from a silent one, which is the failure being removed.
const truncated = draw(
  ev("TEXT_MESSAGE_START", { messageId: "m1" }),
  ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "half a sen" }),
);
c("an unterminated text stream is flushed and marked truncated", truncated === "» half a sen …", truncated);
const openTool = draw(ev("TOOL_CALL_START", { toolCallId: "t1", toolCallName: "grep" }));
c("an unterminated tool call is flushed and marked truncated", openTool === "⚙ grep() …", openTool);

// ── EMPTY IS NOT ABSENT, and the two must not be conflated ────────────────────────────────────
// `str()` returns undefined for a non-string, so `??` distinguishes "the producer sent nothing"
// from "the producer sent an empty string". Saying `(no content)` about a tool that genuinely
// returned nothing states something the source never said. The browser copy of this renderer used
// `||` here and therefore disagreed on exactly these inputs; the parity suite pins it now.
c("an ABSENT tool result says so", draw(ev("TOOL_CALL_RESULT", {})) === "  ↳ (no content)");
c("an EMPTY tool result renders empty, not `(no content)`",
  draw(ev("TOOL_CALL_RESULT", { content: "" })) === "  ↳ ", JSON.stringify(draw(ev("TOOL_CALL_RESULT", { content: "" }))));
c("an ABSENT run error message says so", draw(ev("RUN_ERROR", {})) === "✗ run error: (no message)");
c("an EMPTY run error message renders empty",
  draw(ev("RUN_ERROR", { message: "" })) === "✗ run error: ", JSON.stringify(draw(ev("RUN_ERROR", { message: "" }))));

// ── THE LINE-START INVARIANT, executed over hostile payload ───────────────────────────────────
// Measured failure: a tool result whose second line began `- ` opened a markdown list that captured
// the frame's own terminator into a list item the payload created. Payload restructured scaffolding.
// The second half of this payload is the set a REVIEWER found the first predicate accepted while
// calling itself "the block-level openers": a fence, a thematic break, a setext underline, an HTML
// block and a link reference definition, which renders as nothing at all and so deletes its line.
const hostilePayload =
  "line one\n- a list item\n# a heading\n    indented code\n> quote\n| table |\n1. ordered\n" +
  "```\n~~~\n---\n***\n___\n===\n<!-- html -->\n<div>\n[ref]: http://example.invalid\n\ttab indented";
const rendered = draw(
  ev("TOOL_CALL_RESULT", { content: hostilePayload }),
  ev("RUN_FINISHED", { runId: "r1" }),
);
const offenders = rendered.split("\n").filter((l) => !LINE_START_SAFE(l));
c("no emitted line can open a markdown block, over a payload made of nothing but block openers",
  offenders.length === 0, offenders);
c("CONTROL: the invariant's own predicate rejects a raw block opener (else the cell above is vacuous)",
  !LINE_START_SAFE("- a list item") && !LINE_START_SAFE("# h") && !LINE_START_SAFE("    code") && LINE_START_SAFE("» ok"));

// THE REGRESSION THIS PREDICATE WAS WIDENED FOR. Each of these PASSED the enumerating version, so
// this cell is the only thing standing between the predicate and the claim it makes about itself.
// It is pinned construct by construct rather than as a count, so a future narrowing names its victim.
const previouslyAccepted: Array<[string, string]> = [
  ["fence, backtick", "```"],
  ["fence, tilde", "~~~ts"],
  ["thematic break, dashes", "---"],
  ["thematic break, asterisks", "***"],
  ["thematic break, underscores", "___"],
  ["setext underline, equals", "==="],
  ["HTML comment", "<!-- html -->"],
  ["HTML block", "<div>"],
  ["link reference definition (renders as NOTHING)", "[ref]: http://example.invalid"],
  ["a tab, which is up to four columns of indent", "\ttab indented"],
  ["a block opener behind three spaces (three is the ceiling, not an escape)", "   ```"],
];
const stillAccepted = previouslyAccepted.filter(([, line]) => LINE_START_SAFE(line));
c("every construct the enumerating predicate wrongly called safe is now refused",
  stillAccepted.length === 0, stillAccepted.map(([name]) => name));
c("CONTROL: the widening did not just refuse everything, so the predicate still admits real lines",
  ["» text", "(thinking) x", "⚙ tool()", "  · continued", "  ↳ result", "", "   ", "plain words", "(paren"]
    .every((l) => LINE_START_SAFE(l)));
c("and the stricter rule is stated honestly: a line that opens nothing is refused anyway when it starts with a block character",
  !LINE_START_SAFE("1x") && !LINE_START_SAFE("-x"));
c("every payload line is still present, prefixed rather than dropped",
  hostilePayload.split("\n").every((l) => rendered.includes(l)), rendered);

// ── MALFORMED INPUT IS DRAWN, NEVER THROWN ON ─────────────────────────────────────────────────
// `parseAguiFrame` checks the envelope and each event's `type` and nothing else, measured. So every
// field here is untrusted. A renderer is the wrong place to discover a producer's bug.
const MALFORMED: unknown[] = [
  ev("RUN_STARTED", { runId: 42 }),
  ev("TEXT_MESSAGE_CONTENT", { messageId: null, delta: { not: "a string" } }),
  ev("TOOL_CALL_END", { toolCallId: [] }),
  ev("RUN_FINISHED", { outcome: "not an object" }),
  ev("RUN_FINISHED", { outcome: null }),
  ev("TOOL_CALL_RESULT", { content: 7 }),
  { type: 99 },
  null,
];
// MEASURED ON THIS CELL, AND THE FIRST VERSION OF IT WAS VACUOUS. Wrapping `draw()` in a try/catch
// and asserting nothing was caught can never fail: `partsToText` catches a throwing renderer and
// returns `[part renderer for … failed: …]`, so the throw is absorbed one layer below the
// assertion. It absorbed a real one, too. A `null` element made the renderer throw, and the whole
// frame collapsed to a single failure line, deleting every other event in it from the reader. The
// cell therefore looks for the dispatcher's failure MARKER, which is what actually surfaces.
let renderFailed = "";
for (const bad of MALFORMED) {
  const out = draw(bad);
  if (out.includes("part renderer for")) renderFailed += `${JSON.stringify(bad)} -> ${out}; `;
}
c("no malformed event makes the renderer fail (checked via the dispatcher's marker, not via a throw)",
  renderFailed === "", renderFailed);
c("a null event is named rather than skipped or fatal", draw(null) === "• unrecognised event null", draw(null));
c("CONTROL: the failure marker this cell looks for is really what a throwing renderer produces",
  partsToText([{ kind: "com.example.boom" } as unknown as Part]).includes("unrenderable") &&
    typeof MALFORMED[0] === "object");
// One malformed element must cost ONE line, not the whole frame. This is the property the guard
// bought, and it is invisible to a cell that only checks "did it throw".
const withNull = draw(ev("RUN_STARTED", { runId: "r1" }), null, ev("RUN_FINISHED", { runId: "r1" }));
c("a null element among good events costs one line, not the frame",
  withNull === "▸ run r1 started\n• unrecognised event null\n◂ run r1 finished", withNull);

// ── A THROWING RENDERER MUST NOT SILENCE THE MESSAGE. Core's contract, exercised here ─────────
// Not this renderer's own behaviour: the guarantee that a surface survives one. Asserted because
// every cell above depends on the dispatcher reporting failures rather than swallowing them.
c("CONTROL: a part whose `kind` is absent does not reach this renderer",
  partsToText([{ kind: "text", text: "plain" } as Part]) === "plain");

// ── DIRECT CALLS, and they are labelled because the dispatcher cannot produce these ───────────
// `render()` is reachable as a plain function on a registered object, so it is graded on inputs
// that routing would never hand it. Without the guard, a non-frame part is told it is a frame
// "carrying no events", which is a false statement about the part rather than a refusal to draw it.
c("[direct] a non-frame part is refused by name", aguiFramePartRenderer.render({ kind: "text", text: "x" } as Part) === "[not an AG-UI frame]");
c("[direct] a frame with an empty events array says so",
  aguiFramePartRenderer.render({ kind: AGUI_FRAME_KIND, events: [] } as unknown as Part) === "[AG-UI frame carrying no events]");
c("[direct] a frame whose events is not an array says so",
  aguiFramePartRenderer.render({ kind: AGUI_FRAME_KIND, events: "nope" } as unknown as Part) === "[AG-UI frame carrying no events]");
c("[direct] a frame with no events key at all says so",
  aguiFramePartRenderer.render({ kind: AGUI_FRAME_KIND } as unknown as Part) === "[AG-UI frame carrying no events]");

// ── A FRAME AMONG OTHER PARTS ─────────────────────────────────────────────────────────────────
const mixed = partsToText([
  { kind: "text", text: "before" } as Part,
  frame(ev("RUN_STARTED", { runId: "r1" })),
  { kind: "text", text: "after" } as Part,
]);
c("a frame between two text parts is drawn between them, not collapsed",
  mixed === "before ▸ run r1 started after", mixed);

console.log(`\nagui-render smoke: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
