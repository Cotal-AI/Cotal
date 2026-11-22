import type { Command, FlagSpec, ParsedArgs } from "@cotal-ai/core";

/** Read command words and declared options for help, completion and refusals, without validating an invocation. */
export function metadataPositionals(cmd: Pick<Command, "flags">, argv: readonly string[], options: { completing?: boolean } = {}) {
  const positionals: { value: string; index: number }[] = [];
  const values: ParsedArgs["values"] = Object.create(null);
  let valueFlag: FlagSpec | undefined;
  let optionsEnded = false;
  const takeOption = (flag: FlagSpec, inline: string | undefined, index: number): number => {
    if (flag.type === "boolean") {
      if (inline === undefined) values[flag.name] = true;
    } else if (inline !== undefined) values[flag.name] = inline;
    else {
      if (index >= argv.length - 2) valueFlag = flag;
      const next = argv[index + 1];
      // A missing value must not hide the next option or swallow the separator in a refusal.
      if (next !== undefined && (options.completing || !next.startsWith("-") || next === "-" || /^-\d/.test(next))) {
        values[flag.name] = next;
        return index + 1;
      }
    }
    return index;
  };
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]!;
    // Completion includes the unfinished cursor word; only an earlier separator is committed.
    if (!optionsEnded && word === "--" && (!options.completing || index < argv.length - 1)) { optionsEnded = true; continue; }
    if (!optionsEnded && word.startsWith("--")) {
      const equals = word.indexOf("=");
      const name = equals === -1 ? word.slice(2) : word.slice(2, equals);
      const flag = cmd.flags?.find((item) => item.name === name);
      if (flag) index = takeOption(flag, equals === -1 ? undefined : word.slice(equals + 1), index);
    } else if (!optionsEnded && word.startsWith("-") && word !== "-") {
      const cluster = word.slice(1);
      for (let offset = 0; offset < cluster.length; offset++) {
        const flag = cmd.flags?.find((item) => item.short === cluster[offset]);
        if (!flag) continue;
        index = takeOption(flag, flag.type === "string" ? cluster.slice(offset + 1) || undefined : undefined, index);
        if (flag.type === "string") break;
      }
    } else positionals.push({ value: word, index });
  }
  return { positionals, values, valueFlag, optionsEnded };
}
