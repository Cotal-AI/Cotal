import { MeshAgent, InboxTurn, configFromEnv } from "@cotal-ai/connector-core";
import type { InboxItem, AgentConfig } from "@cotal-ai/connector-core";
import { loadAgentFile } from "@cotal-ai/core";
import {
  AgentSessionRuntime,
  AuthStorage,
  DefaultResourceLoader,
  InteractiveMode,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionServices,
  defineTool,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent, CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import { Type, type Api, type Model } from "@earendil-works/pi-ai";

function log(e: unknown): void {
  process.stderr.write(`[pi-peer] ${e instanceof Error ? e.message : String(e)}\n`);
}

/**
 * Read-only / awareness tools. Replies are NOT sent by the model — the run loop delivers
 * the agent's final text on the right delivery mode (see runPiPeer), so the model can't
 * mis-route or duplicate a reply. These just let it see who is present and report its own
 * status. Mirrors the openai-agents / vercel-ai adapters.
 */
export function buildTools(mesh: MeshAgent) {
  const cotal_roster = defineTool({
    name: "cotal_roster",
    label: "Cotal roster",
    description: "List the peers currently present on the Cotal mesh.",
    parameters: Type.Object({}),
    execute: async () => {
      const peers = mesh.roster();
      const text = peers.length
        ? peers
            .map((p) => `${p.card.name}${p.card.role ? `/${p.card.role}` : ""} [${p.status}]`)
            .join("\n")
        : "roster is empty";
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  const cotal_status = defineTool({
    name: "cotal_status",
    label: "Cotal status",
    description: "Update this peer's presence status on the mesh.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("idle"), Type.Literal("waiting"), Type.Literal("working")]),
      activity: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      await mesh.setStatus(params.status, params.activity);
      return { content: [{ type: "text", text: `status set to ${params.status}` }], details: {} };
    },
  });

  return [cotal_roster, cotal_status];
}

/** Actionable = a DM, an anycast to our role, or a channel message that names us — and not
 *  our own echo. Pure ambient channel chatter is dropped (acked, never answered). */
function actionable(mesh: MeshAgent, item: InboxItem): boolean {
  if (item.fromId === mesh.id) return false;
  return item.kind !== "channel" || item.mentionsMe;
}

/** The audience a reply goes back to. A channel message is answered ON that channel
 *  (sender-independent — everyone there already saw it); a DM/anycast is answered privately
 *  to its sender. Two messages with the same scope can share one turn + reply; mixing scopes
 *  cannot (a DM folded into a channel turn would broadcast private content), so different-
 *  scope messages get their own scope-isolated turn. */
function scopeKey(item: InboxItem): string {
  return item.kind === "channel" && item.channel ? `channel:${item.channel}` : `dm:${item.fromId}`;
}

function framed(item: InboxItem): string {
  return `from ${item.fromName} via ${item.kind}: ${item.text}`;
}

/** Pull this turn's final assistant text from the agent_end payload (not the session-wide
 *  last message), so a turn that produced no text never re-delivers a previous reply. */
function turnReplyText(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const text = m.content
      .map((p) =>
        p && typeof p === "object" && (p as { type?: unknown }).type === "text"
          ? String((p as { text?: unknown }).text ?? "")
          : "",
      )
      .join("");
    return text.length ? text : undefined;
  }
  return undefined;
}

/**
 * Resolve a persona's pinned `model:` string to a pi {@link Model} object using
 * only public API (`ModelRegistry.getAvailable` + the public `Model.provider`/
 * `Model.id` fields). Exact-match only — mirrors pi's internal
 * `findExactModelReferenceMatch` contract: canonical `provider/id`, then a split
 * `provider`+`id`, then a bare `id` (rejected if ambiguous across providers). No
 * fuzzy/partial matching: that is pi's CLI convenience (internal, not exported)
 * and not appropriate for a declarative persona pin. Throws on not-found/
 * ambiguous so a bad pin fails loud at startup instead of silently falling back
 * to pi's default model. (TUI mode passes the string to pi's CLI which fuzzy-
 * resolves it; headless runs in-process where only exact resolution is public.)
 */
export function resolveModel(ref: string, registry: ModelRegistry): Model<Api> {
  const avail = registry.getAvailable();
  const r = ref.trim().toLowerCase();
  if (!r) throw new Error("pi peer: empty persona model");
  // canonical "provider/id"
  let m = avail.find((x) => `${x.provider}/${x.id}`.toLowerCase() === r);
  // split provider + id
  if (!m && r.includes("/")) {
    const slash = ref.indexOf("/");
    const provider = ref.slice(0, slash).trim().toLowerCase();
    const id = ref.slice(slash + 1).trim().toLowerCase();
    if (provider && id) m = avail.find((x) => x.provider.toLowerCase() === provider && x.id.toLowerCase() === id);
  }
  // bare id — must be unique across providers
  if (!m) {
    const ids = avail.filter((x) => x.id.toLowerCase() === r);
    if (ids.length === 1) m = ids[0];
  }
  if (!m) throw new Error(`pi peer: persona model "${ref}" not found or ambiguous — use provider/id`);
  return m;
}

/**
 * Embed a pi coding-agent session in-process and drive it from mesh traffic. This is the
 * native-embed pattern (cf. docs/agent-frameworks.md): MeshAgent owns the NATS connection,
 * presence, and a stream-backed inbox; pi's loop is driven straight off that inbox via an
 * {@link InboxTurn} — `prompt()` wakes an idle session on the front message, `steer()`
 * interjects into a live one (true mid-turn drive, pi's distinctive capability), and presence
 * is read off the session's event stream. The loop owns reply routing, so the model never
 * mis-routes.
 *
 * Delivery is ack-on-surface: the inbox is the single source of truth (no parallel buffer);
 * a turn surfaces a front-contiguous run and `commit()`s (drainInbox-acks) it only once the
 * turn completes, so a crash/interrupt redelivers. Each turn is owned by one reply scope —
 * a mid-turn message is steered in only when it shares that scope; a different-scope message
 * stays on the stream and becomes the next turn's origin — so a private DM is never folded
 * into a channel broadcast.
 */
export async function runPiPeer(config: AgentConfig = configFromEnv()): Promise<void> {
  const mesh = new MeshAgent(config);
  mesh.start();

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  // Persona + model from the agent file. buildLaunch already parsed the file for
  // launch-time validation + `--model` precedence and forwarded COTAL_MODEL (the
  // resolved model string). The persona body is read here, in-process, and handed
  // to the ResourceLoader as appendSystemPrompt — the in-process equivalent of
  // TUI's --append-system-prompt. Construct the loader with the same defaults
  // createAgentSession would have used (cwd/agentDir/settingsManager) so passing
  // our own doesn't silently drop extension/skill/theme loading.
  const def = process.env.COTAL_AGENT_FILE ? loadAgentFile(process.env.COTAL_AGENT_FILE) : undefined;
  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    appendSystemPrompt: def?.persona ? [def.persona] : undefined,
  });
  await resourceLoader.reload();
  const model = process.env.COTAL_MODEL ? resolveModel(process.env.COTAL_MODEL, modelRegistry) : undefined;

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
    customTools: buildTools(mesh),
    resourceLoader,
    model,
  });

  const turn = new InboxTurn(mesh);
  let streaming = false; // gates steer(): only valid once the agent is actually streaming

  const setStatus = (status: "idle" | "working", activity?: string): void => {
    void mesh.setStatus(status, activity).catch(() => {});
  };

  const framed = (item: InboxItem): string =>
    `from ${item.fromName} via ${item.kind}: ${item.text}`;

  function deliver(to: InboxItem, text: string): void {
    if (to.kind === "channel" && to.channel) void mesh.send(text, to.channel).catch(log);
    else void mesh.dm(to.fromId, text).catch(log);
  }

  /** Start the next turn on the front actionable message, dropping leading non-actionable
   *  (own echoes, ambient chatter) first. No-op while a turn is in flight. */
  function pump(): void {
    if (turn.inFlight) return;
    turn.drop((i) => !actionable(mesh, i));
    const origin = turn.start();
    if (!origin) {
      setStatus("idle");
      return;
    }
    streaming = false;
    void session.prompt(framed(origin)).catch(onStartError); // wake into a fresh turn
  }

  /** Fold any front-contiguous, same-scope actionable messages into the live turn (mid-turn
   *  steer). A cross-scope or ambient message breaks contiguity and waits for its own turn. */
  function foldSameScope(): void {
    if (!turn.origin || !streaming) return;
    for (const item of turn.extend((i, o) => actionable(mesh, i) && scopeKey(i) === scopeKey(o))) {
      void session.steer(framed(item)).catch(log);
    }
  }

  function onStartError(e: unknown): void {
    log(e);
    if (streaming) return; // already running → agent_end will complete the turn
    turn.commit(); // pre-flight failure (e.g. no model/key): drop, no retry-loop
    setStatus("idle");
    pump();
  }

  mesh.on("incoming", () => {
    if (turn.inFlight) foldSameScope();
    else pump();
  });
  mesh.on("wake", () => {
    if (!turn.inFlight) pump();
  });

  session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case "agent_start":
        streaming = true;
        setStatus("working", "thinking");
        foldSameScope(); // flush same-scope peers that landed before streaming began
        break;
      case "tool_execution_start":
        setStatus("working", `running ${event.toolName}`);
        break;
      case "tool_execution_end":
        setStatus("working", "thinking"); // clear the per-tool activity so it can't read stale
        break;
      case "agent_end": {
        if (event.willRetry) break; // transient failure; a retry turn follows
        const to = turn.origin;
        const reply = turnReplyText(event.messages);
        turn.commit(); // ack the surfaced run — clean or failed both consume (no retry-loop)
        streaming = false;
        if (to && reply) deliver(to, reply);
        pump(); // next scope
        break;
      }
    }
  });

  // Drain anything already buffered before the listeners were attached.
  pump();

  async function shutdown(): Promise<void> {
    try {
      if (turn.inFlight) {
        turn.abandon(); // leave the in-flight run on the stream → redeliver, no peer dropped
        await session.abort();
      }
      session.dispose();
      await mesh.stop();
    } finally {
      process.exit(0);
    }
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Keep alive.
  await new Promise<void>(() => {});
}

/**
 * Interactive native peer: the same embedded MeshAgent/AgentSession bridge as
 * runPiPeer, but with Pi's own InteractiveMode owning the real terminal UI.
 * This is deliberately separate from the legacy RPC renderer in tui-client.ts.
 */
export async function runInteractivePeer(config: AgentConfig = configFromEnv()): Promise<void> {
  const mesh = new MeshAgent(config);
  mesh.start();

  const cwd = process.cwd();
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const def = process.env.COTAL_AGENT_FILE ? loadAgentFile(process.env.COTAL_AGENT_FILE) : undefined;
  const appendSystemPrompt = def?.persona ? [def.persona] : undefined;

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: runtimeCwd,
    agentDir: runtimeAgentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      authStorage,
      modelRegistry,
      settingsManager:
        runtimeCwd === cwd ? settingsManager : SettingsManager.create(runtimeCwd, runtimeAgentDir),
      resourceLoaderOptions: { appendSystemPrompt },
    });
    const model = process.env.COTAL_MODEL
      ? resolveModel(process.env.COTAL_MODEL, services.modelRegistry)
      : undefined;
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model,
      customTools: buildTools(mesh),
    });
    return {
      ...created,
      services,
      diagnostics: services.diagnostics,
    };
  };

  const sessionManager = SessionManager.inMemory();
  sessionManager.appendSessionInfo(config.name);
  const initial = await createRuntime({ cwd, agentDir, sessionManager });
  const runtime = new AgentSessionRuntime(
    initial.session,
    initial.services,
    createRuntime,
    initial.diagnostics,
    initial.modelFallbackMessage,
  );
  const interactive = new InteractiveMode(runtime);
  await interactive.init();

  const session = runtime.session;
  const turn = new InboxTurn(mesh);
  let streaming = false;
  let shuttingDown = false;

  const setStatus = (status: "idle" | "working", activity?: string): void => {
    void mesh.setStatus(status, activity).catch(log);
  };

  const deliver = (to: InboxItem, text: string): void => {
    if (to.kind === "channel" && to.channel) void mesh.send(text, to.channel).catch(log);
    else void mesh.dm(to.fromId, text).catch(log);
  };

  function pump(): void {
    if (turn.inFlight || session.isStreaming || shuttingDown) return;
    turn.drop((item) => !actionable(mesh, item));
    const origin = turn.start();
    if (!origin) {
      setStatus("idle");
      return;
    }
    setStatus("working", "thinking");
    void session.prompt(framed(origin)).catch((error) => {
      log(error);
      turn.commit();
      setStatus("idle");
      pump();
    });
  }

  function foldSameScope(): void {
    if (!turn.origin || !session.isStreaming) return;
    for (const item of turn.extend((i, o) => actionable(mesh, i) && scopeKey(i) === scopeKey(o))) {
      void session.steer(framed(item)).catch(log);
    }
  }

  mesh.on("incoming", () => {
    if (session.isStreaming) foldSameScope();
    else pump();
  });
  mesh.on("wake", () => pump());

  session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case "agent_start":
        streaming = true;
        setStatus("working", "thinking");
        foldSameScope();
        break;
      case "tool_execution_start":
        setStatus("working", `running ${event.toolName}`);
        break;
      case "tool_execution_end":
        setStatus("working", "thinking");
        break;
      case "agent_end": {
        if (event.willRetry) break;
        const to = turn.origin;
        const reply = turnReplyText(event.messages);
        if (turn.inFlight) turn.commit();
        streaming = false;
        setStatus("idle");
        if (to && reply) deliver(to, reply);
        pump();
        break;
      }
    }
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    turn.abandon();
    try {
      await session.abort();
      interactive.stop();
      await runtime.dispose();
      await mesh.stop();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  pump();
  try {
    await interactive.run();
  } finally {
    if (!shuttingDown) {
      interactive.stop();
      await runtime.dispose();
      await mesh.stop();
    }
  }
}
