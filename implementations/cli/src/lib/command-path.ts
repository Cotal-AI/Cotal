import type { Command, FlagSpec, ParsedArgs } from "@cotal-ai/core";

/** Read metadata paths without interpreting option values as command words or running a validator. */
export function metadataPositionals(cmd: Pick<Command, "flags">, argv: readonly string[], options: { completing?: boolean; forRefusal?: boolean } = {}) {
  const positionals: { value: string; index: number }[] = [];
  const values: ParsedArgs["values"] = {};
  let valueFlag: FlagSpec | undefined;
  let optionsEnded = false;
  const takeNext = (flag: FlagSpec, index: number, standalone: boolean): boolean => {
    const value = argv[index + 1];
    if (index >= argv.length - 2) valueFlag = flag;
    // In a refusal, an option missing its operand must not hide the next option or separator.
    if (options.forRefusal && value?.startsWith("-") && value !== "-" && !(standalone && /^-\d/.test(value))) return false;
    values[flag.name] = value;
    return true;
  };
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]!;
    // Completion includes the unfinished cursor word; only an earlier separator is committed.
    if (!optionsEnded && word === "--" && (!options.completing || index < argv.length - 1)) { optionsEnded = true; continue; }
    if (!optionsEnded && word.startsWith("--")) {
      const equals = word.indexOf("=");
      const flag = cmd.flags?.find((item) => item.name === (equals === -1 ? word.slice(2) : word.slice(2, equals)));
      if (flag?.type === "boolean" && equals === -1) values[flag.name] = true;
      if (flag?.type !== "string") continue;
      if (equals !== -1) values[flag.name] = word.slice(equals + 1);
      else if (takeNext(flag, index, true)) index++;
    } else if (!optionsEnded && word.startsWith("-") && word !== "-") {
      const cluster = word.slice(1);
      for (let offset = 0; offset < cluster.length; offset++) {
        const flag = cmd.flags?.find((item) => item.short === cluster[offset]);
        if (flag?.type === "boolean") values[flag.name] = true;
        if (flag?.type !== "string") continue;
        if (offset < cluster.length - 1) values[flag.name] = cluster.slice(offset + 1);
        else if (takeNext(flag, index, cluster.length === 1)) index++;
        break;
      }
    } else positionals.push({ value: word, index });
  }
  return { positionals, values, valueFlag, optionsEnded };
}
