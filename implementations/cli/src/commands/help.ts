import { findCommand, findSubcommand, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { commandSurface } from "../ext-loader.js";
import { printCommandHelp, printCommandList } from "../help.js";
import { cliVersion, extensionVersions } from "../lib/version.js";

export const helpFlags = [{ name: "all", type: "boolean", description: "also list hidden commands" }] as const;

/** `cotal help [command…] [--all]`: the command list, or the help of the command the words name.
 *  The words are literal nesting: a command (or its alias), then one of its subcommands. */
export async function help(args: ParsedArgs): Promise<void> {
  const values = args.values as FlagValues<typeof helpFlags>;
  const [word, subWord, ...extra] = args.positionals;
  const commands = commandSurface();
  if (word === undefined) return printCommandList(commands, values.all === true);
  const cmd = findCommand(commands, word);
  if (!cmd || cmd.name.startsWith("__")) throw new Error(`unknown command: ${word} - run \`cotal help\` to list commands`);
  if (subWord === undefined) return printCommandHelp(cmd);
  const sub = findSubcommand(cmd, subWord);
  if (!sub || sub.hidden) throw new Error(`cotal ${cmd.name} has no subcommand "${subWord}" - run \`cotal help ${cmd.name}\``);
  if (extra.length) throw new Error(`cotal ${cmd.name} ${sub.name} has no subcommands - run \`cotal help ${cmd.name} ${sub.name}\``);
  printCommandHelp(cmd, sub);
}

/** `cotal version` (also `--version`, `-V`): this binary's version, then each installed extension's,
 *  read from disk. Plain text, since a version line is routinely machine-read. */
export async function version(): Promise<void> {
  const exts = extensionVersions();
  const lines = [`cotal-ai ${cliVersion()}`];
  if (exts.length) {
    const pad = Math.max(...exts.map((e) => e.label.length));
    for (const e of exts) lines.push(`  ${e.label.padEnd(pad)}  ${e.version}`);
  }
  console.log(lines.join("\n"));
}
