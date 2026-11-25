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

function leadingFlagCount(argv: readonly string[], forRefusal = false): number {
  let lead = 0;
  for (const word of argv) {
    // Only refusal rendering can look past a switch with an attached value.
    const flag = forRefusal ? word.split("=", 1)[0]! : word;
    if (!OUTPUT_FLAG_WORDS.has(flag) && !GLOBAL_FLAG_WORDS.has(flag)) break;
    lead++;
  }
  return lead;
}

function commandIndex(argv: readonly string[], lead: number): number {
  return argv[lead] === "--" ? lead + 1 : lead;
}

export function leadingInvocation(argv: readonly string[], forRefusal = false) {
  const lead = leadingFlagCount(argv, forRefusal);
  const command = commandIndex(argv, lead);
  const original = argv[command];
  const word = original === "--version" || original === "-V" ? "version"
    : original === "--help" || original === "-h" ? "help" : original;
  const args = argv.slice(command + 1);
  return { leading: argv.slice(0, lead), original, word, args };
}

/** The command word of `argv` as `runCli` reads it: the first word after the leading output and
 *  global flags and a `--` that ends them, or undefined when `argv` names none. */
export function commandWord(argv: readonly string[]): string | undefined {
  return argv[commandIndex(argv, leadingFlagCount(argv))];
}

/** Whether `args` ask for help: `--help` or `-h` before any `--`, after which every word is text. */
export function asksForHelp(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  return options.includes("--help") || options.includes("-h");
}
