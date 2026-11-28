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
export const TYPOGRAPHIC_OPTION = /^[\u2010-\u2015\u2212][-\u2010-\u2015\u2212]*([^=]+)(?:=(.*))?$/su;

function leadingFlagCount(argv: readonly string[], forRefusal = false): number {
  let lead = 0;
  for (const word of argv) {
    // Only refusal rendering can look past malformed switches. Keep their original argv words.
    const flag = forRefusal ? word.split("=", 1)[0]! : word;
    const name = forRefusal ? TYPOGRAPHIC_OPTION.exec(flag)?.[1] : undefined;
    const spelling = name === undefined ? flag : `${name.length === 1 ? "-" : "--"}${name}`;
    if (OUTPUT_FLAG_WORDS.has(spelling) || GLOBAL_FLAG_WORDS.has(spelling)) { lead++; continue; }
    // A mistyped help or version word is still a leading flag for the refusal, so it never hides the
    // command that asked for its JSON receipt. Stop at the next word, which is the command: these
    // spellings also request help and version, and reading past them would take the command word.
    const recovering = forRefusal && (spelling === "--help" || spelling === "-h" || spelling === "--version" || spelling === "-V");
    if (!recovering || argv[lead + 1] === undefined) break;
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
