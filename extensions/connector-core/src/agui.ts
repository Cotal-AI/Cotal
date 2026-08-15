/**
 * The AG-UI event VOCABULARY and the Cotal frame envelope.
 *
 * This is the file that makes the change an abolition rather than a rename. Renaming `tr-<name>` to
 * `events.<name>` while the connectors still publish `condense()` output would move glyph-prefixed
 * text to a new channel and change nothing a consumer can do with it — the channel name was never
 * the complaint.
 *
 * **The vocabulary is adopted; the SDK is not** (plan §2). `@ag-ui/core` is a `devDependency`,
 * pinned EXACT at `0.0.57`, and this file imports from it with `import type` ONLY. The reason is
 * measured rather than stylistic: `0.0.57` declares `dependencies: { zod: "^3.22.4" }` (verified
 * against the registry, not remembered), and `connector-core` is esbuild-bundled into every seeded
 * connector — so a runtime dependency would ship a second zod major to every customer in order to
 * validate events we construct ourselves. The conformance smoke imports the real schemas and
 * validates against them; production code carries types and string literals and no zod.
 *
 * **Promotion trigger, conditional and NOT scheduled:** if a 0.1.x ships stable with zod moved to
 * `peerDependencies`, promote to a runtime dependency and use the schemas directly. As of this
 * writing `latest` is `0.0.57`, the active `canary` still carries the zod-3 runtime dep, and the
 * release that moves zod to a peer sits on no dist-tag at all.
 *
 * ## What step 1 deferred, and where it now stands
 *
 * Step 1 names `eventChannel()` and the `max_payload` preflight/split as parts of this module. Both
 * were deliberately absent when this file landed, because each depended on something that did not
 * exist — and they were NAMED rather than stubbed, since a stub is a claim that the shape is known.
 * Both prerequisites have since landed on this branch, so the record is updated rather than left to
 * age into a false statement about the tree:
 *
 * - **The channel key was replaced, and `eventChannel()` did NOT come here.** It keys on the
 *   principal now (`events.<owner>.<actor>`) instead of the display name, which
 *   `packages/core/src/resolve.ts` states is not an identity. It lives in `launch.ts`, beside the
 *   launch plumbing that is its only caller, rather than in this module as §5.6 sketches. **That is
 *   a deliberate divergence from the plan and it is recorded as one, not slipped:** moving a working
 *   function across files to satisfy a section that predates the re-key is churn with no behavioural
 *   gain, and §5.6's point — one module, not `tr-`'s three scattered copies — is already met. If a
 *   second caller ever appears, move it and take the cells with it.
 * - **Sizing arrived, and the split below is built on it.** `CotalEndpoint.encodedSize` measures the
 *   exact bytes the client will send, headers included, on the same surface that builds the
 *   envelope. That is what makes {@link splitFrames} implementable: it does not measure, it is
 *   handed the measurement. A raw `maxPayload` getter never was sufficient, and the plan said so
 *   before this lane confirmed it against a real 4096-byte broker.
 *
 * **Where the "nothing runs" claim now stands, restated precisely rather than left to rot.** The
 * emitter below EXISTS, and `[P5]`'s R1 preflight has a real call site in its startup — which it did
 * not when this file landed. What is still true, and is the part that matters:
 *
 * - **No connector constructs an emitter**, so nothing in production reaches any of this. The
 *   emitter is a production call site for the preflight and is not itself production-reached.
 * - **{@link splitFrames} has no durable-plane caller BY DESIGN** — it is the preview plane's
 *   splitter (§5.8); the emitter packs with {@link packUnits}. See its own doc for why calling it
 *   from the durable plane would be a silent-loss bug rather than a style choice.
 *
 * The distinction is the whole reason this paragraph is maintained: "it has a caller" and "a real
 * entry point reaches it" are different claims, and this module has one of each right now.
 */

import type {
  CustomEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageStartEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@ag-ui/core";
import { randomUUID } from "node:crypto";
import { isCasLoss, principalKey, type Part } from "@cotal-ai/core";
import type { DurableSource } from "./durable-source.js";
import type { EventWal } from "./event-wal.js";
import { eventChannelForSession } from "./launch.js";

/**
 * The AG-UI events this plane emits — the MAPPED SUBSET, not the whole protocol.
 *
 * Absent by decision, each recorded so its absence is not read as an oversight:
 * `*_CHUNK` (plan §3: all three sources are settled observations, so we emit the START/CONTENT/END
 * triple, which is the subset every consumer implements — raw CHUNK needs a client transformer);
 * `STATE_*` and the interrupt outcome (§4 reserved them for cotal-lang `checkpoint`, and ask state
 * left this plane entirely); `MESSAGES_SNAPSHOT` (§5.3 dropped it as a compaction anchor — a
 * windowed snapshot DELETES the prefix); `THINKING_*` (deprecated at 0.0.57 in favour of
 * `REASONING_*`, which is what we emit).
 */
export type AguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | CustomEvent;

/**
 * The `type` discriminators, as literals.
 *
 * `EventType` in `@ag-ui/core` is a real (non-const) enum, so reading `EventType.RUN_STARTED` as a
 * VALUE would be a runtime import of the package this module is forbidden to depend on at runtime.
 * So the literals are written out — and the conformance smoke asserts each one against the real
 * enum member, because a hand-copied literal that nothing compares to its source is exactly the
 * drift this lane has already shipped once.
 */
export const AGUI_EVENT_TYPE = {
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
} as const;

/**
 * Cotal metadata rides ONE key on a standard event.
 *
 * Legal because every AG-UI event schema is `.passthrough()` — asserted by the conformance smoke
 * against the real schemas rather than trusted, since this whole vehicle collapses if a future
 * release tightens it.
 *
 * **It does NOT work everywhere.** `RunFinishedOutcomeSchema` is STRICT: it refuses unrecognized
 * keys, measured. So `cotal` may ride an EVENT and never an `outcome`. Recorded here because
 * "AG-UI is passthrough" is the kind of sentence that gets generalized one level too far.
 */
export interface CotalMeta {
  /** Where the `timestamp` came from. Absent means the source carried a real one. */
  tsSource?: "arrival";
  /** Set when the connector minted the `runId` rather than reading one from the harness. */
  runIdSource?: "connector";
  /** The provider's own message id — preserved for correlation, never spent as `messageId`. */
  providerMessageId?: string;
  /** The harness's stop reason, on the event that carries one. */
  stopReason?: string;
  /** `tool_result.is_error` — AG-UI's result event has no error field of its own. */
  isError?: boolean;
  /** Subagent linkage. Deliberately NOT `parentRunId`, which is retry/edit lineage. */
  delegation?: { agentId: string; toolCallId: string };
  /**
   * WHAT BEGAN THIS RUN. Attribution, and deliberately NOT a gate on run-opening.
   *
   * Run-opening ("did a turn begin?") and attribution ("who began it?") are two questions, and an
   * earlier revision used one provenance predicate to answer both — so a turn started by a peer
   * produced no run at all, and an agent-driven session mapped to nothing. Provenance ANNOTATES;
   * it does not SELECT. A run with `"channel"` attribution is still a run.
   *
   * `"unknown"` is never written by the mapper: an unrecognised provenance FAILS LOUD instead, so a
   * future harness value produces an error rather than a confident wrong attribution. It exists for
   * consumers that must render something for a producer which did not set the field.
   */
  turnSource?: "human" | "channel" | "notification" | "sdk" | "unknown";
  /** What was cut to fit the wire, and how big it was. Set only by the sizing path. */
  truncated?: { field: string; originalBytes: number };
}

/** An event carrying Cotal metadata. Kept structural so it composes with any member of the union. */
export type WithCotal<E> = E & { cotal?: CotalMeta };

/**
 * The `cotal.*` `CUSTOM` event table — the second and ONLY other vehicle for Cotal-specific data.
 *
 * **The v1 table is EMPTY, and that is the specification, not an unfinished state.** Earlier
 * revisions described a two-member table holding `cotal.ask.opened` / `cotal.ask.settled`; §4
 * removed both when ask state left this plane, on the operative ground that there is no consumer —
 * the board answers what is owed, the plane carries what is happening. Leaving the count in the
 * prose invited re-adding them "because the table has two slots", so the table ships with no slots.
 *
 * It exists as the GATE: adding a member is a decision that touches this declaration, rather than
 * a `CUSTOM` name invented at a call site where nobody reviews the vocabulary.
 */
export const COTAL_CUSTOM_EVENTS: readonly string[] = [];

/** The envelope version. One frame declares the AG-UI vocabulary version it was built against. */
export const AGUI_PROTOCOL = "ag-ui/0.0.57";

/** The frame's `kind`, distinguishing it from every other part a Cotal message can carry. */
export const AGUI_FRAME_KIND = "ag-ui.frame";

/**
 * One Cotal message = one frame (plan §5.2).
 *
 * `threadId` is the native harness session and `runId` is ONE native harness turn — §4 is explicit
 * that nothing else may claim these. `epoch` is the writer-identity fence recovered from the WAL
 * (never re-minted on restart), and `seq` is this writer's frame counter, which is what lets a
 * consumer detect a gap rather than merely fail to notice one.
 *
 * **A frame carries no text part, by design.** That is why the renderers are a binding precondition
 * on the cutover rather than a follow-up.
 *
 * **RE-DERIVED, because core changed underneath this sentence.** It used to end "a viewer that does
 * not understand this part shows nothing, and an empty pane is indistinguishable from a
 * correctly-empty one." That is now true of some surfaces and false of others, and the split is
 * exactly which ones adopted core's shared `partsToText`:
 *
 *   - **3 ADOPTED IT** — `connector-core/src/agent.ts`, `cli/src/commands/join.ts`,
 *     `cli/src/view/mesh-view.ts`. These now render a marker naming the kind.
 *   - **4 DID NOT** — `implementations/web/src/web/app.js`, `.../graph.js`,
 *     `examples/02-self-improving-console/harness/observer.ts`,
 *     `examples/04-frontier-faces/tools/studio.mjs`. The two stringify-form copies still leave a
 *     stray separator; the two filter-form ones still leave no trace at all.
 *
 * Measured on a real frame from `aguiFrame` below, placed between two text parts: the adopted
 * renderer produced `"before  after"` before the core change and names the kind after it. **The
 * worse half of that defect was never the missing frame — it was that `"before  after"` is a
 * well-formed sentence with a silent hole in it, so it prompts no question at all.**
 *
 * **THE PRECONDITION IS UNCHANGED AND THE MARKER IS NOT A LOOPHOLE IN IT.** A named marker proves a
 * frame ARRIVED; it does not display one. Cutting a connector over on the strength of it would
 * still ship events nothing can render.
 */
export interface AguiFrame {
  kind: typeof AGUI_FRAME_KIND;
  protocol: typeof AGUI_PROTOCOL;
  threadId: string;
  runId: string;
  epoch: string;
  seq: number;
  events: AguiEvent[];
}

/** Raised when a frame or an event sequence violates a structural rule of the vocabulary. */
export class AguiVocabularyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AguiVocabularyError";
  }
}

/**
 * The bracket machine's persisted form (WAL v2).
 *
 * It is a plain, JSON-round-trippable record on purpose: it is written into the write-ahead log, so
 * it must survive `JSON.stringify`/`parse` unchanged and must be readable by a human staring at a
 * WAL trying to work out why an emitter refused something.
 */
export interface BracketState {
  /** The run currently open, or `undefined` when the stream is at a legal stopping point. */
  run: string | undefined;
  text: string[];
  reasoning: string[];
  tools: string[];
}

/**
 * Bracketing, checked INCREMENTALLY over the event sequence — deliberately not over one frame.
 *
 * **A frame is not guaranteed to be self-bracketed, and a validator demanding that it be would
 * forbid a split the plan mandates.** An oversized frame splits on event boundaries with each part
 * carrying its own `seq` (§5.2), so a run can legally open in one frame and close in the next. The
 * unit that must balance is the WRITER'S STREAM, not the message. Feeding this machine frame after
 * frame is therefore the only way to check the property that is actually claimed.
 *
 * What it enforces:
 * - one run open at a time; nothing may be emitted outside an open run
 * - `TEXT_MESSAGE_*`, `REASONING_MESSAGE_*` and `TOOL_CALL_*` open and close by their own id, and an
 *   id may not be opened twice while already open
 * - a run may not close while any message or tool call it opened is still open
 *
 * The id-reuse rule is the one with a measured defect behind it: `message.id` is a PROVIDER REQUEST
 * id, and over one real session 833 of 1243 assistant `message.id` values appeared in more than one
 * JSONL entry. Keying identity on it would open and close the same `messageId` repeatedly, which
 * the AG-UI verifier rejects and the reference reducer collapses. This machine refuses that rather
 * than letting it reach a consumer.
 */
export class AguiBrackets {
  private run: string | undefined;
  private readonly text = new Set<string>();
  private readonly reasoning = new Set<string>();
  private readonly tools = new Set<string>();

  /**
   * The machine's whole state, as plain JSON — what the WAL persists so a restart does not lose it.
   *
   * Sorted, because this value is written to disk and compared BY A HUMAN reading two documents.
   * A `Set`'s iteration order is insertion order, so two machines that are semantically identical
   * would serialize differently depending on the order events happened to arrive, and a diff of two
   * WALs would show a change where there is none.
   */
  snapshot(): BracketState {
    return {
      run: this.run,
      text: [...this.text].sort(),
      reasoning: [...this.reasoning].sort(),
      tools: [...this.tools].sort(),
    };
  }

  /** Rebuild a machine from a snapshot. The inverse of {@link snapshot}, and the reason a mid-run
   *  restart can continue instead of refusing its first event. */
  static restore(s: BracketState): AguiBrackets {
    const b = new AguiBrackets();
    b.run = s.run;
    for (const id of s.text) b.text.add(id);
    for (const id of s.reasoning) b.reasoning.add(id);
    for (const id of s.tools) b.tools.add(id);
    return b;
  }

  /** An independent machine at the same state — used to VALIDATE a batch without advancing the
   *  machine that is in step with the disk. */
  clone(): AguiBrackets {
    return AguiBrackets.restore(this.snapshot());
  }

  /** True while a run is open — i.e. the stream is mid-turn and not at a legal stopping point. */
  get open(): boolean {
    return this.run !== undefined;
  }

  /** The run currently open, for diagnostics and for checking a frame's envelope against it. */
  get runId(): string | undefined {
    return this.run;
  }

  /** Feed one event. Throws {@link AguiVocabularyError} on the first violation. */
  accept(event: AguiEvent): void {
    const e = event as { type: string; [k: string]: unknown };
    const t = e.type;

    if (t === AGUI_EVENT_TYPE.RUN_STARTED) {
      if (this.run !== undefined)
        throw new AguiVocabularyError(
          `RUN_STARTED for "${String(e.runId)}" while run "${this.run}" is still open`,
        );
      this.run = String(e.runId);
      return;
    }

    if (this.run === undefined)
      throw new AguiVocabularyError(`${t} emitted outside an open run`);

    if (t === AGUI_EVENT_TYPE.RUN_FINISHED || t === AGUI_EVENT_TYPE.RUN_ERROR) {
      // RUN_ERROR carries no runId of its own (its schema has `message` and `code`), so only
      // RUN_FINISHED can be checked against the open run. Checking what exists rather than
      // pretending to check both.
      if (t === AGUI_EVENT_TYPE.RUN_FINISHED && String(e.runId) !== this.run)
        throw new AguiVocabularyError(
          `RUN_FINISHED for "${String(e.runId)}" but the open run is "${this.run}"`,
        );
      const dangling = [...this.text, ...this.reasoning, ...this.tools];
      if (dangling.length > 0)
        throw new AguiVocabularyError(
          `${t} while still open: ${dangling.join(", ")}`,
        );
      this.run = undefined;
      return;
    }

    switch (t) {
      case AGUI_EVENT_TYPE.TEXT_MESSAGE_START:
        return this.openId(this.text, String(e.messageId), t);
      case AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT:
        return this.requireOpen(this.text, String(e.messageId), t);
      case AGUI_EVENT_TYPE.TEXT_MESSAGE_END:
        return this.closeId(this.text, String(e.messageId), t);

      case AGUI_EVENT_TYPE.REASONING_MESSAGE_START:
        return this.openId(this.reasoning, String(e.messageId), t);
      case AGUI_EVENT_TYPE.REASONING_MESSAGE_CONTENT:
        return this.requireOpen(this.reasoning, String(e.messageId), t);
      case AGUI_EVENT_TYPE.REASONING_MESSAGE_END:
        return this.closeId(this.reasoning, String(e.messageId), t);

      case AGUI_EVENT_TYPE.TOOL_CALL_START:
        return this.openId(this.tools, String(e.toolCallId), t);
      case AGUI_EVENT_TYPE.TOOL_CALL_ARGS:
        return this.requireOpen(this.tools, String(e.toolCallId), t);
      case AGUI_EVENT_TYPE.TOOL_CALL_END:
        return this.closeId(this.tools, String(e.toolCallId), t);

      case AGUI_EVENT_TYPE.TOOL_CALL_RESULT:
        // A result arrives AFTER its call closed — the harness reports it as a separate
        // observation — so this asserts the call is NOT open rather than that it is.
        if (this.tools.has(String(e.toolCallId)))
          throw new AguiVocabularyError(
            `TOOL_CALL_RESULT for "${String(e.toolCallId)}" while its call is still open`,
          );
        return;

      case AGUI_EVENT_TYPE.CUSTOM:
        if (!COTAL_CUSTOM_EVENTS.includes(String(e.name)))
          throw new AguiVocabularyError(
            `CUSTOM "${String(e.name)}" is not declared in COTAL_CUSTOM_EVENTS (the v1 table is empty by specification)`,
          );
        return;

      default:
        throw new AguiVocabularyError(`${t} is not in the mapped subset this plane emits`);
    }
  }

  /**
   * Assert the stream is at a legal stopping point.
   *
   * Called at the end of a synthesized sequence and by any consumer checking a writer closed
   * cleanly. NOT called per frame: mid-turn frames are legally unbalanced.
   */
  assertClosed(): void {
    if (this.run !== undefined)
      throw new AguiVocabularyError(`run "${this.run}" was never closed`);
  }

  private openId(set: Set<string>, id: string, t: string): void {
    if (set.has(id)) throw new AguiVocabularyError(`${t} re-opened "${id}" while already open`);
    set.add(id);
  }

  private requireOpen(set: Set<string>, id: string, t: string): void {
    if (!set.has(id)) throw new AguiVocabularyError(`${t} for "${id}" which is not open`);
  }

  private closeId(set: Set<string>, id: string, t: string): void {
    if (!set.delete(id)) throw new AguiVocabularyError(`${t} for "${id}" which is not open`);
  }
}

/**
 * Build a frame, validating the envelope's own fields.
 *
 * Bracketing is NOT checked here — see {@link AguiBrackets} for why a single frame cannot be
 * required to balance. The emitter holds one `AguiBrackets` across the whole stream and feeds it as
 * it builds; that is the placement that checks the property actually claimed.
 */
export function aguiFrame(opts: {
  threadId: string;
  runId: string;
  epoch: string;
  seq: number;
  events: AguiEvent[];
}): AguiFrame {
  for (const [field, value] of [
    ["threadId", opts.threadId],
    ["runId", opts.runId],
    ["epoch", opts.epoch],
  ] as const)
    if (typeof value !== "string" || value.length === 0)
      throw new AguiVocabularyError(`frame ${field} must be a non-empty string`);

  if (!Number.isSafeInteger(opts.seq) || opts.seq < 0)
    throw new AguiVocabularyError(
      `frame seq must be a non-negative safe integer, got ${JSON.stringify(opts.seq)}`,
    );

  // An empty frame is refused rather than published as a no-op: a consumer counting `seq` would
  // see a gap-free stream carrying nothing, which is the silent-loss shape this plane exists to
  // make impossible.
  if (!Array.isArray(opts.events) || opts.events.length === 0)
    throw new AguiVocabularyError("a frame must carry at least one event");

  return {
    kind: AGUI_FRAME_KIND,
    protocol: AGUI_PROTOCOL,
    threadId: opts.threadId,
    runId: opts.runId,
    epoch: opts.epoch,
    seq: opts.seq,
    events: opts.events,
  };
}

/**
 * **THE CONSUMER-SIDE ENFORCEMENT POINT.** `aguiFrame` above validates on the way OUT; this pair
 * validates on the way IN, and they are separate functions because they are separate trust domains.
 *
 * It exists because the renderers cannot enforce a contract expressed as TypeScript types.
 * `implementations/web/tsconfig.json` carries `"include": ["src"]` with `"exclude": ["src/web"]`,
 * and the build copies `src/web` into `dist` verbatim — so the renderer is plain JavaScript that
 * `tsc` never reads. A prose contract with no enforcement point is the defect, so the contract ships
 * as **a function a consumer executes**, not as a shape a consumer is trusted to have read.
 *
 * **THE TWO ANSWERS ARE DIFFERENT AND MUST NOT BE FUSED.** "This part is not mine" is a routing
 * decision a consumer makes constantly and quietly — every non-frame part on a channel it also
 * reads. "This part claims to be mine and is malformed" is a defect that must be LOUD. One function
 * returning `null` for both would make a version skew look exactly like someone else's message, and
 * a renderer would show an empty pane for a stream it is actively failing to parse. So:
 * {@link isAguiFramePart} answers the routing question with a boolean and never throws, and
 * {@link parseAguiFrame} answers the validity question and throws with the field named.
 */
export function isAguiFramePart(part: unknown): boolean {
  return typeof part === "object" && part !== null && (part as { kind?: unknown }).kind === AGUI_FRAME_KIND;
}

/**
 * Validate an incoming frame, or throw {@link AguiVocabularyError} naming the field that failed.
 *
 * Call it only on a part {@link isAguiFramePart} accepted. Everything after that check is a defect
 * rather than a routing outcome, including an unknown `protocol` — **a version skew must fail loud
 * rather than render partially**, because a consumer that drops the fields it does not recognise
 * shows a confidently incomplete transcript, which is worse than showing nothing.
 *
 * It deliberately does NOT check bracketing. A frame is not guaranteed to be self-bracketed — an
 * oversized frame splits on event boundaries — so the unit that must balance is the writer's stream,
 * and {@link AguiBrackets} is the machine for that, fed frame after frame. A validator demanding a
 * frame balance on its own would forbid a split the plan mandates.
 */
export function parseAguiFrame(part: unknown): AguiFrame {
  if (!isAguiFramePart(part))
    throw new AguiVocabularyError(
      `not an AG-UI frame: expected kind ${JSON.stringify(AGUI_FRAME_KIND)}, got ` +
        `${JSON.stringify((part as { kind?: unknown } | null)?.kind ?? null)}. Route with ` +
        `isAguiFramePart before calling this.`,
    );
  const f = part as Record<string, unknown>;

  if (f.protocol !== AGUI_PROTOCOL)
    throw new AguiVocabularyError(
      `AG-UI protocol mismatch: this consumer understands ${JSON.stringify(AGUI_PROTOCOL)}, the ` +
        `frame declares ${JSON.stringify(f.protocol ?? null)}. Refusing rather than rendering the ` +
        `fields that happen to still parse.`,
    );

  for (const field of ["threadId", "runId", "epoch"] as const)
    if (typeof f[field] !== "string" || (f[field] as string).length === 0)
      throw new AguiVocabularyError(`frame ${field} must be a non-empty string`);

  if (!Number.isSafeInteger(f.seq) || (f.seq as number) < 0)
    throw new AguiVocabularyError(
      `frame seq must be a non-negative safe integer, got ${JSON.stringify(f.seq ?? null)}`,
    );

  if (!Array.isArray(f.events) || f.events.length === 0)
    throw new AguiVocabularyError("a frame must carry at least one event");

  const known = new Set<string>(Object.values(AGUI_EVENT_TYPE));
  f.events.forEach((e, i) => {
    if (typeof e !== "object" || e === null)
      throw new AguiVocabularyError(`frame events[${i}] is not an object`);
    const t = (e as { type?: unknown }).type;
    if (typeof t !== "string" || !known.has(t))
      throw new AguiVocabularyError(
        `frame events[${i}] carries an unrecognised type ${JSON.stringify(t ?? null)}. A renderer ` +
          `must refuse an event it cannot display rather than skip it: a skipped event is a hole ` +
          `in a transcript that still looks complete.`,
      );
  });

  return part as AguiFrame;
}

// ---------------------------------------------------------------------------------------------
// Sizing and splitting (plan §5.2).
//
// THIS DOES NOT MEASURE ANYTHING ITSELF, AND THAT IS THE WHOLE DESIGN. The bytes a frame puts on
// the wire are decided by the surface that builds the envelope and sets the headers: the endpoint
// adds `id`, `ts`, `space`, `from` and `channel` AFTER the publish call, and the JetStream client
// adds `Nats-Msg-Id` and `Nats-Expected-Last-Subject-Sequence`, all of which the broker charges
// against `max_payload`. A splitter that sized the frame from here would be measuring the FRAME
// while the broker measures the MESSAGE — and it would be wrong in the dangerous direction, because
// the part it produced would be REJECTED, and a rejected truncation makes the loss silent again,
// which is the exact failure splitting exists to prevent. Measured against a 4096-byte broker, a
// 3994-byte payload was refused while naive arithmetic said it fit by a hundred bytes.
//
// So `measure` is injected. In production it is `CotalEndpoint.encodedSize` bound to the real
// channel and expectation; in a cell it is any function, which is what makes the algorithm testable
// without a broker. Two places that both compute size WILL drift, and the drift is invisible until
// a frame near the ceiling meets a real broker — the one case no unit test builds.
// ---------------------------------------------------------------------------------------------

/**
 * The fields a too-large event may be truncated on — NAMED, never inferred (plan §5.2).
 *
 * Inferring "the biggest string on the object" would eventually truncate an id, a role or a tool
 * name, and produce a frame that fits and means something else. The plan names three, so three is
 * what this table holds; an event carrying none of them cannot be truncated and says so.
 */
const TRUNCATABLE_FIELDS: ReadonlyArray<{ readonly type: string; readonly field: string }> = [
  { type: AGUI_EVENT_TYPE.TOOL_CALL_ARGS, field: "delta" },
  { type: AGUI_EVENT_TYPE.TOOL_CALL_RESULT, field: "content" },
  { type: AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT, field: "delta" },
];

/** Truncate to `codePoints` code points, never code UNITS. Slicing a JS string by index can cut a
 *  surrogate pair in half and produce a lone surrogate, which is not well-formed UTF-16 — the exact
 *  defect `fix(core)!: refuse names that are not well-formed UTF-16` landed on this branch for. A
 *  splitter that reintroduced it here would emit a frame the wire layer is now obliged to refuse. */
const takeCodePoints = (s: string, codePoints: number): string =>
  Array.from(s).slice(0, codePoints).join("");

/**
 * Split `events` into as many frames as the wire requires, truncating only what physically cannot
 * cross it, and LABELLING every truncation.
 *
 * **THIS IS THE PREVIEW PLANE'S SPLITTER (§5.8), AND IT HAS NO DURABLE-PLANE CALLER BY DESIGN.**
 * Read that as a boundary, not as an oversight: the durable emitter packs with {@link packUnits} at
 * SOURCE-RECORD boundaries and refuses an oversized unit, because `[P8]` requires every frame to
 * carry a cursor that resumes after it and a frame ending mid-record has no cursor it can honestly
 * store. §5.2 specified this event-boundary split and its labelled truncation before the durable
 * plane had a cursor contract; where the two now disagree, `[P8]` governs the durable plane. The
 * PREVIEW plane has no resume obligation at all, which is exactly where truncate-and-label is the
 * right answer and why this machinery is worth keeping.
 *
 * **Calling this from the durable emitter would be a silent-loss bug**, not a performance choice —
 * so if you are here looking for the packer, you want `packUnits`. And it is marked rather than
 * deleted for the reason one module over already demonstrated: `assertExpectationSemantics()` sat
 * with zero production callers looking exactly like live code, and unreachable code that looks live
 * is a hazard whichever direction the next reader resolves it in.
 *
 * **Say the uncomfortable thing** (plan §5.2): this is a content truncation, which is one of the
 * sins `tr-` is being abolished for. The difference is not that we are gentler about it. `tr-` cut
 * *every* result at 700 characters, silently and unconditionally, as a design choice; this cuts only
 * what cannot physically be sent, three orders of magnitude higher, and records what it cut and how
 * big it was. If routine results start tripping the ceiling the honest response is a
 * content-addressed side channel, not a quieter limit.
 *
 * **Splitting happens on EVENT boundaries**, each part carrying its own `seq`, so a run may legally
 * open in one frame and close in the next. That is why {@link AguiBrackets} checks the writer's
 * stream and not the frame — a per-frame balance check would forbid the split this function
 * performs.
 *
 * **`seq` is measured, not assumed.** Each candidate is measured at the `seq` it will actually carry,
 * because `seq` is a header-adjacent value in the encoded body: sizing at 9 and publishing at 10 is
 * one byte, and a frame one byte over the ceiling is refused. The same reason `encodedSize` takes
 * `expectedLastSubjectSeq` as a parameter rather than sizing at zero.
 *
 * @param measure the EXACT encoded size of a candidate, headers included — `CotalEndpoint.encodedSize`
 *   in production. Never re-implement it here.
 * @param limit the broker's `max_payload`.
 * @throws {AguiVocabularyError} if a single event cannot be made to fit even fully truncated, or
 *   carries no truncatable field. Failing loud is required: the alternative is looping forever or
 *   dropping the event, and a dropped event on this plane is the silent loss the plane exists to
 *   make impossible.
 */
export function splitFrames(opts: {
  threadId: string;
  runId: string;
  epoch: string;
  /** The `seq` the FIRST emitted frame carries; each subsequent part takes the next. */
  firstSeq: number;
  events: AguiEvent[];
  measure: (frame: AguiFrame) => number;
  limit: number;
}): AguiFrame[] {
  if (!Number.isSafeInteger(opts.limit) || opts.limit <= 0)
    throw new AguiVocabularyError(
      `split limit must be a positive safe integer, got ${JSON.stringify(opts.limit)}`,
    );
  if (!Array.isArray(opts.events) || opts.events.length === 0)
    throw new AguiVocabularyError("splitFrames requires at least one event");

  const { threadId, runId, epoch, measure, limit } = opts;
  const build = (seq: number, events: AguiEvent[]): AguiFrame =>
    aguiFrame({ threadId, runId, epoch, seq, events });
  const fits = (seq: number, events: AguiEvent[]): boolean => measure(build(seq, events)) <= limit;

  const out: AguiFrame[] = [];
  let seq = opts.firstSeq;
  let batch: AguiEvent[] = [];

  const flush = (): void => {
    if (batch.length === 0) return;
    out.push(build(seq, batch));
    seq += 1;
    batch = [];
  };

  for (const event of opts.events) {
    if (fits(seq, [...batch, event])) {
      batch.push(event);
      continue;
    }
    // It did not fit alongside what is already batched. Close the batch and reconsider the event
    // ALONE — an event that is merely unlucky in its neighbours needs no truncation at all, and
    // truncating it here would cut content that would have crossed the wire intact.
    flush();
    if (fits(seq, [event])) {
      batch.push(event);
      continue;
    }
    batch.push(truncateToFit(event, seq, fits, limit, measure, build));
  }
  flush();
  return out;
}

/**
 * Shrink one event's single largest truncatable string until the frame carrying it alone fits.
 *
 * **Iterate to fit, never one pass** (plan §5.2). Shortening a string changes its JSON escaping and
 * its UTF-8 length NONLINEARLY — one multi-byte character or one escaped quote is several bytes, so
 * "cut it to the overage" both overshoots and undershoots depending on content. This binary-searches
 * the code-point length and re-measures the WHOLE candidate each step, envelope and headers
 * included, so the answer is measured rather than computed.
 *
 * The shortened value carries no ellipsis or marker. The label is `cotal.truncated`, which records
 * the field path AND the original byte count — a marker inside the value would spend wire budget to
 * say less, and a consumer parsing the field as JSON (`TOOL_CALL_ARGS.delta` is a JSON fragment)
 * would have to strip it.
 */
function truncateToFit(
  event: AguiEvent,
  seq: number,
  fits: (seq: number, events: AguiEvent[]) => boolean,
  limit: number,
  measure: (frame: AguiFrame) => number,
  build: (seq: number, events: AguiEvent[]) => AguiFrame,
): AguiEvent {
  const record = event as unknown as Record<string, unknown>;
  const spec = TRUNCATABLE_FIELDS.find(
    (t) => t.type === record.type && typeof record[t.field] === "string",
  );
  if (!spec)
    throw new AguiVocabularyError(
      `a ${String(record.type)} event does not fit in ${limit} bytes and carries no truncatable ` +
        `field. Measured ${measure(build(seq, [event]))} bytes for the frame carrying it alone. ` +
        `Only ${TRUNCATABLE_FIELDS.map((t) => `${t.type}.${t.field}`).join(", ")} may be cut, ` +
        `because cutting anything else would produce a frame that fits and means something else.`,
    );

  const original = record[spec.field] as string;
  const originalBytes = Buffer.byteLength(original, "utf8");
  const at = (codePoints: number): AguiEvent =>
    ({
      ...record,
      [spec.field]: takeCodePoints(original, codePoints),
      cotal: {
        ...((record.cotal as CotalMeta | undefined) ?? {}),
        truncated: { field: `${String(record.type)}.${spec.field}`, originalBytes },
      },
    }) as unknown as AguiEvent;

  // Even emptied it must fit, or no truncation can help and looping would be the alternative. This
  // is also the plan's "fixed envelope and headers alone exceed the ceiling" case, detected by
  // measurement rather than by a second arithmetic path that could disagree with the first.
  if (!fits(seq, [at(0)]))
    throw new AguiVocabularyError(
      `a ${String(record.type)} event does not fit in ${limit} bytes even with ${spec.field} ` +
        `emptied — the envelope, the labelling metadata and the headers alone are ` +
        `${measure(build(seq, [at(0)]))} bytes. No truncation can help, so this fails loudly ` +
        `rather than dropping the event or looping.`,
    );

  // Binary search the largest code-point count that still fits. `lo` always fits, `hi` never does.
  let lo = 0;
  let hi = Array.from(original).length + 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(seq, [at(mid)])) lo = mid;
    else hi = mid;
  }
  return at(lo);
}

// ---------------------------------------------------------------------------------------------
// Constructors.
//
// One per mapped event. They exist so a connector never hand-builds an object literal with a
// `type` string in it — the drift that produces is invisible until a consumer rejects a frame,
// which on this plane means after it is durably published.
//
// `timestamp` is deliberately a REQUIRED parameter on every constructor rather than defaulted to
// `Date.now()`. The plan's rule is that a timestamp is real or honestly labelled, and a default
// would silently manufacture an arrival time that looks like a source time. A caller with no
// source timestamp passes the arrival time AND sets `cotal.tsSource: "arrival"`.
// ---------------------------------------------------------------------------------------------

/** `RUN_STARTED` — `threadId` is the native session, `runId` one native harness turn. */
export function runStarted(o: {
  threadId: string;
  runId: string;
  timestamp: number;
  cotal?: CotalMeta;
}): WithCotal<RunStartedEvent> {
  return {
    type: AGUI_EVENT_TYPE.RUN_STARTED,
    threadId: o.threadId,
    runId: o.runId,
    timestamp: o.timestamp,
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<RunStartedEvent>;
}

/**
 * `RUN_FINISHED`.
 *
 * `outcome` is OPTIONAL — measured against the real schema, which accepts a `RUN_FINISHED` carrying
 * none. That matters because the Claude `Stop` hook reports that a turn ended and nothing more, so
 * manufacturing a `success` outcome would be asserting something the source never said. When an
 * outcome IS supplied its discriminator key is `type`, not `status` (measured: the schema refuses
 * `{status:"success"}` naming `outcome.type`), and the object is STRICT.
 */
export function runFinished(o: {
  threadId: string;
  runId: string;
  timestamp: number;
  outcome?: { type: "success" } | { type: "interrupt"; interrupts: unknown[] };
  cotal?: CotalMeta;
}): WithCotal<RunFinishedEvent> {
  return {
    type: AGUI_EVENT_TYPE.RUN_FINISHED,
    threadId: o.threadId,
    runId: o.runId,
    timestamp: o.timestamp,
    ...(o.outcome ? { outcome: o.outcome } : {}),
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<RunFinishedEvent>;
}

/** `RUN_ERROR` — carries `message` and an optional `code`, and NO `runId` of its own. */
export function runError(o: {
  message: string;
  timestamp: number;
  code?: string;
  cotal?: CotalMeta;
}): WithCotal<RunErrorEvent> {
  return {
    type: AGUI_EVENT_TYPE.RUN_ERROR,
    message: o.message,
    timestamp: o.timestamp,
    ...(o.code ? { code: o.code } : {}),
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<RunErrorEvent>;
}

/**
 * `TEXT_MESSAGE_START`.
 *
 * `messageId` must be unique per OBSERVATION, not per provider message. The specified form is
 * `${entry.uuid}#${blockIndex}` — the provider's own id is preserved as `cotal.providerMessageId`
 * and never spent here, because it does not have the cardinality the field needs.
 */
export function textMessageStart(o: {
  messageId: string;
  timestamp: number;
  role?: "assistant" | "user";
  cotal?: CotalMeta;
}): WithCotal<TextMessageStartEvent> {
  return {
    type: AGUI_EVENT_TYPE.TEXT_MESSAGE_START,
    messageId: o.messageId,
    timestamp: o.timestamp,
    ...(o.role ? { role: o.role } : {}),
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<TextMessageStartEvent>;
}

/** `TEXT_MESSAGE_CONTENT` — one settled observation, never a token-level delta. */
export function textMessageContent(o: {
  messageId: string;
  delta: string;
  timestamp: number;
  cotal?: CotalMeta;
}): WithCotal<TextMessageContentEvent> {
  return {
    type: AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT,
    messageId: o.messageId,
    delta: o.delta,
    timestamp: o.timestamp,
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<TextMessageContentEvent>;
}

/** `TEXT_MESSAGE_END`. */
export function textMessageEnd(o: {
  messageId: string;
  timestamp: number;
  cotal?: CotalMeta;
}): WithCotal<TextMessageEndEvent> {
  return {
    type: AGUI_EVENT_TYPE.TEXT_MESSAGE_END,
    messageId: o.messageId,
    timestamp: o.timestamp,
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<TextMessageEndEvent>;
}

/** `TOOL_CALL_START` — `toolCallId` is the harness's own id, carried rather than re-minted. */
export function toolCallStart(o: {
  toolCallId: string;
  toolCallName: string;
  timestamp: number;
  parentMessageId?: string;
  cotal?: CotalMeta;
}): WithCotal<ToolCallStartEvent> {
  return {
    type: AGUI_EVENT_TYPE.TOOL_CALL_START,
    toolCallId: o.toolCallId,
    toolCallName: o.toolCallName,
    timestamp: o.timestamp,
    ...(o.parentMessageId ? { parentMessageId: o.parentMessageId } : {}),
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<ToolCallStartEvent>;
}

/**
 * `TOOL_CALL_ARGS` — `delta` is the FULL `JSON.stringify(input)`.
 *
 * This is where `tr-`'s `salient()` died: it guessed which argument mattered and dropped the rest,
 * so a reader could not reconstruct what the agent actually did. The whole input goes on the wire,
 * and if it physically cannot fit, the sizing path truncates it with a label rather than silently.
 */
export function toolCallArgs(o: {
  toolCallId: string;
  delta: string;
  timestamp: number;
  cotal?: CotalMeta;
}): WithCotal<ToolCallArgsEvent> {
  return {
    type: AGUI_EVENT_TYPE.TOOL_CALL_ARGS,
    toolCallId: o.toolCallId,
    delta: o.delta,
    timestamp: o.timestamp,
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<ToolCallArgsEvent>;
}

/** `TOOL_CALL_END`. */
export function toolCallEnd(o: {
  toolCallId: string;
  timestamp: number;
  cotal?: CotalMeta;
}): WithCotal<ToolCallEndEvent> {
  return {
    type: AGUI_EVENT_TYPE.TOOL_CALL_END,
    toolCallId: o.toolCallId,
    timestamp: o.timestamp,
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<ToolCallEndEvent>;
}

/**
 * `TOOL_CALL_RESULT`.
 *
 * **`messageId` is REQUIRED by the real schema** — measured; a result without one is refused. The
 * plan's per-connector mapping table names only `toolCallId` for this row, so the identity of the
 * result MESSAGE is unstated there and is raised as a plan gap rather than guessed at a call site.
 * The parameter is required here so a mapper cannot omit it and discover the refusal downstream.
 *
 * `is_error` has no AG-UI field and rides `cotal.isError`.
 */
export function toolCallResult(o: {
  messageId: string;
  toolCallId: string;
  content: string;
  timestamp: number;
  cotal?: CotalMeta;
}): WithCotal<ToolCallResultEvent> {
  return {
    type: AGUI_EVENT_TYPE.TOOL_CALL_RESULT,
    messageId: o.messageId,
    toolCallId: o.toolCallId,
    content: o.content,
    timestamp: o.timestamp,
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<ToolCallResultEvent>;
}

/**
 * `REASONING_MESSAGE_START` — off by default; the signature is never emitted, ever.
 *
 * **`role` is a REQUIRED literal `"reasoning"`**, unlike `TEXT_MESSAGE_START` where `role` is
 * optional. Measured: the first version of this constructor omitted it and the real schema refused
 * the event. It is set here rather than exposed as a parameter, because there is exactly one legal
 * value and a caller-supplied one could only ever be wrong.
 */
export function reasoningMessageStart(o: {
  messageId: string;
  timestamp: number;
  cotal?: CotalMeta;
}): WithCotal<ReasoningMessageStartEvent> {
  return {
    type: AGUI_EVENT_TYPE.REASONING_MESSAGE_START,
    messageId: o.messageId,
    role: "reasoning",
    timestamp: o.timestamp,
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<ReasoningMessageStartEvent>;
}

/** `REASONING_MESSAGE_CONTENT`. */
export function reasoningMessageContent(o: {
  messageId: string;
  delta: string;
  timestamp: number;
  cotal?: CotalMeta;
}): WithCotal<ReasoningMessageContentEvent> {
  return {
    type: AGUI_EVENT_TYPE.REASONING_MESSAGE_CONTENT,
    messageId: o.messageId,
    delta: o.delta,
    timestamp: o.timestamp,
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<ReasoningMessageContentEvent>;
}

/** `REASONING_MESSAGE_END`. */
export function reasoningMessageEnd(o: {
  messageId: string;
  timestamp: number;
  cotal?: CotalMeta;
}): WithCotal<ReasoningMessageEndEvent> {
  return {
    type: AGUI_EVENT_TYPE.REASONING_MESSAGE_END,
    messageId: o.messageId,
    timestamp: o.timestamp,
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<ReasoningMessageEndEvent>;
}

// ---------------------------------------------------------------------------------------------
// THE EMITTER (plan §5.4 for the state machine, §5.6 for this file, build-order step 2a for the
// startup preflight).
//
// Everything above this line is a pure function of its arguments. Everything below it is the one
// thing that TALKS: it reads a durable source forward from the WAL's cursor, maps records to
// events, packs them into frames that provably fit, and appends them to the principal's event
// channel under an optimistic-concurrency expectation with a frozen dedup id.
//
// The emitter owns no policy about WHAT an event means — that is §3's per-connector mapping, and it
// arrives here as an injected function. What it owns is the property none of the pieces can hold
// alone: that a frame is either on the wire and folded into the frontier, or not on the wire and
// not folded, and that no third state is ever reported as success.

/**
 * The endpoint surface the emitter needs, declared STRUCTURALLY rather than as `CotalEndpoint`.
 *
 * Not for testability as an end in itself — for a specific one. A cell that needs a live broker to
 * exercise the duplicate-ack halt cannot be written at all before a broker exists, and a cell that
 * re-implements `encodedSize` is measuring a copy. This interface is the exact set of methods the
 * emitter calls, so a cell substitutes an instrument and the production path substitutes the real
 * endpoint, and neither one is a re-implementation of the other.
 */
export interface EmitterEndpoint {
  readonly principal: { owner: string; actor: string };
  readonly actorIsEphemeral: boolean;
  /** The broker's live `max_payload`. Throws when not connected — never guesses a default. */
  readonly maxPayload: number;
  /** `[P5]`'s R1 preflight. The emitter calls this at startup, before anything can publish. */
  assertExpectationSemantics(): Promise<void>;
  encodedSize(o: { channel: string; parts: Part[]; id: string; expectedLastSubjectSeq: number }): number;
  multicastExpecting(o: {
    channel: string;
    parts: Part[];
    id: string;
    expectedLastSubjectSeq: number;
  }): Promise<{ ack: { seq: number; duplicate: boolean } }>;
}

/**
 * One source record's worth of events, with the cursor that resumes AFTER that record.
 *
 * `[P8]`: the emitter splits only at source-observation boundaries that are independently
 * reconstructable from the durable source. A frame therefore ends where a record ends, and carries
 * that record's cursor — so folding it means exactly "every record in this frame is consumed".
 */
export interface EmitUnit {
  /** The run these events belong to. A frame's envelope names ONE run (§4), so units are never
   *  mixed across runs in one frame. */
  runId: string;
  events: AguiEvent[];
  cursor: string;
}

/** What the mapper returns for one source record: its run and its events, or `null` for a record
 *  this plane deliberately drops (§3 drops many). `null` is NOT an error — `[P7]` keeps the two
 *  apart, and conflating them turns a parser bug into silently skipped history. */
export type RecordMapper<T> = (record: T) => { runId: string; events: AguiEvent[] } | null;

/**
 * The emitter has stopped and will not publish again without operator action.
 *
 * Halting is a SUCCESS of this design, not a failure of it: every halt below is a case where the
 * alternative is to report success for a message that was not stored, or to fold an ack for a body
 * we did not write. A halt is loud, bounded and recoverable by a human; the alternative is silent
 * and permanent.
 */
/**
 * A bracket violation that is OURS, not the writer's: the machine that tracks open runs and messages
 * was lost across a process restart.
 *
 * **This exists because two halts that both say "unbalanced" prove nothing about which produced
 * one.** The WAL persists `epoch`, `frontier` and the pending frame (§5.4) and NOT the set of open
 * runs and messages, so a process that dies mid-run restarts with an empty {@link AguiBrackets},
 * resumes from `sourceCursor` at events whose `RUN_STARTED` was already published, and refuses the
 * first of them. Without this class the operator sees "nothing may be emitted outside an open run"
 * and files a bug against a writer that did nothing wrong.
 *
 * It is deliberately a SUBCLASS: every existing catch of {@link AguiVocabularyError} still catches
 * it, and only code that wants to tell the two apart has to know it exists.
 */
export class AguiBracketStateLost extends AguiVocabularyError {
  constructor(message: string, readonly cause: Error) {
    super(message);
    this.name = "AguiBracketStateLost";
  }
}

export class AguiEmitterHalted extends Error {
  constructor(
    readonly reason: "duplicate-ack" | "cas-loss",
    message: string,
  ) {
    super(message);
    this.name = "AguiEmitterHalted";
  }
}

/**
 * The id used only for SIZING, and it is the longest one `assertIdToken` admits.
 *
 * Sizing must never report a smaller number than publishing will produce, and the id is not known
 * when a frame is measured — it is minted per publish attempt. Measuring at the maximum admissible
 * length makes the measurement an UPPER BOUND over every id the emitter could mint, which costs a
 * few bytes of packing density and removes an entire class of near-ceiling defect. The alternative,
 * measuring with the id we intend to use, requires minting before packing and freezing an id for a
 * frame that may never be built.
 */
const SIZING_ID = "S".repeat(64);

/**
 * Likewise for the expectation, and this one CANNOT be known at pack time even in principle.
 *
 * `expectedLastSubjectSeq` for frame k+1 is the sequence the broker assigns frame k, and the stream
 * sequence advances with every message in the space, not only ours. Its decimal length is therefore
 * unknowable while packing. `MAX_SAFE_INTEGER` is the widest value the publish path will accept, so
 * measuring at it bounds every expectation the emitter can ever send.
 */
const SIZING_EXPECTATION = Number.MAX_SAFE_INTEGER;

/**
 * Pack units into frames, splitting ONLY at unit boundaries and never inside one.
 *
 * Deliberately NOT {@link splitFrames}, and the difference is `[P8]`. `splitFrames` splits at EVENT
 * boundaries, which is what §5.2 specifies for a frame considered on its own — but a frame that
 * ends mid-record has no cursor it can honestly store: the only value available says the whole
 * record was consumed, and folding that after a crash skips the rest of the record's events with no
 * `seq` gap for a consumer to notice.
 *
 * **So §5.2's event-boundary split and `[P8]`'s unit rule are in tension, and this resolves it in
 * the direction `[P8]` states explicitly: a single unit that does not fit FAILS LOUD rather than
 * being truncated at a frame boundary.** That leaves `splitFrames`'s truncation path with no caller
 * on the durable plane, which is reported as a plan conflict rather than silently decided here.
 *
 * @throws {AguiVocabularyError} when one unit cannot fit in a frame alone.
 */
export function packUnits(opts: {
  threadId: string;
  epoch: string;
  firstSeq: number;
  units: readonly EmitUnit[];
  measure: (frame: AguiFrame) => number;
  limit: number;
}): { frame: AguiFrame; cursor: string }[] {
  const { threadId, epoch, measure, limit } = opts;
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new AguiVocabularyError(`pack limit must be a positive safe integer, got ${JSON.stringify(limit)}`);

  const out: { frame: AguiFrame; cursor: string }[] = [];
  let seq = opts.firstSeq;
  let batch: AguiEvent[] = [];
  let batchRun: string | undefined;
  let batchCursor: string | undefined;

  const flush = (): void => {
    if (batch.length === 0) return;
    out.push({ frame: aguiFrame({ threadId, runId: batchRun as string, epoch, seq, events: batch }), cursor: batchCursor as string });
    seq += 1;
    batch = [];
    batchRun = undefined;
    batchCursor = undefined;
  };

  for (const unit of opts.units) {
    if (unit.events.length === 0)
      throw new AguiVocabularyError("packUnits was handed an empty unit; a record that maps to nothing advances the cursor and never becomes a frame");

    // A frame names ONE run. A unit from a different run cannot join the open batch even if it
    // would fit, so the run change is a flush and not a size decision.
    if (batchRun !== undefined && unit.runId !== batchRun) flush();

    const candidate = [...batch, ...unit.events];
    const fits =
      measure(aguiFrame({ threadId, runId: batchRun ?? unit.runId, epoch, seq, events: candidate })) <= limit;
    if (fits) {
      batch = candidate;
      batchRun = batchRun ?? unit.runId;
      batchCursor = unit.cursor;
      continue;
    }

    // It did not fit WITH the open batch. Flush and try it alone before concluding anything about
    // the unit itself: an ordinary unit that happens to arrive behind a nearly-full frame is not an
    // oversized unit, and treating it as one would halt the emitter on a packing accident.
    flush();
    const alone = aguiFrame({ threadId, runId: unit.runId, epoch, seq, events: unit.events });
    const aloneBytes = measure(alone);
    if (aloneBytes > limit)
      throw new AguiVocabularyError(
        `a single source observation does not fit in one frame (${aloneBytes} > ${limit} bytes, ` +
          `${unit.events.length} event(s), run ${unit.runId}). [P8] requires this to fail loud rather ` +
          `than be truncated at a frame boundary: a frame that ends mid-record has no cursor it can ` +
          `honestly store, and a dropped boundary with no gap marker is worse than a halt.`,
      );
    batch = [...unit.events];
    batchRun = unit.runId;
    batchCursor = unit.cursor;
  }
  flush();
  return out;
}

/**
 * The event emitter: one per principal, one thread at a time (§5.5).
 *
 * **A KNOWN GAP, DECLARED RATHER THAN PAPERED OVER: bracket state does not survive a restart.**
 * It now DIAGNOSES ITSELF ({@link AguiBracketStateLost}) instead of surfacing as an anonymous
 * protocol violation, which is the interim ruled for this wave; PERSISTING the machine is a plan
 * amendment against §5.4 targeted at the wave that ships a connector, and it must not slip past it.
 * Today this is unreachable in production because nothing emits; the moment a connector cuts over,
 * a mid-run crash is an ordinary Tuesday.
 * {@link AguiBrackets} checks a property of the WRITER'S STREAM across frames, and the WAL persists
 * `epoch`, `frontier` and the pending frame — not the open runs and messages. So a process that
 * crashes mid-run restarts with an empty bracket machine, resumes from `sourceCursor` at events
 * whose `RUN_STARTED` was already published, and the first of them is REFUSED. That is a halt, not
 * a loss, which is the safe direction — but it is a real production behaviour and not a hypothetical,
 * and §5.4 specifies recovery of the durable state without saying anything about this one. Reported
 * as a plan defect; not decided here.
 */
export class AguiEmitter<T> {
  /**
   * The bracket machine AT THE FOLDED POSITION — deliberately not "wherever validation got to".
   *
   * It advances one frame at a time, immediately before that frame's `beginSend`, so the state
   * frozen with a pending frame is the state that belongs to it. A machine advanced by the whole
   * batch up front would freeze a state describing events that had not been sent.
   */
  private brackets: AguiBrackets;
  private halted: AguiEmitterHalted | undefined;
  /** True once THIS process has fed an event through the bracket machine. It is the half of the
   *  restart diagnosis that keeps a genuine mid-stream violation from being blamed on a restart. */
  private fedAnyEvent = false;

  private constructor(
    private readonly ep: EmitterEndpoint,
    private readonly wal: EventWal,
    private readonly source: DurableSource<T>,
    private readonly map: RecordMapper<T>,
    /** Derived from the endpoint's OWN principal, never from a config name or the launch env. */
    readonly channel: string,
    readonly threadId: string,
  ) {
    // RESTORED FROM THE WAL, which is the whole point of the v2 migration: a process that died
    // mid-run comes back knowing which runs and messages are open, instead of refusing the first
    // event it re-reads. `null` means the document cannot say (migrated from v1) — an empty machine
    // is the honest starting point there, and `diagnoseBracket` is what keeps the resulting refusal
    // from being blamed on the writer.
    this.brackets = wal.brackets ? AguiBrackets.restore(wal.brackets) : new AguiBrackets();
  }

  /**
   * Start an emitter: resolve the channel, run the `[P5]` preflight, and settle any pending frame.
   *
   * **THIS IS BUILD-ORDER STEP 2a's PRODUCTION CALL SITE, AND UNTIL THIS FUNCTION EXISTED THERE WAS
   * NONE.** `CotalEndpoint.assertExpectationSemantics()` had zero production callers: it was a
   * check that shipped, was covered by its own suite, and never ran outside one. That is why it is
   * called HERE, before recovery and therefore before any publish — a serialized append on an
   * unverified stream is the exact case it exists to prevent, and doing it after recovery would
   * leave the one publish that matters most, the re-publish of a frozen frame, outside the guard.
   */
  static async start<T>(opts: {
    endpoint: EmitterEndpoint;
    /** Already open, so the caller owns `space`, the WAL path, and the `subjectMayExist` judgement
     *  — none of which the emitter can make honestly on the caller's behalf. */
    wal: EventWal;
    source: DurableSource<T>;
    map: RecordMapper<T>;
  }): Promise<AguiEmitter<T>> {
    const { endpoint, wal } = opts;
    const channel = eventChannelForSession(endpoint);

    // The WAL must be THIS principal's. `EventWal.open` refuses a document whose stored principal
    // disagrees with what it was asked for, but that protects the file against being mistaken for
    // another; it cannot notice an emitter handed the wrong WAL object. Publishing under one
    // principal's identity while recovering another's frozen `E` is a fabricated frontier.
    const live = principalKey(endpoint.principal.owner, endpoint.principal.actor).key;
    if (wal.principal !== live)
      throw new Error(
        `event WAL belongs to principal ${wal.principal}, but this endpoint is ${live} — refusing to ` +
          `publish under one identity from another's write-ahead log`,
      );

    // `[P5]` R1 PREFLIGHT — before recovery, before any publish.
    await endpoint.assertExpectationSemantics();

    const em = new AguiEmitter<T>(endpoint, wal, opts.source, opts.map, channel, wal.threadId);
    await em.recover();
    return em;
  }

  /** True once the emitter has stopped for good. */
  get stopped(): boolean {
    return this.halted !== undefined;
  }

  /**
   * Boot recovery, branching on the WAL's tag (§5.4).
   *
   * `acked` NEVER republishes: the frame landed and we know it, so the only remaining work is to
   * fold. `sent_unacked` is the genuinely uncertain case and republishes with the SAME frozen `id`
   * and `E` — never the current tip, because re-deriving either is what turns an uncertain publish
   * into a second, different message.
   */
  private async recover(): Promise<void> {
    const p = this.wal.pending;
    if (!p) return;
    if (p.state === "acked") {
      await this.wal.fold();
      return;
    }
    await this.attempt({ id: p.id, E: p.E, body: p.body, retry: true });
  }

  /**
   * Read forward, map, pack, and publish. Returns what it did, so a caller can distinguish "nothing
   * to do" from "did work" without inspecting the WAL.
   */
  async pump(): Promise<{ frames: number; events: number }> {
    if (this.halted) throw this.halted;
    if (this.wal.pending)
      throw new Error(
        `event emitter for ${this.channel}: a frame is still pending; recovery must settle it before a new read`,
      );

    const read = await this.source.read(this.wal.frontier.sourceCursor);

    // Units the mapper dropped are not errors and not frames. Their cursor folds FORWARD into the
    // preceding unit, so consuming that frame consumes them too and they are never re-read. `[P7]`
    // keeps this apart from a mapper error, which reaches the caller with the cursor unmoved.
    const units: EmitUnit[] = [];
    for (const rec of read.records) {
      const mapped = this.map(rec.value);
      if (mapped === null || mapped.events.length === 0) {
        const last = units[units.length - 1];
        if (last) last.cursor = rec.cursor;
        continue;
      }
      units.push({ runId: mapped.runId, events: mapped.events, cursor: rec.cursor });
    }

    // `[P7]` — a bounded range that mapped to nothing advances the cursor atomically and ALONE.
    //
    // THIS IS THE COMMON PATH, NOT AN EDGE CASE, and the number is here so nobody reads it as one.
    // Measured on a real Claude session of 5938 records: only 2694 (45%) carry a `message` at all —
    // the rest are attachments, queue operations, mode changes, prompt markers and system entries
    // that §3 deliberately drops. So the MAJORITY of a real session maps to nothing. An emitter that
    // advanced the cursor only through an acked frame would re-read the same 55% forever, and no
    // fixture would ever show it, because a fixture author writes records that mean something.
    //
    // It must also advance on an ADOPT, which reads zero records by design: without that the position
    // is never persisted and the next read adopts a LATER end, silently skipping everything appended
    // in between.
    if (units.length === 0) {
      if (read.cursor !== this.wal.frontier.sourceCursor) await this.wal.advanceCursorOnly(read.cursor);
      return { frames: 0, events: 0 };
    }

    // Validate the WHOLE batch before publishing any of it. A vocabulary violation discovered
    // halfway through would leave a valid prefix on the wire and the rest refused, and the refusal
    // is supposed to mean "this stream never carried that", not "it carried some of it".
    // Validated on a CLONE, so the machine that is in step with the disk does not advance for a
    // batch that may never be sent. The clone starts from the folded state, so it sees exactly what
    // the real machine will see, in the same order.
    const probe = this.brackets.clone();
    for (const u of units)
      for (const e of u.events) {
        try {
          probe.accept(e);
        } catch (err) {
          throw this.diagnoseBracket(err as Error);
        }
      }
    // Set only after the WHOLE batch validated. Setting it per event would make a batch that failed
    // on its FIRST event count as "this process has fed something", which is the precise input that
    // turns the restart diagnosis off.
    this.fedAnyEvent = true;

    const frames = packUnits({
      threadId: this.threadId,
      epoch: this.wal.epoch,
      firstSeq: this.wal.frontier.seq + 1,
      units,
      measure: (f) => this.measure(f),
      limit: this.ep.maxPayload,
    });

    let events = 0;
    for (const { frame, cursor } of frames) {
      await this.publish(frame, cursor);
      events += frame.events.length;
    }

    // Records the mapper dropped AFTER the last unit have no frame to ride on, so their cursor is
    // advanced on its own — the same `[P7]` rule, applied to the tail of the batch.
    if (read.cursor !== this.wal.frontier.sourceCursor) await this.wal.advanceCursorOnly(read.cursor);

    return { frames: frames.length, events };
  }

  /** Measure a candidate frame EXACTLY as the wire will, at an upper bound over id and expectation. */
  private measure(frame: AguiFrame): number {
    return this.ep.encodedSize({
      channel: this.channel,
      parts: [frame as unknown as Part],
      id: SIZING_ID,
      expectedLastSubjectSeq: SIZING_EXPECTATION,
    });
  }

  /** Transition 1 then the first network attempt. */
  private async publish(frame: AguiFrame, cursor: string): Promise<void> {
    // Advance the real machine by exactly this frame. It cannot throw: the identical sequence was
    // already accepted by a clone starting from this same state, in this same order. It is not
    // wrapped in a diagnosis for that reason — a throw here would be a bug in this file, not a
    // stream problem, and dressing it as one would hide it.
    for (const e of frame.events) this.brackets.accept(e);
    const brackets = this.brackets.snapshot();
    const id = randomUUID();
    const E = this.wal.frontier.lastSubjectSeq;
    const body: Part[] = [frame as unknown as Part];
    // Durable BEFORE the wire. The order is the whole state machine: a crash between this line and
    // the next is recoverable precisely because the id and `E` are already frozen on disk.
    await this.wal.beginSend({ id, E, seq: frame.seq, sourceCursor: cursor, body, brackets });
    await this.attempt({ id, E, body, retry: false });
  }

  /**
   * One publish attempt — first or retry — with the FROZEN id and the FROZEN `E`. Never the tip.
   *
   * The three outcomes are not symmetric and the asymmetry is the design:
   * - `!duplicate` → transition 2 then 3. Success becomes durable before the frontier moves.
   * - `duplicate` → HALT. On a first attempt it means a body WE DID NOT WRITE holds our id, and
   *   folding its `ackSeq` would advance the frontier and the source cursor past events that were
   *   never published. On a retry it cannot happen under `[P5]` at all — an R1 stream evaluates the
   *   expectation before the dedup cache — so observing it proves `[P5]` was violated. Both are
   *   fail-loud, and neither is a case where guessing is better than stopping.
   * - CAS loss → HALT. Someone else moved the tip on a subject only this principal may write, or
   *   the subject was purged. Uncertainty plus a moved tip is exactly what must not be guessed at.
   *
   * A NETWORK error is deliberately none of these: it leaves `pending` as `sent_unacked`, which is
   * the state that means "we do not know", and the next boot retries the same frozen frame.
   */
  private async attempt(o: { id: string; E: number; body: Part[]; retry: boolean }): Promise<void> {
    let ack: { seq: number; duplicate: boolean };
    try {
      ({ ack } = await this.ep.multicastExpecting({
        channel: this.channel,
        parts: o.body,
        id: o.id,
        expectedLastSubjectSeq: o.E,
      }));
    } catch (e) {
      if (isCasLoss(e))
        throw this.halt(
          "cas-loss",
          `event emitter for ${this.channel}: the subject tip is no longer ${o.E} (${(e as Error).message}). ` +
            `This subject is writable by one principal, so a moved tip means another writer, a restored ` +
            `stream, or a filtered purge — none of which a publisher may resolve by re-reading the tip. ` +
            `Clearing it is an explicit abandonment, which resets epoch, seq, E and cursor together.`,
        );
      throw e;
    }

    if (ack.duplicate)
      throw this.halt(
        "duplicate-ack",
        `event emitter for ${this.channel}: the broker answered ${o.retry ? "a RETRY" : "a FIRST attempt"} ` +
          `for id ${o.id} with duplicate:true. ` +
          (o.retry
            ? `Under [P5] this cannot happen on an R1 stream, which evaluates the subject expectation ` +
              `before the dedup cache — so either the stream is not R1 or a foreign body holds our ` +
              `stream-wide id. `
            : `We have never published this id, so a body we did not write holds it. `) +
          `Folding this ack would advance the frontier and the source cursor past events that were ` +
          `never published: silent loss of real events. The frontier and cursor are unchanged.`,
      );

    await this.wal.recordAck(ack.seq);
    await this.wal.fold();
  }

  /**
   * Decide whether a bracket refusal is the WRITER's fault or OURS, and say which.
   *
   * Ours iff ALL THREE hold, and each is load-bearing:
   * - this process has fed NO event through the machine yet, so the machine cannot have been put
   *   into a bad state by anything we did in this run; and
   * - the frontier is non-virgin, so frames — and therefore possibly an open `RUN_STARTED` — were
   *   published by a PREVIOUS process; and
   * - the WAL cannot say what was open. Since v2 the machine is PERSISTED, so an ordinary restart
   *   restores it and never reaches here at all; `null` means the document was migrated from v1 and
   *   genuinely never recorded the state. Without this condition the diagnosis would survive as a
   *   permanent excuse for a case the migration fixed.
   *
   * Drop the first condition and a genuine mid-stream violation by the writer gets blamed on a
   * restart that happened an hour ago. Drop the second and a violation on a virgin thread, where
   * nothing was ever published and nothing could have been lost, gets blamed on a restart that never
   * happened. Each condition alone produces a confident, wrong diagnosis — which is worse than the
   * undiagnosed error it replaced, because a named cause stops the search.
   */
  private diagnoseBracket(err: Error): Error {
    if (this.fedAnyEvent || this.wal.frontier.seq === 0 || this.wal.brackets !== null) return err;
    return new AguiBracketStateLost(
      `event emitter for ${this.channel}: bracket state was LOST ACROSS A RESTART — this is not a ` +
        `protocol violation by the writer. This process has emitted nothing yet, but the WAL says ` +
        `frame ${this.wal.frontier.seq} already went out, and the document records NO bracket state ` +
        `(it was migrated from v1, which never stored one), so any run or message the previous ` +
        `process left open is invisible to this one. Resuming from the source cursor therefore lands ` +
        `mid-run and the first event is refused. A WAL written by this build persists the machine and ` +
        `does not reach this path. The underlying refusal was: ${err.message}`,
      err,
    );
  }

  private halt(reason: "duplicate-ack" | "cas-loss", message: string): AguiEmitterHalted {
    this.halted = new AguiEmitterHalted(reason, message);
    return this.halted;
  }
}
