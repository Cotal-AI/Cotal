/**
 * The AG-UI vocabulary conforms to the REAL protocol, not to our reading of it.
 *
 * This suite is the reason `@ag-ui/core` is a dependency at all. Production code carries `import
 * type` and hand-written string literals, so nothing in `src/agui.ts` can fail at build time if our
 * idea of the protocol drifts from the protocol. Here — and only here — the actual zod schemas are
 * imported and every constructor's output is parsed by the schema that owns it.
 *
 * **Why literals in src and schemas here.** `@ag-ui/core@0.0.57` declares `zod: ^3.22.4` as a
 * RUNTIME dependency, and `connector-core` is esbuild-bundled into every seeded connector — so
 * importing schemas from production code would ship a second zod major to every customer to
 * validate events we build ourselves. The cost of that trade is exactly this file: the literals are
 * unchecked by the compiler, so they are checked by execution instead.
 *
 * FOUR ASSERTIONS ARE REQUIRED BY THE BUILD ORDER and each is here under its own heading: validate
 * against the real schemas, assert `.passthrough()`, assert BRACKETING over a synthesized
 * multi-turn sequence, and assert two principals through one channel stay separate.
 *
 * ⚠️ READ THIS BEFORE TRUSTING THE FOURTH. **The separation asserted here is at the ENVELOPE layer
 * only, and it is NOT channel isolation.** That scope has not changed, but its REASON has: this was
 * written when `eventChannel` still keyed on the display name, so a cell asserting two principals
 * get two channels would have failed, and one asserting they share a channel would have encoded the
 * defect as correct. The re-key has since landed — the channel is now `events.<owner>.<actor>` —
 * and channel isolation IS proven, at the authorities that enforce it rather than here:
 * `event-channel.smoke.ts` (injective, by exhibiting the left inverse),
 * `transcript-grant-acl.smoke.ts` (the minted credential names the principal, from a real spawn),
 * and `foreground-event-grant.smoke.ts` (a real broker DENIES one principal's credential on
 * another's channel). What this suite asserts is still only the envelope half: frames from two
 * principals are attributable to their own writers by the envelope they carry. Do not read the cell
 * below as covering the channel half — read the three suites named above.
 *
 * ## Mutation ledger — kill sets predicted BEFORE each run, as NAMED cells, and confirmed
 *
 * Counts are deliberately absent. A kill-set header written as a NUMBER goes stale silently every
 * time a cell is added, and this lane inherited three such headers that had drifted from 3 to 22,
 * from 2 to 3, and from 3 to 26. Names do not drift; if a named cell stops existing, the reader
 * knows to re-measure rather than trusting an integer that still looks plausible.
 *
 * | # | Mutation, in `src/agui.ts` | Predicted, and confirmed |
 * | --- | --- | --- |
 * | M10 | drop `role: "reasoning"` from `reasoningMessageStart` | `reasoningMessageStart parses under its real schema` |
 * | M11 | `aguiFrame` accepts an empty `events` array | `a frame with no events is refused …` |
 * | M12 | `RUN_FINISHED` stops refusing dangling opens | `closing a run with a tool call still open is refused` |
 * | M13 | `openId` drops its already-open check | `re-opening a messageId that is already open is refused` AND `a provider id reused across two observations is refused as a re-open` |
 * | M14 | the CUSTOM gate accepts any name | `an undeclared CUSTOM name is refused rather than emitted` |
 * | M15 | delete the three `REASONING_*` cases, so they fall to `default` | `a synthesized 3-turn sequence brackets cleanly` |
 * | M16 | route all three `REASONING_*` cases to `this.text` | `the three id sets do not collide` AND `mid-split, the reasoning id opened in the FIRST frame is still outstanding` |
 * | M17 | delete the `TOOL_CALL_RESULT` while-still-open guard | `a TOOL_CALL_RESULT arriving while its call is still open is refused` |
 *
 * All eight landed in SOURCE (this suite imports `../src/agui.js`, so a mutation cannot miss the
 * code that runs), all eight killed exactly their predicted set and nothing else, and the restore
 * was verified by a clean `git status` plus a return to the baseline tally.
 *
 * **M15 and M17 are why M16 is phrased the way it is.** Before M15's cells existed, deleting the
 * reasoning cases outright left this suite fully GREEN — the id space was claimed in the header and
 * never entered by a fixture. M17 was the same shape one level down: the `TOOL_CALL_RESULT` guard is
 * the only branch asserting an id is NOT open, and every happy path sends the result after
 * `TOOL_CALL_END`, so deleting it also went unnoticed. M16 is the discriminating mutation the first
 * two do not cover: it keeps all three cases present and merely misroutes them into the text set,
 * which the multi-turn sequence CANNOT see, because `turn()` uses ids that differ across the sets.
 * It was measured, not assumed — under M16 the multi-turn passes and exactly two cells fail, with
 * the tally dropping 72 → 70 because two more stop reporting rather than failing.
 *
 * **A cell that throws is a cell that stops reporting** (this lane's own finding). M16's tally drop
 * is that hazard visible in miniature: a reader watching only the failure list would see two
 * failures and miss that two further assertions never ran at all. Compare the TALLY, not just the
 * red lines.
 *
 * **M10 is the one worth keeping.** It is not a hypothetical: the constructor really did omit
 * `role`, and this suite caught it on its first execution. The mutation re-introduces a defect that
 * actually shipped in the first draft, which is the strongest form this proof takes.
 *
 * **What these mutations do NOT prove.** Every cell here builds its own input by hand, so a killed
 * mutation shows the cells DEPEND on this code; it does not show a real entry point REACHES it.
 * That half is owed by the connector cutover and is not claimed here.
 *
 * Stated precisely, because the loose version of it has already gone stale once. It is no longer
 * true that "no connector calls these constructors": `connector-claude-code/src/agui-map.ts` calls
 * them, and its own suite maps a REAL session. What is still true is narrower and is the part that
 * matters — **nothing constructs an `AguiEmitter` outside a smoke**, so no connector PUBLISHES. The
 * two claims are easy to conflate and only one of them survives this commit.
 *
 * Run: pnpm smoke:agui-conformance
 */
import {
  CustomEventSchema,
  EventType,
  ReasoningMessageContentEventSchema,
  ReasoningMessageEndEventSchema,
  ReasoningMessageStartEventSchema,
  RunErrorEventSchema,
  RunFinishedEventSchema,
  RunStartedEventSchema,
  TextMessageContentEventSchema,
  TextMessageEndEventSchema,
  TextMessageStartEventSchema,
  ToolCallArgsEventSchema,
  ToolCallEndEventSchema,
  ToolCallResultEventSchema,
  ToolCallStartEventSchema,
} from "@ag-ui/core";

// The subject, by SOURCE path. A package-name import would resolve to this package's own `dist/`,
// and a mutation to `src/agui.ts` would then never reach the running code while this suite stayed
// green — the vacuous-parity failure already found once in this lane's `codex-args` suite.
import {
  AGUI_EVENT_TYPE,
  AGUI_FRAME_KIND,
  AGUI_PROTOCOL,
  AguiBrackets,
  AguiVocabularyError,
  COTAL_CUSTOM_EVENTS,
  aguiFrame,
  isAguiFramePart,
  parseAguiFrame,
  reasoningMessageContent,
  reasoningMessageEnd,
  reasoningMessageStart,
  runError,
  runFinished,
  runStarted,
  textMessageContent,
  textMessageEnd,
  textMessageStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  toolCallStart,
  type AguiEvent,
} from "../src/agui.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) ok++; else { fail++; console.log("  x FAIL:", n, extra ?? ""); }
};

/**
 * A refusal cell that asserts WHICH refusal.
 *
 * A guard that refuses because it is correct and one that refuses because it is broken are
 * identical from the refusing side, so every refusal here names the message it expects. A cell that
 * merely asserted "it threw" would pass against a mutation that refuses everything.
 */
const refuses = (name: string, fn: () => unknown, pattern: RegExp) => {
  try {
    fn();
    c(name, false, "accepted, expected a refusal");
  } catch (e) {
    const m = (e as Error).message;
    c(name, e instanceof AguiVocabularyError && pattern.test(m), m);
  }
};

const TS = 1_700_000_000_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. THE LITERALS MATCH THE REAL ENUM
//
//    `src/agui.ts` cannot import `EventType` as a value without a runtime dependency, so it writes
//    the discriminators out by hand. Nothing in the compiler compares them to anything. This is
//    that comparison, and it is mechanical over the whole table rather than a spot-check, so a
//    future member cannot be added without being covered.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const enumMembers = EventType as unknown as Record<string, string>;
let literalDrift = "";
for (const [key, literal] of Object.entries(AGUI_EVENT_TYPE))
  if (enumMembers[key] !== literal)
    literalDrift += `${key}: ours=${literal} real=${String(enumMembers[key])}; `;
c("every AGUI_EVENT_TYPE literal equals the real EventType member of the same name",
  literalDrift === "", literalDrift);
c("the table covers 14 mapped members", Object.keys(AGUI_EVENT_TYPE).length === 14,
  Object.keys(AGUI_EVENT_TYPE).length);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. EVERY CONSTRUCTOR'S OUTPUT PARSES UNDER THE SCHEMA THAT OWNS IT
//
//    Paired explicitly rather than looked up from a map built out of the same names, which would
//    make a mis-named constructor validate against its own mistake.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const parses = (name: string, schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, value: unknown) => {
  const r = schema.safeParse(value);
  c(`${name} parses under its real schema`, r.success, r.success ? "" : JSON.stringify(r.error));
};

parses("runStarted", RunStartedEventSchema, runStarted({ threadId: "sess-1", runId: "turn-1", timestamp: TS }));
parses("runFinished (no outcome)", RunFinishedEventSchema, runFinished({ threadId: "sess-1", runId: "turn-1", timestamp: TS }));
parses("runFinished (outcome success)", RunFinishedEventSchema,
  runFinished({ threadId: "sess-1", runId: "turn-1", timestamp: TS, outcome: { type: "success" } }));
parses("runError", RunErrorEventSchema, runError({ message: "boom", timestamp: TS, code: "E1" }));
parses("textMessageStart", TextMessageStartEventSchema, textMessageStart({ messageId: "u1#0", timestamp: TS, role: "assistant" }));
parses("textMessageContent", TextMessageContentEventSchema, textMessageContent({ messageId: "u1#0", delta: "hello", timestamp: TS }));
parses("textMessageEnd", TextMessageEndEventSchema, textMessageEnd({ messageId: "u1#0", timestamp: TS }));
parses("toolCallStart", ToolCallStartEventSchema, toolCallStart({ toolCallId: "tc1", toolCallName: "Read", timestamp: TS }));
parses("toolCallArgs", ToolCallArgsEventSchema, toolCallArgs({ toolCallId: "tc1", delta: '{"file":"a.ts"}', timestamp: TS }));
parses("toolCallEnd", ToolCallEndEventSchema, toolCallEnd({ toolCallId: "tc1", timestamp: TS }));
parses("toolCallResult", ToolCallResultEventSchema,
  toolCallResult({ messageId: "u2#0", toolCallId: "tc1", content: "ok", timestamp: TS }));
parses("reasoningMessageStart", ReasoningMessageStartEventSchema, reasoningMessageStart({ messageId: "u3#0", timestamp: TS }));
parses("reasoningMessageContent", ReasoningMessageContentEventSchema, reasoningMessageContent({ messageId: "u3#0", delta: "think", timestamp: TS }));
parses("reasoningMessageEnd", ReasoningMessageEndEventSchema, reasoningMessageEnd({ messageId: "u3#0", timestamp: TS }));

// THE CONTROL for the block above, and it is the inverse of the predicate under test: these schemas
// must REFUSE something, or "it parsed" proves nothing. A schema that accepted anything would make
// all fourteen cells vacuous while looking like the strongest section in the file.
c("CONTROL: the real schema refuses a TEXT_MESSAGE_CONTENT missing its required delta",
  TextMessageContentEventSchema.safeParse({ type: "TEXT_MESSAGE_CONTENT", messageId: "m" }).success === false);
c("CONTROL: the real schema refuses a TOOL_CALL_RESULT missing its required messageId",
  ToolCallResultEventSchema.safeParse({ type: "TOOL_CALL_RESULT", toolCallId: "tc", content: "x" }).success === false);

// The two measured protocol facts `src/agui.ts` documents, asserted so the documentation cannot
// quietly become false. Both were WRONG in a first static reading of the .d.ts and corrected only
// by executing them — which is why they are executed here rather than restated.
c("MEASURED: a RUN_FINISHED with NO outcome is accepted (the tolerated no-outcome case is real)",
  RunFinishedEventSchema.safeParse({ type: "RUN_FINISHED", threadId: "t", runId: "r" }).success === true);
// Found by this suite on its first run: the constructor omitted `role` and the real schema refused
// the event. `TEXT_MESSAGE_START.role` is optional, `REASONING_MESSAGE_START.role` is a REQUIRED
// literal — an asymmetry no reading of the two constructors side by side would suggest.
c("MEASURED: REASONING_MESSAGE_START requires role:\"reasoning\", unlike TEXT_MESSAGE_START",
  ReasoningMessageStartEventSchema.safeParse({ type: "REASONING_MESSAGE_START", messageId: "m" }).success === false &&
  ReasoningMessageStartEventSchema.safeParse({ type: "REASONING_MESSAGE_START", messageId: "m", role: "reasoning" }).success === true &&
  TextMessageStartEventSchema.safeParse({ type: "TEXT_MESSAGE_START", messageId: "m" }).success === true);
c("MEASURED: the outcome discriminator key is `type`, and `status` is refused",
  RunFinishedEventSchema.safeParse({ type: "RUN_FINISHED", threadId: "t", runId: "r", outcome: { type: "success" } }).success === true &&
  RunFinishedEventSchema.safeParse({ type: "RUN_FINISHED", threadId: "t", runId: "r", outcome: { status: "success" } }).success === false);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. `.passthrough()` — THE `cotal` METADATA VEHICLE
//
//    Vehicle (a) for Cotal-specific data is one `cotal` key on a standard event, and it is legal
//    only because these schemas are `.passthrough()`. Asserted rather than trusted, because the
//    whole vehicle collapses silently if a future release tightens it: events would still validate
//    with the key STRIPPED, and every consumer would just stop seeing our metadata.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Swept over EVERY schema, not sampled on one. The header claims `.passthrough()` for the whole
// vocabulary; sampling `RunStarted` alone proved it for a fourteenth of what was claimed, and a
// release that tightened any OTHER event would have left this section green while that event's
// metadata vanished. The vehicle is only as good as its narrowest member, so the sweep is
// mechanical and a new event cannot be added without being covered.
const CM = { runIdSource: "connector", tsSource: "arrival" } as const;
const CM_JSON = JSON.stringify(CM);
const metaCarriers: Array<[string, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }, unknown]> = [
  ["runStarted", RunStartedEventSchema, runStarted({ threadId: "sess-1", runId: "turn-1", timestamp: TS, cotal: CM })],
  ["runFinished", RunFinishedEventSchema, runFinished({ threadId: "sess-1", runId: "turn-1", timestamp: TS, cotal: CM })],
  ["runError", RunErrorEventSchema, runError({ message: "boom", timestamp: TS, code: "E1", cotal: CM })],
  ["textMessageStart", TextMessageStartEventSchema, textMessageStart({ messageId: "u1#0", timestamp: TS, role: "assistant", cotal: CM })],
  ["textMessageContent", TextMessageContentEventSchema, textMessageContent({ messageId: "u1#0", delta: "hello", timestamp: TS, cotal: CM })],
  ["textMessageEnd", TextMessageEndEventSchema, textMessageEnd({ messageId: "u1#0", timestamp: TS, cotal: CM })],
  ["reasoningMessageStart", ReasoningMessageStartEventSchema, reasoningMessageStart({ messageId: "th1#0", timestamp: TS, cotal: CM })],
  ["reasoningMessageContent", ReasoningMessageContentEventSchema, reasoningMessageContent({ messageId: "th1#0", delta: "think", timestamp: TS, cotal: CM })],
  ["reasoningMessageEnd", ReasoningMessageEndEventSchema, reasoningMessageEnd({ messageId: "th1#0", timestamp: TS, cotal: CM })],
  ["toolCallStart", ToolCallStartEventSchema, toolCallStart({ toolCallId: "tc1", toolCallName: "Read", timestamp: TS, cotal: CM })],
  ["toolCallArgs", ToolCallArgsEventSchema, toolCallArgs({ toolCallId: "tc1", delta: "{}", timestamp: TS, cotal: CM })],
  ["toolCallEnd", ToolCallEndEventSchema, toolCallEnd({ toolCallId: "tc1", timestamp: TS, cotal: CM })],
  ["toolCallResult", ToolCallResultEventSchema, toolCallResult({ messageId: "r1#0", toolCallId: "tc1", content: "ok", timestamp: TS, cotal: CM })],
  // CUSTOM has no constructor — the `cotal.*` table is empty BY POLICY (§5), which is a rule this
  // plane enforces and not a property of the schema. Built by hand so the schema-level sweep stays
  // complete; the policy refusal is asserted separately in section 5.
  ["custom", CustomEventSchema, { type: "CUSTOM", name: "x", value: {}, timestamp: TS, cotal: CM }],
];
c("the passthrough sweep covers every schema the parse block covers",
  metaCarriers.length === 14, metaCarriers.length);

let notAccepted = "", stripped = "";
for (const [name, schema, event] of metaCarriers) {
  const r = schema.safeParse(event);
  if (!r.success) { notAccepted += `${name} `; continue; }
  // Acceptance is not enough — a `.strip()` schema also accepts, and silently DELETES the key. That
  // is the failure this cell exists for, and asserting acceptance alone would miss it entirely.
  if (JSON.stringify((r.data as Record<string, unknown>).cotal) !== CM_JSON) stripped += `${name} `;
}
c("EVERY event carrying a `cotal` key is ACCEPTED", notAccepted === "", notAccepted);
c("and on EVERY one the `cotal` key SURVIVES the parse rather than being stripped",
  stripped === "", stripped);

// The boundary of the vehicle, measured: `RunFinishedOutcomeSchema` is STRICT, so `cotal` rides an
// EVENT and never an `outcome`. Recorded as a cell because "AG-UI is passthrough" is exactly the
// kind of sentence that gets generalized one level too far.
c("CONTROL: the outcome object is STRICT — an unknown key inside it is refused",
  RunFinishedEventSchema.safeParse({
    type: "RUN_FINISHED", threadId: "t", runId: "r", outcome: { type: "success", cotal: { isError: true } },
  }).success === false);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. BRACKETING, OVER A SYNTHESIZED MULTI-TURN SEQUENCE
//
//    Multi-turn deliberately: a single turn cannot show that state is released at a run boundary,
//    so a one-turn fixture would pass against a machine that never closes anything.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// All THREE id spaces, deliberately. The machine keys text, reasoning and tool calls in separate
// sets (`src/agui.ts` `BracketState`), and a fixture that never emits a `REASONING_*` event leaves
// a third of the machine unexecuted while every cell below still passes — the exact defect this
// suite was graded on. The reasoning message sits between the prompt and the tool call because that
// is where a real harness puts it.
const turn = (n: number): AguiEvent[] => [
  runStarted({ threadId: "sess-1", runId: `turn-${n}`, timestamp: TS }),
  textMessageStart({ messageId: `u${n}#0`, timestamp: TS, role: "user" }),
  textMessageContent({ messageId: `u${n}#0`, delta: `prompt ${n}`, timestamp: TS }),
  textMessageEnd({ messageId: `u${n}#0`, timestamp: TS }),
  reasoningMessageStart({ messageId: `th${n}#0`, timestamp: TS }),
  reasoningMessageContent({ messageId: `th${n}#0`, delta: `thinking ${n}`, timestamp: TS }),
  reasoningMessageEnd({ messageId: `th${n}#0`, timestamp: TS }),
  toolCallStart({ toolCallId: `tc-${n}`, toolCallName: "Read", timestamp: TS }),
  toolCallArgs({ toolCallId: `tc-${n}`, delta: '{"file":"a.ts"}', timestamp: TS }),
  toolCallEnd({ toolCallId: `tc-${n}`, timestamp: TS }),
  toolCallResult({ messageId: `r${n}#0`, toolCallId: `tc-${n}`, content: "ok", timestamp: TS }),
  textMessageStart({ messageId: `a${n}#0`, timestamp: TS, role: "assistant" }),
  textMessageContent({ messageId: `a${n}#0`, delta: `answer ${n}`, timestamp: TS }),
  textMessageEnd({ messageId: `a${n}#0`, timestamp: TS }),
  runFinished({ threadId: "sess-1", runId: `turn-${n}`, timestamp: TS }),
];

const threeTurns = [...turn(1), ...turn(2), ...turn(3)];
let bracketErr = "";
const brackets = new AguiBrackets();
try {
  for (const e of threeTurns) brackets.accept(e);
  brackets.assertClosed();
} catch (e) { bracketErr = (e as Error).message; }
c("a synthesized 3-turn sequence brackets cleanly", bracketErr === "", bracketErr);
c("and the machine reports itself closed at the end", brackets.open === false);

// THE PROPERTY THAT MATTERS FOR SPLIT FRAMES: a frame is NOT required to be self-bracketed, because
// an oversized frame splits on event boundaries with each part carrying its own seq. A machine that
// demanded per-frame balance would forbid a split the plan mandates — so this feeds ONE turn as two
// frames and requires it to pass. Without this cell, "check bracketing per frame" is an easy and
// wrong repair that every other cell here would accept.
// The cut lands mid-REASONING on purpose: `slice(0, 5)` ends on `REASONING_MESSAGE_START`, so the
// second frame opens with an id already outstanding. That is stricter than cutting between
// messages, which would only prove the RUN survives a boundary — here a per-id set has to survive
// it too, and `snapshot()`/`restore()` (what the WAL persists) is the reason that matters.
const oneTurn = turn(9);
const splitA = oneTurn.slice(0, 5), splitB = oneTurn.slice(5);
let splitErr = "";
const splitBrackets = new AguiBrackets();
try {
  for (const e of splitA) splitBrackets.accept(e);
  c("mid-split, the machine reports the run still OPEN", splitBrackets.open === true);
  c("mid-split, the reasoning id opened in the FIRST frame is still outstanding",
    splitBrackets.snapshot().reasoning.join(",") === "th9#0", splitBrackets.snapshot());
  for (const e of splitB) splitBrackets.accept(e);
  splitBrackets.assertClosed();
} catch (e) { splitErr = (e as Error).message; }
c("one turn split across two frames still brackets — a frame need not balance alone", splitErr === "", splitErr);

// Refusals, each naming its own message so a mutation that refuses everything cannot pass them.
refuses("a second RUN_STARTED while a run is open is refused",
  () => { const b = new AguiBrackets(); b.accept(turn(1)[0]!); b.accept(turn(2)[0]!); },
  /RUN_STARTED .* while run .* is still open/);

refuses("an event outside any open run is refused",
  () => new AguiBrackets().accept(textMessageStart({ messageId: "m", timestamp: TS })),
  /outside an open run/);

refuses("re-opening a messageId that is already open is refused",
  () => {
    const b = new AguiBrackets();
    b.accept(turn(1)[0]!);
    b.accept(textMessageStart({ messageId: "dup", timestamp: TS }));
    b.accept(textMessageStart({ messageId: "dup", timestamp: TS }));
  },
  /re-opened "dup" while already open/);

refuses("closing a run with a tool call still open is refused",
  () => {
    const b = new AguiBrackets();
    b.accept(turn(1)[0]!);
    b.accept(toolCallStart({ toolCallId: "leak", toolCallName: "Read", timestamp: TS }));
    b.accept(runFinished({ threadId: "sess-1", runId: "turn-1", timestamp: TS }));
  },
  /RUN_FINISHED while still open: leak/);

refuses("RUN_FINISHED naming a different run than the open one is refused",
  () => {
    const b = new AguiBrackets();
    b.accept(turn(1)[0]!);
    b.accept(runFinished({ threadId: "sess-1", runId: "turn-99", timestamp: TS }));
  },
  /RUN_FINISHED for "turn-99" but the open run is "turn-1"/);

refuses("content for a messageId that was never opened is refused",
  () => {
    const b = new AguiBrackets();
    b.accept(turn(1)[0]!);
    b.accept(textMessageContent({ messageId: "ghost", delta: "x", timestamp: TS }));
  },
  /TEXT_MESSAGE_CONTENT for "ghost" which is not open/);

// The reasoning id space gets its OWN refusals rather than riding the text ones. The three cases
// share `openId`/`requireOpen`/`closeId`, so a mutation to a helper reddens text and reasoning
// alike and proves nothing about the routing — these cells exist for the mutation that misroutes
// `REASONING_MESSAGE_*` to another set, which every text cell would survive.
refuses("re-opening a reasoning messageId that is already open is refused",
  () => {
    const b = new AguiBrackets();
    b.accept(turn(1)[0]!);
    b.accept(reasoningMessageStart({ messageId: "th-dup", timestamp: TS }));
    b.accept(reasoningMessageStart({ messageId: "th-dup", timestamp: TS }));
  },
  /REASONING_MESSAGE_START re-opened "th-dup" while already open/);

refuses("reasoning content for a messageId that was never opened is refused",
  () => {
    const b = new AguiBrackets();
    b.accept(turn(1)[0]!);
    b.accept(reasoningMessageContent({ messageId: "th-ghost", delta: "x", timestamp: TS }));
  },
  /REASONING_MESSAGE_CONTENT for "th-ghost" which is not open/);

refuses("closing a reasoning message that was never opened is refused",
  () => {
    const b = new AguiBrackets();
    b.accept(turn(1)[0]!);
    b.accept(reasoningMessageEnd({ messageId: "th-ghost", timestamp: TS }));
  },
  /REASONING_MESSAGE_END for "th-ghost" which is not open/);

refuses("closing a run with a REASONING message still open is refused",
  () => {
    const b = new AguiBrackets();
    b.accept(turn(1)[0]!);
    b.accept(reasoningMessageStart({ messageId: "th-leak", timestamp: TS }));
    b.accept(runFinished({ threadId: "sess-1", runId: "turn-1", timestamp: TS }));
  },
  /RUN_FINISHED while still open: th-leak/);

// The `TOOL_CALL_RESULT` guard, which is the one case that asserts an id is NOT open. Every happy
// path sends the result after `TOOL_CALL_END`, so deleting the guard left the suite fully green —
// an unexecuted branch inside an otherwise well-covered machine.
refuses("a TOOL_CALL_RESULT arriving while its call is still open is refused",
  () => {
    const b = new AguiBrackets();
    b.accept(turn(1)[0]!);
    b.accept(toolCallStart({ toolCallId: "tc-early", toolCallName: "Read", timestamp: TS }));
    b.accept(toolCallResult({ messageId: "r#0", toolCallId: "tc-early", content: "ok", timestamp: TS }));
  },
  /TOOL_CALL_RESULT for "tc-early" while its call is still open/);

// THE THREE ID SETS ARE SEPARATE, and nothing else here can see that. Every other cell uses ids
// that differ across the sets, so a machine that routed all three into ONE set would pass the whole
// file. This opens the SAME id as text and as reasoning at once and requires both to be legal:
// they are different namespaces in the protocol, and a collision between them is not a re-open.
let sharedIdErr = "";
try {
  const b = new AguiBrackets();
  b.accept(turn(1)[0]!);
  b.accept(textMessageStart({ messageId: "shared", timestamp: TS, role: "assistant" }));
  b.accept(reasoningMessageStart({ messageId: "shared", timestamp: TS }));
  b.accept(toolCallStart({ toolCallId: "shared", toolCallName: "Read", timestamp: TS }));
  const snap = b.snapshot();
  c("one id open in all THREE sets at once is legal — they are separate namespaces",
    snap.text.join() === "shared" && snap.reasoning.join() === "shared" && snap.tools.join() === "shared", snap);
  b.accept(textMessageEnd({ messageId: "shared", timestamp: TS }));
  // After the TEXT id closes, the reasoning and tool ids of the same name must still be open —
  // this is what separates three sets from one set that happens to be keyed loosely.
  const after = b.snapshot();
  c("closing the TEXT `shared` leaves the reasoning and tool `shared` open",
    after.text.length === 0 && after.reasoning.join() === "shared" && after.tools.join() === "shared", after);
} catch (e) { sharedIdErr = (e as Error).message; }
c("the three id sets do not collide", sharedIdErr === "", sharedIdErr);

// THE CONTROL for the whole refusal block — the inverse of the predicate under test. Every cell
// above shows the machine refusing something; this shows it ACCEPTING the legitimate neighbour of
// the thing it refuses. A machine broken so it refuses all input would satisfy every refusal above,
// and only this cell separates it from a correct one. Counted by NAME, not by number: this comment
// used to say "all six", which was already wrong by the time anyone read it.
let controlErr = "";
try {
  const b = new AguiBrackets();
  for (const e of turn(1)) b.accept(e);
  for (const e of turn(2)) b.accept(e);   // a SECOND run, after the first legally closed
  b.assertClosed();
} catch (e) { controlErr = (e as Error).message; }
c("CONTROL: a run opened after the previous one CLOSED is accepted", controlErr === "", controlErr);

// The reused-id case that has a measurement behind it: `message.id` is a provider request id, and
// over one real session 833 of 1243 appeared in more than one entry. Keying identity on it would
// re-open the same messageId — so the machine must refuse that, and a mapper that spends the field
// wrongly is caught here rather than by a consumer after a durable publish.
refuses("a provider id reused across two observations is refused as a re-open",
  () => {
    const b = new AguiBrackets();
    b.accept(turn(1)[0]!);
    b.accept(textMessageStart({ messageId: "msg_provider_01", timestamp: TS }));
    b.accept(textMessageEnd({ messageId: "msg_provider_01", timestamp: TS }));
    b.accept(textMessageStart({ messageId: "msg_provider_01", timestamp: TS }));
    b.accept(textMessageStart({ messageId: "msg_provider_01", timestamp: TS }));
  },
  /re-opened "msg_provider_01" while already open/);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 5. THE `cotal.*` CUSTOM TABLE IS EMPTY, AND THAT IS THE SPECIFICATION
// ─────────────────────────────────────────────────────────────────────────────────────────────
c("the v1 CUSTOM table has ZERO members", COTAL_CUSTOM_EVENTS.length === 0, COTAL_CUSTOM_EVENTS);
refuses("an undeclared CUSTOM name is refused rather than emitted",
  () => {
    const b = new AguiBrackets();
    b.accept(turn(1)[0]!);
    b.accept({ type: "CUSTOM", name: "cotal.ask.opened", value: {}, timestamp: TS } as unknown as AguiEvent);
  },
  /CUSTOM "cotal\.ask\.opened" is not declared/);
// Named for the specific pair §4 removed when ask state left this plane, because the failure mode
// is somebody re-adding exactly those two "because the table has slots".
c("CONTROL: the real CustomEventSchema would have ACCEPTED that event — the refusal is ours, by policy, not the protocol's",
  CustomEventSchema.safeParse({ type: "CUSTOM", name: "cotal.ask.opened", value: {} }).success === true);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 6. THE FRAME ENVELOPE
// ─────────────────────────────────────────────────────────────────────────────────────────────
const frame = aguiFrame({ threadId: "sess-1", runId: "turn-1", epoch: "ep-1", seq: 0, events: turn(1) });
c("a frame declares its kind and protocol", frame.kind === AGUI_FRAME_KIND && frame.protocol === AGUI_PROTOCOL,
  [frame.kind, frame.protocol]);
c("the protocol string names the pinned version", AGUI_PROTOCOL === "ag-ui/0.0.57", AGUI_PROTOCOL);
c("seq 0 is legal — the first frame of a writer is not a missing frame", frame.seq === 0);

refuses("a frame with no events is refused rather than published as a gap-free no-op",
  () => aguiFrame({ threadId: "t", runId: "r", epoch: "e", seq: 0, events: [] }),
  /at least one event/);
refuses("a negative seq is refused", () => aguiFrame({ threadId: "t", runId: "r", epoch: "e", seq: -1, events: turn(1) }),
  /seq must be a non-negative safe integer/);
refuses("a non-integer seq is refused", () => aguiFrame({ threadId: "t", runId: "r", epoch: "e", seq: 1.5, events: turn(1) }),
  /seq must be a non-negative safe integer/);
refuses("an empty epoch is refused", () => aguiFrame({ threadId: "t", runId: "r", epoch: "", seq: 0, events: turn(1) }),
  /frame epoch must be a non-empty string/);
refuses("an empty threadId is refused", () => aguiFrame({ threadId: "", runId: "r", epoch: "e", seq: 0, events: turn(1) }),
  /frame threadId must be a non-empty string/);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 7. TWO PRINCIPALS THROUGH ONE CHANNEL STAY SEPARATE — AT THE ENVELOPE LAYER
//
//    ⚠️ Read the header warning before reading these cells. This is NOT channel isolation. That is
//    a scope statement, not a statement about the tree: channel isolation DOES exist at this commit
//    — the channel keys on the principal (`events.<owner>.<actor>`) and the header names the three
//    suites that prove it. This comment used to say isolation "does not exist at this commit",
//    which the re-key made false and which no cell here could catch, because a comment asserting
//    something outside its own function is a test nobody wrote. What IS asserted below is the
//    envelope half, which survives the re-key: two writers sharing one subject remain attributable,
//    because every frame carries its own writer identity.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const alpha = aguiFrame({ threadId: "sess-alpha", runId: "turn-1", epoch: "epoch-alpha", seq: 0, events: turn(1) });
const beta  = aguiFrame({ threadId: "sess-beta",  runId: "turn-1", epoch: "epoch-beta",  seq: 0, events: turn(1) });

c("two principals' frames carry DISTINCT threadIds", alpha.threadId !== beta.threadId, [alpha.threadId, beta.threadId]);
c("two principals' frames carry DISTINCT epochs", alpha.epoch !== beta.epoch, [alpha.epoch, beta.epoch]);
// The sharp one: their runIds and seqs COLLIDE, deliberately. Two writers each number their own
// turns from 1 and their own frames from 0, so a consumer that de-duplicated or ordered on
// (runId, seq) alone would merge two principals' streams into one. That is the real failure this
// section is about, and it is why the epoch is the discriminator rather than the sequence.
c("their runIds and seqs COLLIDE, so neither can be the discriminator",
  alpha.runId === beta.runId && alpha.seq === beta.seq);
c("the (epoch, seq) pair separates them where (runId, seq) does not",
  `${alpha.epoch}/${alpha.seq}` !== `${beta.epoch}/${beta.seq}`);

// And each writer's own stream brackets independently — interleaving two principals' events into
// ONE machine is what a channel-keyed-on-name consumer effectively does, and it must not appear
// well-formed. This is the executable form of the co-mingling the plan measured.
// Through `refuses()`, so it names WHICH refusal. It previously checked `instanceof
// AguiVocabularyError` alone, which is the bar this file sets for every other refusal cell and did
// not meet itself: a machine that refused its own legitimate second turn would have passed it.
refuses("two principals' runs interleaved into one stream do NOT look well-formed",
  () => {
    const b = new AguiBrackets();
    b.accept(runStarted({ threadId: "sess-alpha", runId: "turn-1", timestamp: TS }));
    b.accept(runStarted({ threadId: "sess-beta", runId: "turn-1", timestamp: TS }));
  },
  /RUN_STARTED for "turn-1" while run "turn-1" is still open/);

// ---------------------------------------------------------------------------------------------
// THE CONSUMER-SIDE VALIDATOR. This is the renderers' enforcement point, and it exists because the
// obvious one does not: `implementations/web/tsconfig.json` excludes `src/web` from `tsc` and the
// build copies it into `dist` verbatim, so that renderer is plain JavaScript no compiler reads.
// A contract expressed as types has NO ENFORCEMENT POINT on it. So the contract is a function, and
// these cells are what a consumer is entitled to rely on.
// ---------------------------------------------------------------------------------------------
const good = aguiFrame({ threadId: "t", runId: "r", epoch: "e", seq: 0, events: turn(1) });

// ROUTING vs VALIDITY — the two answers that must never fuse. A consumer sharing a channel meets
// parts that are not its business constantly; it meets a malformed frame as a defect.
c("route:a-text-part-is-NOT-an-agui-frame", isAguiFramePart({ kind: "text", text: "hello" }) === false);
c("route:a-real-frame-IS-one", isAguiFramePart(good) === true);
c("route:the-routing-check-NEVER-throws-on-junk", (() => {
  for (const junk of [null, undefined, 0, "", [], { kind: 7 }, { nokind: true }])
    if (typeof isAguiFramePart(junk) !== "boolean") return false;
  return true;
})());

c("validate:a-well-formed-frame-passes-through-unchanged", parseAguiFrame(good) === good);
// EACH REFUSAL NAMES ITS OWN FIELD, through the same `refuses` helper the bracket cells use — a
// validator that threw one message for every defect would tell a renderer author nothing, and "it
// refused" is the same observation whichever field was wrong.
refuses("validate:a-protocol-SKEW-is-refused-and-says-so",
  () => parseAguiFrame({ ...good, protocol: "ag-ui/9.9.9" }), /protocol mismatch/);
refuses("validate:an-empty-threadId-is-refused-BY-NAME",
  () => parseAguiFrame({ ...good, threadId: "" }), /threadId/);
refuses("validate:a-negative-seq-is-refused-BY-NAME",
  () => parseAguiFrame({ ...good, seq: -1 }), /seq/);
refuses("validate:an-EMPTY-events-array-is-refused",
  () => parseAguiFrame({ ...good, events: [] }), /at least one event/);
refuses("validate:an-UNRECOGNISED-event-type-is-refused-rather-than-skipped",
  () => parseAguiFrame({ ...good, events: [{ type: "SOME_FUTURE_EVENT" }] }), /unrecognised type/);
// And the routing/validity boundary from the other side: something that never claimed to be a frame
// must be refused by pointing at the ROUTING check, not with a field complaint.
refuses("validate:a-non-frame-is-refused-by-pointing-at-the-ROUTING-check",
  () => parseAguiFrame({ kind: "text", text: "x" }), /isAguiFramePart/);
// THE CONTROL FOR THE WHOLE REFUSAL BLOCK, and it is the inverse predicate: every type the
// vocabulary DOES define must survive the same check. Without it, "unknown types are refused" is
// satisfied by a validator that refuses everything — which is what every cell above would also pass.
c("validate:CONTROL-every-defined-event-type-is-accepted-by-the-same-check", (() => {
  for (const t of Object.values(AGUI_EVENT_TYPE)) {
    try {
      parseAguiFrame({ ...good, events: [{ type: t }] });
    } catch {
      return false;
    }
  }
  return true;
})(), { types: Object.values(AGUI_EVENT_TYPE).length });

console.log(`agui-conformance smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
