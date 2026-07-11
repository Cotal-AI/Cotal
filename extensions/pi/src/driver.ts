import { randomUUID } from "node:crypto";
import type { InboxItem, MeshAgent } from "@cotal-ai/connector-core";
import { formatInjection } from "@cotal-ai/connector-core";
import { InboxTurn } from "./inbox-turn.js";

const CUSTOM_TYPE = "cotal-inbox";
const BATCH_LIMIT = 32;
const DEFAULT_START_TIMEOUT_MS = 5_000;

export type DriverState = "idle" | "dispatching" | "streaming" | "held" | "shuttingDown";

export interface CotalBatchDetails {
  version: 1;
  batchId: string;
  ids: string[];
}

export interface PiContextLike {
  signal?: AbortSignal;
  isIdle(): boolean;
  hasUI: boolean;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  shutdown(): void;
}

export interface PiHost {
  sendMessage(
    message: { customType: string; content: string; display: boolean; details: CotalBatchDetails },
    options: { triggerTurn: true; deliverAs: "steer" },
  ): void;
}

interface Batch {
  id: string;
  ids: string[];
  content: string;
  started: boolean;
  confirmed: boolean;
  watchdog?: ReturnType<typeof setTimeout>;
}

interface PendingEnd {
  stopReason?: string;
  context: PiContextLike;
  timer?: ReturnType<typeof setImmediate>;
}

function detailsOf(message: unknown): CotalBatchDetails | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as { role?: unknown; customType?: unknown; details?: unknown };
  if (value.role !== "custom" || value.customType !== CUSTOM_TYPE || !value.details || typeof value.details !== "object")
    return undefined;
  const details = value.details as Partial<CotalBatchDetails>;
  if (details.version !== 1 || typeof details.batchId !== "string" || !Array.isArray(details.ids)) return undefined;
  if (!details.ids.every((id) => typeof id === "string")) return undefined;
  return details as CotalBatchDetails;
}

function ownChannelEcho(mesh: MeshAgent, item: InboxItem): boolean {
  return item.kind === "channel" && item.fromId === mesh.id;
}

function wakeable(mesh: MeshAgent, item: InboxItem): boolean {
  if (ownChannelEcho(mesh, item)) return false;
  if (item.kind !== "channel" || item.mentionsMe) return true;
  if (mesh.channelMode(item.channel) === "quiet") return false;
  return mesh.attention === "open";
}

/** Serialized Pi-owned delivery driver. No event callback calls the host send API outside this class. */
export class PiDriver {
  private readonly inbox: InboxTurn;
  private host?: PiHost;
  private context?: PiContextLike;
  private batches: Batch[] = [];
  private requestBatchIds = new Set<string>();
  private nudges: string[] = [];
  private presence = Promise.resolve();
  private activeSignal?: AbortSignal;
  private pendingEnd?: PendingEnd;
  private overflowRetry = false;
  private _state: DriverState = "idle";
  private heldReason?: string;

  constructor(
    private readonly mesh: MeshAgent,
    private readonly startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  ) {
    this.inbox = new InboxTurn(mesh);
  }

  get state(): DriverState {
    return this._state;
  }

  get reason(): string | undefined {
    return this.heldReason;
  }

  bind(host: PiHost): void {
    this.host = host;
  }

  onSessionStart(context: PiContextLike): void {
    this.context = context;
    if (this._state === "shuttingDown") {
      context.shutdown();
      return;
    }
    this.pump();
  }

  onSessionShutdown(): void {
    this.context = undefined;
  }

  onIncoming(): void {
    this.pump();
  }

  onWake(): void {
    this.pump();
  }

  onMentionWake(item: InboxItem): void {
    const who = item.fromRole ? `${item.fromName}/${item.fromRole}` : item.fromName;
    this.nudges.push(
      `Cotal: you were @mentioned on #${item.channel} by ${who} while focused. ` +
        "The body is held; read it with cotal_inbox and reply with cotal_send if warranted.",
    );
    if (this.nudges.length > BATCH_LIMIT) this.nudges.splice(0, this.nudges.length - BATCH_LIMIT);
    this.pump();
  }

  onAgentStart(context: PiContextLike): void {
    this.context = context;
    this.activeSignal = context.signal;
    this.overflowRetry = false;
    if (this._state === "held" && this.batches.length === 0) {
      this.heldReason = undefined;
      this._state = "streaming";
    } else if (this._state !== "held") {
      this._state = this.batches.some((batch) => !batch.confirmed) ? "dispatching" : "streaming";
    }
    this.enqueuePresence("working", "thinking");
    if (this._state !== "held") this.pump(true);
  }

  onMessageStart(message: unknown): void {
    const details = detailsOf(message);
    if (!details) return;
    const batch = this.batches.find((candidate) => candidate.id === details.batchId);
    if (!batch || batch.ids.length !== details.ids.length || !batch.ids.every((id, i) => id === details.ids[i])) return;
    batch.started = true;
    if (batch.watchdog) clearTimeout(batch.watchdog);
    batch.watchdog = undefined;
  }

  onContext(messages: readonly unknown[]): void {
    const visible = new Set(messages.map(detailsOf).filter((details): details is CotalBatchDetails => Boolean(details)).map((d) => d.batchId));
    this.requestBatchIds = new Set(
      this.batches.filter((batch) => batch.started && !batch.confirmed && visible.has(batch.id)).map((batch) => batch.id),
    );
  }

  onProviderResponse(status: number): void {
    if (status >= 200 && status < 300) {
      for (const id of this.requestBatchIds) {
        const batch = this.batches.find((candidate) => candidate.id === id);
        if (batch) batch.confirmed = true;
      }
    }
    this.requestBatchIds.clear();
    if (this._state !== "held" && this._state !== "shuttingDown") {
      this._state = "streaming";
      this.pump();
    }
  }

  onToolStart(name: string): void {
    this.enqueuePresence("working", `running ${name || "tool"}`);
  }

  onToolEnd(): void {
    this.enqueuePresence("working", "thinking");
  }

  onAgentEnd(messages: readonly unknown[], context: PiContextLike): void {
    const lastAssistant = [...messages]
      .reverse()
      .find((message) => message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") as
      | { stopReason?: string }
      | undefined;
    const aborted = this.activeSignal?.aborted === true;
    this.activeSignal = undefined;

    if (aborted) {
      this.finalizeEnd("abort", context);
      return;
    }

    if (lastAssistant?.stopReason === "error") {
      const pending: PendingEnd = { stopReason: "error", context };
      pending.timer = setImmediate(() => {
        if (this.pendingEnd === pending) {
          this.pendingEnd = undefined;
          this.finalizeEnd("error", context);
        }
      });
      this.pendingEnd = pending;
      return;
    }

    this.finalizeEnd("clean", context);
  }

  onBeforeCompact(reason: string, willRetry: boolean): void {
    if (reason !== "overflow" || !willRetry) return;
    this.overflowRetry = true;
    if (this.pendingEnd?.timer) clearImmediate(this.pendingEnd.timer);
    this.pendingEnd = undefined;
    if (this._state !== "held") this._state = "streaming";
    this.enqueuePresence("working", "compacting before automatic retry");
  }

  requestShutdown(): void {
    if (this._state === "shuttingDown") return;
    this._state = "shuttingDown";
    this.clearTimers();
    if (this.context) this.context.shutdown();
  }

  async quit(): Promise<void> {
    this._state = "shuttingDown";
    this.clearTimers();
    await this.presence.catch(() => {});
  }

  async flushPresence(): Promise<void> {
    await this.presence.catch(() => {});
  }

  private pump(force = false): void {
    if (!this.host || !this.context || this._state === "held" || this._state === "shuttingDown") return;
    if (this.batches.some((batch) => !batch.confirmed)) return;

    this.inbox.discardTombstonedFront();
    this.inbox.discardFront((item) => ownChannelEcho(this.mesh, item));
    const reserved = new Set(this.batches.flatMap((batch) => batch.ids));
    const available = this.inbox.peek().filter((item) => !reserved.has(item.id));
    if (!force && this.nudges.length === 0 && !available.some((item) => wakeable(this.mesh, item))) {
      if (this.batches.length === 0) this.publishIdleWhenSettled(this.context);
      return;
    }

    let ids: string[] = [];
    let content: string | undefined;
    if (this.nudges.length > 0) {
      content = this.nudges.splice(0).join("\n");
    } else {
      const items = this.inbox.select(reserved, (item) => ownChannelEcho(this.mesh, item), BATCH_LIMIT);
      if (items.length === 0) return;
      ids = items.map((item) => item.id);
      content = formatInjection(items);
    }
    if (!content) return;

    const batch: Batch = { id: randomUUID(), ids, content, started: false, confirmed: false };
    this.batches.push(batch);
    this._state = "dispatching";
    try {
      this.host.sendMessage(
        {
          customType: CUSTOM_TYPE,
          content,
          display: true,
          details: { version: 1, batchId: batch.id, ids: [...ids] },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
      if (!batch.started) {
        batch.watchdog = setTimeout(() => {
          if (!batch.started) this.hold(`Pi did not start dispatched Cotal batch ${batch.id}`);
        }, this.startTimeoutMs);
        batch.watchdog.unref?.();
      }
    } catch (error) {
      this.hold(`Pi rejected Cotal dispatch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private finalizeEnd(kind: "clean" | "error" | "abort", context: PiContextLike): void {
    if (this.overflowRetry) return;
    const confirmed = this.batches.filter((batch) => batch.confirmed);
    const ids = confirmed.flatMap((batch) => batch.ids);
    const committed = this.inbox.commitConfirmed(ids);
    this.batches = this.batches.filter((batch) => !batch.confirmed);

    if (committed.error) {
      this.hold(committed.error);
      return;
    }
    if (kind === "abort") {
      this.hold("Pi turn was aborted; Cotal delivery is held until a human turn or managed restart");
      return;
    }
    if (this.batches.length > 0) {
      this.hold(
        kind === "error"
          ? "Pi failed before confirming all dispatched Cotal messages"
          : "Pi ended before confirming a queued Cotal steer",
      );
      return;
    }

    this._state = "idle";
    this.heldReason = undefined;
    this.pump();
    if (this._state === "idle") this.publishIdleWhenSettled(context);
  }

  private hold(reason: string): void {
    this._state = "held";
    this.heldReason = reason;
    this.clearWatchdogs();
    this.enqueuePresence("waiting", reason);
    if (this.context?.hasUI) this.context.ui.notify(`Cotal delivery held: ${reason}`, "warning");
  }

  private publishIdleWhenSettled(context: PiContextLike): void {
    const check = (): void => {
      if (this._state !== "idle") return;
      if (this.context !== context) return;
      if (!context.isIdle()) {
        setTimeout(check, 10).unref?.();
        return;
      }
      this.enqueuePresence("idle");
    };
    check();
  }

  private enqueuePresence(status: "idle" | "working" | "waiting", activity?: string): void {
    this.presence = this.presence
      .then(() => this.mesh.setStatus(status, activity))
      .catch(() => {});
  }

  private clearWatchdogs(): void {
    for (const batch of this.batches) {
      if (batch.watchdog) clearTimeout(batch.watchdog);
      batch.watchdog = undefined;
    }
  }

  private clearTimers(): void {
    this.clearWatchdogs();
    if (this.pendingEnd?.timer) clearImmediate(this.pendingEnd.timer);
    this.pendingEnd = undefined;
  }
}
