/**
 * §3.1 — the Claude Code session JSONL → AG-UI event mapping.
 *
 * This is the record-shaped half of the cutover. It lives HERE and not in `connector-core` on
 * purpose: the JSONL entry shape is Claude's, and letting it into the shared layer would be exactly
 * the leak AGENTS.md forbids ("never let an adapter's concepts leak into the shared layers"). What
 * IS shared — the vocabulary, the frame, the bracket machine, the durable read discipline — is
 * imported from `connector-core` and nothing about Claude goes back the other way.
 *
 * ---------------------------------------------------------------------------------------------
 * THREE THINGS THE PLAN DOES NOT SETTLE, RECORDED AS GAPS RATHER THAN DECIDED HERE.
 *
 * **(A) The run brackets have no vehicle, and this is a real plan defect, not a detail.** §3.1
 * sources `RUN_STARTED` from the `UserPromptSubmit` hook and `RUN_FINISHED` from the `Stop` hook
 * (`mcp.ts:72`, `:96`). But `[P6]`/§5.4 makes the durable plane READ A FILE, and the emitter's
 * mapper is `(record) => events` — a hook fires in a different process at a different time and
 * produces NO JSONL record, so there is no vehicle by which a hook-sourced event can enter a
 * record-sourced stream. The two halves of the design were specified against different inputs.
 *
 * What this file does instead is stated plainly so a ruling can replace it in one function:
 * **brackets are derived from the record stream.** A human prompt opens a run; the NEXT human
 * prompt closes the previous one. Two consequences, both of which a reader must know:
 *   1. `RUN_FINISHED` lags by one turn. It is emitted when the next turn starts, not when the turn
 *      ends, so a consumer sees the finish later than the `Stop` hook would have said it.
 *   2. **The last run of a session never closes.** There is no record after it to close it on.
 * Neither is silently absorbed: {@link closeOpenRun} exists so the connector's `Stop` hook can shut
 * the run at the real boundary once a vehicle is ruled, and until then the lag is honest.
 *
 * **(B) `origin.kind === "human"` OPENS NO RUN IN ANY AGENT-DRIVEN SESSION — MEASURED on three, and
 * this is why the mapping smoke reads a real session rather than a fixture.** §3.1's rule is right
 * about what it excludes (peer/mesh injections, task notifications, resumed-session summaries). The
 * problem is what is left to select. Partitioned by CONTENT SHAPE, not just counted:
 *
 *   | session | user entries | `tool_result` | mesh (`origin.kind:"channel"`) | compact summary | human |
 *   | --- | --- | --- | --- | --- | --- |
 *   | interactive, 5938 rec | 892 | 824 | 67 | 1 | **0** |
 *   | headless `claude -p`, 30 rec | 5 | 3 | 0 | 0 | **0** (2 prompts, `promptSource:"sdk"`) |
 *   | agent session, 1088 rec | 90 | 86 | 4 | 0 | **0** |
 *
 * **`kind:"human"` occurs zero times — but so does a human.** `~/.claude/history.jsonl`, which
 * records typed prompts through a different mechanism entirely, reports **0** for all three sessions
 * and 0 for this worktree. The two sources agree, so zero matches is the CORRECT result on these
 * captures and NOT evidence the rule is wrong. **The rule is unexercised here, not disproven.**
 *
 * **AND IT IS EXERCISED ELSEWHERE — read `plans/agui-events.md` §3.1 before reading these numbers as
 * a defect.** That section measured a real session a person was driving and counted `kind:"human"`
 * **44 times**, with `promptSource: "typed"`/`"queued"`, beside 3068 `kind:"channel"` injections. So
 * the predicate does select, on a session that contains the thing it selects. The three captures
 * here simply contain none. **Both numbers belong together; either alone misleads.**
 *
 * **THIS WAS A COVERAGE GAP, IT WAS RULED, AND THE RULING IS IMPLEMENTED BELOW.** It read: on
 * agent-driven sessions no run is ever opened and the connector emits nothing, because §3.1's table
 * sent every non-`human` origin to *nothing*. §3.1's session had a human typing 44 times alongside
 * its 3068 mesh messages; a spawned lane seat has **0 and 67**, so the open question was **what
 * opens a run when nobody types**.
 *
 * **RULED (fm-orchestrator, `agui-events.md` §3.1): run-opening and attribution are two predicates,
 * and that row was one predicate doing both jobs.** A run opens on
 * `origin.kind ∈ { human, channel }`, ENUMERATED and never inferred; `task-notification` is named as
 * known-and-not-a-turn; absent `origin` gets its own enumeration over `promptSource`. Attribution
 * rides as `cotal.turnSource` — **a field on the run, never a gate on it**. The privacy argument is
 * untouched: a `RUN_STARTED` attributed to a peer republishes no message body, so a peer-initiated
 * turn can be a turn without re-emitting the peer's content. See {@link ORIGIN_RULE} and
 * {@link ABSENT_ORIGIN_RULE}, which are where this now lives.
 *
 * **KEEP THIS PARAGRAPH HONEST.** Its earlier form said "no run is ever opened and the connector
 * emits nothing" and "escalated as a plan defect rather than decided here" — describing the state
 * before the ruling, directly above code that had already implemented it. A successor read it,
 * believed it over the code, and escalated a closed question as a live blocker; the measurement that
 * corrected it took one run of the real mapper (**67 runs / 5217 events** on the 5938-record
 * session, `diagnose()` → `null`). **A stale header is not a documentation defect, it is a false
 * claim about the function beneath it.** If the rule changes again, this paragraph changes with it.
 *
 * **DO NOT "FIX" THIS BY TREATING ABSENT `origin` AS HUMAN.** In a Claude session `user` is also the
 * role of a TOOL RESULT: that predicate selects **825** of the interactive session's 892 user
 * entries, and the single non-tool-result among them is a **context-compaction summary**
 * (`isCompactSummary`), so the true human count is 0 and the predicate over-matches by 825. It would
 * not emit nothing — it would emit a flood, each entry opening a run, which looks like the connector
 * working. An earlier revision of this comment recorded (B) as HEADLESS-ONLY and asserted a human
 * turn is "a `user` entry with no `origin`"; both halves were wrong.
 *
 * **The rule is implemented exactly as RULED, and still not guessed at.** `promptSource` was
 * proposed as the selector and REJECTED: it is bounded by the partition it was inferred from, and
 * "sdk" also covers programmatic injection. It survives only inside {@link ABSENT_ORIGIN_RULE},
 * where there is no `origin.kind` to enumerate — a second table rather than a synthetic member,
 * because an enumeration over `origin.kind` cannot classify a record that has none. Every value
 * outside either table **fails loud** rather than being silently treated as not-a-turn.
 *
 * **(C) `TOOL_CALL_RESULT.messageId` is unstated in §3.1's table** (the row names only
 * `toolCallId`) while the real schema REQUIRES it. It is keyed the same way every other message
 * identity here is — entry `uuid` plus block index — so it is unique, stable, and derived rather
 * than invented at a call site. Raised as a gap in `connector-core`'s constructor doc as well.
 * ---------------------------------------------------------------------------------------------
 *
 * `messageId` is `${uuid}#${blockIndex}` and NOT `message.id`. `message.id` is a provider request
 * id: measured over a real session, 67% of them appear in more than one entry and 59% carry more
 * than one block type, so spending it as an AG-UI message identity opens and closes one id
 * repeatedly and collapses text and reasoning into a single message in the reference reducer. The
 * provider id is preserved as `cotal.providerMessageId`, which is what it is good for.
 */
import {
  type AguiEvent,
  type RecordMapper,
  runStarted,
  runFinished,
  textMessageStart,
  textMessageContent,
  textMessageEnd,
  toolCallStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  reasoningMessageStart,
  reasoningMessageContent,
  reasoningMessageEnd,
} from "@cotal-ai/connector-core";

/**
 * One JSONL entry, typed to what the mapping actually reads and no further.
 *
 * Every field is optional because a session file carries at least seven entry types
 * (`user`, `assistant`, `attachment`, `queue-operation`, `ai-title`, `last-prompt`, `mode`, and
 * more will be added by a harness release we do not control). Declaring them required would make
 * the mapper's own type a lie about a file it does not own.
 */
export interface ClaudeEntry {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  isSidechain?: boolean;
  origin?: { kind?: string };
  /**
   * Present on every submitted prompt and absent on tool results. **Not the run-opening gate** —
   * it is `"system"` on task-notifications and caveats too. Read ONLY where `origin` is absent, and
   * only for the value `"sdk"`. See `ABSENT_ORIGIN_RULE`.
   */
  promptSource?: string;
  /** The harness's own compaction record. A string-content `user` entry that is not a turn. */
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  /**
   * The session-level invocation marker — `"cli"` or `"sdk-cli"`, uniform across a session file.
   * **Declared and deliberately NOT read.** It is here so the field's existence is recorded rather
   * than rediscovered, and so a suite can drive both values against a rule that must ignore them.
   */
  entrypoint?: string;
  message?: {
    id?: string;
    stop_reason?: string | null;
    content?: string | ClaudeBlock[];
  };
}

/**
 * (A) RUN-OPENING and (B) ATTRIBUTION in one table, because they are one enumeration read two ways:
 * a `null` means "known, and NOT a turn"; a string means "a turn, attributed thus".
 *
 * **ENUMERATED, NEVER INFERRED.** Every key here was read off a real session or off
 * `plans/agui-events.md` §3.1's own measurement. `task-notification` is harness plumbing and is
 * named as not-a-turn rather than left to fall through — the distinction between "we decided no"
 * and "nothing matched" is the whole difference between a rule and an accident.
 *
 * An `origin.kind` outside this table THROWS. A provenance field's entire product is an external
 * observer's belief about who caused something, so a value a future harness adds must produce an
 * error rather than a confident wrong attribution. `CotalMeta.turnSource` carries `"unknown"` for
 * producers that never set the field; the mapper never writes it.
 */
const ORIGIN_RULE: Record<string, "human" | "channel" | null> = {
  human: "human",
  channel: "channel", // a peer/mesh delivery IS a turn — the one change from §3.1
  "task-notification": null, // known, and deliberately not a turn
};

/**
 * The SECOND enumeration, and it only runs where the first one has nothing to read: a record with
 * NO `origin` at all. An enumeration over `origin.kind` cannot classify a record that has no
 * `origin.kind`, and inventing a synthetic member would fabricate the one field §3.1's table exists
 * to stop us guessing at — so the absent-origin case gets its own table rather than a third member.
 *
 * **MEASURED ACROSS ALL 88 SESSION FILES ON THE MACHINE THAT PRODUCED THEM**, over records that are
 * `user`, string-content, and not a compaction marker — i.e. exactly the population that reaches
 * this function. `promptSource` takes precisely two values there: `"sdk"` × 21, absent × 66. All 21
 * `"sdk"` records are real submitted prompts. All 66 absent ones are plumbing — `<local-command-
 * caveat>`, `/compact` command records, `<local-command-stdout>`, the caveat/heartbeat class §3.1
 * counts at 81.
 *
 * **THIS IS NOT `promptSource`-PRESENCE READMITTED, and the difference is the whole reason the first
 * attempt was wrong.** That predicate asked "is the field there?", and the field is there on
 * task-notifications and caveats as `"system"` — so it opened runs on harness plumbing. This asks
 * "is the value exactly `sdk`?", in a branch that only runs when `origin` is absent, against a
 * two-value measured population. Different predicate, different position, measured rather than
 * inferred from a partition of three captures.
 */
const ABSENT_ORIGIN_RULE: Record<string, "sdk" | null> = {
  sdk: "sdk",
  // **NOT FROM MY CORPUS — FROM §3.1's, WHICH I CANNOT RE-READ.** My 88-session sweep finds this
  // value on an absent-origin `user` record ZERO times in 129,910 records. §3.1's table records it
  // 81 times, as "local-command caveats, heartbeats, resumed-session summaries", on a capture with
  // 4728 `user` entries and 3068 `channel` deliveries — and **no session on this machine matches
  // that shape**; the closest has 18 human and 0 channel. So the two measurements are over different
  // corpora and one of them is gone.
  //
  // It is entered as `null` — known, and NOT a turn — because §3.1 already classified it and a
  // measurement I cannot repeat is still a measurement. Leaving it out would make the throw below
  // fire in production on a class the plan documents, which is the one thing a fail-loud branch must
  // not do: **a fail-loud branch is only safe if you know what is on the other side of it.**
  system: null,
};

/**
 * (A) run-opening and (B) attribution, read off whichever of the two tables above applies.
 *
 * **DELIBERATELY NOT KEYED ON `entrypoint`**, which is the session-level marker a reader would
 * reach for first. It is real — 88 sessions, exactly two values (`cli` × 69, `sdk-cli` × 19), no
 * session mixing them — but it does not select prompts, and gating the `sdk` rule behind
 * `entrypoint === "sdk-cli"` **drops a real one**: a `promptSource: "sdk"` record sits in a
 * 2973-record session whose entrypoint is `cli` throughout — an SDK-submitted wake into an
 * interactive session. A session gate opens no run for it: a silent zero manufactured by the fix
 * for silent zeros. Asserted by `mechanism:an-sdk-prompt-opens-a-run-REGARDLESS-of-entrypoint`,
 * because a comment claiming a rule's absence is otherwise a test nobody wrote.
 */
const runOpeningAttribution = (entry: ClaudeEntry): "human" | "channel" | "sdk" | null => {
  const kind = entry.origin?.kind;
  if (kind === undefined) {
    // ABSENT origin. Not an error — absence is a known shape — but no longer a blanket refusal
    // either, because a headless prompt has no `origin` and IS a turn.
    const ps = entry.promptSource;
    if (ps === undefined) return null;
    if (!(ps in ABSENT_ORIGIN_RULE))
      throw new Error(
        `agui-map: origin-less entry ${entry.uuid ?? "<no uuid>"} carries promptSource ` +
          `${JSON.stringify(ps)}, which this mapper has never measured. Refusing to decide whether it ` +
          `begins a run. Add it to ABSENT_ORIGIN_RULE deliberately, with a measurement.`,
      );
    return ABSENT_ORIGIN_RULE[ps]!;
  }
  if (!(kind in ORIGIN_RULE))
    throw new Error(
      `agui-map: unrecognised origin.kind ${JSON.stringify(kind)} on entry ${entry.uuid ?? "<no uuid>"} — ` +
        `refusing to decide whether it begins a run, or to attribute one to a provenance this mapper ` +
        `has never seen. Add it to ORIGIN_RULE deliberately, with a measurement.`,
    );
  return ORIGIN_RULE[kind]!;
};

/** A content block. Same reasoning as above: shape-tolerant, read narrowly. */
export interface ClaudeBlock {
  type?: string;
  text?: string;
  thinking?: string;
  /** `tool_use` */
  id?: string;
  name?: string;
  input?: unknown;
  /** `tool_result` */
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface ClaudeMapperOptions {
  /** The native session id — `threadId` for every event. §3 forbids anything else claiming it. */
  threadId: string;
  /** Mints a `runId`. Connector-minted by §3.1, so every `RUN_STARTED` carries `runIdSource`. */
  mintRunId: () => string;
  /**
   * Emit `REASONING_*` for `thinking` blocks. **Off by default (§7 Q1).** The `signature` is never
   * emitted at any setting (§3.5) and is not read by this module at all.
   */
  reasoning?: boolean;
  /**
   * Arrival clock, for the entries whose `timestamp` is missing or unparseable. Injectable so the
   * mapping is deterministic under test; those events are labelled `cotal.tsSource: "arrival"`
   * rather than being given a real-looking number.
   */
  now?: () => number;
}

/** What {@link createClaudeMapper} returns: the mapper plus the out-of-band run close. */
export interface ClaudeMapper {
  map: RecordMapper<ClaudeEntry>;
  /**
   * Close the open run, if there is one, at a boundary the record stream cannot see — the `Stop`
   * hook. Returns `null` when no run is open, so calling it twice is not an error and cannot
   * manufacture a second `RUN_FINISHED` the bracket machine would refuse.
   *
   * It exists because gap (A) above is a gap: the durable plane has no way to hear a hook today,
   * and this is the seam a ruling plugs into rather than a rewrite.
   */
  closeOpenRun: (timestamp: number, stopReason?: string) => { runId: string; events: AguiEvent[] } | null;
  /** The run currently open, or `null`. Read-only view for a caller that needs to know. */
  openRun: () => string | null;
  /**
   * **WHY THIS SESSION OPENED NO RUNS** — a sentence, or `null` once any run has opened.
   *
   * A mapper that opens zero runs is byte-indistinguishable from a session nobody prompted, and
   * from a mapper that is simply broken. Refusing a record is a legitimate outcome; refusing it
   * SILENTLY is not, and the silence is the defect, not the refusal. This is the production
   * statement of that — it lives in the shipped mapper, not in a smoke summary, so the connector
   * and any operator reading it get the same sentence the suite does.
   *
   * It is deliberately NOT a throw. Some sessions genuinely contain no prompt yet, and a mapper
   * that threw on one would take down a live connector over an empty file.
   */
  diagnose: () => string | null;
}

/** Parse the entry timestamp, or say honestly that we used arrival time. */
function stampOf(entry: ClaudeEntry, now: () => number): { ts: number; arrival: boolean } {
  const parsed = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? { ts: parsed, arrival: false } : { ts: now(), arrival: true };
}

/**
 * `tool_result.content` is a string on some entries and an array of blocks on others. AG-UI's
 * `content` is a string, so the array form is JSON-encoded rather than joined: joining would
 * silently drop every non-text member, which is `salient()`'s defect in a smaller costume.
 */
function resultContent(raw: unknown): string {
  return typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
}

export function createClaudeMapper(opts: ClaudeMapperOptions): ClaudeMapper {
  const now = opts.now ?? (() => Date.now());
  let open: string | null = null;

  // The three counters `diagnose()` reports on. They count what was SEEN and what was REFUSED, so
  // a zero-run session can say which of the two reasons it was.
  let runsOpened = 0;
  let promptShaped = 0; // string-content, non-compaction `user` records — candidates
  let refusedUnattributable = 0; // ...of those, refused for want of an attribution

  const closeOpenRun = (timestamp: number, stopReason?: string) => {
    if (open === null) return null;
    const runId = open;
    open = null;
    // No `outcome`. The Claude source reports that a turn ended and nothing more, so manufacturing
    // a `success` would assert what it never said — the tolerated no-outcome case (§3.1).
    return {
      runId,
      events: [
        runFinished({
          threadId: opts.threadId,
          runId,
          timestamp,
          ...(stopReason ? { cotal: { stopReason } } : {}),
        }),
      ] as AguiEvent[],
    };
  };

  const map: RecordMapper<ClaudeEntry> = (entry) => {
    const { ts, arrival } = stampOf(entry, now);
    const arrivalMeta = arrival ? { tsSource: "arrival" as const } : undefined;
    const uuid = entry.uuid ?? "";
    const events: AguiEvent[] = [];

    if (entry.type === "user") {
      const content = entry.message?.content;

      // Tool results. These are `user` entries by the harness's shape, not by authorship, and they
      // are mapped whatever the entry's origin says — an origin rule about PROMPTS must not reach
      // them, or a session's tool history disappears with its prompts.
      if (Array.isArray(content)) {
        content.forEach((b, i) => {
          if (b.type !== "tool_result" || !b.tool_use_id) return;
          events.push(
            toolCallResult({
              messageId: `${uuid}#${i}`,
              toolCallId: b.tool_use_id,
              content: resultContent(b.content),
              timestamp: ts,
              ...(b.is_error || arrivalMeta
                ? { cotal: { ...(b.is_error ? { isError: true } : {}), ...arrivalMeta } }
                : {}),
            }),
          );
        });
        return events.length > 0 && open !== null ? { runId: open, events } : null;
      }

      if (typeof content !== "string") return null;

      // NOT A TURN, EXCLUDED BY A POSITIVE MARKER rather than by falling through. A compaction
      // summary is a string-content `user` entry the harness writes to itself; it is the single
      // non-tool-result `user` entry in a 5938-record session, so anything that selects by absence
      // picks it up. Naming it is what stops it being "the one that got through".
      if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return null;

      // (A) RUN-OPENING — "did a turn begin?" — an ENUMERATION, never an inference.
      //
      // A turn-initiating input opens a run whatever authored it: an external observer asks what
      // work this agent did and what triggered it, not whether a person typed it. So `"channel"` —
      // a peer/mesh delivery — opens a run exactly as `"human"` does. That is the only change from
      // §3.1, whose table sent every non-human origin to nothing and therefore emitted NOTHING on an
      // agent-driven session.
      //
      // **KEYED ON `origin.kind`, NOT ON `promptSource`, and the difference is a category error I
      // made first.** `promptSource` is present on every submitted prompt in the captures available,
      // so a partition of those captures suggests it as the discriminator — but the captures contain
      // no `task-notification` and no local-command caveats, and §3.1's own measurement does:
      // `task-notification` × 5 and 81 absent-origin entries (caveats, heartbeats, resumed-session
      // summaries), all of which carry `promptSource: "system"` too. **A predicate inferred from a
      // partition is bounded by that partition's categories**, and this one would have opened runs
      // on harness plumbing. `promptSource` is corroboration; it is not the gate.
      //
      // Anything not enumerated FAILS LOUD — including a value a future harness adds.
      promptShaped += 1;
      const turnSource = runOpeningAttribution(entry);
      if (turnSource === null) {
        refusedUnattributable += 1;
        return null;
      }

      const prior = closeOpenRun(ts);
      const runId = opts.mintRunId();
      open = runId;
      runsOpened += 1;
      const messageId = `${uuid}#0`;

      /**
       * **AUTHORSHIP, NOT INITIATOR — the emitter must never republish a body this principal did
       * not author.** Run-opening and body-emission are separate decisions and this is the second
       * one. A peer/mesh delivery legitimately OPENS a run, because an observer asking what this
       * agent did is entitled to know a turn began and what triggered it; it does not follow that
       * the observer is entitled to the peer's words.
       *
       * §3.1's privacy argument is stated as already true — *"a `RUN_STARTED` attributed to a peer
       * republishes no message body"* — and it was NOT: this branch emitted
       * `TEXT_MESSAGE_CONTENT` with the peer's `content` verbatim, measured at 240 bytes in and 240
       * bytes out on a real session. `events.<owner>.<actor>` carries a DIFFERENT read ACL from the
       * channel the message arrived on, so that is a republication across an ACL boundary — the
       * exact failure §3.1's non-human exclusion existed to prevent, which the ruling correctly
       * moved off run-opening and which then had nothing enforcing it.
       *
       * So the run opens and the BODY IS WITHHELD. `cotal.turnSource` already tells a consumer a
       * peer began this turn, which is the fact an observer needs; the text is not.
       *
       * Deliberately NOT a redaction marker: a fixed placeholder would invent vocabulary §3.1 does
       * not define, and a placeholder string is one edit away from being a real delta again.
       */
      const selfAuthored = turnSource !== "channel";
      // The previous run's close rides the SAME unit as this run's open. They are one observation
      // of the source and must not be split across frames: a frame names ONE run (`packUnits`), so
      // returning them together lets the packer flush at the boundary, while returning them
      // separately would need a record that does not exist.
      return {
        runId,
        events: [
          ...(prior?.events ?? []),
          runStarted({
            threadId: opts.threadId,
            runId,
            timestamp: ts,
            cotal: { runIdSource: "connector", turnSource, ...arrivalMeta },
          }),
          ...(selfAuthored
            ? [
                textMessageStart({ messageId, timestamp: ts, role: "user", ...(arrivalMeta ? { cotal: arrivalMeta } : {}) }),
                textMessageContent({ messageId, delta: content, timestamp: ts }),
                textMessageEnd({ messageId, timestamp: ts }),
              ]
            : []),
        ] as AguiEvent[],
      };
    }

    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) return null;
    const runId = open;

    entry.message.content.forEach((b, i) => {
      const messageId = `${uuid}#${i}`;
      // The provider id is correlation metadata, never an identity. `stop_reason` rides the entry
      // that carries one, per §3.1.
      const meta = {
        ...(entry.message?.id ? { providerMessageId: entry.message.id } : {}),
        ...(entry.message?.stop_reason ? { stopReason: entry.message.stop_reason } : {}),
        ...arrivalMeta,
      };
      const cotal = Object.keys(meta).length > 0 ? { cotal: meta } : {};

      if (b.type === "text" && typeof b.text === "string") {
        events.push(
          textMessageStart({ messageId, timestamp: ts, role: "assistant", ...cotal }),
          textMessageContent({ messageId, delta: b.text, timestamp: ts }),
          textMessageEnd({ messageId, timestamp: ts }),
        );
        return;
      }
      if (b.type === "thinking" && opts.reasoning && typeof b.thinking === "string") {
        // `signature` is not read here and is not reachable from here. §3.5.
        events.push(
          reasoningMessageStart({ messageId, timestamp: ts, ...cotal }),
          reasoningMessageContent({ messageId, delta: b.thinking, timestamp: ts }),
          reasoningMessageEnd({ messageId, timestamp: ts }),
        );
        return;
      }
      if (b.type === "tool_use" && b.id) {
        // The FULL input, JSON-encoded. This is the line `tr-`'s `salient()` could not hold: it
        // guessed which argument mattered and dropped the rest, so a reader could not reconstruct
        // what the agent did.
        events.push(
          toolCallStart({
            toolCallId: b.id,
            toolCallName: b.name ?? "",
            timestamp: ts,
            parentMessageId: messageId,
            ...cotal,
          }),
          toolCallArgs({ toolCallId: b.id, delta: JSON.stringify(b.input ?? null), timestamp: ts }),
          toolCallEnd({ toolCallId: b.id, timestamp: ts }),
        );
      }
    });

    if (events.length === 0) return null;
    // With no run open there is no `runId` to name. Emitting under a minted one would invent a run
    // the source never started; the honest unit names the run it belongs to, and when there is
    // none the record maps to nothing and advances the cursor alone (`[P7]`).
    return runId === null ? null : { runId, events };
  };

  const diagnose = (): string | null => {
    if (runsOpened > 0) return null;
    if (promptShaped === 0)
      return (
        `agui-map: no run opened — this session contains no prompt-shaped record at all ` +
        `(no string-content, non-compaction \`user\` entry). Nothing was refused; there was nothing ` +
        `to refuse.`
      );
    return (
      `agui-map: NO RUN OPENED, and it was a refusal, not an empty session — ${refusedUnattributable} of ` +
      `${promptShaped} prompt-shaped record(s) carry neither an \`origin.kind\` this mapper enumerates ` +
      `nor \`promptSource: "sdk"\`, so none of them could be attributed and none opened a run. Every ` +
      `event downstream of a run is therefore absent BY DECISION. If these are real prompts, the ` +
      `harness has a provenance shape that has not been measured: measure it and add it to ` +
      `ORIGIN_RULE or ABSENT_ORIGIN_RULE deliberately.`
    );
  };

  return { map, closeOpenRun, openRun: () => open, diagnose };
}
