import { createHash } from "node:crypto";
import {
  reasoningMessageContent,
  reasoningMessageEnd,
  reasoningMessageStart,
  runStarted,
  textMessageContent,
  textMessageEnd,
  textMessageStart,
  toolCallEnd,
  toolCallStart,
  type AguiEvent,
  type RecordMapper,
} from "@cotal-ai/connector-core";

export interface JcodeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface JcodeMessage {
  role?: string;
  content?: JcodeContentBlock[];
  timestamp?: string;
}

export interface JcodeJournalRecord {
  append_messages?: JcodeMessage[];
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

export function createJcodeMapper(opts: {
  threadId: string;
  mintRunId: () => string;
  resumeRunId?: string;
  now?: () => number;
}): JcodeMapper {
  const now = opts.now ?? (() => Date.now());
  let open: string | null = opts.resumeRunId ?? null;
  const map: RecordMapper<PositionedJcodeJournalRecord> = ({ cursor, record }) => {
    if (record === null || typeof record !== "object" || !Array.isArray(record.append_messages)) return null;
    const events: AguiEvent[] = [];
    let runId = open;

    for (const [messageIndex, message] of record.append_messages.entries()) {
      if (message === null || typeof message !== "object" || !Array.isArray(message.content)) continue;
      const { value: timestamp, arrival } = stamp(message, now);
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
      if (durableOutput && open === null) {
        open = opts.mintRunId();
        runId = open;
        events.push(
          runStarted({
            threadId: opts.threadId,
            runId: open,
            timestamp,
            cotal: { runIdSource: "connector", ...(arrival ? { tsSource: "arrival" as const } : {}) },
          }),
        );
      }

      if (open === null) continue;
      runId = open;

      parts.forEach((part, partIndex) => {
        if (part === null || typeof part !== "object") return;
        const observationId = messageId(opts.threadId, cursor, messageIndex, partIndex);
        if (message.role === "assistant" && part.type === "text" && typeof part.text === "string" && part.text.length > 0) {
          events.push(
            textMessageStart({ messageId: observationId, role: "assistant", timestamp, ...timeMeta }),
            textMessageContent({ messageId: observationId, delta: part.text, timestamp }),
            textMessageEnd({ messageId: observationId, timestamp }),
          );
          return;
        }
        if (message.role === "assistant" && (part.type === "reasoning" || part.type === "reasoning_trace") && typeof part.text === "string" && part.text.length > 0) {
          events.push(
            reasoningMessageStart({ messageId: observationId, timestamp, ...timeMeta }),
            reasoningMessageContent({ messageId: observationId, delta: part.text, timestamp }),
            reasoningMessageEnd({ messageId: observationId, timestamp }),
          );
          return;
        }
        if (message.role === "assistant" && part.type === "tool_use" && typeof part.id === "string" && part.id.length > 0) {
          events.push(
            toolCallStart({
              toolCallId: part.id,
              toolCallName: typeof part.name === "string" ? part.name : "",
              parentMessageId: observationId,
              timestamp,
              ...timeMeta,
            }),
          );
          return;
        }
        if (message.role === "user" && part.type === "tool_result" && typeof part.tool_use_id === "string" && part.tool_use_id.length > 0) {
          events.push(toolCallEnd({ toolCallId: part.tool_use_id, timestamp, ...timeMeta }));
        }
      });
    }

    return runId === null || events.length === 0 ? null : { runId, events };
  };

  return {
    map,
    forgetOpenRun(runId: string): void {
      if (open === runId) open = null;
    },
  };
}
