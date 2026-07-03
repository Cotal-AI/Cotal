import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { Extension } from "./registry.js";

/** One shell-completion candidate. `value` is inserted on the command line; `description`
 *  is a one-line hint shown by shells that support it (zsh, fish) and ignored by bash. */
export interface CompletionItem {
  value: string;
  description?: string;
}

/** What a command's {@link Command.complete} returns for the current cursor position: the
 *  candidates, plus a directive telling the shell glue how to treat them.
 *  - `nofiles` (the norm for our completions): don't fall back to filename completion.
 *  - `nospace`: don't append a trailing space (the value is a prefix, e.g. `owner/`).
 *  - `default`: normal behaviour (a trailing space is added; files may be offered). */
export interface CompletionResult {
  items: CompletionItem[];
  directive?: "default" | "nospace" | "nofiles";
}

/** One declared flag. The single source for parsing, `--help`, usage errors, and flag
 *  completion — a command never hand-rolls `parseArgs` for a declared flag. */
export interface FlagSpec {
  /** Long name without dashes (`space`, `dry-run`). */
  readonly name: string;
  readonly type: "string" | "boolean";
  /** Single-character short alias (`f` for `-f`). */
  readonly short?: string;
  /** Metavar shown in help for string flags, e.g. `<url>`. Defaults to `<value>`. */
  readonly value?: string;
  /** One-line help text. */
  readonly description?: string;
}

/** What a command's `run` receives: the declared flags parsed strictly (an undeclared flag is
 *  a usage error rendered by the dispatcher), the positionals, and the raw argv for the rare
 *  command that needs it verbatim (e.g. the completion dispatcher). */
export interface ParsedArgs {
  readonly values: Record<string, string | boolean | undefined>;
  readonly positionals: string[];
  readonly raw: readonly string[];
}

/**
 * The contract for a composable CLI command — an {@link Extension} of kind
 * `"command"`. An implementation (the mesh CLI, the manager …) self-registers its
 * commands on import; the `cotal` binary resolves them from the registry.
 */
export interface Command extends Extension {
  readonly kind: "command";
  readonly name: string;
  readonly summary: string;
  /** Help grouping header (e.g. "Mesh", "Control plane"). Defaults to "Commands". */
  readonly group?: string;
  /** Overrides the generated usage line — for sub-grammar commands
   *  (`send <dm <agent> | msg <channel> | ask <role>> "<text>"`) the generator can't express. */
  readonly usage?: string;
  /** Hide from the top-level help listing while keeping it runnable — for dev/test aids
   *  (e.g. `demo`) that clutter the surface but stay documented and invocable. */
  readonly hidden?: boolean;
  /** Declared flags — parsed by the dispatcher ({@link parseCommandArgs}), rendered into help
   *  and completion. Omit for a command that takes no flags. */
  readonly flags?: readonly FlagSpec[];
  /** Positionals help label (e.g. `"<name-or-path>"`, `"<subcommand> …"`). Present ⇒
   *  positionals are allowed; absent ⇒ a stray positional is a usage error. */
  readonly positionals?: string;
  /** Skip parsing: `run` sees only {@link ParsedArgs.raw}/`positionals` verbatim. For the
   *  completion dispatcher, whose argv is another command's half-typed line. */
  readonly rawArgs?: boolean;
  run(args: ParsedArgs): Promise<void>;
  /** Optional shell-completion provider, owned by the command exactly as `run` is. Given the
   *  args typed so far (everything after the command name; the last element is the word being
   *  completed, possibly empty), returns the candidates for that position. Runs on every <TAB>
   *  via the hidden `__complete` dispatcher, so it MUST be import-light and side-effect-free —
   *  no network, no spawns. Omit it to offer no argument completion for this command.
   *  Flag-name candidates are generated from {@link Command.flags} by the dispatcher; this hook
   *  only supplies positional/value candidates. */
  complete?(argv: string[]): CompletionResult | Promise<CompletionResult>;
}

/** Parse `argv` against a command's declared flags — strict: an undeclared flag or a stray
 *  positional (when the command declares none) throws `parseArgs`' usage error, which the
 *  dispatcher renders as one red line plus the command's help. */
export function parseCommandArgs(cmd: Command, argv: string[]): ParsedArgs {
  if (cmd.rawArgs) return { values: {}, positionals: [...argv], raw: argv };
  const options: ParseArgsOptionsConfig = {};
  for (const f of cmd.flags ?? []) {
    options[f.name] = f.short ? { type: f.type, short: f.short } : { type: f.type };
  }
  const { values, positionals } = parseArgs({
    args: [...argv],
    options,
    allowPositionals: cmd.positionals !== undefined,
    strict: true,
  });
  return { values: values as ParsedArgs["values"], positionals, raw: argv };
}

/** The generated usage line: `cotal <name> [<positionals>] [flags…]`, honoring an explicit
 *  {@link Command.usage} override. One source for `--help` and usage errors. */
export function commandUsage(cmd: Command): string {
  if (cmd.usage) return cmd.usage;
  const parts = [`cotal ${cmd.name}`];
  if (cmd.positionals) parts.push(cmd.positionals);
  for (const f of cmd.flags ?? []) {
    const long = `--${f.name}`;
    const metavar = f.type === "string" ? ` ${f.value ?? "<value>"}` : "";
    parts.push(`[${f.short ? `-${f.short}|` : ""}${long}${metavar}]`);
  }
  return parts.join(" ");
}
