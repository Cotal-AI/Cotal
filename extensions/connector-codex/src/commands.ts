/**
 * The Codex agent's skills, owner turns and context use on its `agent` endpoint (SPEC 13.22).
 * Codex's app-server lists skills and starts one as a skill in the running thread. It has no method
 * that lists or runs Codex's built-in slash commands or custom prompts, so this dispatcher runs
 * skills only. An owner's turn starts with `turn/start` on the same thread, and `usage` answers
 * what Codex last reported in `thread/tokenUsage/updated`.
 */
import { CommandRefused, type CommandDispatcher } from "@cotal-ai/connector-core";
import type { CommandEntry } from "@cotal-ai/core";
import { AppServerRpcError, type AppServerDriver, type CodexSkill } from "./app-server.js";
import { codexSkillEntries, enabledSkills } from "./skills.js";

type ThreadHost = Pick<AppServerDriver, "listSkills" | "startSkillTurn" | "startTurn" | "interruptTurn" | "contextUsage">;

/** Start a turn. An error answer means Codex refused it; a request it never answered may have
 *  started one. */
async function started(start: () => Promise<void>): Promise<void> {
  try {
    await start();
  } catch (e) {
    if (e instanceof AppServerRpcError) throw new CommandRefused("failed-precondition", e.message);
    throw e;
  }
}

/** `host` is read at each call, because the driver is built after the agent that owns the dispatcher. */
export function codexCommands(host: () => ThreadHost): CommandDispatcher {
  const skills = async (): Promise<Map<string, CodexSkill>> => enabledSkills(await host().listSkills());
  return {
    targets: new Set(["skill"]),
    async list(): Promise<CommandEntry[]> {
      return codexSkillEntries(await host().listSkills());
    },
    async dispatch({ name, args }) {
      let skill: CodexSkill | undefined;
      try {
        skill = (await skills()).get(name);
      } catch (e) {
        throw new CommandRefused("failed-precondition", `Codex did not list its skills: ${(e as Error).message}`);
      }
      if (!skill) throw new CommandRefused("not-found", `Codex has no enabled skill named "${name}"`);
      const found = skill;
      await started(() => host().startSkillTurn(found.name, found.path, args));
    },
    interrupt: () => host().interruptTurn(),
    images: true,
    turn: ({ text, images }) => started(() => host().startTurn(text, images)),
    async usage() {
      const context = host().contextUsage;
      return context ? { context } : {};
    },
  };
}
