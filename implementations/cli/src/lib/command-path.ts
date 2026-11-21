import type { Command, FlagSpec } from "@cotal-ai/core";

/** Read metadata paths without interpreting option values as command words or running a validator. */
export function metadataPositionals(cmd: Pick<Command, "flags">, argv: readonly string[], options: {
  completing?: boolean;
  refusal?: { flags: Set<string>; values: Map<string, string>; skipIndex?: number };
} = {}) {
  const positionals: { value: string; index: number }[] = [];
  const refusal = options.refusal;
  let valueFlag: FlagSpec | undefined;
  let optionsEnded = false;
  const takeValue = (flag: FlagSpec, index: number): number => {
    const next = argv[index + 1];
    // A dash-leading value must be attached, except negative numbers and the single dash.
    if (refusal && next !== undefined && next.startsWith("-") && next !== "-" && !/^-\d/u.test(next)) return index;
    if (index + 1 === argv.length - 1 || index === argv.length - 1) valueFlag = flag;
    if (next !== undefined) refusal?.values.set(flag.name, next);
    return index + 1;
  };
  for (let index = 0; index < argv.length; index++) {
    if (index === refusal?.skipIndex) continue;
    const word = argv[index]!;
    // Completion includes the unfinished cursor word; only an earlier separator is committed.
    if (!optionsEnded && word === "--" && (!options.completing || index < argv.length - 1)) { optionsEnded = true; continue; }
    if (!optionsEnded && word.startsWith("--")) {
      const equal = word.indexOf("=");
      const flag = cmd.flags?.find((item) => item.name === word.slice(2, equal === -1 ? undefined : equal));
      if (flag?.type === "boolean" && equal === -1) refusal?.flags.add(flag.name);
      if (flag?.type === "string" && equal === -1) index = takeValue(flag, index);
      else if (flag?.type === "string") refusal?.values.set(flag.name, word.slice(equal + 1));
    } else if (!optionsEnded && word.startsWith("-") && word !== "-") {
      const cluster = word.slice(1);
      for (let offset = 0; offset < cluster.length; offset++) {
        const flag = cmd.flags?.find((item) => item.short === cluster[offset]);
        if (flag?.type === "boolean") refusal?.flags.add(flag.name);
        if (flag?.type !== "string") continue;
        if (offset === cluster.length - 1) index = takeValue(flag, index);
        else refusal?.values.set(flag.name, cluster.slice(offset + 1));
        break;
      }
    } else positionals.push({ value: word, index });
  }
  return { positionals, valueFlag, optionsEnded };
}
