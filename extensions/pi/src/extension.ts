import { basename, dirname, join } from "node:path";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkSecretDir, principalKey, writeSecretFileAtomic } from "@cotal-ai/core";
import {
  AguiEmitter,
  AguiEmitterHolder,
  EventWal,
  FileSubjectFrontier,
  JsonlFileSource,
  MeshAgent,
  type DurableSource,
  type SourceRead,
  configFromEnv,
  ensureEventWalDir,
  hasIdentity,
  resolveEventsStateRoot,
  runError,
  runStarted,
  startControlServer,
  textMessageContent,
  textMessageEnd,
  textMessageStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  toolCallStart,
  type AgentConfig,
  type InboxItem,
  controlFromEnv,
  scrubLaunchMaterial,
} from "@cotal-ai/connector-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiMapper, type PiEventRecord, type PiSessionRecord } from "./agui-map.js";
import { PiDriver, type CotalBatchDetails, type PiContextLike } from "./driver.js";
import { registerCotalTools } from "./tools.js";
import { wrapped } from "./wrap.js";

const CUSTOM_TYPE = "cotal-inbox";
const RUNTIMES = Symbol.for("cotal.pi.runtimes");

interface PiRuntime {
  config: AgentConfig;
  mesh: MeshAgent;
  driver: PiDriver;
  controlServer?: ReturnType<typeof startControlServer>;
  personaCleaned: boolean;
  sessionId?: string;
  expectedSessionId?: string;
  events?: PiEvents;
}

type GlobalWithPi = typeof globalThis & { [RUNTIMES]?: Map<string, PiRuntime> };

interface PiEvents {
  holder: AguiEmitterHolder<PiSessionRecord>;
  append(record: PiEventRecord): void;
  startTurn(timestamp: number): void;
  assistant(timestamp: number, content: unknown, toolCalls: unknown): void;
  toolResult(timestamp: number, toolCallId: string, content: unknown): void;
  failedTurn(stopReason: string, timestamp: number): void;
  close(timestamp: number): void;
  settled(): Promise<void>;
}

const EVENTS = "cotal-agui";

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("");
}

function sessionPath(context: ExtensionContext): string {
  const path = context.sessionManager.getSessionFile();
  if (!path) throw new Error("pi connector: events require a persisted Pi session file");
  return path;
}

class BoundStartSource<T> implements DurableSource<T> {
  readonly kind: string;

  constructor(
    private readonly inner: DurableSource<T>,
    private readonly start: string,
  ) {
    this.kind = inner.kind;
  }

  read(cursor: string | undefined): Promise<SourceRead<T>> {
    return this.inner.read(cursor ?? this.start);
  }
}

function createEvents(runtime: PiRuntime, context: ExtensionContext, pi: ExtensionAPI): PiEvents | undefined {
  if (!/^(1|true|yes|on)$/i.test(process.env.COTAL_EVENTS ?? "")) return undefined;
  const path = sessionPath(context);
  const threadId = context.sessionManager.getSessionId();
  const mapper = createPiMapper();
  // Capture the source boundary before async emitter setup. A fresh JsonlFileSource adopts at its
  // current end, so without this a complete turn written while the holder opens its WAL would be
  // silently treated as history. A resumed WAL supplies its own cursor and bypasses this boundary.
  let startCursor = "";
  const holder = new AguiEmitterHolder<PiSessionRecord>(
    async (sourcePath) => {
      const workspaceRoot = resolveEventsStateRoot(process.env);
      const principal = principalKey(runtime.mesh.ep.principal.owner, runtime.mesh.ep.principal.actor).key;
      const { walPath, subjectPath } = await ensureEventWalDir({
        workspaceRoot,
        space: runtime.config.space,
        principal,
        threadId,
      });
      const subjectFrontier = await FileSubjectFrontier.open(subjectPath, { space: runtime.config.space, principal });
      const wal = await EventWal.open(walPath, { space: runtime.config.space, threadId, principal, subjectMayExist: false });
      return AguiEmitter.start({
        endpoint: runtime.mesh.ep,
        wal,
        subjectFrontier,
        source: new BoundStartSource(new JsonlFileSource<PiSessionRecord>(sourcePath), startCursor),
        map: mapper.map,
      });
    },
    (error) => process.stderr.write(`[cotal-pi] AG-UI emitter stopped: ${error.message}\n`),
    mapper.forgetOpenRun,
  );

  const append = (record: PiEventRecord): void => {
    // Pi's extension API appends an opaque record to the same session JSONL this holder reads.
    // Flush remains synchronous and serialized inside the existing holder lifecycle seam.
    pi.appendEntry(EVENTS, record);
    void ready.then(() => holder.flush(path));
  };

  // The holder is lazy; pin its fresh-source boundary before its first adopt starts async setup.
  // A later write remains ahead of this cursor and the first flush publishes it.
  const ready = new JsonlFileSource<PiSessionRecord>(path).read(undefined).then((read) => {
    startCursor = read.cursor;
    holder.adopt(path);
  });

  let runId: string | undefined;
  return {
    holder,
    append,
    startTurn(timestamp) {
      if (runId !== undefined) return;
      runId = randomUUID();
      append({ version: 1, runId, events: [runStarted({ threadId, runId, timestamp })] });
    },
    assistant(timestamp, content, calls) {
      if (runId === undefined) return;
      const events = [];
      const body = text(content);
      if (body) {
        const messageId = randomUUID();
        events.push(
          textMessageStart({ messageId, timestamp, role: "assistant" }),
          textMessageContent({ messageId, delta: body, timestamp }),
          textMessageEnd({ messageId, timestamp }),
        );
      }
      if (Array.isArray(calls))
        for (const value of calls) {
          const call = value as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
          if (call.type !== "toolCall" || typeof call.id !== "string" || typeof call.name !== "string") continue;
          events.push(
            toolCallStart({ toolCallId: call.id, toolCallName: call.name, timestamp }),
            toolCallArgs({ toolCallId: call.id, delta: JSON.stringify(call.arguments ?? {}), timestamp }),
            toolCallEnd({ toolCallId: call.id, timestamp }),
          );
        }
      if (events.length) append({ version: 1, runId, events });
    },
    toolResult(timestamp, toolCallId, content) {
      if (runId === undefined) return;
      append({
        version: 1,
        runId,
        events: [toolCallResult({ messageId: randomUUID(), toolCallId, content: text(content), timestamp })],
      });
    },
    failedTurn(stopReason, timestamp) {
      if (runId === undefined) return;
      append({
        version: 1,
        runId,
        events: [runError({ message: `Pi turn ended with ${stopReason}`, timestamp, cotal: { stopReason } })],
      });
      runId = undefined;
    },
    close(timestamp) {
      if (runId === undefined) return;
      holder.closeRun(timestamp);
      runId = undefined;
    },
    settled: () => ready.then(() => holder.settled()),
  };
}

function runtimeMap(): Map<string, PiRuntime> {
  const root = globalThis as GlobalWithPi;
  return (root[RUNTIMES] ??= new Map());
}

function runtimeKey(config: AgentConfig): string {
  return `${config.space}\0${config.id ?? config.name}`;
}

function asContext(context: ExtensionContext): PiContextLike {
  return context;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function sessionStatePath(): string | undefined {
  const explicit = process.env.COTAL_PI_SESSION_STATE?.trim();
  if (explicit) return explicit;
  // Upgrade path for seats launched before COTAL_PI_SESSION_STATE existed. Managed Pi receives the
  // persona path and lifecycle UID; from <root>/.cotal/agents/<name>.md the same lifecycle-keyed
  // state path is derivable without selecting a newest session.
  const agentFile = process.env.COTAL_AGENT_FILE?.trim();
  const name = process.env.COTAL_NAME?.trim();
  const lifecycleUid = process.env.COTAL_LIFECYCLE_UID?.trim();
  const agentsDir = agentFile ? dirname(agentFile) : "";
  const cotalDir = agentsDir ? dirname(agentsDir) : "";
  if (!agentFile || !name || !lifecycleUid || basename(agentsDir) !== "agents" || basename(cotalDir) !== ".cotal")
    return undefined;
  return join(cotalDir, "pi-sessions", `${name}-${lifecycleUid}.json`);
}

export function persistSessionId(sessionId: string, status: "running" | "quit" = "running"): void {
  const path = sessionStatePath();
  if (!path) return;
  mkSecretDir(dirname(path));
  writeSecretFileAtomic(path, `${JSON.stringify({ version: 1, sessionId, status })}\n`);
}

function cleanPersonaFile(runtime: PiRuntime): void {
  if (runtime.personaCleaned) return;
  runtime.personaCleaned = true;
  const file = process.env.COTAL_PI_PERSONA_FILE;
  if (!file) return;
  const dir = dirname(file);
  if (basename(file) !== "persona.md" || !basename(dir).startsWith("cotal-persona-") || dirname(dir) !== tmpdir())
    return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A pre-start crash can leave the OS-temp file behind; normal cleanup remains best-effort.
  }
}

function createRuntime(config: AgentConfig, control: { path: string; token: string } | undefined): PiRuntime {
  const mesh = new MeshAgent(config);
  const driver = new PiDriver(mesh);
  const runtime: PiRuntime = {
    config,
    mesh,
    driver,
    personaCleaned: false,
  };

  mesh.on("incoming", () => driver.onIncoming());
  mesh.on("wake", () => driver.onWake());
  mesh.on("mention-wake", (item: InboxItem) => driver.onMentionWake(item));
  mesh.start();

  if (control) {
    runtime.controlServer = startControlServer(
      mesh,
      control,
      async () => ({ ok: false, error: "pi uses in-process lifecycle events; only control operations are supported" }),
      {
        fatalBind: true,
        onShutdown: () => driver.requestShutdown(),
        onSession: () => runtime.sessionId,
      },
    );
  }
  return runtime;
}

/** Load Cotal into the operator's Pi. With no mesh identity this extension is completely inert. */
export default async function cotalMesh(pi: ExtensionAPI): Promise<void> {
  if (!hasIdentity()) return;
  if (typeof pi.sendMessage !== "function" || typeof pi.registerMessageRenderer !== "function" || typeof pi.on !== "function") {
    throw new Error("pi connector: this Pi version lacks the required custom-message lifecycle API (requires Pi 0.79.10)");
  }

  const config = configFromEnv();
  // CLI startup opens/creates/forks the session BEFORE extension factories run, so the first
  // session_start may already be past. Pi publishes the active id through PI_SESSION_ID for exactly
  // this host-integration case. Later in-process /resume/new/fork transitions are captured by the
  // session_start handler below.
  const startupSessionId = process.env.PI_SESSION_ID?.trim() || undefined;
  const expectedSessionId = process.env.COTAL_PI_EXPECTED_SESSION?.trim() || undefined;
  delete process.env.COTAL_PI_EXPECTED_SESSION;
  // The socket path rides the env; the first-frame token rides the launch material, so a shell this
  // seat runs cannot pick a control-plane bearer out of its own environment. Read BEFORE the scrub
  // below, and read on every load rather than inside createRuntime: a second load reuses the cached
  // runtime, but the first one must not find the pointer already gone. That ordering is not a
  // detail - reversed, it refused every pi launch with the half-pair error `controlFromEnv` throws,
  // which is the failure that contract is supposed to produce and did.
  const control = controlFromEnv();
  // Both readers are done, so the pointer to the launch material has none left. Dropping it here is
  // what keeps it out of the environment of every shell command, build and tool this seat runs.
  scrubLaunchMaterial();
  config.connector = "pi";
  const key = runtimeKey(config);
  const runtimes = runtimeMap();
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createRuntime(config, control);
    runtimes.set(key, runtime);
  }
  runtime.expectedSessionId = expectedSessionId;
  if (startupSessionId) {
    if (expectedSessionId && startupSessionId !== expectedSessionId)
      throw new Error(`pi connector: expected startup session ${expectedSessionId}, host opened ${startupSessionId}`);
    runtime.sessionId = startupSessionId;
    runtime.expectedSessionId = undefined;
    persistSessionId(startupSessionId);
  }
  runtime.driver.bind(pi);
  registerCotalTools(pi, runtime.mesh, runtime.config);
  pi.registerMessageRenderer<CotalBatchDetails>(CUSTOM_TYPE, (message) => wrapped(messageText(message.content)));

  pi.on("session_start", (_event, context) => {
    cleanPersonaFile(runtime);
    runtime.sessionId = context.sessionManager.getSessionId();
    if (runtime.expectedSessionId && runtime.sessionId !== runtime.expectedSessionId)
      throw new Error(`pi connector: expected session ${runtime.expectedSessionId}, host opened ${runtime.sessionId}`);
    runtime.expectedSessionId = undefined;
    persistSessionId(runtime.sessionId);
    if (runtime.events !== undefined)
      throw new Error("pi connector: session replacement reached a live AG-UI holder before its shutdown completed");
    runtime.events = createEvents(runtime, context, pi);
    runtime.driver.onSessionStart(asContext(context));
  });
  pi.on("agent_start", (_event, context) => {
    // Pi creates the CLI session before it loads extension factories, so the startup
    // session_start may have already happened. agent_start is the first guaranteed context for
    // that session and occurs before its first turn_start.
    runtime.events ??= createEvents(runtime, context, pi);
    runtime.driver.onAgentStart(asContext(context));
  });
  pi.on("turn_start", (event) => runtime.events?.startTurn(event.timestamp));
  pi.on("message_start", (event) => runtime.driver.onMessageStart(event.message));
  pi.on("message_end", (event, context) => {
    const message = event.message as { role?: unknown; content?: unknown; toolCallId?: unknown; timestamp?: unknown };
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
    if (message.role === "assistant") {
      const calls = Array.isArray(message.content) ? message.content : [];
      runtime.events?.assistant(timestamp, message.content, calls);
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      runtime.events?.toolResult(timestamp, message.toolCallId, message.content);
    }
  });
  pi.on("context", (event) => runtime.driver.onContext(event.messages));
  pi.on("after_provider_response", (event) => runtime.driver.onProviderResponse(event.status));
  pi.on("tool_execution_start", (event) => runtime.driver.onToolStart(event.toolName));
  pi.on("tool_execution_end", () => runtime.driver.onToolEnd());
  pi.on("session_before_compact", (event) => runtime.driver.onBeforeCompact(event.reason, event.willRetry));
  pi.on("turn_end", (event) => {
    const message = event.message as { stopReason?: unknown; timestamp?: unknown };
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : "unknown";
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
    if (stopReason === "error" || stopReason === "aborted") runtime.events?.failedTurn(stopReason, timestamp);
    else runtime.events?.close(timestamp);
  });
  pi.on("agent_end", (event, context) => runtime.driver.onAgentEnd(event.messages, asContext(context)));
  pi.on("session_shutdown", async (event) => {
    runtime.driver.onSessionShutdown();
    runtime.events?.close(Date.now());
    await runtime.events?.settled();
    runtime.events = undefined;
    if (event.reason !== "quit") return;
    if (runtime.sessionId) persistSessionId(runtime.sessionId, "quit");
    await runtime.driver.quit();
    try {
      runtime.controlServer?.close();
    } catch {
      // The server may already be closing after the manager's shutdown request.
    }
    await runtime.mesh.stop().catch(() => {});
    runtimes.delete(key);
  });
}
