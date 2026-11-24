/**
 * How OpenCode 2.x lists and runs commands and skills at its server: what a seat's dispatcher
 * (commands2.ts) lists and runs, and what the connector lists before launch (command-catalog.ts).
 */
import type { CommandEntry, CommandTarget } from "@cotal-ai/core";

/** How OpenCode lists and runs each command target, measured on 2.2.5. The field `key` of a listed
 *  entry is the name `run` sends, so a listed name is one a command runs. A built-in skill's `id`
 *  differs from its `name`, and `/prompt` attaches a skill by `id`. `loaded` is the event OpenCode
 *  emits once it loaded the list. */
export const COMMAND_ROUTES: Record<CommandTarget, { list: string; loaded: string; key: "name" | "id"; run(name: string, args: string): [path: string, body: Record<string, unknown>] }> = {
  command: { list: "/api/command", loaded: "command.updated", key: "name", run: (name, args) => ["command", { name, text: args }] },
  skill: { list: "/api/skill", loaded: "skill.updated", key: "id", run: (name, args) => ["prompt", { text: args, skills: [{ id: name }] }] },
};

/** How long the first list waits for OpenCode to load the lists. OpenCode loads a location's commands
 *  and skills on the first request for them, answers that request with what it already holds, and
 *  emits each list's `loaded` event once the load ended (measured on 2.2.5). */
export const LISTS_LOAD_MS = 3_000;

/** Every command and skill the server lists now, each named as its route runs it. `get` answers a
 *  server path with the parsed reply. */
export async function readCommandLists(get: (path: string) => Promise<unknown>): Promise<CommandEntry[]> {
  const lists = await Promise.all((Object.keys(COMMAND_ROUTES) as CommandTarget[]).map(async (target) => {
    const { list, key } = COMMAND_ROUTES[target];
    const data = ((await get(list)) as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(data)) throw new Error(`OpenCode answered ${list} with no data list`);
    return data.map((e: unknown) => {
      const entry = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
      const name = entry[key];
      if (typeof name !== "string") throw new Error(`OpenCode listed a ${target} with no ${key} at ${list}`);
      return { name, target, ...(typeof entry.description === "string" ? { description: entry.description } : {}) };
    });
  }));
  return lists.flat();
}
