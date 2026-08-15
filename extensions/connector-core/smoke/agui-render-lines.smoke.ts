/**
 * `agui-render.ts` — the LINE-START invariant, and the fidelity control that keeps it honest.
 *
 * **The defect this suite exists for was measured, not imagined.** The renderer pushed a tool result
 * as ONE string containing embedded newlines, so only its first line carried `  ↳ ` and every line
 * after it began at column 0. Driven through the web surface's markdown pipeline, a result line
 * beginning `- ` opened a list that CAPTURED the frame's own `◂ run … finished` terminator into a
 * list item the payload had created. Payload restructured scaffolding.
 *
 * **WHAT THIS SUITE ASSERTS IS LOCAL, AND THAT IS DELIBERATE.** It asserts a property of the lines
 * this renderer emits — that none of them can open a block construct — and says nothing about what
 * any consumer does downstream. The markdown evidence above cannot be a cell here: it needs the
 * vendored `marked` build under `implementations/web/dist/`, which is **gitignored**, so a cell
 * depending on it would be a cell that cannot run on a fresh checkout. A cross-surface claim with no
 * runnable cell behind it is the "comment asserting something outside its own function" shape, so
 * the consequence is recorded as evidence and the INVARIANT is what gets tested.
 *
 * **THE FIDELITY CELLS ARE THE CONTROL AND THEY ARE NOT DECORATION.** Prefixing every line with `X`
 * would satisfy the invariant perfectly and destroy the renderer; so would dropping the payload
 * entirely. An invariant cell with no fidelity cell beside it rewards deleting the content. Both
 * halves must pass or neither means anything.
 *
 * **AND THE CORPUS IS CHECKED FOR NON-VACUITY.** If the hostile payload contained no line the
 * predicate rejects, every §2 cell would pass over an input that could not have failed — the
 * "matcher that cannot fire" shape. §4 names how many hostile starts the corpus must contain.
 *
 * Run: npx tsx extensions/connector-core/smoke/agui-render-lines.smoke.ts
 */
import { LINE_START_SAFE, aguiFramePartRenderer } from "../src/agui-render.js";
import {
  aguiFrame, runStarted, runFinished, runError,
  textMessageStart, textMessageContent, textMessageEnd,
  reasoningMessageStart, reasoningMessageContent, reasoningMessageEnd,
  toolCallStart, toolCallArgs, toolCallEnd, toolCallResult,
} from "../src/agui.js";
import type { Part } from "@cotal-ai/core";

let pass = 0;
let fail = 0;
const c = (n: string, v: boolean, extra?: unknown): void => {
  if (v) {
    pass += 1;
    return;
  }
  fail += 1;
  console.error(`  x FAIL: ${n}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
};

const TS = 1;
const ENV = { threadId: "t1", runId: "r1", epoch: "e1", seq: 1 } as const;
const draw = (events: readonly unknown[]): string[] =>
  aguiFramePartRenderer.render(aguiFrame({ ...ENV, events: events as never }) as unknown as Part).split("\n");

/** Every block-level opener markdown recognises. Not chosen for variety — this IS the population. */
const HOSTILE_LINES = [
  "# heading opener",
  "- bullet opener",
  "* star bullet",
  "+ plus bullet",
  "> blockquote opener",
  "| table | row |",
  "1. ordered opener",
  "1) paren ordered",
  "    four-space code block",
];
const HOSTILE = [...HOSTILE_LINES, "plain trailing line"].join("\n");

// ── 1. THE PREDICATE ITSELF — it must be able to REFUSE, and it must be able to ACCEPT ───────────
// A predicate that never fires makes every cell below vacuous; one that never accepts makes the
// renderer untestable. Both directions are controlled, and each hostile form is named rather than
// counted, so a cell that stops covering one is visible as itself.
c("[predicate] rejects an ATX heading", !LINE_START_SAFE("# h"));
c("[predicate] rejects a dash bullet", !LINE_START_SAFE("- b"));
c("[predicate] rejects a star bullet", !LINE_START_SAFE("* b"));
c("[predicate] rejects a plus bullet", !LINE_START_SAFE("+ b"));
c("[predicate] rejects a blockquote", !LINE_START_SAFE("> q"));
c("[predicate] rejects a table row", !LINE_START_SAFE("| a |"));
c("[predicate] rejects a dotted ordered item", !LINE_START_SAFE("1. x"));
c("[predicate] rejects a parenthesised ordered item", !LINE_START_SAFE("1) x"));
c("[predicate] rejects a four-space indented code block", !LINE_START_SAFE("    code"));
// Three leading spaces still opens a heading — this is exactly why the prefixes are capped at three.
c("[predicate] rejects a heading indented by three spaces", !LINE_START_SAFE("   # h"));
c("[predicate] accepts the text prefix", LINE_START_SAFE("» hello"));
c("[predicate] accepts the continuation prefix", LINE_START_SAFE("  · payload"));
c("[predicate] accepts the tool-result prefix", LINE_START_SAFE("  ↳ payload"));
c("[predicate] accepts an ordinary word", LINE_START_SAFE("plain line"));

// ── 2. THE INVARIANT, over every event family whose payload can be multi-line ────────────────────
const violations = (ls: string[]): string[] => ls.filter((l) => !LINE_START_SAFE(l));
const noneUnsafe = (label: string, ls: string[]): void =>
  c(`[invariant] every emitted line is line-start safe — ${label}`, violations(ls).length === 0, violations(ls));

const resultLines = draw([
  runStarted({ threadId: "t1", runId: "r1", timestamp: TS }),
  toolCallResult({ messageId: "m2", toolCallId: "tc1", content: HOSTILE, timestamp: TS }),
  runFinished({ threadId: "t1", runId: "r1", timestamp: TS, outcome: { type: "success" } }),
]);
noneUnsafe("tool result", resultLines);

const textLines = draw([
  textMessageStart({ messageId: "m1", role: "assistant", timestamp: TS }),
  textMessageContent({ messageId: "m1", delta: `first\n${HOSTILE}`, timestamp: TS }),
  textMessageEnd({ messageId: "m1", timestamp: TS }),
]);
noneUnsafe("text message", textLines);

noneUnsafe("reasoning message", draw([
  reasoningMessageStart({ messageId: "m3", timestamp: TS }),
  reasoningMessageContent({ messageId: "m3", delta: `thought\n${HOSTILE}`, timestamp: TS }),
  reasoningMessageEnd({ messageId: "m3", timestamp: TS }),
]));

const argLines = draw([
  toolCallStart({ toolCallId: "tc1", toolCallName: "bash", timestamp: TS }),
  toolCallArgs({ toolCallId: "tc1", delta: `{\n${HOSTILE}\n}`, timestamp: TS }),
  toolCallEnd({ toolCallId: "tc1", timestamp: TS }),
]);
noneUnsafe("tool call args", argLines);

noneUnsafe("run error message", draw([
  runError({ threadId: "t1", runId: "r1", timestamp: TS, message: `boom\n${HOSTILE}`, code: "E1" }),
]));

// An unterminated stream takes the tail-flush path, which is a SEPARATE emit site — a fix applied
// only to the END branch would leave this one at column 0 and no cell above would notice.
noneUnsafe("unterminated text (tail flush)", draw([
  textMessageStart({ messageId: "m1", role: "assistant", timestamp: TS }),
  textMessageContent({ messageId: "m1", delta: `first\n${HOSTILE}`, timestamp: TS }),
]));
noneUnsafe("unterminated tool args (tail flush)", draw([
  toolCallStart({ toolCallId: "tc1", toolCallName: "bash", timestamp: TS }),
  toolCallArgs({ toolCallId: "tc1", delta: `{\n${HOSTILE}\n}`, timestamp: TS }),
]));

// ── 3. FIDELITY — the control on §2. Prefixing with `X` would pass every cell above ──────────────
const endsWithAll = (ls: string[], payload: string[]): string[] =>
  payload.filter((p) => !ls.some((l) => l.endsWith(p)));

c("[fidelity] every hostile tool-result line survives, verbatim, as a line suffix",
  endsWithAll(resultLines, HOSTILE_LINES).length === 0, endsWithAll(resultLines, HOSTILE_LINES));
c("[fidelity] every hostile text-message line survives, verbatim, as a line suffix",
  endsWithAll(textLines, HOSTILE_LINES).length === 0, endsWithAll(textLines, HOSTILE_LINES));
c("[fidelity] every hostile tool-args line survives, verbatim, as a line suffix",
  endsWithAll(argLines, HOSTILE_LINES).length === 0, endsWithAll(argLines, HOSTILE_LINES));
// Nothing added and nothing dropped: run-started + one line per payload line + run-finished.
c("[fidelity] the tool-result frame emits exactly one line per payload line, plus its two run lines",
  resultLines.length === HOSTILE.split("\n").length + 2,
  { got: resultLines.length, want: HOSTILE.split("\n").length + 2 });

// ── 4. NON-VACUITY — could §2 have failed at all? ────────────────────────────────────────────────
// If the corpus held no line the predicate rejects, every invariant cell would pass over an input
// incapable of breaking it. The number is NAMED, so shrinking the corpus reddens this cell.
c("[non-vacuity] the hostile corpus contains exactly 9 lines the predicate rejects",
  HOSTILE_LINES.filter((l) => !LINE_START_SAFE(l)).length === 9,
  HOSTILE_LINES.filter((l) => !LINE_START_SAFE(l)).length);

console.log(`\n  ${fail === 0 ? "ok" : "NOT ok"} — passed ${pass}, failed ${fail}`);
process.exit(fail === 0 ? 0 : 1);
