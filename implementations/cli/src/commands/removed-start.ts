import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import type { ParsedArgs } from "@cotal-ai/core";
import { CommandFailure } from "@cotal-ai/workspace";
import { displayCmd } from "../lib/self-exec.js";
import { brokerFlagFailure, emptySpaceFlagFailure } from "../lib/target-flag-failure.js";
import { retryWord, spawnFlags } from "./spawn-flags.js";
import { validateSpawnArguments } from "./spawn.js";

const retryOptions: ParseArgsOptionsConfig = {
  ...Object.fromEntries(spawnFlags.map(({ name, ...flag }) => [name, flag])),
  "no-color": { type: "boolean" },
  "no-input": { type: "boolean" },
};
const spawnTarget = { name: "spawn", flags: spawnFlags };

function parseOptions(argv: readonly string[], allowPositionals = false) {
  try {
    return parseArgs({ args: [...argv], options: retryOptions, allowPositionals, tokens: true });
  } catch { return undefined; }
}

function optionNames(argv: readonly string[], parsed: ReturnType<typeof parseOptions>): Set<string> {
  const end = argv.indexOf("--");
  // Tolerant parsing can explain the mode, but only a strict parse can yield a retry.
  const tokens = parsed?.tokens ?? parseArgs({
    args: end === -1 ? [...argv] : argv.slice(0, end), options: retryOptions, strict: false, allowPositionals: true, tokens: true,
  }).tokens;
  return new Set(tokens.flatMap(token => token.kind === "option" ? [token.name] : []));
}

function startRetry(argv: readonly string[], parsed: NonNullable<ReturnType<typeof parseOptions>>, foreground: boolean): string | CommandFailure | undefined {
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
  const spawnValues = candidate.values as ParsedArgs["values"];
  const spaceFailure = emptySpaceFlagFailure(spawnTarget, spawnValues.space);
  if (spaceFailure) return spaceFailure;
  try {
    validateSpawnArguments({ values: spawnValues, positionals: candidate.positionals, raw: args });
  } catch (error) {
    if (error instanceof CommandFailure) return undefined;
    throw error;
  }
  return brokerFlagFailure(spawnTarget, spawnValues) ?? `${displayCmd({ fromAnyFolder: true })} spawn ${args.map(retryWord).join(" ")}`;
}

/** Refuse the removed verb during validation without launching or installing anything. */
export function refuseRemovedStart(args: ParsedArgs): never {
  const parsed = parseOptions(args.raw);
  const options = optionNames(args.raw, parsed);
  const foregroundFlags = spawnFlags.filter(flag => "foregroundOnly" in flag && options.has(flag.name));
  const flagNames = foregroundFlags.map(flag => `--${flag.name}`).join(", ");
  const foreground = foregroundFlags.length > 0 || options.has("foreground");
  const candidate = parsed && startRetry(args.raw, parsed, foreground);
  const retry = typeof candidate === "string" ? candidate : undefined;
  const targetFailure = candidate instanceof CommandFailure ? candidate : undefined;
  const mode = flagNames ? `${flagNames} ${foregroundFlags.length === 1 ? "belongs" : "belong"} to direct foreground execution.` : "";
  const guidance = foreground ? "Use `cotal spawn --foreground` to launch in this terminal." : parsed ? "Use `cotal spawn --detach` to launch through a manager." : "Use `cotal spawn` with corrected options.";
  const persona = "Pass the catalog name as a positional argument or use --file for a persona file.";
  const help = "Run `cotal spawn --help` for supported launch options.";
  const remedy = targetFailure ? targetFailure.remedy ?? help : `${persona} ${foreground ? "Omit manager options and use --json or --plain only with --dry-run." : help}`;
  throw new CommandFailure("refused", "USAGE_INVALID", ["`cotal start` was removed.", mode, guidance, targetFailure?.message].filter(Boolean).join(" "), {
    remedy: retry ?? remedy,
    ...(retry ? { remedyIsCommand: true } : {}),
    selfContained: true,
  });
}
