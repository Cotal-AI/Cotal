import { findCommand, type FlagValues, type ParsedArgs } from "@cotal-ai/core";
import { cachedUpdateSummary, CommandFailure, globalConfigDirProblem, jsonFlag, paintFor, writeResult } from "@cotal-ai/workspace";
import { commandSurface } from "../ext-loader.js";
import { printCommandList, printHelpPath } from "../help.js";
import { unknownCommandMessage } from "../lib/nearest-word.js";
import { findServicePreset, servicePresetCommand } from "../lib/service-presets.js";
import { cliVersion, printVersion, readExtensionVersions } from "../lib/version.js";
import { managerServiceCommand } from "./manager-service.js";
import { manifestRepair, readUpdatePending } from "../lib/update-pending.js";

/** `--all`, the older way to ask for every command, which help now always lists. It is accepted and
 *  changes nothing, and neither help nor completion offers it. */
export const helpFlags = [{ name: "all", type: "boolean", description: "accepted for scripts written before help listed every command; it changes nothing" }] as const;

/** `cotal help [command…]`: every command, or the help of the command the words name. The words
 *  select a command or alias, then its subcommands before any operands. A manager lifecycle
 *  verb is read as the dispatcher reads it, so its help is the one `--help` prints. */
export async function help(args: ParsedArgs): Promise<void> {
  const [word, ...path] = args.positionals;
  const commands = commandSurface();
  if (word === undefined) return paintFor(process.stdout, () => printCommandList(commands));
  const cmd = findCommand(commands, word);
  if (!cmd || cmd.name.startsWith("__")) throw new CommandFailure("refused", "USAGE_INVALID", unknownCommandMessage(commands, word), { selfContained: true });
  if (cmd.name === "service" && path[0] === "add") {
    let scoped = cmd;
    try { scoped = servicePresetCommand(cmd, path); }
    catch { /* A preset that cannot supply options still shows generic help, as suffix help does. */ }
    return paintFor(process.stdout, () => printHelpPath(scoped, path));
  }
  if (cmd.name === "service" && path[0] === "start" && path[1] !== undefined && findServicePreset(path[1])) {
    let scoped = cmd;
    try { scoped = servicePresetCommand(cmd, path.slice(0, 2)); }
    catch (error) { if (path.length === 2) throw error; }
    return paintFor(process.stdout, () => printHelpPath(scoped, path));
  }
  paintFor(process.stdout, () => printHelpPath(managerServiceCommand(cmd, path)?.cmd ?? cmd, path));
}

export const versionFlags = [jsonFlag] as const;

/** `cotal version [--json]` (also `--version`, `-V`): this binary's version, then each installed
 *  extension's, read from disk. Plain text, since a version line is routinely machine-read, or one
 *  envelope with no target, since it reads only local metadata. */
export async function version(args: ParsedArgs): Promise<void> {
  if ((args.values as FlagValues<typeof versionFlags>).json) {
    const { versions, unreadable } = readExtensionVersions();
    const config = unreadable === undefined ? undefined : globalConfigDirProblem();
    const current = cliVersion();
    const pending = readUpdatePending(current);
    const reconciliation = config && pending.kind === "unreadable" && pending.source === "manifest"
      ? { ...pending, error: config.message, instruction: config.remedy } : pending;
    // An unreadable manifest leaves the extension list unread, so the read is partial rather than an
    // empty complete list.
    writeResult(
      "json",
      {
        command: "version",
        target: null,
        result: { version: current, update: cachedUpdateSummary(current), reconciliation, extensions: versions.map((e) => ({ package: e.pkg, version: e.version })) },
        ...(unreadable === undefined
          ? {}
          : {
              completeness: "partial",
              warnings: [{ code: "EXTENSIONS_UNREADABLE", target: null, message: `the extensions manifest could not be read: ${config?.message ?? unreadable}` }],
              partial: { message: "the installed extensions could not be listed", remedy: config?.remedy ?? manifestRepair },
            }),
      },
      () => ({ sections: [] }),
    );
    return;
  }
  printVersion();
}
