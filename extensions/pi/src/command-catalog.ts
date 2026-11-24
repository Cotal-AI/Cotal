/**
 * The commands a pi seat started in a directory would run, read before any seat exists from a pi in
 * RPC mode there (`get_commands`). That pi loads the operator's extensions as the seat's does, and
 * trusts the project as a supervised seat does (trust-entry.ts), so the list matches what the seat's
 * `commands` would answer.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { CommandCatalog, CommandListOpts } from "@cotal-ai/core";
import { piCommandEntries, piRunsCommands, type PiCommandInfo } from "./commands.js";
import { askPi } from "./rpc-once.js";

const DIST = new URL(import.meta.url.includes("/dist/") ? "./" : "../dist/", import.meta.url);
const TRUST_ENTRY = fileURLToPath(new URL("trust-entry.js", DIST));
const SOURCES = new Set<unknown>(["extension", "prompt", "skill"]);

function commandInfos(listed: unknown): PiCommandInfo[] {
  if (!Array.isArray(listed)) throw new Error("pi answered get_commands without a command list");
  return listed.map((row: Partial<Record<keyof PiCommandInfo, unknown>> | null) => {
    const { name, description, source } = row ?? {};
    if (typeof name !== "string" || !SOURCES.has(source)) throw new Error("pi listed a command with no name or an unknown source");
    return { name, source: source as PiCommandInfo["source"], ...(typeof description === "string" ? { description } : {}) };
  });
}

/** `env` is the environment a seat's pi gets, so the list comes from the same configuration. */
export async function piCommandCatalog(opts: CommandListOpts, env: Record<string, string>): Promise<CommandCatalog> {
  const bin = opts.resolvedBinaries?.pi ?? "pi";
  const { stdout } = await promisify(execFile)(bin, ["--version"], { env, timeout: 5_000 });
  const version = stdout.trim();
  if (!piRunsCommands(version))
    return { supported: false, reason: `pi ${version} sends an extension's /name to its model as text, so its seats run no agent commands; pi 0.84.2 or later runs them` };
  // `--offline` skips startup network work, such as an OAuth refresh that stopping pi mid-request would lose.
  const answer = await askPi({ bin, args: ["--no-session", "--offline", "--extension", TRUST_ENTRY], cwd: opts.cwd, env, type: "get_commands", boundMs: 10_000 });
  if ("failed" in answer) throw new Error(answer.failed);
  if (answer.reply.success !== true)
    throw new Error(`pi refused get_commands: ${typeof answer.reply.error === "string" ? answer.reply.error : "no reason given"}`);
  return { supported: true, commands: piCommandEntries(commandInfos(answer.reply.data?.commands)) };
}
