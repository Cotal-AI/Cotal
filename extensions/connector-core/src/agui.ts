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
 * **Still absent, and named for the same reason: NOTHING IN THIS MODULE IS CALLED BY PRODUCTION
 * CODE YET.** The vocabulary, the bracket machine and the splitter are all reachable only from this
 * package's own smokes. No connector emits, and the `[P5]` R1 preflight has no production call site
 * to start from because the emitter that §9 step 2a places it in has not been built. Read nothing
 * here as evidence that anything runs.
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
