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
 * THREE THINGS THE PLAN DID NOT SETTLE.
 *
 * **(A) The record stream cannot see a turn end.** A hook fires in a different process and writes
 * no JSONL record, so on records alone a run closes only when the next prompt opens one, and the
 * last run of a session never closes. The `Stop` and `StopFailure` hooks therefore close the open
 * run through the emitter holder (`AguiEmitterHolder.closeRun`) at the real boundary, and the
 * holder reports the closed run back through {@link ClaudeMapper.forgetOpenRun}.
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
 * **AND IT IS EXERCISED ELSEWHERE — read the mapping rationale below before reading these numbers as
 * a defect.** That section measured a real session a person was driving and counted `kind:"human"`
 * **44 times**, with `promptSource: "typed"`/`"queued"`, beside 3068 `kind:"channel"` injections. So
 * the predicate does select, on a session that contains the thing it selects. The three captures
 * here simply contain none. **Both numbers belong together; either alone misleads.**
 *
 * **WHAT OPENS A RUN WHEN NOBODY TYPES.** A mapping that sends every non-`human` origin to
 * *nothing* opens no run on an agent-driven session, and the connector emits nothing there. The
 * session the mapping was derived from had a human typing 44 times alongside its 3068 mesh
 * messages; a spawned lane seat has **0 and 67**.
 *
 * **THE RULE: run-opening and attribution are two predicates, not one doing both jobs.** A run
 * opens only on an `origin.kind` that {@link ORIGIN_RULE} ENUMERATES as a turn, never on an
 * inferred one; the same table names the kinds that are known and not a turn, and absent `origin`
 * gets its own enumeration over `promptSource` in {@link ABSENT_ORIGIN_RULE}. Attribution rides as
 * `cotal.turnSource` — **a field on the run, never a gate on it**. The privacy argument holds: a
 * `RUN_STARTED` attributed to a peer republishes no message body, so a peer-initiated turn can be a
 * turn without re-emitting the peer's content. The values live only in those two tables.
 *
 * On the 5938-record session the real mapper opens **67 runs** and emits **5217 events**.
 *
 * **DO NOT "FIX" THIS BY TREATING ABSENT `origin` AS HUMAN.** In a Claude session `user` is also the
 * role of a TOOL RESULT: that predicate selects **825** of the interactive session's 892 user
 * entries, and the single non-tool-result among them is a **context-compaction summary**
 * (`isCompactSummary`), so the true human count is 0 and the predicate over-matches by 825. It would
 * not emit nothing — it would emit a flood, each entry opening a run, which looks like the connector
 * working.
 *
 * **The rule is not guessed at.** `promptSource` is not the selector: it is bounded by the
 * partition it was inferred from, and "sdk" also covers programmatic injection. It is read only
 * inside {@link ABSENT_ORIGIN_RULE}, where there is no `origin.kind` to enumerate — a second table
 * rather than a synthetic member, because an enumeration over `origin.kind` cannot classify a
 * record that has none. Every value outside either table **fails loud** rather than being silently
 * treated as not-a-turn.
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
   * it is `"system"` on task-notifications and caveats too. Read ONLY where `origin` is absent,
   * against the values `ABSENT_ORIGIN_RULE` enumerates.
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
 * the measurement this mapping was derived from. `task-notification` is harness plumbing and is
 * named as not-a-turn rather than left to fall through — the distinction between "we decided no"
 * and "nothing matched" is the whole difference between a rule and an accident.
 *
 * An `origin.kind` outside this table THROWS. A provenance field's entire product is an external
 * observer's belief about who caused something, so a value a future harness adds must produce an
 * error rather than a confident wrong attribution. `CotalMeta.turnSource` carries `"unknown"` for
 * producers that never set the field; the mapper never writes it.
 */
const ORIGIN_RULE: Record<string, "human" | "channel" | "auto-continuation" | null> = {
  human: "human",
  channel: "channel", // a peer/mesh delivery IS a turn
  "task-notification": null, // known, and deliberately not a turn
  // MEASURED ON THIS MACHINE'S CORPUS, 237 session files and 531,882 records: 4 occurrences, every
  // one a standing goal the harness re-injects to continue work, all carrying
  // `promptSource: "system"`. It opens a run because a run is work that began, and this input is
  // what began it; an observer asking what the agent did and what triggered it is owed the answer
  // "the harness continued itself", which is neither a person nor a peer. So it is attributed as
  // itself rather than folded into either.
  //
  // WITHOUT THIS KEY THE MAPPER THROWS IN PRODUCTION on a value that is already in the corpus, and
  // the throw is the correct behaviour for an unmeasured provenance. Adding it is what a
  // measurement buys; guessing at it is what the throw exists to prevent.
  "auto-continuation": "auto-continuation",
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
 * **THIS IS NOT `promptSource`-PRESENCE.** That predicate asks "is the field there?", and the field
 * is there on task-notifications and caveats as `"system"`, so it would open runs on harness
 * plumbing. This asks "is the value exactly `sdk`?", in a branch that only runs when `origin` is
 * absent, against a two-value measured population. Different predicate, different position,
 * measured rather than inferred from a partition of three captures.
 */
const ABSENT_ORIGIN_RULE: Record<string, "sdk" | "human" | null> = {
  sdk: "sdk",
  // MEASURED, 6 occurrences across the same 237-file corpus, and READ rather than counted: every
  // one is a person typing, each a file path followed by a question about it. They carry no
  // `origin` because the harness does not stamp one on this shape, not because nobody authored
  // them.
  //
  // Without this key the mapper THROWS on these records, which is why they were read and not
  // assumed. A throw here is a session that stops mapping mid-stream; attributing these to anything
  // other than the person who typed them would be the confident wrong attribution the enumeration
  // exists to prevent.
  typed: "human",
  // **FROM §3.1's CORPUS, NOT THE 88-SESSION SWEEP ABOVE**, which finds this value on an
  // absent-origin `user` record ZERO times in 129,910 records. §3.1's table records it 81 times, as
  // "local-command caveats, heartbeats, resumed-session summaries", on a capture with 4728 `user`
  // entries and 3068 `channel` deliveries — and **no session in the sweep matches that shape**; the
  // closest has 18 human and 0 channel. So the two measurements are over different corpora, and
  // §3.1's capture is not available to re-read.
  //
  // It is entered as `null` — known, and NOT a turn — because §3.1 already classified it and a
  // measurement that cannot be repeated is still a measurement. Leaving it out would make the throw
  // below fire in production on a class the plan documents, which is the one thing a fail-loud
  // branch must not do: **a fail-loud branch is only safe if you know what is on the other side of
  // it.**
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
const runOpeningAttribution = (entry: ClaudeEntry): "human" | "channel" | "sdk" | "auto-continuation" | null => {
  const kind = entry.origin?.kind;
  if (kind === undefined) {
    // ABSENT origin. Not an error — absence is a known shape — and not a blanket refusal either,
    // because a headless prompt has no `origin` and IS a turn.
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

/** What {@link createClaudeMapper} returns: the mapper plus the report of a run the emitter closed. */
export interface ClaudeMapper {
  map: RecordMapper<ClaudeEntry>;
  /**
   * Forget a run the EMITTER closed out of band, so this mapper stops treating it as open.
   *
   * Two things close a run now, and they do not share state. The mapper closes one when the record
   * stream shows a new turn beginning. The emitter closes one when a lifecycle hook says the turn
   * ended, which is a boundary no record describes. After the second kind, the mapper still believes
   * a run is open: it would attribute the next records to a run the stream has already finished, and
   * the bracket machine would refuse the second terminal it eventually emitted. The emitter reports
   * what it closed, and this is where that report lands.
   *
   * KEYED ON THE ID, and that is the whole safety of it. The report arrives asynchronously, so by
   * the time it does the mapper may already have opened a NEWER run from a record that landed in
   * between. Clearing unconditionally would orphan that one: its events would emit under no run at
   * all, which the brackets refuse, and the session would halt on a frame it had every right to
   * send. A run that is not the one named is left exactly as it is.
   */
  forgetOpenRun: (runId: string) => void;
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
      // AN ARRAY IS TWO DIFFERENT RECORDS WEARING ONE SHAPE, and reading it as only the first one
      // DROPS REAL HUMAN TURNS. A `user` entry carries an array both when the harness reports tool
      // results and when a person attaches something to a prompt, and the second case is not rare:
      // 8 of them sit in this machine's corpus, every one a person sending an attachment with a
      // question about it. Returning early on any array would make each of those turns produce
      // NOTHING, which an observer reads as an agent that did work nobody asked for.
      //
      // The discriminator is the presence of a `tool_result` block, not the array-ness.
      const toolResults = Array.isArray(content) ? content.filter((b) => b.type === "tool_result" && b.tool_use_id) : [];
      if (toolResults.length > 0) {
        (content as ClaudeBlock[]).forEach((b, i) => {
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

      // The prompt body. A string entry is its own body; an array entry with no tool results is a
      // prompt with attachments, whose body is the text a person actually typed. Non-text blocks
      // are deliberately not rendered into it: an attachment is not prose, and inventing a
      // placeholder for it would put vocabulary on the wire that no consumer is defined to read.
      const promptText =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text!).join("\n")
            : null;
      if (promptText === null) return null;

      // NOT A TURN, EXCLUDED BY A POSITIVE MARKER rather than by falling through. A compaction
      // summary is a string-content `user` entry the harness writes to itself; it is the single
      // non-tool-result `user` entry in a 5938-record session, so anything that selects by absence
      // picks it up. Naming it is what stops it being "the one that got through".
      if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return null;

      // (A) RUN-OPENING — "did a turn begin?" — an ENUMERATION, never an inference.
      //
      // A turn-initiating input opens a run whatever authored it: an external observer asks what
      // work this agent did and what triggered it, not whether a person typed it. So `"channel"` —
      // a peer/mesh delivery — opens a run exactly as `"human"` does, where §3.1's table sent every
      // non-human origin to nothing and therefore emitted NOTHING on an agent-driven session.
      //
      // **KEYED ON `origin.kind`, NOT ON `promptSource`, and keying on `promptSource` is a category
      // error.** `promptSource` is present on every submitted prompt in the captures available,
      // so a partition of those captures suggests it as the discriminator — but the captures contain
      // no `task-notification` and no local-command caveats, and §3.1's own measurement does:
      // `task-notification` × 5 and 81 absent-origin entries (caveats, heartbeats, resumed-session
      // summaries), all of which carry `promptSource: "system"` too. **A predicate inferred from a
      // partition is bounded by that partition's categories**, and this one would open runs on
      // harness plumbing. `promptSource` is corroboration; it is not the gate.
      //
      // Anything not enumerated FAILS LOUD — including a value a future harness adds.
      const turnSource = runOpeningAttribution(entry);
      if (turnSource === null) return null;

      const prior = open;
      const runId = opts.mintRunId();
      open = runId;
      const messageId = `${uuid}#0`;

      /**
       * **AUTHORSHIP, NOT INITIATOR — the emitter must never republish a body this principal did
       * not author.** Run-opening and body-emission are separate decisions and this is the second
       * one. A peer/mesh delivery legitimately OPENS a run, because an observer asking what this
       * agent did is entitled to know a turn began and what triggered it; it does not follow that
       * the observer is entitled to the peer's words.
       *
       * §3.1's privacy argument is stated as already true — *"a `RUN_STARTED` attributed to a peer
       * republishes no message body"* — and this branch is what makes it true. Emitting
       * `TEXT_MESSAGE_CONTENT` here would carry the peer's `content` verbatim, and
       * `events.<owner>.<actor>` carries a DIFFERENT read ACL from the channel the message arrived
       * on, so that is a republication across an ACL boundary — the exact failure §3.1's non-human
       * exclusion exists to prevent, and which nothing else enforces once a peer delivery opens a
       * run.
       *
       * So the run opens and the BODY IS WITHHELD. `cotal.turnSource` already tells a consumer a
       * peer began this turn, which is the fact an observer needs; the text is not.
       *
       * Deliberately NOT a redaction marker: a fixed placeholder would invent vocabulary §3.1 does
       * not define, and a placeholder string is one edit away from being a real delta again.
       */
      const selfAuthored = turnSource !== "channel";
      // An attachment-only prompt has no text to carry. The run still opens, because a turn still
      // began, but an empty `TEXT_MESSAGE_CONTENT` would assert the person said nothing rather than
      // that they sent something this plane does not carry.
      const carriesBody = selfAuthored && promptText.length > 0;
      // The previous run's close rides the SAME unit as this run's open. They are one observation
      // of the source and must not be split across frames: a frame names ONE run (`packUnits`), so
      // returning them together lets the packer flush at the boundary, while returning them
      // separately would need a record that does not exist. That close carries no `outcome`: a new
      // prompt says a turn began and nothing about how the last one ended, so a `success` would
      // assert what the source never said (the tolerated no-outcome case, §3.1).
      return {
        runId,
        events: [
          ...(prior === null ? [] : [runFinished({ threadId: opts.threadId, runId: prior, timestamp: ts })]),
          runStarted({
            threadId: opts.threadId,
            runId,
            timestamp: ts,
            cotal: { runIdSource: "connector", turnSource, ...arrivalMeta },
          }),
          ...(carriesBody
            ? [
                textMessageStart({ messageId, timestamp: ts, role: "user", ...(arrivalMeta ? { cotal: arrivalMeta } : {}) }),
                textMessageContent({ messageId, delta: promptText, timestamp: ts }),
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

  const forgetOpenRun = (runId: string): void => {
    if (open === runId) open = null;
  };

  return { map, forgetOpenRun };
}
