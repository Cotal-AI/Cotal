import { execFileSync, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const EXIT_WAIT_MS = 8_000;
const EXIT_POLL_MS = 100;
const PROBE_MS = 2_000;
const RUN_TIMEOUT_MS = 10_000;
const SERVER_START_WAIT_MS = 5_000;
const SERVER_START_POLL_MS = 100;
const RUN_START_WAIT_MS = 5_000;
const RUN_START_POLL_MS = 50;

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

/** Oldest herdr whose CLI contract this driver speaks: `workspace create` + `pane run`, and
 *  `pane send-text`. 0.7.x exposed `agent start --cwd -- argv` and `agent send` instead, which
 *  0.8.0 removed outright — there is no shared subset, so an older herdr is refused rather than
 *  silently half-supported. */
export const MIN_HERDR = [0, 8, 0] as const;

/** `herdr --version` prints e.g. `herdr 0.8.0`. Returns the numeric triple, or undefined when the
 *  output does not carry a parseable version (a fork, a wrapper, a future format change). */
export function parseVersion(out: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

function atLeast(v: readonly [number, number, number], min: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

/** True if a herdr this driver can actually drive is on PATH. Deliberately checks the VERSION and
 *  not merely that the binary executes: a bare `--version` probe reports 0.7.x as available, so the
 *  CLI advertises the runtime as ready and every spawn then dies on `unknown option: --cwd`. An
 *  unparseable version reads as unavailable — uncertainty must not advertise readiness. The session
 *  server is provisioned separately ({@link ensureServer}), like tmux's auto-created sessions. */
export function available(): boolean {
  let out: string;
  try {
    out = execFileSync("herdr", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: PROBE_MS,
    });
  } catch {
    return false;
  }
  const version = parseVersion(out);
  return version !== undefined && atLeast(version, MIN_HERDR);
}

/** The installed herdr version as text, for error messages. Empty when it cannot be determined. */
export function versionText(): string {
  try {
    return execFileSync("herdr", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: PROBE_MS,
    }).trim();
  } catch {
    return "";
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

/** Whether the spawned server child is PROVABLY dead. The provisioning wait blocks the event
 *  loop, so Node cannot reap the child yet and a dead child lingers as a zombie — which
 *  `kill(pid, 0)` still counts as alive; `ps`'s state column sees through that synchronously.
 *  Death is only ever proven by `ps` actually running: a nonzero `ps` exit (it ran, the pid
 *  does not exist) or a zombie/empty state. A `ps` that cannot run at all (Windows, a ps-less
 *  container) proves nothing and reads as "still alive" — early-death detection is a POSIX
 *  fast path; everywhere else the bounded startup window still fails loud with the captured
 *  stderr, never a false "dead" for a healthy starting child. */
function childDead(pid: number | undefined): boolean {
  if (pid === undefined) return true; // spawn itself failed (error event is pending)
  let state: string;
  try {
    state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: PROBE_MS,
    }).trim();
  } catch (err) {
    // exitCode set → ps ran and found no such pid: proof of death. Anything else (ENOENT,
    // spawn failure, timeout) means ps itself failed: no proof, treat as alive.
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" && status !== 0;
  }
  return state === "" || state.startsWith("Z");
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
  // Every exit from the poll below — success, timeout, or a THROW out of serverRunning (which
  // wraps execFileSync with no catch, so a probe timeout or nonzero exit propagates) — must leave
  // the fd closed, the scratch dir gone, and no detached child behind. Without this the throwing
  // path leaked all three AND kept the manager alive on the unreffed child handle.
  let adopted = false; // the server is up and now owns itself
  try {
    const deadline = Date.now() + SERVER_START_WAIT_MS;
    while (Date.now() < deadline) {
      sleepSync(SERVER_START_POLL_MS);
      if (serverRunning(session)) {
        adopted = true;
        child.unref();
        return;
      }
      if (childDead(child.pid)) fail("failed to start");
    }
    fail(`did not come up within ${SERVER_START_WAIT_MS}ms`);
  } finally {
    if (!adopted) {
      // A wedged half-start (or one abandoned by a throw) must not linger: kill it so the next
      // attempt provisions fresh, and so this process is not held open by its handle.
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      child.unref();
    }
    finish();
  }
}

/** POSIX single-quote escaping. `pane run` hands its argument to the pane's interactive SHELL, so
 *  unlike every other call in this driver the command is not argv — each word must be quoted or a
 *  path containing a space, quote, or `$` becomes multiple words or a substitution. */
export function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** True when the pane's foreground process is the command we asked for. The readiness signal for
 *  {@link agentStart}: `pane run` types into a shell, so a successful CLI call proves the keystrokes
 *  were delivered, NOT that the process started. Polling the real process table is the only proof.
 *
 *  Matched on the BASENAME: herdr reports `argv0` as the bare command name (`node`) while the
 *  caller passes an absolute interpreter path (`process.execPath`), so a literal comparison never
 *  matches and every spawn would time out. */
function paneRunning(session: string, paneId: string, command: string): boolean {
  let result: Record<string, unknown>;
  try {
    result = run(session, ["pane", "process-info", "--pane", paneId]);
  } catch {
    return false; // pane may not have settled yet; the caller's deadline decides
  }
  const info = result.process_info as Record<string, unknown> | undefined;
  const procs = info?.foreground_processes;
  if (!Array.isArray(procs)) return false;
  const want = basename(command);
  return procs.some((p) => {
    if (!p || typeof p !== "object") return false;
    const argv0 = (p as Record<string, unknown>).argv0;
    return typeof argv0 === "string" && basename(argv0) === want;
  });
}

/** Start `argv` in its own workspace of `session` and return its stable refs.
 *
 *  herdr 0.8.0 has no "create a pane running this command" primitive: `agent start` attaches a
 *  RECOGNIZED agent kind to an existing pane, `pane split` needs a pane to split from, and a fresh
 *  headless server has no workspace, tab or pane at all. So the bootstrap is `workspace create`
 *  (which yields a workspace + tab + root pane in one call, honouring --cwd) followed by `pane run`
 *  into that root pane. One workspace per agent also gives the name-labeled-tab layout for free.
 *
 *  The command is `exec`'d deliberately: a plain `pane run` leaves the pane's shell alive after the
 *  command exits, so the pane would outlive the agent and {@link terminalState} could never prove an
 *  exit. `exec` replaces the shell, so herdr closes the pane exactly when the agent exits — which is
 *  the property the whole lifecycle design rests on.
 *
 *  Fails loud and leaves nothing behind: if the process does not appear within the readiness window
 *  the half-built workspace is torn down before throwing. */
export function agentStart(
  session: string,
  name: string,
  cwd: string,
  argv: string[],
): HerdrAgent {
  const created = run(session, ["workspace", "create", "--cwd", cwd, "--label", name, "--no-focus"]);
  const rootPane = created.root_pane;
  if (!rootPane || typeof rootPane !== "object")
    throw new Error(`herdr: workspace create returned no root pane (${JSON.stringify(created)})`);
  const agent = parseAgent(rootPane as Record<string, unknown>);

  try {
    // `workspace create --label` names the WORKSPACE; the tab it creates is labeled positionally
    // ("1", "2", …). The tab strip is what an operator actually reads, so name the tab too —
    // otherwise every agent shows up as a number.
    const tabId = (rootPane as Record<string, unknown>).tab_id;
    if (typeof tabId === "string") run(session, ["tab", "rename", tabId, name], { void: true });
    run(session, ["pane", "run", agent.paneId, `exec ${argv.map(shellQuote).join(" ")}`], { void: true });
    const argv0 = argv[0] ?? "";
    const deadline = Date.now() + RUN_START_WAIT_MS;
    let started = false;
    while (Date.now() < deadline) {
      if (paneRunning(session, agent.paneId, argv0)) {
        started = true;
        break;
      }
      // The pane closing before the process ever appeared means the command died instantly
      // (bad interpreter, exec failure) — stop waiting out the window for a corpse.
      if (terminalState(session, agent.terminalId) === "exited")
        throw new Error(`herdr: agent "${name}" exited immediately; its command never started (${argv0})`);
      sleepSync(RUN_START_POLL_MS);
    }
    if (!started)
      throw new Error(
        `herdr: agent "${name}" did not start ${argv0} within ${RUN_START_WAIT_MS}ms - ` +
          `check \`herdr --session ${session} pane read ${agent.paneId}\``,
      );
  } catch (err) {
    try {
      closePane(session, agent.paneId);
    } catch {
      /* best-effort teardown of the half-built workspace */
    }
    throw err;
  }
  return agent;
}

/** The CURRENT record for a terminal id, or undefined when it is gone.
 *
 *  Resolved off the pane inventory rather than `agent get`: in herdr 0.8.0 an "agent" is a
 *  RECOGNIZED KIND (pi, claude, codex, …) attached to a pane, so a pane we started with
 *  {@link agentStart} never appears in the agent registry and `agent get` reports it as gone. The
 *  pane inventory is the only view that sees it, and it is session-wide (`--workspace` merely
 *  narrows), so a pane that moved workspaces is still found.
 *
 *  A failed inventory THROWS rather than reporting undefined — uncertainty must never read as gone,
 *  or a live agent gets torn down as a corpse. */
export function agentInfo(session: string, terminalId: string): HerdrAgent | undefined {
  const result = run(session, ["pane", "list"]);
  const panes = result.panes;
  if (!Array.isArray(panes)) throw new Error(`herdr: malformed pane list (${JSON.stringify(result)})`);
  for (const pane of panes) {
    if (pane && typeof pane === "object" && (pane as Record<string, unknown>).terminal_id === terminalId)
      return parseAgent(pane as Record<string, unknown>);
  }
  return undefined;
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

/** Type literal text into a pane. Pane-scoped: the caller must pass a freshly re-resolved pane id
 *  ({@link agentInfo}), never a cached one. (herdr 0.8.0 removed `agent send`; `pane send-text` is
 *  the replacement, and it is addressed by pane rather than terminal.) */
export function sendText(session: string, paneId: string, text: string): void {
  run(session, ["pane", "send-text", paneId, text], { void: true });
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

/** Every tab in the session, newest last. Used to find a tab to share under the `split` layout. */
export function tabIds(session: string): string[] {
  const result = run(session, ["tab", "list"]);
  const tabs = result.tabs;
  if (!Array.isArray(tabs)) throw new Error(`herdr: malformed tab list (${JSON.stringify(result)})`);
  return tabs
    .map((t) => (t && typeof t === "object" ? (t as Record<string, unknown>).tab_id : undefined))
    .filter((id): id is string => typeof id === "string");
}

/** Move a pane into an EXISTING tab, splitting it, and return the pane's updated record — the
 *  public pane id changes. `terminalId` pins the response: a malformed or wrong-terminal record is
 *  rejected so a bad reply can never make later metadata/cleanup target a different terminal.
 *  Used only by the opt-in `split` layout; the default one-workspace-per-agent layout needs no move
 *  at all, because {@link agentStart} already lands each agent in its own name-labeled tab. */
export function paneMoveIntoTab(session: string, paneId: string, tabId: string, terminalId: string): HerdrAgent {
  const result = run(session, ["pane", "move", paneId, "--tab", tabId, "--split", "down", "--no-focus"]);
  const moved = (result.move_result as Record<string, unknown> | undefined)?.pane;
  if (!moved || typeof moved !== "object")
    throw new Error(`herdr: pane move returned no pane (${JSON.stringify(result)})`);
  const agent = parseAgent(moved as Record<string, unknown>);
  if (agent.terminalId !== terminalId)
    throw new Error(`herdr: pane move returned a different terminal (${agent.terminalId}, expected ${terminalId})`);
  return agent;
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
 *  that persistence is the point of the runtime).
 *
 *  `session stop` takes a POSITIONAL name, not `--session`, so it cannot go through {@link run}.
 *  Only "it was not running" is absorbed, matched on herdr's exact `session_stop_failed` code —
 *  which it reports on stdout with exit 0, so the output has to be read rather than ignored. Every
 *  other structured error (permission, protocol) propagates: a teardown that cannot say it failed
 *  is worse than no teardown, because it reports success either way. */
export function stopSession(session: string): void {
  let out: string;
  try {
    out = execFileSync("herdr", ["session", "stop", session], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: PROBE_MS,
    });
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const structured = parseError(`${String(e.stdout ?? "")}\n${String(e.stderr ?? "")}`);
    if (structured) {
      if (structured.code === "session_stop_failed") return; // not running: the desired end state
      throw structured;
    }
    throw new Error(
      `herdr session stop ${session} failed: ${String(e.stderr ?? "").trim() || String(e.message ?? err)}`,
      { cause: err },
    );
  }
  const structured = parseError(out);
  if (structured && structured.code !== "session_stop_failed") throw structured;
}
