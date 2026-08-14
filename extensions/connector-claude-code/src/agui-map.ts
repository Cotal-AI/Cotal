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
 * **(B) `origin.kind === "human"` MATCHES NOTHING IN A REAL SESSION — MEASURED, on both shapes, and
 * this is why the mapping smoke reads a real session rather than a fixture.** §3.1's rule is right
 * about what it excludes (peer/mesh injections, task notifications, resumed-session summaries). What
 * it does not do is select anything:
 *
 *   - **headless / SDK** (`claude -p`), 30 records, 5 user entries: `origin` ABSENT from every one.
 *   - **interactive**, 5938 records, 892 user entries: `origin` absent from 825, and present on 67
 *     — every one of them `kind: "channel"`, a Cotal mesh delivery. `kind: "human"` occurs **zero**
 *     times.
 *
 * An earlier revision of this comment recorded (B) as HEADLESS-ONLY and said the interactive case
 * was fine. That was wrong and a real interactive session is what falsified it: a human turn is
 * simply a `user` entry with no `origin` at all. Applied to either shape the rule emits ZERO
 * prompts, and because an assistant observation cannot name a run that was never opened, **a real
 * session maps to no events whatsoever** — the exact regression §3.1 says omitting prompts would be.
 *
 * **The rule is implemented exactly as specified and is NOT patched here.** Extending it to
 * `promptSource`, or to "a user entry with no origin", would be putting a guess in the connector:
 * "sdk" also covers programmatic injection, and over-emitting republishes other people's content
 * onto a channel with a different read ACL, which is the worse failure of the two. Escalated as a
 * plan defect against §3.1 rather than decided here. The smoke asserts the CONSEQUENCE, with a
 * control requiring the mapper to open a run on a genuine `origin.kind === "human"` entry, so
 * "opens no run" is a statement about the data and not about a broken rule.
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
  message?: {
    id?: string;
    stop_reason?: string | null;
    content?: string | ClaudeBlock[];
  };
}

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

      // A prompt — and ONLY when `origin.kind === "human"` (§3.1). Everything else with string
      // content is injected rather than authored: peer/mesh messages, task notifications,
      // local-command caveats, resumed-session summaries. Re-emitting those would republish facts
      // the mesh already carries onto a channel with a different read ACL. See gap (B): on a
      // headless session this branch is never taken, and the smoke asserts that rather than hiding
      // it.
      if (typeof content !== "string" || entry.origin?.kind !== "human") return null;

      const prior = closeOpenRun(ts);
      const runId = opts.mintRunId();
      open = runId;
      const messageId = `${uuid}#0`;
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
            cotal: { runIdSource: "connector", ...arrivalMeta },
          }),
          textMessageStart({ messageId, timestamp: ts, role: "user", ...(arrivalMeta ? { cotal: arrivalMeta } : {}) }),
          textMessageContent({ messageId, delta: content, timestamp: ts }),
          textMessageEnd({ messageId, timestamp: ts }),
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

  return { map, closeOpenRun, openRun: () => open };
}
