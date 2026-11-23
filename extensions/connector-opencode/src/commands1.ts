/**
 * The OpenCode 1.x commands and skills on the `agent` endpoint (SPEC 13.22), as measured on 1.19.6.
 * `GET /command` lists both, a skill with `source: "skill"`, and `POST /session/:id/command` runs
 * either by name. That route answers only once the turn it started has ended, so a dispatch resolves
 * at the `command.execute.before` hook, which OpenCode calls right before it submits the command's
 * prompt.
 */
import { CommandRefused, type CommandDispatcher } from "@cotal-ai/connector-core";
import type { CommandEntry, CommandTarget } from "@cotal-ai/core";
import { RECONNECT_COMMAND } from "./reconnect-command.js";

export interface Commands1Deps {
  /** The plugin's OpenCode HTTP client. An answer that is not 2xx throws an Error with its `status`. */
  api<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T>;
  /** The owned session, created first when there is none yet. */
  ensureSession(): Promise<string | undefined>;
  /** The session a turn runs in now, the connector's or its user's, or undefined while none runs. */
  running(): string | undefined;
  /** Record that the next end of the turn in `session` is a stop someone asked for. */
  markInterrupt(session: string): void;
  warn(message: string): void;
}

export interface Commands1 {
  readonly dispatcher: CommandDispatcher;
  /** The `command.execute.before` hook: OpenCode is about to submit a command's prompt. */
  starting(sessionID: string, command: string): void;
  /** Teardown began: stop waiting on a command's answer. */
  close(): void;
}

const isReconnect = (c: { target: CommandTarget; name: string }) => c.target === "command" && c.name === RECONNECT_COMMAND.name;

function entryOf(e: unknown): CommandEntry {
  const entry = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
  if (typeof entry.name !== "string") throw new Error("OpenCode listed a command with no name at /command");
  const target: CommandTarget = entry.source === "skill" ? "skill" : "command";
  return { name: entry.name, target, ...(typeof entry.description === "string" ? { description: entry.description } : {}) };
}

export function opencode1Commands(deps: Commands1Deps): Commands1 {
  const controller = new AbortController();
  // The dispatch waiting for its command's turn to start. The agent dispatches one command at a time.
  let waiting: { session: string; name: string; start(): void } | undefined;

  async function list(): Promise<CommandEntry[]> {
    const data = await deps.api<unknown>("/command");
    if (!Array.isArray(data)) throw new Error("OpenCode answered /command with no list");
    // The launch's own `/reconnect` runs only at the agent's terminal (reconnect-command.ts).
    return data.map(entryOf).filter((e) => !isReconnect(e));
  }

  async function dispatch(command: { target: CommandTarget; name: string; args: string }): Promise<void> {
    if (isReconnect(command))
      throw new CommandRefused("failed-precondition", `/${RECONNECT_COMMAND.name} recovers this agent's own mesh link and runs only at its terminal`);
    // OpenCode answers an unknown name with a 500, after it published a session error, so the list
    // decides first.
    if (!(await list()).some((e) => e.target === command.target && e.name === command.name))
      throw new CommandRefused("not-found", `OpenCode has no ${command.target} named "${command.name}"`);
    const session = await deps.ensureSession();
    if (!session) throw new CommandRefused("failed-precondition", "this agent has no OpenCode session yet");
    const started = new Promise<void>((start) => { waiting = { session, name: command.name, start }; });
    // No client timeout: the command's shell snippets run before its turn starts, and the answer
    // comes only once that turn ended.
    const answer = deps.api(`/session/${encodeURIComponent(session)}/command`, {
      method: "POST",
      body: JSON.stringify({ command: command.name, arguments: command.args }),
      signal: controller.signal,
    });
    try {
      await Promise.race([started, answer]);
    } catch (e) {
      // An error answer before the hook means OpenCode never submitted the prompt, so no turn started.
      if (typeof (e as { status?: unknown }).status === "number") throw new CommandRefused("failed-precondition", (e as Error).message);
      throw e;
    } finally {
      waiting = undefined;
    }
    answer.catch((e: Error) => deps.warn(`the ${command.target} "${command.name}" ended with ${e.message}`));
  }

  const dispatcher: CommandDispatcher = {
    targets: new Set<CommandTarget>(["command", "skill"]),
    list,
    dispatch,
    // Measured on 1.19.6: the route answers true whether or not a turn ran, so the plugin's own turn
    // state says whether one runs. The stopped turn ends with a `MessageAbortedError`.
    async interrupt() {
      const session = deps.running();
      if (!session) return "idle";
      deps.markInterrupt(session);
      const answer = await deps.api<unknown>(`/session/${encodeURIComponent(session)}/abort`, { method: "POST" });
      if (typeof answer !== "boolean") throw new Error("OpenCode answered /abort with no boolean");
      return "interrupted";
    },
  };

  return {
    dispatcher,
    starting(sessionID, command) {
      if (waiting?.session === sessionID && waiting.name === command) waiting.start();
    },
    close: () => controller.abort(),
  };
}
