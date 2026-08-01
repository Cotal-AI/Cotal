/**
 * Codex app-server driver — a JSON-RPC 2.0 client that owns a `codex app-server` child and
 * drives one live thread: start a turn (wake), steer a turn already in flight (true mid-turn
 * injection), or interrupt one.
 *
 * The child is run as a **shared server** (`--listen ws://…`), not a private stdio pipe, because
 * that is what lets the operator attach the REAL Codex TUI to the very same thread the mesh
 * drives (`codex resume --remote …`, see tui.ts). A stdio app-server has exactly one client and
 * no way in. Multi-client is a designed app-server capability: `thread/resume` on a *running*
 * thread rejoins it, and the server fans its event stream out to every attached client.
 *
 * The cotal_* tools deliberately do NOT ride this connection. A client-provided `dynamicTools`
 * call is routed to whichever client owns the turn, so it would break the moment a human typed
 * into the attached TUI; they are served over a loopback MCP endpoint instead, where the
 * app-server itself is the client and every turn can reach them (see mcp.ts).
 *
 * The listener is loopback-only AND authenticated: `--ws-auth capability-token` with a 0600
 * token file inside the agent's private CODEX_HOME. Without it any local process could connect
 * and drive the agent (the listener has no auth by default), so the token is the boundary.
 *
 * Protocol: app-server **v2** (the API the Codex TUI itself runs on — feature
 * `tui_app_server` is permanently on), verified live against codex-cli 0.145.0.
 * `initialize` declares `capabilities.experimentalApi: true`, which the experimental v2
 * surface requires. Every protocol shape this connector depends on lives in
 * THIS file, so a Codex upgrade has one blast radius; regenerate the reference
 * bindings with `codex app-server generate-ts --experimental` to diff on drift.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";

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
  /** mcpToolCall */
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
  timer: ReturnType<typeof setTimeout>;
}

/** Deadline on every JSON-RPC request. Without one, a wedged child leaves `initialize` /
 *  `turn/start` / `turn/steer` pending FOREVER — the steer-settlement barrier then never
 *  resolves and the whole delivery loop buffers behind a turn that cannot end. A timed-out
 *  request rejects (the host's retry rails take over); repeated consecutive timeouts mean the
 *  child is dead-but-breathing, so the driver kills it and the host exits for a clean respawn. */
const REQUEST_TIMEOUT_MS = 60_000;
const FATAL_CONSECUTIVE_TIMEOUTS = 3;
/** How long to wait for the child to print its `listening on: ws://…` banner before giving up. */
const LISTEN_TIMEOUT_MS = 30_000;

/** Written into the thread at start so a rollout exists on disk for the TUI to resume. It lands
 *  in model-visible history, so it reads as a plain statement of fact rather than an instruction. */
const PRIMER = "[cotal] This session is a Cotal mesh peer.";

/** Where (and with what credential) the real Codex TUI can attach to this agent's thread. */
export interface RemoteEndpoint {
  /** `ws://127.0.0.1:<port>` — loopback only; the child refuses to bind anything else. */
  url: string;
  /** The capability token the listener requires (also on disk, 0600, inside CODEX_HOME). */
  token: string;
  /** Absolute path of that token file. */
  tokenFile: string;
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
  /** Extra env for the child, applied AFTER the COTAL_* scrub. The MCP bearer token rides here:
   *  the child genuinely needs that one capability, while everything else COTAL_* stays hidden. */
  extraEnv?: Record<string, string>;
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
  private ws?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private threadId?: string;
  private activeTurnId?: string;
  private endpoint?: RemoteEndpoint;
  private readonly opts: DriverOpts;
  private readonly log: (m: string) => void;

  /** Where the TUI attaches. Defined once {@link start} has resolved. */
  get remote(): RemoteEndpoint | undefined {
    return this.endpoint;
  }

  get thread(): string | undefined {
    return this.threadId;
  }

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

  /** Spawn `codex app-server`, initialize, and start the thread. Resolves with the thread id.
   *  Re-callable: the host restarts a crashed app-server in place (same mesh lifecycle). */
  async start(): Promise<string> {
    // A fresh capability token per incarnation: a restarted app-server invalidates the old one,
    // so a stale TUI (or anything that scraped the previous token) cannot drive the new child.
    const token = randomBytes(32).toString("hex");
    const tokenFile = join(this.opts.codexHome, "remote-token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    // Port 0 = let the OS pick; the child prints the one it got. Fixed ports would collide
    // between concurrent agents on one workstation.
    const args = [
      "app-server",
      "--listen",
      "ws://127.0.0.1:0",
      "--ws-auth",
      "capability-token",
      "--ws-token-file",
      tokenFile,
    ];
    for (const [k, v] of this.opts.configOverrides) args.push("-c", `${k}=${v}`);
    // The child inherits the host's (already allow-listed) env, minus COTAL_* — the codex
    // process and anything it spawns have no business reading the mesh identity — plus the
    // per-agent CODEX_HOME that keeps the operator's config/hooks/MCP servers out (see host.ts).
    const env: Record<string, string> = { CODEX_HOME: this.opts.codexHome };
    for (const [k, v] of Object.entries(process.env))
      if (v !== undefined && !k.startsWith("COTAL_") && k !== "CODEX_HOME") env[k] = v;
    for (const [k, v] of Object.entries(this.opts.extraEnv ?? {})) env[k] = v;
    const child = spawn(this.opts.bin ?? "codex", args, {
      cwd: this.opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    // In listen mode neither pipe is the protocol channel (the websocket is): they carry the
    // startup banner naming the port the OS assigned, then ordinary diagnostics. codex-cli 0.145
    // prints that banner on STDERR, so both streams are scanned rather than assuming one — the
    // port is the one thing we cannot proceed without.
    let banner = "";
    let sawBanner = false;
    const onBanner: ((url: string) => void)[] = [];
    const scan = (d: string): void => {
      if (!sawBanner) {
        banner += d;
        const m = /listening on:\s*(ws:\/\/\S+)/.exec(banner);
        if (m) {
          sawBanner = true;
          for (const f of onBanner) f(m[1]);
          return;
        }
      }
      this.log(`app-server: ${d.trimEnd()}`);
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", scan);
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", scan);
    // ONE-SHOT finalizer for every way the child can die. A spawn failure (ENOENT/EACCES)
    // emits `error` + `close` but never `exit` — an exit-only handler would leave `initialize`
    // pending forever while the mesh endpoint sits connected with no Codex behind it.
    let finalized = false;
    const finalize = (code: number): void => {
      if (finalized) return;
      finalized = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`app-server gone (${p.method})`));
      }
      this.pending.clear();
      this.activeTurnId = undefined;
      try {
        this.ws?.close();
      } catch {
        /* the child is already gone */
      }
      this.ws = undefined;
      this.emit("closed", code);
    };
    child.on("exit", (code, signal) => finalize(code ?? (signal ? 1 : 0)));
    child.on("close", (code, signal) => finalize(code ?? (signal ? 1 : 0)));
    child.on("error", (e) => {
      this.log(`app-server spawn/pipe error: ${e.message}`);
      finalize(1);
    });

    // Wait for the port, then dial it. A child that dies during startup rejects here rather than
    // hanging: `closed` has already fired by then, so the host's restart rail owns the outcome.
    const url = await new Promise<string>((res, rej) => {
      if (sawBanner) return; // impossible before the listener is wired, but keep the branch honest
      const timer = setTimeout(
        () => rej(new Error(`codex app-server did not report a listen address within ${LISTEN_TIMEOUT_MS}ms`)),
        LISTEN_TIMEOUT_MS,
      );
      timer.unref?.();
      onBanner.push((u) => {
        clearTimeout(timer);
        res(u);
      });
      child.once("close", () => {
        clearTimeout(timer);
        rej(new Error("codex app-server exited before it started listening"));
      });
    });
    this.endpoint = { url, token, tokenFile };
    await this.connect(url, token);
    this.log(`app-server listening on ${url}`);

    const init = (await this.request("initialize", {
      clientInfo: { name: "cotal", title: "Cotal", version: "0.0.0" },
      // The experimental v2 surface this driver speaks is gated behind this capability.
      capabilities: { experimentalApi: true },
    })) as { userAgent?: string };
    this.notify("initialized");
    if (init?.userAgent) this.log(`app-server up: ${init.userAgent}`);

    const started = (await this.request("thread/start", {
      cwd: this.opts.cwd,
      ...(this.opts.developerInstructions ? { developerInstructions: this.opts.developerInstructions } : {}),
    })) as { thread?: { id?: string }; model?: string };
    const id = started.thread?.id;
    if (!id) throw new Error("thread/start returned no thread id");
    this.threadId = id;
    this.startedModel = started.model;
    // Materialize the thread's rollout file. `thread/start` alone writes NOTHING to disk, and
    // `thread/resume` (how the TUI attaches) fails with "no rollout found" until something does
    // — so without this the TUI could not attach until after the agent's first mesh turn.
    // `thread/inject_items` appends to model-visible history without spending a model call.
    try {
      await this.request("thread/inject_items", {
        threadId: id,
        items: [{ type: "message", role: "user", content: [{ type: "input_text", text: PRIMER }] }],
      });
    } catch (e) {
      // Non-fatal: the mesh loop works regardless; only TUI attach before the first turn suffers.
      this.log(`thread priming failed (TUI attach may need one turn first): ${(e as Error).message}`);
    }
    this.log(`thread ${id} (model ${started.model ?? "?"})`);
    return id;
  }

  /** Dial the child's websocket, presenting the capability token. Rejects (rather than hanging)
   *  on a refused or unauthorized handshake. */
  private connect(url: string, token: string): Promise<void> {
    return new Promise<void>((res, rej) => {
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      this.ws = ws;
      const fail = (e: Error): void => {
        if (this.ws === ws) this.ws = undefined;
        rej(e);
      };
      ws.once("open", () => res());
      ws.once("error", (e: Error) => fail(new Error(`app-server websocket: ${e.message}`)));
      ws.on("message", (data: Buffer | string) => this.onData(String(data)));
      ws.on("close", () => {
        // The child's own exit is the authority for `closed` (it fires the finalizer). A socket
        // that drops while the child lives is still fatal to this driver: every request would
        // hang. Kill the child so the host's restart rail runs exactly one recovery path.
        if (this.ws === ws && this.child && !this.child.killed) {
          this.log("app-server websocket closed unexpectedly — killing the child to force a clean restart");
          this.child.kill("SIGKILL");
        }
      });
    });
  }

  /** The model the thread actually started with (config default or `-c model` override). */
  private startedModel?: string;

  get model(): string | undefined {
    return this.startedModel;
  }

  /** Begin a new user turn — wakes the session. The active turn id is adopted from the
   *  `turn/started` NOTIFICATION, never from this response: notifications are processed in wire
   *  order inside the read loop, so `turn/started` always precedes `turn/completed`, and by the
   *  time a terminal event is handled the id is set. Adopting from the awaited response instead
   *  would run as a later microtask — after a same-chunk `turn/started`+`turn/completed` already
   *  cleared the id — and would resurrect the dead turn (falsely busy forever). */
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

  /** The account state Codex reports (`account/read`): `account` is null when no credentials
   *  resolve; `requiresOpenaiAuth` is false for fully custom model providers. */
  async readAccount(): Promise<{ account?: unknown; requiresOpenaiAuth?: boolean }> {
    return (await this.request("account/read", {})) as { account?: unknown; requiresOpenaiAuth?: boolean };
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
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
    this.child?.kill("SIGTERM");
  }

  // ---- JSON-RPC plumbing ---------------------------------------------------

  private consecutiveTimeouts = 0;

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      if (!this.writeLine({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }))
        return reject(new Error("app-server not running"));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.consecutiveTimeouts++;
        this.log(`request ${method} timed out (${REQUEST_TIMEOUT_MS}ms, ${this.consecutiveTimeouts} consecutive)`);
        if (this.consecutiveTimeouts >= FATAL_CONSECUTIVE_TIMEOUTS) {
          this.log("app-server unresponsive — killing it so the host can exit and redeliver");
          this.child?.kill("SIGKILL"); // the exit finalizer rejects the rest + emits closed
        }
        reject(new Error(`${method} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, method, timer });
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.writeLine({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  private writeLine(obj: unknown): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(obj));
    return true;
  }

  /** One websocket frame. Unlike a byte stream a frame is already a COMPLETE unit — there is no
   *  partial message to carry across reads, and waiting for a trailing newline that framing does
   *  not require would stall the protocol forever. A frame may still pack several newline-
   *  delimited messages, so split, and process them in wire order. */
  private onData(chunk: string): void {
    for (const line of chunk.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(text) as RpcMessage;
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
      if (!p) return; // unknown/expired id — a late reply after its timeout already rejected
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      this.consecutiveTimeouts = 0; // the child is alive and answering
      if (msg.error) p.reject(new Error(msg.error.message ?? "app-server error"));
      else p.resolve(msg.result);
      return;
    }
    // Server→client request (id AND method): approvals and elicitations.
    if (msg.id !== undefined && msg.method) return this.onServerRequest(msg.id, msg.method);
    // Notification (method, no id).
    if (msg.method) this.onNotification(msg.method, msg.params ?? {});
  }

  private onServerRequest(id: number | string, method: string): void {
    // Approvals. The host enforces approval_policy=never at launch (host.ts refuses an override
    // to any interactive mode a headless session cannot honestly answer) and pre-approves its
    // OWN MCP tools (`default_tools_approval_mode=approve`), so these shouldn't fire. If one
    // arrives anyway, DECLINE with the method's own response shape — an unattended host must
    // never grant authority the policy didn't, and an unanswered request would hang the turn
    // forever. Method-specific: a generic suffix match must not answer shapes it doesn't know
    // (item/permissions/requestApproval wants {permissions, scope}, not a decision).
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
        // Terminal events are correlated by EXACT turn id: a stale or duplicated terminal for
        // an old turn must never close the live one (and so ack the live turn's surfaced ids).
        // Fail closed on ambiguity: an id mismatch is ignored; a MISSING/unknown status is
        // reported as "interrupted" (no ack → redeliver) rather than assumed successful.
        const turn = params.turn as { id?: string; status?: TurnStatus } | undefined;
        if (!this.activeTurnId || !turn?.id || turn.id !== this.activeTurnId) {
          if (turn?.id !== undefined || this.activeTurnId !== undefined)
            this.log(`ignoring turn/completed for ${turn?.id ?? "?"} (active: ${this.activeTurnId ?? "none"})`);
          return;
        }
        const status: TurnStatus =
          turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted"
            ? turn.status
            : "interrupted";
        this.activeTurnId = undefined;
        this.emit("turnCompleted", { turnId: turn.id, status });
        return;
      }
      default:
        return; // deltas, token usage, hook/thread status — not load-bearing for the host
    }
  }
}
