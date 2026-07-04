import type { FlagSpec } from "@cotal-ai/core";

/** The string flag whose value is currently being completed, if the cursor is in one. */
export function completingFlagValue(argv: string[], flags: readonly FlagSpec[]): FlagSpec | undefined {
  const prev = argv[argv.length - 2];
  if (!prev) return undefined;
  const flag = flagForToken(prev, flags);
  return flag?.type === "string" ? flag : undefined;
}

/** Strip declared flags and their values, leaving the positional cursor shape for sub-grammars. */
export function positionalsForCompletion(argv: string[], flags: readonly FlagSpec[]): string[] {
  const out: string[] = [];
  let positionalOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (!positionalOnly && word === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly) {
      const inline = /^--([^=]+)=/.exec(word);
      if (inline && flagForLong(inline[1], flags)) continue;
      const flag = flagForToken(word, flags);
      if (flag) {
        if (flag.type === "string" && i + 1 < argv.length) i++;
        continue;
      }
    }
    out.push(word);
  }
  return out;
}

export function hasCompletedFlagValue(argv: string[], flags: readonly FlagSpec[], name: string): boolean {
  return completedFlagValue(argv, flags, name) !== undefined;
}

export function completedFlagValue(argv: string[], flags: readonly FlagSpec[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    const inline = /^--([^=]+)=(.*)$/.exec(word);
    if (inline) {
      const flag = flagForLong(inline[1], flags);
      if (flag?.name === name && inline[2] !== "") return inline[2];
      continue;
    }
    const flag = flagForToken(word, flags);
    if (flag?.name !== name || flag.type !== "string") continue;
    const value = argv[i + 1];
    if (value !== undefined && value !== "" && i + 1 < argv.length - 1) return value;
  }
  return undefined;
}

function flagForToken(token: string, flags: readonly FlagSpec[]): FlagSpec | undefined {
  if (token.startsWith("--")) return flagForLong(token.slice(2), flags);
  if (/^-[^-]$/.test(token)) return flags.find((f) => f.short === token.slice(1));
  return undefined;
}

function flagForLong(name: string, flags: readonly FlagSpec[]): FlagSpec | undefined {
  return flags.find((f) => f.name === name);
}
