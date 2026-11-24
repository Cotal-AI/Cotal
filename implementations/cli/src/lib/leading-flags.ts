import { GLOBAL_FLAGS } from "@cotal-ai/workspace";

/**
 * The words `cotal` reads before its command word. An output flag is the command's own and moves
 * after the word, a global flag ({@link GLOBAL_FLAGS}) applies whatever the command is, and a `--`
 * after them ends them. Any other word there is the command word. The dispatcher and a composition
 * root that imports only one command's modules read the word from these sets, so both read the same
 * word from one argv.
 */
export const OUTPUT_FLAG_WORDS: ReadonlySet<string> = new Set(["--json", "-j", "--plain"]);
export const GLOBAL_FLAG_WORDS: ReadonlySet<string> = new Set(GLOBAL_FLAGS.map((name) => `--${name}`));

/** The command word of `argv` as `runCli` reads it: the first word after the leading output and
 *  global flags and a `--` that ends them, or undefined when `argv` names none. */
export function commandWord(argv: readonly string[]): string | undefined {
  let lead = 0;
  while (lead < argv.length && (OUTPUT_FLAG_WORDS.has(argv[lead]!) || GLOBAL_FLAG_WORDS.has(argv[lead]!))) lead++;
  return argv[argv[lead] === "--" ? lead + 1 : lead];
}
