import type { Command, FlagSpec, ParsedArgs } from "@cotal-ai/core";

export function typographicOptionParts(word: string): { name: string; value?: string } | undefined {
  const match = /^[\u2010-\u2015\u2212][-\u2010-\u2015\u2212]*([^=]+)(?:=(.*))?$/su.exec(word);
  return match ? { name: match[1]!, value: match[2] } : undefined;
}

export function shortEqualsOptionParts(word: string): { short: string; value: string } | undefined {
  const match = /^-([^-=])=(.*)$/su.exec(word);
  return match ? { short: match[1]!, value: match[2]! } : undefined;
}

/** Read command words and declared options for help, completion and refusals, without validating an invocation. */
export function metadataPositionals(cmd: Pick<Command, "flags">, argv: readonly string[], options: { completing?: boolean; refusalGlobalFlags?: readonly string[] } = {}) {
  const positionals: { value: string; index: number }[] = [];
  const values: ParsedArgs["values"] = Object.create(null);
  const seenStrings = options.refusalGlobalFlags && new Set<string>();
  let valueFlag: FlagSpec | undefined;
  let optionsEnded = false;
  const takeOption = (flag: FlagSpec, inline: string | undefined, index: number, validSpelling = true): number => {
    if (seenStrings && flag.type === "string" && !flag.multiple) {
      // A refused repeat does not select either value, even when an occurrence had no value.
      if (seenStrings.has(flag.name)) {
        delete values[flag.name];
        validSpelling = false;
      }
      seenStrings.add(flag.name);
    }
    if (flag.type === "boolean") {
      if (validSpelling && inline === undefined) values[flag.name] = true;
    } else if (inline !== undefined) {
      if (validSpelling) values[flag.name] = inline;
    } else {
      if (index >= argv.length - 2) valueFlag = flag;
      const next = argv[index + 1];
      // A missing value must not hide the next option or swallow the separator in a refusal.
      if (next !== undefined && (options.completing || !next.startsWith("-") || next === "-" || /^-\d/.test(next))) {
        if (validSpelling) values[flag.name] = next;
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
      const shortEquals = options.refusalGlobalFlags && shortEqualsOptionParts(word);
      for (let offset = 0; offset < cluster.length; offset++) {
        const flag = cmd.flags?.find((item) => item.short === cluster[offset]);
        if (!flag) continue;
        const inline = flag.type === "string" ? cluster.slice(offset + 1) || undefined : undefined;
        index = takeOption(flag, inline, index, !shortEquals || flag.type !== "string");
        if (flag.type === "string") break;
      }
    } else {
      const typed = options.refusalGlobalFlags && !optionsEnded ? typographicOptionParts(word) : undefined;
      const flag = typed && (cmd.flags?.find((item) => item.name === typed.name) ?? cmd.flags?.find((item) => item.short === typed.name));
      // A misspelled option and its operand do not name the command's target or select its output.
      if (typed && flag) index = takeOption(flag, typed.value, index, false);
      else if (!typed || !options.refusalGlobalFlags?.includes(typed.name)) positionals.push({ value: word, index });
    }
  }
  return { positionals, values, valueFlag, optionsEnded };
}
