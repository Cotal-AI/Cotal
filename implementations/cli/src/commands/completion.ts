import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type Command,
  type CompletionItem,
  type CompletionResult,
  type ParsedArgs,
} from "@cotal-ai/core";
import { commandSurface } from "../ext-loader.js";
import { c } from "../ui.js";

/**
 * Shell completion, the standard two-layer way (Cobra/Click/clap): a thin per-shell stub —
 * printed to stdout by `cotal completion <shell>`, installed once — that forwards each <TAB>
 * to the hidden `cotal __complete` dispatcher. The dispatcher returns live candidates, so
 * completion sees real data (your personas) that a static script never could.
 *
 * The stub is installed once; the protocol between it and `__complete` is line-oriented and
 * tolerant (unknown lines are ignored), so it can grow without anyone re-installing the stub.
 *
 *   cotal completion bash|zsh|fish|powershell   # print the stub to stdout
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
  const cmd = commands.find((cmd) => cmd.name === argv[0]);
  if (argv.length === 1 && cmd) return emitCommandCompletion(cmd, [""]);
  if (argv.length === 1) {
    emit(commands.map((cmd) => ({ value: cmd.name, description: cmd.summary })), "nofiles");
    return;
  }
  return emitCommandCompletion(cmd, argv.slice(1));
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
    "# cotal bash completion — forwards each <TAB> to `cotal __complete` (dynamic).",
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
    "# cotal zsh completion — forwards each <TAB> to `cotal __complete` (dynamic).",
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
    "# cotal fish completion — forwards each <TAB> to `cotal __complete` (dynamic).",
    "function __cotal_complete",
    "    set -l tokens (commandline -opc) (commandline -ct)",
    "    cotal __complete $tokens[2..-1] 2>/dev/null | string match -rv '^:'",
    "end",
    "complete -c cotal -f -a '(__cotal_complete)'",
  ),
  powershell: lines(
    "# cotal PowerShell completion — forwards each <TAB> to `cotal __complete` (dynamic).",
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

export async function completion(args: ParsedArgs): Promise<void> {
  const argv = args.positionals;
  if (argv[0] === "install") return install(argv[1]);
  const script = argv[0] ? SCRIPTS[argv[0]] : undefined;
  if (!script) {
    console.error(c.red("usage: cotal completion <bash|zsh|fish|powershell | install [shell]>"));
    console.error(c.dim("  enable it now (this shell):"));
    console.error(c.dim("    bash/zsh:  source <(cotal completion bash)"));
    console.error(c.dim("    fish:      cotal completion fish | source"));
    console.error(c.dim("    pwsh:      cotal completion powershell | Out-String | Invoke-Expression"));
    console.error(c.dim("  or install it persistently:  cotal completion install"));
    process.exit(1);
  }
  process.stdout.write(script);
}

/** `cotal completion install [shell]` — wire the stub into your shell persistently. Opt-in (never
 *  run by `setup`). Auto-detects the shell from $SHELL when omitted; fails loud on an unknown or
 *  unsupported one (no silent guess). Idempotent — re-running once installed is a no-op. */
function install(shell?: string): void {
  const sh = shell ?? basename(process.env.SHELL ?? "");
  if (!SCRIPTS[sh]) {
    console.error(c.red(`can't install for "${sh || "unknown shell"}" — pass one of: bash, zsh, fish`));
    process.exit(1);
  }
  if (sh === "fish") {
    // Fish auto-loads files from its completions dir — drop the stub straight in (no rc edit).
    const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fish", "completions");
    const file = join(dir, "cotal.fish");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, SCRIPTS.fish);
    console.log(c.green("✓ installed fish completion"));
    console.log(c.dim(`  ${file}\n  open a new shell (or: source ${file})`));
    return;
  }
  if (sh === "bash" || sh === "zsh") {
    // Write the stub to a cached file and source THAT from the rc — deterministic (process
    // substitution is slower and empirically flaky on macOS bash) and fast (no `cotal` spawn on
    // every shell start). Re-running regenerates the stub; the rc line is added at most once.
    const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cotal");
    const stub = join(dir, `completion.${sh}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stub, SCRIPTS[sh]);
    const rc = sh === "zsh" ? join(process.env.ZDOTDIR || homedir(), ".zshrc") : join(homedir(), ".bashrc");
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
  console.error(c.dim("  add to your $PROFILE:  cotal completion powershell | Out-String | Invoke-Expression"));
  process.exit(1);
}

/** Argument completion for `cotal completion` itself: the supported shells, plus `install`. */
export function completionComplete(argv: string[]): CompletionResult {
  const shells = Object.keys(SCRIPTS).map((value) => ({ value }));
  if (argv.length <= 1)
    return {
      items: [...shells, { value: "install", description: "install for your shell" }],
      directive: "nofiles",
    };
  if (argv[0] === "install") return { items: shells, directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}

function lines(...l: string[]): string {
  return `${l.join("\n")}\n`;
}
