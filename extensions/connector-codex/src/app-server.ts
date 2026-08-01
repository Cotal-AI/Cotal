/**
 * Codex app-server driver — a JSON-RPC 2.0 (JSONL over stdio) client that owns a
 * `codex app-server` child and drives one live thread: start a turn (wake), steer a
 * turn already in flight (true mid-turn injection), or interrupt one. The cotal_*
 * tools ride the SAME pipe as app-server **dynamicTools**: the server calls back
 * with `item/tool/call` and this driver dispatches into the host's handler — no MCP
 * sidecar process, no second mesh endpoint.
 *
 * Protocol: app-server **v2** (the API the Codex TUI itself runs on — feature
 * `tui_app_server` is permanently on), verified live against codex-cli 0.145.0.
 * `initialize` must declare `capabilities.experimentalApi: true` or `thread/start`
 * rejects `dynamicTools`. Every protocol shape this connector depends on lives in
 * THIS file, so a Codex upgrade has one blast radius; regenerate the reference
 * bindings with `codex app-server generate-ts --experimental` to diff on drift.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

/** A dynamic (client-provided) tool, as `thread/start` accepts it. */
export interface DynamicTool {
  type: "function";
  name: string;
  description: string;
  inputSchema: unknown;
}

/** One `item/tool/call` from the server: the model invoked a dynamic tool. */
export interface ToolCall {
  callId: string;
  tool: string;
  arguments: unknown;
}

/** What the host's dispatcher returns for a tool call. */
export interface ToolReply {
  text: string;
  isError?: boolean;
}

/** A thread item as the notifications carry it — only the fields the host reads. */
export interface ThreadItem {
  type?: string;
  id?: string;
  text?: string;
  /** agentMessage: `commentary` (preamble) or `final_answer`. */
  phase?: string;
  /** commandExecution */
  command?: string;
  exitCode?: number | null;
  /** dynamicToolCall / mcpToolCall */
  tool?: string;
  status?: string;
  arguments?: unknown;
  [k: string]: unknown;
}

/** Terminal turn statuses (`inProgress` is the only non-terminal one). */
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
}

/** One decoded line off the app-server: a response, a notification, or a server→client request. */
interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface DriverOpts {
  /** The agent's working directory (the thread's cwd). */
  cwd: string;
  /** Per-agent CODEX_HOME (isolation boundary: operator MCP servers / hooks / config never load). */
  codexHome: string;
  /** `-c key=value` config overrides for the child (model, effort, approval/sandbox policy …). */
  configOverrides: readonly (readonly [string, string])[];
  /** Persona → `thread/start.developerInstructions`. */
  developerInstructions?: string;
  /** The cotal_* surface, rendered by the host (tools.ts). */
  dynamicTools: DynamicTool[];
  /** Dispatch one model-invoked tool call; the reply text is fed back into the turn. */
  onToolCall: (call: ToolCall) => Promise<ToolReply>;
  /** Binary override (tests point this at a fake server). */
  bin?: string;
  log?: (m: string) => void;
}

/**
 * Emits:
 *  - `"turnStarted"` (turnId)                          — a turn began (→ working)
 *  - `"turnCompleted"` ({turnId, status})              — a turn reached a terminal status
 *  - `"itemStarted"` / `"itemCompleted"` (item, turnId) — thread items (feed/transcript/presence)
 *  - `"waiting"` (detail)                              — an approval was requested (auto-answered)
 *  - `"closed"` (code)                                 — the child exited
 */
export class AppServerDriver extends EventEmitter {
  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buf = "";
  private threadId?: string;
  private activeTurnId?: string;
  private readonly opts: DriverOpts;
  private readonly log: (m: string) => void;

  constructor(opts: DriverOpts) {
    super();
    this.opts = opts;
    this.log = opts.log ?? ((m) => process.stderr.write(`[cotal-codex] ${m}\n`));
  }

  get busy(): boolean {
    return this.activeTurnId !== undefined;
  }

  get currentTurnId(): string | undefined {
    return this.activeTurnId;
  }

  /** Spawn `codex app-server`, initialize, and start the thread. Resolves with the thread id. */
  async start(): Promise<string> {
    const args = ["app-server"];
    for (const [k, v] of this.opts.configOverrides) args.push("-c", `${k}=${v}`);
    // The child inherits the host's (already allow-listed) env, minus COTAL_* — the codex
    // process and anything it spawns have no business reading the mesh identity — plus the
    // per-agent CODEX_HOME that keeps the operator's config/hooks/MCP servers out (see host.ts).
    const env: Record<string, string> = { CODEX_HOME: this.opts.codexHome };
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && !k.startsWith("COTAL_") && k !== "CODEX_HOME") env[k] = v;
    const child = spawn(this.opts.bin ?? "codex", args, {
      cwd: this.opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => this.onData(d));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => this.log(`app-server: ${d.trimEnd()}`));
    child.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`app-server exited (${p.method})`));
      this.pending.clear();
      this.activeTurnId = undefined;
      this.emit("closed", code ?? 0);
    });
    child.on("error", (e) => this.emit("error", e));

    const init = (await this.request("initialize", {
      clientInfo: { name: "cotal", title: "Cotal", version: "0.0.0" },
      // dynamicTools is gated behind this capability (0.145: "requires experimentalApi").
      capabilities: { experimentalApi: true },
    })) as { userAgent?: string };
    this.notify("initialized");
    if (init?.userAgent) this.log(`app-server up: ${init.userAgent}`);

    const started = (await this.request("thread/start", {
      cwd: this.opts.cwd,
      ...(this.opts.developerInstructions ? { developerInstructions: this.opts.developerInstructions } : {}),
      dynamicTools: this.opts.dynamicTools,
    })) as { thread?: { id?: string }; model?: string };
    const id = started.thread?.id;
    if (!id) throw new Error("thread/start returned no thread id");
    this.threadId = id;
    this.startedModel = started.model;
    this.log(`thread ${id} (model ${started.model ?? "?"})`);
    return id;
  }

  /** The model the thread actually started with (config default or `-c model` override). */
  private startedModel?: string;

  get model(): string | undefined {
    return this.startedModel;
  }

  /** Begin a new user turn — wakes the session. */
  async startTurn(text: string): Promise<void> {
    if (!this.threadId) throw new Error("thread not started");
    await this.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  /** Inject input into the turn currently in flight (true mid-turn steer). Returns false when
   *  there is no active turn or it just ended — the caller falls back to {@link startTurn} at the
   *  next turn boundary. `expectedTurnId` makes the injection race-safe: if the turn we aimed at
   *  already completed, the server rejects instead of silently binding to a newer turn. */
  async steer(text: string): Promise<boolean> {
    const turnId = this.activeTurnId;
    if (!this.threadId || !turnId) return false;
    try {
      await this.request("turn/steer", {
        threadId: this.threadId,
        input: [{ type: "text", text, text_elements: [] }],
        expectedTurnId: turnId,
      });
      return true;
    } catch (e) {
      this.log(`steer declined: ${(e as Error).message}`);
      return false;
    }
  }

  /** Cancel the in-flight turn, if any (its surfaced messages then redeliver — see host.ts). */
  async interrupt(): Promise<void> {
    const turnId = this.activeTurnId;
    if (!this.threadId || !turnId) return;
    try {
      await this.request("turn/interrupt", { threadId: this.threadId, turnId });
    } catch (e) {
      this.log(`interrupt failed: ${(e as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    try {
      this.child?.stdin?.end();
    } catch {
      /* ignore */
    }
    this.child?.kill("SIGTERM");
  }

  // ---- JSON-RPC plumbing ---------------------------------------------------

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      if (!this.writeLine({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }))
        return reject(new Error("app-server not running"));
      this.pending.set(id, { resolve, reject, method });
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.writeLine({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  private writeLine(obj: unknown): boolean {
    const stdin = this.child?.stdin;
    if (!stdin || !stdin.writable) return false;
    stdin.write(JSON.stringify(obj) + "\n");
    return true;
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        continue; // not a protocol line — ignore
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: RpcMessage): void {
    // Response to one of our requests (id, no method).
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      if (msg.error) p.reject(new Error(msg.error.message ?? "app-server error"));
      else p.resolve(msg.result);
      return;
    }
    // Server→client request (id AND method): dynamic tool calls + approvals.
    if (msg.id !== undefined && msg.method) return this.onServerRequest(msg.id, msg.method, msg.params ?? {});
    // Notification (method, no id).
    if (msg.method) this.onNotification(msg.method, msg.params ?? {});
  }

  private onServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method === "item/tool/call") {
      const call: ToolCall = {
        callId: String(params.callId ?? ""),
        tool: String(params.tool ?? ""),
        arguments: params.arguments,
      };
      // Dispatch async; the turn blocks on this reply, exactly like any tool. success:false
      // surfaces a tool error to the model (it sees the text and can react) — a dispatch THROW
      // still must answer, or the turn hangs forever.
      void this.opts
        .onToolCall(call)
        .catch((e) => ({ text: `tool ${call.tool} failed: ${(e as Error).message}`, isError: true }))
        .then((r) =>
          this.writeLine({
            jsonrpc: "2.0",
            id,
            result: { contentItems: [{ type: "inputText", text: r.text }], success: !r.isError },
          }),
        );
      return;
    }
    // Approvals. The host enforces approval_policy=never at launch (host.ts refuses an override
    // to any interactive mode a headless session cannot honestly answer), so these shouldn't
    // fire. If one arrives anyway, DECLINE with the method's own response shape — an unattended
    // host must never grant authority the policy didn't, and an unanswered request would hang
    // the turn forever. Method-specific: a generic suffix match must not answer shapes it
    // doesn't know (item/permissions/requestApproval wants {permissions, scope}, not a decision).
    this.emit("waiting", method);
    if (method === "execCommandApproval" || method === "applyPatchApproval")
      return void this.writeLine({ jsonrpc: "2.0", id, result: { decision: "denied" } }); // legacy ReviewDecision
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval")
      return void this.writeLine({ jsonrpc: "2.0", id, result: { decision: "decline" } }); // v2 decision enums
    // Anything else (permissions requests, elicitations, attestation, user-input): decline cleanly.
    this.writeLine({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported by the cotal host" } });
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "turn/started": {
        const turn = params.turn as { id?: string } | undefined;
        this.activeTurnId = turn?.id;
        if (this.activeTurnId) this.emit("turnStarted", this.activeTurnId);
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = params.item as ThreadItem | undefined;
        if (item) this.emit(method === "item/started" ? "itemStarted" : "itemCompleted", item, params.turnId as string | undefined);
        return;
      }
      case "turn/failed": // terminal, but turn/completed (status:"failed") follows on the same turn
        return;
      case "turn/completed": {
        const turn = params.turn as { id?: string; status?: TurnStatus } | undefined;
        const turnId = turn?.id ?? this.activeTurnId;
        this.activeTurnId = undefined;
        this.emit("turnCompleted", { turnId, status: turn?.status ?? "completed" });
        return;
      }
      default:
        return; // deltas, token usage, hook/thread status — not load-bearing for the host
    }
  }
}
