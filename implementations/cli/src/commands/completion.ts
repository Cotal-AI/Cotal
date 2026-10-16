import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  findCommand,
  findSubcommand,
  type Command,
  type CompletionItem,
  type CompletionResult,
  type FlagValues,
  type ParsedArgs,
} from "@cotal-ai/core";
import { CommandFailure, jsonFlag, plainFlag, presentationOf, writeResult, type Report, type Styled } from "@cotal-ai/workspace";
import { commandSurface } from "../ext-loader.js";
import { c } from "../ui.js";

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
 *   cotal completion install [shell]            # install it persistently (auto-detects $SHELL)
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
  const word = argv[argv.length - 1];
  if (cmd && word.startsWith("-") && !word.includes("=")) {
    const items = (cmd.flags ?? []).map((f) => ({ value: `--${f.name}`, description: f.description }));
    emit(items, "nofiles");
    return;
  }
  if (!cmd?.complete) {
    const items = (cmd?.flags ?? []).map((f) => ({ value: `--${f.name}`, description: f.description }));
    emit(items, items.length ? "nofiles" : "default");
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

const SCRIPTS: Record<string, string> = {
  bash: lines(
    "# cotal bash completion - forwards each <TAB> to `cotal __complete` (dynamic).",
    "_cotal_complete() {",
    '  local cur out line',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  local -a args=("${COMP_WORDS[@]:1:COMP_CWORD}")',
    '  out="$(cotal __complete "${args[@]}" 2>/dev/null)" || return',
    "  local -a values=()",
    "  while IFS= read -r line; do",
    '    [ -z "$line" ] && continue',
    '    case "$line" in',
    "      :nospace) compopt -o nospace 2>/dev/null ;;",
    "      :*) ;;",
    `      *) values+=("\${line%%$'\\t'*}") ;;`,
    "    esac",
    '  done <<< "$out"',
    '  COMPREPLY=($(compgen -W "${values[*]}" -- "$cur"))',
    "}",
    "complete -F _cotal_complete cotal",
  ),
  zsh: lines(
    "#compdef cotal",
    "# cotal zsh completion - forwards each <TAB> to `cotal __complete` (dynamic).",
    "_cotal() {",
    "  local -a args; args=(\"${(@)words[2,CURRENT]}\")",
    '  local out line val desc',
    '  out="$(cotal __complete "${args[@]}" 2>/dev/null)"',
    "  local -a descs",
    "  while IFS= read -r line; do",
    '    [[ -z "$line" || "$line" == :* ]] && continue',
    `    val="\${line%%$'\\t'*}"; desc="\${line#*$'\\t'}"`,
    '    if [[ "$desc" != "$line" ]]; then descs+=("$val:$desc"); else descs+=("$val"); fi',
    '  done <<< "$out"',
    "  (( ${#descs} )) && _describe -t cotal cotal descs",
    "}",
    "compdef _cotal cotal",
  ),
  fish: lines(
    "# cotal fish completion - forwards each <TAB> to `cotal __complete` (dynamic).",
    "function __cotal_complete",
    "    set -l tokens (commandline -opc) (commandline -ct)",
    "    cotal __complete $tokens[2..-1] 2>/dev/null | string match -rv '^:'",
    "end",
    "complete -c cotal -f -a '(__cotal_complete)'",
  ),
  powershell: lines(
    "# cotal PowerShell completion - forwards each <TAB> to `cotal __complete` (dynamic).",
    "Register-ArgumentCompleter -Native -CommandName cotal -ScriptBlock {",
    "    param($wordToComplete, $commandAst, $cursorPosition)",
    '    $elements = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { "$_" })',
    "    if (-not $wordToComplete) { $elements += '' }",
    "    $out = & cotal __complete @elements 2>$null",
    "    foreach ($line in $out) {",
    "        if ([string]::IsNullOrEmpty($line) -or $line.StartsWith(':')) { continue }",
    '        $parts = $line -split "`t", 2',
    "        $val = $parts[0]",
    '        if ($val -notlike "$wordToComplete*") { continue }',
    "        $desc = if ($parts.Length -gt 1) { $parts[1] } else { $val }",
    "        [System.Management.Automation.CompletionResult]::new($val, $val, 'ParameterValue', $desc)",
    "    }",
    "}",
  ),
};

export const completionFlags = [jsonFlag, plainFlag] as const;

/** The line that loads a shell's stub into the current shell only. */
const LOAD_NOW: Record<string, string> = {
  bash: "source <(cotal completion script bash)",
  zsh: "source <(cotal completion script zsh)",
  fish: "cotal completion script fish | source",
  powershell: "cotal completion script powershell | Out-String | Invoke-Expression",
};

/** `cotal completion [--json|--plain]`: whether each shell has the stub and loads it;
 *  `completion script <shell>`: the stub as raw shell code; `completion install [shell]`. A shell
 *  name in place of `script` is the form this release replaced, refused with its replacement. */
export async function completion(args: ParsedArgs): Promise<void> {
  const [sub, shell] = args.positionals;
  const values = args.values as FlagValues<typeof completionFlags>;
  if (sub === undefined) return writeResult(presentationOf(values), { command: "completion", target: null, result: completionStatus() }, statusView);
  if (values.json || values.plain)
    throw new CommandFailure("refused", "USAGE_INVALID", `cotal completion ${sub} takes no --json or --plain`, { remedy: "run `cotal completion --json` for the status" });
  if (sub === "install") return install(shell);
  if (sub === "script") {
    const script = shell === undefined ? undefined : SCRIPTS[shell];
    if (!script)
      throw new CommandFailure("refused", "USAGE_INVALID", shell === undefined ? "cotal completion script needs a shell" : `cotal completion script has no shell "${shell}"`, {
        remedy: `pass one of ${Object.keys(SCRIPTS).join(", ")}`,
      });
    process.stdout.write(script);
    return;
  }
  // `completion <shell>`: a hand-wired startup line from before `script`. Nothing on stdout, so a
  // process substitution sources nothing.
  throw new CommandFailure("refused", "USAGE_INVALID", `\`cotal completion ${sub}\` is now \`cotal completion script ${sub}\``, { remedy: `load it with: ${LOAD_NOW[sub]}` });
}

type StubState = "missing" | "current" | "differs";

/** One shell's completion as this machine has it. `loadedBy` is the file that sources the stub, or
 *  null when nothing does; fish loads its completions directory itself, and Cotal installs nothing
 *  for PowerShell, whose profile it does not edit. */
export interface ShellCompletion {
  readonly shell: string;
  readonly stub: string | null;
  readonly state: StubState | "not-installed-by-cotal";
  readonly loadedBy: string | null;
}

/** The stub file and the rc file that sources it, per shell Cotal installs for. */
function stubPaths(shell: string): { stub: string; rc?: string } | undefined {
  const config = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  if (shell === "fish") return { stub: join(config, "fish", "completions", "cotal.fish") };
  if (shell === "bash") return { stub: join(config, "cotal", "completion.bash"), rc: join(homedir(), ".bashrc") };
  if (shell === "zsh") return { stub: join(config, "cotal", "completion.zsh"), rc: join(process.env.ZDOTDIR || homedir(), ".zshrc") };
  return undefined;
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Each shell's stub against the script this binary prints. Reads local files only. */
export function completionStatus(): { shell: string | null; shells: ShellCompletion[] } {
  const shells = Object.keys(SCRIPTS).map((shell): ShellCompletion => {
    const paths = stubPaths(shell);
    if (!paths) return { shell, stub: null, state: "not-installed-by-cotal", loadedBy: null };
    const content = readIfPresent(paths.stub);
    const state: StubState = content === undefined ? "missing" : content === SCRIPTS[shell] ? "current" : "differs";
    const loadedBy = shell === "fish" ? (content === undefined ? null : dirname(paths.stub)) : paths.rc && readIfPresent(paths.rc)?.includes(`source "${paths.stub}"`) ? paths.rc : null;
    return { shell, stub: paths.stub, state, loadedBy };
  });
  const detected = basename(process.env.SHELL ?? "");
  return { shell: SCRIPTS[detected] ? detected : null, shells };
}

const STATE: Record<ShellCompletion["state"], Styled> = {
  current: { text: "current", tone: "ok" },
  differs: { text: "differs from this version", tone: "waiting" },
  missing: { text: "not installed", tone: "hint" },
  "not-installed-by-cotal": { text: "not installed by cotal", tone: "hint" },
};

function statusView(status: ReturnType<typeof completionStatus>): Report {
  return {
    sections: [
      {
        title: "Shell completion",
        blocks: [
          {
            kind: "table",
            columns: [
              { key: "shell", label: "SHELL" },
              { key: "state", label: "STUB" },
              { key: "loaded", label: "LOADED BY" },
              { key: "stub", label: "FILE" },
            ],
            rows: status.shells.map((s) => ({
              shell: s.shell === status.shell ? { text: `${s.shell} (this shell)`, tone: "selected" } : s.shell,
              state: STATE[s.state],
              loaded: s.loadedBy ?? (s.state === "current" || s.state === "differs" ? { text: "nothing", tone: "waiting" } : ""),
              stub: s.stub ?? "",
            })),
          },
          {
            kind: "lines",
            lines: [
              { text: "install: cotal completion install [shell]", tone: "hint" },
              { text: `this shell only: ${LOAD_NOW[status.shell ?? "bash"]}`, tone: "hint" },
            ],
          },
        ],
      },
    ],
  };
}

/** `cotal completion install [shell]` — wire the stub into your shell persistently. Opt-in (never
 *  run by `setup`). Auto-detects the shell from $SHELL when omitted; fails loud on an unknown or
 *  unsupported one (no silent guess). Idempotent — re-running once installed is a no-op. */
function install(shell?: string): void {
  const sh = shell ?? basename(process.env.SHELL ?? "");
  if (!SCRIPTS[sh]) {
    console.error(c.red(`can't install for "${sh || "unknown shell"}" - pass one of: bash, zsh, fish`));
    process.exit(1);
  }
  if (sh === "fish") {
    // Fish auto-loads files from its completions dir — drop the stub straight in (no rc edit).
    const file = stubPaths("fish")!.stub;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, SCRIPTS.fish);
    console.log(c.green("✓ installed fish completion"));
    console.log(c.dim(`  ${file}\n  open a new shell (or: source ${file})`));
    return;
  }
  if (sh === "bash" || sh === "zsh") {
    // Write the stub to a cached file and source THAT from the rc — deterministic (process
    // substitution is slower and empirically flaky on macOS bash) and fast (no `cotal` spawn on
    // every shell start). Re-running regenerates the stub; the rc line is added at most once.
    const { stub, rc } = stubPaths(sh) as { stub: string; rc: string };
    mkdirSync(dirname(stub), { recursive: true });
    writeFileSync(stub, SCRIPTS[sh]);
    const line = `source "${stub}"`;
    let current = "";
    try {
      current = readFileSync(rc, "utf8");
    } catch {
      /* rc doesn't exist yet — appendFileSync creates it */
    }
    if (current.includes(line)) {
      console.log(c.dim(`already installed in ${rc}`));
      console.log(c.dim(`  refreshed ${stub}`));
      return;
    }
    appendFileSync(rc, `${current && !current.endsWith("\n") ? "\n" : ""}# cotal shell completion\n${line}\n`);
    console.log(c.green(`✓ installed ${sh} completion`));
    console.log(c.dim(`  ${stub}\n  appended to ${rc}\n  open a new shell (or: source ${stub})`));
    return;
  }
  // powershell: $PROFILE isn't resolvable from here, so print the exact line rather than guess.
  console.error(c.red("auto-install isn't supported for powershell."));
  console.error(c.dim(`  add to your $PROFILE:  ${LOAD_NOW.powershell}`));
  process.exit(1);
}

/** Argument completion for `cotal completion` itself: its subcommands, then the shells. */
export function completionComplete(argv: string[]): CompletionResult {
  const shells = Object.keys(SCRIPTS).map((value) => ({ value }));
  if (argv.length <= 1)
    return {
      items: [
        { value: "script", description: "print the stub for a shell" },
        { value: "install", description: "install for your shell" },
      ],
      directive: "nofiles",
    };
  if (argv.length === 2 && (argv[0] === "script" || argv[0] === "install")) return { items: shells, directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}

function lines(...l: string[]): string {
  return `${l.join("\n")}\n`;
}
