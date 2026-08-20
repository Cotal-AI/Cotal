/**
 * Maps OpenCode session records to AG-UI events.
 *
 * **The mapper is a transition machine over per-part state, not a pure function of a record**, for
 * the reason §3.2 gives: the bus re-emits `message.part.updated` for one part id as it streams. It
 * is fed from {@link OpenCodeSessionSource}, which hands over only SETTLED parts, in order, so the
 * transitions here are the ones that survive: a part arrives once, finished.
 *
 * **NO USER-AUTHORED TEXT IS EMITTED, EVER (§3.2, orchestrator ruling).** OpenCode injects a peer
 * batch by prepending it into the human's own text part, so a single part holds peer-authored and
 * human-authored content with no boundary in the record to filter on. The unit of authorship is
 * smaller than the smallest unit the store keeps. Content-parsing the injected header back out is
 * ruled out and is not to be built, prototyped, or left in a comment as an option: it would fail
 * OPEN the moment either formatter changed a character, and a boundary that depends on two
 * formatters agreeing forever is not a boundary. So user messages map to nothing at all.
 *
 * **REMOVAL NEEDS NO HOOK HERE, AND THAT IS A CONSEQUENCE RATHER THAN AN OVERSIGHT.** The ruling on
 * a reverted session is: publish only on finality, drop the per-part state for the vanished ids, log
 * the divergence once, keep going. Because the source hands over only settled parts, this mapper
 * holds no per-part state to drop: a part arrives once, complete, and is mapped in one shot. So the
 * divergence log is the source's, and there is nothing here for a revert to invalidate.
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
import type { OpenCodeRecord } from "./agui-source.js";

export interface OpenCodeMapperOptions {
  /** The native session id. It is the `threadId` on every event and nothing else may claim it. */
  threadId: string;
  /** Mints a `runId`. Connector-minted, so every `RUN_STARTED` carries `runIdSource: "connector"`. */
  mintRunId: () => string;
  /** Emit `REASONING_*` for reasoning parts. Off by default (§7 Q1). */
  reasoning?: boolean;
  /** Arrival clock, for the records carrying no usable source stamp. Injectable for determinism. */
  now?: () => number;
}

export interface OpenCodeMapper {
  map: RecordMapper<OpenCodeRecord>;
  /**
   * Close the open run at a boundary the record stream cannot see: `session.idle`, which §3.2 makes
   * the flush boundary. Returns `null` when nothing is open, so calling it twice cannot manufacture
   * a second `RUN_FINISHED` for the bracket machine to refuse.
   */
  closeOpenRun: (timestamp: number, stopReason?: string) => { runId: string; events: AguiEvent[] } | null;
  /** The run currently open, or `null`. */
  openRun: () => string | null;
  /**
   * Forget a run the emitter closed out of band. KEYED ON THE ID: the report can arrive after this
   * mapper has already opened a newer run, and clearing unconditionally would orphan that one, whose
   * events would then emit under no run at all and halt a session that had done nothing wrong.
   */
  forgetOpenRun: (runId: string) => void;
  /** Why this session opened no runs, or `null` once one has. A silent refusal is the defect. */
  diagnose: () => string | null;
}

/**
 * Which part types this mapper has an arm for, stated as a table rather than left implicit, because
 * the arms it does NOT have are a design decision and not an omission:
 *
 * - `text`      -> `TEXT_MESSAGE_*`, assistant only, `synthetic` and `ignored` skipped
 * - `reasoning` -> `REASONING_*`, off by default
 * - `tool`      -> `TOOL_CALL_START` / `ARGS` / `END` / `RESULT`, `toolCallId` is the native `callID`
 * - `step-start` and `step-finish` -> NOTHING IN v1. There is no step name and no shared key between
 *   them, so AG-UI's `STEP_STARTED` / `STEP_FINISHED`, which require a `stepName`, could only be
 *   emitted by inventing a name and pairing positionally. `step-finish` carries `cost` and `tokens`:
 *   it is a usage record wearing a step's name, and emitting it as a step boundary would tell a
 *   consumer that a phase ended when what happened is that token counts arrived. §3.2 routes that
 *   usage to `cotal.usage` on `RUN_FINISHED`, and NO SUCH MEMBER EXISTS on `CotalMeta` today, so v1
 *   drops it and the carrier is filed against the frame contract rather than invented here.
 * - `file`, `patch`, `snapshot`, `subtask`, `agent`, `retry`, `compaction` -> nothing in v1 (§3.4).
 *
 * **THERE IS NO `RUN_ERROR` ARM, AND THAT IS NOT AN OMISSION OF THIS CONNECTOR.** §3.2 maps
 * `session.error` to `RUN_ERROR`, and the vocabulary has the constructor, but NO emitter path
 * publishes one anywhere on this plane today: the holder exposes `adopt`, `flush` and `closeRun`,
 * and the already-merged Claude connector closes an errored turn the same way a normal one ends.
 * Reaching it means adding a method to the shared emitter, which is a vocabulary-adjacent change
 * that does not ride inside a connector cutover. A failed turn therefore ends with `RUN_FINISHED`
 * carrying NO outcome, which says the run ended and does not claim it succeeded, and the gap is
 * filed rather than papered over.
 */
const HANDLED = new Set(["text", "reasoning", "tool"]);

/** The source stamp, or an honest admission that we used arrival time. */
function stampOf(record: OpenCodeRecord, now: () => number): { ts: number; arrival: boolean } {
  // A TOOL part keeps its clock on `state.time`, not on `part.time`, so reading only `part.time`
  // would arrival-stamp every tool call in the session while a real source stamp sat one field away.
  const t =
    record.part.time?.start ??
    record.part.state?.time?.start ??
    record.part.time?.end ??
    record.message.time?.created;
  return typeof t === "number" && Number.isFinite(t) ? { ts: t, arrival: false } : { ts: now(), arrival: true };
}

/**
 * The result content of a settled tool part.
 *
 * A failed call's `output` is absent and its `error` carries the reason, so reading `output` alone
 * would publish an empty result for every failure and tell a reader the tool returned nothing.
 */
function toolResultContent(state: OpenCodeRecord["part"]["state"]): string {
  if (state?.status === "error") return state.error ?? "";
  return state?.output ?? "";
}

export function createOpenCodeMapper(opts: OpenCodeMapperOptions): OpenCodeMapper {
  const now = opts.now ?? (() => Date.now());
  let open: string | null = null;

  // What diagnose() reports on: a session that opened no runs must be able to say WHY, because
  // "nobody prompted it" and "the mapper refused everything" are byte-identical otherwise.
  let runsOpened = 0;
  let assistantRecords = 0;
  let handledParts = 0;

  const close = (timestamp: number, stopReason?: string) => {
    if (open === null) return null;
    const runId = open;
    open = null;
    // No `outcome`. OpenCode reports that a session went idle and nothing more, so manufacturing a
    // `success` would assert something the source never said.
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

  const map: RecordMapper<OpenCodeRecord> = (record) => {
    const { part, message } = record;
    const { ts, arrival } = stampOf(record, now);
    const arrivalMeta = arrival ? { tsSource: "arrival" as const } : undefined;

    // A user record ends the previous turn and contributes nothing of its own. Closing here matters:
    // without it a prompt that arrives before `session.idle` would leave the run open across a turn
    // boundary, and the next `RUN_STARTED` would be refused by the bracket machine.
    if (message.role !== "assistant") return close(ts);

    assistantRecords += 1;
    const events: AguiEvent[] = [];

    if (open === null) {
      open = opts.mintRunId();
      runsOpened += 1;
      events.push(
        runStarted({
          threadId: opts.threadId,
          runId: open,
          timestamp: ts,
          cotal: { runIdSource: "connector", ...arrivalMeta },
        }),
      );
    }
    const runId = open;

    if (HANDLED.has(part.type)) {
      // The part id IS the per-observation identity, so nothing has to be synthesized. The message
      // id is preserved for correlation and is never spent as `messageId`.
      const messageId = part.id;
      const cotal = { providerMessageId: part.messageID, ...arrivalMeta };

      if (part.type === "text" && !part.synthetic && !part.ignored && part.text) {
        handledParts += 1;
        events.push(
          textMessageStart({ messageId, timestamp: ts, role: "assistant", cotal }),
          textMessageContent({ messageId, delta: part.text, timestamp: ts }),
          textMessageEnd({ messageId, timestamp: ts }),
        );
      } else if (part.type === "reasoning" && opts.reasoning && part.text) {
        handledParts += 1;
        events.push(
          reasoningMessageStart({ messageId, timestamp: ts, cotal }),
          reasoningMessageContent({ messageId, delta: part.text, timestamp: ts }),
          reasoningMessageEnd({ messageId, timestamp: ts }),
        );
      } else if (part.type === "tool" && part.callID) {
        handledParts += 1;
        const isError = part.state?.status === "error";
        events.push(
          toolCallStart({
            toolCallId: part.callID,
            toolCallName: part.tool ?? "",
            timestamp: ts,
            parentMessageId: messageId,
            cotal,
          }),
          toolCallArgs({ toolCallId: part.callID, delta: JSON.stringify(part.state?.input ?? null), timestamp: ts }),
          toolCallEnd({ toolCallId: part.callID, timestamp: ts }),
          toolCallResult({
            // `messageId` is REQUIRED by the schema and must not collide with the call's own
            // observation id, which is already spent as `parentMessageId` above.
            messageId: `${part.id}#result`,
            toolCallId: part.callID,
            content: toolResultContent(part.state),
            timestamp: ts,
            ...(isError || arrivalMeta ? { cotal: { ...(isError ? { isError: true } : {}), ...arrivalMeta } } : {}),
          }),
        );
      }
    }

    // Nothing to say about this record. It maps to nothing and advances the cursor alone, which is
    // the documented behaviour for a record with no mapping rather than a silent drop: the arm
    // table above names every type this mapper handles and every type it deliberately does not.
    if (events.length === 0) return null;
    return { runId, events };
  };

  return {
    map,
    closeOpenRun: close,
    openRun: () => open,
    forgetOpenRun: (runId) => {
      if (open === runId) open = null;
    },
    diagnose: () => {
      if (runsOpened > 0) return null;
      if (assistantRecords === 0) {
        return "no runs: this session produced no assistant records, so nothing ever began a turn";
      }
      return `no runs: ${assistantRecords} assistant records were seen and none opened a run, which should be impossible and means this mapper is broken`;
    },
  };
}
