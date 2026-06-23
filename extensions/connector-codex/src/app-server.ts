/**
 * Codex app-server driver — a JSON-RPC 2.0 (JSONL over stdio) client that owns a
 * `codex app-server` child and drives a live thread: start a turn (wake), steer a
 * turn already in flight (true mid-turn injection), or interrupt one. Presence
 * falls out of the app-server's own event stream, so the host never guesses what
 * the session is doing.
 *
 * This is the host-mode path: Cotal is the parent holding the pipe, so a peer
 * message becomes a real user turn — unlike the pull-only MCP injection. Built to
 * the app-server **v2** protocol the TUI/VS Code extension also speak; verified
 * against codex-cli 0.137.0 (`codex app-server generate-ts`). The wire omits the
 * `jsonrpc` field, matching the generated bindings.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

/** A text user-input item (the only kind we send). `text_elements` is required by the schema. */
function textInput(text: string): { type: "text"; text: string; text_elements: never[] } {
  return { type: "text", text, text_elements: [] };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** One decoded line off the app-server: a response, a notification, or a server→client request. */
interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * Emits:
 *  - `"turnStarted"` (turnId)            — a turn began (→ working)
 *  - `"turnCompleted"` ({turnId, text})  — a turn finished; `text` = final agent message (may be "")
 *  - `"waiting"`                          — an approval was requested (auto-answered)
 *  - `"closed"` (code)                    — the child exited
 *  - `"error"` (Error)
 */
export class AppServerDriver extends EventEmitter {
  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buf = "";
  private threadId?: string;
  private activeTurnId?: string;
  /** Final agent-message text per turn (the last `agentMessage` item of a turn is the reply). */
  private readonly replyByTurn = new Map<string, string>();
  private readonly cwd: string;
  private readonly model?: string;
  private readonly log: (m: string) => void;

  constructor(opts: { cwd: string; model?: string; log?: (m: string) => void }) {
    super();
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.log = opts.log ?? ((m) => process.stderr.write(`[cotal-codex-host] ${m}\n`));
  }

  get busy(): boolean {
    return this.activeTurnId !== undefined;
  }

  /** Spawn `codex app-server`, initialize, and start a thread. Resolves with the thread id. */
  async start(): Promise<string> {
    // approval_policy=never + sandbox=workspace-write make a spawned session autonomous; without
    // them the first command would block on an approval the host can't surface (deadlock).
    const child = spawn(
      "codex",
      ["app-server", "-c", 'approval_policy="never"', "-c", 'sandbox_mode="workspace-write"'],
      { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => this.onData(d));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (d: string) => this.log(`app-server: ${d.trimEnd()}`));
    child.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error("app-server exited"));
      this.pending.clear();
      this.emit("closed", code ?? 0);
    });
    child.on("error", (e) => this.emit("error", e));

    await this.request("initialize", {
      clientInfo: { name: "cotal", title: "Cotal", version: "0.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");

    const started = (await this.request("thread/start", {
      cwd: this.cwd,
      ...(this.model ? { model: this.model } : {}),
      approvalPolicy: "never",
      sandbox: "workspace-write",
    })) as { thread?: { id?: string } };
    const id = started.thread?.id;
    if (!id) throw new Error("thread/start returned no thread id");
    this.threadId = id;
    this.log(`thread started: ${id}`);
    return id;
  }

  /** Begin a new user turn — wakes the session. */
  async startTurn(text: string): Promise<void> {
    if (!this.threadId) throw new Error("thread not started");
    await this.request("turn/start", { threadId: this.threadId, input: [textInput(text)] });
  }

  /** Inject input into the turn currently in flight (true mid-turn steer). Returns false if there
   *  is no active turn or the turn just ended (the caller then falls back to {@link startTurn}). */
  async steer(text: string): Promise<boolean> {
    if (!this.threadId || !this.activeTurnId) return false;
    try {
      await this.request("turn/steer", {
        threadId: this.threadId,
        input: [textInput(text)],
        expectedTurnId: this.activeTurnId,
      });
      return true;
    } catch (e) {
      this.log(`steer failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Cancel the in-flight turn, if any. */
  async interrupt(): Promise<void> {
    if (!this.threadId || !this.activeTurnId) return;
    try {
      await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.activeTurnId });
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
      if (!this.writeLine({ id, method, ...(params ? { params } : {}) }))
        return reject(new Error("app-server not running"));
      this.pending.set(id, { resolve, reject });
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.writeLine({ method, ...(params ? { params } : {}) });
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
        continue;
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
    // Server→client request (id AND method) — approvals etc. Keep the session autonomous.
    if (msg.id !== undefined && msg.method) return this.answerServerRequest(msg.id, msg.method);
    // Notification (method, no id).
    if (msg.method) this.onNotification(msg.method, msg.params ?? {});
  }

  /** Auto-answer server-initiated requests so an unattended session never stalls. With
   *  approval_policy=never these shouldn't fire, but we accept defensively. */
  private answerServerRequest(id: number | string, method: string): void {
    this.emit("waiting");
    if (method === "execCommandApproval" || method === "applyPatchApproval")
      return void this.writeLine({ id, result: { decision: "approved" } }); // legacy: ReviewDecision
    if (method.endsWith("/requestApproval"))
      return void this.writeLine({ id, result: { decision: "accept" } }); // v2 approval decision
    // Anything we don't implement (dynamic tool calls, elicitations): decline cleanly.
    this.writeLine({ id, error: { code: -32601, message: "unsupported by cotal host" } });
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "turn/started": {
        const turn = params.turn as { id?: string } | undefined;
        this.activeTurnId = turn?.id;
        if (this.activeTurnId) this.emit("turnStarted", this.activeTurnId);
        return;
      }
      case "item/completed": {
        const item = params.item as { type?: string; text?: string } | undefined;
        const turnId = params.turnId as string | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string" && turnId)
          this.replyByTurn.set(turnId, item.text); // last agentMessage of the turn = the reply
        return;
      }
      case "turn/completed": {
        const turn = params.turn as { id?: string; status?: string } | undefined;
        const turnId = turn?.id ?? this.activeTurnId;
        const text = (turnId && this.replyByTurn.get(turnId)) || "";
        if (turnId) this.replyByTurn.delete(turnId);
        this.activeTurnId = undefined;
        // status ∈ completed | interrupted | failed — the host acks the inbox only on a clean
        // finish, so an interrupted/crashed turn redelivers its surfaced messages.
        this.emit("turnCompleted", { turnId, text, status: turn?.status ?? "completed" });
        return;
      }
      default:
        return; // deltas, reasoning, diffs, status pings — not needed for presence/reply
    }
  }
}
