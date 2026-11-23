import {
  reasoningMessageContent,
  reasoningMessageEnd,
  reasoningMessageStart,
  runError,
  runFinished,
  runStarted,
  textMessageContent,
  textMessageEnd,
  textMessageStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  toolCallStart,
  toolResultMarker,
  type AguiEvent,
  type RecordMapper,
} from "@cotal-ai/connector-core";

/** One line of the turn journal the plugin writes (plugin/cotal/journal.py). */
export interface HermesJournalRecord {
  k: "start" | "done" | "assistant" | "tool";
  /** Unique per record, so each observation gets its own message id. */
  rid: string;
  /** Epoch milliseconds, stamped when the plugin wrote the record. */
  ts: number;
  /** `start`/`done`: the gateway's processing of one message. */
  key?: string;
  outcome?: "success" | "failure" | "cancelled";
  /** `assistant`: one model response. */
  content?: string;
  reasoning?: string;
  calls?: { id: string; name: string; arguments: string }[];
  /** `tool`: the result of call `id`. */
  id?: string;
  result?: string;
  error?: boolean;
}

/**
 * Map the journal to AG-UI.
 *
 * A run spans the gateway's processing of Cotal messages. It opens at the first model response
 * while a message is in progress, and finishes at the `done` that leaves none in progress. It does
 * not open at `start`: the gateway also processes a message that arrives during its startup once
 * without running the model, and that pass is no turn. A message that fails before any model
 * response opens and fails a run at its `done`, so a client waiting on the turn sees the failure.
 * One gateway runs many sessions at once, and the event plane has one run open at a time, so
 * concurrent messages share the run. Tool calls are tracked by their own ids, and a call still open
 * when the run ends is ended without a result rather than given one. A `failure` ends the run with
 * `RUN_ERROR`, a `cancelled` with an interrupt outcome.
 *
 * `consumed` is the journal up to the cursor the event plane has acknowledged. A re-established
 * plane replays it here so the mapper knows which messages are still in progress, and resumes the
 * open run under the id the wire holds (`resumeRunId`).
 */
export function createHermesMapper(opts: {
  threadId: string;
  mintRunId: () => string;
  consumed?: readonly HermesJournalRecord[];
  resumeRunId?: string;
  /** Emit `REASONING_*` for the model's reasoning text. Off by default, as in the other mappers. */
  reasoning?: boolean;
}): RecordMapper<HermesJournalRecord> {
  const { threadId } = opts;
  let mint = (): string => "";
  let open: string | null = null;
  const pending = new Set<string>();
  const tools = new Set<string>();
  let failed = false;
  let cancelled = false;

  const started = (runId: string, ts: number): AguiEvent =>
    runStarted({ threadId, runId, timestamp: ts, cotal: { runIdSource: "connector" } });
  const close = (runId: string, ts: number): AguiEvent[] => {
    const events: AguiEvent[] = [...tools].map((toolCallId) => toolCallEnd({ toolCallId, timestamp: ts }));
    events.push(
      failed
        ? runError({ message: "Hermes could not process a message of this run", code: "hermes_processing_failed", timestamp: ts })
        : cancelled
          ? runFinished({ threadId, runId, timestamp: ts, outcome: { type: "interrupt", interrupts: [{ id: runId, reason: "cancelled" }] } })
          : runFinished({ threadId, runId, timestamp: ts }),
    );
    tools.clear();
    failed = cancelled = false;
    open = null;
    return events;
  };

  const assistant = (rec: HermesJournalRecord): AguiEvent[] => {
    const events: AguiEvent[] = [];
    const ts = rec.ts;
    if (opts.reasoning && rec.reasoning) {
      const messageId = `${rec.rid}:reasoning`;
      events.push(
        reasoningMessageStart({ messageId, timestamp: ts }),
        reasoningMessageContent({ messageId, delta: rec.reasoning, timestamp: ts }),
        reasoningMessageEnd({ messageId, timestamp: ts }),
      );
    }
    if (rec.content) {
      const messageId = `${rec.rid}:text`;
      events.push(
        textMessageStart({ messageId, role: "assistant", timestamp: ts }),
        textMessageContent({ messageId, delta: rec.content, timestamp: ts }),
        textMessageEnd({ messageId, timestamp: ts }),
      );
    }
    for (const call of rec.calls ?? []) {
      if (tools.has(call.id)) continue;
      tools.add(call.id);
      events.push(
        toolCallStart({ toolCallId: call.id, toolCallName: call.name, timestamp: ts }),
        toolCallArgs({ toolCallId: call.id, delta: call.arguments, timestamp: ts }),
      );
    }
    return events;
  };

  const map: RecordMapper<HermesJournalRecord> = (rec) => {
    if (!Number.isFinite(rec.ts) || typeof rec.rid !== "string")
      throw new Error(`Hermes AG-UI: journal record ${JSON.stringify(rec.k)} has no id or timestamp`);
    switch (rec.k) {
      case "start":
        pending.add(String(rec.key));
        return null;
      case "done": {
        if (!pending.delete(String(rec.key))) return null;
        failed ||= rec.outcome === "failure";
        cancelled ||= rec.outcome === "cancelled";
        if (pending.size > 0) return null;
        if (open !== null) return { runId: open, events: close(open, rec.ts) };
        if (!failed) {
          cancelled = false;
          return null;
        }
        const runId = mint();
        return { runId, events: [started(runId, rec.ts), ...close(runId, rec.ts)] };
      }
      case "assistant": {
        if (open === null && pending.size === 0) return null;
        const events = assistant(rec);
        if (events.length === 0) return null;
        if (open !== null) return { runId: open, events };
        open = mint();
        return { runId: open, events: [started(open, rec.ts), ...events] };
      }
      case "tool": {
        if (open === null || !rec.id || !tools.delete(rec.id)) return null;
        const isError = rec.error === true;
        return {
          runId: open,
          events: [
            toolCallEnd({ toolCallId: rec.id, timestamp: rec.ts }),
            toolCallResult({ messageId: rec.rid, toolCallId: rec.id, content: rec.result ?? "", timestamp: rec.ts, cotal: { isError } }),
            toolResultMarker({ toolCallId: rec.id, isError, timestamp: rec.ts }),
          ],
        };
      }
      default:
        throw new Error(`Hermes AG-UI: unknown journal record kind ${JSON.stringify(rec.k)}`);
    }
  };

  for (const rec of opts.consumed ?? []) map(rec);
  if ((open !== null) !== (opts.resumeRunId !== undefined))
    throw new Error(`Hermes AG-UI: the journal ${open !== null ? "has a run open" : "has no run open"} where the event plane's log ${opts.resumeRunId !== undefined ? "has one" : "has none"}`);
  if (open !== null) open = opts.resumeRunId!;
  mint = opts.mintRunId;
  return map;
}
