import {
  registry,
  type Command,
  type CompletionItem,
  type CompletionResult,
} from "@cotal-ai/core";
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
 *   cotal __complete <words…>                   # internal: emit candidates for the cursor
 *
 * `__complete` is import-light and side-effect-free by contract — persona completion is a
 * filesystem read, never a mesh connection — so a keystroke never blocks on the network.
 */

/** Wire format: one `value\tdescription` (or bare `value`) per line, then a `:directive`
 *  trailer the stub reads (`:nofiles` / `:nospace` / `:default`). */
function emit(items: CompletionItem[], directive: NonNullable<CompletionResult["directive"]>): void {
  const lines = items.map((i) => (i.description ? `${i.value}\t${i.description}` : i.value));
  lines.push(`:${directive}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** The hidden dispatcher the shell stubs call. `argv` is the words after `cotal`, up to and
 *  including the (possibly empty) word being completed. */
export async function complete(argv: string[]): Promise<void> {
  const commands = registry.all<Command>("command").filter((cmd) => !cmd.name.startsWith("__"));
  // Word 0 (the command name itself): offer the command names.
  if (argv.length <= 1) {
    emit(commands.map((cmd) => ({ value: cmd.name, description: cmd.summary })), "nofiles");
    return;
  }
  const cmd = commands.find((cmd) => cmd.name === argv[0]);
  if (!cmd?.complete) {
    emit([], "default"); // unknown command, or one with no completer → defer to the shell
    return;
  }
  try {
    const res = await cmd.complete(argv.slice(1));
    emit(res.items, res.directive ?? "nofiles");
  } catch {
    emit([], "default"); // a throwing completer yields nothing — never noisy on stderr/stdout
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

export async function completion(argv: string[]): Promise<void> {
  const script = argv[0] ? SCRIPTS[argv[0]] : undefined;
  if (!script) {
    console.error(c.red("usage: cotal completion <bash|zsh|fish|powershell>"));
    console.error(c.dim("  enable it now (this shell):"));
    console.error(c.dim("    bash/zsh:  source <(cotal completion bash)"));
    console.error(c.dim("    fish:      cotal completion fish | source"));
    console.error(c.dim("    pwsh:      cotal completion powershell | Out-String | Invoke-Expression"));
    process.exit(1);
  }
  process.stdout.write(script);
}

/** Argument completion for `cotal completion` itself: the supported shells. */
export function completionComplete(argv: string[]): CompletionResult {
  if (argv.length <= 1)
    return { items: Object.keys(SCRIPTS).map((value) => ({ value })), directive: "nofiles" };
  return { items: [], directive: "nofiles" };
}

function lines(...l: string[]): string {
  return `${l.join("\n")}\n`;
}
