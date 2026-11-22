import type { Command, FlagSpec } from "@cotal-ai/core";

/** Read metadata paths without interpreting option values as command words or running a validator. */
export function metadataPositionals(cmd: Pick<Command, "flags">, argv: readonly string[], options: { completing?: boolean } = {}) {
  const positionals: { value: string; index: number }[] = [];
  let valueFlag: FlagSpec | undefined;
  let ambiguousValue: { flag: FlagSpec; value: string } | undefined;
  let optionsEnded = false;
  const readValue = (index: number, flag: FlagSpec, acceptsNegative: boolean): number => {
    const next = argv[index + 1];
    if (!options.completing && next?.startsWith("-") && next !== "-" && !(acceptsNegative && /^-\d/.test(next))) {
      ambiguousValue ??= { flag, value: next };
      return index;
    }
    if (index + 1 === argv.length - 1 || index === argv.length - 1) valueFlag = flag;
    return index + 1;
  };
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]!;
    // Completion includes the unfinished cursor word; only an earlier separator is committed.
    if (!optionsEnded && word === "--" && (!options.completing || index < argv.length - 1)) { optionsEnded = true; continue; }
    if (!optionsEnded && word.startsWith("--")) {
      const flag = cmd.flags?.find((item) => item.name === word.slice(2).split("=")[0]);
      if (flag?.type === "string" && !word.includes("=")) index = readValue(index, flag, true);
    } else if (!optionsEnded && word.startsWith("-") && word !== "-") {
      const cluster = word.slice(1);
      for (let offset = 0; offset < cluster.length; offset++) {
        const flag = cmd.flags?.find((item) => item.short === cluster[offset]);
        if (flag?.type !== "string") continue;
        if (offset === cluster.length - 1) index = readValue(index, flag, cluster.length === 1);
        break;
      }
    } else positionals.push({ value: word, index });
  }
  return { positionals, valueFlag, ambiguousValue, optionsEnded };
}
