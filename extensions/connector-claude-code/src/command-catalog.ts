/**
 * The commands a Claude Code seat started in a directory would run, read before any seat exists from
 * a headless `claude` run there. Its `initialize` answer lists the session's commands and skills, and
 * marks Claude's own with `builtin`. The command mod's policy then drops what a remote request may
 * not run, so the list matches what the seat's `commands` would answer. MCP prompts are missing,
 * because the read starts no MCP server.
 */
import type { CommandCatalog, CommandEntry, CommandListOpts } from "@cotal-ai/core";
import { refusal } from "../hooks/commands.js";
import { claudeInitialize } from "./claude-initialize.js";
import { claudeFloorRefusal } from "./command-feed.js";

interface ClaudeCommand {
  name?: unknown;
  description?: unknown;
  argumentHint?: unknown;
  builtin?: unknown;
}

const nonEmpty = (text: unknown): text is string => typeof text === "string" && text !== "";

function entries(rows: unknown): CommandEntry[] {
  if (!Array.isArray(rows)) throw new Error("claude answered without a command list");
  const listed = rows.map((row: ClaudeCommand | null) => {
    const { name, description, argumentHint, builtin } = row ?? {};
    if (typeof name !== "string") throw new Error("claude listed a command with no name");
    return { name, source: builtin === true ? "builtin" : "user", description, argumentHint };
  });
  // Claude's list does not say which entries are skills, so each is a command, as the seat lists it.
  return listed.filter((c) => refusal(listed, c.name) === undefined).map((c) => ({
    name: c.name,
    target: "command" as const,
    ...(nonEmpty(c.description) ? { description: c.description } : {}),
    ...(nonEmpty(c.argumentHint) ? { inputHint: c.argumentHint } : {}),
  }));
}

/** `env` is the environment a seat's `claude` gets, so the list comes from the same configuration. */
export async function claudeCommandCatalog(opts: CommandListOpts, env: Record<string, string>): Promise<CommandCatalog> {
  const bin = opts.resolvedBinaries?.claude ?? "claude";
  const answer = await claudeInitialize({ bin, cwd: opts.cwd, env, boundMs: 10_000, what: "its commands" });
  if ("failed" in answer) throw new Error(answer.failed);
  const version = answer.response.claude_code_version;
  if (typeof version !== "string") throw new Error("claude answered without its version");
  const tooOld = claudeFloorRefusal(version);
  if (tooOld) return { supported: false, reason: `${tooOld}, so its seats run no agent commands` };
  return { supported: true, commands: entries(answer.response.commands) };
}
