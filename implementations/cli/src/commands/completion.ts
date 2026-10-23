import { basename, dirname, isAbsolute } from "node:path";
import {
  findCommand,
  findSubcommand,
  type Command,
  type CompletionItem,
  type CompletionResult,
  type FlagValues,
  type ParsedArgs,
  type Subcommand,
} from "@cotal-ai/core";
import { CommandFailure, isCommandFailure, jsonFlag, plainFlag, presentationOf, writeResult, type OutputWarning, type Report, type Styled } from "@cotal-ai/workspace";
import { metadataPositionals } from "../lib/command-path.js";
import { servicePresetCommand } from "../lib/service-presets.js";
import { commandSurface } from "../ext-loader.js";
import { changeCompletion, completionOwnership, completionPaths as stubPaths, completionSourceLine, readCompletionText } from "../lib/completion-install.js";
import { SCRIPTS, LOAD_NOW } from "../lib/completion-scripts.js";

/**
 * Shell completion, the standard two-layer way (Cobra/Click/clap): a thin per-shell stub —
 * printed to stdout by `cotal completion script <shell>`, installed once — that forwards each <TAB>
 * to the hidden `cotal __complete` dispatcher. The dispatcher returns live candidates, so
 * completion sees real data (your personas) that a static script never could.
 *
 * The stub is installed once; the protocol between it and `__complete` is line-oriented and
 * tolerant (unknown lines are ignored), so it can grow without anyone re-installing the stub.
 *
 *   cotal completion                            # which shells have the stub, and whether it is current
 *   cotal completion script <shell>             # print the stub to stdout
 *   cotal completion install [shell]            # install or refresh unchanged owned files
 *   cotal completion uninstall [shell]          # remove unchanged owned files and startup block
 *   cotal __complete <words…>                   # internal: emit candidates for the cursor
 *
 * `__complete` is import-light and side-effect-free by contract — completion reads only local
 * files (your personas and their declared channels/roles), never the mesh — so a keystroke never
 * blocks on the network. And there is no fallback: a completer that can't produce its authoritative
 * answer (e.g. a malformed agent file) fails the process — nothing on stdout, non-zero exit — so a
 * partial set is never mistaken for a complete one. Set COTAL_COMPLETE_DEBUG to see why on stderr.
 */

/** Wire format: one `value\tdescription` (or bare `value`) per line, then a `:directive`
 *  trailer the stub reads (`:nofiles` / `:nospace` / `:default`). */
function emit(items: CompletionItem[], directive: NonNullable<CompletionResult["directive"]>): void {
  const lines = items.map((i) => (i.description ? `${i.value}\t${i.description}` : i.value));
  lines.push(`:${directive}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** The hidden dispatcher the shell stubs call (`rawArgs`: its argv is another command's
 *  half-typed line, never parsed). The words after `cotal`, up to and including the (possibly
 *  empty) word being completed, arrive as `args.positionals` verbatim. */
export async function complete(args: ParsedArgs): Promise<void> {
  const argv = args.positionals;
  // Mirror help()'s visibility: the SAME surface runCli resolved (registered commands plus
  // extension stubs when the root opted in), minus `__`-internal and `hidden` ones. Extension
  // candidates come from the manifest CACHE — a <TAB> never imports an extension.
  const commands = commandSurface().filter((cmd) => !cmd.name.startsWith("__") && !cmd.hidden);
  // No command word yet: offer the command names. If the lone word is an exact command, many
  // shells omitted the trailing empty cursor word; complete inside that command instead.
  if (argv.length === 0) {
    emit(commands.map((cmd) => ({ value: cmd.name, description: cmd.summary })), "nofiles");
    return;
  }
  // The command word resolves as dispatch resolves it: by exact name or alias, never by prefix. A
  // lone alias is still the word being typed (`sp` on the way to `spawn`), so only a lone exact name
  // completes inside its command.
  const cmd = findCommand(commands, argv[0]);
  if (argv.length === 1 && cmd?.name === argv[0]) return emitCommandCompletion(cmd, [""]);
  if (argv.length === 1) {
    emit(commands.map((cmd) => ({ value: cmd.name, description: cmd.summary })), "nofiles");
    return;
  }
  // A finished subcommand word reaches the command's completer by its canonical name.
  const words = argv.slice(1);
  const sub = cmd && words.length > 1 ? findSubcommand(cmd, words[0]) : undefined;
  return emitCommandCompletion(cmd, sub ? [sub.name, ...words.slice(1)] : words);
}

async function emitCommandCompletion(cmd: Command | undefined, argv: string[]): Promise<void> {
  // A word starting with `-` completes against the command's DECLARED flags — generated from
  // the specs, so it can never drift from what parsing accepts. Value/positional completion
  // stays with the command's own `complete` hook below.
  const word = argv[argv.length - 1] ?? "";
  const original = cmd ? metadataPositionals(cmd, argv, { completing: true }) : undefined;
  if (cmd?.name === "service" && original?.valueFlag?.name !== "preset" && !word.startsWith("--preset=")) {
    try { cmd = servicePresetCommand(cmd, argv); }
    catch { if (process.env.COTAL_COMPLETE_DEBUG) process.stderr.write("cotal __complete: service preset metadata is unavailable or changed\n"); process.exit(1); }
  }
  const context = cmd ? metadataPositionals(cmd, argv, { completing: true }) : undefined;
  let selected: Subcommand | undefined;
  let parent: Pick<Command, "subcommands"> | undefined = cmd;
  for (const token of context?.positionals ?? []) {
    if (token.index === argv.length - 1) break;
    const child: Subcommand | undefined = parent && findSubcommand(parent, token.value);
    if (!child) break;
    selected = child; parent = child;
    if (!child.subcommands?.length) break;
  }
  const flagNames = selected?.flagNames ?? cmd?.flagNames;
  const flags = (cmd?.flags ?? []).filter((flag) => !flagNames || flagNames.includes(flag.name));
  if (cmd && !context?.valueFlag && !context?.optionsEnded && word.startsWith("-") && !word.includes("=")) {
    emit(flags.map((flag) => ({ value: `--${flag.name}`, description: flag.description })), "nofiles");
    return;
  }
  if (!cmd?.complete) {
    const cursor = context?.positionals.find((item) => item.index === argv.length - 1);
    const children = parent?.subcommands?.filter((item) => !item.hidden);
    if (cursor && children?.length) emit(children.map((item) => ({ value: item.name, description: item.summary })), "nofiles");
    else if (context?.optionsEnded || context?.valueFlag) emit([], "nofiles");
    else emit(flags.map((flag) => ({ value: `--${flag.name}`, description: flag.description })), flags.length ? "nofiles" : "default");
    return;
  }
  try {
    const res = await cmd.complete(argv);
    emit(res.items, res.directive ?? "nofiles");
  } catch (e) {
    // No fallback: a completer that can't produce its authoritative set (e.g. a malformed agent
    // file) fails the process — nothing on stdout, non-zero exit — so the shell offers nothing and
    // never mistakes a failure for a successful empty result. Silent unless explicitly debugging.
    if (process.env.COTAL_COMPLETE_DEBUG)
      process.stderr.write(`cotal __complete: ${(e as Error).message}\n`);
    process.exit(1);
  }
}


export const completionFlags = [jsonFlag, plainFlag] as const;
const currentShell = (): string => { const name = basename(process.env.SHELL ?? ""); return name === "pwsh" ? "powershell" : name; };

/** Validate output mode and grammar before reading or changing shell files. */
export function validateCompletionArguments(args: ParsedArgs): void {
  presentationOf(args.values);
  const [sub, shell] = args.positionals;
  if (args.positionals.length > 2) throw new CommandFailure("refused", "USAGE_INVALID", "completion takes one operation and one shell");
  if (sub === undefined) return;
  if (Object.hasOwn(SCRIPTS, sub)) throw new CommandFailure("refused", "USAGE_INVALID", `cotal completion ${sub} is now cotal completion script ${sub}`, { remedy: `load it with: ${LOAD_NOW[sub]}` });
  if (!["script", "install", "uninstall"].includes(sub)) throw new CommandFailure("refused", "USAGE_INVALID", "choose completion script, install or uninstall");
  if (sub === "script" && (args.values.json || args.values.plain)) throw new CommandFailure("refused", "USAGE_INVALID", "completion script prints raw shell code, without --json or --plain");
  if ((sub === "script" && shell === undefined) || (shell !== undefined && !Object.hasOwn(SCRIPTS, shell))) throw new CommandFailure("refused", "USAGE_INVALID", "choose a supported shell", { remedy: `pass one of: ${Object.keys(SCRIPTS).join(", ")}` });
}

export async function completion(args: ParsedArgs): Promise<void> {
  validateCompletionArguments(args);
  const [sub, shell] = args.positionals;
  const values = args.values as FlagValues<typeof completionFlags>;
  const presentation = presentationOf(values);
  if (sub === undefined) {
    const { status, unread } = completionStatus();
    const partial = unread.length ? { completeness: "partial" as const, warnings: unread, partial: { message: `completion could not read ${unread.length === 1 ? "one file" : `${unread.length} files`}`, remedy: "review each named file without overwriting custom startup content" } } : {};
    return writeResult(presentation, { command: "completion", target: null, result: status, ...partial }, statusView);
  }
  if (sub === "script") { process.stdout.write(SCRIPTS[shell!]!); return; }
  const sh = shell ?? currentShell();
  if (!Object.hasOwn(SCRIPTS, sh)) throw new CommandFailure("refused", "USAGE_INVALID", "the current shell is unknown", { remedy: "pass one of: bash, zsh, fish, powershell" });
  const paths = stubPaths(sh);
  if (!paths) throw new CommandFailure("refused", "UNSUPPORTED", "owned PowerShell profile installation is unavailable on this host or the shell is not installed; no profile path was guessed", { remedy: `review your profile manually; the supported loading command is: ${LOAD_NOW.powershell}` });
  if (sh === "zsh" && process.env.ZDOTDIR && !isAbsolute(process.env.ZDOTDIR)) throw new CommandFailure("refused", "USAGE_INVALID", "relative ZDOTDIR makes the startup target depend on the shell's working directory", { remedy: "use an absolute ZDOTDIR or manage the printed script manually" });
  const operation = sub as "install" | "uninstall";
  const result = changeCompletion(operation, sh, paths, SCRIPTS[sh]!);
  writeResult(presentation, { command: `completion ${operation}`, target: { shell: sh }, noOp: result.noOp, result }, (data): Report => ({ sections: [
    { title: data.noOp ? "Shell completion unchanged" : operation === "install" ? "Shell completion installed" : "Shell completion removed", blocks: [
      { kind: "fields", rows: [["Shell", data.shell], ["Script", data.stub], ["Startup", data.startup ?? "fish completion directory"], ["Changed files", String(data.changed.length)]] },
      { kind: "lines", lines: [{ text: "Only recorded, unchanged owned material was changed. Other startup content was retained.", tone: "hint" }, { text: operation === "install" ? "Open a new shell to load the installed completion. This command did not change the parent shell." : "Functions already loaded in the parent shell cannot be unloaded by this command. Open a new shell.", tone: "hint" }] },
    ] },
    { title: "Next", blocks: [{ kind: "commands", items: [{ command: "cotal completion", description: "Read installed files and ownership, without loading a shell" }, { command: `cotal completion script ${sh}`, description: "Print the supported script for manual wiring" }] }] },
  ] }));
}

type StubState = "missing" | "current" | "differs" | "unreadable";

/** One shell's completion as this machine has it. `wiredIn` is where `completion install` wires the
 *  stub in: the startup file holding the line it writes, or fish's completions directory, which fish
 *  loads by itself. It is null when that wiring is not found, which does not mean the shell loads no
 *  completion some other way. PowerShell reports only the profile its installed host identifies. */
export interface ShellCompletion {
  readonly shell: string;
  readonly stub: string | null;
  readonly state: StubState | "not-installed-by-cotal";
  readonly wiredIn: string | null;
  readonly ownership: "managed" | "unrecorded" | "modified" | "unreadable" | "manual";
  readonly legacyWiring: boolean;
}

export interface CompletionStatus {
  /** The shell `$SHELL` names, when it is one Cotal completes. */
  readonly shell: string | null;
  readonly shells: ShellCompletion[];
}

/** The line `completion install` adds to a startup file for `stub`. */
const sourceLine = completionSourceLine;

/** Whether a startup file holds the install line as a line of its own, so a comment or a longer
 *  line that only contains it does not count. Only spaces and tabs around it are blanks: bash keeps
 *  a carriage return in the file name it sources, so a CRLF copy of the line loads nothing. */
const holdsSourceLine = (rc: string, stub: string, shell: string): boolean => rc.split("\n").some((line) => line.replace(/^[ \t]+|[ \t]+$/g, "") === sourceLine(stub, shell) || shell !== "powershell" && line.replace(/^[ \t]+|[ \t]+$/g, "") === `source "${stub}"`);

/** A file's text, `undefined` when it does not exist, or the error that stopped the read. */
function readText(path: string): string | undefined | NodeJS.ErrnoException {
  try {
    return readCompletionText(path);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? undefined : (e as NodeJS.ErrnoException);
  }
}

/** Each shell's stub against the script this binary prints, and a warning for each file it could
 *  not read. Reads local files only. */
export function completionStatus(): { status: CompletionStatus; unread: OutputWarning[] } {
  const unread: OutputWarning[] = [];
  const read = (shell: string, path: string): string | undefined | null => {
    const text = readText(path);
    if (typeof text !== "object") return text;
    const reason = isCommandFailure(text) ? text.message : text.code ?? text.message;
    // A refusal that already names the file, such as a symlink's, is not prefixed with it again.
    unread.push({ code: "COMPLETION_UNREADABLE", target: { shell }, message: reason.startsWith(path) ? reason : `${path} could not be read: ${reason}` });
    return null;
  };
  const shells = Object.keys(SCRIPTS).map((shell): ShellCompletion => {
    let paths: ReturnType<typeof stubPaths>;
    try { paths = stubPaths(shell); }
    catch { unread.push({ code: "COMPLETION_PROFILE_UNAVAILABLE", target: { shell }, message: "the shell did not return a usable current-user profile; no alternate profile was guessed" }); return { shell, stub: null, state: "unreadable", wiredIn: null, ownership: "unreadable", legacyWiring: false }; }
    if (!paths) return { shell, stub: null, state: "not-installed-by-cotal", wiredIn: null, ownership: "manual", legacyWiring: false };
    const content = read(shell, paths.stub);
    const state: StubState = content === null ? "unreadable" : content === undefined ? "missing" : content === SCRIPTS[shell] ? "current" : "differs";
    let ownership: ShellCompletion["ownership"];
    try { ownership = completionOwnership(shell, paths); }
    catch { ownership = "unreadable"; unread.push({ code: "COMPLETION_OWNERSHIP_UNREADABLE", target: { shell }, message: "the completion ownership record or its file scope could not be read safely" }); }
    if (!paths.rc) return { shell, stub: paths.stub, state, wiredIn: content === undefined || content === null ? null : dirname(paths.stub), ownership, legacyWiring: false };
    const rc = read(shell, paths.rc);
    const legacyWiring = typeof rc === "string" && new RegExp(`cotal[ \t]+completion[ \t]+${shell}(?:[ \t;|)]|$)`, "m").test(rc);
    return { shell, stub: paths.stub, state, wiredIn: rc && holdsSourceLine(rc, paths.stub, shell) ? paths.rc : null, ownership, legacyWiring };
  });
  const detected = currentShell();
  return { status: { shell: Object.hasOwn(SCRIPTS, detected) ? detected : null, shells }, unread };
}

const STATE: Record<ShellCompletion["state"], Styled> = {
  current: { text: "current", tone: "ok" },
  differs: { text: "differs from this version", tone: "waiting" },
  missing: { text: "not installed", tone: "hint" },
  unreadable: { text: "unreadable", tone: "failed" },
  "not-installed-by-cotal": { text: "not installed by cotal", tone: "hint" },
};

function completionCell(shell: ShellCompletion): Styled {
  if (shell.ownership === "modified" || shell.ownership === "unreadable") return { text: `${shell.ownership} owned integration`, tone: "waiting", mark: "●" };
  if (shell.legacyWiring) return { text: "old custom loading command needs migration", tone: "waiting", mark: "●" };
  if (shell.state === "current") return shell.wiredIn
    ? { text: "installed · startup reference found", tone: "ok", mark: "●" }
    : { text: "script present · startup not configured", tone: "waiting", mark: "●" };
  if (shell.state === "missing" && shell.wiredIn) return { text: "startup points at a missing script", tone: "failed", mark: "●" };
  return { ...STATE[shell.state], mark: shell.state === "unreadable" || shell.state === "differs" ? "●" : "○" };
}

function statusView(status: CompletionStatus): Report {
  const selected = status.shells.find((shell) => shell.shell === status.shell);
  const dangling = status.shells.filter((shell) => shell.state === "missing" && shell.wiredIn !== null);
  return {
    sections: [
      { title: "Shell completion", blocks: [
        ...(selected ? [{ kind: "fields" as const, rows: [
          ["Shell", selected.shell] as const,
          ["Integration", completionCell(selected)] as const,
          ["Startup", selected.wiredIn ?? "no managed startup reference"] as const,
          ["Script", selected.stub ?? "manual setup"] as const,
          ["Ownership", selected.ownership] as const,
        ] }] : []),
        { kind: "table", columns: [{ key: "shell", label: "Shell" }, { key: "state", label: "Integration" }], rows: status.shells.map((shell) => ({ shell: shell.shell, state: completionCell(shell) })) },
        { kind: "lines", lines: [
          ...dangling.map((shell) => ({ text: `${shell.wiredIn} sources ${shell.stub}, which is missing.`, tone: "waiting" as const })),
          ...status.shells.filter((shell) => shell.legacyWiring).map((shell) => ({ text: `Custom ${shell.shell} wiring needs manual migration to: ${LOAD_NOW[shell.shell]}`, tone: "waiting" as const })),
          { text: "Files only. The running shell was not inspected or changed.", tone: "hint" },
        ] },
      ] },
      { title: "Next", blocks: [{ kind: "commands", items: [
        { command: `cotal completion install ${selected?.shell ?? "<shell>"}`, description: "Install or refresh the managed integration" },
        { command: `cotal completion script ${selected?.shell ?? "<shell>"}`, description: "Print the script for manual setup" },
        { command: `cotal completion uninstall ${selected?.shell ?? "<shell>"}`, description: "Remove only unchanged recorded material" },
      ] }] },
    ],
  };
}

/** Argument completion for `cotal completion` itself: its subcommands, then the shells. */
export function completionComplete(argv: string[]): CompletionResult {
  const shells = Object.keys(SCRIPTS).map((value) => ({ value }));
  if (argv.length <= 1)
    return {
      items: [
        { value: "script", description: "print the stub for a shell" },
        { value: "install", description: "install or refresh unchanged owned files" },
        { value: "uninstall", description: "remove unchanged owned completion" },
      ],
      directive: "nofiles",
    };
  if (argv.length === 2 && (argv[0] === "script" || argv[0] === "install" || argv[0] === "uninstall")) return { items: argv[0] === "script" || process.platform !== "win32" ? shells : shells.filter((item) => item.value !== "powershell"), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}
