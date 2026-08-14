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
 * ## What is NOT here, and why the file is smaller than the build order's step 1
 *
 * Step 1 also names `eventChannel()` and the `max_payload` preflight/split as parts of this module.
 * Both are deliberately absent, because both depend on decisions this lane does not yet hold:
 *
 * - **The channel key is being replaced.** `eventChannel(name)` keys a per-agent isolation boundary
 *   on the DISPLAY NAME, which `packages/core/src/resolve.ts` states is not an identity. The ruling
 *   is to key on the principal-stable id, and the plan says to settle it BEFORE this file exists or
 *   the emitter gets built twice. Nothing here derives a channel, so nothing here has to be rebuilt
 *   when it lands.
 * - **Sizing cannot be done correctly from here yet.** The endpoint constructs `id`/`ts`/`space`/
 *   `from`/`channel` AFTER the publish call and sets two headers the broker counts against
 *   `max_payload`, so a caller splitting against a bare ceiling measures the frame while the broker
 *   measures the message. A raw `maxPayload` getter is not sufficient and the plan says so; the
 *   surface that measures exactly what will be sent does not exist.
 *
 * Writing either against today's surfaces would produce code that looks finished and is wrong in a
 * way no test written alongside it would catch. They are named here rather than stubbed, because a
 * stub is a claim that the shape is known.
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
 * on the cutover rather than a follow-up: a viewer that does not understand this part shows
 * nothing, and an empty pane is indistinguishable from a correctly-empty one.
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
