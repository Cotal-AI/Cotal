import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { parseCommandArgs, registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import { CommandFailure, GLOBAL_FLAGS, isCommandFailure } from "@cotal-ai/workspace";
import { displayCmd } from "../lib/self-exec.js";
import { retryWord, spawnFlags } from "./spawn-flags.js";

const globalFlags = GLOBAL_FLAGS.map(name => ({ name, type: "boolean" as const }));
const retryFlags = [...spawnFlags, ...globalFlags];
const retryOptions: ParseArgsOptionsConfig = Object.fromEntries(retryFlags.map(({ name, ...flag }) => [name, flag]));

function parseLegacyOptions(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: retryOptions, allowPositionals: false, tokens: true });
  } catch { return undefined; }
}

type LegacyOptions = NonNullable<ReturnType<typeof parseLegacyOptions>>;

function retryArgs(argv: readonly string[], parsed: LegacyOptions) {
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
  const foreground = values.foreground || values["live-only"];
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
  return args;
}

function startRetry(argv: readonly string[], parsed: LegacyOptions): string | undefined {
  const args = retryArgs(argv, parsed);
  if (!args) return undefined;
  const spawn = registry.resolve<Command>("command", "spawn");
  try {
    spawn.validate?.(parseCommandArgs({ ...spawn, flags: retryFlags }, args));
  } catch (error) {
    if (isCommandFailure(error) || (error instanceof TypeError && "code" in error &&
      typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS_"))) return undefined;
    throw error;
  }
  return `${displayCmd({ fromAnyFolder: true })} spawn ${args.map(retryWord).join(" ")}`;
}

/** Refuse the removed verb during validation without launching or installing anything. */
export function refuseRemovedStart(args: ParsedArgs): never {
  const parsed = parseLegacyOptions(args.raw);
  const retry = parsed && startRetry(args.raw, parsed);
  const liveOnly = parsed?.values["live-only"] === true;
  const guidance = liveOnly
    ? "`--live-only` requires `cotal spawn --foreground`. It cannot be used with a manager launch (`--detach` or `--on`)."
    : "Use `cotal spawn` to launch an agent. Add `--detach` to launch through a manager.";
  const previewHint = liveOnly ? "Use `--dry-run` with `--json` or `--plain` to preview a foreground launch. " : "";
  const manual = "Pass the catalog name as a positional argument or use --file for a persona file. See `cotal spawn --help` for compatible launch options.";
  throw new CommandFailure("refused", "USAGE_INVALID", `\`cotal start\` was removed. ${guidance}`, {
    remedy: retry ?? previewHint + manual,
    ...(retry ? { remedyIsCommand: true } : {}),
    selfContained: true,
  });
}
