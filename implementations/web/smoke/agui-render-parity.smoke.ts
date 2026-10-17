/**
 * AG-UI renderer parity: the browser's frame renderer must agree, BYTE FOR BYTE, with the one every
 * other surface uses.
 *
 * WHY TWO IMPLEMENTATIONS EXIST, since the repo otherwise refuses duplication.
 * `implementations/web/client/src/lib/aguiFrame.ts` is bundled for a browser. The client imports
 * nothing from `@cotal-ai/*` at runtime, so it cannot reach `extensions/connector-core/src/agui-render.ts`.
 * The constraint is the tier rule, not a design preference, and no seam removes it. This is the same
 * situation `launch-parity.smoke.ts` documents for the launch grammar — the tier rule forbids the
 * shared import, so parity is enforced HERE, by test.
 *
 * WHY IT LIVES IN THE WEB PACKAGE. The browser half is client source that only this package's suites
 * can reach by source path, which is what lets a mutation of `aguiFrame.ts` be graded against these
 * cells. The node half is read through connector-core's built `dist`, and the script builds that
 * package first, so the cells never grade a stale build.
 *
 * "We will keep them in sync" was explicitly refused as a plan. Sync by intention is a property
 * nothing recomputes. This suite is the recomputation.
 *
 * WHAT IT DRIVES. The node renderer is the REAL exported `aguiFramePartRenderer` — the object core
 * resolves by kind, not a copy of its logic. The browser renderer is the REAL exported
 * `renderAguiFrame`, imported by source path as the client bundle imports it. Neither side is
 * restated here, so no cell can pass against a version of a function that no longer exists.
 *
 * ── WHAT IT PRINTS ON FAILURE, WHICH IS A DELIBERATE RESTRICTION ─────────────────────────────────
 * An equivalence assertion's natural output is `expected X, got Y`, and the day this corpus is
 * pointed at a real session, X and Y ARE an operator's content. Failure output is also exactly what
 * gets pasted into a channel or a DM. So a mismatch reports DIGEST AND POSITION ONLY — line index,
 * first differing byte offset, lengths, sha256 prefixes — and never the two strings. The corpus
 * below is synthetic and safe today; the reporting discipline is built in now so that pointing this
 * at real input later is not also a decision to start printing it.
 *
 * ── COVERAGE IS MEASURED FROM THE EMITTER, NOT PROMISED IN PROSE ─────────────────────────────────
 * A hand-written "this covers everything" note goes stale the day someone adds an event type. So the
 * corpus's covered types are compared against the emitter's own enumerable `AGUI_EVENT_TYPE`, and
 * the UNCOVERED ones are printed BY NAME, on every run, green included. A new event type lands and
 * appears in that list the same day with nobody remembering anything.
 *
 * ── WHAT THIS DOES NOT CLAIM ─────────────────────────────────────────────────────────────────────
 * It proves the two renderers produce identical text for the same frame. It does NOT open a browser,
 * does not assert rendered HTML, and does not prove the module is bundled. `web`'s own suites own
 * the served routes and the dispatch through `parts.ts`. Parity of the text is not
 * delivery of the pixels, and the two failures look nothing alike.
 *
 * ── THE FOLD, A THIRD READER ─────────────────────────────────────────────────────────────────────
 * `client/src/lib/session.ts` folds the same events into session steps rather than lines. Its output
 * is not text, so it is held to the node renderer by projection: both sides are reduced to one list
 * of facts (said, tool, turn, end, error, unknown, reasoning) and compared, over every corpus entry
 * that is a frame carrying events. What the projection leaves out on purpose is printed on every run.
 *
 * Run: pnpm smoke:agui-render-parity
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AGUI_EVENT_TYPE, AGUI_FRAME_KIND } from "@cotal-ai/core";
// THE NODE HALF COMES FROM THE BUILD, AND THE BUILD IS FRESH. This package does not depend on
// connector-core, so its renderer is reached through the built file rather than the package name.
// `pnpm smoke:agui-render-parity` rebuilds connector-core before it runs this file, so an edit to the
// node renderer's source is always what these cells compare, and a mutation against it is graded
// after the same rebuild. The browser half is imported by source path, as the client bundle imports it.
import { aguiFramePartRenderer, LINE_START_SAFE } from "../../../extensions/connector-core/dist/agui-render.js";
import { renderAguiFrame } from "../client/src/lib/aguiFrame.js";
import { partsToText } from "../client/src/lib/parts.js";
import { foldSession, framesOf, type SessionStep } from "../client/src/lib/session.js";
import type { CotalMessage } from "../client/src/api/types.js";

let cells = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  cells++;
  assert.ok(cond, `${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  console.log(`  ok  ${name}`);
};

// ── The browser renderer, imported the way the client bundle imports it ─────────────────────────
// If the module stopped exporting the renderer, or stopped registering it, this fails HERE with a
// named cell rather than leaving a later cell to fail for a reason that reads like a rendering bug.
ok("aguiFrame.ts exports renderAguiFrame", typeof renderAguiFrame === "function");
const registered = { kind: AGUI_FRAME_KIND, events: [{ type: "RUN_STARTED", runId: "r" }] };
ok("it registers under EXACTLY the emitter's frame kind, not a hand-typed lookalike",
  partsToText([registered]) === renderAguiFrame(registered), { kind: AGUI_FRAME_KIND });

const browser = (part: unknown): string => renderAguiFrame(part as never);
const node = (part: unknown): string => aguiFramePartRenderer.render(part as never);

// ── Failure reporting: digest and position, never content ────────────────────────────────────────
const digest = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
/** Where two renderings first differ, described without quoting either. */
function divergence(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const lineIndex = a.slice(0, i).split("\n").length - 1;
  return {
    firstDifferingOffset: i, lineIndex,
    nodeLen: a.length, browserLen: b.length,
    nodeLines: a.split("\n").length, browserLines: b.split("\n").length,
    nodeDigest: digest(a), browserDigest: digest(b),
  };
}

// ── The corpus ───────────────────────────────────────────────────────────────────────────────────
// Every case is a SHAPE that has a reason to diverge, not a sample of pretty output. The ids are
// hostile on purpose: they arrive off the wire, so "nobody would send that" is not a property of the
// input, it is a hope about the sender.
const frame = (...events: unknown[]) => ({ kind: AGUI_FRAME_KIND, protocol: "ag-ui/1", threadId: "t", runId: "r", events });
const T = AGUI_EVENT_TYPE;

const CORPUS: { name: string; part: unknown }[] = [
  { name: "a complete ordinary turn", part: frame(
    { type: T.RUN_STARTED, runId: "r1" },
    { type: T.TEXT_MESSAGE_START, messageId: "m1" },
    { type: T.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "hello " },
    { type: T.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "world" },
    { type: T.TEXT_MESSAGE_END, messageId: "m1" },
    { type: T.RUN_FINISHED, runId: "r1", outcome: { type: "success" } }) },

  { name: "a run that finished with no outcome (the optional field)", part: frame(
    { type: T.RUN_STARTED, runId: "r2" }, { type: T.RUN_FINISHED, runId: "r2" }) },

  { name: "a run error with and without a code", part: frame(
    { type: T.RUN_ERROR, code: "E_BOOM", message: "it broke" },
    { type: T.RUN_ERROR, message: "no code" },
    { type: T.RUN_ERROR }) },

  { name: "reasoning, which uses a different continuation prefix from text", part: frame(
    { type: T.REASONING_MESSAGE_START, messageId: "n1" },
    { type: T.REASONING_MESSAGE_CONTENT, messageId: "n1", delta: "step one\nstep two" },
    { type: T.REASONING_MESSAGE_END, messageId: "n1" }) },

  { name: "a tool call with streamed args and a multi-line result", part: frame(
    { type: T.TOOL_CALL_START, toolCallId: "c1", toolCallName: "grep" },
    { type: T.TOOL_CALL_ARGS, toolCallId: "c1", delta: '{"q":' },
    { type: T.TOOL_CALL_ARGS, toolCallId: "c1", delta: '"x"}' },
    { type: T.TOOL_CALL_END, toolCallId: "c1" },
    { type: T.TOOL_CALL_RESULT, toolCallId: "c1", content: "- one\n- two\n# three" }) },

  { name: "a tool result with no content", part: frame({ type: T.TOOL_CALL_RESULT, toolCallId: "c9" }) },

  { name: "CUSTOM, named and unnamed", part: frame(
    { type: T.CUSTOM, name: "checkpoint" }, { type: T.CUSTOM }) },

  // INTERLEAVING. The ids exist because it is legal; a renderer that used one accumulator would
  // braid these two messages into one and both surfaces would have to braid them identically to
  // pass, which is the wrong kind of agreement.
  { name: "two text streams interleaved (the reason ids exist)", part: frame(
    { type: T.TEXT_MESSAGE_START, messageId: "a" },
    { type: T.TEXT_MESSAGE_START, messageId: "b" },
    { type: T.TEXT_MESSAGE_CONTENT, messageId: "a", delta: "AAA" },
    { type: T.TEXT_MESSAGE_CONTENT, messageId: "b", delta: "BBB" },
    { type: T.TEXT_MESSAGE_END, messageId: "b" },
    { type: T.TEXT_MESSAGE_END, messageId: "a" }) },

  // THE MAP-VERSUS-OBJECT DIVERGENCE, both halves. With plain-object accumulators the browser would
  // flush these in ascending NUMERIC order while the node Maps flush in INSERTION order. This cell
  // is the reason `aguiFrame.ts` uses Map, and it fails the moment someone "simplifies" it back.
  { name: "unterminated streams with INTEGER-LIKE ids (object keys would reorder them)", part: frame(
    { type: T.TEXT_MESSAGE_START, messageId: "10" },
    { type: T.TEXT_MESSAGE_CONTENT, messageId: "10", delta: "ten" },
    { type: T.TEXT_MESSAGE_START, messageId: "2" },
    { type: T.TEXT_MESSAGE_CONTENT, messageId: "2", delta: "two" }) },

  // `__proto__` never becomes an own property of a plain object, so that stream would VANISH on one
  // surface — a silent drop, which is the exact failure class this whole lane exists to remove.
  { name: "an id of __proto__ (a plain object would drop the stream entirely)", part: frame(
    { type: T.TEXT_MESSAGE_START, messageId: "__proto__" },
    { type: T.TEXT_MESSAGE_CONTENT, messageId: "__proto__", delta: "payload" },
    { type: T.TEXT_MESSAGE_CONTENT, messageId: "constructor", delta: "other" }) },

  { name: "an unterminated tool call (tail flush, the third path)", part: frame(
    { type: T.TOOL_CALL_START, toolCallId: "c2", toolCallName: "sleep" },
    { type: T.TOOL_CALL_ARGS, toolCallId: "c2", delta: "{}" }) },

  { name: "a started-but-empty message flushes nothing", part: frame(
    { type: T.TEXT_MESSAGE_START, messageId: "empty" }) },

  { name: "content with no START (a delta that arrives first)", part: frame(
    { type: T.TEXT_MESSAGE_CONTENT, messageId: "orphan", delta: "no start" },
    { type: T.TEXT_MESSAGE_END, messageId: "orphan" }) },

  { name: "an END for a message that never existed", part: frame(
    { type: T.TEXT_MESSAGE_END, messageId: "ghost" }) },

  { name: "missing ids entirely (both sides must pick the same empty-string key)", part: frame(
    { type: T.TEXT_MESSAGE_START },
    { type: T.TEXT_MESSAGE_CONTENT, delta: "keyless" },
    { type: T.TEXT_MESSAGE_END }) },

  { name: "non-string fields, which the wire does not forbid", part: frame(
    { type: T.RUN_STARTED, runId: 7 },
    { type: T.TEXT_MESSAGE_CONTENT, messageId: 7, delta: 42 },
    { type: T.TOOL_CALL_START, toolCallId: null, toolCallName: { a: 1 } },
    { type: T.TOOL_CALL_END, toolCallId: null }) },

  { name: "an event type this build does not know (named, never skipped)", part: frame(
    { type: "STATE_SNAPSHOT" }, { type: 5 }, { type: null }, {}) },

  // THE EMPTY-STRING FAMILY, and it is here because the two sides really did disagree on it. The
  // browser copy used `||` where the node renderer used `??`, so a field carrying "" took the
  // ABSENT branch on one surface and the EMPTY branch on the other: an empty tool result printed
  // `(no content)` in the dashboard and nothing in the console, for the same frame. `str()` returns
  // undefined for a non-string precisely so the two can be told apart, and every fallback on both
  // sides now keys on undefined. Each field with a non-empty default is covered, because the
  // divergence was per-field and fixing one said nothing about the rest.
  { name: "empty strings where the default is non-empty (`??` versus `||`)", part: frame(
    { type: T.RUN_STARTED, runId: "" },
    { type: T.RUN_ERROR, message: "", code: "" },
    { type: T.TOOL_CALL_START, toolCallId: "c8", toolCallName: "" },
    { type: T.TOOL_CALL_END, toolCallId: "c8" },
    { type: T.TOOL_CALL_RESULT, toolCallId: "c8", content: "" },
    { type: T.CUSTOM, name: "" },
    { type: T.RUN_FINISHED, runId: "", outcome: { type: "" } }) },

  // A NULL ELEMENT. `events` is an array off the wire and nothing upstream checks that its members
  // are objects, so `null` arrives. Unguarded, `e.type` throws, and because each surface catches a
  // throwing renderer into its own marker the whole frame collapsed to one failure line: every
  // other event in it deleted from the reader's view, differently worded on each surface.
  { name: "a null element among good events (unguarded, this threw and ate the frame)", part: frame(
    { type: T.RUN_STARTED, runId: "r9" }, null, undefined, 42, "str",
    { type: T.RUN_FINISHED, runId: "r9" }) },

  { name: "a frame with no events", part: frame() },
  { name: "a frame whose events field is not an array", part: { kind: AGUI_FRAME_KIND, events: "nope" } },
  { name: "a part that is not a frame at all", part: { kind: "text", text: "x" } },
];

ok("the corpus is non-empty and every entry is named (a silent short table checks fewer)",
  CORPUS.length >= 20 && CORPUS.every((c) => c.name.length > 0), { n: CORPUS.length });

// ── THE PARITY ASSERTION ─────────────────────────────────────────────────────────────────────────
for (const { name, part } of CORPUS) {
  const a = node(part);
  const b = browser(part);
  ok(`parity: ${name}`, a === b, a === b ? undefined : divergence(a, b));
}

// ── POSITIVE CONTROL on the comparison itself ────────────────────────────────────────────────────
// Every cell above is an equality, and equality passes trivially if both sides return the same
// constant — an empty string, a marker, a thrown-and-caught "". So: the corpus must actually produce
// DISTINCT, non-trivial renderings, or parity is agreement about nothing.
const renderings = CORPUS.map(({ part }) => node(part));
const distinct = new Set(renderings).size;
ok("CONTROL: the corpus produces mostly DISTINCT renderings (equality of two constants is not parity)",
  distinct >= CORPUS.length - 2, { distinct, corpus: CORPUS.length });
ok("CONTROL: most renderings are multi-line and substantial (not every case degrading to a marker)",
  renderings.filter((r) => r.includes("\n")).length >= 8,
  { multiline: renderings.filter((r) => r.includes("\n")).length });

// ── NEGATIVE CONTROL on the detector ─────────────────────────────────────────────────────────────
// If `divergence` cannot see a difference, every parity cell above is a green light wired to
// nothing. Feed it a known-unequal pair and require it to report the right position.
const d = divergence("» abc", "» abd");
ok("CONTROL: the divergence detector finds a real difference at the right offset",
  d.firstDifferingOffset === 4 && d.nodeDigest !== d.browserDigest, d);
ok("CONTROL: the divergence report carries NO content from either string",
  !JSON.stringify(d).includes("abc") && !JSON.stringify(d).includes("abd"), Object.keys(d));

// ── THE FOLD AGAINST THE NODE RENDERER, BY PROJECTION ────────────────────────────────────────────
// `foldSession` draws steps, not lines, so both sides are projected to one fact list, written once
// here. A tool fact is the name up to its first "(", from the name's first line, on both sides: the
// renderer prints `name(args)` and continues a multi-line name under `  · `, so that is all of the
// name its first line holds.
const toolFact = (nameAndRest: string) => `tool ${nameAndRest.split("\n")[0].split("(")[0]}`;

/** The node renderer's output as facts. A render that is one bracketed line is a whole-part marker
 *  (it drew nothing for the frame's events) and projects to no facts. */
function factsFromLines(rendered: string): string[] {
  const lines = rendered.split("\n");
  if (lines.length === 1 && lines[0].startsWith("[")) return [];
  const facts: string[] = [];
  for (const l of lines) {
    if (l.startsWith("» ")) facts.push(`said ${l.slice(2)}`);
    else if (l.startsWith("⚙ ")) facts.push(toolFact(l.slice(2)));
    else if (l.startsWith("◂ ")) facts.push("end");
    else if (l.startsWith("✗ ")) facts.push("error");
    else if (l.startsWith("▸ ")) facts.push("turn");
    else if (l.startsWith("• unrecognised event") || l.startsWith("• custom")) facts.push("unknown");
    else if (l.startsWith("(thinking) ")) facts.push("reasoning");
    // A result line is the deliberate difference; a `  · ` line continues the fact before it.
    else if (l.startsWith("  ↳ ") || l.startsWith("  · ")) continue;
    // A prefix the projection does not know fails the comparison rather than vanishing from it.
    else facts.push("unprojected");
  }
  return facts;
}

/** The fold's steps as facts. Prompt and said are both `» ` text to the renderer, a line per fact,
 *  and a cut stream carries the renderer's trailing " …". */
function factsFromSteps(steps: SessionStep[]): string[] {
  const facts: string[] = [];
  for (const s of steps) {
    switch (s.kind) {
      case "prompt":
      case "said":
        for (const l of (s.text + (s.cut ? " …" : "")).split("\n")) facts.push(`said ${l}`);
        break;
      case "tools":
        for (const c of s.calls) facts.push(toolFact(c.full));
        break;
      case "turn": facts.push("turn"); break;
      case "turnEnd": facts.push("end"); break;
      case "runError": facts.push("error"); break;
      case "unknown": facts.push("unknown"); break;
      case "reasoning": facts.push("reasoning"); break;
      case "post": facts.push("post"); break;
    }
  }
  return facts;
}

/** A corpus part as the one message that carries it, folded with no posts. */
const fold = (part: unknown, i: number): SessionStep[] =>
  foldSession(framesOf({ id: `p${i}`, ts: 0, space: "s", from: { id: "x", name: "x" }, parts: [part], channel: "events.local.x" } as unknown as CotalMessage, false), []);

const carriesEvents = (part: unknown) => {
  const p = part as { kind?: unknown; events?: unknown };
  return p.kind === AGUI_FRAME_KIND && Array.isArray(p.events) && p.events.length > 0;
};
const folded = CORPUS.map((c, i) => ({ ...c, i })).filter((c) => carriesEvents(c.part));
const foldMismatches = folded.flatMap(({ name, part, i }) => {
  const a = factsFromLines(node(part));
  const b = factsFromSteps(fold(part, i));
  if (a.length === b.length && a.every((f, k) => f === b[k])) return [];
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  // Digest and position only, as every other cell here reports.
  return [{ corpusIndex: i, corpusName: name, firstDifferingFact: k, nodeFacts: a.length, foldFacts: b.length,
    nodeDigest: digest(a.join("\n")), foldDigest: digest(b.join("\n")) }];
});
ok("fold parity: foldSession's steps project to the node renderer's facts on every frame in the corpus that carries events",
  foldMismatches.length === 0, foldMismatches);

const foldFacts = folded.flatMap(({ part, i }) => factsFromSteps(fold(part, i)));
const kinds = ["said", "tool", "turn", "end", "error", "unknown", "reasoning"];
ok("CONTROL: the fold cell compared most of the corpus, and every fact kind, cut text included",
  folded.length >= CORPUS.length - 3 && kinds.every((k) => foldFacts.some((f) => f === k || f.startsWith(`${k} `))) &&
    foldFacts.some((f) => f.startsWith("said ") && f.endsWith(" …")),
  { folded: folded.length, corpus: CORPUS.length });
ok("CONTROL: the projection sees a dropped trailing ellipsis",
  factsFromSteps([{ kind: "said", key: "k", text: "x", cut: true, live: false }]).join() !==
    factsFromSteps([{ kind: "said", key: "k", text: "x", cut: false, live: false }]).join());

// ── The line-start invariant, on the BROWSER's output ─────────────────────────────────────────────
// The predicate is IMPORTED from the node renderer rather than restated, so both surfaces are held
// to one definition of "safe" and a change to it cannot pass here while failing there. This matters
// on the browser specifically: message bodies are meant for the client's markdown renderer
// (`lib/md.ts`, over marked), so a payload line starting `- ` or `# ` would open a markdown block
// and payload would restructure the frame's own scaffolding.
let checkedLines = 0;
for (const { name, part } of CORPUS) {
  const out = browser(part);
  if (!out.includes("\n") && out.startsWith("[")) continue; // a marker, not rendered lines
  for (const line of out.split("\n")) {
    checkedLines++;
    ok(`line-start safe: ${name} @ line ${checkedLines}`, LINE_START_SAFE(line),
      { lineIndex: checkedLines, len: line.length, digest: digest(line) });
  }
}
ok("the line-start invariant was checked over a substantial number of real lines (non-vacuity)",
  checkedLines >= 30, { checkedLines });

// ── COVERAGE, measured from the emitter and printed every run ────────────────────────────────────
const covered = new Set<string>();
for (const { part } of CORPUS) {
  const events = (part as { events?: unknown }).events;
  // Guarded for the same reason both renderers are: the corpus deliberately contains a `null`
  // element, and this accounting loop crashed on it the first time it ran. A suite that walks the
  // hostile input it wrote has to be at least as careful as the code it grades.
  if (Array.isArray(events)) for (const e of events) {
    if (typeof e !== "object" || e === null) continue;
    const t = (e as { type?: unknown }).type;
    if (typeof t === "string") covered.add(t);
  }
}
const all = Object.values(AGUI_EVENT_TYPE) as string[];
const uncovered = all.filter((t) => !covered.has(t));

console.log("\n── coverage, measured against the emitter's own AGUI_EVENT_TYPE ──");
console.log(`  event types defined by the emitter : ${all.length}`);
console.log(`  exercised by this corpus           : ${all.filter((t) => covered.has(t)).length}`);
console.log(`  UNCOVERED                          : ${uncovered.length === 0 ? "(none)" : uncovered.join(", ")}`);

ok("every event type the emitter defines is exercised by the parity corpus",
  uncovered.length === 0, { uncovered });

// ── The disclosure, PRINTED ON EVERY RUN, green included ─────────────────────────────────────────
// A limit that prints only while red vanishes at exactly the moment it matters: the reader who needs
// to know what this does not cover is the one glancing at a green summary, and that reader never
// opens the file.
console.log(`
── what the fold cell leaves out, deliberately ─────────────────────────────────
  · Tool results (\`  ↳ \` lines) and tool arguments, on both sides. The event
    plane drops them, so the fold draws neither; if one arrives it is not drawn.
  · Where a call lands. The fold places a call where it starts and draws it once;
    the renderer prints it where it ends, prints an END with no START as "?()",
    and adds " …" to a call with no END. No corpus frame has another event
    between a call's start and its end.
  · Which text is a prompt. Both are \`» \` lines to the renderer.
  · Labels. A turn, an end, an error, an unknown marker and reasoning compare as
    the fact alone: the fold carries no run id, outcome, error message or code.
  · The three entries that are not a frame carrying events. The renderer answers
    each with one whole-part marker; the fold names each as an unknown step.

── what this suite does NOT establish ──────────────────────────────────────────
  · It compares TEXT. It does not open a browser, does not assert rendered DOM,
    and does not prove aguiFrame.ts is bundled or loaded. The web package's own
    suites own the served routes and dispatch through parts.ts.
  · The corpus is SYNTHETIC. It covers every event type the emitter enumerates
    (measured above, not promised here), but it cannot cover a SHAPE nobody
    thought of — an ordering, a field combination, a payload no cell describes.
    Type coverage is not shape coverage and this line is not a claim that it is.
  · Parity is agreement between two implementations, NOT correctness of either.
    Both could be wrong in the same way and every cell above would stay green.
────────────────────────────────────────────────────────────────────────────────`);

console.log(`\n${cells} cells green`);
