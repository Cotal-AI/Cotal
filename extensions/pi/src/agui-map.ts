import {
  runStarted, runFinished, runError, textMessageStart, textMessageContent, textMessageEnd,
  reasoningMessageStart, reasoningMessageContent, reasoningMessageEnd,
  toolCallStart, toolCallArgs, toolCallEnd, toolCallResult, toolResultMarker, StreamedParts,
  type RecordMapper, type AguiEvent, type Merged, type StreamSeed,
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

/** The delta journal's key for one part of a reply Pi is streaming: the reply's timestamp, which Pi
 *  keeps on the message it saves, and the part's index. */
export function piStreamKey(timestamp: number, kind: "text" | "thinking", index: number): string {
  return `${timestamp}:${kind}:${index}`;
}

interface PiMapState {
  threadId: string;
  open: string | undefined;
  tools: Set<string>;
  reasoning: boolean;
  streams: StreamedParts;
}

type PiPart = NonNullable<NonNullable<PiSessionEntry["message"]>["content"]>[number];

function mapToolResult(s: PiMapState, entry: PiSessionEntry): ReturnType<RecordMapper<PiSessionEntry>> {
  const callId = entry.message!.toolCallId;
  // A resumed transcript can begin after an old call but before its result. Its start was
  // never published here, so do not invent a matching end for an unknown call.
  if (!s.open || !callId || !s.tools.delete(callId)) return null;
  const ts = entry.message!.timestamp ?? Date.parse(entry.timestamp ?? "");
  if (!Number.isFinite(ts)) throw new Error("Pi AG-UI: tool result has no valid timestamp");
  // The result follows its call's end, and the marker beside it tells a public reader that the
  // call finished and whether it failed, while the egress fence keeps the output on the rail.
  const isError = entry.message!.isError === true;
  return {
    runId: s.open,
    events: [
      toolCallEnd({ toolCallId: callId, timestamp: ts }),
      toolCallResult({ messageId: `${callId}:result`, toolCallId: callId, content: resultContent(entry.message!.content), timestamp: ts, cotal: { isError } }),
      toolResultMarker({ toolCallId: callId, isError, timestamp: ts }),
    ],
  };
}

/** A saved text or thinking part: the close of what streamed under its key, then the part as a
 *  message of its own when nothing streamed or the saved text does not continue what did. */
function savedPart(s: PiMapState, id: string, key: string | undefined, kind: "text" | "reasoning", text: string, ts: number): AguiEvent[] {
  const closed = key === undefined ? { events: [], mapAsNew: true } : s.streams.saved(key, text, ts);
  if (!closed.mapAsNew) return closed.events;
  return kind === "text"
    ? [...closed.events, textMessageStart({ messageId: id, timestamp: ts }), textMessageContent({ messageId: id, delta: text, timestamp: ts }), textMessageEnd({ messageId: id, timestamp: ts })]
    : [...closed.events, reasoningMessageStart({ messageId: id, timestamp: ts }), reasoningMessageContent({ messageId: id, delta: text, timestamp: ts }), reasoningMessageEnd({ messageId: id, timestamp: ts })];
}

function partEvents(s: PiMapState, entry: PiSessionEntry, index: number, part: PiPart, ts: number): AguiEvent[] {
  const streamed = entry.message!.timestamp;
  const key = (kind: "text" | "thinking") => (typeof streamed === "number" ? piStreamKey(streamed, kind, index) : undefined);
  if (part.type === "text" && part.text) return savedPart(s, `${entry.id}:text:${index}`, key("text"), "text", part.text, ts);
  // A redacted block holds Pi's placeholder text, not the model's reasoning.
  if (part.type === "thinking" && s.reasoning && part.thinking && !part.redacted)
    return savedPart(s, `${entry.id}:thinking:${index}`, key("thinking"), "reasoning", part.thinking, ts);
  if (part.type !== "toolCall") return [];
  if (!part.id || !part.name) throw new Error(`Pi AG-UI: tool call in ${entry.id} lacks native id/name`);
  s.tools.add(part.id);
  return [
    toolCallStart({ toolCallId: part.id, toolCallName: part.name, timestamp: ts }),
    toolCallArgs({ toolCallId: part.id, delta: JSON.stringify(part.arguments ?? null), timestamp: ts }),
  ];
}

/** The events a saved reply's stop reason closes its run with. */
function stopEvents(s: PiMapState, entry: PiSessionEntry, runId: string, ts: number): AguiEvent[] {
  const message = entry.message!;
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const events: AguiEvent[] = [...s.tools].map((toolCallId) => toolCallEnd({ toolCallId, timestamp: ts }));
    s.tools.clear();
    // A stopped turn did not fail, so it ends as an interrupt.
    events.push(stopped(message)
      ? runFinished({ threadId: s.threadId, runId, timestamp: ts, outcome: { type: "interrupt", interrupts: [{ id: entry.id!, reason: "aborted" }] } })
      : runError({ message: message.errorMessage || message.stopReason, timestamp: ts }));
    s.open = undefined;
    return events;
  }
  if (message.stopReason === "stop" || message.stopReason === "length") {
    if (s.tools.size) throw new Error(`Pi AG-UI: terminal assistant entry ${entry.id} has unclosed native tool calls`);
    s.open = undefined;
    return [runFinished({ threadId: s.threadId, runId, timestamp: ts })];
  }
  if (message.stopReason !== "toolUse") throw new Error(`Pi AG-UI: unsupported native stop reason ${String(message.stopReason)}`);
  return [];
}

function mapAssistant(s: PiMapState, entry: PiSessionEntry): ReturnType<RecordMapper<PiSessionEntry>> {
  if (!entry.id || !Array.isArray(entry.message?.content))
    throw new Error("Pi AG-UI: saved assistant entry lacks an id or content array");
  const ts = entry.message.timestamp ?? Date.parse(entry.timestamp ?? "");
  if (!Number.isFinite(ts)) throw new Error(`Pi AG-UI: assistant entry ${entry.id} has no valid timestamp`);
  const events: AguiEvent[] = [];
  if (!s.open) {
    s.open = entry.id;
    events.push(runStarted({ threadId: s.threadId, runId: s.open, timestamp: ts }));
  }
  const runId = s.open;
  for (const [index, part] of entry.message.content.entries()) events.push(...partEvents(s, entry, index, part, ts));
  // Pi streams one reply at a time, so a part still open here is one this saved reply left out.
  events.push(...s.streams.endAll(ts), ...stopEvents(s, entry, runId, ts));
  return { runId, events };
}

/** A journal line: the parts it streams, opening the turn's run at its first delta. */
function mapDeltas(s: PiMapState, line: Extract<Merged<PiSessionEntry>, { deltas: unknown }>): ReturnType<RecordMapper<PiSessionEntry>> {
  const live = line.deltas.filter((d) => d.kind === "text" || s.reasoning);
  const events = live.flatMap((d) => s.streams.delta(d, line.timestamp));
  if (events.length === 0) return null;
  if (!s.open) {
    s.open = live[0]!.key;
    events.unshift(runStarted({ threadId: s.threadId, runId: s.open, timestamp: line.timestamp }));
  }
  return { runId: s.open, events };
}

/** Pi saves completed messages; the delta journal carries what a reply streamed before Pi saved it.
 *  A reply that streamed nothing maps from its saved record alone. User messages have no separable
 *  peer authorship. `reasoning` emits `REASONING_*` for thinking and is off by default. `seed` is
 *  the stream state {@link streamSeed} rebuilt for a restarted emitter. */
export function createPiMapper(threadId: string, resumedRun?: string, resumedTools: readonly string[] = [], reasoning = false, seed?: StreamSeed): RecordMapper<Merged<PiSessionEntry>> {
  const s: PiMapState = { threadId, open: resumedRun, tools: new Set(resumedTools), reasoning, streams: new StreamedParts(seed) };
  return (record) => {
    if ("deltas" in record) return mapDeltas(s, record);
    const entry = record.harness;
    if (entry.type !== "message") return null;
    if (entry.message?.role === "toolResult") return mapToolResult(s, entry);
    return entry.message?.role === "assistant" ? mapAssistant(s, entry) : null;
  };
}
