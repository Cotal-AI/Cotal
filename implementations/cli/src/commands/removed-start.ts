import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { ParsedArgs } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";
import { displayCmd } from "../lib/self-exec.js";
import { retryWord, spawnFlags } from "./spawn-flags.js";

const retryOptions: ParseArgsOptionsConfig = {
  ...Object.fromEntries(spawnFlags.map(({ name, ...flag }) => [name, flag])),
  "no-color": { type: "boolean" },
  "no-input": { type: "boolean" },
};

function parseLegacyOptions(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: retryOptions, allowPositionals: false, tokens: true });
  } catch { return undefined; }
}

function startRetry(argv: readonly string[]): string | undefined {
  const parsed = parseLegacyOptions(argv);
  if (!parsed) return undefined;
  const { values, tokens } = parsed;
  const config = typeof values.config === "string" ? values.config : undefined;
  const name = typeof values.name === "string" ? values.name : undefined;
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option" || retryOptions[token.name]?.multiple) continue;
    if (seen.has(token.name)) return undefined;
    seen.add(token.name);
  }
  if (values.foreground || (config && values.file) || (config && !config.trim())) return undefined;
  const persona = values.file ? undefined : config || name?.trim();
  const file = persona && /[\\/]|\.md$/.test(persona) ? persona : undefined;
  const args: string[] = [];
  if (persona && !file && !persona.startsWith("-")) args.push(persona);
  if (!values.detach) args.push("--detach");
  if (file) args.push(...(file.startsWith("-") ? [`--file=${file}`] : ["--file", file]));
  const omit = new Set<number>();
  for (const token of tokens) {
    if (token.kind === "option-terminator") omit.add(token.index);
    if (token.kind !== "option" || token.name !== "config") continue;
    omit.add(token.index);
    if (!token.inlineValue) omit.add(token.index + 1);
  }
  args.push(...argv.filter((_, index) => !omit.has(index)));
  if (persona?.startsWith("-") && !file) args.push("--", persona);
  return `${displayCmd({ fromAnyFolder: true })} spawn ${args.map(retryWord).join(" ")}`;
}

/** Refuse the removed verb during validation without launching or installing anything. */
export function refuseRemovedStart(args: ParsedArgs): never {
  const retry = startRetry(args.raw);
  throw new CommandFailure("refused", "USAGE_INVALID", "`cotal start` was removed. Use `cotal spawn --detach` to launch through a manager.", {
    remedy: retry ?? "Pass the catalog name as a positional argument or use --file for a persona file. Keep the other launch options.",
    ...(retry ? { remedyIsCommand: true } : {}),
    selfContained: true,
  });
}
