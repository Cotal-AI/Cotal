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
 * divergence log is the source's, and there is nothing here for a revert to invalidate. A part
 * that streamed through the delta journal (stream1.ts) is the one exception: its stream stays open
 * until its saved record or the turn's end closes it.
 */
import {
  type AguiEvent,
  type CotalMeta,
  type Merged,
  type RecordMapper,
  StreamedParts,
  type StreamSeed,
  runStarted,
  runFinished,
  textMessageStart,
  textMessageContent,
  textMessageEnd,
  toolCallStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  toolResultMarker,
  reasoningMessageStart,
  reasoningMessageContent,
  reasoningMessageEnd,
} from "@cotal-ai/connector-core";
import type { OpenCodeRecord } from "./agui-source.js";
import { streamKey1 } from "./stream1.js";

interface OpenCodeMapperOptions {
  /** The native session id. It is the `threadId` on every event and nothing else may claim it. */
  threadId: string;
  /** Mints a `runId`. Connector-minted, so every `RUN_STARTED` carries `runIdSource: "connector"`. */
  mintRunId: () => string;
  /** The run the write-ahead log has open when this mapper is built, so a mapper built for a
   *  re-established plane attributes the next records to it instead of dropping them. */
  resumeRunId?: string;
  /** Emit `REASONING_*` for reasoning parts. Off by default (§7 Q1). */
  reasoning?: boolean;
  /** The stream state {@link streamSeed} rebuilt for a restarted emitter. */
  seed?: StreamSeed;
  /** Arrival clock, for the records carrying no usable source stamp. Injectable for determinism. */
  now?: () => number;
}

export interface OpenCodeMapper {
  map: RecordMapper<OpenCodeRecord>;
  /** {@link map} over the session's records with its delta journal read in among them: a journal
   *  line streams the parts it carries, and a part's saved record closes its stream. */
  mapMerged: RecordMapper<Merged<OpenCodeRecord>>;
  /**
   * Forget a run the emitter closed out of band. KEYED ON THE ID: the report can arrive after this
   * mapper has already opened a newer run, and clearing unconditionally would orphan that one, whose
   * events would then emit under no run at all and halt a session that had done nothing wrong.
   */
  forgetOpenRun: (runId: string) => void;
}

/**
 * Which part types this mapper has an arm for, stated as a table rather than left implicit, because
 * the arms it does NOT have are a design decision and not an omission:
 *
 * - `text`      -> `TEXT_MESSAGE_*`, assistant only, `synthetic` and `ignored` skipped
 * - `reasoning` -> `REASONING_*`, off by default
 * - `tool`      -> `TOOL_CALL_START` / `ARGS` / `END` at its call record, which the source hands over
 *   once the tool runs, and `TOOL_CALL_RESULT` then the `cotal.toolResult` marker with the part's own
 *   error status at its result record. `toolCallId` is the native `callID`. The egress fence drops the
 *   result, so the marker is what tells a public reader that the call finished and whether it failed.
 * - `step-start` and `step-finish` -> NOTHING IN v1. There is no step name and no shared key between
 *   them, so AG-UI's `STEP_STARTED` / `STEP_FINISHED`, which require a `stepName`, could only be
 *   emitted by inventing a name and pairing positionally. `step-finish` carries `cost` and `tokens`:
 *   it is a usage record wearing a step's name, and emitting it as a step boundary would tell a
 *   consumer that a phase ended when what happened is that token counts arrived. §3.2 routes that
 *   usage to `cotal.usage` on `RUN_FINISHED`. `CotalMeta.usage` is that carrier, and filling it is
 *   a change of its own, so v1 still drops the numbers.
 * - `file`, `patch`, `snapshot`, `subtask`, `agent`, `retry`, `compaction` -> nothing in v1 (§3.4).
 * - `assistant-header` -> opens the run before the model answers. A failed turn with no parts
 *   still has this record, and `session.error` closes its run.
 *
 * **THERE IS NO `RUN_ERROR` ARM HERE, AND THAT IS A STATEMENT ABOUT WHERE IT LIVES.**
 * §3.2 maps `session.error` to `RUN_ERROR`, and a failed turn IS published as one — but not from
 * this file, because `session.error` is a BUS event and never a record in the session store this
 * mapper reads. It is a turn boundary the record stream cannot see, exactly like the finish, so it
 * closes the run through the same out-of-band path: `plugin.ts` decides which errors are failed
 * turns and hands the reason to `AguiEmitterHolder.closeRun`.
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

/** A tool part's call: its start, its whole input and its end. The part id IS the per-observation
 *  identity, so nothing has to be synthesized. */
function toolCall(part: OpenCodeRecord["part"], toolCallId: string, ts: number, cotal: CotalMeta): AguiEvent[] {
  return [
    toolCallStart({ toolCallId, toolCallName: part.tool ?? "", timestamp: ts, parentMessageId: part.id, cotal }),
    toolCallArgs({ toolCallId, delta: JSON.stringify(part.state?.input ?? null), timestamp: ts }),
    toolCallEnd({ toolCallId, timestamp: ts }),
  ];
}

/** A settled tool part's result, then the result marker with the part's own error status. */
function toolResult(part: OpenCodeRecord["part"], toolCallId: string, ts: number, arrivalMeta: CotalMeta | undefined): AguiEvent[] {
  const isError = part.state?.status === "error";
  return [
    toolCallResult({
      // `messageId` is REQUIRED by the schema and must not collide with the call's own observation
      // id, which the call spends as `parentMessageId`.
      messageId: `${part.id}#result`,
      toolCallId,
      content: toolResultContent(part.state),
      timestamp: ts,
      ...(isError || arrivalMeta ? { cotal: { ...(isError ? { isError: true } : {}), ...arrivalMeta } } : {}),
    }),
    toolResultMarker({ toolCallId, isError, timestamp: ts, ...(arrivalMeta ? { cotal: arrivalMeta } : {}) }),
  ];
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
  const streams = new StreamedParts(opts.seed);
  let open: string | null = opts.resumeRunId ?? null;

  const close = (timestamp: number) => {
    if (open === null) return null;
    const runId = open;
    open = null;
    // No `outcome`. A user record says a new turn began and nothing about how the last one ended,
    // so manufacturing a `success` would assert something the source never said. A part still
    // streaming is ended first, because a run cannot close while a message is open.
    return {
      runId,
      events: [
        ...streams.endAll(timestamp),
        runFinished({
          threadId: opts.threadId,
          runId,
          timestamp,
        }),
      ] as AguiEvent[],
    };
  };

  /** A saved text or reasoning part: the close of what streamed under its key, then the part as a
   *  message of its own, under its id, when nothing streamed or the saved text does not continue
   *  what did. */
  const savedPart = (kind: "text" | "reasoning", part: OpenCodeRecord["part"], ts: number, cotal: CotalMeta): AguiEvent[] => {
    const text = part.text ?? "";
    const closed = streams.saved(streamKey1(part.id), text, ts);
    if (!closed.mapAsNew || !text) return closed.events;
    const messageId = part.id;
    return kind === "text"
      ? [
          ...closed.events,
          textMessageStart({ messageId, timestamp: ts, role: "assistant", cotal }),
          textMessageContent({ messageId, delta: text, timestamp: ts }),
          textMessageEnd({ messageId, timestamp: ts }),
        ]
      : [
          ...closed.events,
          reasoningMessageStart({ messageId, timestamp: ts, cotal }),
          reasoningMessageContent({ messageId, delta: text, timestamp: ts }),
          reasoningMessageEnd({ messageId, timestamp: ts }),
        ];
  };

  /** A journal line: the parts it streams, opening the turn's run at its first delta, and the end
   *  of each part the plugin abandoned. Reasoning streams only when it is published at all. */
  const mapDeltas = (line: Extract<Merged<OpenCodeRecord>, { deltas: unknown }>): ReturnType<RecordMapper<OpenCodeRecord>> => {
    const events = line.deltas.flatMap((d) => (d.kind === "reasoning" && !opts.reasoning ? [] : streams.delta(d, line.timestamp)));
    events.push(...streams.end(line.ends ?? [], line.timestamp));
    if (events.length === 0) return null;
    if (open === null) {
      open = opts.mintRunId();
      events.unshift(runStarted({ threadId: opts.threadId, runId: open, timestamp: line.timestamp, cotal: { runIdSource: "connector" } }));
    }
    return { runId: open, events };
  };

  const map: RecordMapper<OpenCodeRecord> = (record) => {
    const { part, message } = record;
    const { ts, arrival } = stampOf(record, now);
    const arrivalMeta = arrival ? { tsSource: "arrival" as const } : undefined;

    // A user record ends the previous turn and contributes nothing of its own. Closing here matters:
    // without it a prompt that arrives before `session.idle` would leave the run open across a turn
    // boundary, and the next `RUN_STARTED` would be refused by the bracket machine.
    if (message.role !== "assistant") return close(ts);

    const events: AguiEvent[] = [];

    if (open === null) {
      open = opts.mintRunId();
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
      // The message id is preserved for correlation and is never spent as `messageId`.
      const cotal = { providerMessageId: part.messageID, ...arrivalMeta };

      if (part.type === "text" && !part.synthetic && !part.ignored) {
        events.push(...savedPart("text", part, ts, cotal));
      } else if (part.type === "reasoning" && opts.reasoning) {
        events.push(...savedPart("reasoning", part, ts, cotal));
      } else if (part.type === "tool" && part.callID) {
        events.push(...(record.call ? toolCall(part, part.callID, ts, cotal) : toolResult(part, part.callID, ts, arrivalMeta)));
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
    mapMerged: (r) => ("deltas" in r ? mapDeltas(r) : map(r.harness)),
    forgetOpenRun: (runId) => {
      if (open === runId) open = null;
    },
  };
}
