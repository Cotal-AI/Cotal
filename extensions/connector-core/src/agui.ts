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
 * ## What is here, and what is deliberately NOT
 *
 * Here: the event constructors, the frame envelope, the routing/validity split
 * ({@link isAguiFramePart} / {@link parseAguiFrame}), the {@link AguiBrackets} stream machine, and
 * the `cotal.*` `CUSTOM` table, which is empty in v1.
 *
 * Not here, and NAMED rather than stubbed, because a stub is a claim that the shape is known: the
 * channel derivation, the `max_payload` split, and the emitter that publishes. Each of those talks
 * to something outside this module, and each lands with the surface that calls it.
 *
 * **Nothing constructs a frame outside a smoke.** No connector emits, and this module publishes
 * nothing: every export below is a pure function of its arguments. That is a statement about the
 * tree, not a disclaimer — a reader deciding whether a change here can reach a customer needs it to
 * be accurate, so it is maintained rather than left to rot.
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
 * `*_CHUNK` (plan §3: all three sources are settled observations, so we emit the START/CONTENT/END
 * triple, which is the subset every consumer implements — raw CHUNK needs a client transformer);
 * `STATE_*` (reserved for a later lane, and ask state left this plane entirely);
 * `MESSAGES_SNAPSHOT` (§5.3 dropped it as a compaction anchor — a
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
