/**
 * The AG-UI event VOCABULARY and the Cotal frame envelope.
 *
 * This is the file that makes the change an abolition rather than a rename. Renaming `tr-<name>` to
 * `events.<name>` while the connectors went on publishing `condense()` output would have moved
 * glyph-prefixed text to a new channel and changed nothing a consumer can do with it — the channel
 * name was never the complaint. The mirror is now gone from the tree rather than renamed, and this
 * vocabulary is what replaced it.
 *
 * **The vocabulary is adopted; the SDK is not.** `@ag-ui/core` is a `devDependency`,
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
 * ## What is here, and what is deliberately NOT
 *
 * Here: the event constructors, the frame envelope, the routing/validity split
 * ({@link isAguiFramePart} / {@link parseAguiFrame}), the {@link AguiBrackets} stream machine, the
 * `cotal.*` `CUSTOM` table (empty in v1), the preview plane's {@link splitFrames}, and the egress
 * policy that decides which events may leave for the event channel.
 *
 * Not here: the emitter that publishes, with the channel derivation and the durable source, WAL and
 * subject frontier it drives. Those are in `agui-emitter.ts`, which imports this module and is never
 * imported by it, so a change to the delivery machine cannot reach the vocabulary.
 *
 * **This module publishes nothing and does no I/O.** A reader deciding whether a change here can
 * reach the wire on its own needs that to be accurate, so it is maintained rather than left to rot.
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

// The frame's wire identity lives in `@cotal-ai/core`: an adopted vocabulary is a standard concept,
// and core must be able to RENDER a frame without depending on an extension. Re-exported here so an
// importer of this module gets the whole producer-side vocabulary as one surface. The constructors,
// the envelope and all validation stay in this file — only the identity is in core. See
// `packages/core/src/agui-kind.ts`.
export { AGUI_FRAME_KIND, AGUI_EVENT_TYPE, isAguiFramePart } from "@cotal-ai/core";
import { AGUI_FRAME_KIND, AGUI_EVENT_TYPE, isAguiFramePart } from "@cotal-ai/core";

/**
 * The AG-UI events this plane emits — the MAPPED SUBSET, not the whole protocol.
 *
 * Absent by decision, each recorded so its absence is not read as an oversight:
 * `*_CHUNK` (all three sources are settled observations, so we emit the START/CONTENT/END
 * triple, which is the subset every consumer implements: raw CHUNK needs a client transformer);
 * `STATE_*` (reserved for a later lane, and ask state left this plane entirely);
 * `MESSAGES_SNAPSHOT` (dropped as a compaction anchor, because a
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
  /**
   * Model usage for the whole run, on the event that closes it (`RUN_FINISHED` or `RUN_ERROR`).
   * The union has no step events, so the run terminal is the only boundary every connector shares.
   *
   * Set only by a connector whose harness reports the numbers, and a count the harness does not
   * report is omitted rather than zeroed, so a reader can tell "none" from "unknown". The cache and
   * reasoning counts are PARTS of the totals beside them: harnesses disagree on whether their input
   * count includes cached tokens, and one stated rule is what keeps two connectors from publishing
   * different quantities under the same name.
   */
  usage?: {
    /** Every prompt token the model read, cached or not. */
    inputTokens?: number;
    /** The part of `inputTokens` read from the provider's prompt cache. */
    cacheReadTokens?: number;
    /** The part of `inputTokens` written to the provider's prompt cache. */
    cacheWriteTokens?: number;
    /** Every token the model generated, reasoning included. */
    outputTokens?: number;
    /** The part of `outputTokens` spent on reasoning. */
    reasoningTokens?: number;
    /** The run's cost in US dollars. */
    costUsd?: number;
  };
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
   *
   * **`"auto-continuation"` was added because a fail-loud branch is only safe if you know what is on
   * the other side of it.** It is the harness re-injecting a standing goal into an unattended
   * session, and it is a turn: work begins, and an observer asking what triggered it is owed the
   * real answer rather than `"human"`. Measured over 237 real session files and 531,882 records on
   * one machine, where the whole provenance universe is four values: `channel` 30,385, `human`
   * 1,505, `task-notification` 706, `auto-continuation` 4. The rare one is exactly the one an
   * enumeration built from a smaller sample misses, and missing it throws in production.
   */
  turnSource?: "human" | "channel" | "notification" | "sdk" | "auto-continuation" | "unknown";
  /** What was cut to fit the wire, and how big it was. Set only by the sizing path. */
  truncated?: { field: string; originalBytes: number };
}

/** An event carrying Cotal metadata. Kept structural so it composes with any member of the union. */
export type WithCotal<E> = E & { cotal?: CotalMeta };

/**
 * The `cotal.*` `CUSTOM` event table — the second and ONLY other vehicle for Cotal-specific data.
 *
 * **The v1 table is EMPTY, and that is the specification, not an unfinished state.** Earlier
 * revisions described a two-member table holding `cotal.ask.opened` / `cotal.ask.settled`. Both
 * were removed when ask state left this plane, on the operative ground that there is no consumer:
 * the board answers what is owed, the plane carries what is happening. Leaving the count in the
 * prose invited re-adding them "because the table has two slots", so the table ships with no slots.
 *
 * It exists as the GATE: adding a member is a decision that touches this declaration, rather than
 * a `CUSTOM` name invented at a call site where nobody reviews the vocabulary.
 */
export const COTAL_CUSTOM_EVENTS: readonly string[] = [];

/** The envelope version. One frame declares the AG-UI vocabulary version it was built against. */
export const AGUI_PROTOCOL = "ag-ui/0.0.57";


/**
 * One Cotal message = one frame.
 *
 * `threadId` is the native harness session and `runId` is ONE native harness turn, and nothing
 * else may claim either of them. `epoch` is the writer-identity fence recovered from the WAL
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
 * forbid a split this design requires.** An oversized frame splits on event boundaries with each
 * part carrying its own `seq`, so a run can legally open in one frame and close in the next. The
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
 * One entry of the `interrupt` outcome.
 *
 * Both fields are REQUIRED strings, measured against the real schema rather than read off its
 * types: an entry missing either is refused naming `outcome.interrupts.<i>.<field>`. Extra keys on
 * an entry are STRIPPED rather than refused, which is why nothing here polices them.
 */
export interface AguiInterrupt {
  id: string;
  reason: string;
}

/**
 * The `interrupt` outcome's list, checked against exactly what the real schema requires.
 *
 * Measured: the list must be present and NON-EMPTY (`too_small` on `outcome.interrupts`), and every
 * entry must be an object carrying `id` and `reason` as strings (`invalid_type` on
 * `outcome.interrupts.<i>.<field>`). The check is exactly the schema's rule and no stricter: an
 * empty `id` is legal upstream, so refusing it here would be this file inventing a protocol.
 *
 * It lives at the CONSTRUCTOR because the constructor is the only writer, and because a typed
 * parameter proves nothing about the callers that actually reach it: a hook payload crosses into
 * this file as `unknown`, and a replayed record crosses through a cast. The type is the reader's
 * documentation, this is the enforcement.
 */
function assertInterrupts(list: readonly AguiInterrupt[]): void {
  if (!Array.isArray(list) || list.length === 0)
    throw new AguiVocabularyError(
      "outcome.interrupts must be a non-empty array when the outcome is an interrupt",
    );
  for (const [i, entry] of list.entries()) {
    const e = entry as { id?: unknown; reason?: unknown } | null;
    if (typeof e !== "object" || e === null)
      throw new AguiVocabularyError(`outcome.interrupts[${i}] is not an object`);
    if (typeof e.id !== "string")
      throw new AguiVocabularyError(`outcome.interrupts[${i}].id must be a string`);
    if (typeof e.reason !== "string")
      throw new AguiVocabularyError(`outcome.interrupts[${i}].reason must be a string`);
  }
}

/**
 * `RUN_FINISHED`.
 *
 * `outcome` is OPTIONAL — measured against the real schema, which accepts a `RUN_FINISHED` carrying
 * none. That matters because the Claude `Stop` hook reports that a turn ended and nothing more, so
 * manufacturing a `success` outcome would be asserting something the source never said. When an
 * outcome IS supplied its discriminator key is `type`, not `status` (measured: the schema refuses
 * `{status:"success"}` naming `outcome.type`), and the object is STRICT.
 *
 * The `interrupt` outcome is REPRESENTABLE and VALIDATED here, and UNSPENT: no source on this plane
 * constructs one, because a harness-native park is what would justify it and none of the three
 * sources reports one. It is checked anyway because the arm exists, and an arm that builds an event
 * the schema refuses is worse than an arm that does not exist. Its first draft took `unknown[]` and
 * passed it through, so `[]` and `[{}]` both produced a refused event with nothing looking.
 */
export function runFinished(o: {
  threadId: string;
  runId: string;
  timestamp: number;
  outcome?: { type: "success" } | { type: "interrupt"; interrupts: AguiInterrupt[] };
  cotal?: CotalMeta;
}): WithCotal<RunFinishedEvent> {
  if (o.outcome?.type === "interrupt") assertInterrupts(o.outcome.interrupts);
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
 * The constructor still builds the event. The durable emitter suppresses TOOL_CALL_ARGS before
 * beginSend (and refuses a frozen pre-fix body that still carries it), because `events.<owner>.<actor>`
 * has a different read ACL from the channel a mesh read tool ran on. Mappers keep constructing it so
 * their own shape smokes stay about mapping, not about egress.
 *
 * This is where `tr-`'s `salient()` died: it guessed which argument mattered and dropped the rest,
 * so a reader could not reconstruct what the agent actually did. The whole input is still the
 * constructor's job; the events plane no longer carries it.
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
 *
 * The constructor still builds the event. The durable emitter suppresses TOOL_CALL_RESULT before
 * beginSend (and refuses a frozen pre-fix body that still carries it). Content is mandatory, so the
 * event is dropped rather than emptied or placeholdered. Observers lose the tool output they see
 * today; that is the boundary.
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
// Sizing and splitting.
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
 * The fields a too-large event may be truncated on: NAMED, never inferred.
 *
 * Inferring "the biggest string on the object" would eventually truncate an id, a role or a tool
 * name, and produce a frame that fits and means something else. Exactly three fields carry
 * free-form content, so three is what this table holds; an event carrying none of them cannot be
 * truncated and says so.
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
export const takeCodePoints = (s: string, codePoints: number): string =>
  Array.from(s).slice(0, codePoints).join("");

/**
 * Split `events` into as many frames as the wire requires, truncating only what physically cannot
 * cross it, and LABELLING every truncation.
 *
 * **THIS IS THE PREVIEW PLANE'S SPLITTER, AND IT HAS NO DURABLE-PLANE CALLER BY DESIGN.**
 * Read that as a boundary, not as an oversight: the durable emitter packs with `packUnits` at
 * SOURCE-RECORD boundaries and refuses an oversized unit, because one durable emit unit must be one
 * frame carrying a cursor that resumes after it, and a frame ending mid-record has no cursor it can
 * honestly store. This event-boundary split and its labelled truncation were specified before the
 * durable plane had a cursor contract; where the two disagree, the durable plane's rule wins. The
 * PREVIEW plane has no resume obligation at all, which is exactly where truncate-and-label is the
 * right answer and why this machinery is worth keeping.
 *
 * **Calling this from the durable emitter would be a silent-loss bug**, not a performance choice —
 * so if you are here looking for the packer, you want `packUnits` in `agui-emitter.ts`. And it is
 * marked rather than deleted for the reason one module over already demonstrated:
 * `assertExpectationSemantics()` sat with zero production callers looking exactly like live code,
 * and unreachable code that looks live is a hazard whichever direction the next reader resolves it
 * in.
 *
 * **Say the uncomfortable thing:** this is a content truncation, which is one of the
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
 * **Iterate to fit, never one pass.** Shortening a string changes its JSON escaping and
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

/**
 * Events that must never reach `events.<owner>.<actor>`.
 *
 * That channel carries a different read ACL from the channel a mesh read tool ran on. TOOL_CALL_ARGS
 * and TOOL_CALL_RESULT republish tool inputs and outputs unredacted. Fail closed: without trusted
 * provenance AND evidence the destination audience may read the bytes, do not republish them.
 * Content is mandatory on both kinds (schema-measured: ARGS requires `delta`, RESULT requires
 * `content` and `messageId`), so the event is suppressed rather than emptied, placeholdered, or
 * rewritten. No tool-name allowlist. Observers lose the tool output they see today; that is the
 * boundary, not a regression.
 *
 * Applied on the WRITE path before `beginSend`, so disk and wire agree, and on the RETRY path as a
 * refusal rather than a rewrite: a body frozen by an older process can still carry a forbidden
 * kind, and mutating frozen bytes between disk and wire would break the recovery machine. An
 * upgrade across a pending pre-fix frame therefore HALTS rather than leaks.
 */
const EGRESS_FORBIDDEN_TYPES: ReadonlySet<string> = new Set([
  AGUI_EVENT_TYPE.TOOL_CALL_ARGS,
  AGUI_EVENT_TYPE.TOOL_CALL_RESULT,
]);

// ---------------------------------------------------------------------------
// Closed-schema tables.
//
// The egress fence must validate the WHOLE envelope, not just `.events[].type`.
// A frame with extra properties at any level passes the event-kind check and
// publishes its payload untouched. These tables define the closed shape so the
// fence can refuse an envelope carrying unknown properties and name the path.
//
// `cotal` is an allowed extension key on every event (WithCotal<E>). AG-UI
// schemas are `.passthrough()`, so the upstream schema would not refuse it;
// this fence enforces the closed shape Cotal publishes.
// ---------------------------------------------------------------------------

/** The ONLY keys a frame part may carry at the top level. */
const KNOWN_FRAME_KEYS: ReadonlySet<string> = new Set([
  "kind", "protocol", "threadId", "runId", "epoch", "seq", "events",
]);

/**
 * The allowed keys per event type. Each set includes the AG-UI schema keys for
 * that type PLUS `cotal` (the Cotal extension key carried via `WithCotal<E>`).
 *
 * The source of truth is the AG-UI 0.0.57 schema shapes, measured at build time
 * by the conformance smoke. `rawEvent` is an AG-UI schema key on every type.
 */
const KNOWN_EVENT_KEYS_BY_TYPE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [AGUI_EVENT_TYPE.RUN_STARTED, new Set(["type", "timestamp", "rawEvent", "threadId", "runId", "parentRunId", "input", "cotal"])],
  [AGUI_EVENT_TYPE.RUN_FINISHED, new Set(["type", "timestamp", "rawEvent", "threadId", "runId", "result", "outcome", "cotal"])],
  [AGUI_EVENT_TYPE.RUN_ERROR, new Set(["type", "timestamp", "rawEvent", "message", "code", "cotal"])],
  [AGUI_EVENT_TYPE.TEXT_MESSAGE_START, new Set(["type", "timestamp", "rawEvent", "messageId", "role", "name", "cotal"])],
  [AGUI_EVENT_TYPE.TEXT_MESSAGE_CONTENT, new Set(["type", "timestamp", "rawEvent", "messageId", "delta", "cotal"])],
  [AGUI_EVENT_TYPE.TEXT_MESSAGE_END, new Set(["type", "timestamp", "rawEvent", "messageId", "cotal"])],
  [AGUI_EVENT_TYPE.TOOL_CALL_START, new Set(["type", "timestamp", "rawEvent", "toolCallId", "toolCallName", "parentMessageId", "cotal"])],
  [AGUI_EVENT_TYPE.TOOL_CALL_ARGS, new Set(["type", "timestamp", "rawEvent", "toolCallId", "delta", "cotal"])],
  [AGUI_EVENT_TYPE.TOOL_CALL_END, new Set(["type", "timestamp", "rawEvent", "toolCallId", "cotal"])],
  [AGUI_EVENT_TYPE.TOOL_CALL_RESULT, new Set(["type", "timestamp", "rawEvent", "messageId", "toolCallId", "content", "role", "cotal"])],
  [AGUI_EVENT_TYPE.REASONING_MESSAGE_START, new Set(["type", "timestamp", "rawEvent", "messageId", "role", "cotal"])],
  [AGUI_EVENT_TYPE.REASONING_MESSAGE_CONTENT, new Set(["type", "timestamp", "rawEvent", "messageId", "delta", "cotal"])],
  [AGUI_EVENT_TYPE.REASONING_MESSAGE_END, new Set(["type", "timestamp", "rawEvent", "messageId", "cotal"])],
  [AGUI_EVENT_TYPE.CUSTOM, new Set(["type", "timestamp", "rawEvent", "name", "value", "cotal"])],
]);

/**
 * Find the first extra property on a parsed frame, returning its JSON-path
 * string, or `undefined` when the envelope is closed.
 *
 * Checks two levels:
 * 1. Frame-level keys against {@link KNOWN_FRAME_KEYS}.
 * 2. Per-event keys against {@link KNOWN_EVENT_KEYS_BY_TYPE} for the event's
 *    `type`. An event whose `type` is not in the map has already been refused
 *    by `parseAguiFrame`; if it somehow reaches here it is reported as
 *    `events[i]` with no key.
 *
 * Returns the dotted path of the first unknown property found, e.g.
 * `"recovery"` for a frame-level extra or `"events[0].leaked"` for an
 * event-level extra. The caller turns this into a named verdict.
 */
export function extraPropertyPath(part: Record<string, unknown>): string | undefined {
  // Frame-level extra keys.
  for (const key of Object.keys(part)) {
    if (!KNOWN_FRAME_KEYS.has(key)) return key;
  }
  // Per-event extra keys.
  const events = part.events;
  if (!Array.isArray(events)) return undefined; // parseAguiFrame already validated
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as Record<string, unknown> | null;
    if (typeof e !== "object" || e === null) continue; // parseAguiFrame already validated
    const t = e.type as string;
    const allowed = KNOWN_EVENT_KEYS_BY_TYPE.get(t);
    if (!allowed) return `events[${i}]`; // unknown type
    for (const key of Object.keys(e)) {
      if (!allowed.has(key)) return `events[${i}].${key}`;
    }
  }
  return undefined;
}

export function isForbiddenEgressEventType(type: unknown): boolean {
  return typeof type === "string" && EGRESS_FORBIDDEN_TYPES.has(type);
}

/**
 * The only `message` a published `RUN_ERROR` carries.
 *
 * `RUN_ERROR` is the terminal a renderer waits on, so the kind cannot be withheld the way tool
 * arguments and results are. Its `message`, `code` and `rawEvent` are upstream values that no
 * connector controls: a harness can echo the prompt, a peer message or tool output into any of them,
 * and the events channel has a different read ACL from wherever that text was read (#1431). So the
 * content is fixed instead: every `RUN_ERROR` leaving through the emitter carries this text and no
 * `code` or `rawEvent`, and the upstream detail stays in the seat's own log. The failure kind a
 * connector classified is published on presence, as the agent's condition.
 */
export const RUN_ERROR_EGRESS_MESSAGE = "run failed";

/** The one `RUN_ERROR` shape that may publish: the fixed message, the timestamp, and Cotal metadata. */
function egressRunError(o: { timestamp?: number; cotal?: CotalMeta }): WithCotal<RunErrorEvent> {
  return {
    type: AGUI_EVENT_TYPE.RUN_ERROR,
    message: RUN_ERROR_EGRESS_MESSAGE,
    ...(o.timestamp !== undefined ? { timestamp: o.timestamp } : {}),
    ...(o.cotal ? { cotal: o.cotal } : {}),
  } as WithCotal<RunErrorEvent>;
}

/** Whether a `RUN_ERROR` read back from a frozen body is the shape {@link egressRunError} writes. */
function isEgressRunError(e: object): boolean {
  return (e as { message?: unknown }).message === RUN_ERROR_EGRESS_MESSAGE && !("code" in e) && !("rawEvent" in e);
}

/**
 * Drop forbidden kinds from a mapped unit, and rebuild every `RUN_ERROR` as
 * {@link egressRunError}. Sibling lifecycle and text events stay.
 */
export function applyAguiEgressPolicy(events: readonly AguiEvent[]): AguiEvent[] {
  return events
    .filter((e) => !isForbiddenEgressEventType((e as { type?: unknown }).type))
    .map((e) => (e.type === AGUI_EVENT_TYPE.RUN_ERROR ? egressRunError(e as WithCotal<RunErrorEvent>) : e));
}

/** What a frozen body is, as far as the egress policy can tell. */
export type FrozenBodyEgressVerdict = "clean" | "forbidden-kind" | "unreadable" | "extra-property" | "run-error-content";

/**
 * Classify a frozen body for egress. Used on retry, where the body is already on disk and must not
 * be rewritten. A part that is not a frame is not this policy's to judge.
 *
 * THREE ANSWERS, BECAUSE TWO WERE NOT ENOUGH. A boolean forced every frame this policy could not
 * read into one of two wrong buckets. Reading it through the strict {@link parseAguiFrame} made an
 * unreadable frame throw a bare vocabulary error out of a machine whose every other abnormal
 * outcome is a named halt. Skipping it instead PUBLISHED the frame: measured, a body whose `events`
 * is the string `"TOOL_CALL_RESULT: <bytes>"` survives a JSON round-trip, carries the bytes as its
 * event list, and reaches the wire. The confidentiality boundary is the wire, not what a renderer
 * folds, so a frame this policy cannot interpret is `unreadable` and the caller halts on it by name.
 *
 * THE INVARIANT, AND IT IS THE WHOLE DESIGN: this function's READ PATTERN IS ITS PREDECESSOR'S. It
 * validates the part through the same `parseAguiFrame` and scans the events of that call's result,
 * in that order, exactly as the strict read it replaces did. Every difference between them is a
 * throw becoming a named answer. Nothing else moved, so no input can make this weaker than the code
 * it replaced — not a malformed envelope, not a stateful accessor, not a representation nobody has
 * thought of. Equivalence is structural here rather than enumerated, and that is the point.
 *
 * WHY IT IS WRITTEN THIS WAY AND NOT AS A DIRECT SCAN. Four repairs tried to answer the forbidden-
 * kind question by reading `events` off the part itself and validating separately. Each one shipped
 * a classifier that was weaker than the strict read on some input the author had not pictured: a
 * non-array `events` that used to throw (`1698fe253`), an empty array the scan looped over zero
 * times (`350b8eb7a`), an envelope whose `protocol`, `threadId`, `runId`, `epoch` and `seq` were
 * never checked at all (`071233483`), and a check/use split where the scan and the validator read
 * `events` at different times and could disagree (`6502b213e`). The last of those tried to close the
 * split by DETECTING the objects that could exhibit it, which held for an own accessor and lost
 * immediately to an inherited one and to a Proxy reporting a data descriptor while its `get` trap
 * returned something else. A guard that enumerates representations loses to the next representation.
 * Reading the way the predecessor read cannot lose that way, because there is no second reader whose
 * answer could differ.
 *
 * ORDERING, STATED BECAUSE IT IS OBSERVABLE. The parse runs before the scan, so a frame that both
 * fails to parse and carries a forbidden event answers `unreadable`, not `forbidden-kind`. That is
 * the predecessor's order too — it threw before it ever reached its scan — so this is equivalence,
 * not a new preference. Both answers halt the publish and neither claims a cause it did not see.
 * `forbidden-kind` still wins over `unreadable` ACROSS parts: an earlier unparseable part does not
 * stop a later part's forbidden event from being named as the more specific diagnosis.
 *
 * `run-error-content` (#1431) is read off the same parse result as the forbidden-kind scan: a
 * `RUN_ERROR` other than the fixed shape {@link applyAguiEgressPolicy} writes was frozen before that
 * fix and may carry upstream text, so it halts like a pre-fix tool event does.
 *
 * A part whose `kind` is not `AGUI_FRAME_KIND` is skipped, as it was before. That is the
 * pre-existing non-frame gap and this function neither widens nor closes it.
 *
 * TOTAL: no input makes this throw. That covers iterating `body` itself, not only reading a part's
 * properties: a Proxy whose `Symbol.iterator` traps, or an array with a throwing index accessor,
 * raises before any per-part catch can see it, and an abort there is fail-closed rather than
 * `clean`. `isAguiFramePart` in core makes the same promise for the same stated reason, that a
 * function accepting `unknown` and throwing on some of it is a trap for its next caller. This takes
 * `readonly unknown[]`.
 */
export function frozenBodyEgressVerdict(body: readonly unknown[]): FrozenBodyEgressVerdict {
  let unreadable = false;
  // The outer catch covers the ITERATION. A Proxy whose `Symbol.iterator` traps, or an array with a
  // throwing index accessor, raises before the per-part catch below can see it. Neither can come off
  // a WAL, which is JSON, but the exported signature takes `readonly unknown[]` and has to mean it.
  // Aborting mid-iteration is fail-closed: a forbidden part already seen has returned, and anything
  // unseen is unread rather than assumed harmless.
  try {
    for (const part of body) {
      // The per-part catch is what turns the predecessor's throw into a named answer, and it is the
      // ONLY difference between the two functions. `parseAguiFrame` throws on every envelope defect
      // it knows -- protocol, threadId, runId, epoch, seq, an absent or empty event list, an
      // unrecognised event type -- and each of those used to escape as a bare `AguiVocabularyError`.
      // `0492bcd11` stopped calling it so an old-protocol or replayed-WAL frame would be EVALUATED
      // rather than die on one. That rationale is about not throwing; it is not about publishing,
      // and collapsing the two is what let three regressions ship. Such a frame now takes the named
      // `egress-unreadable` halt instead of either outcome.
      try {
        if (!isAguiFramePart(part)) continue;
        const frame = parseAguiFrame(part);
        for (const e of frame.events) {
          if (isForbiddenEgressEventType((e as { type?: unknown }).type)) return "forbidden-kind";
        }
        // A RUN_ERROR frozen before #1431 can carry upstream text in `message`, `code` or `rawEvent`.
        // Every frame this version writes holds only the fixed shape, so anything else halts.
        for (const e of frame.events) {
          if (e.type === AGUI_EVENT_TYPE.RUN_ERROR && !isEgressRunError(e)) return "run-error-content";
        }
        // Closed-schema check: refuse any property not in the known set.
        // This is the fix for #1432: the fence previously checked only
        // .events[].type and let sibling/extra properties ride through.
        const extra = extraPropertyPath(part as Record<string, unknown>);
        if (extra !== undefined) return "extra-property";
      } catch {
        unreadable = true;
      }
    }
  } catch {
    unreadable = true;
  }
  return unreadable ? "unreadable" : "clean";
}
