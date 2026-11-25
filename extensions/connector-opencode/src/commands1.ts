/**
 * The OpenCode 1.x dispatcher on the `agent` endpoint (SPEC 13.22), as measured on 1.19.6.
 * `GET /command` lists commands and skills, a skill with `source: "skill"`, and
 * `POST /session/:id/command` runs either by name. That route answers only once the turn it started
 * has ended, so a dispatch resolves once that turn starts: OpenCode calls the
 * `command.execute.before` hook, stores the command's prompt, and reports the session busy. An
 * owner's turn goes out as a prompt, each image as a file part with a data URL, and `usage` reads
 * the session's messages the way T3 Code's OpenCode provider does. After an owner's `set-model`,
 * every prompt and command names the model and variant they chose (model-switch.ts).
 */
import { CommandRefused, type AgentTurn, type AgentUsage, type CommandDispatcher } from "@cotal-ai/connector-core";
import type { CommandEntry, CommandTarget } from "@cotal-ai/core";
import { RECONNECT_COMMAND } from "./reconnect-command.js";
import { opencode1ModelChoice, type PromptModel1 } from "./model-switch.js";

export interface Commands1Deps {
  /** The plugin's OpenCode HTTP client. An answer that is not 2xx throws an Error with its `status`. */
  api<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T>;
  /** The owned session, created first when there is none yet. */
  ensureSession(): Promise<string | undefined>;
  /** The session a turn runs in now, the connector's or its user's, or undefined while none runs. */
  running(): string | undefined;
  /** Record that the next end of the turn in `session` is a stop someone asked for. */
  markInterrupt(session: string): void;
  /** The `system` field of the first turn the plugin submits, or undefined once one went out. */
  firstTurnSystem(): string | undefined;
  /** A turn carrying the first-turn `system` field went out. */
  primed(): void;
  /** The model and variant the launch pinned on the `cotal` agent, each absent when it pinned none. */
  launch: { model?: string; variant?: string };
  warn(message: string): void;
}

export interface Commands1 {
  readonly dispatcher: CommandDispatcher;
  /** The `command.execute.before` hook: OpenCode is about to store a command's prompt. */
  starting(sessionID: string, command: string): void;
  /** OpenCode reported `session` busy: a turn started in it. */
  turnStarted(sessionID: string): void;
  /** Teardown began: stop waiting on a command's answer. */
  close(): void;
  /** What every prompt the plugin sends names besides its parts. */
  promptModel(): PromptModel1;
}

const isReconnect = (c: { target: CommandTarget; name: string }) => c.target === "command" && c.name === RECONNECT_COMMAND.name;

/** How long a command has to start its turn once its hook ran. OpenCode only stores the prompt in
 *  between (10 ms measured on 1.19.6), and a command that neither starts a turn nor answers leaves
 *  no event that frees the session. */
const TURN_START_MS = 5_000;

interface StepTokens { input: number; output: number; cache: { read: number; write: number } }
interface UsageMessage {
  info: { id: string; role?: unknown; cost?: unknown; providerID?: unknown; modelID?: unknown };
  parts: { type?: unknown; tokens?: StepTokens }[];
}

/** What the session's messages report: the last step's tokens and the model that took it, and the
 *  sum of the assistant messages' cost. The last step is the one in the newest message by id, the
 *  session order agui-source.ts reads, whatever order the list came in: 1.19.6 lists by creation
 *  time. */
function readUsage(messages: UsageMessage[]): { step?: StepTokens; model?: string; cost: number } {
  const out: { step?: StepTokens; model?: string; cost: number } = { cost: 0 };
  for (const { info, parts } of [...messages].sort((a, b) => (a.info.id < b.info.id ? -1 : a.info.id > b.info.id ? 1 : 0))) {
    if (info.role !== "assistant") continue;
    if (typeof info.cost === "number" && Number.isFinite(info.cost)) out.cost += info.cost;
    for (const part of parts) {
      if (part.type !== "step-finish" || typeof part.tokens?.input !== "number") continue;
      out.step = part.tokens;
      out.model = `${String(info.providerID)}/${String(info.modelID)}`;
    }
  }
  return out;
}

function entryOf(e: unknown): CommandEntry {
  const entry = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
  if (typeof entry.name !== "string") throw new Error("OpenCode listed a command with no name at /command");
  const target: CommandTarget = entry.source === "skill" ? "skill" : "command";
  return { name: entry.name, target, ...(typeof entry.description === "string" ? { description: entry.description } : {}) };
}

/** The entries of a `GET /command` answer, as a seat lists them and runs them by name. */
export function opencode1CommandEntries(data: unknown): CommandEntry[] {
  if (!Array.isArray(data)) throw new Error("OpenCode answered /command with no list");
  // The launch's own `/reconnect` runs only at the agent's terminal (reconnect-command.ts).
  return data.map(entryOf).filter((e) => !isReconnect(e));
}

export function opencode1Commands(deps: Commands1Deps): Commands1 {
  const controller = new AbortController();
  // The dispatch waiting for its command's hook and then for its turn. The agent dispatches one
  // command at a time.
  let waiting: { session: string; name: string; hooked: boolean; hook(): void; start(): void } | undefined;
  // Each model's context window. `GET /provider` can be megabytes, and a window does not change.
  const windows = new Map<string, number | undefined>();
  const models = opencode1ModelChoice(deps.api, deps.launch);

  async function list(): Promise<CommandEntry[]> {
    return opencode1CommandEntries(await deps.api<unknown>("/command"));
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
    let hook!: () => void, start!: () => void;
    const hooked = new Promise<void>((resolve) => { hook = resolve; });
    const started = new Promise<void>((resolve) => { start = resolve; });
    waiting = { session, name: command.name, hooked: false, hook, start };
    // No client timeout: the command's shell snippets run before its hook, and the answer comes only
    // once its turn ended.
    const answer = deps.api(`/session/${encodeURIComponent(session)}/command`, {
      method: "POST",
      body: JSON.stringify({ command: command.name, arguments: command.args, ...models.command() }),
      signal: controller.signal,
    });
    const ended = (e: Error) => deps.warn(`the ${command.target} "${command.name}" ended with ${e.message}`);
    let bound: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([hooked, answer]);
      await Promise.race([started, answer, new Promise<never>((_, fail) => {
        bound = setTimeout(() => {
          answer.catch(ended);
          fail(new Error(`OpenCode ran the hook of the ${command.target} "${command.name}" and started no turn within ${TURN_START_MS / 1000} s`));
        }, TURN_START_MS);
      })]);
    } catch (e) {
      // An error answer before the turn started: OpenCode failed before it stored the prompt
      // (measured on 1.19.6), so nothing ran.
      if (typeof (e as { status?: unknown }).status === "number") throw new CommandRefused("failed-precondition", (e as Error).message);
      throw e;
    } finally {
      clearTimeout(bound);
      waiting = undefined;
    }
    answer.catch(ended);
  }

  /** The owner's words as the user's own prompt. `prompt_async` answers once OpenCode took it. */
  async function turn({ text, images }: AgentTurn): Promise<void> {
    const session = await deps.ensureSession();
    if (!session) throw new CommandRefused("failed-precondition", "this agent has no OpenCode session yet");
    const system = deps.firstTurnSystem();
    const parts = [
      ...(text ? [{ type: "text", text }] : []),
      ...images.map(({ mimeType, data }) => ({ type: "file", mime: mimeType, url: `data:${mimeType};base64,${data}` })),
    ];
    try {
      await deps.api(`/session/${encodeURIComponent(session)}/prompt_async`, { method: "POST", body: JSON.stringify({ parts, ...models.prompt(), ...(system ? { system } : {}) }) });
    } catch (e) {
      const status = (e as { status?: unknown }).status;
      if (typeof status === "number" && status >= 400 && status < 500) throw new CommandRefused("failed-precondition", (e as Error).message);
      throw e;
    }
    if (system) deps.primed();
  }

  /** The window T3 Code shows: the model's input limit, else its context limit. */
  async function windowOf(model: string): Promise<number | undefined> {
    if (windows.has(model)) return windows.get(model);
    const all = (await deps.api<{ all?: unknown }>("/provider", undefined, 30_000))?.all;
    if (!Array.isArray(all)) throw new Error("OpenCode answered /provider with no provider list");
    const [providerID, ...rest] = model.split("/");
    const entry = (all as { id?: unknown; models?: Record<string, { limit?: { input?: unknown; context?: unknown } }> }[])
      .find((p) => p.id === providerID)?.models?.[rest.join("/")];
    const size = [entry?.limit?.input, entry?.limit?.context].find((n): n is number => typeof n === "number" && n > 0);
    windows.set(model, size);
    return size;
  }

  /** The context the next request starts from, as the last step's prompt plus its output, and the
   *  session's cost once it is above zero. */
  async function usage(): Promise<AgentUsage> {
    const session = await deps.ensureSession();
    if (!session) return {};
    const messages = await deps.api<UsageMessage[]>(`/session/${encodeURIComponent(session)}/message`, undefined, 30_000);
    if (!Array.isArray(messages)) throw new Error("OpenCode answered the session's messages with no list");
    const { step, model, cost } = readUsage(messages);
    const size = model ? await windowOf(model) : undefined;
    return {
      ...(step && size ? { context: { used: step.input + step.cache.read + step.cache.write + step.output, size } } : {}),
      ...(cost > 0 ? { cost: { amount: cost, currency: "USD" } } : {}),
    };
  }

  const dispatcher: CommandDispatcher = {
    targets: new Set<CommandTarget>(["command", "skill"]),
    list,
    dispatch,
    turn,
    images: true,
    usage,
    setModel: models.setModel,
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
      if (waiting?.session !== sessionID || waiting.name !== command) return;
      waiting.hooked = true;
      waiting.hook();
    },
    turnStarted(sessionID) {
      if (waiting?.hooked && waiting.session === sessionID) waiting.start();
    },
    close: () => controller.abort(),
    promptModel: models.prompt,
  };
}
