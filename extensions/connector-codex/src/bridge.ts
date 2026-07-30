import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
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
  batches: ReservedBatch[];
  uncertainBatches: ReservedBatch[];
  scope?: string;
  pendingSteers: number;
  completion?: { status: unknown };
  recovery: boolean;
}

interface ReservedBatch {
  ids: string[];
  scope?: string;
  text: string;
}

interface Recovery {
  batches: ReservedBatch[];
  reason: string;
  automatic: boolean;
}

interface PendingStart {
  batches: ReservedBatch[];
  recovery: boolean;
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
 * and uncertain work stays reserved in the live MeshAgent and gets one reconciliation turn before
 * any later inbox scope is surfaced.
 */
export class CodexBridge {
  private readonly peer: AppServerPeer;
  private readonly agent: BridgeAgent;
  private readonly model?: string;
  private readonly effort?: string;
  private readonly developerInstructions?: string;
  private readonly threadConfig?: Record<string, unknown>;
  private readonly reservedIds = new Set<string>();
  private readonly tasks = new Set<Promise<unknown>>();
  private threadId?: string;
  private activeTurn?: ActiveTurn;
  private recovery?: Recovery;
  private pendingStart?: PendingStart;
  private initialPrompt?: string;
  private active = false;
  private stopping = false;
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
  }) {
    this.peer = opts.peer;
    this.agent = opts.agent;
    this.model = opts.model;
    this.effort = opts.effort;
    this.developerInstructions = opts.developerInstructions;
    this.threadConfig = opts.threadConfig;
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

  /**
   * Fence TUI attachment on the app-server's stored-thread view. Codex 0.146 can return from
   * `thread/start` before a concurrent `codex resume --remote` can discover the rollout; attaching
   * in that window exits with `no rollout found`. `thread/read` is the protocol's stored-thread
   * boundary, so poll it instead of sleeping or starting a synthetic model turn.
   */
  async waitUntilStored(timeoutMs = 15_000): Promise<void> {
    if (!this.threadId) throw new Error("Codex thread has not started");
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (true) {
      try {
        const result = (await this.peer.request("thread/read", {
          threadId: this.threadId,
          includeTurns: false,
        })) as { thread?: { id?: unknown; path?: unknown } };
        if (
          result.thread?.id === this.threadId &&
          typeof result.thread.path === "string" &&
          existsSync(result.thread.path)
        )
          return;
        lastError = new Error(
          result.thread?.id !== this.threadId
            ? "thread/read returned a different or missing thread id"
            : "thread/read returned before the rollout path existed",
        );
      } catch (error) {
        lastError = error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(
          `Codex thread ${this.threadId} did not become attachable within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        );
      await delay(Math.min(50, remaining));
    }
  }

  /** Release the startup gate after the attached TUI has been spawned. */
  activate(): void {
    if (this.stopping) return;
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
    if (!this.active || this.stopping || !this.threadId) return;
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
    if (this.recovery || this.activeTurn?.recovery) return [];
    const candidates = this.agent
      .peekInbox("automatic")
      .filter((item) => !this.reservedIds.has(item.id));
    if (!candidates.length) return [];
    const scope = this.activeTurn?.scope ?? inboxScope(candidates[0]);
    return candidates.filter((item) => inboxScope(item) === scope);
  }

  private async driveOnce(): Promise<boolean> {
    if (!this.threadId || this.stopping) return false;
    if (this.recovery) {
      if (this.activeTurn || !this.recovery.automatic) return false;
      return this.startRecovery(this.recovery);
    }
    const items = this.unreservedInbox();
    const injection = formatInjection(items);
    const prompt = this.initialPrompt;
    if (!prompt && !injection) return false;
    const text = [prompt, injection].filter(Boolean).join("\n\n");
    const ids = items.map((item) => item.id);
    let batch: ReservedBatch | undefined;
    if (ids.length > 0) {
      if (!injection) throw new Error("Cotal inbox formatter returned no batch text");
      batch = {
        ids,
        scope: items[0] ? inboxScope(items[0]) : undefined,
        text: injection,
      };
    }
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
          if (batch) turn.batches.push(batch);
          turn.scope ??= batch?.scope;
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
          if (!(error instanceof AppServerResponseError) && batch)
            turn.uncertainBatches.push(batch);
          if (turn.completion)
            await this.completeTurn(turn, turn.completion.status);
        }
        if (!(error instanceof AppServerResponseError)) {
          process.stderr.write(
            `[cotal-codex] turn/steer outcome is uncertain; holding its inbox batch until the active turn completes: ${(error as Error).message}\n`,
          );
          return false;
        }
        this.release(ids);
        // A completion may have won the race. If its event already cleared the turn, the queued
        // batch can safely become a fresh turn; otherwise wait for that authoritative event.
        if (!this.activeTurn) this.queueDrive();
        process.stderr.write(
          `[cotal-codex] turn/steer rejected; batch remains queued: ${(error as Error).message}\n`,
        );
        return false;
      }
    }

    const pendingStart: PendingStart = {
      batches: batch ? [batch] : [],
      recovery: false,
    };
    this.pendingStart = pendingStart;
    try {
      const result = (await this.peer.request("turn/start", {
        threadId: this.threadId,
        input: [textInput(text)],
        ...(this.effort ? { effort: this.effort } : {}),
      })) as { turn?: { id?: string } };
      const turnId = result.turn?.id;
      if (!turnId) throw new Error("codex turn/start returned no turn id");
      if (this.pendingStart === pendingStart) this.pendingStart = undefined;
      if (
        !this.activeTurn &&
        this.recoveryOwnsAny(pendingStart.batches)
      )
        return false;
      if (!this.activeTurn)
        this.activeTurn = {
          id: turnId,
          batches: pendingStart.batches,
          uncertainBatches: [],
          scope: batch?.scope,
          pendingSteers: 0,
          recovery: false,
        };
      if (this.activeTurn.id !== turnId) {
        for (const candidate of pendingStart.batches)
          if (
            !this.activeTurn.uncertainBatches.includes(candidate) &&
            !this.activeTurn.batches.includes(candidate)
          )
            this.activeTurn.uncertainBatches.push(candidate);
        process.stderr.write(
          `[cotal-codex] mesh turn ${turnId} raced with active turn ${this.activeTurn.id}; holding its inbox batch for reconciliation at the active turn boundary\n`,
        );
        return false;
      }
      this.confirmPendingStart(this.activeTurn, pendingStart);
      this.initialPrompt = undefined;
      await this.safeStatus("working");
      return true;
    } catch (error) {
      if (this.pendingStart === pendingStart) this.pendingStart = undefined;
      const attached = this.activeTurn
        ? pendingStart.batches.some(
            (candidate) =>
              this.activeTurn?.uncertainBatches.includes(candidate) ||
              this.activeTurn?.batches.includes(candidate),
          )
        : false;
      if (error instanceof AppServerResponseError && this.activeTurn) {
        this.activeTurn.uncertainBatches =
          this.activeTurn.uncertainBatches.filter(
            (candidate) => !pendingStart.batches.includes(candidate),
          );
      }
      if (!attached || error instanceof AppServerResponseError) this.release(ids);
      process.stderr.write(
        `[cotal-codex] turn/start failed; batch remains queued: ${(error as Error).message}\n`,
      );
      if (!(error instanceof AppServerResponseError) && batch && !attached) {
        for (const id of batch.ids) this.reservedIds.add(id);
        this.recovery = {
          batches: [batch],
          reason: `turn/start outcome is uncertain: ${(error as Error).message}`,
          automatic: false,
        };
        await this.safeStatus(
          "waiting",
          "Cotal inbox batch held after uncertain turn/start",
        );
      }
      return false;
    }
  }

  private async startRecovery(recovery: Recovery): Promise<boolean> {
    if (!this.threadId || this.stopping || this.recovery !== recovery) return false;
    const ids = recovery.batches.flatMap((batch) => batch.ids);
    const exactBatch = recovery.batches.map((batch) => batch.text).join("\n\n");
    const text = [
      "COTAL RECOVERY: the previous mesh-originated turn did not reach a clean successful boundary, so its outcome is uncertain.",
      `Reason: ${recovery.reason}.`,
      "Do not blindly repeat commands, tool calls, messages, or other external actions. First inspect and reconcile the current state, then perform only work that is still missing. Treat the reserved inbox batch below as the exact recovery scope; newer inbox traffic is intentionally queued for later turns.",
      `Reserved Cotal inbox ids: ${ids.join(", ")}`,
      exactBatch,
    ].join("\n\n");
    const pendingStart: PendingStart = {
      batches: recovery.batches,
      recovery: true,
    };
    this.pendingStart = pendingStart;
    this.recovery = undefined;
    try {
      const result = (await this.peer.request("turn/start", {
        threadId: this.threadId,
        input: [textInput(text)],
        ...(this.effort ? { effort: this.effort } : {}),
      })) as { turn?: { id?: string } };
      const turnId = result.turn?.id;
      if (!turnId) throw new Error("codex recovery turn/start returned no turn id");
      if (this.pendingStart === pendingStart) this.pendingStart = undefined;
      if (
        !this.activeTurn &&
        this.recoveryOwnsAny(pendingStart.batches)
      )
        return false;
      if (!this.activeTurn)
        this.activeTurn = {
          id: turnId,
          batches: pendingStart.batches,
          uncertainBatches: [],
          scope: recovery.batches[0]?.scope,
          pendingSteers: 0,
          recovery: true,
        };
      if (this.activeTurn.id !== turnId) {
        for (const candidate of pendingStart.batches)
          if (
            !this.activeTurn.uncertainBatches.includes(candidate) &&
            !this.activeTurn.batches.includes(candidate)
          )
            this.activeTurn.uncertainBatches.push(candidate);
        await this.safeStatus(
          "waiting",
          "Cotal recovery held after concurrent Codex turn",
        );
        return false;
      }
      this.confirmPendingStart(this.activeTurn, pendingStart);
      this.activeTurn.scope = recovery.batches[0]?.scope;
      this.activeTurn.recovery = true;
      await this.safeStatus("working", "Reconciling interrupted Cotal work");
      return false;
    } catch (error) {
      if (this.pendingStart === pendingStart) this.pendingStart = undefined;
      let attached = this.activeTurn
        ? pendingStart.batches.some(
            (candidate) =>
              this.activeTurn?.uncertainBatches.includes(candidate) ||
              this.activeTurn?.batches.includes(candidate),
          )
        : false;
      if (error instanceof AppServerResponseError && this.activeTurn) {
        this.activeTurn.uncertainBatches =
          this.activeTurn.uncertainBatches.filter(
            (candidate) => !pendingStart.batches.includes(candidate),
          );
        attached = false;
      }
      if (!attached) this.recovery = { ...recovery, automatic: false };
      process.stderr.write(
        `[cotal-codex] recovery turn/start failed; exact inbox batch remains held in-process: ${(error as Error).message}\n`,
      );
      await this.safeStatus(
        "waiting",
        "Cotal recovery batch held for operator attention",
      );
      return false;
    }
  }

  private confirmPendingStart(turn: ActiveTurn, pending: PendingStart): void {
    turn.uncertainBatches = turn.uncertainBatches.filter(
      (candidate) => !pending.batches.includes(candidate),
    );
    for (const batch of pending.batches)
      if (!turn.batches.includes(batch)) turn.batches.push(batch);
    turn.recovery ||= pending.recovery;
  }

  private recoveryOwnsAny(batches: ReservedBatch[]): boolean {
    return (
      this.recovery?.batches.some((candidate) => batches.includes(candidate)) ??
      false
    );
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
          this.activeTurn = {
            id,
            batches: [],
            uncertainBatches: [...(this.pendingStart?.batches ?? [])],
            scope: this.pendingStart?.batches[0]?.scope,
            pendingSteers: 0,
            recovery: this.pendingStart?.recovery ?? false,
          };
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
    const surfacedIds = turn.batches.flatMap((batch) => batch.ids);
    const uncertainIds = turn.uncertainBatches.flatMap((batch) => batch.ids);
    this.activeTurn = undefined;
    const completed = status === "completed";
    if (!completed && surfacedIds.length === 0 && uncertainIds.length === 0) {
      await this.safeStatus("idle");
      this.queueDrive();
      return;
    }
    if (completed && surfacedIds.length > 0) {
      this.agent.drainInboxIds(surfacedIds);
      this.release(surfacedIds);
    }
    const recoveryBatches = completed
      ? turn.uncertainBatches
      : [...turn.batches, ...turn.uncertainBatches];
    if (recoveryBatches.length > 0) {
      this.recovery = {
        batches: recoveryBatches,
        reason: `turn ${turn.id} ended ${String(status)}`,
        automatic: !turn.recovery,
      };
      await this.safeStatus(
        "waiting",
        turn.recovery
          ? "Cotal recovery failed; exact batch held for operator attention"
          : "Cotal turn outcome uncertain; reconciling exact inbox batch",
      );
      if (!turn.recovery) this.queueDrive();
      else
        process.stderr.write(
          `[cotal-codex] recovery turn ${turn.id} ended ${String(status)}; exact inbox batch remains held in-process\n`,
        );
      return;
    }
    await this.safeStatus("idle", turn.recovery ? "" : undefined);
    this.queueDrive();
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
