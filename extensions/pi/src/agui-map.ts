import {
  runStarted, runFinished, runError, textMessageStart, textMessageContent, textMessageEnd,
  toolCallStart, toolCallEnd, type RecordMapper, type AguiEvent,
} from "@cotal-ai/connector-core";

export interface PiSessionEntry {
  type: string;
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; id?: string; name?: string }>;
    stopReason?: string;
    timestamp?: number;
    errorMessage?: string;
    toolCallId?: string;
  };
}

/** Pi persists completed messages, not live deltas. User messages have no separable peer authorship. */
export function createPiMapper(threadId: string, resumedRun?: string, resumedTools: readonly string[] = []): RecordMapper<PiSessionEntry> {
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
      return { runId: open, events: [toolCallEnd({ toolCallId: callId, timestamp: ts })] };
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
      } else if (part.type === "toolCall") {
        if (!part.id || !part.name) throw new Error(`Pi AG-UI: tool call in ${entry.id} lacks native id/name`);
        tools.add(part.id);
        events.push(toolCallStart({ toolCallId: part.id, toolCallName: part.name, timestamp: ts }));
      }
    }
    if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") {
      for (const toolCallId of tools) events.push(toolCallEnd({ toolCallId, timestamp: ts }));
      tools.clear();
      events.push(runError({ message: entry.message.errorMessage || entry.message.stopReason, timestamp: ts }));
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
