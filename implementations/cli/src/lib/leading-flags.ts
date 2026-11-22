import { parseCommandArgs, type Command, type ParsedArgs } from "@cotal-ai/core";
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
const GLOBAL_OPTIONS = GLOBAL_FLAGS.map((name) => ({ name, type: "boolean" } as const));

/** Parse with global option boundaries intact and give the command only its own arguments. */
export function parseWithGlobalFlags(cmd: Command, words: string[]): ParsedArgs {
  const end = words.indexOf("--");
  const raw: string[] = [];
  const indices: number[] = [];
  const globalWords = new Set<string>();
  for (const [index, word] of words.entries()) {
    if ((end < 0 || index < end) && GLOBAL_FLAG_WORDS.has(word)) {
      globalWords.add(word);
      continue;
    }
    indices[index] = raw.length;
    raw.push(word);
  }
  if (!globalWords.size) return parseCommandArgs(cmd, words);
  const globals = GLOBAL_OPTIONS.filter(({ name }) => globalWords.has(`--${name}`));
  const parsed = parseCommandArgs({ ...cmd, flags: [...(cmd.flags ?? []), ...globals] }, words);
  for (const { name } of globals) delete parsed.values[name];
  return { ...parsed, raw, positionalIndices: parsed.positionalIndices?.map((index) => indices[index]!) };
}

/** The command word of `argv` as `runCli` reads it: the first word after the leading output and
 *  global flags and a `--` that ends them, or undefined when `argv` names none. */
export function commandWord(argv: readonly string[]): string | undefined {
  let lead = 0;
  while (lead < argv.length && (OUTPUT_FLAG_WORDS.has(argv[lead]!) || GLOBAL_FLAG_WORDS.has(argv[lead]!))) lead++;
  return argv[argv[lead] === "--" ? lead + 1 : lead];
}
