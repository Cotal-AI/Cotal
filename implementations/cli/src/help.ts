/**
 * Help text, rendered from each command's declared specs: the bare entry screen, the grouped command
 * list, and one command's or subcommand's help. Every renderer reads local metadata only: it never
 * connects, writes, seeds or imports an extension.
 */
import { commandUsage, findSubcommand, type Command, type Subcommand } from "@cotal-ai/core";
import { cachedPreferences, canonicalRoot, displayWidth, findCotalRoot, findPreparedSpace, folderSpace, folderSpaceHeld, folderSpaceStopped, getCurrent, loadMeshes, loadPreparedSpaces, localeIsUtf8, plainPunctuation, readMesh, recordsElsewhereError, recordsElsewhereText, renderReport, resolvePreference, terminalWidth, wrapWords, type Section } from "@cotal-ai/workspace";
import { shellWord } from "./lib/endpoint-errors.js";
import { unknownSubcommandMessage } from "./lib/nearest-word.js";
import { workingFolderRemoved } from "./lib/paths.js";
import { c, hang } from "./ui.js";

/** Display order for the help groups — an explicit ranking, NOT registration order: modules
 *  self-register on import and the dev runner (tsx) doesn't guarantee entry-import evaluation
 *  order, so the daemon surface could otherwise print above Setup. Groups not listed here
 *  (e.g. an extension's custom group) follow, in first-registered order. */
const GROUP_ORDER = ["Setup", "Mesh", "Messaging", "Agents", "Run a manager", "Observe", "Extensions", "Manager"];

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

/** One piece of a usage, and whether a space joins it to the piece before. A word is cut after each
 *  compact `|` in it, such as the one in `[--json|--plain]`, and nothing joins the pieces. */
interface UsageToken {
  readonly text: string;
  readonly spaced: boolean;
}

/** A usage as its tokens. They join back into the same text. */
function usageTokens(usage: string): UsageToken[] {
  return usage.split(" ").flatMap((word, i) => word.split(/(?<=\|)(?=.)/).map((text, j) => ({ text, spaced: i > 0 && j === 0 })));
}

/** `tokens` as the text they came from. */
const joined = (tokens: readonly UsageToken[]): string => tokens.map((token, i) => (i > 0 && token.spaced ? " " : "") + token.text).join("");

/** A usage's tokens cut where its lines may break: at the gaps outside the groups the tokens share,
 *  except where {@link staysWith} keeps two words together. The gaps after their own ` | ` or
 *  compact `|` alternatives come first. None when no gap may break. */
function usageUnits(tokens: readonly UsageToken[]): UsageToken[][] | undefined {
  const gaps: { at: number; depth: number; alternative: boolean }[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length - 1; i++) {
    depth = Math.max(0, depth + nesting(tokens[i]!.text));
    const next = tokens[i + 1]!;
    if (!next.spaced) gaps.push({ at: i + 1, depth, alternative: true });
    else if (!staysWith(tokens[i]!.text, next.text)) gaps.push({ at: i + 1, depth, alternative: tokens[i]!.text === "|" });
  }
  if (!gaps.length) return undefined;
  const top = Math.min(...gaps.map((gap) => gap.depth));
  const level = gaps.filter((gap) => gap.depth === top);
  const cuts = level.some((gap) => gap.alternative) ? level.filter((gap) => gap.alternative) : level;
  const bounds = [0, ...cuts.map((gap) => gap.at), tokens.length];
  return bounds.slice(1).map((end, i) => tokens.slice(bounds[i], end));
}

/** A usage in lines of at most `width` columns, broken only where {@link usageUnits} allows. A group
 *  too wide for a line takes lines of its own and breaks the same way one level in. Only a single
 *  option with its argument wider than the line is broken at its spaces. From 20 columns every line
 *  fits or is one word; below 20 the usage is one line, as {@link wrapWords} leaves it. Either way
 *  the report renderer draws each line as it is. */
function usageLines(tokens: readonly UsageToken[], width: number): string[] {
  const text = joined(tokens);
  if (!(width >= 20) || displayWidth(text) <= width) return [text];
  const units = usageUnits(tokens);
  if (!units) {
    // No gap may break, so these tokens are one option and its argument, joined by spaces, and
    // broken at them. A ` | ` after them stays on the line before it when it fits there.
    const kept: string[] = [];
    for (const { text: word } of tokens) {
      if (word === "|" && kept.length && displayWidth(`${kept[kept.length - 1]} |`) <= width) kept[kept.length - 1] += " |";
      else kept.push(word);
    }
    return wrapWords(kept, width);
  }
  const lines: string[] = [];
  let line = "";
  for (const unit of units) {
    const piece = joined(unit);
    const longer = `${line}${unit[0]!.spaced ? " " : ""}${piece}`;
    if (displayWidth(piece) > width) {
      if (line) lines.push(line);
      lines.push(...usageLines(unit, width));
      line = "";
    } else if (line && displayWidth(longer) > width) {
      lines.push(line);
      line = piece;
    } else line = line ? longer : piece;
  }
  if (line) lines.push(line);
  return lines;
}

/** A command's name with its aliases, as help lists it. */
function label(cmd: Command | Subcommand): string {
  return [cmd.name, ...(cmd.aliases ?? [])].join(", ");
}

/** Commands help lists: never `__` internals or `hidden` ones. A hidden command stays callable. */
function listed(commands: readonly Command[]): Command[] {
  return commands.filter((cmd) => !cmd.name.startsWith("__") && !cmd.hidden);
}

/** `cotal help`: the title, the entry screen, then every listed command by group. Under a locale
 *  that is not UTF-8 the summaries are written with plain punctuation, as the entry screen is. */
export function printCommandList(commands: readonly Command[]): void {
  const visible = listed(commands);
  const ascii = !localeIsUtf8();
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
  console.log(`${hang("", title(), width).join("\n")}\n`);
  printEntry(commands, true);
  let out = "";
  for (const [group, cmds] of ordered) {
    out += `\n${hang("", group, width, c.bold).join("\n")}\n`;
    // Padded to the widest name in every group, so the descriptions line up across groups.
    out += `${describe(cmds.map((cmd) => label(cmd).padEnd(pad)), cmds.map((cmd) => (ascii ? plainPunctuation(cmd.summary) : cmd.summary)), width).join("\n")}\n`;
  }
  const notes = ["Every command also takes --no-color (no ANSI color) and --no-input (never prompt).", "Run `cotal help <command>` for a command's flags."];
  for (const note of notes) out += `\n${hang("", note, width, c.dim).join("\n")}`;
  console.log(out);
}

/** The approved compact entry screen. Its context comes from local records only. With `listing`, the
 *  command groups follow it, so it leaves out the lines that point to them. */
export function printEntry(commands: readonly Command[], listing = false): void {
  const width = terminalWidth(process.stdout);
  const has = (name: string): boolean => commands.some((command) => command.name === name && !command.hidden);
  const actions = (title: string, items: readonly [string, string, string][]): Section => ({
    title,
    blocks: [{ kind: "commands", items: items.filter(([name]) => has(name)).map(([, command, description]) => ({ command, description })) }],
  });
  let space: string | undefined;
  let context: string | undefined;
  // The selection, when this folder's space is the target here instead.
  let outside: string | undefined;
  // The `up` that starts a prepared space: no other command works on it until it runs.
  let start: string | undefined;
  // What this folder holds that is not running, when a command here targets the selection instead.
  let folderHeld: string | undefined;
  // What a copy or a moved folder holds, with the step the commands here refuse with.
  let elsewhere: string | undefined;
  let unreadable = false;
  // Setup is the first step only on a machine with no space at all.
  let anySpace = false;
  // From a removed folder every command that uses a space refuses, so no space is shown.
  const removed = workingFolderRemoved();
  if (!removed) try {
    const selected = getCurrent();
    const root = findCotalRoot(process.cwd());
    // A command run here targets the space this folder has registered over the selection while it
    // runs, as it does with nothing selected. A space prepared here, or one whose stack here is
    // stopped, is not the target of anything but `up`, so it is named as this folder's `up` rather
    // than as the space. A registered one is named so when this folder's records show its stack
    // stopped, since help reads no broker.
    const stopped = selected ? folderSpaceStopped(process.cwd(), selected) : undefined;
    const folder = stopped ? undefined : folderSpace(process.cwd());
    const held = folder === undefined ? stopped ?? folderSpaceHeld(process.cwd()) : undefined;
    // With nothing selected no selection takes its place, so a command here targets the space this
    // folder prepared, and it leads.
    const preparedHere = selected || !held ? undefined : findPreparedSpace(held.space);
    // A copy or a moved folder holds the records of a stack that runs from another folder, so the
    // commands here refuse, with the selection too, and name that folder.
    const records = recordsElsewhereError(root)?.details;
    const holds = records && recordsElsewhereText(records);
    if (holds) elsewhere = `${holds}; ${records!.stackRemedy}`;
    space = folder ?? selected ?? (preparedHere && canonicalRoot(preparedHere.root) === canonicalRoot(held!.root) ? held!.space : undefined);
    if (selected && folder !== undefined && folder !== selected) outside = selected;
    if (held) start = canonicalRoot(held.root) === canonicalRoot(root) ? "cotal up" : `cotal up --root ${shellWord(held.root)}`;
    if (space) {
      const mesh = readMesh(space);
      const prepared = mesh === undefined ? findPreparedSpace(space) : undefined;
      const here = prepared !== undefined && canonicalRoot(prepared.root) === canonicalRoot(root);
      const preferences = cachedPreferences();
      const harness = resolvePreference("harness", { space, preferences }).value;
      context = [space, mesh ? mesh.origin === "catalog" || mesh.origin === "manual" ? "registered" : "local" : here ? "prepared here" : prepared ? "prepared" : "not recorded", harness ? `default agent ${harness}` : "no default application"].join(" · ");
      if (prepared) start = here ? "cotal up" : `cotal up --root ${shellWord(prepared.root)}`;
      if (held && held.space !== space) folderHeld = `this folder holds the ${held.state} space "${held.space}"`;
    } else anySpace = loadMeshes().length > 0 || loadPreparedSpaces().length > 0;
  } catch {
    unreadable = true;
  }
  const sections: Section[] = [];
  if (removed) sections.push({ blocks: [{ kind: "lines", lines: [{ text: "This folder no longer exists, so commands that use a space refuse here. cd to an existing folder first.", tone: "waiting" }] }] });
  else if (unreadable) sections.push({ blocks: [{ kind: "lines", lines: [{ text: "The local space or defaults could not be read. Status reports the affected records.", tone: "waiting" }] }] });
  else if (context) sections.push({ blocks: [{ kind: "lines", lines: [{ text: context, tone: "hint" },
    // Help reads no broker, so it cannot tell whether this folder's space runs; it says when it applies.
    ...(outside ? [{ text: `this folder's space while it runs; the selected space "${outside}" applies outside it and while it is stopped`, tone: "hint" } as const] : []),
    ...(folderHeld ? [{ text: folderHeld, tone: "hint" } as const] : []),
    ...(elsewhere ? [{ text: elsewhere, tone: "hint" } as const] : [])] }] });
  else sections.push({ blocks: [{ kind: "lines", lines: ["No space is selected.", { text: anySpace ? "Select one with `cotal use <name>`; `cotal space` lists them." : "Set up a local space, or connect to a self-hosted one.", tone: "hint" },
    ...(elsewhere ? [{ text: elsewhere, tone: "hint" } as const] : [])] }] });
  sections.push({ title: "Usage", blocks: [{ kind: "lines", lines: [{ text: "cotal <command> [options]", tone: "command" }] }] });
  sections.push(actions("Start here", space ? [
    // A folder's `up` starts THAT folder's space, not the one commands here target, so it is named
    // as the folder's and the selection keeps its own first action.
    ...(start ? [["up", start, folderHeld ? "Start this folder's space" : "Start this space"] as [string, string, string]] : []),
    ...(start && !folderHeld ? [] : [["spawn", "cotal spawn", "Open your default agent"] as [string, string, string]]),
    ["setup", "cotal setup", "Review setup and defaults"],
    ["use", "cotal use", "Choose another space"],
  ] : anySpace ? [
    ["use", "cotal use <name>", "Choose the space commands use"],
    ["space", "cotal space", "List the spaces on this machine"],
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
  if (!listing) {
    sections.push({ title: "More", blocks: [{ kind: "commands", items: [
      { command: "cotal help", description: "Every command" },
      { command: "cotal <command> -h", description: "Options, shorthands and examples" },
    ] }] });
    const groups = ["space", "persona", "personas", "team", "run", "config"].filter(has);
    if (groups.length) sections.push({ blocks: [{ kind: "lines", lines: [{ text: `Also: ${groups.join(" · ")}`, tone: "hint" }] }] });
  }
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
    // A titled section indents its lines two columns, so the usage is fitted to what is left. A usage
    // that declares several forms, one per line, shows each form on its own lines.
    { title: "Usage", blocks: [{ kind: "lines", lines: usage.split("\n").flatMap((form) => usageLines(usageTokens(form), width - 2)).map((text) => ({ text, tone: "command" as const })) }] },
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
      for (const line of hang("✗ ", unknownSubcommandMessage(at, surface, word), terminalWidth(process.stderr))) console.error(c.red(line));
      printCommandHelp(cmd, selected ? { ...selected, name: path.join(" ") } : undefined, (line) => console.error(line), terminalWidth(process.stderr));
      process.exit(1);
    }
    path.push(sub.name); selected = sub; surface = sub;
  }
  printCommandHelp(cmd, selected ? { ...selected, name: path.join(" ") } : undefined, out, width);
}
