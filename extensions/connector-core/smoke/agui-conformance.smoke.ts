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
 * only, and it is NOT channel isolation.** At this commit `eventChannel` still keys on the display
 * name, and the plan carries a MEASURED repro of two valid principals both named `worker`
 * publishing to one `events.worker` and being co-mingled by an observer. Writing a cell here that
 * asserted two principals get two channels would fail; writing one that asserted they share one
 * would be worse — it would encode today's defect as correct, which this plan forbids by name
 * because this build has already been burned by exactly that. So this suite asserts only what is
 * true and will REMAIN true after the re-key: frames from two principals are attributable to their
 * own writers by the envelope they carry. **The channel-isolation half belongs to the commit that
 * keys on the principal-stable id, and does not exist yet.** Do not read the cell below as covering
 * it.
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
 *
 * All five landed in SOURCE (this suite imports `../src/agui.js`, so a mutation cannot miss the code
 * that runs), all five killed exactly their predicted set and nothing else, and the restore was
 * verified by a clean `git status` plus a return to the baseline tally.
 *
 * **M10 is the one worth keeping.** It is not a hypothetical: the constructor really did omit
 * `role`, and this suite caught it on its first execution. The mutation re-introduces a defect that
 * actually shipped in the first draft, which is the strongest form this proof takes.
 *
 * **What these mutations do NOT prove.** Every cell here builds its own input by hand — no connector
 * calls these constructors yet, because nothing emits. So a killed mutation shows the cells DEPEND
 * on this code; it does not show a real entry point REACHES it. That half is owed by the connector
 * cutover and is not claimed here.
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
const withMeta = runStarted({
  threadId: "sess-1", runId: "turn-1", timestamp: TS,
  cotal: { runIdSource: "connector", tsSource: "arrival" },
});
const passed = RunStartedEventSchema.safeParse(withMeta);
c("an event carrying a `cotal` key is ACCEPTED", passed.success, JSON.stringify(passed));
// Acceptance is not enough — a `.strip()` schema also accepts, and silently DELETES the key. That
// is the failure this cell exists for, and asserting acceptance alone would miss it entirely.
c("and the `cotal` key SURVIVES the parse rather than being stripped",
  passed.success && JSON.stringify((passed as { data: Record<string, unknown> }).data.cotal) ===
    JSON.stringify({ runIdSource: "connector", tsSource: "arrival" }),
  passed.success ? (passed as { data: Record<string, unknown> }).data.cotal : "");

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
const turn = (n: number): AguiEvent[] => [
  runStarted({ threadId: "sess-1", runId: `turn-${n}`, timestamp: TS }),
  textMessageStart({ messageId: `u${n}#0`, timestamp: TS, role: "user" }),
  textMessageContent({ messageId: `u${n}#0`, delta: `prompt ${n}`, timestamp: TS }),
  textMessageEnd({ messageId: `u${n}#0`, timestamp: TS }),
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
const oneTurn = turn(9);
const splitA = oneTurn.slice(0, 5), splitB = oneTurn.slice(5);
let splitErr = "";
const splitBrackets = new AguiBrackets();
try {
  for (const e of splitA) splitBrackets.accept(e);
  c("mid-split, the machine reports the run still OPEN", splitBrackets.open === true);
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

// THE CONTROL for the whole refusal block — the inverse of the predicate under test. Every cell
// above shows the machine refusing something; this shows it ACCEPTING the legitimate neighbour of
// the thing it refuses. A machine broken so it refuses all input would satisfy all six refusals and
// only this cell separates it from a correct one.
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
//    ⚠️ Read the header warning before reading these cells. This is NOT channel isolation, which
//    does not exist at this commit and cannot be asserted until the channel keys on the
//    principal-stable id. What is asserted is the property that survives that change: two writers
//    sharing one subject remain attributable, because every frame carries its own writer identity.
//    Named this way so a later reader cannot mistake one for the other.
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
let interleaveRefused = false;
try {
  const b = new AguiBrackets();
  b.accept(runStarted({ threadId: "sess-alpha", runId: "turn-1", timestamp: TS }));
  b.accept(runStarted({ threadId: "sess-beta", runId: "turn-1", timestamp: TS }));
} catch (e) { interleaveRefused = e instanceof AguiVocabularyError; }
c("two principals' runs interleaved into one stream do NOT look well-formed", interleaveRefused);

console.log(`agui-conformance smoke: ${ok} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
