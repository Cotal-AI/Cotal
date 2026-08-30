import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError, JcodeClient, launchInstance, type ApiEvent, type LaunchedInstance } from "@1jehuang/jcode-sdk";
import { hardenPrivate, loadAgentFile } from "@cotal-ai/core";
import { mirrorJcodeCredentials, shortSocketHome } from "./private-state.js";
import { captureProcessIdentity, launchIdentityEnv, stopPrivateTree, type ProcessIdentity } from "./private-lifecycle.js";
import { chooseSessionToResume, type ResumeCandidate } from "./session-resume.js";
import { bareModelId, describeRoute } from "./route-identity.js";
import {
  classifyReadinessProviderRefusal,
  installJcodeDiagnosticLog,
  JcodeConnectorError,
  jcodeEffortRefusal,
  writeJcodeDiagnostic,
} from "./startup-diagnostics.js";
import { ERROR_RETRY_INITIAL_MS, nextRetryDelay, shouldRetry } from "./retry-policy.js";
import {
  MeshAgent,
  ORIENTATION_BOOTSTRAP,
  MESH_FIRST_STEER,
  configFromEnv,
  controlFromEnv,
  feedbackLine,
  formatInjection,
  parseToolArgs,
  scrubLaunchMaterial,
  startControlServer,
  cotalToolSpecs,
  type AgentConfig,
  type InboxItem,
  type ToolResult,
} from "@cotal-ai/connector-core";

const MAX_RELAY_BYTES = 4 * 1024 * 1024;
const RELAY_TIMEOUT_MS = 30_000;
export const PERMANENT_BRIDGE_RECOVERY_CODES = new Set([
  "handshake_failed",
  "invalid_instance_home",
  "invalid_request",
  "jcode_not_found",
  "unknown_request",
  "unknown_session",
  "unsupported_version",
]);
export const PERMANENT_BRIDGE_CONNECT_CAUSE_CODES = new Set(["EACCES"]);

/** Recovery retries availability races, not a refusal that another attempt cannot change. */
export function permanentBridgeRecoveryFailure(error: unknown): error is HarnessError {
  if (!(error instanceof HarnessError)) return false;
  if (PERMANENT_BRIDGE_RECOVERY_CODES.has(error.code)) return true;
  if (error.code === "connect_failed")
    return PERMANENT_BRIDGE_CONNECT_CAUSE_CODES.has((error.cause as NodeJS.ErrnoException | undefined)?.code ?? "");
  return false;
}

interface RelayEndpoint {
  path: string;
  token: string;
}

function privateAgentHome(space: string, name: string): string {
  const root = process.env.COTAL_JCODE_HOME?.trim();
  if (!root) throw new Error("COTAL_JCODE_HOME is not set — the connector must pin the agent's Jcode home");
  const slug = `${space}-${name}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const key = createHash("sha256").update(`${space}\0${name}`).digest("hex").slice(0, 12);
  const managedRoot = join(root, ".cotal", "jcode");
  const home = join(managedRoot, `${slug || "agent"}-${key}`);
  if (!resolve(home).startsWith(resolve(managedRoot) + sep)) throw new Error(`jcode home ${home} escapes ${managedRoot} — refusing`);
  for (const path of [join(root, ".cotal"), managedRoot, home]) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error(`refusing symlinked managed path: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  hardenPrivate(home, "dir");
  return home;
}

function publicConfig(config: AgentConfig): AgentConfig {
  // This object is handed to Jcode's MCP CHILD so it can render the exact tool schemas. It is not
  // a second connection config: the host owns the MeshAgent. Do not put static creds, user-mode
  // bearer material, join tokens, broker coordinates, feedback keys, or the launch-material
  // pointer on the child rail.
  return {
    ...config,
    creds: config.creds ? "managed" : undefined,
    userAuth: undefined,
    token: undefined,
    user: undefined,
    pass: undefined,
    servers: "held by the Jcode host",
    feedbackKey: undefined,
  };
}

/** Jcode deliberately overlays project `.jcode/mcp.json`, `.mcp.json`, and `.claude/mcp.json`
 * over its private home. A same-name project entry could replace the connector's cotal bridge, or
 * add a server the operator never opted to share. The Harness API has no isolation switch for this
 * source set, so refuse the whole launch instead of claiming our private home is sufficient. */
function assertNoProjectMcpConfig(cwd: string): void {
  const found = [".jcode/mcp.json", ".mcp.json", ".claude/mcp.json"].filter((relative) => existsSync(join(cwd, relative)));
  if (found.length)
    throw new Error(
      `jcode connector: project MCP configuration (${found.join(", ")}) is not supported — Jcode overlays it over the managed cotal MCP bridge. Remove it or use a workspace without project MCP configuration; tool-sharing is not implemented.`,
    );
}

function mcpEntry(): { command: string; args: string[] } {
  const built = import.meta.url.includes("/dist/");
  if (built) return { command: process.execPath, args: [filePath("mcp.js")] };
  return { command: filePath("../node_modules/.bin/tsx"), args: [filePath("mcp-main.ts")] };
}

function filePath(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

function writeMcpConfig(home: string, relay: RelayEndpoint, config: AgentConfig): void {
  const { command, args } = mcpEntry();
  const mcp = {
    servers: {
      cotal: {
        command,
        args,
        env: {
          COTAL_JCODE_MCP_SOCKET: relay.path,
          COTAL_JCODE_MCP_TOKEN: relay.token,
          COTAL_JCODE_MCP_CONFIG: JSON.stringify(publicConfig(config)),
        },
        shared: false,
      },
    },
  };
  const path = join(home, "mcp.json");
  // `home` is a real, private managed directory as checked above. Unlinking does not follow a
  // planted symlink; O_EXCL|O_NOFOLLOW closes the replacement race before the private MCP bearer
  // lands on disk. A seat whose private config cannot be safely written cannot start.
  rmSync(path, { force: true });
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    throw new Error(`refusing to write Jcode MCP config at ${path}: ${(error as Error).message}`);
  }
  try {
    writeFileSync(fd, JSON.stringify(mcp));
  } finally {
    closeSync(fd);
  }
  if (process.platform !== "win32") hardenPrivate(path, "file");
}

function relayEndpoint(space: string, name: string): RelayEndpoint {
  const token = randomBytes(32).toString("base64url");
  const id = createHash("sha256").update(`${space}\0${name}\0${process.pid}\0${token}`).digest("base64url").slice(0, 32);
  return {
    path: process.platform === "win32" ? `\\\\.\\pipe\\cotal-jcode-${id}` : join("/tmp", `cotal-jcode-${id}.sock`),
    token,
  };
}

function instructions(config: AgentConfig, persona: string | undefined): string {
  const mesh =
    `You are connected to the Cotal mesh as "${config.name}"${config.role ? ` (role: ${config.role})` : ""} in space "${config.space}". ` +
    `${ORIENTATION_BOOTSTRAP} ${feedbackLine(config)}${MESH_FIRST_STEER} ` +
    "Peer messages are delivered into your turns as blocks marked 📨. Reply with cotal_dm (privately, to the sender), cotal_send (to a channel), or cotal_anycast (to a role); use cotal_roster to see who is present and cotal_status to report what you are doing. Reply only when a reply is actually needed — silent acknowledgement is correct, and @-mention a peer only when you need that peer to act now.";
  return persona ? `${persona}\n\n${mesh}` : mesh;
}

function constantTokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string") return false;
  const actual = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

async function startRelay(agent: MeshAgent, config: AgentConfig, endpoint: RelayEndpoint): Promise<Server> {
  const specs = new Map(cotalToolSpecs(config, "jcode").map((spec) => [spec.name, spec]));
  if (process.platform !== "win32" && existsSync(endpoint.path)) rmSync(endpoint.path, { force: true });
  const server = createServer((socket) => {
    let input = "";
    let handled = false;
    const deadline = setTimeout(() => socket.destroy(), 5_000);
    deadline.unref?.();
    socket.setEncoding("utf8");
    socket.on("close", () => clearTimeout(deadline));
    socket.on("data", (chunk: string) => {
      if (handled) return;
      input += chunk;
      if (input.length > MAX_RELAY_BYTES) return socket.destroy();
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      clearTimeout(deadline);
      void (async () => {
        try {
          const frame = JSON.parse(input.slice(0, newline)) as { token?: unknown; name?: unknown; args?: unknown };
          if (!constantTokenMatches(frame.token, endpoint.token)) return socket.destroy();
          if (typeof frame.name !== "string" || !specs.has(frame.name)) throw new Error("unknown cotal tool");
          const spec = specs.get(frame.name)!;
          const args = parseToolArgs(spec, frame.args);
          // The Jcode host owns automatic inbox delivery, so this bridge pulls only its buffered
          // ambient queue. Unlike the other host-owned variants, Jcode still exposes the shared
          // `peek` control and must carry it through to the spec rather than replacing it.
          const result: ToolResult = await spec.run(
            agent,
            config,
            spec.name === "cotal_inbox" ? { ...args, scope: "pull-only" } : args,
          );
          socket.end(JSON.stringify({ result }) + "\n");
        } catch (error) {
          socket.end(JSON.stringify({ error: (error as Error).message }) + "\n");
        }
      })();
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(endpoint.path, () => {
      server.removeListener("error", reject);
      resolvePromise();
    });
  });
  return server;
}

function closeServer(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => server?.close(() => resolve()) ?? resolve());
}

function noCotalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("COTAL_")) env[key] = value;
  return env;
}

export async function runJcodeHost(): Promise<void> {
  const config = configFromEnv();
  config.connector = "jcode";
  const control = controlFromEnv();
  if (!control) throw new Error("jcode connector: managed session has no control endpoint");
  const binary = process.env.COTAL_JCODE_BIN?.trim() || "jcode";
  const tuiOverride = process.env.COTAL_JCODE_TUI?.trim();
  const bootPrompt = process.env.COTAL_JCODE_PROMPT?.trim();
  const def = process.env.COTAL_AGENT_FILE?.trim() ? loadAgentFile(process.env.COTAL_AGENT_FILE.trim()) : undefined;
  const cwd = process.cwd();
  assertNoProjectMcpConfig(cwd);
  const home = privateAgentHome(config.space, config.name);
  installJcodeDiagnosticLog(home);
  // SDK 1.1.0 has no socket-path launch option: it derives `run/jcode-api.sock` below jcodeHome.
  // The managed home stays in the workspace, but this private short alias keeps that fixed API
  // path below AF_UNIX's platform limit. Failure is fatal; a long-path fallback is the reported bug.
  mirrorJcodeCredentials(home);
  const socketHome = shortSocketHome(home);
  const relay = relayEndpoint(config.space, config.name);

  // The endpoint is the sole reader of Cotal material. Once it has parsed config/control, neither
  // Jcode itself nor the MCP child can inherit the material pointer or its broker credential.
  scrubLaunchMaterial();
  for (const key of Object.keys(process.env)) if (key.startsWith("COTAL_")) delete process.env[key];

  const agent = new MeshAgent(config);
  const relayServer = await startRelay(agent, config, relay);
  writeMcpConfig(home, relay, config);

  let instance: LaunchedInstance | undefined;
  let launchIdentity: ProcessIdentity | undefined;
  let launchIdentityValue: string | undefined;
  let client: JcodeClient | undefined;
  let tui: ChildProcess | undefined;
  let stopping = false;
  let reconnecting = false;
  let bridgeRecoveryUsed = false;
  let sessionId: string | undefined;
  let driving = false;
  let turnActive = false;
  let briefed = false;
  let initialized = false;
  let wakeQueued = false;
  /** Exact Cotal deliveries the active Harness turn has accepted, either in its initial prompt or
   *  through Jcode's session-owned soft-interrupt queue. They commit only when that containing turn
   *  finishes cleanly. A soft_interrupt `ok` proves the live recipient session queued the text; it
   *  does not prove the model consumed it yet, so the turn boundary remains the sole ack site. */
  let surfacedIds: string[] = [];
  let steering = false;
  /** The last in-flight steer request. `drive()` waits for it before deciding which ids the clean
   *  boundary owns, so a soft_interrupt reply racing turn_done can never be recorded after the ack. */
  let steerSettled: Promise<unknown> = Promise.resolve();
  const receivedAt = new Map<string, number>();

  // The SDK trusts mutable servers.json PIDs and can signal a stale foreign process. Remove its
  // exit hook once the launch handle exists and own teardown here instead: every record is checked
  // against the immutable bridge identity captured at spawn, then the scan stays quiescent after
  // bridge exit so a late daemon record cannot land behind a single empty pass.
  const stopPrivateJcode = async (): Promise<void> => {
    await client?.close().catch(() => {});
    if (launchIdentity && launchIdentityValue)
      await stopPrivateTree({ jcodeHome: socketHome.jcodeHome, launch: launchIdentity, identityValue: launchIdentityValue });
  };

  // Launched in two steps rather than JcodeClient.launch() so the connector holds the instance
  // handle itself: the bridge PID for teardown, and a shutdown it can follow with verification.
  // Bridge recovery relaunches through here too, so the identity slots always name the live tree
  // that stopPrivateJcode must target.
  const launchPrivateJcode = async (deadline?: number): Promise<JcodeClient> => {
    const remaining = (): number | undefined => deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
    const exitListenersBefore = new Set(process.listeners("exit"));
    const launchBound = launchIdentityEnv();
    launchIdentityValue = launchBound.value;
    instance = await launchInstance({
      binary,
      jcodeHome: socketHome.jcodeHome,
      workingDir: cwd,
      // Re-copied above on every launch. Do not call the SDK default: it links rotating provider
      // auth files, while current jcode correctly refuses external auth paths that are symlinks.
      inheritLogins: false,
      // A managed seat never updates its own binary. Jcode's background updater restarts the
      // process tree when it lands a release, which SIGTERMs the TUI — the only connection the
      // server counts as a client — and nothing re-attaches afterwards, so the server's idle
      // reaper takes the whole seat down five minutes later, mid-turn. Measured 2026-08-26: three
      // seats, three identical chains, "Updated to v0.81.1. Restarting..." then a shutdown exactly
      // 300s after the client was lost, one of them two seconds after starting a tool call. The
      // seat's version is the operator's choice at spawn time; it must not change under a running
      // agent.
      env: {
        JCODE_DISABLE_CLAUDE_MCP: "1",
        JCODE_NO_AUTO_UPDATE: "1",
        [launchBound.key]: launchBound.value,
      },
      ...(remaining() !== undefined ? { startupTimeoutMs: remaining() } : {}),
    });
    const sdkExitListeners = process.listeners("exit").filter((listener) => !exitListenersBefore.has(listener));
    for (const listener of sdkExitListeners) process.removeListener("exit", listener);
    if (sdkExitListeners.length !== 1)
      throw new Error(`jcode connector: expected one SDK instance exit hook, found ${sdkExitListeners.length} — refusing unsafe lifecycle ownership`);
    launchIdentity = captureProcessIdentity(instance.process.pid!);
    return JcodeClient.connect({ socketPath: instance.socketPath, ...(remaining() !== undefined ? { requestTimeoutMs: remaining() } : {}) });
  };

  const launchTui = (): void => {
    const runtime = join(socketHome.jcodeHome, "run");
    tui = spawn(binary, ["--socket", join(runtime, "jcode.sock"), "--resume", sessionId!], {
      cwd,
      env: { ...noCotalEnv(), JCODE_HOME: socketHome.jcodeHome, JCODE_RUNTIME_DIR: runtime, JCODE_SOCKET: join(runtime, "jcode.sock") },
      stdio: "inherit",
    });
    tui.once("exit", (code) => void shutdown(code ?? 0));
  };

  const shutdown = async (code = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      tui?.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    await closeServer(relayServer);
    let exit = code;
    try {
      await stopPrivateJcode();
    } catch (error) {
      writeJcodeDiagnostic(`[cotal-jcode] ${(error as Error).message}\n`);
      exit = 1;
    }
    socketHome.dispose();
    await agent.stop().catch(() => {});
    process.exit(exit);
  };

  /** Retry pacing for a failed turn. A turn's batch is acked only on success, so a failure leaves
   *  `pendingWake()` positive and the naive re-drive is instantaneous and unbounded. */
  const ERROR_RETRY_INITIAL_MS = 1_000;
  const ERROR_RETRY_MAX_MS = 60_000;
  /** After this many consecutive failures the seat stops re-driving and stays visibly degraded,
   *  rather than burning tokens forever against a provider that is not answering. */
  const ERROR_RETRY_GIVE_UP = 8;
  let errorRetryMs = ERROR_RETRY_INITIAL_MS;
  let errorRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;
  /** One bridge recovery remains bounded, but it is bounded by time rather than one launch/attach
   *  outcome. A loaded host can lose a transient replacement race without turning that into a
   *  second provider close or an unbounded relaunch loop. */
  const BRIDGE_RECOVERY_WINDOW_MS = 60_000;
  const BRIDGE_RECOVERY_RETRY_MS = 1_000;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  /** Re-drive after a growing delay, at most one timer in flight, never while shutting down. */
  const scheduleErrorRetry = (): void => {
    if (stopping || errorRetryTimer) return;
    if (consecutiveFailures >= ERROR_RETRY_GIVE_UP) {
      writeJcodeDiagnostic(
        `[cotal-jcode] giving up after ${consecutiveFailures} consecutive failed turns - the batch stays ` +
          `un-acked and will redeliver; the seat stays degraded until a new wake arrives\n`,
      );
      return;
    }
    if (agent.pendingWake() === 0 && !wakeQueued) return;
    const delay = errorRetryMs;
    errorRetryMs = Math.min(errorRetryMs * 2, ERROR_RETRY_MAX_MS);
    errorRetryTimer = setTimeout(() => {
      errorRetryTimer = undefined;
      if (stopping || driving || turnActive) return;
      if (agent.pendingWake() > 0 || wakeQueued) void drive();
    }, delay);
    // Never hold the process open on a pending retry.
    errorRetryTimer.unref?.();
  };

  const sessionBusy = (): boolean => driving || turnActive;

  const publishInboundHealth = (): void => {
    const pending = agent.peekInbox("automatic");
    const live = new Set(pending.map((item) => item.recvKey));
    for (const key of receivedAt.keys()) if (!live.has(key)) receivedAt.delete(key);
    const queued = pending.length;
    if (queued === 0) {
      void agent.setStatus(sessionBusy() ? "working" : "idle", "").catch(() => {});
      return;
    }
    let oldest: number | undefined;
    for (const item of pending) {
      const at = receivedAt.get(item.recvKey);
      if (at === undefined) continue;
      if (oldest === undefined || at < oldest) oldest = at;
    }
    const ageS = oldest === undefined ? 0 : Math.max(0, Math.round((Date.now() - oldest) / 1000));
    const activity = `inbound: ${queued} automatic queued, oldest ${ageS}s`;
    void agent.setStatus(sessionBusy() ? "working" : "waiting", activity).catch(() => {});
  };

  /** Commit ids the live session already accepted when the host does not own `run()`. A Cotal-owned
   *  `drive()` still commits only in its own try path, so a TUI-owned turn cannot ack that batch. */
  const commitSteeredIfHostIdle = async (): Promise<void> => {
    if (driving) return;
    await steerSettled;
    if (driving || !surfacedIds.length) return;
    const committed = surfacedIds;
    surfacedIds = [];
    agent.drainInboxDeliveries(committed);
    publishInboundHealth();
  };

  const finishHostIdleTurn = async (): Promise<void> => {
    await commitSteeredIfHostIdle();
    if (!sessionBusy() && !reconnecting && (agent.pendingWake() > 0 || wakeQueued)) void drive();
  };

  const drive = async (override?: string): Promise<void> => {
    if (stopping || reconnecting || !initialized || driving || turnActive || !client || !sessionId) return;
    driving = true;
    await steerSettled;
    if (stopping || reconnecting || turnActive || !client || !sessionId) {
      driving = false;
      return;
    }
    if (surfacedIds.length) {
      const committed = surfacedIds;
      surfacedIds = [];
      agent.drainInboxDeliveries(committed);
    }
    wakeQueued = false;
    const parts: string[] = [];
    let ids: string[] = [];
    if (override) parts.push(override);
    else {
      const inbox = agent.peekInbox("automatic");
      const injection = formatInjection(inbox);
      if (!injection) {
        driving = false;
        return;
      }
      ids = inbox.map((item) => item.recvKey);
      parts.push(injection);
    }
    if (!briefed) {
      briefed = true;
      const briefing = agent.channelBriefing();
      if (briefing) parts.unshift(briefing);
    }
    turnActive = true;
    surfacedIds = [...ids];
    publishInboundHealth();
    let turnClient: JcodeClient | undefined;
    try {
      turnClient = client;
      await turnClient.run(sessionId, parts.join("\n\n"), { autoApprove: true });
      // The SDK's event iterator returns normally when its socket closes. That is not a successful
      // turn: the model may never have received the injection, so preserving the inbox batch is the
      // only safe outcome. The reconnect path redrives it after it reattaches the owned session.
      if (reconnecting || client !== turnClient)
        throw new Error("Jcode Harness connection closed during the turn; leaving the inbox batch unacknowledged");
      // A directed DM can be accepted into Jcode's persistent soft-interrupt queue while this run is
      // active. Wait for that request to settle before reading the exact containing-turn ledger.
      await steerSettled;
      const committed = surfacedIds;
      surfacedIds = [];
      if (committed.length) agent.drainInboxDeliveries(committed);
      publishInboundHealth();
      // A turn that SUCCEEDS clears the backoff: the next failure starts from the short delay again
      // rather than inheriting a penalty the seat has already recovered from.
      errorRetryMs = ERROR_RETRY_INITIAL_MS;
      consecutiveFailures = 0;
    } catch (error) {
      surfacedIds = [];
      consecutiveFailures++;
      writeJcodeDiagnostic(
        `[cotal-jcode] turn failed (${consecutiveFailures} in a row): ${(error as Error).message}\n`,
      );
    } finally {
      turnActive = false;
      driving = false;
      // The recovering client owns the one post-close redrive. An old turn that finishes after
      // replacement must not race it and make the recovery look successful while its own work is
      // merely retried — or re-paced — by a stale finally block.
      if (!reconnecting && client === turnClient) {
        // The ack lives inside the try, so a failed turn leaves its batch UN-acked and pendingWake()
        // stays positive. Re-driving immediately therefore re-sends the same batch to the same
        // provider with no delay and no limit - one deterministic failure became a hot loop that
        // re-paid the full injection in tokens on every pass (#790, measured at 62 resends).
        //
        // The codex host already solved this with scheduleErrorRetry; this is the same shape.
        if (consecutiveFailures > 0) {
          // "waiting", not "idle": PresenceStatus has no degraded state, and idle is a lie here - the
          // seat is not ready for work, it is holding an un-acked batch and pacing a retry. An idle
          // label is exactly what made a hot-looping seat look healthy in the roster.
          void agent.setStatus("waiting").catch(() => {});
          scheduleErrorRetry();
        } else {
          void agent.setStatus("idle").catch(() => {});
          if (agent.pendingWake() > 0 || wakeQueued) void drive();
        }
      }
    }
  };

  /** Queue directed automatic traffic in Jcode's live session while a turn owns the provider. Jcode
   *  incorporates soft interrupts at its documented safe points (after provider streaming / tools),
   *  including a persisted fallback across a private bridge replacement. Ambient channel chatter
   *  stays buffered for the next turn. Exact-id accounting makes the accepted set independent of
   *  physical inbox order, and the containing turn's clean completion remains the only commit. */
  const steerPending = async (): Promise<void> => {
    if (steering || !sessionBusy() || !client || !sessionId) return;
    steering = true;
    try {
      for (;;) {
        const surfaced = new Set(surfacedIds);
        const items = agent
          .peekInbox("automatic")
          .filter((item) => !surfaced.has(item.recvKey) && (item.kind !== "channel" || item.mentionsMe));
        if (!items.length || !sessionBusy()) return;
        const injection = formatInjection(items);
        if (!injection) return;
        const current: JcodeClient = client;
        const request = current.softInterrupt(sessionId, injection, false);
        steerSettled = request.catch(() => {});
        await request;
        // If the turn closed or the client was replaced while acceptance was in flight, retain the
        // inbox copy. Jcode may also have queued it, so this deliberately chooses at-least-once.
        if (!sessionBusy() || client !== current) return;
        surfacedIds.push(...items.map((item) => item.recvKey));
      }
    } catch (error) {
      writeJcodeDiagnostic(`[cotal-jcode] soft interrupt failed: ${(error as Error).message}\n`);
    } finally {
      steering = false;
    }
  };

  /**
   * A provider stall can take down Jcode's bridge while leaving the private session and its inbox
   * batch intact. Give that owned instance one clean replacement: the failed turn remains unacked,
   * we attach the exact session rather than creating a blank one, and only then let the normal
   * inbox driver see the pending work again. A second close is terminal — retry pacing belongs to
   * the turn policy, not an unbounded connector relaunch loop.
   */
  const recoverBridge = async (lost: JcodeClient): Promise<void> => {
    if (stopping || lost !== client || reconnecting) return;
    if (bridgeRecoveryUsed) {
      writeJcodeDiagnostic("[cotal-jcode] private Harness connection closed after its one recovery attempt\n");
      await shutdown(1);
      return;
    }
    bridgeRecoveryUsed = true;
    reconnecting = true;
    turnActive = false;
    driving = false;
    surfacedIds = []; // deliberately unacked; the replacement redrives the durable inbox batch
    void agent.setStatus("waiting").catch(() => {});
    let lastError: unknown;
    const deadline = Date.now() + BRIDGE_RECOVERY_WINDOW_MS;
    try {
      // The connector owns the private instance. Stop the whole broken tree before replacing it:
      // a surviving daemon still holds the private home's registry and socket, so a replacement
      // cannot own the same home until it is gone. The lost client's close listener is ignored
      // because reconnecting is already true, and the relaunch goes through the same
      // identity-capturing path as startup so teardown targets the replacement tree, not the corpse.
      await stopPrivateJcode();
      if (!sessionId) throw new Error("jcode connector: Harness connection closed before a session was established");
      for (;;) {
        let replacement: JcodeClient | undefined;
        try {
          replacement = await launchPrivateJcode(deadline);
          const attachRemaining = Math.max(1, deadline - Date.now());
          let attachDeadline: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              replacement.attachSession(sessionId),
              new Promise<never>((_, reject) => {
                attachDeadline = setTimeout(() => reject(new Error("jcode connector: recovery attach exceeded its bounded window")), attachRemaining);
              }),
            ]);
          } finally {
            if (attachDeadline !== undefined) clearTimeout(attachDeadline);
          }
          client = replacement;
          watchClient(replacement);
          writeJcodeDiagnostic(`[cotal-jcode] recovered private Harness connection for session ${sessionId}\n`);
          void agent.setStatus("idle").catch(() => {});
          break;
        } catch (error) {
          lastError = error;
          await replacement?.close().catch(() => {});
          await stopPrivateJcode();
          if (stopping) return;
          if (permanentBridgeRecoveryFailure(error)) throw error;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw error;
          writeJcodeDiagnostic(
            `[cotal-jcode] private Harness replacement not ready yet; retrying inside its one recovery window: ${(error as Error).message}\n`,
          );
          await sleep(Math.min(BRIDGE_RECOVERY_RETRY_MS, remaining));
        }
      }
    } catch (error) {
      writeJcodeDiagnostic(
        `[cotal-jcode] private Harness connection closed and recovery failed: ${((lastError ?? error) as Error).message}\n`,
      );
      await shutdown(1);
    } finally {
      reconnecting = false;
      if (!stopping && (agent.pendingWake() > 0 || wakeQueued)) void drive();
    }
  };

  const watchClient = (connected: JcodeClient): void => {
    connected.on("close", () => void recoverBridge(connected));
    connected.on("session_status", (event: ApiEvent) => {
      if (!("session_id" in event) || event.session_id !== sessionId || event.ev !== "session_status") return;
      // Advisory idle between tool rounds does not mean the Cotal-owned run() has ended.
      // steerPending keys off sessionBusy() (driving || turnActive) so that pulse cannot drop a DM.
      turnActive = event.status !== "idle";
      if (!turnActive) void finishHostIdleTurn();
      else publishInboundHealth();
    });
    connected.on("turn_done", (event: ApiEvent) => {
      if ("session_id" in event && event.session_id === sessionId) {
        turnActive = false;
        void finishHostIdleTurn();
      }
    });
  };

  agent.on("incoming", (item: InboxItem) => {
    const automatic = agent.inboxScope(item.recvKey) === "automatic";
    if (!automatic) return;
    wakeQueued = true;
    if (!receivedAt.has(item.recvKey)) receivedAt.set(item.recvKey, Date.now());
    const directed = item.kind !== "channel" || item.mentionsMe;
    if (sessionBusy()) {
      if (directed) void steerPending();
      publishInboundHealth();
      return;
    }
    if (directed || agent.attention === "open") void drive();
  });

  let startControl: ReturnType<typeof startControlServer> | undefined;
  const shutdownControl = async (): Promise<void> => {
    startControl?.close();
    await shutdown();
  };
  startControl = startControlServer(agent, control, async () => ({ ok: false, error: "jcode has no lifecycle hook relay" }), {
    fatalBind: true,
    onShutdown: () => void shutdownControl(),
  });

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  try {
    client = await launchPrivateJcode();
    // A restart must come back to the session it left. Calling createSession unconditionally forked
    // a blank session and orphaned the real transcript, so a restarted seat reported for duty looking
    // healthy while remembering nothing - and the TUI, spawned with --resume below, showed a human the
    // very history the agent could not recall (#789). listSessions failing is not fatal: a seat that
    // cannot enumerate still deserves to start, it just starts fresh and says so.
    let prior: ResumeCandidate | undefined;
    try {
      prior = chooseSessionToResume(await client.listSessions(), cwd);
    } catch (error) {
      writeJcodeDiagnostic(
        `[cotal-jcode] could not list prior sessions, starting fresh: ${(error as Error).message}\n`,
      );
    }
    let session;
    if (prior) {
      session = await client.attachSession(prior.session_id);
      writeJcodeDiagnostic(
        `[cotal-jcode] resumed session ${prior.session_id} (${prior.transcript_bytes} bytes of transcript)\n`,
      );
    } else {
      session = await client.createSession(cwd);
      writeJcodeDiagnostic(`[cotal-jcode] started a fresh session (no resumable prior session in this home)\n`);
    }
    const resumed = prior !== undefined;
    sessionId = session.session_id;
    agent.setContextId(sessionId);
    // A `provider/model` specifier was forwarded verbatim to an endpoint that wants a bare id, and
    // the refusal came back as `model_not_found` naming neither the connector nor the prefix as the
    // cause. Refuse it here, where the accepted form can actually be named (#785).
    if (config.model) {
      const spec = bareModelId(config.model);
      if (!spec.ok)
        throw new JcodeConnectorError(
          "model_prefix_rejected",
          `jcode connector: model ${JSON.stringify(config.model)} carries a provider prefix, but the Harness API expects a bare model id — pass ${JSON.stringify(spec.bare)} (the ${JSON.stringify(spec.prefix)} provider is selected by configuration, not by the model id)`,
        );
    }
    if (config.model) {
      try {
        await client.setModel(sessionId, config.model);
      } catch (error) {
        throw new JcodeConnectorError("model_refused", "Jcode refused the requested model", { cause: error });
      }
    }
    // The Cotal variant is Jcode's per-session reasoning effort. Apply it after model selection
    // and before any instructions or readiness turn, so no served turn uses an unrequested tier.
    // Jcode owns the provider/model ladder and validates the requested tier at this API boundary.
    if (config.variant) {
      const model = (await client.getRuntimeInfo(sessionId)).model ?? config.model;
      try {
        await client.setReasoningEffort(sessionId, config.variant);
      } catch (error) {
        throw jcodeEffortRefusal(error, config.variant, model ?? "(the provider default)");
      }
    }
    // On a resume the persona/instructions are already the first thing in this transcript. Re-sending
    // them would replay the whole briefing on every restart and grow the context without adding to it.
    if (!resumed) {
      await client.sendMessage(sessionId, instructions(config, def?.persona || undefined), { noReply: true });
    }
    const useTui = tuiOverride ? /^(1|true|yes|on)$/i.test(tuiOverride) : Boolean(process.stdout.isTTY);
    // The viewer needs only the fresh session's socket. Start it before the readiness LLM turn so
    // a foreground operator sees boot activity while presence remains gated on readiness below.
    if (useTui) launchTui();
    // Jcode registers MCP tools asynchronously. Its first turn can lock the pre-MCP tool snapshot
    // just before cotal connects, then rebuild that snapshot. Repeat the exact proof once for this
    // measured race; a second absence is terminal, never a polling loop or a guessed success.
    const readinessPrompt = "Call the cotal_orientation tool exactly once now. Do not perform any other work and do not write a response.";
    const hasOrientation = (run: Awaited<ReturnType<JcodeClient["run"]>>) =>
      run.toolCalls.some((call) => /(?:^|__)cotal_orientation$/.test(call.name));
    let readiness;
    try {
      readiness = await client.run(sessionId, readinessPrompt, { autoApprove: true });
      if (!hasOrientation(readiness)) {
        readiness = await client.run(sessionId, readinessPrompt, { autoApprove: true });
      }
    } catch (error) {
      // A readiness-turn provider refusal is different from arbitrary Harness API failure: Jcode
      // supplied an invalid-request code and a rejected model/effort value the connector can safely
      // classify. Preserve only those bounded fields; all other message bytes stay scrubbed (#828).
      throw classifyReadinessProviderRefusal(error) ?? error;
    }
    if (!hasOrientation(readiness))
      throw new Error(
        "jcode connector: the cotal MCP bridge did not become callable during its two mandatory readiness turns — refusing to join a mesh seat without its tool surface",
      );
    watchClient(client);
    if (config.model) {
      const runtime = await client.getRuntimeInfo(sessionId);
      if (runtime.model !== config.model)
        throw new JcodeConnectorError(
          "model_mismatch",
          `jcode connector: requested model ${JSON.stringify(config.model)} but the Harness API reports ${JSON.stringify(runtime.model)} — refusing a mislabelled mesh seat`,
        );
      // The model is checked above; the PROVIDER carrying it was fetched in the same response and
      // then thrown away. That gap cost real time: a seat requested as one model logged under a
      // second provider's name and died inside a third component, and establishing which was true
      // meant reading the seat's private log by hand. RuntimeInfo already knows, so record it where
      // an operator looks first (#785).
      writeJcodeDiagnostic(`[cotal-jcode] ${describeRoute(runtime, config.model)}\n`);
    }

    initialized = true;
    await agent.start();
    // The readiness proof necessarily precedes mesh join. Tell the session that its bootstrap
    // orientation card was pre-join so it cannot later mistake that truthful old snapshot for its
    // current connection state (#778).
    await client.sendMessage(
      sessionId,
      `You are now connected to the Cotal mesh as "${config.name}". The earlier cotal_orientation result was captured before this join; use cotal_orientation again for live context.`,
      { noReply: true },
    );
    if (bootPrompt) await drive(bootPrompt);
  } catch (error) {
    // A shutdown requested mid-startup closes the client and rejects whatever startup step was in
    // flight. That is the shutdown completing, not a startup failure: let its teardown own the
    // process exit code instead of racing it to process.exit with a failure report.
    if (stopping) return;
    startControl?.close();
    await closeServer(relayServer);
    // The refusal is only safe once the launch it abandons is provably dead: returning non-zero
    // hands the manager a retired seat while an unverified daemon would keep running (#839).
    try {
      await stopPrivateJcode();
    } catch (teardown) {
      writeJcodeDiagnostic(`[cotal-jcode] ${(teardown as Error).message}\n`);
    }
    socketHome.dispose();
    await agent.stop().catch(() => {});
    throw error;
  }
}
