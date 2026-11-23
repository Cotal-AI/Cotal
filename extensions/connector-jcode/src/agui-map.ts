import { createHash } from "node:crypto";
import {
  reasoningMessageContent,
  reasoningMessageEnd,
  reasoningMessageStart,
  runError,
  runStarted,
  textMessageContent,
  textMessageEnd,
  textMessageStart,
  toolCallEnd,
  toolCallArgs,
  toolCallResult,
  toolResultMarker,
  toolCallStart,
  type AguiEvent,
  type RecordMapper,
} from "@cotal-ai/connector-core";

interface JcodeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface JcodeMessage {
  role?: string;
  content?: JcodeContentBlock[];
  timestamp?: string;
}

export interface JcodeJournalRecord {
  append_messages?: JcodeMessage[];
  journal_fold?: Record<string, never>;
}

export interface PositionedJcodeJournalRecord {
  cursor: string;
  record: JcodeJournalRecord;
}

export interface JcodeMapper {
  map: RecordMapper<PositionedJcodeJournalRecord>;
  forgetOpenRun: (runId: string) => void;
}

function stamp(message: JcodeMessage, now: () => number): { value: number; arrival: boolean } {
  const parsed = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? { value: parsed, arrival: false } : { value: now(), arrival: true };
}

function messageId(threadId: string, cursor: string, messageIndex: number, partIndex: number): string {
  const position = createHash("sha256")
    .update(`${cursor}\0${messageIndex}\0${partIndex}`)
    .digest("base64url")
    .slice(0, 22);
  return `${threadId}:${position}`;
}

interface JcodeMapState {
  threadId: string;
  mintRunId: () => string;
  now: () => number;
  open: string | null;
  tools: Set<string>;
}

type Mapped = ReturnType<RecordMapper<PositionedJcodeJournalRecord>>;
type TimeMeta = { cotal?: { tsSource: "arrival" } };

function interrupt(s: JcodeMapState, message: string, code: string, timestamp: number): AguiEvent[] {
  // End the interrupted observations, not the underlying tool executions. The terminal error
  // names the loss; neither a successful result nor a successful run is manufactured.
  const events = [...s.tools].sort().map((toolCallId) => toolCallEnd({ toolCallId, timestamp }));
  s.tools.clear();
  s.open = null;
  return [...events, runError({ message, code, timestamp })];
}

function mapFold(s: JcodeMapState): Mapped {
  const runId = s.open;
  return runId === null
    ? null
    : {
        runId,
        events: interrupt(
          s,
          "Jcode session journal compacted into its snapshot; records not yet emitted were lost and are not reconstructed",
          "jcode_journal_fold",
          s.now(),
        ),
      };
}

function partEvents(s: JcodeMapState, message: JcodeMessage, part: JcodeContentBlock, observationId: string, timestamp: number, timeMeta: TimeMeta): AguiEvent[] {
  if (message.role === "assistant" && part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
    return [
      textMessageStart({ messageId: observationId, role: "assistant", timestamp, ...timeMeta }),
      textMessageContent({ messageId: observationId, delta: part.text, timestamp }),
      textMessageEnd({ messageId: observationId, timestamp }),
    ];
  }
  if (message.role === "assistant" && (part.type === "reasoning" || part.type === "reasoning_trace") && typeof part.text === "string" && part.text.length > 0) {
    return [
      reasoningMessageStart({ messageId: observationId, timestamp, ...timeMeta }),
      reasoningMessageContent({ messageId: observationId, delta: part.text, timestamp }),
      reasoningMessageEnd({ messageId: observationId, timestamp }),
    ];
  }
  if (message.role === "assistant" && part.type === "tool_use" && typeof part.id === "string" && part.id.length > 0) {
    s.tools.add(part.id);
    return [
      toolCallStart({
        toolCallId: part.id,
        toolCallName: typeof part.name === "string" ? part.name : "",
        parentMessageId: observationId,
        timestamp,
        ...timeMeta,
      }),
      toolCallArgs({ toolCallId: part.id, delta: JSON.stringify(part.input ?? null), timestamp }),
    ];
  }
  if (message.role === "user" && part.type === "tool_result" && typeof part.tool_use_id === "string" && part.tool_use_id.length > 0) {
    s.tools.delete(part.tool_use_id);
    return [
      toolCallEnd({ toolCallId: part.tool_use_id, timestamp, ...timeMeta }),
      toolCallResult({ messageId: observationId, toolCallId: part.tool_use_id, content: typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? null), timestamp, cotal: { isError: part.is_error === true } }),
      toolResultMarker({ toolCallId: part.tool_use_id, isError: part.is_error === true, timestamp }),
    ];
  }
  return [];
}

function mapMessages(s: JcodeMapState, cursor: string, record: JcodeJournalRecord): Mapped {
  if (record === null || typeof record !== "object" || !Array.isArray(record.append_messages)) return null;
  const events: AguiEvent[] = [];
  let runId = s.open;

  for (const [messageIndex, message] of record.append_messages.entries()) {
    if (message === null || typeof message !== "object" || !Array.isArray(message.content)) continue;
    const { value: timestamp, arrival } = stamp(message, s.now);
    const timeMeta = arrival ? { cotal: { tsSource: "arrival" as const } } : {};
    const parts = message.content;
    const durableOutput = parts.some((part) =>
      message.role === "assistant"
        ? part?.type === "text" || part?.type === "reasoning" || part?.type === "reasoning_trace" || part?.type === "tool_use"
        : message.role === "user" && part?.type === "tool_result",
    );

    // Jcode checkpoints the submitted prompt into its snapshot before it appends the turn's
    // output to the journal. The journal therefore names a turn at its first durable output, not
    // at prompt acceptance. Open there rather than reading the live delta bus, whose events cannot
    // be replayed after a crash. User text is never republished onto this differently scoped plane.
    if (durableOutput && s.open === null) {
      s.open = s.mintRunId();
      runId = s.open;
      events.push(
        runStarted({
          threadId: s.threadId,
          runId: s.open,
          timestamp,
          cotal: { runIdSource: "connector", ...(arrival ? { tsSource: "arrival" as const } : {}) },
        }),
      );
    }

    if (s.open === null) continue;
    runId = s.open;

    if (message.role === "user") {
      const remaining = new Set(s.tools);
      const missingStart = parts.some((part) => part?.type === "tool_result" &&
        typeof part.tool_use_id === "string" && part.tool_use_id.length > 0 && !remaining.delete(part.tool_use_id));
      if (missingStart) {
        // A checkpoint can consume the start before this reader sees it. Do not invent that
        // start or emit an unpaired end. Mark this record's interrupted observation explicitly.
        events.push(...interrupt(s, "Jcode tool result has no observed start; this record cannot be replayed as a complete event sequence", "jcode_tool_start_missing", timestamp));
        return { runId, events };
      }
    }

    parts.forEach((part, partIndex) => {
      if (part === null || typeof part !== "object") return;
      events.push(...partEvents(s, message, part, messageId(s.threadId, cursor, messageIndex, partIndex), timestamp, timeMeta));
    });
  }

  return runId === null || events.length === 0 ? null : { runId, events };
}

export function createJcodeMapper(opts: {
  threadId: string;
  mintRunId: () => string;
  resumeRunId?: string;
  resumeTools?: readonly string[];
  now?: () => number;
}): JcodeMapper {
  const s: JcodeMapState = {
    threadId: opts.threadId,
    mintRunId: opts.mintRunId,
    now: opts.now ?? (() => Date.now()),
    open: opts.resumeRunId ?? null,
    tools: new Set(opts.resumeTools ?? []),
  };
  return {
    map: ({ cursor, record }) => (record?.journal_fold ? mapFold(s) : mapMessages(s, cursor, record)),
    forgetOpenRun(runId: string): void {
      if (s.open === runId) {
        s.open = null;
        s.tools.clear();
      }
    },
  };
}
