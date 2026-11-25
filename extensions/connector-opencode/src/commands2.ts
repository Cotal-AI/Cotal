/**
 * The OpenCode 2.x dispatcher on the `agent` endpoint (SPEC 13.22): its commands and skills,
 * interrupt, the owner's turns with images, and usage. A turn goes out as a prompt, each image a file
 * attached by its data URL, and `usage` reads the session and its last model step the way T3 Code's
 * OpenCode 2 provider does, as measured on 2.0.24.
 */
import { CommandRefused, type AgentTurn, type AgentUsage, type CommandDispatcher } from "@cotal-ai/connector-core";
import type { CommandEntry, CommandTarget } from "@cotal-ai/core";
import { RECONNECT_COMMAND } from "./reconnect-command.js";
import { COMMAND_ROUTES, LISTS_LOAD_MS, readCommandLists } from "./command-routes.js";
import { OpenCodeHttpError, type OpenCodeApi } from "./opencode2-http.js";

const isReconnect = (c: { target: CommandTarget; name: string }) => c.target === "command" && c.name === RECONNECT_COMMAND.name;

async function readLists(opencodeApi: OpenCodeApi): Promise<CommandEntry[]> {
  // The launch's own `/reconnect` runs only at the agent's terminal (reconnect-command.ts).
  return (await readCommandLists((path) => opencodeApi(path))).filter((e) => !isReconnect(e));
}

/** A record of the session's message list, as far as `usage` reads it. An assistant record is one
 *  model step. */
interface StepRecord {
  type?: unknown;
  model?: { id?: unknown; providerID?: unknown };
  tokens?: { input: number; output: number; cache: { read: number; write: number } };
}

export interface Commands2Deps {
  api: OpenCodeApi;
  /** The owned session, created first when there is none yet. */
  ensureSession(): Promise<string | undefined>;
  /** The owned session, or undefined before there is one. */
  session(): string | undefined;
  /** The `system` field of the first turn the plugin submits, or undefined once one went out. */
  firstTurnSystem(): string | undefined;
  /** A turn carrying the first-turn `system` field went out. */
  primed(): void;
  /** Aborted when teardown begins. */
  signal: AbortSignal;
}

export interface Commands2 {
  readonly dispatcher: CommandDispatcher;
  /** Each event the plugin's event loop reads: a list's `loaded` event ends the first list's wait. */
  event(type: string): void;
}

export function opencode2Commands(deps: Commands2Deps): Commands2 {
  // Each model's context window. A window does not change while the server runs.
  const windows = new Map<string, number | undefined>();

  /** The owner's words as the user's own prompt. The route answers once OpenCode stored it. */
  async function turn({ text, images }: AgentTurn): Promise<void> {
    const id = await deps.ensureSession();
    if (!id) throw new CommandRefused("failed-precondition", "this agent has no OpenCode session yet");
    const system = deps.firstTurnSystem();
    const files = images.map(({ mimeType, data }) => ({ uri: `data:${mimeType};base64,${data}` }));
    try {
      await deps.api(
        `/api/session/${encodeURIComponent(id)}/prompt`,
        { method: "POST", body: JSON.stringify({ text, ...(files.length ? { files } : {}), ...(system ? { system } : {}) }) },
        10_000,
      );
    } catch (e) {
      if (e instanceof OpenCodeHttpError && e.status >= 400 && e.status < 500) throw new CommandRefused("failed-precondition", e.message);
      throw e;
    }
    if (system) deps.primed();
  }

  /** The window T3 Code shows: the model's input limit, else its context limit. */
  async function windowOf(providerID: unknown, modelID: unknown): Promise<number | undefined> {
    const key = `${String(providerID)}/${String(modelID)}`;
    if (windows.has(key)) return windows.get(key);
    const data = (await deps.api<{ data?: unknown } | undefined>("/api/model", undefined, 30_000))?.data;
    if (!Array.isArray(data)) throw new Error("OpenCode answered /api/model with no data list");
    const entry = (data as { providerID?: unknown; modelID?: unknown; limit?: { input?: unknown; context?: unknown } }[])
      .find((m) => m.providerID === providerID && m.modelID === modelID);
    const size = [entry?.limit?.input, entry?.limit?.context].find((n): n is number => typeof n === "number" && n > 0);
    windows.set(key, size);
    return size;
  }

  /** The context the next request starts from, as the last step's prompt plus its output, and the
   *  session's cost once it is above zero. */
  async function usage(): Promise<AgentUsage> {
    const id = deps.session();
    if (!id) return {};
    const path = `/api/session/${encodeURIComponent(id)}`;
    const [info, page] = await Promise.all([
      deps.api<{ data?: { cost?: unknown } } | undefined>(path, undefined, 30_000),
      deps.api<{ data?: unknown } | undefined>(`${path}/message?limit=200&order=desc`, undefined, 30_000),
    ]);
    if (!Array.isArray(page?.data)) throw new Error("OpenCode answered the session's messages with no data list");
    const step = (page.data as StepRecord[]).find((r) => r.type === "assistant" && typeof r.tokens?.input === "number");
    const size = step ? await windowOf(step.model?.providerID, step.model?.id) : undefined;
    const cost = info?.data?.cost;
    return {
      ...(step?.tokens && size ? { context: { used: step.tokens.input + step.tokens.cache.read + step.tokens.cache.write + step.tokens.output, size } } : {}),
      ...(typeof cost === "number" && cost > 0 ? { cost: { amount: cost, currency: "USD" } } : {}),
    };
  }

  // The `loaded` events still to come, set from the event loop, and the one bounded wait for them.
  const listsLoading = new Set(Object.values(COMMAND_ROUTES).map((r) => r.loaded));
  let markListsLoaded!: () => void;
  const listsLoaded = new Promise<void>((resolve) => { markListsLoaded = resolve; });
  let listsWait: Promise<void> | undefined;
  const dispatcher: CommandDispatcher = {
    targets: new Set(Object.keys(COMMAND_ROUTES) as CommandTarget[]),
    async list() {
      const loaded = listsLoading.size === 0;
      const first = await readLists(deps.api);
      if (loaded) return first;
      await (listsWait ??= new Promise<void>((resolve) => {
        const late = setTimeout(resolve, LISTS_LOAD_MS);
        void listsLoaded.then(() => { clearTimeout(late); resolve(); });
      }).then(() => listsLoading.clear()));
      return readLists(deps.api);
    },
    async dispatch(command) {
      if (isReconnect(command))
        throw new CommandRefused("failed-precondition", `/${RECONNECT_COMMAND.name} recovers this agent's own mesh link and runs only at its terminal`);
      const id = await deps.ensureSession();
      if (!id) throw new CommandRefused("failed-precondition", "this agent has no OpenCode session yet");
      const system = deps.firstTurnSystem();
      const [path, body] = COMMAND_ROUTES[command.target].run(command.name, command.args);
      try {
        // No client timeout: OpenCode answers only once the template's shell snippets finish, and a
        // client that leaves first cancels the command (measured on 2.2.5).
        await deps.api(`/api/session/${encodeURIComponent(id)}/${path}`, {
          method: "POST",
          body: JSON.stringify({ ...body, ...(system ? { system } : {}) }),
          signal: deps.signal,
        });
      } catch (e) {
        // Measured on OpenCode 2.2.5: an unknown command answers a 404 `CommandNotFoundError` and an
        // unknown skill a 400 `InvalidRequestError` whose field is `skills`; any 4xx refuses before the
        // turn starts.
        if (!(e instanceof OpenCodeHttpError) || e.status < 400 || e.status >= 500) throw e;
        const unknown = (e.status === 404 && e.tag === "CommandNotFoundError") || (e.status === 400 && e.tag === "InvalidRequestError" && e.field === "skills");
        if (unknown) throw new CommandRefused("not-found", `OpenCode has no ${command.target} named "${command.name}"`);
        throw new CommandRefused("failed-precondition", e.message);
      }
      if (system) deps.primed();
    },
    // Measured on OpenCode 2.2.5: the route answers `{ interrupted }`, false when no execution ran, and
    // a stopped execution ends as `session.execution.interrupted`, which completes the turn in plugin2.ts. Without
    // `resume`, OpenCode resumes nothing of its own, so the next queued command runs next.
    async interrupt() {
      const sessionID = deps.session();
      if (!sessionID) return "idle"; // no session yet, so no turn of ours runs
      const r = await deps.api<{ interrupted?: unknown } | undefined>(`/api/session/${encodeURIComponent(sessionID)}/interrupt`, { method: "POST" });
      if (typeof r?.interrupted !== "boolean") throw new Error("OpenCode answered /interrupt with no interrupted flag");
      return r.interrupted ? "interrupted" : "idle";
    },
    turn,
    images: true,
    usage,
  };
  return {
    dispatcher,
    event(type) {
      if (listsLoading.delete(type) && listsLoading.size === 0) markListsLoaded();
    },
  };
}
