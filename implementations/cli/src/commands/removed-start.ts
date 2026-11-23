import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { ParsedArgs } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";
import { displayCmd } from "../lib/self-exec.js";
import { retryWord, spawnFlags } from "./spawn-flags.js";
import { validateSpawnArguments } from "./spawn.js";

const retryOptions: ParseArgsOptionsConfig = {
  ...Object.fromEntries(spawnFlags.map(({ name, ...flag }) => [name, flag])),
  "no-color": { type: "boolean" },
  "no-input": { type: "boolean" },
};

function parseOptions(argv: readonly string[], allowPositionals = false) {
  try {
    return parseArgs({ args: [...argv], options: retryOptions, allowPositionals, tokens: true });
  } catch { return undefined; }
}

function startRetry(argv: readonly string[], parsed: NonNullable<ReturnType<typeof parseOptions>>, foreground: boolean): string | undefined {
  const { values, tokens } = parsed;
  const config = typeof values.config === "string" ? values.config : undefined;
  const name = typeof values.name === "string" ? values.name : undefined;
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option" || retryOptions[token.name]?.multiple) continue;
    if (seen.has(token.name)) return undefined;
    seen.add(token.name);
  }
  if (config !== undefined && (values.file !== undefined || !config.trim())) return undefined;
  const persona = values.file ? undefined : config || name?.trim();
  const file = persona && /[\\/]|\.md$/.test(persona) ? persona : undefined;
  const args: string[] = [];
  if (persona && !file && !persona.startsWith("-")) args.push(persona);
  if (foreground && !values.foreground) args.push("--foreground");
  if (!foreground && !values.detach) args.push("--detach");
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
  const candidate = parseOptions(args, true);
  if (!candidate) return undefined;
  try {
    validateSpawnArguments({ values: candidate.values as ParsedArgs["values"], positionals: candidate.positionals, raw: args });
  } catch (error) {
    if (error instanceof CommandFailure) return undefined;
    throw error;
  }
  return `${displayCmd({ fromAnyFolder: true })} spawn ${args.map(retryWord).join(" ")}`;
}

/** Refuse the removed verb during validation without launching or installing anything. */
export function refuseRemovedStart(args: ParsedArgs): never {
  const parsed = parseOptions(args.raw);
  const foregroundFlags = spawnFlags.filter(flag => "foregroundOnly" in flag && parsed?.values[flag.name] !== undefined);
  const flagNames = foregroundFlags.map(flag => `--${flag.name}`).join(", ");
  const foreground = foregroundFlags.length > 0 || parsed?.values.foreground === true;
  const retry = parsed && startRetry(args.raw, parsed, foreground);
  const mode = flagNames ? `${flagNames} ${foregroundFlags.length === 1 ? "belongs" : "belong"} to direct foreground execution.` : "";
  const guidance = foreground ? "Use `cotal spawn --foreground` to launch in this terminal." : "Use `cotal spawn --detach` to launch through a manager.";
  const persona = "Pass the catalog name as a positional argument or use --file for a persona file.";
  throw new CommandFailure("refused", "USAGE_INVALID", ["`cotal start` was removed.", mode, guidance].filter(Boolean).join(" "), {
    remedy: retry ?? `${persona} ${foreground ? "Omit manager options and use --json or --plain only with --dry-run." : "Run `cotal spawn --help` for supported launch options."}`,
    ...(retry ? { remedyIsCommand: true } : {}),
    selfContained: true,
  });
}
