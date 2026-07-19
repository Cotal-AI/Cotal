// connector-codex — the serve shim (LaunchSpec.command = node, args = [dist/serve.js]).
//
// Owns ONE MeshAgent for the lifetime of the agent and drives the Codex CLI as a chain of
// non-interactive turns:
//
//   turn 1:  codex exec  <persona + orientation [+ initial prompt]>
//   turn N:  codex exec resume <threadId>  <formatInjection(drainInbox())>
//
// Every turn gets `-c mcp_servers.cotal.url="http://127.0.0.1:<port>/mcp"` — a local
// streamable-HTTP MCP server (this process) exposing the full cotal_* tool surface bound to
// the ONE MeshAgent, so mesh state (inbox acks, presence, joins) survives across turns.
// Peer messages that arrive mid-turn queue in the MeshAgent inbox and become the next turn.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { loadAgentFile, type PresenceStatus } from "@cotal-ai/core";
import {
  configFromEnv,
  hasIdentity,
  MeshAgent,
  registerCotalTools,
  startControlServer,
  formatInjection,
  ORIENTATION_BOOTSTRAP,
  MESH_FIRST_STEER,
} from "@cotal-ai/connector-core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const TURN_TIMEOUT_MS = Number(process.env.COTAL_CODEX_TURN_TIMEOUT_MS ?? 15 * 60 * 1000);
const log = (msg: string): void => void process.stderr.write(`[cotal-codex] ${msg}\n`);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One `codex exec --json` event line — only the fields the turn loop reads. */
interface CodexEvent {
  type?: string;
  thread_id?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string; message?: string };
}

async function freePort(): Promise<number> {
  const srv = createNetServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on("error", reject);
  });
}

async function main(): Promise<void> {
  if (!hasIdentity())
    throw new Error(
      "connector-codex serve: no COTAL_* identity in the environment — this shim is only launched by the cotal manager (not a managed session).",
    );

  const config = configFromEnv();
  config.connector = "codex";
  const workRoot = process.env.COTAL_CODEX_HOME?.trim() || process.cwd();
  const initialPrompt = process.env.COTAL_CODEX_PROMPT;
  const overrides: string[] = process.env.COTAL_CODEX_OVERRIDES
    ? (JSON.parse(process.env.COTAL_CODEX_OVERRIDES) as string[])
    : [];

  // Persona body (markdown after the frontmatter) — configFromEnv reads the frontmatter
  // (name/role/channels), the body is ours to hand codex as its first turn.
  let persona: string | undefined;
  if (process.env.COTAL_AGENT_FILE) {
    try {
      persona = loadAgentFile(process.env.COTAL_AGENT_FILE).persona;
    } catch (e) {
      throw new Error(`connector-codex: cannot read agent file ${process.env.COTAL_AGENT_FILE}: ${errMsg(e)}`);
    }
  }

  const agent = new MeshAgent(config);
  agent.on("error", (e) => log(`mesh error: ${errMsg(e)}`));
  agent.start();

  // ---- cotal MCP over local streamable HTTP (stateless: fresh server per request, one shared agent)
  const port = await freePort();
  const mcpUrl = `http://127.0.0.1:${port}/mcp`;
  const http = createHttpServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readBody(req);
      const server = new McpServer(
        { name: "cotal", version: "0.1.0" },
        { instructions: `${ORIENTATION_BOOTSTRAP} ${MESH_FIRST_STEER}` },
      );
      registerCotalTools(server, agent, config, "codex");
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log(`mcp request error: ${errMsg(e)}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  http.listen(port, "127.0.0.1");
  await once(http, "listening");
  log(`cotal MCP for codex on ${mcpUrl}`);

  // ---- turn loop state
  let threadId: string | undefined;
  let child: ChildProcess | undefined;
  let stopping = false;
  let wakeTimer: NodeJS.Timeout | undefined;

  const codexEnv = (): NodeJS.ProcessEnv => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
    return env;
  };

  function codexArgs(): string[] {
    const args = ["exec"];
    if (threadId) args.push("resume", threadId);
    args.push(
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-c",
      `mcp_servers.cotal.url="${mcpUrl}"`,
    );
    if (config.model) args.push("--model", config.model);
    if (config.variant) args.push("-c", `model_reasoning_effort="${config.variant}"`);
    for (const o of overrides) args.push("-c", o);
    args.push("-"); // prompt on stdin — immune to argv length limits and leading-dash text
    return args;
  }

  function runTurn(prompt: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = spawn("codex", codexArgs(), {
        cwd: workRoot,
        env: codexEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      child = proc;
      proc.stdin?.write(prompt);
      proc.stdin?.end();

      let sawCompleted = false;
      let failure: string | undefined;
      let buf = "";
      const onLine = (line: string): void => {
        if (!line.startsWith("{")) return;
        let ev: CodexEvent;
        try {
          ev = JSON.parse(line) as CodexEvent;
        } catch {
          return;
        }
        if (ev.type === "thread.started" && ev.thread_id && !threadId) {
          threadId = ev.thread_id;
          log(`codex thread ${threadId}`);
        } else if (ev.type === "turn.completed") {
          sawCompleted = true;
        } else if (ev.type === "turn.failed") {
          failure = ev.error?.message ?? JSON.stringify(ev);
        } else if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
          log(`codex says: ${String(ev.item.text ?? "").slice(0, 400)}`);
        } else if (ev.type === "item.completed" && ev.item?.type === "error") {
          log(`codex warning: ${ev.item.message}`);
        }
      };
      proc.stdout?.on("data", (d: Buffer) => {
        buf += d.toString();
        for (let i; (i = buf.indexOf("\n")) >= 0; ) {
          onLine(buf.slice(0, i).trim());
          buf = buf.slice(i + 1);
        }
      });
      let errTail = "";
      proc.stderr?.on("data", (d: Buffer) => {
        errTail = (errTail + d.toString()).slice(-4000);
      });

      const timer = setTimeout(() => {
        log(`turn timed out after ${TURN_TIMEOUT_MS}ms — killing codex`);
        proc.kill("SIGKILL");
      }, TURN_TIMEOUT_MS);

      proc.on("error", (e) => {
        clearTimeout(timer);
        child = undefined;
        reject(new Error(`codex spawn failed: ${e.message}`));
      });
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        child = undefined;
        if (buf.trim()) onLine(buf.trim());
        if (failure) return reject(new Error(`codex turn failed: ${failure}`));
        if (code !== 0 || !sawCompleted)
          return reject(
            new Error(
              `codex exec exited code=${code} signal=${signal} completed=${sawCompleted}: ${errTail.trim().split("\n").slice(-3).join(" | ")}`,
            ),
          );
        resolve();
      });
    });
  }

  const setStatusSafe = async (status: PresenceStatus, activity?: string): Promise<void> => {
    try {
      await agent.setStatus(status, activity);
    } catch {
      /* pre-connect / transient — presence is advisory */
    }
  };

  // ---- inbox pump: one turn at a time; messages landing mid-turn queue and become the next turn
  let pumping = false;
  async function pump(): Promise<void> {
    if (pumping || stopping) return;
    pumping = true;
    try {
      for (;;) {
        if (stopping || agent.pendingWake() === 0) break;
        const injection = formatInjection(agent.drainInbox(undefined, "automatic"));
        if (!injection) break;
        await setStatusSafe("working", "codex turn");
        try {
          await runTurn(injection);
        } catch (e) {
          log(`turn failed: ${errMsg(e)}`);
          break; // don't spin — wait for the next wake
        }
      }
    } finally {
      pumping = false;
      await setStatusSafe("idle");
    }
  }
  const scheduleWake = (delay = 300): void => {
    if (stopping) return;
    clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => void pump(), delay);
  };

  // ---- cooperative shutdown (manager control frame, signals)
  async function shutdown(code = 0): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearTimeout(wakeTimer);
    try {
      child?.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    try {
      await agent.stop();
    } catch {
      /* best-effort — exiting anyway */
    }
    try {
      http.close();
    } catch {
      /* best-effort — exiting anyway */
    }
    process.exit(code);
  }
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  const controlPath = process.env.COTAL_CONTROL_SOCKET;
  const controlToken = process.env.COTAL_CONTROL_TOKEN;
  if (controlPath && controlToken) {
    startControlServer(
      agent,
      { path: controlPath, token: controlToken },
      async () => ({}), // codex has no lifecycle hooks — the control plane is shutdown-only
      { fatalBind: true, onShutdown: () => void shutdown(0) },
    );
  }

  // ---- wait for the mesh link, then boot turn: persona + orientation (+ optional launch prompt)
  const deadline = Date.now() + 60_000;
  while (!agent.connected && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 250));
  if (!agent.connected)
    throw new Error("connector-codex: mesh connection not established within 60s — aborting (is the broker up?)");
  log(`joined mesh "${config.space}" as ${config.name} (${agent.id})`);

  const bootParts = [
    `You are "${config.name}"${config.role ? ` (role: ${config.role})` : ""} — an agent on the Cotal mesh (space "${config.space}"), hosted on the OpenAI Codex CLI.`,
    `Peers reach you via mesh channels and DMs. Use the cotal_* tools (MCP server "cotal") to read and reply: cotal_send for channels, cotal_dm for direct messages. Work delivered to you arrives as "messages from peers" blocks; a turn that ends without sending a reply is INVISIBLE to peers — always report back over the mesh.`,
    ORIENTATION_BOOTSTRAP,
    MESH_FIRST_STEER,
  ];
  const briefing = agent.channelBriefing();
  if (briefing) bootParts.push(briefing);
  if (persona) bootParts.push(`## Your persona\n\n${persona}`);
  if (initialPrompt) bootParts.push(initialPrompt);

  await setStatusSafe("working", "orienting");
  try {
    await runTurn(bootParts.join("\n\n"));
  } catch (e) {
    log(`boot turn failed: ${errMsg(e)}`);
    await shutdown(1);
    return;
  }
  await setStatusSafe("idle");
  log("boot turn complete — waiting for peer messages");

  agent.on("incoming", () => scheduleWake());
  agent.on("wake", () => scheduleWake(0));
  agent.on("mention-wake", () => scheduleWake(0));
  scheduleWake(0); // catch anything buffered during boot
}

main().catch((e: unknown) => {
  process.stderr.write(`[cotal-codex] fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
