import type { Command, FlagSpec } from "@cotal-ai/core";

/** Split a typographic option for its diagnostic and for refusal-only operand recovery. */
export function typographicOptionParts(word: string): { name: string; value: string | undefined } | undefined {
  const match = /^[\u2010-\u2015\u2212][-\u2010-\u2015\u2212]*([^=]+)(?:=(.*))?$/su.exec(word);
  return match ? { name: match[1]!, value: match[2] } : undefined;
}

/** Read metadata paths without interpreting option values as command words or running a validator. */
export function metadataPositionals(cmd: Pick<Command, "flags">, argv: readonly string[], options: {
  completing?: boolean;
  refusal?: { flags: Set<string>; values: Map<string, string> };
} = {}) {
  const positionals: { value: string; index: number }[] = [];
  const refusal = options.refusal;
  let valueFlag: FlagSpec | undefined;
  let optionsEnded = false;
  const takeValue = (flag: FlagSpec, index: number, malformed = false): number => {
    const next = argv[index + 1];
    // A dash-leading value must be attached, except negative numbers and the single dash.
    if (refusal && next !== undefined && next.startsWith("-") && next !== "-" && !/^-\d/u.test(next)) return index;
    if (index + 1 === argv.length - 1 || index === argv.length - 1) valueFlag = flag;
    if (!malformed && next !== undefined) refusal?.values.set(flag.name, next);
    return index + 1;
  };
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index]!;
    // Completion includes the unfinished cursor word; only an earlier separator is committed.
    if (!optionsEnded && word === "--" && (!options.completing || index < argv.length - 1)) { optionsEnded = true; continue; }
    if (!optionsEnded && refusal) {
      const typed = typographicOptionParts(word);
      if (typed) {
        const flag = cmd.flags?.find(({ name }) => name === typed.name) ?? cmd.flags?.find(({ short }) => short === typed.name);
        if (flag) {
          if (flag.type === "string" && typed.value === undefined) index = takeValue(flag, index, true);
          continue;
        }
      }
    }
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
        // A short option written as -s=value is refused, so do not report its value as a target.
        else if (offset !== 0 || cluster[1] !== "=") refusal?.values.set(flag.name, cluster.slice(offset + 1));
        break;
      }
    } else positionals.push({ value: word, index });
  }
  return { positionals, valueFlag, optionsEnded };
}
