/**
 * Codex rollout records to AG-UI events.
 *
 * The durable record is the thread's rollout JSONL, not the app-server notification stream. The
 * stream cannot make brackets legal across a restart, which is the property the emitter exists to
 * provide, so the file is the record of truth and the stream is only how the host learns a thread
 * id.
 *
 * Every rollout record is `{timestamp, type, payload}`. `type` is the envelope kind
 * (`response_item`, `event_msg`, `session_meta`, `turn_context`, `world_state`, `compacted`) and
 * `payload.type` is the inner kind for the first two. This mapper reads BOTH, because the same
 * inner name appears under different envelopes and means different things: `agent_message` is an
 * `event_msg` mirror of an assistant turn AND a `response_item` for inter-agent traffic.
 *
 * Derived against a real app-server thread (`.internal` 3.3b), not against the operator's own
 * sessions: `originator` is `cotal` there and the primer records ahead of the first turn do not
 * occur in an operator corpus at all.
 */
import {
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
  type AguiEvent,
} from "@cotal-ai/connector-core";

/** One rollout line. `payload` is `unknown` on purpose: it crosses in from a file this process did
 *  not write, so every field is checked at the point it is read rather than trusted by its type. */
export interface CodexRecord {
  timestamp?: string;
  type?: string;
  payload?: unknown;
}

export interface CodexMapper {
  map: (record: CodexRecord) => { runId: string; events: AguiEvent[] } | null;
  /** Drop a run the record stream never closed, when a turn terminal says it ended. Keyed on the
   *  id so a newer run opened in between is left alone. */
  forgetOpenRun: (runId: string) => void;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A record's clock. Rollout timestamps are ISO strings; a record without a parseable one falls
 *  back to the last good clock rather than to `Date.now()`, because a wall clock read at replay
 *  time would date a year-old record to today. */
function clock(record: CodexRecord, last: number): number {
  const t = asString(record.timestamp);
  if (t === undefined) return last;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : last;
}

/** The text of a `content` array, which the rollout writes as `[{type, text}]`. Both
 *  `input_text` and `output_text` carry `text`; anything else (an `input_image`) contributes
 *  nothing rather than throwing, because a turn that attached an image still has text worth
 *  publishing. */
function contentText(payload: Record<string, unknown>): string {
  const parts = payload.content;
  if (!Array.isArray(parts)) return "";
  let out = "";
  for (const p of parts) {
    const r = asRecord(p);
    const t = r === undefined ? undefined : asString(r.text);
    if (t !== undefined) out += t;
  }
  return out;
}

/** A tool output. `function_call_output.output` is a UNION in the corpus, `str` on 6 353 records
 *  and `list` on 380, and `custom_tool_call_output` skews the other way. Serializing the non-string
 *  form is the only reading that does not throw on one of the two shapes. */
function outputText(payload: Record<string, unknown>): string {
  const o = payload.output;
  if (typeof o === "string") return o;
  if (o === undefined || o === null) return "";
  try {
    return JSON.stringify(o);
  } catch {
    return "";
  }
}

/**
 * @param threadId The native thread id, which is `session_meta.payload.id` and the rollout
 *  filename key. Passed in rather than read from the file: the caller resolved the path FROM this
 *  id, so reading it back would make the two independently derivable and let them disagree.
 * @param mintRunId Injected so a test can make runs deterministic without the mapper owning a
 *  source of randomness.
 */
export function createCodexMapper(opts: { threadId: string; mintRunId: () => string }): CodexMapper {
  const { threadId, mintRunId } = opts;
  let open: string | null = null;
  /** The turn this run was opened for, so an abort or a completion for a DIFFERENT turn cannot
   *  close it. Codex retries a failed turn with a fresh turn id, and each retry is its own run. */
  let openTurn: string | undefined;
  let last = 0;

  const map = (record: CodexRecord): { runId: string; events: AguiEvent[] } | null => {
    // A LINE THAT IS NOT AN OBJECT IS A DROP, NOT A THROW, and the difference is the whole plane.
    // `JsonlFileSource` hands over `JSON.parse(line)` unchecked, so a line reading `null` arrives
    // here as `null` and every field read below would throw. A throw from a mapper does not lose
    // one record: it kills the emitter, the holder is terminal on error, and the seat publishes
    // nothing for the rest of its life with one log line inside its own process as the only trace.
    // `typeof null === "object"`, so null is named rather than implied.
    if (record === null || typeof record !== "object") return null;
    const envelope = asString(record.type);
    const payload = asRecord(record.payload);
    if (envelope === undefined || payload === undefined) return null;
    const ts = clock(record, last);
    last = ts;
    const inner = asString(payload.type);

    // ---- run brackets -------------------------------------------------------------------
    if (envelope === "event_msg" && inner === "task_started") {
      // A second `task_started` while a run is open would be illegal downstream. It is not
      // reachable in a rollout (a turn always terminates before the next starts) and it is
      // DROPPED rather than force-closed, because inventing a terminal for a run whose real
      // terminal may still arrive publishes an outcome that never happened.
      if (open !== null) return null;
      const runId = mintRunId();
      open = runId;
      openTurn = asString(payload.turn_id);
      return { runId, events: [runStarted({ threadId, runId, timestamp: ts })] };
    }

    if (envelope === "event_msg" && inner === "task_complete") {
      if (open === null) return null;
      const turn = asString(payload.turn_id);
      if (turn !== undefined && openTurn !== undefined && turn !== openTurn) return null;
      const runId = open;
      const err = asRecord(payload.error);
      open = null;
      openTurn = undefined;
      // MEASURED, not assumed: a failed turn writes NO `event_msg/error` record at all. The
      // failure is carried here, and a mapper keyed on `event_msg/error` for RUN_ERROR publishes
      // nothing for a real failure. `event_msg/error` occurs 2 times in 74 031 corpus records;
      // this field is the actual path. RUN_ERROR closes the run on its own, so no RUN_FINISHED
      // follows it.
      if (err !== undefined) {
        const message = asString(err.message) ?? "codex turn failed";
        const code = asString(err.codex_error_info);
        return { runId, events: [runError({ message, timestamp: ts, ...(code ? { code } : {}) })] };
      }
      return { runId, events: [runFinished({ threadId, runId, timestamp: ts, outcome: { type: "success" } })] };
    }

    if (envelope === "event_msg" && inner === "turn_aborted") {
      if (open === null) return null;
      const turn = asString(payload.turn_id);
      if (turn !== undefined && openTurn !== undefined && turn !== openTurn) return null;
      const runId = open;
      open = null;
      openTurn = undefined;
      // `turn_id` is NOT required here. One corpus reading has it on 61 of 61 and another on 18 of
      // 19, and a mapper that threw on a missing one would convert a rare heterogeneity into a
      // dead stream. The interrupt id falls back to the run when the record does not name a turn.
      const id = turn ?? runId;
      const reason = asString(payload.reason) ?? "aborted";
      return {
        runId,
        events: [runFinished({ threadId, runId, timestamp: ts, outcome: { type: "interrupt", interrupts: [{ id, reason }] } })],
      };
    }

    // Everything below belongs INSIDE a run. A record that arrives outside one is dropped rather
    // than given a synthetic run: the primer that materializes the rollout writes five records
    // ahead of the first `task_started`, and all five are withheld anyway.
    if (open === null) return null;
    const runId = open;

    // ---- assistant text -----------------------------------------------------------------
    if (envelope === "response_item" && inner === "message") {
      const role = asString(payload.role);
      // WITHHELD: the user's own words and the developer instructions. This is the authorship
      // ruling, and it is load-bearing twice over: `events.<owner>.<actor>` carries a different
      // read ACL from the channel the user typed into, so republishing their prompt there widens
      // who can read it.
      if (role !== "assistant") return null;
      const text = contentText(payload);
      if (text.length === 0) return null;
      const messageId = asString(payload.id) ?? `msg:${runId}:${ts}`;
      return {
        runId,
        events: [
          textMessageStart({ messageId, timestamp: ts, role: "assistant" }),
          textMessageContent({ messageId, delta: text, timestamp: ts }),
          textMessageEnd({ messageId, timestamp: ts }),
        ],
      };
    }

    // The `event_msg` mirror of the same assistant turn. Dropped, or every reply publishes twice.
    if (envelope === "event_msg" && (inner === "agent_message" || inner === "agent_reasoning")) return null;
    // Withheld user traffic, in both the shapes the rollout writes it: a real thread emits the
    // same 291 bytes as BOTH a `response_item/message role=user` and an `event_msg/user_message`.
    if (envelope === "event_msg" && inner === "user_message") return null;

    // ---- reasoning ----------------------------------------------------------------------
    if (envelope === "response_item" && inner === "reasoning") {
      const summary = payload.summary;
      if (!Array.isArray(summary)) return null;
      let text = "";
      for (const p of summary) {
        const r = asRecord(p);
        const t = r === undefined ? undefined : asString(r.text);
        if (t !== undefined) text += t;
      }
      // `encrypted_content` is present on every reasoning record and is NOT published: it is
      // opaque to this plane and publishing it would put bytes on the subject that no renderer
      // can read. A record whose summary is empty therefore carries nothing to emit.
      if (text.length === 0) return null;
      const messageId = asString(payload.id) ?? `rsn:${runId}:${ts}`;
      return {
        runId,
        events: [
          reasoningMessageStart({ messageId, timestamp: ts }),
          reasoningMessageContent({ messageId, delta: text, timestamp: ts }),
          reasoningMessageEnd({ messageId, timestamp: ts }),
        ],
      };
    }

    // ---- tool calls ---------------------------------------------------------------------
    if (envelope === "response_item" && (inner === "function_call" || inner === "custom_tool_call")) {
      // The NATIVE `call_id`, never a synthesized key: it is present on 6 734 of 6 734
      // `function_call` records and on all 2 324 `custom_tool_call` records, and it is the only
      // value the matching output record carries to join on.
      const toolCallId = asString(payload.call_id);
      if (toolCallId === undefined) return null;
      const toolCallName = asString(payload.name) ?? "tool";
      const args = asString(payload.arguments) ?? asString(payload.input) ?? "";
      return {
        runId,
        events: [
          toolCallStart({ toolCallId, toolCallName, timestamp: ts }),
          ...(args.length > 0 ? [toolCallArgs({ toolCallId, delta: args, timestamp: ts })] : []),
          toolCallEnd({ toolCallId, timestamp: ts }),
        ],
      };
    }

    if (envelope === "response_item" && (inner === "function_call_output" || inner === "custom_tool_call_output")) {
      const toolCallId = asString(payload.call_id);
      if (toolCallId === undefined) return null;
      // The `messageId` section 3.1 owes per connector. Codex has no message id for a tool result:
      // the record's own `id`, present on 2 437 of 6 733, is the response item's id and not a
      // message's. Synthesized from the call id so it is STABLE across a replay of the same
      // record, which a mint would not be.
      const messageId = `res:${toolCallId}`;
      return { runId, events: [toolCallResult({ messageId, toolCallId, content: outputText(payload), timestamp: ts })] };
    }

    // Unmapped in v1, and stated rather than dropped silently: `world_state`, `turn_context`,
    // `session_meta`, `token_count`, `thread_settings_applied`, `sub_agent_activity`,
    // `compacted`, `context_compacted`, the exec/patch/mcp/web-search `event_msg` families, and
    // the `_end`-only tool families that have no begin record to bracket against.
    return null;
  };

  return {
    map,
    forgetOpenRun: (runId: string): void => {
      if (open === runId) {
        open = null;
        openTurn = undefined;
      }
    },
  };
}
