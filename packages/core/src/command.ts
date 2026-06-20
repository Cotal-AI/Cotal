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
  /** One-line usage shown by `cotal <cmd> --help` and on an invalid-argument error.
   *  Falls back to `summary` when unset. */
  readonly usage?: string;
  run(argv: string[]): Promise<void>;
  /** Optional shell-completion provider, owned by the command exactly as `run` is. Given the
   *  args typed so far (everything after the command name; the last element is the word being
   *  completed, possibly empty), returns the candidates for that position. Runs on every <TAB>
   *  via the hidden `__complete` dispatcher, so it MUST be import-light and side-effect-free —
   *  no network, no spawns. Omit it to offer no argument completion for this command. */
  complete?(argv: string[]): CompletionResult | Promise<CompletionResult>;
}
