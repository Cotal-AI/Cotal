import type { Command, FlagSpec } from "@cotal-ai/core";

/** Read positionals and string options for discovery without accepting or validating input. */
export function metadataPositionals(cmd: Pick<Command, "flags">, argv: readonly string[], options: { completing?: boolean } = {}) {
  const positionals: { value: string; index: number }[] = [];
  const stringOptions: { name: string; value: string | undefined }[] = [];
  let valueFlag: FlagSpec | undefined;
  let optionsEnded = false;
  let index = 0;
  const readValue = (flag: FlagSpec): string | undefined => {
    const next = argv[index + 1];
    // A missing value must not hide the following option or the end-of-options separator.
    const cursor = options.completing && index + 1 === argv.length - 1;
    if (next !== undefined && !cursor && next.startsWith("-") && next !== "-" && !/^-\d/.test(next)) return undefined;
    if (index >= argv.length - 2) valueFlag = flag;
    if (next !== undefined) index++;
    return next;
  };
  for (; index < argv.length; index++) {
    const word = argv[index]!;
    // Completion includes the unfinished cursor word; only an earlier separator is committed.
    if (!optionsEnded && word === "--" && (!options.completing || index < argv.length - 1)) { optionsEnded = true; continue; }
    if (!optionsEnded && word.startsWith("--")) {
      const equals = word.indexOf("=");
      const flag = cmd.flags?.find((item) => item.name === word.slice(2, equals === -1 ? undefined : equals));
      if (flag?.type === "string") stringOptions.push({ name: flag.name, value: equals === -1 ? readValue(flag) : word.slice(equals + 1) });
    } else if (!optionsEnded && word.startsWith("-") && word !== "-") {
      const cluster = word.slice(1);
      for (let offset = 0; offset < cluster.length; offset++) {
        const flag = cmd.flags?.find((item) => item.short === cluster[offset]);
        if (flag?.type !== "string") continue;
        stringOptions.push({ name: flag.name, value: offset === cluster.length - 1 ? readValue(flag) : cluster.slice(offset + 1) });
        break;
      }
    } else positionals.push({ value: word, index });
  }
  return { positionals, stringOptions, valueFlag, optionsEnded };
}
