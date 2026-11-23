import {
  runStarted, runFinished, runError, textMessageStart, textMessageContent, textMessageEnd,
  reasoningMessageStart, reasoningMessageContent, reasoningMessageEnd,
  toolCallStart, toolCallArgs, toolCallEnd, toolCallResult, toolResultMarker, type RecordMapper, type AguiEvent,
} from "@cotal-ai/connector-core";

export interface PiSessionEntry {
  type: string;
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; id?: string; name?: string; arguments?: unknown; thinking?: string; redacted?: boolean }>;
    stopReason?: string;
    timestamp?: number;
    errorMessage?: string;
    toolCallId?: string;
    isError?: boolean;
  };
}

/** A tool result's content is an array of blocks. Text alone is joined as Pi joins it for display;
 *  any other block, such as an image, keeps the whole array JSON-encoded rather than dropped. */
function resultContent(content: unknown): string {
  const blocks = Array.isArray(content) ? (content as Array<{ type?: unknown; text?: unknown }>) : undefined;
  return blocks?.every((block) => block?.type === "text" && typeof block.text === "string")
    ? blocks.map((block) => block.text).join("\n")
    : JSON.stringify(content ?? null);
}

/**
 * True for a turn its user stopped. Pi records an abort while the reply streams as `aborted`. When
 * Escape lands during a tool call, Pi 0.84.3 records the next reply as an `error` carrying the
 * platform's AbortError text instead (measured live). A timeout's abort reads differently.
 */
function stopped(message: NonNullable<PiSessionEntry["message"]>): boolean {
  return message.stopReason === "aborted" || (message.stopReason === "error" && message.errorMessage === "This operation was aborted");
}

/** Pi persists completed messages, not live deltas. User messages have no separable peer authorship.
 *  `reasoning` emits `REASONING_*` for thinking blocks and is off by default. */
export function createPiMapper(threadId: string, resumedRun?: string, resumedTools: readonly string[] = [], reasoning = false): RecordMapper<PiSessionEntry> {
  let open = resumedRun;
  const tools = new Set(resumedTools);
  return (entry) => {
    if (entry.type === "message" && entry.message?.role === "toolResult") {
      const callId = entry.message.toolCallId;
      // A resumed transcript can begin after an old call but before its result. Its start was
      // never published here, so do not invent a matching end for an unknown call.
      if (!open || !callId || !tools.delete(callId)) return null;
      const ts = entry.message.timestamp ?? Date.parse(entry.timestamp ?? "");
      if (!Number.isFinite(ts)) throw new Error("Pi AG-UI: tool result has no valid timestamp");
      // The result follows its call's end, and the marker beside it tells a public reader that the
      // call finished and whether it failed, while the egress fence keeps the output on the rail.
      const isError = entry.message.isError === true;
      return {
        runId: open,
        events: [
          toolCallEnd({ toolCallId: callId, timestamp: ts }),
          toolCallResult({ messageId: `${callId}:result`, toolCallId: callId, content: resultContent(entry.message.content), timestamp: ts, cotal: { isError } }),
          toolResultMarker({ toolCallId: callId, isError, timestamp: ts }),
        ],
      };
    }
    if (entry.type !== "message" || entry.message?.role !== "assistant") return null;
    if (!entry.id || !Array.isArray(entry.message.content))
      throw new Error("Pi AG-UI: saved assistant entry lacks an id or content array");
    const ts = entry.message.timestamp ?? Date.parse(entry.timestamp ?? "");
    if (!Number.isFinite(ts)) throw new Error(`Pi AG-UI: assistant entry ${entry.id} has no valid timestamp`);
    const events: AguiEvent[] = [];
    if (!open) {
      open = entry.id;
      events.push(runStarted({ threadId, runId: open, timestamp: ts }));
    }
    const runId = open;
    for (const [index, part] of entry.message.content.entries()) {
      if (part.type === "text" && part.text) {
        const messageId = `${entry.id}:text:${index}`;
        events.push(textMessageStart({ messageId, timestamp: ts }));
        events.push(textMessageContent({ messageId, delta: part.text, timestamp: ts }));
        events.push(textMessageEnd({ messageId, timestamp: ts }));
      } else if (part.type === "thinking" && reasoning && part.thinking && !part.redacted) {
        // A redacted block holds Pi's placeholder text, not the model's reasoning.
        const messageId = `${entry.id}:thinking:${index}`;
        events.push(reasoningMessageStart({ messageId, timestamp: ts }));
        events.push(reasoningMessageContent({ messageId, delta: part.thinking, timestamp: ts }));
        events.push(reasoningMessageEnd({ messageId, timestamp: ts }));
      } else if (part.type === "toolCall") {
        if (!part.id || !part.name) throw new Error(`Pi AG-UI: tool call in ${entry.id} lacks native id/name`);
        tools.add(part.id);
        events.push(toolCallStart({ toolCallId: part.id, toolCallName: part.name, timestamp: ts }));
        events.push(toolCallArgs({ toolCallId: part.id, delta: JSON.stringify(part.arguments ?? null), timestamp: ts }));
      }
    }
    if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") {
      for (const toolCallId of tools) events.push(toolCallEnd({ toolCallId, timestamp: ts }));
      tools.clear();
      // A stopped turn did not fail, so it ends as an interrupt.
      events.push(stopped(entry.message)
        ? runFinished({ threadId, runId, timestamp: ts, outcome: { type: "interrupt", interrupts: [{ id: entry.id, reason: "aborted" }] } })
        : runError({ message: entry.message.errorMessage || entry.message.stopReason, timestamp: ts }));
      open = undefined;
    } else if (entry.message.stopReason === "stop" || entry.message.stopReason === "length") {
      if (tools.size) throw new Error(`Pi AG-UI: terminal assistant entry ${entry.id} has unclosed native tool calls`);
      events.push(runFinished({ threadId, runId, timestamp: ts }));
      open = undefined;
    } else if (entry.message.stopReason !== "toolUse") {
      throw new Error(`Pi AG-UI: unsupported native stop reason ${String(entry.message.stopReason)}`);
    }
    return { runId, events };
  };
}
