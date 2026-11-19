// Host support moved verbatim from host.ts: timing bounds, the bridge-recovery classifier, the seat home,
// MCP config, relay server and env scrub. host.ts re-exports the public names so importers keep their paths.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError } from "@1jehuang/jcode-sdk";
import { hardenPrivate, type PresenceCondition, type PresenceConditionCode } from "@cotal-ai/core";
import { jcodeSeatHome } from "./session-fork.js";
import { JcodeProjectMcpConfig, PROJECT_MCP_FILES, writeJcodeDiagnostic } from "./startup-diagnostics.js";
import { JCODE_READINESS_TIMEOUT_MS } from "./readiness-bound.js";
import { MeshAgent, briefing, parseToolArgs, cotalToolSpecs, type AgentConfig, type ToolResult } from "@cotal-ai/connector-core";

const MAX_RELAY_BYTES = 4 * 1024 * 1024;
/** How often the relay checks that its socket path still exists. See the re-bind in `startRelay`. */
const RELAY_REBIND_POLL_MS = 1_000;
/** How long a stop waits for the TUI to exit after SIGTERM, and again after SIGKILL. A TUI exits in
 *  milliseconds; the bound keeps a wedged one from eating the grace the private tree needs. */
export const TUI_STOP_GRACE_MS = 1_000;
/** How long a run may hold the dispatch gate waiting for its own acknowledgement (#1233).
 *
 *  Matches the SDK's `acceptTimeoutMs` default, because that is the point past which `sendMessage`
 *  stops waiting anyway (jcode-sdk client.js:317), so a longer value here could only hold the gate
 *  after the thing it is waiting for has already given up. It is a CEILING, not a delay: the gate is
 *  released the moment the acknowledgement arrives, which is single-digit milliseconds on a healthy
 *  seat. A Harness that never acknowledges therefore costs one bounded wait, not a wedged gate. */
export const RUN_ACCEPT_WINDOW_MS = 10_000;
/** One bridge recovery remains bounded, but it is bounded by time rather than one launch/attach
 *  outcome. A loaded host can lose a transient replacement race without turning that into a
 *  second provider close or an unbounded relaunch loop. The window opens at the close, so tearing
 *  down the broken tree spends it too. Exported so a test waiting on a recovery step allows the
 *  host the same window instead of a shorter guess. */
export const BRIDGE_RECOVERY_WINDOW_MS = 60_000;

export function readinessTurnTimeoutMs(): number {
  const raw = process.env.COTAL_JCODE_READINESS_TIMEOUT_MS?.trim();
  if (!raw) return JCODE_READINESS_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`jcode connector: COTAL_JCODE_READINESS_TIMEOUT_MS ${JSON.stringify(raw)} is not a positive integer`);
  return parsed;
}

/**
 * Override for the SDK's per-request reply timeout, which defaults to 30000ms.
 *
 * Exists so a fixture can make a soft-interrupt timeout happen in seconds instead of half a minute.
 * It is NOT a remedy for #1233 and must never be used as one: lengthening this bound only makes the
 * stall take longer to appear, and shortening it makes it appear sooner. What the fix changes is
 * what happens AFTER the timeout, which is why this knob is validated the same way as the readiness
 * bound and otherwise left alone.
 */
export function requestTimeoutOverrideMs(): number | undefined {
  const raw = process.env.COTAL_JCODE_REQUEST_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`jcode connector: COTAL_JCODE_REQUEST_TIMEOUT_MS ${JSON.stringify(raw)} is not a positive integer`);
  return parsed;
}

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
  /** The owner-only directory that holds {@link path}. Empty on Windows, which uses a named pipe. */
  dir: string;
  path: string;
  token: string;
}

const PRESENCE_CONDITION_CODES: ReadonlySet<string> = new Set<PresenceConditionCode>([
  "rate_limit", "overloaded", "auth", "billing", "budget", "context", "model", "request", "server", "retrying", "approval", "input", "failed",
]);

/** A failed turn's condition, relayed from the Harness's own error code. Only a `HarnessError` is
 *  relayed: it is what the Harness reported. A code outside the closed set reads `failed`, with
 *  the native code kept as `source`. Without this the seat read `waiting` with the error only in
 *  its private log (#618). */
export function jcodeTurnCondition(error: unknown, since = Date.now()): PresenceCondition | undefined {
  if (!(error instanceof HarnessError)) return undefined;
  const source = String(error.code);
  const code = (PRESENCE_CONDITION_CODES.has(source) ? source : "failed") as PresenceConditionCode;
  return { code, source, message: error.message, since };
}

/** Jcode acknowledges a plain send with `message_accepted` before it checks whether this connection
 *  is still processing a message, and then refuses the send with this error. The acknowledgement is
 *  therefore no proof that the model received the text. */
export function isJcodeBusyRefusal(error: unknown): boolean {
  return error instanceof HarnessError && error.message.includes("Already processing a message");
}

export function privateAgentHome(space: string, name: string): string {
  const root = process.env.COTAL_JCODE_HOME?.trim();
  if (!root) throw new Error("COTAL_JCODE_HOME is not set — the connector must pin the agent's Jcode home");
  const managedRoot = join(root, ".cotal", "jcode");
  const home = jcodeSeatHome(root, space, name);
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
    // Keep the catalog's authenticated-mode gate without exposing either credential shape.
    // Clearing both markers makes a user-mode child advertise tools its host refuses.
    creds: config.creds || config.userAuth ? "managed" : undefined,
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
 * source set, so refuse the whole launch instead of claiming our private home is sufficient. A home
 * directory counts too: its `.jcode/mcp.json` is Jcode's own global file, read here as a project's. */
export function assertNoProjectMcpConfig(cwd: string): void {
  const found = PROJECT_MCP_FILES.filter((relative) => existsSync(join(cwd, relative)));
  if (found.length) throw new JcodeProjectMcpConfig(found);
}

function mcpEntry(): { command: string; args: string[] } {
  const built = import.meta.url.includes("/dist/");
  if (built) return { command: process.execPath, args: [filePath("mcp.js")] };
  return { command: filePath("../node_modules/.bin/tsx"), args: [filePath("mcp-main.ts")] };
}

function filePath(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

export function writeMcpConfig(home: string, relay: RelayEndpoint, config: AgentConfig): void {
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
        // Pooled (Jcode's default): one bridge per daemon, reused across every session in the
        // seat, so repeated subagent sessions cannot each leave a bridge process behind until
        // teardown. Pooling never crosses seats — the pool lives in the daemon and this daemon is
        // private to the seat (its own JCODE_HOME, socket, and relay token above).
        shared: true,
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

/**
 * Where this launch keeps its tool relay socket.
 *
 * The socket used to sit at the top level of the shared temp directory. Anything that empties that
 * directory — a distribution's periodic cleaner, or a self-test whose recursive cleanup escaped its
 * own root — unlinked the control path of every live seat at once. The host kept listening on the
 * now-nameless inode, so every `cotal_*` call failed with `connect ENOENT` and the only recovery was
 * a respawn, which discards the session's context (#1625). One private per-launch directory keeps
 * the socket out of a top-level sweep, and `startRelay` re-binds the path if it disappears anyway.
 */
export function relayEndpoint(space: string, name: string): RelayEndpoint {
  const token = randomBytes(32).toString("base64url");
  const id = createHash("sha256").update(`${space}\0${name}\0${process.pid}\0${token}`).digest("base64url").slice(0, 32);
  if (process.platform === "win32") return { dir: "", path: `\\\\.\\pipe\\cotal-jcode-${id}`, token };
  // `/tmp` rather than `tmpdir()`, as the SDK alias directory does: this path is AF_UNIX and an
  // overridden TMPDIR can push it past sun_path.
  const dir = join("/tmp", `cotal-jcode-${id}`);
  return { dir, path: join(dir, "relay.sock"), token };
}

function ensureRelayDirectory(endpoint: RelayEndpoint): void {
  if (process.platform === "win32") return;
  mkdirSync(endpoint.dir, { recursive: true, mode: 0o700 });
  hardenPrivate(endpoint.dir, "dir");
}

export function instructions(config: AgentConfig, persona: string | undefined): string {
  const mesh = briefing(config, "jcode");
  return persona ? `${persona}\n\n${mesh}` : mesh;
}

function constantTokenMatches(presented: unknown, expected: string): boolean {
  if (typeof presented !== "string") return false;
  const actual = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

export async function startRelay(agent: MeshAgent, config: AgentConfig, endpoint: RelayEndpoint): Promise<Server> {
  const specs = new Map(cotalToolSpecs(config, "jcode").map((spec) => [spec.name, spec]));
  ensureRelayDirectory(endpoint);
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
  const listen = (): Promise<void> =>
    new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(endpoint.path, () => {
        server.removeListener("error", reject);
        resolvePromise();
      });
    });
  await listen();
  if (process.platform !== "win32") {
    // A listener whose path was unlinked serves nobody: the bridge connects by name and gets
    // ENOENT. Re-bind it so a deleted socket costs one poll interval instead of a respawn (#1625).
    // `server.listening` is false once shutdown closes the server for good, which retires this.
    let rebinding = false;
    const watch = setInterval(() => {
      if (rebinding || !server.listening || existsSync(endpoint.path)) return;
      rebinding = true;
      void (async () => {
        try {
          ensureRelayDirectory(endpoint);
          await closeServer(server);
          await listen();
          writeJcodeDiagnostic(`[cotal-jcode] the tool relay socket was deleted; re-bound it at the same path\n`);
        } catch (error) {
          writeJcodeDiagnostic(`[cotal-jcode] the tool relay socket was deleted and could not be re-bound: ${(error as Error).message}\n`);
        } finally {
          rebinding = false;
        }
      })();
    }, RELAY_REBIND_POLL_MS);
    watch.unref?.();
  }
  return server;
}

function closeServer(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => server?.close(() => resolve()) ?? resolve());
}

/** Close the relay and take its private directory with it, so a retired launch leaves nothing. */
export async function retireRelay(server: Server | undefined, endpoint: RelayEndpoint): Promise<void> {
  await closeServer(server);
  if (process.platform !== "win32") rmSync(endpoint.dir, { recursive: true, force: true });
}

export const SEAT_ATTRIBUTION_ENV: ReadonlySet<string> = new Set([
  "COTAL_SPACE",
  "COTAL_MANAGER_INSTANCE",
  "COTAL_NAME",
  "COTAL_ID",
  "COTAL_LIFECYCLE_UID",
  "COTAL_ACCEPTED_TOKEN",
  "COTAL_HOME",
]);

export function noCotalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("COTAL_")) env[key] = value;
  return env;
}
