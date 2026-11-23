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
  StreamedParts,
  type AguiEvent,
  type Merged,
  type RecordMapper,
  type StreamDelta,
  type StreamSeed,
} from "@cotal-ai/connector-core";

interface JcodeContentBlock {
  type?: string;
  text?: string;
  /** An `anthropic_thinking` block's reasoning. */
  thinking?: string;
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
  map: RecordMapper<Merged<PositionedJcodeJournalRecord>>;
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
  streams: StreamedParts;
  /** The latest key each kind streamed under: Jcode's next saved reply carries that part. */
  current: Keys;
}

type Keys = Partial<Record<StreamDelta["kind"], string>>;
type Mapped = ReturnType<RecordMapper<Merged<PositionedJcodeJournalRecord>>>;
type TimeMeta = { cotal?: { tsSource: "arrival" } };

function interrupt(s: JcodeMapState, message: string, code: string, timestamp: number): AguiEvent[] {
  // End the interrupted observations, not the underlying tool executions. The terminal error
  // names the loss; neither a successful result nor a successful run is manufactured.
  const events = [...s.streams.endAll(timestamp), ...[...s.tools].sort().map((toolCallId) => toolCallEnd({ toolCallId, timestamp }))];
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

/** The readable reasoning of a saved block: Jcode stores it as `reasoning`, `reasoning_trace` or, for
 *  Anthropic's signed thinking, `anthropic_thinking`. */
function reasoningText(part: JcodeContentBlock): string | undefined {
  const text = part.type === "anthropic_thinking" ? part.thinking : part.type === "reasoning" || part.type === "reasoning_trace" ? part.text : undefined;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}

/** A saved text or reasoning part: the close of what streamed under `key`, then the part as a
 *  message of its own when nothing streamed or the saved text does not continue what did. */
function savedPart(s: JcodeMapState, kind: StreamDelta["kind"], key: string | undefined, text: string, observationId: string, timestamp: number, timeMeta: TimeMeta): AguiEvent[] {
  const closed = key === undefined ? { events: [], mapAsNew: true } : s.streams.saved(key, text, timestamp);
  if (!closed.mapAsNew) return closed.events;
  return kind === "text"
    ? [
        ...closed.events,
        textMessageStart({ messageId: observationId, role: "assistant", timestamp, ...timeMeta }),
        textMessageContent({ messageId: observationId, delta: text, timestamp }),
        textMessageEnd({ messageId: observationId, timestamp }),
      ]
    : [
        ...closed.events,
        reasoningMessageStart({ messageId: observationId, timestamp, ...timeMeta }),
        reasoningMessageContent({ messageId: observationId, delta: text, timestamp }),
        reasoningMessageEnd({ messageId: observationId, timestamp }),
      ];
}

/** The streamed key of a saved reply's first part of `kind`; its later parts of that kind stream none. */
function takeKey(keys: Keys, kind: StreamDelta["kind"]): string | undefined {
  const key = keys[kind];
  delete keys[kind];
  return key;
}

function partEvents(s: JcodeMapState, message: JcodeMessage, part: JcodeContentBlock, keys: Keys, observationId: string, timestamp: number, timeMeta: TimeMeta): AguiEvent[] {
  if (message.role === "assistant" && part.type === "text" && typeof part.text === "string" && part.text.length > 0)
    return savedPart(s, "text", takeKey(keys, "text"), part.text, observationId, timestamp, timeMeta);
  const reasoning = message.role === "assistant" ? reasoningText(part) : undefined;
  if (reasoning !== undefined) return savedPart(s, "reasoning", takeKey(keys, "reasoning"), reasoning, observationId, timestamp, timeMeta);
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
        ? part?.type === "text" || part?.type === "reasoning" || part?.type === "reasoning_trace" || part?.type === "anthropic_thinking" || part?.type === "tool_use"
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

    // Jcode saves one assistant message per provider call, after the call's last delta: a part
    // still open once it is mapped is one this reply left out.
    const keys: Keys = message.role === "assistant" ? { ...s.current } : {};
    parts.forEach((part, partIndex) => {
      if (part === null || typeof part !== "object") return;
      events.push(...partEvents(s, message, part, keys, messageId(s.threadId, cursor, messageIndex, partIndex), timestamp, timeMeta));
    });
    if (message.role === "assistant") {
      events.push(...s.streams.endAll(timestamp));
      s.current = {};
    }
  }

  return runId === null || events.length === 0 ? null : { runId, events };
}

/** A journal line: the parts it streams, opening the turn's run at its first delta, and the end of
 *  each part Jcode abandoned. */
function mapDeltas(s: JcodeMapState, line: Extract<Merged<PositionedJcodeJournalRecord>, { deltas: unknown }>): Mapped {
  const events = line.deltas.flatMap((d) => {
    s.current[d.kind] = d.key;
    return s.streams.delta(d, line.timestamp);
  });
  events.push(...s.streams.end(line.ends ?? [], line.timestamp));
  if (events.length === 0) return null;
  if (s.open === null) {
    s.open = s.mintRunId();
    events.unshift(runStarted({ threadId: s.threadId, runId: s.open, timestamp: line.timestamp, cotal: { runIdSource: "connector" } }));
  }
  return { runId: s.open, events };
}

/** `seed` is the stream state {@link streamSeed} rebuilt for a restarted emitter. */
export function createJcodeMapper(opts: {
  threadId: string;
  mintRunId: () => string;
  resumeRunId?: string;
  resumeTools?: readonly string[];
  seed?: StreamSeed;
  now?: () => number;
}): JcodeMapper {
  const s: JcodeMapState = {
    threadId: opts.threadId,
    mintRunId: opts.mintRunId,
    now: opts.now ?? (() => Date.now()),
    open: opts.resumeRunId ?? null,
    tools: new Set(opts.resumeTools ?? []),
    streams: new StreamedParts(opts.seed),
    current: Object.fromEntries((opts.seed?.open ?? []).map((part) => [part.kind, part.key])),
  };
  return {
    map: (r) => {
      if ("deltas" in r) return mapDeltas(s, r);
      const { cursor, record } = r.harness;
      return record?.journal_fold ? mapFold(s) : mapMessages(s, cursor, record);
    },
    forgetOpenRun(runId: string): void {
      if (s.open === runId) {
        s.open = null;
        s.tools.clear();
      }
    },
  };
}
