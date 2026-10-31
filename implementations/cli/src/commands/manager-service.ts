import { findSubcommand, registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import { servicePresetCommand } from "../lib/service-presets.js";
import { service } from "./service-registry.js";

/** The manager group's lifecycle verbs. Each is `service <verb> manager`. */
export const MANAGER_LIFECYCLE = ["start", "stop", "restart", "status", "logs", "install", "uninstall"] as const;

/** The first word of `argv` that is not a flag or a flag's value, and where it is. */
function verbAt(cmd: Command, argv: readonly string[]): number {
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]!;
    if (word === "--") return index + 1 < argv.length ? index + 1 : -1;
    if (!word.startsWith("-")) return index;
    const flag = cmd.flags?.find((flag) => word === `--${flag.name}` || flag.short && word === `-${flag.short}`);
    if (flag?.type === "string") index++;
  }
  return -1;
}

const withName = (args: ParsedArgs): ParsedArgs => ({ ...args, positionals: [args.positionals[0]!, "manager", ...args.positionals.slice(1)] });

/** `cotal manager <verb>` for a lifecycle verb: the service command for the manager preset, parsed
 *  with that preset's flags and run under the manager's name. Its help is the verb's own summary,
 *  usage and examples, as the manager group declares them, with the options that parser takes; both
 *  `manager <verb> --help` and `help manager <verb>` print it. Undefined for the group's other words,
 *  which the manager group answers itself. */
export function managerServiceCommand(manager: Command, argv: readonly string[]): { cmd: Command; argv: string[] } | undefined {
  if (manager.name !== "manager") return undefined;
  const base = registry.resolve<Command>("command", "service");
  const at = verbAt(base, argv);
  const verb = at < 0 ? undefined : argv[at] as (typeof MANAGER_LIFECYCLE)[number];
  if (!verb || !(MANAGER_LIFECYCLE as readonly string[]).includes(verb)) return undefined;
  const declared = findSubcommand(manager, verb);
  if (!declared) throw new Error(`the manager group does not declare ${verb}`);
  const rest = argv.filter((_, index) => index !== at);
  const augmented = servicePresetCommand({ ...base, run: (args) => service(args, "manager") }, [verb, "manager", ...rest]);
  const cmd: Command = {
    ...augmented, name: "manager", aliases: manager.aliases, group: manager.group, summary: manager.summary,
    usage: declared.usage, positionals: "<start | stop | restart | status | logs | install | uninstall>",
    subcommands: augmented.subcommands?.filter((sub) => sub.name === verb).map((sub) => ({ ...sub, summary: declared.summary, usage: declared.usage, examples: declared.examples, flagNames: sub.flagNames?.filter((flag) => flag !== "file" && flag !== "preset" && flag !== "new-instance") })),
    validate: (args) => augmented.validate?.(withName(args)),
    run: (args) => augmented.run(withName(args)),
  };
  return { cmd, argv: [verb, ...rest] };
}
