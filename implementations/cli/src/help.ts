/**
 * Help text, rendered from each command's declared specs: the bare entry screen, the grouped command
 * list, and one command's or subcommand's help. Every renderer reads local metadata only: it never
 * connects, writes, seeds or imports an extension.
 */
import { commandUsage, type Command, type Subcommand } from "@cotal-ai/core";
import { getCurrent, readMesh } from "@cotal-ai/workspace";
import { c } from "./ui.js";

/** Display order for the help groups — an explicit ranking, NOT registration order: modules
 *  self-register on import and the dev runner (tsx) doesn't guarantee entry-import evaluation
 *  order, so the daemon surface could otherwise print above Setup. Groups not listed here
 *  (e.g. an extension's custom group) follow, in first-registered order. */
const GROUP_ORDER = ["Setup", "Mesh", "Messaging", "Agents", "Observe", "Extensions", "Manager"];

/** The commands the bare entry screen suggests, in order. */
const ENTRY_COMMANDS = ["setup", "up", "spawn", "ps", "attach", "send", "status"];

/** The title line, built on each call so `--no-color` read after import still applies. */
const title = (): string => `${c.bold("cotal")} - lateral agent coordination over NATS`;

/** A command's name with its aliases, as help lists it. */
function label(cmd: Command | Subcommand): string {
  return [cmd.name, ...(cmd.aliases ?? [])].join(", ");
}

/** Commands help lists: never `__` internals; `hidden` ones only with `all`. */
function listed(commands: readonly Command[], all: boolean): Command[] {
  return commands.filter((cmd) => !cmd.name.startsWith("__") && (all || !cmd.hidden));
}

/** The grouped command list. With `all`, hidden commands are included. */
export function printCommandList(commands: readonly Command[], all: boolean): void {
  const visible = listed(commands, all);
  const groups = new Map<string, Command[]>();
  for (const cmd of visible) {
    const g = cmd.group ?? "Commands";
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(cmd);
  }
  const rank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  const ordered = [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
  const pad = Math.max(...visible.map((cmd) => label(cmd).length));
  let out = `${title()}\n`;
  for (const [group, cmds] of ordered) {
    out += `\n${c.bold(group)}\n`;
    for (const cmd of cmds) out += `  ${label(cmd).padEnd(pad)}  ${c.dim(cmd.summary)}\n`;
  }
  out += `\n${c.dim("Every command also takes --no-color (no ANSI color) and --no-input (never prompt).")}`;
  out += `\n${c.dim("Run `cotal help <command>` for a command's flags.")}`;
  if (!all && listed(commands, true).length > visible.length) out += `\n${c.dim("Run `cotal help --all` to include hidden commands.")}`;
  console.log(out);
}

/** The bare `cotal` screen: the selected space, a few common commands, and where to find the rest.
 *  It reads the local selection only. */
export function printEntry(commands: readonly Command[]): void {
  let out = `${title()}\n\n`;
  const space = getCurrent();
  let recorded = false;
  try {
    recorded = space !== undefined && readMesh(space) !== undefined;
  } catch {
    recorded = false;
  }
  if (space === undefined) out += `No space is selected. Run ${c.cyan("cotal setup")} to prepare one.\n`;
  else if (!recorded) out += `Selected space: ${c.bold(space)} ${c.dim("(not recorded on this machine)")}\n`;
  else out += `Selected space: ${c.bold(space)}\n`;
  const common = ENTRY_COMMANDS.map((name) => commands.find((cmd) => cmd.name === name)).filter((cmd): cmd is Command => cmd !== undefined);
  if (common.length) {
    const pad = Math.max(...common.map((cmd) => cmd.name.length));
    out += `\n${c.bold("Common commands")}\n`;
    for (const cmd of common) out += `  ${cmd.name.padEnd(pad)}  ${c.dim(cmd.summary.split(" - ")[0]!)}\n`;
  }
  out += `\n${c.dim("Run `cotal help` for every command, `cotal help <command>` for one.")}`;
  console.log(out);
}

/** One command's help, or one subcommand's when `sub` is given: summary, usage, aliases,
 *  subcommands, flags, structured outputs and examples, all from the declared specs. Each line goes
 *  to `out`, which a usage refusal points at stderr. */
export function printCommandHelp(cmd: Command, sub?: Subcommand, out: (line: string) => void = console.log): void {
  const path = sub ? `${cmd.name} ${sub.name}` : cmd.name;
  out(`${c.bold(`cotal ${path}`)} - ${(sub ?? cmd).summary}`);
  out(c.dim(`usage: ${sub ? (sub.usage ?? `cotal ${path}`) : commandUsage(cmd)}`));
  const aliases = (sub ?? cmd).aliases ?? [];
  if (aliases.length) out(c.dim(`aliases: ${aliases.join(", ")}`));
  const subs = (sub ? [] : (cmd.subcommands ?? [])).filter((s) => !s.hidden);
  if (subs.length) {
    const pad = Math.max(...subs.map((s) => label(s).length));
    out(c.bold("subcommands:"));
    for (const s of subs) out(`  ${label(s).padEnd(pad)}  ${c.dim(s.summary)}`);
  }
  const flags = cmd.flags ?? [];
  if (flags.length) {
    const left = flags.map((f) => {
      const metavar = f.type === "string" ? ` ${f.value ?? "<value>"}` : "";
      return `${f.short ? `-${f.short}, ` : "    "}--${f.name}${metavar}`;
    });
    const pad = Math.max(...left.map((s) => s.length));
    out(c.bold("flags:"));
    flags.forEach((f, i) => out(`  ${left[i]!.padEnd(pad)}  ${c.dim(f.description ?? "")}`));
  }
  const outputs = (sub ?? cmd).outputs ?? [];
  if (outputs.length) out(c.dim(`structured output: ${outputs.join(", ")}`));
  const examples = (sub ?? cmd).examples ?? [];
  if (examples.length) {
    out(c.bold("examples:"));
    for (const example of examples) out(`  ${example}`);
  }
}
