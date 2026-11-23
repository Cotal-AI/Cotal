/**
 * Maps OpenCode 2.x session records to AG-UI events, with the same arms and the same withholding as
 * the 1.x mapper (`agui-map.ts`). The source hands over only settled records, in session order, so
 * each record is mapped once, whole.
 *
 * - `text`      -> `TEXT_MESSAGE_*`, assistant only
 * - `reasoning` -> `REASONING_*`, off by default
 * - `tool`      -> `TOOL_CALL_START` / `ARGS` / `END` / `RESULT`, `toolCallId` is the native call id,
 *   then the `cotal.toolResult` marker with the element's own error status
 * - `user`      -> nothing of its own: it closes the open run, because a new turn began. Its text is
 *   never published, for the 1.x reason: a peer batch is prepended into the person's own prompt, so
 *   the record has no boundary between the two authors to filter on.
 * - `idle`      -> closes the open run with the outcome the server recorded: `failed` is `RUN_ERROR`,
 *   and `succeeded` and `interrupted` are `RUN_FINISHED` with no outcome, which says the run ended
 *   without claiming it succeeded. A stop someone pressed is not a failure. An execution that a
 *   rejected permission or a dismissed question interrupted records no `idle` (measured on 2.0.24),
 *   so `plugin2.ts` closes that run out of band and this mapper forgets it.
 * - every other message kind -> nothing, and it closes nothing.
 *
 * A turn that ends before its first element, such as one the provider refused, has no run open at
 * its `idle`, so that `idle` publishes a run of its own: its start at the turn's `user` record and
 * the `idle`'s terminal. A reader waiting on the turn then sees it end. An `idle` that ends no turn
 * of its own, such as one recorded after an out-of-band close, maps to nothing. Tool arguments and
 * results are mapped here and dropped by the emitter's egress policy before anything is written,
 * the one place that decides what leaves.
 *
 * A text or reasoning element that streamed through the delta journal (stream2.ts) publishes as it
 * streams, under its stream key, and its saved record ends that message. A run that closes with a
 * stream still open ends the stream first.
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
  runError,
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
import type { OpenCode2Element, OpenCode2Record } from "./agui-source2.js";
import { streamKey2 } from "./stream2.js";

export interface OpenCode2MapperOptions {
  /** The native session id: the `threadId` on every event. */
  threadId: string;
  /** Mints a `runId`. Connector-minted, so every `RUN_STARTED` carries `runIdSource: "connector"`. */
  mintRunId: () => string;
  /** The run the write-ahead log has open when this mapper is built, so a re-established plane
   *  attributes the next records to it. */
  resumeRunId?: string;
  /** Emit `REASONING_*` for reasoning elements. Off by default. */
  reasoning?: boolean;
  /** The stream state {@link streamSeed} rebuilt for a restarted emitter. */
  seed?: StreamSeed;
}

/** An element's own start time. A text element carries none, so it takes its message's. */
function stampOf(record: OpenCode2Record, element: OpenCode2Element): number {
  if (element.type === "text") return record.message.time.created;
  return element.time?.created ?? record.message.time.created;
}

/** A settled tool's result: its error's text when it failed, else its text content. */
function toolResultContent(state: Extract<OpenCode2Element, { type: "tool" }>["state"]): string {
  if (state.status === "error") return state.error?.message ?? "";
  return (state.content ?? []).map((c) => c.text ?? "").join("");
}

export interface OpenCode2Mapper {
  map: RecordMapper<OpenCode2Record>;
  /** {@link map} over the session's records with its delta journal read in among them: a journal
   *  line streams the elements it carries, and an element's saved record closes its stream. */
  mapMerged: RecordMapper<Merged<OpenCode2Record>>;
  /** Forget a run the emitter closed out of band. Keyed on the id, as 1.x's `forgetOpenRun` is, so a
   *  newer run opened before the report arrives stays open. */
  forgetOpenRun: (runId: string) => void;
}

/** A saved text or reasoning element as a message of its own, under its position id. */
function wholeElement(kind: "text" | "reasoning", messageId: string, text: string, ts: number, cotal: CotalMeta): AguiEvent[] {
  return kind === "text"
    ? [
        textMessageStart({ messageId, timestamp: ts, role: "assistant", cotal }),
        textMessageContent({ messageId, delta: text, timestamp: ts }),
        textMessageEnd({ messageId, timestamp: ts }),
      ]
    : [
        reasoningMessageStart({ messageId, timestamp: ts, cotal }),
        reasoningMessageContent({ messageId, delta: text, timestamp: ts }),
        reasoningMessageEnd({ messageId, timestamp: ts }),
      ];
}

export function createOpenCode2Mapper(opts: OpenCode2MapperOptions): OpenCode2Mapper {
  const streams = new StreamedParts(opts.seed);
  let open: string | null = opts.resumeRunId ?? null;
  /** When the turn no run has taken yet began: its `user` record's time. */
  let begunAt: number | undefined;

  const map: RecordMapper<OpenCode2Record> = (record) => {
    const { message, index, element } = record;
    const timestamp = message.time.created;

    if (message.type === "user" || message.type === "idle") {
      const begun = begunAt;
      begunAt = message.type === "user" ? timestamp : undefined;
      const events: AguiEvent[] = [];
      if (open === null) {
        if (message.type === "user" || begun === undefined) return null;
        open = opts.mintRunId();
        events.push(runStarted({ threadId: opts.threadId, runId: open, timestamp: begun, cotal: { runIdSource: "connector" } }));
      }
      const runId = open;
      open = null;
      const failed = message.type === "idle" && message.outcome === "failed";
      events.push(...streams.endAll(timestamp));
      events.push(failed
        ? runError({ message: message.error?.message || "opencode turn failed", timestamp, ...(message.error?.type ? { code: message.error.type } : {}) })
        : runFinished({ threadId: opts.threadId, runId, timestamp }));
      return { runId, events };
    }
    if (message.type !== "assistant" || element === undefined) return null;

    const ts = stampOf(record, element);
    const events: AguiEvent[] = [];
    if (open === null) {
      open = opts.mintRunId();
      begunAt = undefined;
      events.push(runStarted({ threadId: opts.threadId, runId: open, timestamp: ts, cotal: { runIdSource: "connector" } }));
    }
    const runId = open;
    // The element's position is its identity; the message id is kept for correlation only.
    const messageId = `${message.id}#${index}`;
    const cotal = { providerMessageId: message.id };

    if (element.type === "text" || (element.type === "reasoning" && opts.reasoning)) {
      // The element's ordinal among its message's elements of its kind names its stream.
      const ordinal = (message.content ?? []).slice(0, index).filter((e) => e.type === element.type).length;
      const closed = streams.saved(streamKey2(message.id, element.type, ordinal), element.text, ts);
      events.push(...closed.events);
      if (closed.mapAsNew && element.text) events.push(...wholeElement(element.type, messageId, element.text, ts, cotal));
    } else if (element.type === "tool") {
      const isError = element.state.status === "error";
      events.push(
        toolCallStart({ toolCallId: element.id, toolCallName: element.name, timestamp: ts, parentMessageId: messageId, cotal }),
        toolCallArgs({ toolCallId: element.id, delta: JSON.stringify(element.state.input ?? null), timestamp: ts }),
        toolCallEnd({ toolCallId: element.id, timestamp: ts }),
        toolCallResult({
          messageId: `${messageId}#result`,
          toolCallId: element.id,
          content: toolResultContent(element.state),
          timestamp: ts,
          ...(isError ? { cotal: { isError: true } } : {}),
        }),
        toolResultMarker({ toolCallId: element.id, isError, timestamp: ts }),
      );
    }

    return events.length === 0 ? null : { runId, events };
  };

  /** A journal line: the elements it streams, opening the turn's run at its first delta, and the end
   *  of each element the plugin abandoned. Reasoning streams only when it is published at all. */
  const mapDeltas = (line: Extract<Merged<OpenCode2Record>, { deltas: unknown }>): ReturnType<RecordMapper<OpenCode2Record>> => {
    const events = line.deltas.flatMap((d) => (d.kind === "reasoning" && !opts.reasoning ? [] : streams.delta(d, line.timestamp)));
    events.push(...streams.end(line.ends ?? [], line.timestamp));
    if (events.length === 0) return null;
    if (open === null) {
      open = opts.mintRunId();
      begunAt = undefined;
      events.unshift(runStarted({ threadId: opts.threadId, runId: open, timestamp: line.timestamp, cotal: { runIdSource: "connector" } }));
    }
    return { runId: open, events };
  };

  return {
    map,
    mapMerged: (r) => ("deltas" in r ? mapDeltas(r) : map(r.harness)),
    forgetOpenRun: (runId) => {
      if (open === runId) open = null;
    },
  };
}
