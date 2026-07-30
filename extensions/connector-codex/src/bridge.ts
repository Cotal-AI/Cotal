import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import { formatInjection, type InboxItem } from "@cotal-ai/connector-core";
import {
  AppServerResponseError,
  type RpcMessage,
} from "./rpc.js";
import { CONNECTOR_VERSION } from "./version.js";

export type { RpcMessage } from "./rpc.js";

export interface AppServerPeer extends EventEmitter {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  respond(id: string | number, result: unknown): void;
  respondError(id: string | number, code: number, message: string): void;
}

export interface BridgeAgent extends EventEmitter {
  peekInbox(scope?: "all" | "automatic" | "pull-only"): InboxItem[];
  drainInboxIds(ids: readonly string[]): { items: InboxItem[]; missingIds: string[] };
  setStatus(
    status: "idle" | "working" | "waiting" | "offline",
    activity?: string,
  ): Promise<unknown>;
}

interface ActiveTurn {
  id: string;
  surfacedIds: Set<string>;
  scope?: string;
  pendingSteers: number;
  completion?: { status: unknown };
}

function textInput(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/** Keep private and channel audiences in separate turns so one context cannot accidentally blend them. */
export function inboxScope(item: InboxItem): string {
  return item.kind === "channel"
    ? `channel:${item.channel ?? ""}`
    : `direct:${item.fromId}`;
}

/**
 * Maps one persistent Codex app-server thread onto one MeshAgent.
 *
 * Inbox ids are reserved while a turn/start or turn/steer request is uncertain, then acknowledged
 * only after the matching explicit `turn/completed` event reports `completed`. Failed, interrupted,
 * timed-out, and connection-lost work remains in the MeshAgent inbox for durable redelivery.
 */
export class CodexBridge {
  private readonly peer: AppServerPeer;
  private readonly agent: BridgeAgent;
  private readonly model?: string;
  private readonly effort?: string;
  private readonly developerInstructions?: string;
  private readonly threadConfig?: Record<string, unknown>;
  private readonly onFatal?: (error: Error) => void;
  private readonly reservedIds = new Set<string>();
  private readonly tasks = new Set<Promise<unknown>>();
  private threadId?: string;
  private activeTurn?: ActiveTurn;
  private initialPrompt?: string;
  private active = false;
  private stopping = false;
  private failed = false;
  private driving = false;
  private driveAgain = false;
  private lastStatus?: {
    status: "idle" | "working" | "waiting" | "offline";
    activity?: string;
  };

  constructor(opts: {
    peer: AppServerPeer;
    agent: BridgeAgent;
    model?: string;
    effort?: string;
    developerInstructions?: string;
    threadConfig?: Record<string, unknown>;
    initialPrompt?: string;
    onFatal?: (error: Error) => void;
  }) {
    this.peer = opts.peer;
    this.agent = opts.agent;
    this.model = opts.model;
    this.effort = opts.effort;
    this.developerInstructions = opts.developerInstructions;
    this.threadConfig = opts.threadConfig;
    this.onFatal = opts.onFatal;
    this.initialPrompt = opts.initialPrompt?.trim() || undefined;
    this.peer.on("notification", (message: RpcMessage) =>
      this.track(this.onNotification(message)),
    );
    this.peer.on("serverRequest", (message: RpcMessage) =>
      this.track(this.onServerRequest(message)),
    );
    this.agent.on("incoming", () => this.queueDrive());
    this.agent.on("wake", () => this.queueDrive());
    this.agent.on("mention-wake", () => this.queueDrive());
  }

  async start(): Promise<string> {
    await this.peer.request("initialize", {
      clientInfo: {
        name: "cotal_codex_connector",
        title: "Cotal Codex Connector",
        version: CONNECTOR_VERSION,
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.peer.notify("initialized", {});
    const threadConfig = { ...this.threadConfig };
    if (this.effort) {
      const configuredEffort = threadConfig.model_reasoning_effort;
      if (configuredEffort !== undefined && configuredEffort !== this.effort)
        throw new Error(
          `Codex effort "${this.effort}" conflicts with thread config model_reasoning_effort "${String(configuredEffort)}"`,
        );
      threadConfig.model_reasoning_effort = this.effort;
    }
    const result = (await this.peer.request("thread/start", {
      serviceName: "cotal",
      ...(this.model ? { model: this.model } : {}),
      ...(this.developerInstructions
        ? { developerInstructions: this.developerInstructions }
        : {}),
      ...(Object.keys(threadConfig).length > 0
        ? { config: threadConfig }
        : {}),
    })) as { thread?: { id?: string } };
    const threadId = result.thread?.id;
    if (!threadId) throw new Error("codex thread/start returned no thread id");
    this.threadId = threadId;
    await this.safeStatus("idle");
    return threadId;
  }

  /** Release the startup gate after the attached TUI has been spawned. */
  activate(): void {
    if (this.stopping || this.failed) return;
    this.active = true;
    this.queueDrive();
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    if (!this.threadId || !turn) return;
    await this.peer.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: turn.id,
    });
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.active = false;
    try {
      if (this.threadId)
        await this.peer.request("thread/backgroundTerminals/clean", {
          threadId: this.threadId,
        });
    } finally {
      await this.safeStatus("offline");
    }
  }

  /** Test/teardown helper: wait until currently scheduled event and drive work settles. */
  async settled(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const tasks = [...this.tasks];
      if (!tasks.length && !this.driving && !this.driveAgain) return;
      await Promise.race([
        Promise.allSettled(tasks).then(() => undefined),
        setImmediate(),
      ]);
    }
    throw new Error(
      `CodexBridge did not settle (tasks=${this.tasks.size}, driving=${this.driving}, driveAgain=${this.driveAgain})`,
    );
  }

  private track<T>(task: Promise<T>): void {
    const tracked = task.catch((error) => {
      process.stderr.write(`[cotal-codex] ${(error as Error).message}\n`);
    });
    this.tasks.add(tracked);
    void tracked.finally(() => this.tasks.delete(tracked));
  }

  private queueDrive(): void {
    if (!this.active || this.stopping || this.failed || !this.threadId) return;
    if (this.driving) {
      this.driveAgain = true;
      return;
    }
    this.driving = true;
    this.track(
      (async () => {
        try {
          do {
            this.driveAgain = false;
            const shouldContinue = await this.driveOnce();
            if (!shouldContinue) return;
          } while (this.driveAgain);
        } finally {
          this.driving = false;
          if (this.driveAgain) {
            this.driveAgain = false;
            queueMicrotask(() => this.queueDrive());
          }
        }
      })(),
    );
  }

  private unreservedInbox(): InboxItem[] {
    const candidates = this.agent
      .peekInbox("automatic")
      .filter((item) => !this.reservedIds.has(item.id));
    if (!candidates.length) return [];
    const scope = this.activeTurn?.scope ?? inboxScope(candidates[0]);
    return candidates.filter((item) => inboxScope(item) === scope);
  }

  private async driveOnce(): Promise<boolean> {
    if (!this.threadId || this.stopping) return false;
    const items = this.unreservedInbox();
    const injection = formatInjection(items);
    const prompt = this.initialPrompt;
    if (!prompt && !injection) return false;
    const text = [prompt, injection].filter(Boolean).join("\n\n");
    const ids = items.map((item) => item.id);
    for (const id of ids) this.reservedIds.add(id);

    if (this.activeTurn) {
      const turn = this.activeTurn;
      const expectedTurnId = turn.id;
      turn.pendingSteers += 1;
      try {
        await this.peer.request("turn/steer", {
          threadId: this.threadId,
          input: [textInput(text)],
          expectedTurnId,
        });
        if (this.activeTurn === turn) {
          for (const id of ids) turn.surfacedIds.add(id);
          turn.scope ??= items[0] ? inboxScope(items[0]) : undefined;
          turn.pendingSteers -= 1;
          this.initialPrompt = undefined;
          if (turn.completion) {
            await this.completeTurn(turn, turn.completion.status);
            return false;
          }
          return true;
        }
        this.release(ids);
        return false;
      } catch (error) {
        if (this.activeTurn === turn) {
          turn.pendingSteers -= 1;
          if (turn.completion)
            await this.completeTurn(turn, turn.completion.status);
        }
        this.release(ids);
        if (!(error instanceof AppServerResponseError)) {
          this.failed = true;
          this.onFatal?.(
            new Error(
              `Codex turn/steer outcome is uncertain; restarting without acknowledging its inbox work: ${(error as Error).message}`,
            ),
          );
          return false;
        }
        // A completion may have won the race. If its event already cleared the turn, the queued
        // batch can safely become a fresh turn; otherwise wait for that authoritative event.
        if (!this.activeTurn) this.queueDrive();
        process.stderr.write(
          `[cotal-codex] turn/steer rejected; batch remains queued: ${(error as Error).message}\n`,
        );
        return false;
      }
    }

    try {
      const result = (await this.peer.request("turn/start", {
        threadId: this.threadId,
        input: [textInput(text)],
        ...(this.effort ? { effort: this.effort } : {}),
      })) as { turn?: { id?: string } };
      const turnId = result.turn?.id;
      if (!turnId) throw new Error("codex turn/start returned no turn id");
      if (!this.activeTurn)
        this.activeTurn = {
          id: turnId,
          surfacedIds: new Set(),
          scope: items[0] ? inboxScope(items[0]) : undefined,
          pendingSteers: 0,
        };
      if (this.activeTurn.id !== turnId) {
        this.release(ids);
        this.failed = true;
        this.onFatal?.(
          new Error(
            `Codex started mesh turn ${turnId}, but concurrent turn ${this.activeTurn.id} became active; restarting without acknowledging its inbox work`,
          ),
        );
        return false;
      }
      for (const id of ids) this.activeTurn.surfacedIds.add(id);
      this.initialPrompt = undefined;
      await this.safeStatus("working");
      return true;
    } catch (error) {
      this.release(ids);
      process.stderr.write(
        `[cotal-codex] turn/start failed; batch remains queued: ${(error as Error).message}\n`,
      );
      this.failed = true;
      this.onFatal?.(error as Error);
      return false;
    }
  }

  private release(ids: Iterable<string>): void {
    for (const id of ids) this.reservedIds.delete(id);
  }

  private async onNotification(message: RpcMessage): Promise<void> {
    const params = message.params ?? {};
    if (
      typeof params.threadId === "string" &&
      this.threadId &&
      params.threadId !== this.threadId
    )
      return;
    switch (message.method) {
      case "turn/started": {
        const id = (params.turn as { id?: unknown } | undefined)?.id;
        if (typeof id !== "string") return;
        if (this.activeTurn?.id !== id)
          this.activeTurn = { id, surfacedIds: new Set(), pendingSteers: 0 };
        await this.safeStatus("working");
        this.queueDrive();
        return;
      }
      case "turn/completed": {
        const turn = params.turn as { id?: unknown; status?: unknown } | undefined;
        if (typeof turn?.id !== "string" || this.activeTurn?.id !== turn.id) return;
        if (this.activeTurn.pendingSteers > 0)
          this.activeTurn.completion = { status: turn.status };
        else await this.completeTurn(this.activeTurn, turn.status);
        return;
      }
      case "thread/status/changed": {
        const status = params.status as
          | { type?: unknown; activeFlags?: unknown }
          | undefined;
        if (status?.type === "active") {
          const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
          await this.safeStatus(
            flags.includes("waitingOnApproval") ? "waiting" : "working",
          );
        } else if (status?.type === "idle") {
          await this.safeStatus("idle");
        } else if (status?.type === "systemError") {
          await this.safeStatus("waiting", "Codex app-server system error");
        }
        return;
      }
      case "serverRequest/resolved":
        if (this.activeTurn) await this.safeStatus("working");
        return;
      default:
        return;
    }
  }

  private async completeTurn(turn: ActiveTurn, status: unknown): Promise<void> {
    if (this.activeTurn !== turn) return;
    const ids = [...turn.surfacedIds];
    this.activeTurn = undefined;
    const completed = status === "completed";
    if (!completed && ids.length === 0) {
      await this.safeStatus("idle");
      this.queueDrive();
      return;
    }
    if (!completed) this.failed = true;
    if (completed) this.agent.drainInboxIds(ids);
    this.release(ids);
    await this.safeStatus("idle");
    // A successful turn is a safe boundary for the next queued batch. Failed/interrupted work
    // waits for a supervised restart; the connector never guesses whether to replay.
    if (completed) this.queueDrive();
    else {
      this.onFatal?.(
        new Error(
          `Codex turn ${turn.id} ended ${String(status)}; restarting without acknowledging its inbox work`,
        ),
      );
    }
  }

  private async onServerRequest(message: RpcMessage): Promise<void> {
    if (message.id === undefined || !message.method) return;
    const params = message.params ?? {};
    if (
      typeof params.threadId === "string" &&
      this.threadId &&
      params.threadId !== this.threadId
    ) {
      this.peer.respondError(message.id, -32602, "request belongs to another Cotal thread");
      return;
    }
    if (
      message.method.endsWith("/requestApproval") ||
      message.method === "item/tool/requestUserInput" ||
      message.method === "mcpServer/elicitation/request"
    ) {
      // The attached Codex TUI is the approval/elicitation UI. This bridge observes the request for
      // presence but does not auto-accept it or race the human client with a second response.
      await this.safeStatus("waiting", message.method);
    }
  }

  private async safeStatus(
    status: "idle" | "working" | "waiting" | "offline",
    activity?: string,
  ): Promise<void> {
    if (
      this.lastStatus?.status === status &&
      this.lastStatus.activity === activity
    )
      return;
    try {
      await this.agent.setStatus(status, activity);
      this.lastStatus = { status, activity };
    } catch {
      // Presence is advisory and can race the mesh endpoint's initial/reconnect window.
    }
  }
}
