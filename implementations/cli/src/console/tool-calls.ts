import { chatSubject, eventChannel, eventPayloadSubject, isAguiFramePart, oneLine, type CotalEndpoint, type CotalMessage } from "@cotal-ai/core";

export interface ConsoleToolCall {
  id: string;
  name: string;
  args?: string;
  result?: string;
}

/** Per-observer cache. Taps live until the observer stops, including across detail remounts. */
const observers = new WeakMap<CotalEndpoint, Map<string, ConsoleTools>>();
const MAX_CALLS = 100;
const MAX_BODY = 256_000;

export function payloadText(value: string): string {
  try {
    const cut = JSON.parse(value) as Record<string, unknown>;
    if (cut?.cotalPayloadCut === true) return `cotalPayloadCut: true · originalBytes=${String(cut.originalBytes)} · sha256=${String(cut.sha256)}`;
  } catch { /* Ordinary string payload. */ }
  return value;
}

export class ConsoleTools {
  readonly calls = new Map<string, ConsoleToolCall>();
  private seen = new Set<string>();
  private listeners = new Set<() => void>();
  error?: string;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void { for (const listener of this.listeners) listener(); }

  ingest(msg: CotalMessage): void {
    if (this.seen.has(msg.id)) return;
    this.seen.add(msg.id);
    if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value!);
    if (!Array.isArray(msg.parts)) return;
    for (const part of msg.parts) {
      if (!isAguiFramePart(part)) continue;
      const frame = part as unknown as Record<string, unknown>;
      if (!Array.isArray(frame.events)) continue;
      for (const event of frame.events) {
        if (!event || typeof event !== "object") continue;
        const e = event as Record<string, unknown>;
        if (typeof e.toolCallId !== "string") continue;
        if (e.type !== "TOOL_CALL_START" && e.type !== "TOOL_CALL_ARGS" && e.type !== "TOOL_CALL_RESULT") continue;
        const id = JSON.stringify([frame.threadId, frame.runId, frame.epoch, e.toolCallId]);
        const call = this.calls.get(id) ?? { id, name: e.toolCallId };
        if (e.type === "TOOL_CALL_START" && typeof e.toolCallName === "string") call.name = e.toolCallName;
        if (e.type === "TOOL_CALL_ARGS" && typeof e.delta === "string") call.args = bounded((call.args ?? "") + e.delta);
        if (e.type === "TOOL_CALL_RESULT" && typeof e.content === "string") call.result = bounded(e.content);
        this.calls.set(id, call);
        if (this.calls.size > MAX_CALLS) this.calls.delete(this.calls.keys().next().value!);
      }
    }
    this.changed();
  }

  unavailable(error: unknown): void {
    this.error = oneLine(error instanceof Error ? error.message : String(error));
    this.changed();
  }
}

function bounded(body: string): string {
  // Never imply that a locally bounded display contains the complete payload.
  return body.length <= MAX_BODY ? body : body.slice(0, MAX_BODY) + "\n[console display limit reached]";
}

/** Only a selected concrete principal is subscribed. Broker grants remain authoritative. */
export function consoleTools(ep: CotalEndpoint, owner: string, actor: string): ConsoleTools {
  let principals = observers.get(ep);
  if (!principals) observers.set(ep, principals = new Map());
  const key = `${owner}.${actor}`;
  const existing = principals.get(key);
  if (existing) return existing;
  const model = new ConsoleTools();
  principals.set(key, model);
  const receive = (_subject: string, msg: CotalMessage | undefined) => { if (msg) model.ingest(msg); };
  ep.tap(receive, { subject: eventPayloadSubject(ep.space, owner, actor) });
  // Metadata supplies names while payload frames supply args and results, joined by run and call id.
  ep.tap(receive, { subject: chatSubject(ep.space, owner, actor, eventChannel({ owner, actor })) });
  void ep.channelHistory(eventChannel({ owner, actor }), { limit: 100, publisher: { owner, actor } })
    .then((rows) => { for (const row of rows) model.ingest(row); }).catch((error: unknown) => model.unavailable(error));
  void ep.eventPayloadHistory(owner, actor, { limit: 100 })
    .then((rows) => { for (const row of rows) model.ingest(row); }).catch((error: unknown) => model.unavailable(error));
  return model;
}
