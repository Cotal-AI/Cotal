/**
 * Help text, rendered from each command's declared specs: the bare entry screen, the grouped command
 * list, and one command's or subcommand's help. Every renderer reads local metadata only: it never
 * connects, writes, seeds or imports an extension.
 */
import { commandUsage, type Command, type Subcommand } from "@cotal-ai/core";
import { getCurrent, readMesh, terminalWidth } from "@cotal-ai/workspace";
import { c, hang } from "./ui.js";

/** Display order for the help groups — an explicit ranking, NOT registration order: modules
 *  self-register on import and the dev runner (tsx) doesn't guarantee entry-import evaluation
 *  order, so the daemon surface could otherwise print above Setup. Groups not listed here
 *  (e.g. an extension's custom group) follow, in first-registered order. */
const GROUP_ORDER = ["Setup", "Mesh", "Messaging", "Agents", "Observe", "Extensions", "Manager"];

/** The commands the bare entry screen suggests, in order. */
const ENTRY_COMMANDS = ["setup", "up", "spawn", "ps", "attach", "send", "status"];

/** The title line, built on each call so `--no-color` read after import still applies. */
const title = (): string => `${c.bold("cotal")} - lateral agent coordination over NATS`;

/** A name column and its description. When the names leave the description fewer than 30 columns,
 *  each description goes on the lines under its name instead. */
function describe(names: readonly string[], texts: readonly string[], width: number): string[] {
  const pad = Math.max(...names.map((name) => name.length));
  if (width - pad - 4 >= 30) return names.flatMap((name, i) => hang(`  ${name.padEnd(pad)}  `, texts[i]!, width, c.dim));
  return names.flatMap((name, i) => [`  ${name.trimEnd()}`, ...hang(" ".repeat(10), texts[i]!, width, c.dim)]);
}

/** A usage line's words, each bracketed option with its value kept whole. */
const usageWords = (usage: string): string[] => usage.match(/\[[^\]]*\]|\S+/g) ?? [usage];

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
  const width = terminalWidth(process.stdout);
  let out = `${title()}\n`;
  for (const [group, cmds] of ordered) {
    out += `\n${c.bold(group)}\n`;
    // Padded to the widest name in every group, so the descriptions line up across groups.
    out += `${describe(cmds.map((cmd) => label(cmd).padEnd(pad)), cmds.map((cmd) => cmd.summary), width).join("\n")}\n`;
  }
  const notes = ["Every command also takes --no-color (no ANSI color) and --no-input (never prompt).", "Run `cotal help <command>` for a command's flags."];
  if (!all && listed(commands, true).length > visible.length) notes.push("Run `cotal help --all` to include hidden commands.");
  for (const note of notes) out += `\n${hang("", note, width, c.dim).join("\n")}`;
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
    out += `\n${c.bold("Common commands")}\n`;
    out += `${describe(common.map((cmd) => cmd.name), common.map((cmd) => cmd.summary.split(" - ")[0]!), terminalWidth(process.stdout)).join("\n")}\n`;
  }
  out += `\n${hang("", "Run `cotal help` for every command, `cotal help <command>` for one.", terminalWidth(process.stdout), c.dim).join("\n")}`;
  console.log(out);
}

/** One command's help, or one subcommand's when `sub` is given: summary, usage, aliases,
 *  subcommands, flags, structured outputs and examples, all from the declared specs. Each line goes
 *  to `out`, which a usage refusal points at stderr, wrapped to `width`; examples are never wrapped,
 *  so each stays one line to copy. */
export function printCommandHelp(cmd: Command, sub?: Subcommand, out: (line: string) => void = console.log, width = terminalWidth(process.stdout)): void {
  const path = sub ? `${cmd.name} ${sub.name}` : cmd.name;
  const lines = (many: string[]) => many.forEach((line) => out(line));
  const name = `cotal ${path}`;
  lines(hang(`${name} - `, (sub ?? cmd).summary, width).map((line, i) => (i === 0 ? c.bold(name) + line.slice(name.length) : line)));
  lines(hang("usage: ", usageWords(sub ? (sub.usage ?? `cotal ${path}`) : commandUsage(cmd)), width, c.dim).map((line, i) => (i === 0 ? c.dim(line.slice(0, 7)) + line.slice(7) : line)));
  const aliases = (sub ?? cmd).aliases ?? [];
  if (aliases.length) out(c.dim(`aliases: ${aliases.join(", ")}`));
  const subs = (sub ? [] : (cmd.subcommands ?? [])).filter((s) => !s.hidden);
  if (subs.length) {
    out(c.bold("subcommands:"));
    lines(describe(subs.map(label), subs.map((s) => s.summary), width));
  }
  const flags = cmd.flags ?? [];
  if (flags.length) {
    const left = flags.map((f) => {
      const metavar = f.type === "string" ? ` ${f.value ?? "<value>"}` : "";
      return `${f.short ? `-${f.short}, ` : "    "}--${f.name}${metavar}`;
    });
    out(c.bold("flags:"));
    lines(describe(left, flags.map((f) => f.description ?? ""), width));
  }
  const outputs = (sub ?? cmd).outputs ?? [];
  if (outputs.length) out(c.dim(`structured output: ${outputs.join(", ")}`));
  const examples = (sub ?? cmd).examples ?? [];
  if (examples.length) {
    out(c.bold("examples:"));
    for (const example of examples) out(`  ${example}`);
  }
}
