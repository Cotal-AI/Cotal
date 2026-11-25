/**
 * AG-UI frames from a seat's event channel and its payload rail, mapped to ACP `session/update`
 * notifications.
 *
 * The event channel carries text and reasoning as completed messages, tool calls by name and
 * boundary, and the `cotal.toolResult` marker for a call's end. A tool call's arguments and result
 * travel on the payload rail (SPEC 13.19), which the seat's owner may read. Its frame keeps the
 * event frame's epoch and sequence and is published before it, so either may arrive first. A call
 * shows its kind, title, file locations and edits once its arguments arrive, and its output once its
 * result does. A seat whose payloads are withheld shows its calls by name and status only.
 */
import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import type { AguiEventLike, SeatFrame } from "./mesh.js";
import { describeTool, isPlanTool, Plan } from "./tools.js";

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

/** A payload value the emitter replaced because its frame did not fit (SPEC 13.19). */
function cutNote(value: string): string | undefined {
  if (!value.startsWith("{")) return undefined;
  try {
    const cut = JSON.parse(value) as { cotalPayloadCut?: unknown; originalBytes?: unknown };
    return cut.cotalPayloadCut === true ? `[not shown: ${String(cut.originalBytes)} bytes, over the payload rail's size limit]` : undefined;
  } catch {
    return undefined;
  }
}

/** A call's arguments as they parsed, or the raw text when they are not JSON. */
function parsed(raw: string): unknown {
  if (cutNote(raw)) return { note: cutNote(raw) };
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface Call {
  name: string;
  /** The event channel's TOOL_CALL_START was seen, so the client knows the call. */
  started: boolean;
  /** The call is the harness's todo tool: its arguments show as the session's plan, not as a call. */
  plan: boolean;
  args?: string;
  result?: { content: string; isError: boolean };
  /** The call ended: the marker, or its result when the connector publishes no marker. */
  ended?: "completed" | "failed";
  /** Shown as ended to the client, so the end of the turn need not close it. */
  closed: boolean;
}

/** Map one seat's frames in order. One mapper per ACP session, because message roles and tool calls
 *  carry from one frame to the next. `harness` names the seat's application, which decides how its
 *  tools read, and `cwd` is the seat's folder, which a relative file path is in. */
export class FrameMapper {
  private readonly roles = new Map<string, "user" | "assistant">();
  private readonly calls = new Map<string, Call>();
  private readonly seen = new Set<string>();
  private readonly plan = new Plan();

  constructor(private readonly harness = "", private readonly cwd?: string) {}

  /** Map one frame. A frame already mapped (same plane, epoch and seq) maps to nothing, so a history
   *  read and a live tap can overlap. */
  map(frame: SeatFrame): Mapped {
    const key = `${frame.plane}:${frame.epoch}:${frame.seq}`;
    if (this.seen.has(key)) return { updates: [], runs: [] };
    this.seen.add(key);
    const updates: SessionUpdate[] = [];
    const runs: RunSignal[] = [];
    for (const event of frame.events) {
      if (frame.plane === "payloads") this.payload(event, updates);
      else this.event(event, frame, updates, runs);
    }
    return { updates, runs };
  }

  /** The tool calls still open, closed with `status`. A prompt answers only after this, so no call
   *  stays open in the client once its turn has ended. */
  closeOpen(status: "completed" | "failed"): SessionUpdate[] {
    const updates: SessionUpdate[] = [];
    for (const [toolCallId, call] of this.calls) {
      if (call.started && !call.plan && !call.closed) updates.push({ sessionUpdate: "tool_call_update", toolCallId, status });
    }
    this.calls.clear();
    return updates;
  }

  private call(id: string): Call {
    let call = this.calls.get(id);
    if (!call) {
      call = { name: "tool", started: false, plan: false, closed: false };
      this.calls.set(id, call);
    }
    return call;
  }

  /** What the client is told about a call it knows, from what has arrived. */
  private details(call: Call): { title: string; kind: ReturnType<typeof describeTool>["kind"]; rawInput?: unknown; locations?: ReturnType<typeof describeTool>["locations"]; content?: ToolCallContent[] } {
    const input = call.args === undefined ? undefined : parsed(call.args);
    const view = describeTool(this.harness, call.name, input, this.cwd);
    const content: ToolCallContent[] = [...(view.diffs ?? [])];
    if (call.result) content.push({ type: "content", content: { type: "text", text: cutNote(call.result.content) ?? call.result.content } });
    return {
      title: view.title,
      kind: view.kind,
      ...(input !== undefined ? { rawInput: input } : {}),
      ...(view.locations ? { locations: view.locations } : {}),
      ...(content.length ? { content } : {}),
    };
  }

  private update(id: string, call: Call, updates: SessionUpdate[]): void {
    if (call.plan) {
      const entries = call.args === undefined ? undefined : this.plan.apply(this.harness, call.name, id, parsed(call.args), call.result?.content);
      if (entries) updates.push({ sessionUpdate: "plan", entries });
      return;
    }
    // A result that arrives after the marker still shows on the call it belongs to.
    if (!call.started) return;
    const status = call.ended;
    updates.push({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      ...this.details(call),
      ...(call.result ? { rawOutput: cutNote(call.result.content) ?? call.result.content } : {}),
      ...(status ? { status } : {}),
    });
    if (status) call.closed = true;
  }

  private payload(event: AguiEventLike, updates: SessionUpdate[]): void {
    const id = text(event.toolCallId);
    if (!id) return;
    const call = this.call(id);
    if (event.type === "TOOL_CALL_ARGS") {
      call.args = (call.args ?? "") + (text(event.delta) ?? "");
      this.update(id, call, updates);
    } else if (event.type === "TOOL_CALL_RESULT") {
      const isError = (event.cotal as { isError?: unknown } | undefined)?.isError === true;
      call.result = { content: text(event.content) ?? JSON.stringify(event.content ?? ""), isError };
      // A connector without the marker ends a call with its result.
      if (!call.ended && call.started) call.ended = isError ? "failed" : "completed";
      this.update(id, call, updates);
    }
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
        const call = this.call(id);
        if (call.started) return;
        call.name = text(event.toolCallName) ?? "tool";
        call.started = true;
        call.plan = isPlanTool(this.harness, call.name);
        if (call.plan) return this.update(id, call, updates);
        // Arguments and a result that beat the call's start arrive with it.
        if (call.result && !call.ended) call.ended = call.result.isError ? "failed" : "completed";
        const { title, kind, ...rest } = this.details(call);
        updates.push({ sessionUpdate: "tool_call", toolCallId: id, title, kind, status: call.ended ?? "in_progress", ...rest, ...(call.result ? { rawOutput: cutNote(call.result.content) ?? call.result.content } : {}) });
        if (call.ended) call.closed = true;
        return;
      }
      case "CUSTOM": {
        if (event.name !== TOOL_RESULT) return;
        const value = event.value as { toolCallId?: unknown; isError?: unknown } | undefined;
        const id = text(value?.toolCallId);
        const call = id ? this.calls.get(id) : undefined;
        if (!id || !call || !call.started || call.plan || call.closed) return;
        call.ended = value?.isError === true ? "failed" : "completed";
        this.update(id, call, updates);
        return;
      }
      default:
        // TOOL_CALL_ARGS and TOOL_CALL_RESULT ride the payload rail; TOOL_CALL_END and the other types
        // are bookkeeping.
        return;
    }
  }
}
