/**
 * Help text, rendered from each command's declared specs: the bare entry screen, the grouped command
 * list, and one command's or subcommand's help. Every renderer reads local metadata only: it never
 * connects, writes, seeds or imports an extension.
 */
import { commandUsage, findSubcommand, type Command, type Subcommand } from "@cotal-ai/core";
import { cachedPreferences, displayWidth, findPreparedSpace, getCurrent, readMesh, renderReport, resolvePreference, terminalWidth, wrapWords, type Section } from "@cotal-ai/workspace";
import { c, hang } from "./ui.js";

/** Display order for the help groups — an explicit ranking, NOT registration order: modules
 *  self-register on import and the dev runner (tsx) doesn't guarantee entry-import evaluation
 *  order, so the daemon surface could otherwise print above Setup. Groups not listed here
 *  (e.g. an extension's custom group) follow, in first-registered order. */
const GROUP_ORDER = ["Setup", "Mesh", "Messaging", "Agents", "Observe", "Extensions", "Manager"];

/** The title line, built on each call so `--no-color` read after import still applies. */
const title = (): string => `${c.bold("cotal")} - lateral agent coordination over NATS`;

/** A name column and its description. When the names leave the description fewer than 30 columns,
 *  each description goes on the lines under its name instead. */
function describe(names: readonly string[], texts: readonly string[], width: number): string[] {
  const pad = Math.max(...names.map((name) => name.length));
  if (width - pad - 4 >= 30) return names.flatMap((name, i) => hang(`  ${name.padEnd(pad)}  `, texts[i]!, width, c.dim));
  return names.flatMap((name, i) => [`  ${name.trimEnd()}`, ...hang(" ".repeat(10), texts[i]!, width, c.dim)]);
}

/** The brackets, parentheses and angle brackets `word` opens, less those it closes. */
const nesting = (word: string): number => (word.match(/[[(<]/g)?.length ?? 0) - (word.match(/[\])>]/g)?.length ?? 0);

/** Whether `next` stays on `word`'s line: a ` | ` after it, or its argument, which is a `<value>` or
 *  a bare value such as `a,b` after an option. */
function staysWith(word: string, next: string): boolean {
  if (next === "|") return true;
  return word !== "|" && !/[\])>]$/.test(word) && (next.startsWith("<") || (/^[[(]*-/.test(word) && !/^[-[(|]/.test(next)));
}

/** A usage's words cut where its lines may break: at the gaps outside the groups the words share,
 *  except where {@link staysWith} keeps two words together. The gaps after their own ` | `
 *  alternatives come first. None when no gap may break. */
function usageUnits(words: readonly string[]): string[][] | undefined {
  const gaps: { at: number; depth: number; alternative: boolean }[] = [];
  let depth = 0;
  for (let i = 0; i < words.length - 1; i++) {
    depth = Math.max(0, depth + nesting(words[i]!));
    if (!staysWith(words[i]!, words[i + 1]!)) gaps.push({ at: i + 1, depth, alternative: words[i] === "|" });
  }
  if (!gaps.length) return undefined;
  const top = Math.min(...gaps.map((gap) => gap.depth));
  const level = gaps.filter((gap) => gap.depth === top);
  const cuts = level.some((gap) => gap.alternative) ? level.filter((gap) => gap.alternative) : level;
  const bounds = [0, ...cuts.map((gap) => gap.at), words.length];
  return bounds.slice(1).map((end, i) => words.slice(bounds[i], end));
}

/** A usage in lines of at most `width` columns, broken only where {@link usageUnits} allows. A group
 *  too wide for a line takes lines of its own and breaks the same way one level in. Only a single
 *  option with its argument wider than the line is broken at its spaces. Every line fits or is one
 *  word, so the report renderer draws each line as it is. */
function usageLines(words: readonly string[], width: number): string[] {
  const text = words.join(" ");
  if (!(width >= 20) || displayWidth(text) <= width) return [text];
  const units = usageUnits(words);
  if (!units) {
    // No gap may break, so these words are one option and its argument, broken at their spaces. A
    // ` | ` after them stays on the line before it when it fits there.
    const kept: string[] = [];
    for (const word of words) {
      if (word === "|" && kept.length && displayWidth(`${kept[kept.length - 1]} |`) <= width) kept[kept.length - 1] += " |";
      else kept.push(word);
    }
    return wrapWords(kept, width);
  }
  const lines: string[] = [];
  let line = "";
  for (const unit of units) {
    const piece = unit.join(" ");
    if (displayWidth(piece) > width) {
      if (line) lines.push(line);
      lines.push(...usageLines(unit, width));
      line = "";
    } else if (line && displayWidth(`${line} ${piece}`) > width) {
      lines.push(line);
      line = piece;
    } else line = line ? `${line} ${piece}` : piece;
  }
  if (line) lines.push(line);
  return lines;
}

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
  if (!all) return printEntry(commands);
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
  let out = `${hang("", title(), width).join("\n")}\n`;
  for (const [group, cmds] of ordered) {
    out += `\n${hang("", group, width, c.bold).join("\n")}\n`;
    // Padded to the widest name in every group, so the descriptions line up across groups.
    out += `${describe(cmds.map((cmd) => label(cmd).padEnd(pad)), cmds.map((cmd) => cmd.summary), width).join("\n")}\n`;
  }
  const notes = ["Every command also takes --no-color (no ANSI color) and --no-input (never prompt).", "Run `cotal help <command>` for a command's flags."];
  if (!all && listed(commands, true).length > visible.length) notes.push("Run `cotal help --all` to include hidden commands.");
  for (const note of notes) out += `\n${hang("", note, width, c.dim).join("\n")}`;
  console.log(out);
}

/** The approved compact entry screen. Its context comes from local records only. */
export function printEntry(commands: readonly Command[]): void {
  const width = terminalWidth(process.stdout);
  const has = (name: string): boolean => commands.some((command) => command.name === name && !command.hidden);
  const actions = (title: string, items: readonly [string, string, string][]): Section => ({
    title,
    blocks: [{ kind: "commands", items: items.filter(([name]) => has(name)).map(([, command, description]) => ({ command, description })) }],
  });
  let space: string | undefined;
  let context: string | undefined;
  let unreadable = false;
  try {
    space = getCurrent();
    if (space) {
      const mesh = readMesh(space);
      const prepared = mesh === undefined ? findPreparedSpace(space) : undefined;
      const preferences = cachedPreferences();
      const harness = resolvePreference("harness", { space, preferences }).value;
      context = [space, mesh ? mesh.origin === "catalog" || mesh.origin === "manual" ? "registered" : "local" : prepared ? "prepared" : "not recorded", harness ? `default agent ${harness}` : "no default application"].join(" · ");
    }
  } catch {
    unreadable = true;
  }
  const sections: Section[] = [];
  if (unreadable) sections.push({ blocks: [{ kind: "lines", lines: [{ text: "The local space or defaults could not be read. Status reports the affected records.", tone: "waiting" }] }] });
  else if (context) sections.push({ blocks: [{ kind: "lines", lines: [{ text: context, tone: "hint" }] }] });
  else sections.push({ blocks: [{ kind: "lines", lines: ["No space is selected.", { text: "Set up a local space, or connect to a self-hosted one.", tone: "hint" }] }] });
  sections.push({ title: "Usage", blocks: [{ kind: "lines", lines: [{ text: "cotal <command> [options]", tone: "command" }] }] });
  sections.push(actions("Start here", space ? [
    ["spawn", "cotal spawn", "Open your default agent"],
    ["setup", "cotal setup", "Review setup and defaults"],
    ["use", "cotal use", "Choose another space"],
  ] : [["setup", "cotal setup", "Choose your application and prepare a space"]]));
  sections.push(actions("Everyday", [
    ["ps", "cotal ps", "List agents"],
    ["attach", "cotal attach <name>", "Return to an agent"],
    ["stop", "cotal stop <name>", "Stop one agent"],
    ["send", 'cotal send -t <name> "…"', "Send one message"],
    ["chat", "cotal chat", "Join a live conversation"],
    ["watch", "cotal watch", "Follow activity without controlling agents"],
    ["status", "cotal status", "See this machine and the selected space"],
  ]));
  sections.push({ title: "More", blocks: [{ kind: "commands", items: [
    { command: "cotal help --all", description: "Every command group" },
    { command: "cotal <command> -h", description: "Options, shorthands and examples" },
  ] }] });
  const groups = ["space", "persona", "personas", "team", "run", "config"].filter(has);
  if (groups.length) sections.push({ blocks: [{ kind: "lines", lines: [{ text: `Also: ${groups.join(" · ")}`, tone: "hint" }] }] });
  sections.push({ blocks: [{ kind: "lines", lines: [{ text: "Detaching leaves your agent working. Help does not check services.", tone: "hint" }] }] });
  console.log(renderReport({ sections }, "rich", width));
}

/** One command's help, or one subcommand's when `sub` is given: summary, usage, aliases,
 *  subcommands, flags, structured outputs and examples, all from the declared specs. Each line goes
 *  to `out`, which a usage refusal points at stderr, wrapped to `width`; the usage breaks only where
 *  {@link usageLines} allows, and examples are never wrapped, so each stays one line to copy. */
export function printCommandHelp(cmd: Command, sub?: Subcommand, out: (line: string) => void = console.log, width = terminalWidth(process.stdout)): void {
  const path = sub ? `${cmd.name} ${sub.name}` : cmd.name;
  const selected = sub ?? cmd;
  const usage = sub ? sub.usage ?? `cotal ${path}` : commandUsage(cmd);
  const sections: Section[] = [
    { title: `cotal ${path}`, blocks: [{ kind: "lines", lines: [selected.summary] }] },
    // A titled section indents its lines two columns, so the usage is fitted to what is left.
    { title: "Usage", blocks: [{ kind: "lines", lines: usageLines(usage.split(" "), width - 2).map((text) => ({ text, tone: "command" as const })) }] },
  ];
  if (selected.aliases?.length) sections.push({ title: "Shorthands", blocks: [{ kind: "lines", lines: [{ text: selected.aliases.map((alias) => `cotal ${sub ? `${cmd.name} ${sub.name.split(" ").slice(0, -1).map((word) => word + " ").join("")}` : ""}${alias}`).join(" · "), tone: "command" }] }] });
  const subs = (sub ? sub.subcommands ?? [] : cmd.subcommands ?? []).filter((item) => !item.hidden);
  if (subs.length) sections.push({ title: "Commands", blocks: [{ kind: "commands", items: subs.map((item) => ({ command: label(item), description: item.summary })) }] });
  const flagNames = selected.flagNames;
  const flags = (cmd.flags ?? []).filter((flag) => !flagNames || flagNames.includes(flag.name));
  if (flags.length) sections.push({ title: "Options", blocks: [{ kind: "commands", items: flags.map((flag) => ({
    command: `${flag.short ? `-${flag.short}, ` : ""}--${flag.name}${flag.type === "string" ? ` ${flag.value ?? "<value>"}` : ""}`,
    description: flag.description ?? "",
  })) }] });
  const outputs = selected.outputs ?? [];
  if (outputs.length) sections.push({ blocks: [{ kind: "lines", lines: [{ text: `Structured output: ${outputs.join(", ")}`, tone: "hint" }] }] });
  out(renderReport({ sections }, "rich", width));
  const examples = selected.examples ?? [];
  if (examples.length) {
    out(`\n${c.bold("Examples")}`);
    for (const example of examples) out(`  ${c.blue(example)}`);
  }
}

/** Resolve only declared literal metadata. Neither aliases nor nesting import provider code. */
export function printHelpPath(cmd: Command, words: readonly string[], out: (line: string) => void = console.log, width = terminalWidth(process.stdout)): void {
  let surface: Pick<Command, "subcommands"> = cmd;
  let selected: Subcommand | undefined;
  const path: string[] = [];
  for (const word of words) {
    const sub = findSubcommand(surface, word);
    if (!sub || sub.hidden) {
      // The parser's usage error for the same word: the reason, then the help of the path that exists.
      const at = [cmd.name, ...path].join(" ");
      for (const line of hang("✗ ", `cotal ${at} has no subcommand "${word}" - run \`cotal help ${at}\``, terminalWidth(process.stderr))) console.error(c.red(line));
      printCommandHelp(cmd, selected ? { ...selected, name: path.join(" ") } : undefined, (line) => console.error(line), terminalWidth(process.stderr));
      process.exit(1);
    }
    path.push(sub.name); selected = sub; surface = sub;
  }
  printCommandHelp(cmd, selected ? { ...selected, name: path.join(" ") } : undefined, out, width);
}
