/**
 * The Codex agent's skills on its `agent` endpoint (SPEC 13.22). Codex's app-server lists skills and
 * starts one as a skill in the running thread. It has no method that lists or runs Codex's built-in
 * slash commands or custom prompts, so this dispatcher runs skills only.
 */
import { CommandRefused, type CommandDispatcher } from "@cotal-ai/connector-core";
import type { CommandEntry } from "@cotal-ai/core";
import { AppServerRpcError, type AppServerDriver, type CodexSkill } from "./app-server.js";

type SkillHost = Pick<AppServerDriver, "listSkills" | "startSkillTurn" | "interruptTurn">;

/** `host` is read at each call, because the driver is built after the agent that owns the dispatcher. */
export function codexCommands(host: () => SkillHost): CommandDispatcher {
  /** The enabled skills by name. Codex lists a repo skill before a user or system skill of the same
   *  name, so the first entry of a name is the one listed and run. */
  async function skills(): Promise<Map<string, CodexSkill>> {
    const byName = new Map<string, CodexSkill>();
    for (const skill of await host().listSkills()) if (skill.enabled && !byName.has(skill.name)) byName.set(skill.name, skill);
    return byName;
  }
  return {
    targets: new Set(["skill"]),
    async list(): Promise<CommandEntry[]> {
      return [...(await skills()).values()].map((s) => ({ name: s.name, target: "skill", description: s.description }));
    },
    async dispatch({ name, args }) {
      let skill: CodexSkill | undefined;
      try {
        skill = (await skills()).get(name);
      } catch (e) {
        throw new CommandRefused("failed-precondition", `Codex did not list its skills: ${(e as Error).message}`);
      }
      if (!skill) throw new CommandRefused("not-found", `Codex has no enabled skill named "${name}"`);
      try {
        await host().startSkillTurn(skill.name, skill.path, args);
      } catch (e) {
        // An error answer means Codex refused the turn; a request it never answered may have started one.
        if (e instanceof AppServerRpcError) throw new CommandRefused("failed-precondition", e.message);
        throw e;
      }
    },
    interrupt: () => host().interruptTurn(),
  };
}
