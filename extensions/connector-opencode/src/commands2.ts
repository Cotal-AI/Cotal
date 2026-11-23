/**
 * The OpenCode 2.x dispatcher on the `agent` endpoint (SPEC 13.22): its commands and skills, and
 * interrupt.
 */
import { CommandRefused, type CommandDispatcher } from "@cotal-ai/connector-core";
import type { CommandEntry, CommandTarget } from "@cotal-ai/core";
import { RECONNECT_COMMAND } from "./reconnect-command.js";
import { OpenCodeHttpError, type OpenCodeApi } from "./opencode2-http.js";

/** How OpenCode lists and runs each command target, measured on 2.2.5. The field `key` of a listed
 *  entry is the name `run` sends, so a listed name is one a command runs. A built-in skill's `id`
 *  differs from its `name`, and `/prompt` attaches a skill by `id`. `loaded` is the event OpenCode
 *  emits once it loaded the list. */
const COMMAND_ROUTES: Record<CommandTarget, { list: string; loaded: string; key: "name" | "id"; run(name: string, args: string): [path: string, body: Record<string, unknown>] }> = {
  command: { list: "/api/command", loaded: "command.updated", key: "name", run: (name, args) => ["command", { name, text: args }] },
  skill: { list: "/api/skill", loaded: "skill.updated", key: "id", run: (name, args) => ["prompt", { text: args, skills: [{ id: name }] }] },
};

const isReconnect = (c: { target: CommandTarget; name: string }) => c.target === "command" && c.name === RECONNECT_COMMAND.name;

/** How long the first list waits for OpenCode to load the lists. OpenCode loads a location's commands
 *  and skills on the first request for them, answers that request with what it already holds, and
 *  emits each list's `loaded` event once the load ended (measured on 2.2.5). */
const LISTS_LOAD_MS = 3_000;

async function readLists(opencodeApi: OpenCodeApi): Promise<CommandEntry[]> {
  const lists = await Promise.all((Object.keys(COMMAND_ROUTES) as CommandTarget[]).map(async (target) => {
    const { list, key } = COMMAND_ROUTES[target];
    const data = (await opencodeApi<{ data?: unknown } | undefined>(list))?.data;
    if (!Array.isArray(data)) throw new Error(`OpenCode answered ${list} with no data list`);
    return data.map((e: unknown) => {
      const entry = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
      const name = entry[key];
      if (typeof name !== "string") throw new Error(`OpenCode listed a ${target} with no ${key} at ${list}`);
      return { name, target, ...(typeof entry.description === "string" ? { description: entry.description } : {}) };
    });
  }));
  // The launch's own `/reconnect` runs only at the agent's terminal (reconnect-command.ts).
  return lists.flat().filter((e) => !isReconnect(e));
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
  };
  return {
    dispatcher,
    event(type) {
      if (listsLoading.delete(type) && listsLoading.size === 0) markListsLoaded();
    },
  };
}
