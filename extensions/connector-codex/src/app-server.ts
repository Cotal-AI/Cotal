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
 * token file inside the agent's private CODEX_HOME, minted fresh per incarnation. The listener
 * has no auth of its own, so without this any process on the machine could connect and drive the
 * agent through the app-server's full RPC surface.
 *
 * What that token is, precisely: a boundary against OTHER OS USERS and against anything reaching
 * the port from off-box. It is NOT a boundary between managed agents running as the SAME user —
 * they share a uid, so a sibling that can read this agent's home (or the environment of the
 * attached TUI, which holds the token for the listener's lifetime) can present it. Cotal does not
 * claim mutually-hostile same-uid agent isolation here; that needs OS-level isolation, not a
 * file mode. See docs/connect-codex.md#limits.
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
import { closeSync, constants as fsConstants, openSync, rmSync, writeSync } from "node:fs";
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
/** How long to wait for codex to finish connecting to the cotal MCP server. Generous: it is a
 *  loopback handshake, but it happens while the thread is still coming up. */
const MCP_READY_TIMEOUT_MS = 30_000;
/** How long {@link AppServerDriver.stop} waits for a SIGTERM'd child before SIGKILL. */
const STOP_GRACE_MS = 3_000;
/** ...and how long it then waits for the SIGKILL'd child to actually be reaped before giving up
 *  and letting our own shutdown proceed. */
const STOP_KILL_GRACE_MS = 2_000;
/** The oldest codex-cli this connector is tested against — the first with the app-server listener
 *  (`--listen` / `--ws-auth`). Named in the startup failure, because a bare "it exited" tells an
 *  operator running an older binary nothing about why. */
const MIN_CODEX_VERSION = "0.145.0";
/** Sentinel key in the MCP status map meaning "this incarnation is gone". Not a server name. */
const MCP_DEAD = "\u0000dead";

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

/**
 * Write the capability token fail-closed.
 *
 * A plain write FOLLOWS a symlink. The agent's home sits under agent-writable workspace, so a
 * sibling (or this agent's own workspace-write command) can pre-plant `remote-token` as a link to
 * any path the operator can write: the next launch would then clobber that file AND deposit the
 * live bearer exactly where the planter chose. `prepareCodexHome` already refuses a symlink at
 * every managed DIRECTORY component for this same reason; the credential file needs the same
 * treatment.
 *
 * Unlink first (unlink does not follow), then create with O_EXCL|O_NOFOLLOW so a re-plant racing
 * that window fails the open instead of being followed. Any failure throws — a launch that cannot
 * privately hold its own credential must not start.
 */
function writeTokenFile(path: string, token: string): void {
  rmSync(path, { force: true });
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = openSync(path, flags, 0o600);
  } catch (e) {
    throw new Error(`refusing to write the app-server token at ${path}: ${(e as Error).message}`);
  }
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
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
   *  the child genuinely needs that one capability, while everything else COTAL_* stays hidden.
   *  (That token is host-lifetime — the endpoint outlives app-server restarts — unlike the
   *  websocket capability token, which is minted fresh per incarnation.) */
  extraEnv?: Record<string, string>;
  /** Binary override (tests point this at a fake server). */
  bin?: string;
  log?: (m: string) => void;
}

/**
 * Emits:
 *  - `"turnStarted"` (turnId, owned)                   — a turn began (→ working)
 *  - `"turnCompleted"` ({turnId, status, owned})       — a turn reached a terminal status.
 *    `owned` is false for a turn the attached TUI started: this host may observe it, but only
 *    a turn it started itself may finalize its own delivery accounting.
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
  /** Every turn currently running on the thread — OURS and the attached TUI's alike. The
   *  app-server broadcasts turn lifecycle to every client, so with a UI attached this host sees
   *  turns it did not start. A single "the active turn" slot cannot model that: a foreign turn
   *  would overwrite ours, and whichever terminal arrived second would be discarded as stale,
   *  wedging the delivery loop on a boundary that never comes. */
  private readonly liveTurns = new Set<string>();
  /** The subset of {@link liveTurns} this host started, recorded from the `turn/start` RESPONSE
   *  as it is decoded — synchronously, in wire order. It cannot be recorded in the awaited
   *  continuation instead: that runs as a later microtask, so a frame packing
   *  response+started+completed would finalize the turn before we ever claimed it. */
  private readonly ownedTurns = new Set<string>();
  /** Request ids of `turn/start` calls sent and not yet answered. While one is outstanding, a
   *  terminal for a turn we have not claimed is AMBIGUOUS — it may be the turn that request is
   *  about to name, whose notifications overtook its response. JSON-RPC does not order a
   *  notification after the response to a request in flight, so this cannot be assumed away. */
  private readonly pendingStarts = new Set<number>();
  /** Terminals held back by that ambiguity, in arrival order. Drained the moment no `turn/start`
   *  is outstanding, so each one is finally classified against a settled ownership set. */
  private buffered: { turnId: string; status: TurnStatus }[] = [];
  /** Per-incarnation record of what codex says about each configured MCP server, from its
   *  `mcpServer/startupStatus/updated` notifications. Kept as state rather than consumed as an
   *  event because the `ready` can land before anyone waits for it. */
  private readonly mcpStatus = new Map<string, { status: string; error?: string }>();
  private readonly mcpWaiters = new Set<() => void>();
  /** Set by {@link stop}: this driver has been torn down ON PURPOSE, so the child's death is
   *  expected and must not be recovered from. */
  private terminal = false;
  /** Which app-server incarnation is current. Stamped by {@link start} before its first await,
   *  so a caller reading {@link gen} on the next line holds ITS OWN incarnation's id — including
   *  on the failure path, where there is no return value to carry one. */
  private generation = 0;

  /** Has this driver been deliberately stopped? The host's crash rail asks before restarting. */
  get stopped(): boolean {
    return this.terminal;
  }

  /** The current incarnation's id (see {@link generation}). */
  get gen(): number {
    return this.generation;
  }

  /**
   * Does `gen` still name the LIVE app-server? Every await in the host's launch/restart tails is
   * a point where the child can die and the crash rail can bring up a replacement. A tail that
   * kept going would set the context id, mark the peer ready, replace the TUI and drive over an
   * incarnation it no longer owns — and its failure branch would `die()`/`stop()` the SUCCESSOR's
   * child, turning one crash into a dead agent. Stale tails must return, silently.
   */
  isCurrent(gen: number): boolean {
    return this.generation === gen;
  }
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
    return this.liveTurns.size > 0;
  }

  /** The turn to steer into or interrupt: OURS if one is running, else the human's. (Steering a
   *  peer message into a TUI-owned turn is deliberate — the person sees it — and safe, because
   *  only a turn we own can ack, so anything steered elsewhere simply redelivers.) */
  get currentTurnId(): string | undefined {
    for (const id of this.liveTurns) if (this.ownedTurns.has(id)) return id;
    for (const id of this.liveTurns) return id;
    return undefined;
  }

  /** Our own live turn, if any — the only one this host may interrupt or finalize. */
  private get ownTurnId(): string | undefined {
    for (const id of this.liveTurns) if (this.ownedTurns.has(id)) return id;
    return undefined;
  }

  /** Spawn `codex app-server`, initialize, and start the thread. Resolves with the thread id.
   *  Re-callable: the host restarts a crashed app-server in place (same mesh lifecycle). */
  async start(): Promise<string> {
    // Stamp the new incarnation FIRST, synchronously — before any await, and before anything can
    // fail. That is what lets the caller capture its own generation on the very next line and
    // fence every later step against a restart that overtook it.
    this.generation++;
    this.terminal = false;
    this.mcpStatus.clear();
    // A fresh capability token per incarnation: a restarted app-server invalidates the old one,
    // so a stale TUI (or anything that scraped the previous token) cannot drive the new child.
    const token = randomBytes(32).toString("hex");
    const tokenFile = join(this.opts.codexHome, "remote-token");
    writeTokenFile(tokenFile, token);
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
      this.liveTurns.clear();
      this.ownedTurns.clear();
      // Held terminals die with the thread that produced them: the host resets its own delivery
      // accounting on `closed` and re-drives the un-acked batch into the new thread, so emitting
      // a boundary for a turn on a dead thread could only close accounting the restart owns.
      this.pendingStarts.clear();
      this.buffered = [];
      // Whoever is awaiting MCP readiness is awaiting THIS child's. Releasing them here (rather
      // than leaving them armed) is what stops the NEXT incarnation's `ready` from resolving a
      // dead generation's continuation, which would run two recovery tails over one host.
      this.mcpStatus.set(MCP_DEAD, { status: "gone" });
      for (const w of [...this.mcpWaiters]) w();
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
        // Overwhelmingly this is a codex too old to have the listener at all (`--listen` /
        // `--ws-auth` are part of the experimental v2 surface), which an operator cannot guess
        // from a bare exit — so the error names the check and the cure.
        rej(
          new Error(
            "codex app-server exited before it started listening — check `codex --version` " +
              `(${MIN_CODEX_VERSION} or later is required for the app-server listener) and upgrade if it is older`,
          ),
        );
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
    const turnId = this.currentTurnId;
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

  /**
   * Block until codex reports the named MCP server READY, or fail.
   *
   * Without this the peer can come online MUTE: the thread starts fine, presence publishes, the
   * agent soaks deliveries — and every turn discovers it has no cotal_* tools, because the one
   * server carrying them never finished connecting. A tool-less mesh peer is exactly the silent
   * degradation this codebase refuses, so an unready server is fatal, not a warning.
   *
   * `gen` is the caller's incarnation ({@link gen}, captured right after {@link start}). Readiness
   * is a fact about ONE app-server child: without this fence a caller whose child died before it
   * even registered here would wait, see the REPLACEMENT's `ready`, and continue as though its
   * own generation had come up.
   */
  async awaitMcpReady(name: string, gen: number, timeoutMs = MCP_READY_TIMEOUT_MS): Promise<void> {
    const settled = (): { done: boolean; err?: string } => {
      if (!this.isCurrent(gen)) return { done: true, err: "this app-server incarnation was superseded by a restart" };
      if (this.mcpStatus.has(MCP_DEAD)) return { done: true, err: "the app-server died before its tools were ready" };
      const s = this.mcpStatus.get(name);
      if (!s) return { done: false };
      if (s.status === "ready") return { done: true };
      // Anything terminal that is not `ready` (failed / invalid config / auth refused) is final.
      if (s.status !== "starting") return { done: true, err: s.error ? `${s.status}: ${s.error}` : s.status };
      return { done: false };
    };
    const first = settled();
    if (first.done) {
      if (first.err) throw new Error(`codex could not start the ${name} MCP server (${first.err})`);
      return;
    }
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => {
        finish();
        rej(
          new Error(
            `codex did not connect to the ${name} MCP server within ${timeoutMs}ms — refusing to join the ` +
              `mesh without the cotal_* tools. Retry the spawn; if it repeats, check \`codex --version\` ` +
              `(${MIN_CODEX_VERSION}+) and the app-server output above for what it said about the server`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      const waiter = (): void => {
        const s = settled();
        if (!s.done) return;
        finish();
        if (s.err) rej(new Error(`codex could not start the ${name} MCP server (${s.err})`));
        else res();
      };
      const finish = (): void => {
        clearTimeout(timer);
        this.mcpWaiters.delete(waiter);
      };
      this.mcpWaiters.add(waiter);
    });
  }

  /** The account state Codex reports (`account/read`): `account` is null when no credentials
   *  resolve; `requiresOpenaiAuth` is false for fully custom model providers. */
  async readAccount(): Promise<{ account?: unknown; requiresOpenaiAuth?: boolean }> {
    return (await this.request("account/read", {})) as { account?: unknown; requiresOpenaiAuth?: boolean };
  }

  /** Cancel the in-flight turn, if any (its surfaced messages then redeliver — see host.ts). */
  async interrupt(): Promise<void> {
    const turnId = this.ownTurnId;
    if (!this.threadId || !turnId) return;
    try {
      await this.request("turn/interrupt", { threadId: this.threadId, turnId });
    } catch (e) {
      this.log(`interrupt failed: ${(e as Error).message}`);
    }
  }

  /**
   * Stop for good. DELIBERATE teardown, so it is marked terminal first: the child's death would
   * otherwise reach the host's crash-recovery rail, which would spawn a REPLACEMENT app-server
   * while the caller is busy exiting — leaving a listening codex orphaned behind a dead host.
   *
   * It also REAPS rather than just signalling. A SIGTERM that returns immediately leaves the
   * caller free to exit while the child is still winding down; a listening app-server is not
   * reaped by our pipes closing the way a stdio child was.
   */
  async stop(): Promise<void> {
    this.terminal = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = undefined;
    const child = this.child;
    // `killed` only means a signal was DELIVERED, not that the process is gone — a child already
    // signalled elsewhere (the websocket-drop SIGKILL, an unresponsive-child kill) still has to be
    // waited for here, or `stop()` returns while a listening app-server is still winding down.
    if (child && child.exitCode === null) {
      if (!child.killed) child.kill("SIGTERM");
      await new Promise<void>((res) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(escalate);
          clearTimeout(deadline);
          res();
        };
        const escalate = setTimeout(() => {
          try {
            child.kill("SIGKILL"); // a child that ignores SIGTERM must not outlive us
          } catch {
            /* already gone */
          }
        }, STOP_GRACE_MS);
        // SIGKILL is not instantaneous either, so keep waiting for the actual `exit` after it —
        // with an outer deadline, because an unreapable child must not hang our own shutdown.
        const deadline = setTimeout(finish, STOP_GRACE_MS + STOP_KILL_GRACE_MS);
        escalate.unref?.();
        deadline.unref?.();
        child.once("exit", finish);
      });
    }
    // The listener is going away, so the token on disk is only a scrape target now.
    if (this.endpoint) rmSync(this.endpoint.tokenFile, { force: true });
  }

  // ---- JSON-RPC plumbing ---------------------------------------------------

  private consecutiveTimeouts = 0;

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      if (!this.writeLine({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }))
        return reject(new Error("app-server not running"));
      if (method === "turn/start") this.pendingStarts.add(id);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (this.pendingStarts.delete(id)) this.releaseBuffered(); // a start that never answers can hold nothing
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
      // Claim the turn HERE, not in the awaited continuation: this runs in wire order, so a frame
      // packing response+started+completed still claims the turn before its terminal is handled.
      // The claim must also land BEFORE the held terminals are released, so a terminal that
      // overtook this very response is finally recognized as ours rather than the human's.
      if (p.method === "turn/start") {
        if (!msg.error) {
          const t = (msg.result as { turn?: { id?: string } } | undefined)?.turn;
          if (t?.id) this.ownedTurns.add(t.id);
        }
        this.pendingStarts.delete(msg.id as number);
        this.releaseBuffered();
      }
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

  /** Emit the terminals held while ownership was undecidable. Once no `turn/start` is outstanding
   *  the ownership set is settled, so each held turn gets its true `owned` — including one that
   *  completed before the response that claimed it ever arrived. */
  private releaseBuffered(): void {
    if (this.pendingStarts.size > 0 || this.buffered.length === 0) return;
    const held = this.buffered;
    this.buffered = [];
    for (const t of held) {
      const owned = this.ownedTurns.delete(t.turnId);
      this.emit("turnCompleted", { turnId: t.turnId, status: t.status, owned });
    }
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "turn/started": {
        const turn = params.turn as { id?: string } | undefined;
        if (!turn?.id) return;
        this.liveTurns.add(turn.id);
        this.emit("turnStarted", turn.id, this.ownedTurns.has(turn.id));
        return;
      }
      case "item/started":
      case "item/completed": {
        const item = params.item as ThreadItem | undefined;
        if (item) this.emit(method === "item/started" ? "itemStarted" : "itemCompleted", item, params.turnId as string | undefined);
        return;
      }
      case "mcpServer/startupStatus/updated": {
        const name = typeof params.name === "string" ? params.name : undefined;
        if (!name) return;
        const status = String(params.status ?? "");
        const error = params.error == null ? undefined : String(params.error);
        this.mcpStatus.set(name, { status, error });
        for (const w of [...this.mcpWaiters]) w();
        return;
      }
      case "turn/failed": // terminal, but turn/completed (status:"failed") follows on the same turn
        return;
      case "turn/completed": {
        // Terminal events are correlated by EXACT turn id: a stale or duplicated terminal for a
        // turn that is not running must never close one that is. Fail closed on ambiguity: an
        // unknown id is ignored, and a MISSING/unknown status is reported as "interrupted" (no
        // ack -> redeliver) rather than assumed successful.
        //
        // `owned` is the load-bearing part once a UI is attached. A turn a human started in the
        // TUI reaches this host too, and its completion says nothing about the batch WE surfaced
        // into OUR turn — acking on it would drop peer messages nobody ever saw.
        const turn = params.turn as { id?: string; status?: TurnStatus } | undefined;
        // A turn is closable if we ever SAW it start or if we CLAIMED it. Requiring both would
        // wedge the host on a turn whose `turn/started` never arrived (or arrived out of order):
        // the terminal would be discarded as unknown while the host still waits for a boundary
        // that can no longer come.
        const wasLive = turn?.id ? this.liveTurns.delete(turn.id) : false;
        const wasOwned = turn?.id ? this.ownedTurns.has(turn.id) : false;
        if (!turn?.id || (!wasLive && !wasOwned)) {
          this.log(`ignoring turn/completed for ${turn?.id ?? "?"} (neither live nor ours)`);
          return;
        }
        const status: TurnStatus =
          turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted"
            ? turn.status
            : "interrupted";
        // Ownership is only decidable once no `turn/start` of ours is outstanding. Until then this
        // terminal may belong to the turn that request is about to name (`turn/started` and
        // `turn/completed` are free to overtake the response), and calling it foreign would strand
        // the host's armed accounting on a boundary that has already gone by. Hold it instead.
        if (!wasOwned && this.pendingStarts.size > 0) {
          this.buffered.push({ turnId: turn.id, status });
          return;
        }
        const owned = this.ownedTurns.delete(turn.id);
        this.emit("turnCompleted", { turnId: turn.id, status, owned });
        return;
      }
      default:
        return; // deltas, token usage, hook/thread status — not load-bearing for the host
    }
  }
}
