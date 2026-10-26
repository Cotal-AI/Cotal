import { registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import { servicePresetCommand } from "../lib/service-presets.js";
import { service } from "./service-registry.js";

/** The manager group's lifecycle verbs. Each is `service <verb> manager`. */
export const MANAGER_LIFECYCLE = ["start", "stop", "restart", "status", "logs", "install", "uninstall"] as const;

const usage: Record<(typeof MANAGER_LIFECYCLE)[number], string> = {
  start: "cotal manager start [--runtime <name>] [--roster <file>] [--name <name>] [--foreground|--dry-run] [--space <s>]",
  stop: "cotal manager stop [--with-agents] [--yes|--dry-run] [--space <s>]",
  restart: "cotal manager restart [--with-agents] [--yes|--dry-run] [--space <s>]",
  status: "cotal manager status [--space <s>]",
  logs: "cotal manager logs [--tail <n>] [--follow] [--space <s>]",
  install: "cotal manager install [--dry-run] [--space <s>]",
  uninstall: "cotal manager uninstall [--yes|--dry-run] [--space <s>]",
};

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
 *  with that preset's flags and run under the manager's name. Undefined for the group's other words,
 *  which the manager group answers itself. */
export function managerServiceCommand(manager: Command, argv: readonly string[]): { cmd: Command; argv: string[] } | undefined {
  if (manager.name !== "manager") return undefined;
  const base = registry.resolve<Command>("command", "service");
  const at = verbAt(base, argv);
  const verb = at < 0 ? undefined : argv[at] as (typeof MANAGER_LIFECYCLE)[number];
  if (!verb || !(MANAGER_LIFECYCLE as readonly string[]).includes(verb)) return undefined;
  const rest = argv.filter((_, index) => index !== at);
  const augmented = servicePresetCommand({ ...base, run: (args) => service(args, "manager") }, [verb, "manager", ...rest]);
  const cmd: Command = {
    ...augmented, name: "manager", aliases: manager.aliases, group: manager.group, summary: manager.summary,
    usage: usage[verb], positionals: "<start | stop | restart | status | logs | install | uninstall>",
    subcommands: augmented.subcommands?.filter((sub) => sub.name === verb).map((sub) => ({ ...sub, usage: usage[verb], flagNames: sub.flagNames?.filter((flag) => flag !== "file" && flag !== "preset" && flag !== "new-instance") })),
    validate: (args) => augmented.validate?.(withName(args)),
    run: (args) => augmented.run(withName(args)),
  };
  return { cmd, argv: [verb, ...rest] };
}
