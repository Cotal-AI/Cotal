/**
 * Maps OpenCode 2.x session records to AG-UI events, with the same arms and the same withholding as
 * the 1.x mapper (`agui-map.ts`). The source hands over only settled records, in session order, so
 * each record is mapped once, whole.
 *
 * - `text`      -> `TEXT_MESSAGE_*`, assistant only
 * - `reasoning` -> `REASONING_*`, off by default
 * - `tool`      -> `TOOL_CALL_START` / `ARGS` / `END` / `RESULT`, `toolCallId` is the native call id
 * - `user`      -> nothing of its own: it closes the open run, because a new turn began. Its text is
 *   never published, for the 1.x reason: a peer batch is prepended into the person's own prompt, so
 *   the record has no boundary between the two authors to filter on.
 * - `idle`      -> closes the open run with the outcome the server recorded: `failed` is `RUN_ERROR`,
 *   and `succeeded` and `interrupted` are `RUN_FINISHED` with no outcome, which says the run ended
 *   without claiming it succeeded. A stop someone pressed is not a failure.
 * - every other message kind -> nothing, and it closes nothing.
 *
 * A turn that ends before its first element opened no run, so its `idle` has nothing to close and
 * publishes nothing, as on 1.x. Tool arguments and results are mapped here and dropped by the
 * emitter's egress policy before anything is written, the one place that decides what leaves.
 */
import {
  type AguiEvent,
  type RecordMapper,
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
  reasoningMessageStart,
  reasoningMessageContent,
  reasoningMessageEnd,
} from "@cotal-ai/connector-core";
import type { OpenCode2Element, OpenCode2Record } from "./agui-source2.js";

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

export function createOpenCode2Mapper(opts: OpenCode2MapperOptions): RecordMapper<OpenCode2Record> {
  let open: string | null = opts.resumeRunId ?? null;

  return (record) => {
    const { message, index, element } = record;
    const timestamp = message.time.created;

    if (message.type === "user" || message.type === "idle") {
      if (open === null) return null;
      const runId = open;
      open = null;
      const failed = message.type === "idle" && message.outcome === "failed";
      const terminal = failed
        ? runError({ message: message.error?.message || "opencode turn failed", timestamp, ...(message.error?.type ? { code: message.error.type } : {}) })
        : runFinished({ threadId: opts.threadId, runId, timestamp });
      return { runId, events: [terminal] };
    }
    if (message.type !== "assistant" || element === undefined) return null;

    const ts = stampOf(record, element);
    const events: AguiEvent[] = [];
    if (open === null) {
      open = opts.mintRunId();
      events.push(runStarted({ threadId: opts.threadId, runId: open, timestamp: ts, cotal: { runIdSource: "connector" } }));
    }
    const runId = open;
    // The element's position is its identity; the message id is kept for correlation only.
    const messageId = `${message.id}#${index}`;
    const cotal = { providerMessageId: message.id };

    if (element.type === "text" && element.text) {
      events.push(
        textMessageStart({ messageId, timestamp: ts, role: "assistant", cotal }),
        textMessageContent({ messageId, delta: element.text, timestamp: ts }),
        textMessageEnd({ messageId, timestamp: ts }),
      );
    } else if (element.type === "reasoning" && opts.reasoning && element.text) {
      events.push(
        reasoningMessageStart({ messageId, timestamp: ts, cotal }),
        reasoningMessageContent({ messageId, delta: element.text, timestamp: ts }),
        reasoningMessageEnd({ messageId, timestamp: ts }),
      );
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
      );
    }

    return events.length === 0 ? null : { runId, events };
  };
}
