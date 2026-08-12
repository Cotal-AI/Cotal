import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXIT_WAIT_MS = 8_000;
const EXIT_POLL_MS = 100;
const PROBE_MS = 2_000;
const RUN_TIMEOUT_MS = 10_000;
const SERVER_START_WAIT_MS = 5_000;
const SERVER_START_POLL_MS = 100;

/** A structured error from the herdr CLI/socket API (e.g. `pane_not_found`). */
export class HerdrCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`herdr: ${code}: ${message}`);
    this.name = "HerdrCliError";
  }
}

/** True if the herdr binary is installed and reachable on PATH. The session server is
 *  provisioned separately ({@link ensureServer}), like tmux's auto-created sessions. */
export function available(): boolean {
  try {
    execFileSync("herdr", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** One live pane/agent row as herdr reports it. `terminalId` is the globally-unique stable
 *  identity; `paneId` is the CURRENT public id (workspace-scoped, changes when a pane moves
 *  across workspaces) and must be re-resolved before every pane-scoped operation. */
export interface HerdrAgent {
  terminalId: string;
  paneId: string;
  workspaceId: string;
}

function parseAgent(record: Record<string, unknown>): HerdrAgent {
  const terminalId = record.terminal_id;
  const paneId = record.pane_id;
  const workspaceId = record.workspace_id;
  if (typeof terminalId !== "string" || typeof paneId !== "string" || typeof workspaceId !== "string")
    throw new Error(`herdr: malformed agent record (${JSON.stringify(record)})`);
  return { terminalId, paneId, workspaceId };
}

/** True only for the exact structured code herdr returns when `agent get` targets a gone
 *  terminal. Any other code (workspace/session/plugin not-found, permission, protocol) must
 *  propagate — the idempotency exception is deliberately this narrow. */
export function isAgentGone(err: unknown): boolean {
  return err instanceof HerdrCliError && err.code === "agent_not_found";
}

/** Run one herdr CLI command scoped to `session` and return the parsed JSON `result`.
 *  Every invocation carries `--session` explicitly so no call can ever hit the ambient/default
 *  Herdr session. A JSON `{error}` becomes a {@link HerdrCliError}; missing/non-JSON output
 *  throws — except for `void: true` commands (send-keys, report-metadata), which herdr
 *  acknowledges with a bare exit 0 and no output. */
export function run(session: string, args: string[], opts: { void?: boolean } = {}): Record<string, unknown> {
  let out: string;
  try {
    out = execFileSync("herdr", ["--session", session, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: RUN_TIMEOUT_MS,
    });
  } catch (err) {
    // A JSON error rides stderr (sometimes stdout) with a nonzero exit; surface its code.
    // Anything else (socket down, timeout, kill) is not a protocol error — rethrow with context.
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const structured = parseError(`${String(e.stdout ?? "")}\n${String(e.stderr ?? "")}`);
    if (structured) throw structured;
    throw new Error(
      `herdr --session ${session} ${args.join(" ")} failed: ${String(e.stderr ?? "").trim() || String(e.message ?? err)}`,
      { cause: err },
    );
  }
  const structured = parseError(out);
  if (structured) throw structured;
  if (opts.void) return {};
  return parseResult(session, args, out);
}

function parseError(out: string): HerdrCliError | undefined {
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { error?: { code?: unknown; message?: unknown } };
      if (parsed.error)
        return new HerdrCliError(String(parsed.error.code ?? "unknown"), String(parsed.error.message ?? trimmed));
    } catch {
      /* not JSON — keep scanning */
    }
  }
  return undefined;
}

function parseResult(session: string, args: string[], out: string): Record<string, unknown> {
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { result?: unknown };
      if (parsed.result && typeof parsed.result === "object") return parsed.result as Record<string, unknown>;
    } catch {
      /* not JSON — keep scanning */
    }
  }
  throw new Error(`herdr --session ${session} ${args.join(" ")}: no JSON result in output (${JSON.stringify(out)})`);
}

/** True if the session's server answers on its socket. `herdr status server` exits 0 either
 *  way, so the answer is in the text. */
export function serverRunning(session: string): boolean {
  const out = execFileSync("herdr", ["--session", session, "status", "server"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROBE_MS,
  });
  return /^\s*status:\s*running\s*$/m.test(out);
}

/** Portable synchronous sleep — {@link Runtime.spawn} is a synchronous contract, so server
 *  provisioning below cannot await. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Whether the spawned server child is dead. The provisioning wait blocks the event loop, so
 *  Node cannot reap the child yet and a dead child lingers as a zombie — which `kill(pid, 0)`
 *  still counts as alive. `ps`'s state column sees through that synchronously. */
function childDead(pid: number | undefined): boolean {
  if (pid === undefined) return true; // spawn itself failed (error event is pending)
  try {
    const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: PROBE_MS,
    }).trim();
    return state === "" || state.startsWith("Z");
  } catch {
    return true; // ps errors for a nonexistent pid
  }
}

/** Ensure the named session's headless server is up, starting one when absent (the herdr
 *  analog of tmux's auto-created detached session). Fails loud if it doesn't come up — a dead
 *  or wedged start throws WITH the server's own stderr, and the swallowed `error` event means
 *  a spawn failure can never surface as an uncaught exception in the caller later. */
export function ensureServer(session: string): void {
  if (serverRunning(session)) return;
  const dir = mkdtempSync(join(tmpdir(), "cotal-herdr-srv-"));
  const logPath = join(dir, "server.log");
  const logFd = openSync(logPath, "a");
  const child = spawn("herdr", ["--session", session, "server"], {
    detached: true,
    stdio: ["ignore", "ignore", logFd],
  });
  // A spawn failure (e.g. ENOENT) is delivered as an async "error" event once the event loop
  // resumes — after this function has already thrown via childDead. Swallow it here so it can
  // never crash the manager as an unhandled ChildProcess error.
  child.on("error", () => {});
  const finish = (): void => {
    try {
      closeSync(logFd);
    } catch {
      /* already closed */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the child holds its own fd; unlinking is safe regardless */
    }
  };
  const fail = (why: string): never => {
    let log = "";
    try {
      log = readFileSync(logPath, "utf8").trim();
    } catch {
      /* no log captured */
    }
    finish();
    throw new Error(
      `herdr: server for session "${session}" ${why}` +
        (log ? ` - server said: ${log.split("\n").slice(-5).join(" | ")}` : "") +
        ` - check \`herdr --session ${session} status\``,
    );
  };
  const deadline = Date.now() + SERVER_START_WAIT_MS;
  while (Date.now() < deadline) {
    sleepSync(SERVER_START_POLL_MS);
    if (serverRunning(session)) {
      finish();
      child.unref();
      return;
    }
    if (childDead(child.pid)) fail("failed to start");
  }
  // A wedged half-start must not linger: kill it so the next attempt provisions fresh.
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  fail(`did not come up within ${SERVER_START_WAIT_MS}ms`);
}

/** Start `argv` as a named herdr agent pane in `session` and return its stable refs. */
export function agentStart(
  session: string,
  name: string,
  cwd: string,
  argv: string[],
): HerdrAgent {
  const result = run(session, ["agent", "start", name, "--cwd", cwd, "--no-focus", "--", ...argv]);
  const agent = result.agent;
  if (!agent || typeof agent !== "object") throw new Error(`herdr: agent start returned no agent (${JSON.stringify(result)})`);
  return parseAgent(agent as Record<string, unknown>);
}

/** The CURRENT record for a terminal id, or undefined when it is gone. Only the exact
 *  gone-terminal code ({@link isAgentGone}) maps to undefined; every other failure (socket,
 *  protocol, permission, any other not-found) throws — uncertainty must never read as gone. */
export function agentInfo(session: string, terminalId: string): HerdrAgent | undefined {
  let result: Record<string, unknown>;
  try {
    result = run(session, ["agent", "get", terminalId]);
  } catch (err) {
    if (isAgentGone(err)) return undefined;
    throw err;
  }
  const agent = result.agent;
  if (!agent || typeof agent !== "object") throw new Error(`herdr: agent get returned no agent (${JSON.stringify(result)})`);
  return parseAgent(agent as Record<string, unknown>);
}

export type TerminalState = "running" | "exited";

/** Authoritative liveness for a terminal id: ONLY a successful full pane inventory that no
 *  longer contains it proves exit (herdr closes a pane when its command exits). Every failed
 *  inventory — including an absent/refused session socket, which may be a transient server
 *  restart or a permission problem — throws rather than report a false exit. */
export function terminalState(session: string, terminalId: string): TerminalState {
  let result: Record<string, unknown>;
  try {
    result = run(session, ["pane", "list"]);
  } catch (err) {
    if (err instanceof HerdrCliError) throw err;
    throw new Error(`herdr: couldn't prove terminal ${terminalId} exited: ${(err as Error).message}`, { cause: err });
  }
  const panes = result.panes;
  if (!Array.isArray(panes)) throw new Error(`herdr: malformed pane list (${JSON.stringify(result)})`);
  for (const pane of panes) {
    if (pane && typeof pane === "object" && (pane as Record<string, unknown>).terminal_id === terminalId)
      return "running";
  }
  return "exited";
}

/** Bounded polling over the authoritative pane inventory. */
export async function waitForTerminalExit(
  session: string,
  terminalId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? EXIT_WAIT_MS;
  const pollMs = opts.pollMs ?? EXIT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (terminalState(session, terminalId) === "exited") return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`herdr: terminal ${terminalId} did not exit within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
}

/** Type literal text into an agent terminal (targeted by stable terminal id). */
export function sendText(session: string, terminalId: string, text: string): void {
  run(session, ["agent", "send", terminalId, text]);
}

/** Send a named key (e.g. `enter`, `ctrl+c`) to a pane. Pane-scoped: the caller must pass a
 *  freshly re-resolved pane id ({@link agentInfo}), never a cached one. */
export function sendKeys(session: string, paneId: string, key: string): void {
  run(session, ["pane", "send-keys", paneId, key], { void: true });
}

/** Close a pane. Idempotent for an already-gone pane only; every other error propagates. */
export function closePane(session: string, paneId: string): void {
  try {
    run(session, ["pane", "close", paneId]);
  } catch (err) {
    if (err instanceof HerdrCliError && err.code === "pane_not_found") return;
    throw err;
  }
}

/** Attach Cotal identity to a pane as display metadata tokens (visible in herdr's pane/agent
 *  UI). Values ride argv — never a shell — so no quoting/injection surface. */
export function reportMetadata(
  session: string,
  paneId: string,
  source: string,
  tokens: Record<string, string>,
): void {
  const args = ["pane", "report-metadata", paneId, "--source", source];
  for (const [key, value] of Object.entries(tokens)) {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key))
      throw new Error(`herdr: refusing to render unsafe metadata token name ${JSON.stringify(key)}`);
    args.push("--token", `${key}=${value}`);
  }
  run(session, args, { void: true });
}

/** Stop the named session's server (used by teardown/smoke; production sessions stay up —
 *  that persistence is the point of the runtime). */
export function stopSession(session: string): void {
  try {
    execFileSync("herdr", ["session", "stop", session], { stdio: "ignore", timeout: PROBE_MS });
  } catch {
    /* already stopped */
  }
}
