import { findCommand, findSubcommand, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { jsonFlag, writeResult } from "@cotal-ai/workspace";
import { commandSurface } from "../ext-loader.js";
import { printCommandHelp, printCommandList } from "../help.js";
import { cliVersion, extensionVersions, readExtensionVersions } from "../lib/version.js";

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

export const versionFlags = [jsonFlag] as const;

/** `cotal version [--json]` (also `--version`, `-V`): this binary's version, then each installed
 *  extension's, read from disk. Plain text, since a version line is routinely machine-read, or one
 *  envelope with no target, since it reads only local metadata. */
export async function version(args: ParsedArgs): Promise<void> {
  if ((args.values as FlagValues<typeof versionFlags>).json) {
    const { versions, unreadable } = readExtensionVersions();
    // An unreadable manifest leaves the extension list unread, so the read is partial rather than an
    // empty complete list.
    writeResult(
      "json",
      {
        command: "version",
        target: null,
        result: { version: cliVersion(), extensions: versions.map((e) => ({ package: e.pkg, version: e.version })) },
        ...(unreadable === undefined
          ? {}
          : {
              completeness: "partial",
              warnings: [{ code: "EXTENSIONS_UNREADABLE", target: null, message: `the extensions manifest could not be read: ${unreadable}` }],
              partial: { message: "the installed extensions could not be listed", remedy: "repair the manifest with `cotal ext seed --repair`" },
            }),
      },
      () => ({ sections: [] }),
    );
    return;
  }
  const exts = extensionVersions();
  const lines = [`cotal-ai ${cliVersion()}`];
  if (exts.length) {
    const pad = Math.max(...exts.map((e) => e.label.length));
    for (const e of exts) lines.push(`  ${e.label.padEnd(pad)}  ${e.version}`);
  }
  console.log(lines.join("\n"));
}
