/**
 * AG-UI frames from a seat's event channel, mapped to ACP `session/update` notifications.
 *
 * The ordinary event channel carries text and reasoning as completed messages, tool calls by name
 * and boundary, and the `cotal.toolResult` marker for a call's end. Tool arguments and results are
 * withheld from it (SPEC event payloads), so a tool call shows its name and its status only.
 */
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AguiEventLike, SeatFrame } from "./mesh.js";

/** The content-free marker a connector publishes when a tool call ends. */
const TOOL_RESULT = "cotal.toolResult";

/** What happened to a run, as the bridge needs it for prompt completion. */
export type RunSignal =
  | { readonly kind: "start"; readonly runId: string; readonly ts: number }
  | { readonly kind: "end"; readonly runId: string; readonly outcome: "finished" | "error" | "interrupt"; readonly ts: number; readonly message?: string };

export interface Mapped {
  readonly updates: SessionUpdate[];
  readonly runs: RunSignal[];
}

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Map one seat's frames in order. One mapper per ACP session, because message roles and open tool
 *  calls carry from one frame to the next. */
export class FrameMapper {
  private readonly roles = new Map<string, "user" | "assistant">();
  private readonly open = new Map<string, string>();
  private readonly seen = new Set<string>();

  /** Map one frame. A frame already mapped (same epoch and seq) maps to nothing, so a history read
   *  and a live tap can overlap. */
  map(frame: SeatFrame): Mapped {
    const key = `${frame.epoch}:${frame.seq}`;
    if (this.seen.has(key)) return { updates: [], runs: [] };
    this.seen.add(key);
    const updates: SessionUpdate[] = [];
    const runs: RunSignal[] = [];
    for (const event of frame.events) this.event(event, frame, updates, runs);
    return { updates, runs };
  }

  /** The tool calls still open, closed with `status`. A prompt answers only after this, so no call
   *  stays open in the client once its turn has ended. */
  closeOpen(status: "completed" | "failed"): SessionUpdate[] {
    const updates: SessionUpdate[] = [...this.open.keys()].map((toolCallId) => ({ sessionUpdate: "tool_call_update", toolCallId, status }));
    this.open.clear();
    return updates;
  }

  private event(event: AguiEventLike, frame: SeatFrame, updates: SessionUpdate[], runs: RunSignal[]): void {
    switch (event.type) {
      case "RUN_STARTED":
        runs.push({ kind: "start", runId: text(event.runId) ?? frame.runId, ts: frame.ts });
        return;
      case "RUN_FINISHED": {
        const outcome = (event.outcome as { type?: unknown } | undefined)?.type === "interrupt" ? "interrupt" : "finished";
        runs.push({ kind: "end", runId: text(event.runId) ?? frame.runId, outcome, ts: frame.ts });
        return;
      }
      case "RUN_ERROR":
        // RUN_ERROR names no run; the frame's run is the one that failed.
        runs.push({ kind: "end", runId: frame.runId, outcome: "error", ts: frame.ts, ...(text(event.message) ? { message: text(event.message) } : {}) });
        return;
      case "TEXT_MESSAGE_START": {
        const id = text(event.messageId);
        if (id) this.roles.set(id, event.role === "user" ? "user" : "assistant");
        return;
      }
      case "TEXT_MESSAGE_CONTENT": {
        const id = text(event.messageId);
        const delta = text(event.delta);
        if (!id || !delta) return;
        const role = this.roles.get(id) ?? "assistant";
        updates.push({ sessionUpdate: role === "user" ? "user_message_chunk" : "agent_message_chunk", messageId: id, content: { type: "text", text: delta } });
        return;
      }
      case "TEXT_MESSAGE_END": {
        const id = text(event.messageId);
        if (id) this.roles.delete(id);
        return;
      }
      case "REASONING_MESSAGE_CONTENT": {
        const id = text(event.messageId);
        const delta = text(event.delta);
        if (!delta) return;
        updates.push({ sessionUpdate: "agent_thought_chunk", ...(id ? { messageId: id } : {}), content: { type: "text", text: delta } });
        return;
      }
      case "TOOL_CALL_START": {
        const id = text(event.toolCallId);
        if (!id) return;
        const name = text(event.toolCallName) ?? "tool";
        this.open.set(id, name);
        updates.push({ sessionUpdate: "tool_call", toolCallId: id, title: name, name, kind: "other", status: "in_progress" });
        return;
      }
      case "CUSTOM": {
        if (event.name !== TOOL_RESULT) return;
        const value = event.value as { toolCallId?: unknown; isError?: unknown } | undefined;
        const id = text(value?.toolCallId);
        if (!id || !this.open.has(id)) return;
        this.open.delete(id);
        updates.push({ sessionUpdate: "tool_call_update", toolCallId: id, status: value?.isError === true ? "failed" : "completed" });
        return;
      }
      default:
        // TOOL_CALL_ARGS, TOOL_CALL_END and TOOL_CALL_RESULT carry nothing the client can show from
        // the ordinary channel; the other types are bookkeeping.
        return;
    }
  }
}
