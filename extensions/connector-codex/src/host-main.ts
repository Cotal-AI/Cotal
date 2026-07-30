import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import {
  hardenPrivate,
  loadAgentFile,
  type PresenceStatus,
} from "@cotal-ai/core";
import {
  configFromEnv,
  hasIdentity,
  MeshAgent,
  ORIENTATION_BOOTSTRAP,
  MESH_FIRST_STEER,
  startControlServer,
} from "@cotal-ai/connector-core";
import { AppServerClient } from "./rpc.js";
import { CodexBridge } from "./bridge.js";
import { startCodexMcpServer, withCotalMcp } from "./mcp.js";
import { codexChildEnv } from "./env.js";

const STARTUP_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;

function log(message: string): void {
  process.stderr.write(`[cotal-codex] ${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || childExited(child)) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    once(child, "exit").then(() => true),
    delay(SHUTDOWN_TIMEOUT_MS).then(() => false),
  ]);
  if (!stopped && !childExited(child)) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
}

async function waitForSocket(path: string, appServer: ChildProcess): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    if (childExited(appServer))
      throw new Error(
        `codex app-server exited before its socket was ready (code=${appServer.exitCode}, signal=${appServer.signalCode})`,
      );
    await delay(50);
  }
  throw new Error(`codex app-server socket did not become ready within ${STARTUP_TIMEOUT_MS}ms`);
}

function parseThreadConfig(): Record<string, unknown> | undefined {
  const raw = process.env.COTAL_CODEX_THREAD_CONFIG?.trim();
  if (!raw) return undefined;
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("COTAL_CODEX_THREAD_CONFIG must be a JSON object");
  return value as Record<string, unknown>;
}

function childExitStatus(
  label: "app-server" | "tui",
  code: number | null,
  signal: NodeJS.Signals | null,
): number {
  if (code && code !== 0) return code;
  if (signal) return 1;
  return label === "tui" ? 0 : 1;
}

async function connectAppServer(socketPath: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws+unix://${socketPath}:/rpc`, {
    handshakeTimeout: STARTUP_TIMEOUT_MS,
    maxPayload: 16 * 1024 * 1024,
    perMessageDeflate: false,
  });
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
  return socket;
}

async function main(): Promise<void> {
  if (!hasIdentity())
    throw new Error(
      "connector-codex host has no COTAL identity; launch it through cotal spawn/start",
    );
  const controlPath = process.env.COTAL_CONTROL_SOCKET?.trim();
  const controlToken = process.env.COTAL_CONTROL_TOKEN?.trim();
  if (!controlPath || !controlToken)
    throw new Error(
      "managed Codex connector is missing COTAL_CONTROL_SOCKET/COTAL_CONTROL_TOKEN",
    );

  const config = configFromEnv();
  config.connector = "codex";
  const definition = process.env.COTAL_AGENT_FILE?.trim()
    ? loadAgentFile(process.env.COTAL_AGENT_FILE.trim())
    : undefined;
  const developerInstructions = [
    definition?.persona,
    ORIENTATION_BOOTSTRAP,
    MESH_FIRST_STEER,
    `You are connected to the Cotal mesh as "${config.name}"` +
      `${config.role ? ` (role: ${config.role})` : ""} in space "${config.space}". ` +
      "Use cotal_orientation first. Peer messages arrive as attributed Cotal inbox blocks. " +
      "Reply deliberately with cotal_dm, cotal_send, or cotal_anycast; a final answer in the " +
      "terminal alone is not delivered to a peer.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const agent = new MeshAgent(config);
  agent.on("error", (error) => log(`mesh error: ${errorMessage(error)}`));
  agent.start();
  const codexEnv = codexChildEnv(process.env);
  const mcpToken = randomBytes(32).toString("base64url");
  const mcpServer = await startCodexMcpServer(agent, config, mcpToken);

  const ownedDir = mkdtempSync(join(tmpdir(), "cotal-codex-"));
  hardenPrivate(ownedDir, "dir");
  const socketPath = join(ownedDir, "app-server.sock");
  const remote = `unix://${socketPath}`;
  const children = new Set<ChildProcess>();
  let attached = false;
  let stopping = false;
  let bridge: CodexBridge | undefined;
  let peer: AppServerClient | undefined;
  let controlServer: ReturnType<typeof startControlServer> | undefined;

  const appServer = spawn("codex", ["app-server", "--listen", remote], {
    cwd: process.cwd(),
    env: codexEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(appServer);
  appServer.stderr?.on("data", (chunk: Buffer) => {
    if (!attached) process.stderr.write(chunk);
  });

  const shutdown = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await Promise.race([
        bridge?.interrupt() ?? Promise.resolve(),
        delay(SHUTDOWN_TIMEOUT_MS),
      ]);
    } catch (error) {
      log(`turn/interrupt during shutdown: ${errorMessage(error)}`);
    }
    await Promise.race([
      bridge?.stop() ?? Promise.resolve(),
      delay(SHUTDOWN_TIMEOUT_MS),
    ]).catch((error) => log(`Codex thread cleanup: ${errorMessage(error)}`));
    controlServer?.close();
    peer?.close();
    await Promise.race([mcpServer.close(), delay(SHUTDOWN_TIMEOUT_MS)]).catch(
      (error) => log(`MCP stop: ${errorMessage(error)}`),
    );
    await Promise.race([
      agent.stop(),
      delay(SHUTDOWN_TIMEOUT_MS),
    ]).catch((error) => log(`mesh stop: ${errorMessage(error)}`));
    await Promise.all([...children].map((child) => stopChild(child)));
    rmSync(ownedDir, { recursive: true, force: true });
    process.exit(code);
  };

  const failIfUnexpected = (
    label: "app-server" | "tui",
    child: ChildProcess,
  ): void => {
    child.on("exit", (code, signal) => {
      children.delete(child);
      if (!stopping) void shutdown(childExitStatus(label, code, signal));
    });
    child.on("error", (error) => {
      log(`${label} process error: ${errorMessage(error)}`);
      if (!stopping) void shutdown(1);
    });
  };
  failIfUnexpected("app-server", appServer);

  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => void shutdown(0));

  try {
    controlServer = startControlServer(
      agent,
      { path: controlPath, token: controlToken },
      async () => ({
        ok: false,
        error: "Codex uses app-server events; control is shutdown-only",
      }),
      { fatalBind: true, onShutdown: () => void shutdown(0) },
    );
    await waitForSocket(socketPath, appServer);
    const socket = await connectAppServer(socketPath);
    peer = new AppServerClient({
      socket,
      requestTimeoutMs: Number(
        process.env.COTAL_CODEX_REQUEST_TIMEOUT_MS ?? STARTUP_TIMEOUT_MS,
      ),
    });
    peer.on("closed", (error: Error) => {
      if (!stopping) {
        log(`app-server transport closed: ${errorMessage(error)}`);
        void shutdown(1);
      }
    });
    const initialPrompt =
      process.env.COTAL_CODEX_PROMPT?.trim() ||
      "Join the Cotal mesh now: call cotal_orientation, then remain available for peer messages. Do not modify files or start unrelated work.";
    bridge = new CodexBridge({
      peer,
      agent,
      model: process.env.COTAL_CODEX_MODEL?.trim() || undefined,
      effort: process.env.COTAL_CODEX_EFFORT?.trim() || undefined,
      developerInstructions,
      initialPrompt,
      threadConfig: withCotalMcp(parseThreadConfig(), mcpServer.url, mcpToken),
    });
    const threadId = await bridge.start();
    // Codex 0.146 does not materialize an empty thread/start as a rollout. Start the explicit
    // orientation-only bootstrap turn first, then fence on the stored rollout before attaching the
    // real TUI. This avoids both a blind sleep and the `no rollout found` resume race.
    bridge.activate();
    await bridge.waitUntilStored(STARTUP_TIMEOUT_MS);

    // The TUI is a second app-server client on the same persistent thread. Strip COTAL_* so it is
    // only a viewer/operator surface and can never create a second mesh identity.
    const tuiEnv = { ...codexEnv };
    for (const key of Object.keys(tuiEnv))
      if (key.startsWith("COTAL_")) delete tuiEnv[key];
    const tui = spawn(
      "codex",
      ["resume", threadId, "--remote", remote],
      {
        cwd: process.cwd(),
        env: tuiEnv,
        stdio: "inherit",
      },
    );
    children.add(tui);
    failIfUnexpected("tui", tui);
    attached = true;
    log(`ready — thread=${threadId} space="${config.space}" name="${config.name}"`);
  } catch (error) {
    log(`startup failed: ${errorMessage(error)}`);
    await shutdown(1);
  }
}

void main().catch((error) => {
  process.stderr.write(`[cotal-codex] fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
