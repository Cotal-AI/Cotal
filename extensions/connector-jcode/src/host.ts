import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { JcodeClient, type ApiEvent } from "@1jehuang/jcode-sdk";
import { hardenPrivate, loadAgentFile } from "@cotal-ai/core";
import { mirrorJcodeCredentials, shortSocketHome } from "./private-state.js";
import { chooseSessionToResume, type ResumeCandidate } from "./session-resume.js";
import { bareModelId, describeRoute } from "./route-identity.js";
import {
  MeshAgent,
  ORIENTATION_BOOTSTRAP,
  MESH_FIRST_STEER,
  configFromEnv,
  controlFromEnv,
  feedbackLine,
  formatInjection,
  parseToolArgs,
  refuseAnyArgs,
  scrubLaunchMaterial,
  startControlServer,
  cotalToolSpecs,
  type AgentConfig,
  type InboxItem,
  type ToolResult,
} from "@cotal-ai/connector-core";

const MAX_RELAY_BYTES = 4 * 1024 * 1024;
const RELAY_TIMEOUT_MS = 30_000;

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
          let result: ToolResult;
          if (spec.name === "cotal_inbox") {
            const refused = refuseAnyArgs(spec.name, frame.args);
            result = refused ? { text: refused, isError: true } : await spec.run(agent, config, { scope: "pull-only" });
          } else {
            result = await spec.run(agent, config, parseToolArgs(spec, frame.args));
          }
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
  const binary = "jcode";
  const tuiOverride = process.env.COTAL_JCODE_TUI?.trim();
  const bootPrompt = process.env.COTAL_JCODE_PROMPT?.trim();
  const def = process.env.COTAL_AGENT_FILE?.trim() ? loadAgentFile(process.env.COTAL_AGENT_FILE.trim()) : undefined;
  const cwd = process.cwd();
  assertNoProjectMcpConfig(cwd);
  const home = privateAgentHome(config.space, config.name);
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

  let client: JcodeClient | undefined;
  let tui: ChildProcess | undefined;
  let stopping = false;
  let sessionId: string | undefined;
  let driving = false;
  let turnActive = false;
  let briefed = false;
  let initialized = false;
  let wakeQueued = false;

  const shutdown = async (code = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      tui?.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    await closeServer(relayServer);
    try {
      await client?.close();
    } finally {
      socketHome.dispose();
      await agent.stop().catch(() => {});
      process.exit(code);
    }
  };

  const drive = async (override?: string): Promise<void> => {
    if (stopping || !initialized || driving || turnActive || !client || !sessionId) return;
    wakeQueued = false;
    const parts: string[] = [];
    let ids: string[] = [];
    if (override) parts.push(override);
    else {
      const inbox = agent.peekInbox("automatic");
      const injection = formatInjection(inbox);
      if (!injection) return;
      ids = inbox.map((item) => item.id);
      parts.push(injection);
    }
    if (!briefed) {
      briefed = true;
      const briefing = agent.channelBriefing();
      if (briefing) parts.unshift(briefing);
    }
    driving = true;
    turnActive = true;
    void agent.setStatus("working").catch(() => {});
    try {
      await client.run(sessionId, parts.join("\n\n"), { autoApprove: true });
      if (ids.length) agent.drainInboxIds(ids);
    } catch (error) {
      process.stderr.write(`[cotal-jcode] turn failed: ${(error as Error).message}\n`);
    } finally {
      turnActive = false;
      driving = false;
      void agent.setStatus("idle").catch(() => {});
      if (agent.pendingWake() > 0 || wakeQueued) void drive();
    }
  };

  agent.on("incoming", (item: InboxItem) => {
    void item;
    wakeQueued = true;
    void drive();
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
    client = await JcodeClient.launch({
      binary,
      jcodeHome: socketHome.jcodeHome,
      workingDir: cwd,
      // Re-copied above on every launch. Do not call the SDK default: it links rotating provider
      // auth files, while current jcode correctly refuses external auth paths that are symlinks.
      inheritLogins: false,
      env: { JCODE_DISABLE_CLAUDE_MCP: "1" },
    });
    // A restart must come back to the session it left. Calling createSession unconditionally forked
    // a blank session and orphaned the real transcript, so a restarted seat reported for duty looking
    // healthy while remembering nothing - and the TUI, spawned with --resume below, showed a human the
    // very history the agent could not recall (#789). listSessions failing is not fatal: a seat that
    // cannot enumerate still deserves to start, it just starts fresh and says so.
    let prior: ResumeCandidate | undefined;
    try {
      prior = chooseSessionToResume(await client.listSessions(), cwd);
    } catch (error) {
      process.stderr.write(
        `[cotal-jcode] could not list prior sessions, starting fresh: ${(error as Error).message}\n`,
      );
    }
    let session;
    if (prior) {
      session = await client.attachSession(prior.session_id);
      process.stderr.write(
        `[cotal-jcode] resumed session ${prior.session_id} (${prior.transcript_bytes} bytes of transcript)\n`,
      );
    } else {
      session = await client.createSession(cwd);
      process.stderr.write(`[cotal-jcode] started a fresh session (no resumable prior session in this home)\n`);
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
        throw new Error(
          `jcode connector: model ${JSON.stringify(config.model)} carries a provider prefix, but the Harness API expects a bare model id — pass ${JSON.stringify(spec.bare)} (the ${JSON.stringify(spec.prefix)} provider is selected by configuration, not by the model id)`,
        );
    }
    if (config.model) await client.setModel(sessionId, config.model);
    // The Cotal variant IS Jcode's per-session reasoning effort. It is applied here — after the
    // model, before the instructions and the readiness turn — so no turn this seat serves ever runs
    // at an effort its operator did not choose. The accepted tiers are per provider AND per model,
    // and the Harness API publishes no ladder to check against, so the tier is validated by the
    // component that owns that catalog: Jcode refuses, naming the set it would have taken, and the
    // refusal ends the launch. Clamping to a neighbouring tier would put a seat on the mesh
    // deliberating at a level nobody asked for, which is the failure this whole path exists to stop.
    if (config.variant) {
      const model = (await client.getRuntimeInfo(sessionId)).model ?? config.model;
      try {
        await client.setReasoningEffort(sessionId, config.variant);
      } catch (error) {
        throw new Error(`jcode connector: reasoning effort ${JSON.stringify(config.variant)} was refused for model ${JSON.stringify(model ?? "(the provider default)")} — ${(error as Error).message}`);
      }
    }
    // On a resume the persona/instructions are already the first thing in this transcript. Re-sending
    // them would replay the whole briefing on every restart and grow the context without adding to it.
    if (!resumed) {
      await client.sendMessage(sessionId, instructions(config, def?.persona || undefined), { noReply: true });
    }
    // Jcode registers MCP tools asynchronously. A first workload turn before its tools appear is
    // a silent mesh failure: the seat looks online yet cannot answer peers. Prove the exact cotal
    // surface is callable first. The Harness API exposes no MCP-ready event, so an absent call is
    // not retried or guessed over — the launch fails before it advertises presence.
    const readiness = await client.run(
      sessionId,
      "Call the cotal_orientation tool exactly once now. Do not perform any other work and do not write a response.",
      { autoApprove: true },
    );
    if (!readiness.toolCalls.some((call) => /(?:^|__)cotal_orientation$/.test(call.name)))
      throw new Error(
        "jcode connector: the cotal MCP bridge did not become callable during its mandatory readiness turn — refusing to join a mesh seat without its tool surface",
      );
    client.on("close", () => void shutdown(1));
    client.on("session_status", (event: ApiEvent) => {
      if (!("session_id" in event) || event.session_id !== sessionId || event.ev !== "session_status") return;
      turnActive = event.status !== "idle";
      void agent.setStatus(turnActive ? "working" : "idle").catch(() => {});
      if (!turnActive && (agent.pendingWake() > 0 || wakeQueued)) void drive();
    });
    client.on("turn_done", (event: ApiEvent) => {
      if ("session_id" in event && event.session_id === sessionId) {
        turnActive = false;
        if (agent.pendingWake() > 0 || wakeQueued) void drive();
      }
    });
    if (config.model) {
      const runtime = await client.getRuntimeInfo(sessionId);
      if (runtime.model !== config.model)
        throw new Error(
          `jcode connector: requested model ${JSON.stringify(config.model)} but the Harness API reports ${JSON.stringify(runtime.model)} — refusing a mislabelled mesh seat`,
        );
      // The model is checked above; the PROVIDER carrying it was fetched in the same response and
      // then thrown away. That gap cost real time: a seat requested as one model logged under a
      // second provider's name and died inside a third component, and establishing which was true
      // meant reading the seat's private log by hand. RuntimeInfo already knows, so record it where
      // an operator looks first (#785).
      process.stderr.write(`[cotal-jcode] ${describeRoute(runtime, config.model)}\n`);
    }

    initialized = true;
    agent.start();
    if (bootPrompt) await drive(bootPrompt);

    const useTui = tuiOverride ? /^(1|true|yes|on)$/i.test(tuiOverride) : Boolean(process.stdout.isTTY);
    if (useTui) {
      const runtime = join(socketHome.jcodeHome, "run");
      tui = spawn(binary, ["--socket", join(runtime, "jcode.sock"), "--resume", sessionId], {
        cwd,
        env: { ...noCotalEnv(), JCODE_HOME: socketHome.jcodeHome, JCODE_RUNTIME_DIR: runtime, JCODE_SOCKET: join(runtime, "jcode.sock") },
        stdio: "inherit",
      });
      tui.once("exit", (code) => void shutdown(code ?? 0));
    }
  } catch (error) {
    startControl?.close();
    await closeServer(relayServer);
    await client?.close().catch(() => {});
    socketHome.dispose();
    await agent.stop().catch(() => {});
    throw error;
  }
}
