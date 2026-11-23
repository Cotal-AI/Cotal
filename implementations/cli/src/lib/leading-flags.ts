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

function commandWordIndex(argv: readonly string[]): number {
  let lead = 0;
  while (lead < argv.length && (OUTPUT_FLAG_WORDS.has(argv[lead]!) || GLOBAL_FLAG_WORDS.has(argv[lead]!))) lead++;
  return argv[lead] === "--" ? lead + 1 : lead;
}

/** The command word of `argv` as `runCli` reads it: the first word after the leading output and
 *  global flags and a `--` that ends them, or undefined when `argv` names none. */
export function commandWord(argv: readonly string[]): string | undefined {
  return argv[commandWordIndex(argv)];
}

export function isHelpFlag(word: string | undefined): boolean {
  return word === "--help" || word === "-h";
}

/** A `--` in the command's args ends its options, so a help flag after it is an operand. */
export function asksForHelp(args: readonly string[]): boolean {
  for (const word of args) {
    if (word === "--") break;
    if (isHelpFlag(word)) return true;
  }
  return false;
}

/** Whether the command word or its options request help. */
export function helpRequested(argv: readonly string[]): boolean {
  const lead = commandWordIndex(argv);
  const word = argv[lead];
  return word === "help" || isHelpFlag(word) || asksForHelp(argv.slice(lead + 1));
}
