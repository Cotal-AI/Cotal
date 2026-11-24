import type { Command, FlagSpec } from "@cotal-ai/core";

/** Read metadata paths without treating flag values as command words. A caller can supply recognized
 *  option spellings for attribution only, without changing the original arguments. */
export function metadataPositionals(cmd: Pick<Command, "flags">, argv: readonly string[], options: {
  completing?: boolean;
  optionSpelling?: (word: string) => string | undefined;
} = {}) {
  const positionals: { value: string; index: number }[] = [];
  let valueFlag: FlagSpec | undefined;
  let optionsEnded = false;
  for (let index = 0; index < argv.length; index++) {
    const spelling = optionsEnded ? undefined : options.optionSpelling?.(argv[index]!);
    const word = spelling ?? argv[index]!;
    const next = argv[index + 1];
    // A real string option may take a literal word with a typographic dash as its value.
    const takesNextWord = !options.optionSpelling || next === undefined || next === "-" || /^-\d/.test(next)
      || (!next.startsWith("-") && (!spelling || !options.optionSpelling(next)));
    // Completion includes the unfinished cursor word; only an earlier separator is committed.
    if (!optionsEnded && word === "--" && (!options.completing || index < argv.length - 1)) { optionsEnded = true; continue; }
    if (!optionsEnded && word.startsWith("--")) {
      const flag = cmd.flags?.find((item) => item.name === word.slice(2).split("=")[0]);
      if (flag?.type === "string" && !word.includes("=") && takesNextWord) {
        if (index + 1 === argv.length - 1 || index === argv.length - 1) valueFlag = flag;
        index++;
      }
    } else if (!optionsEnded && word.startsWith("-") && word !== "-") {
      const cluster = word.slice(1);
      for (let offset = 0; offset < cluster.length; offset++) {
        const flag = cmd.flags?.find((item) => item.short === cluster[offset]);
        if (flag?.type !== "string") continue;
        if (offset === cluster.length - 1 && takesNextWord) {
          if (index + 1 === argv.length - 1 || index === argv.length - 1) valueFlag = flag;
          index++;
        }
        break;
      }
    } else positionals.push({ value: word, index });
  }
  return { positionals, valueFlag, optionsEnded };
}
