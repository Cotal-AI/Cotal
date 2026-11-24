import { existsSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { parseArgs } from "node:util";
import { commandDeclarationProblems, findCommand, findSubcommand, parseCommandArgs, type Command, type FlagSpec, type ParsedArgs, type Registry, type Subcommand } from "@cotal-ai/core";
import {
  CommandFailure,
  commandFailureReport,
  cachedPreferences,
  cotalDirProblem,
  cotalHomeProblem,
  findCotalRoot,
  disableColor,
  disableInput,
  envelopeLine,
  exitCode,
  failureEnvelope,
  GLOBAL_FLAGS,
  globalConfigDirProblem,
  globalFlagDeclarationProblems,
  hasMeshTargetFlags,
  inOperationSpace,
  isCommandFailure,
  checkServer,
  isConnectRefusal,
  isMeshRegistryError,
  isSeededCommand,
  isWorkspaceTargetError,
  jsonFlag,
  localeIsUtf8,
  operationWarnings,
  outputDeclarationProblems,
  oneLine,
  paintFor,
  preferencesFolderWarning,
  recordOperationWarning,
  renderReport,
  renderWorkspaceError,
  runOperation,
  workspaceErrorParts,
  spaceRootTarget,
  targetErrorCode,
  targetErrorSpace,
  terminalWidth,
  userCotalDir,
  type OperationScope,
  type OutputWarning,
  staleStoreHint,
  UnreadableConnectorSelection,
} from "@cotal-ai/workspace";
import { c, stderrLine } from "./ui.js";
import { debugFlag } from "./lib/debug-flag.js";
import {
  isExtensionStub,
  materializeExtension,
  materializeExtensionCommand,
  overlayExtensions,
  setCommandSurface,
  setInstalledExtensionsEnabled,
} from "./ext-loader.js";
import { recoverExtensionPromotion } from "./lib/extension-stage.js";
import { SeedChildFailure, deferredSeedRefusal, reconcileSeededConnectors, seedDowngradeRefusal } from "./seed/reconcile.js";
import { deferSeedToLaunch } from "./seed/launch.js";
import { isAuthenticSeedChild } from "./seed/lock.js";
import { printHelpPath, printEntry } from "./help.js";
import { historySetupFailureRecords, membershipSetupFailureRecords } from "./lib/follow-setup-failure.js";
import { watchSetupFailureRecords } from "./commands/watch.js";
import { HISTORY_LIMIT_FLAGS } from "./commands/history-limit.js";
import { CatalogPreparationError, prepareCatalogCommand } from "./commands/sync.js";
import { keepStartupNotice, type StartupNotice } from "./lib/interrupt-notice.js";
import { metadataPositionals } from "./lib/command-path.js";
import { chooseMeshTarget, spaceChoiceRemedy } from "./lib/choose-target.js";
import { registryFailure } from "./lib/registry-errors.js";
import { FlagValueRefusal } from "./lib/flag-value-refusal.js";
import { workingFolderRemoved } from "./lib/paths.js";
import { preserveUpdatePath } from "./lib/npm-invocation.js";
import { reportLostOutput, writeAllSync } from "./lib/stdout-owner.js";
import { shellWord } from "./lib/endpoint-errors.js";
import { displayRemedy, hasMovedStackRemedy } from "./lib/self-exec.js";
import { asksForHelp, GLOBAL_FLAG_WORDS, leadingInvocation, OUTPUT_FLAG_WORDS } from "./lib/leading-flags.js";
import { takeManagedHandoffCustody } from "./managed-handoff.js";
import { nearestWords, LEADING_FLAGS, unknownCommandMessage, unknownSubcommandMessage } from "./lib/nearest-word.js";
import { UnusableFile } from "./lib/unusable-file.js";
import { armTelemetry, recordTelemetryError, recordTelemetryFailure } from "./telemetry.js";

// The service surfaces, the manager choice and the gone-stack refusal are imported where a command
// or a failure needs them, so a process that runs one daemon command never loads them.
const serviceSurfaces = () => Promise.all([import("./lib/service-presets.js"), import("./commands/manager-service.js")]);
const managerChoice = () => import("./lib/manager-choice.js");

/** Whether a global flag ({@link GLOBAL_FLAG_WORDS}: `--no-color`, `--no-input`) is `word`, applying
 *  it when it is. */
function takeGlobalFlag(word: string): boolean {
  if (!GLOBAL_FLAG_WORDS.has(word)) return false;
  if (word === "--no-color") disableColor();
  else if (word === "--no-input") disableInput(true);
  else return false;
  return true;
}

/** Apply leading global flags and move command-owned output flags after the command word. */
function prepareLeadingFlags(leading: readonly string[]) {
  const output: string[] = [];
  const leadingGlobals = new Set<string>();
  let repeatedLeading: string | undefined;
  for (const word of leading) {
    if (OUTPUT_FLAG_WORDS.has(word)) output.push(word);
    else if (leadingGlobals.has(word)) repeatedLeading ??= word;
    else if (takeGlobalFlag(word)) leadingGlobals.add(word);
  }
  return { output, leadingGlobals, repeatedLeading };
}

/** Collect globals before `--`; the parser still needs their original positions. */
function collectGlobalFlags(words: readonly string[], leading: ReadonlySet<string>): { flags: Set<string>; repeated?: string } {
  const flags = new Set<string>();
  let repeated: string | undefined;
  for (const word of words) {
    if (word === "--") break;
    if (!GLOBAL_FLAG_WORDS.has(word)) continue;
    if (leading.has(word) || flags.has(word)) repeated ??= word;
    flags.add(word);
  }
  return { flags, repeated };
}

/** Whether `cmd` takes its words raw: it declares so, or it is an internal command, whose words are
 *  another command line. Such a command parses no flags of its own. */
function takesWordsRaw(cmd: Command | undefined): boolean {
  return Boolean(cmd && (cmd.rawArgs || cmd.name.startsWith("__")));
}

/** Refuse a repeated global flag using the command's output mode and subcommand help. */
async function repeatedGlobalFlag(word: string, cmd: Command | undefined, words: string[], warnings: OutputWarning[] = []): Promise<never> {
  const { cmd: found, rest } = await serviceSurface(takesWordsRaw(cmd) ? undefined : cmd, words, true);
  const end = rest.indexOf("--");
  const options = end === -1 ? rest : rest.slice(0, end);
  // A global word in a string option's value slot cannot supply that value.
  const tokens = found && parseArgs({ args: options, options: parserOptions(found), strict: false, allowPositionals: true, tokens: true }).tokens;
  const missing = tokens?.find((token) => token.kind === "option" && token.inlineValue === false && token.value === word);
  const flag = missing?.kind === "option" ? found?.flags?.find(({ name }) => name === missing.name) : undefined;
  const refusal = flag && missing
    ? !flag.multiple && tokens?.some((token) => token.kind === "option" && token.name === flag.name && token.index < missing.index)
      ? { message: `--${flag.name} cannot be repeated`, remedy: `use --${flag.name} once` }
      : missingValue(flag)
    : { message: `Option '${word}' cannot be repeated` };
  const json = found !== undefined && asksForJson(found, rest);
  if (!json) for (const warning of warnings) console.error(c.red(`! ${warning.message}`));
  return runOperation({ warnings }, () => usageExit(refusal.message, found, json, options.includes("--plain"), refusal.remedy, rest));
}

/** Whether the invoked mode declares a structured output, so it reports every outcome by the 0 to 5
 *  table: the subcommand `first` selects, else the command's bare form. */
function structured(cmd: Command, first: string | undefined): boolean {
  const sub = findSubcommand(cmd, first);
  return ((sub ? sub.outputs : cmd.outputs) ?? []).some((mode) => mode === "json" || mode === "ndjson");
}

/** Whether `args` ask `cmd` for JSON before any `--`: `--json`, `-j`, or `-j` in a short option group
 *  before any value-taking option. The mode is the first positional after skipping declared values. */
function asksForJson(cmd: Command, args: readonly string[]): boolean {
  if (!structured(cmd, metadataPositionals(cmd, args).positionals[0]?.value)) return false;
  const shorts = new Map(cmd.flags?.flatMap((flag) => flag.short ? [[flag.short, flag.type] as const] : []));
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).some((word) => {
    if (word === "--json" || word === "-j") return true;
    if (!/^-[^-]/.test(word)) return false;
    let json = false;
    for (const ch of word.slice(1)) {
      const type = shorts.get(ch);
      if (type === undefined || type === "string") break;
      if (ch === "j") json = true;
    }
    return json;
  });
}

/** Under COTAL_DEBUG, print the failure's stack and the stack of each error that caused it. */
function debugStacks(failure: Error): void {
  if (!debugFlag("COTAL_DEBUG")) return;
  let error: unknown = failure;
  for (let depth = 0; error instanceof Error && depth < 8; error = error.cause, depth++) if (error.stack) console.error(c.dim(error.stack));
}

/** A classified failure: its line and remedy on stderr, its envelope on stdout when one was asked
 *  for, and the exit code its outcome sets. A usage refusal is followed by the help of the command
 *  or subcommand `words` name. Structured output is written synchronously, because stdout to a pipe is
 *  asynchronous on some platforms and `exit` would cut it short. */
function failureExit(cmd: Command, failure: CommandFailure, json: boolean, plain = false, scope?: OperationScope, words: readonly string[] = [], validationArgs?: ParsedArgs): never {
  const warnings = scope ? scope.warnings ?? [] : operationWarnings();
  recordTelemetryFailure(failure.outcome, failure.code, failure);
  // A command's own usage refusal reads as the parser's: the error, its remedy, then the help. A
  // missing --yes, a missing scripted input or a removed working folder is not a grammar mistake,
  // and its remedy says the whole fix. A file the command cannot use is reported like one that does
  // not exist, and a refused flag value names its corrected value, so it gets the classified report.
  if (failure.code === "USAGE_INVALID" && !json && !(failure instanceof UnusableFile) && !(failure instanceof FlagValueRefusal)) {
    usageRefusal(failure, plain, failure.selfContained ? undefined : cmd, words);
    debugStacks(failure);
    process.exit(1);
  }
  // Rendered in the run's scope, so the `Mesh:` heading keeps the note on how the run chose its space.
  const report = () => renderReport(commandFailureReport(failure), plain ? "plain" : "rich", process.stderr);
  const writeReport = () => writeSync(2, `${scope ? runOperation(scope, report) : report()}
`);
  // Under --json the envelope alone reports the failure. Its text report goes to stderr only when the
  // envelope cannot be written for a reason other than a closed pipe. The exit status stands either way.
  if (!json) writeReport();
  else try {
    const recognize = cmd.name === "backup" ? typographicOptions(cmd) : undefined;
    const subcommand = cmd.name === "backup" || cmd.name === "auth" || cmd.name === "doctor" || cmd.name === "endpoint"
      ? findSubcommand(cmd, metadataPositionals(cmd, words, recognize && { optionSpelling: (word) => recognize(word)?.spelling }).positionals[0]?.value)?.name
      : undefined;
    const command = subcommand && (cmd.name === "backup" ||
      (cmd.name === "auth" && subcommand === "mint") || (cmd.name === "doctor" && subcommand === "auth") ||
      (cmd.name === "endpoint" && (subcommand === "init" || subcommand === "check")))
      ? `${cmd.name} ${subcommand}` : cmd.name;
    const follow = validationArgs?.values.follow === true && validationArgs.values.plain !== true && !plain;
    const historyFollow = cmd.name === "history" && follow
      && !findSubcommand(cmd, validationArgs.positionals[0]);
    const membershipFollow = cmd.name === "channel" && follow && validationArgs.positionals[0] === "members";
    const space = validationArgs?.values.space;
    const records = historyFollow ? historySetupFailureRecords(validationArgs, failure)
      : membershipFollow ? membershipSetupFailureRecords({
        space: typeof space === "string" && space.trim() ? space : null,
        channel: validationArgs.positionals[1]?.replace(/^#/, "") ?? null,
      }, failure)
      : cmd.name === "watch" && validationArgs && !plain ? watchSetupFailureRecords(validationArgs, failure) : undefined;
    const lines = records ? records.map((record) => `${JSON.stringify(record)}\n`).join("") : envelopeLine(failureEnvelope(command, failure, warnings, scope));
    writeAllSync(1, Buffer.from(lines));
  } catch (error) {
    const writeError = error as NodeJS.ErrnoException;
    if (writeError.code !== "EPIPE") {
      reportLostOutput(writeError);
      try { writeReport(); } catch { /* stderr failed too; the exit status still says so */ }
    }
  }
  debugStacks(failure);
  process.exit(exitCode(failure.outcome, failure.code));
}

type ConfigFolderProblem = NonNullable<ReturnType<typeof globalConfigDirProblem>>;

/** The refusal of a command that would read or write a config folder that is a file. */
function configFolderRefusal(problem: ConfigFolderProblem): CommandFailure {
  return new CommandFailure("refused", "SCHEMA_INVALID", `${problem.message}; Cotal keeps your preferences, config and extensions there, so the command did not run`, { remedy: problem.remedy });
}

/**
 * `ext seed [--repair|--reset|--force]`, dispatched before the manifest overlay so repair survives a
 * corrupt manifest. Returns `true` iff `argv` was that command (or its help), so the caller returns.
 * The overlay cannot list the command yet, so the built-in `ext` is found through the registry,
 * which resolves its alias too.
 */
async function extSeedGate(extCmd: Command | undefined, words: string[], configFolder: ConfigFolderProblem | undefined, startupNotice?: StartupNotice): Promise<boolean> {
  if (extCmd === undefined || !extSeedSubcommand(extCmd, words)) return false;
  // A help request short-circuits to usage and mutates NOTHING (the maintenance run writes the seed
  // stamp/manifest).
  if (asksForHelp(words)) {
    paintFor(process.stdout, () => printHelpPath(extCmd, ["seed"]));
    return true;
  }
  const parsed = parseOrExit(extCmd, words);
  if (configFolder) failureExit(extCmd, configFolderRefusal(configFolder), false);
  if (parsed.values.repair !== true || parsed.values.reset === true) recoverExtensionPromotion();
  if (startupNotice) keepStartupNotice(startupNotice);
  await extCmd.run(parsed);
  return true;
}

/**
 * Whether a validated invocation skips the connector seed. Every command reconciles first (so a
 * first-command `ext add` still seeds, and the first command after an upgrade refreshes what is
 * installed), EXCEPT help, version, completion, a read its command declares and the cases below. A
 * read never repairs as a hidden prelude. `name` is the canonical command, `cmd` the command when it
 * resolved, and `sub` its first positional; an AUTHENTIC seed CHILD is an `ext add` whose
 * `COTAL_EXT_SEEDING` nonce + parent PID match the live reconcile lock (a forged marker no longer
 * skips, so it can't bypass the recursive-reconcile guard or the lock).
 */
function skipsSeed(name: string, sub: string | undefined, argv: readonly string[], cmd?: Command, values?: ParsedArgs["values"]): boolean {
  if (name === "help" || name === "version" || name === "__complete" || name === "completion") return true;
  if (cmd && readsOnly(cmd, sub)) return true;
  if (name === "login") return true; // device approval does not launch or install a connector
  if (name === "logout") return true; // signing out does not install a connector, and a seed refusal must not keep the cached login
  if (name === "sync") return true; // refreshing account catalogs does not install connectors
  if (name === "use") return true; // selecting or showing the current space does not launch or install connectors
  if (name === "meshes" && (sub === undefined || sub === "list")) return true;
  if (name === "config" && (sub === "set" || sub === "unset")) return true; // editing a preference does not require installing connectors
  // A dry run promises to plan and print while mutating NOTHING, and the boot-gate reconcile is a
  // mutation of the operator-global seed store, manifest and npm prefix — it ran BEFORE the command
  // body could reject the invocation, so `down --preserve-state --dry-run` (an unsupported
  // combination) migrated the whole store to the invoking binary's generation and only then printed
  // the usage refusal, leaving an older live deployment on a store it no longer matches (#1620). The
  // planning surface reads what is installed; it never seeds to make the plan prettier.
  if (argv.includes("--dry-run")) return true;
  if (name === "persona" || (name === "personas" && !argv.includes("--running"))) return true; // local files or existing native manager routes; neither installs connectors
  if (name === "telemetry") return true; // one local settings file; never installs connectors
  if (["__service-feedback-intake", "__service-delivery", "__service-manager", "__service-auth", "__service-linear", "__service-web", "__service-exec-endpoint"].includes(name)) return true; // explicit native service child; never repairs the installation
  if (name === "team" && (sub === "deploy" || sub === "remove")) return true; // existing native manager/channel operations never install local connectors
  // `backup restore` is excluded: it starts the restored stack and resumes its seats through `up
  // --restore`, so it reconciles connectors under the same rules as that startup. Other modes stay offline.
  if (name === "reset" || name === "down" || name === "doctor" || name === "feedback" || (name === "backup" && sub !== "restore") || name === "mint" || (name === "manager" && sub !== "start" && sub !== "restart") || name === "channel" || name === "stop" || name === "attach" || name === "input" || name === "auth" || name === "endpoint" || name === "service-endpoint" || name === "service" || name === "daemon") return true; // native maintenance and channel policy never install connector packages
  if (name === "run" && (sub === "turns" || sub === "yield")) return true; // self-only relay does not repair the operator installation
  if (name === "update") return true; // update owns one explicit reconcile; never auto-refresh then force-refresh
  // The seed is skipped for an INTERNAL CHILD re-exec — the `up`/`spawn` that spawns the delivery
  // daemon / manager / auth service sets COTAL_SKIP_CONNECTOR_SEED=1 in their env AFTER it reconciled,
  // so the child doesn't redo the seed on boot. A USER running the same public command directly (e.g.
  // `cotal supervise --roster`, the agent supervisor + container entrypoint, or `cotal manager start`,
  // which replaces it) still seeds on first run.
  if (process.env.COTAL_SKIP_CONNECTOR_SEED === "1") return true;
  if (name === "ext" && sub === "seed") return true; // the explicit maintenance command self-reconciles
  if (name === "ext" && sub === "add" && isAuthenticSeedChild()) return true; // a seed child must not recurse
  // `agent-bearer` is machine-facing: a spawned seat execs it on EVERY bearer refresh to read one 0600
  // token file, exchange it, print the bearer and exit. It must not depend on or mutate the
  // operator-global store — a newer store generation refused the boot before the token was ever read
  // (disconnecting a live seat at its token's expiry, #1857), and a matching generation seeded every
  // connector as a side effect of a credential exchange. The seat's env carries no
  // COTAL_SKIP_CONNECTOR_SEED (only an operator-set one is forwarded), so the skip is by name.
  if (name === "history" && sub === "clear") return true; // purge authority does not require installing connectors
  if (name === "history" && sub === "limit" && values && HISTORY_LIMIT_FLAGS.every((flag) => values[flag] === undefined)) return true;
  if (name === "agent-bearer") return true;
  // `app-identity` is machine-facing too: the Claude connector's local server runs it on every
  // connection, so, like a credential exchange, it must not seed the store under a running connector.
  if (name === "app-identity" || name === "mcp") return true;
  return false;
}

function seedRefusal(error: unknown): void {
  if (error instanceof SeedChildFailure && error.lines.length > 1) {
    stderrLine("✗ ", error.summary, c.red);
    for (const line of error.lines) stderrLine("  ", line, c.red);
  } else stderrLine("✗ ", error instanceof Error ? error.message : String(error), c.red);
}

/** Whether the invocation is a mode its command declares as a read ({@link Command.reads}). */
function readsOnly(cmd: Command, first: string | undefined): boolean {
  const sub = findSubcommand(cmd, first);
  return sub ? sub.reads === true : cmd.reads === true;
}

/** node's parseArgs throws these for unknown/malformed flags; treat as a usage error. */
function isArgError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

/** The managed verbs whose unpinned manager selection is asked on a terminal: each is refused
 *  before any effect when several of your managers are live. */
const PICKS_MANAGER: ReadonlySet<string> = new Set(["spawn", "ps", "stop", "attach", "input", "models", "persona", "status"]);

/** Whether `e` refused the unpinned manager selection of a command in {@link PICKS_MANAGER} and
 *  this terminal then picked a manager, which `parsed` now pins with `--on`. A script, `--json`,
 *  `--no-input` or `COTAL_NO_PROMPT=1` is not asked and keeps the refusal. A cancelled question exits 0, having
 *  done nothing. */
async function pinPickedManager(e: unknown, cmd: Command, parsed: ParsedArgs, argv: readonly string[]): Promise<boolean> {
  if (!PICKS_MANAGER.has(cmd.name) || parsed.values.on !== undefined || !(await import("./commands/meshes-wizard.js")).canPrompt()) return false;
  const failure = isCommandFailure(e) ? e : isConnectRefusal(e) ? e.failure() : undefined;
  if (!failure) return false;
  const target = { space: typeof parsed.values.space === "string" ? parsed.values.space : undefined, server: typeof parsed.values.server === "string" ? parsed.values.server : undefined };
  const { pickManager, rosterOf } = await managerChoice();
  const picked = await pickManager(failure, () => rosterOf(target), argv);
  if (picked === null) process.exit(0);
  if (picked === undefined) return false;
  parsed.values.on = picked.instanceId;
  return true;
}

/** One dispatcher-owned catalog gate for every command that uses the shared mesh target grammar,
 * including commands self-registered by other packages. Registry-local `meshes add/rm` stay
 * offline. `use` takes its target positionally, and status keeps stale bytes diagnostic-only.
 * Those commands then let a terminal choose between running spaces (see {@link chooseMeshTarget});
 * `status` reports an ambiguous target instead. */
async function prepareCatalogForCommand(cmd: Command, args: ReturnType<typeof parseCommandArgs>): Promise<void> {
  if ((cmd.name === "supervise" || cmd.name === "__daemon-manager") && args.values.execution === "none") return;
  if (args.values["dry-run"] === true) return; // preview handlers own read-only resolution; no catalog refresh or picker
  if (findSubcommand(cmd, args.positionals[0])?.prepareMeshTarget === false) return;
  if (cmd.name === "update" && args.values.check === true) return;
  if (cmd.name === "meshes") {
    const sub = args.positionals[0];
    if (sub === undefined || sub === "list") await prepareCatalogCommand(args, false, "meshes");
    return;
  }
  if (cmd.name === "use") return prepareCatalogCommand(args, false, "use");
  if (cmd.name === "status") {
    if (!args.positionals.length) return prepareCatalogCommand(args, true);
    await prepareCatalogCommand(args);
    return chooseMeshTarget(args);
  }
  if (cmd.name === "personas" && args.values.running !== true) return;
  if (cmd.prepareMeshTarget !== false && hasMeshTargetFlags(cmd.flags)) {
    await prepareCatalogCommand(args);
    await chooseMeshTarget(args);
  }
}

/** Options a composition root passes to {@link runCli}. */
export interface RunCliOptions {
  /** Load operator-installed extensions (`cotal ext add …`) into the surface: help/completion see
   *  manifest-cached stubs (no import), dispatch imports the owning package lazily with LIVE
   *  specs. OFF by default — library composition roots keep the explicit-import model; only the
   *  published binary opts in. */
  extensions?: boolean;
  /** The published entry's notice for an interrupt before the command begins. It is released as the
   *  command's work begins, or kept for a command that declares `keepsStartupNotice`, whose own
   *  notice takes it over. */
  startupNotice?: StartupNotice;
}

/** A usage refusal on stderr, then, when a command is given, the help `--help` prints for the same
 *  `words`: the subcommand's when they name one, else `cmd`'s. Plain output and a locale without
 *  UTF-8 have no refusal mark, so there the refusal is the classified report, which names its outcome
 *  in words. Either way the words it quotes are escaped, as the report escapes every text. */
function usageRefusal(failure: CommandFailure, plain: boolean, cmd?: Command, words: readonly string[] = []): void {
  const report = plain || !localeIsUtf8();
  if (report) writeSync(2, `${renderReport(commandFailureReport(failure), plain ? "plain" : "rich", process.stderr)}\n`);
  else {
    stderrLine("✗ ", oneLine(failure.message), c.red);
    if (failure.remedy) stderrLine("  ", oneLine(failure.remedy), c.dim, failure.remedyIsCommand);
  }
  if (!cmd) return;
  if (report) console.error("");
  paintFor(process.stderr, () => printHelpPath(cmd, helpPath(cmd, words).path, (line) => console.error(line), terminalWidth(process.stderr)));
}

/** Recover the requested stream output and target for a refusal, without running the command. */
function streamRefusalArgs(cmd: Command, words: readonly string[]): ParsedArgs | undefined {
  if (cmd.name !== "history" && cmd.name !== "channel" && cmd.name !== "watch") return undefined;
  const options = Object.fromEntries((cmd.flags ?? []).map(({ name, type, short }) => [name, { type, ...(short ? { short } : {}) }]));
  const args = [...words];
  for (;;) {
    const { values, positionals, tokens } = parseArgs({ args, options, strict: false, allowPositionals: true, tokens: true });
    // The loose parser consumes an option-looking word after a missing value. Leave that word
    // available as an option (or the separator), as it is in the usage diagnostic.
    const missing = tokens.find((token) => token.kind === "option" && token.inlineValue === false
      && token.value?.startsWith("-") && token.value !== "-"
      && !(args[token.index] === token.rawName && /^-\d/.test(token.value)));
    if (!missing) return values.json === true && (cmd.name === "watch" || values.follow === true)
      ? { values: values as ParsedArgs["values"], positionals, raw: words } : undefined;
    args.splice(missing.index + 1, 0, "");
  }
}

/** A usage error, written by {@link usageRefusal} with the help of the command or subcommand `words`
 *  name when there is one, and with `remedy` under the message when the parser can name one. Exit 1. */
function usageExit(message: string, cmd?: Command, json = false, plain = false, remedy?: string, words: readonly string[] = []): never {
  // A JSON caller gets only its receipt or stream records, without help text on stdout.
  if (cmd && json) failureExit(cmd, new CommandFailure("refused", "USAGE_INVALID", message, { remedy: remedy ?? `run \`cotal help ${cmd.name}\`` }), true, false, undefined, words, streamRefusalArgs(cmd, words));
  recordTelemetryFailure("refused", "USAGE_INVALID", message);
  // The help goes to stderr with the reason, so a refused run leaves stdout empty and a script that
  // sources or parses it gets nothing.
  usageRefusal(new CommandFailure("refused", "USAGE_INVALID", message, remedy === undefined ? undefined : { remedy }), plain, cmd, words);
  process.exit(1);
}

/** The refusal for a named or short option typed with a typographic dash pasted from
 *  typeset text, as `\u2013\u2013json`, naming it with hyphens; undefined when `word` is no such option. */
function typographicOption(word: string, names: ReadonlySet<string>, flags: readonly FlagSpec[] = []) {
  const typed = /^[\u2010-\u2015\u2212][-\u2010-\u2015\u2212]*([^=]+)(?:=(.*))?$/su.exec(word);
  if (!typed) return undefined;
  const [, name, value] = typed;
  const long = names.has(name!);
  const flag = flags.find((flag) => long ? flag.name === name : flag.short === name);
  if (!long && !flag) return undefined;
  const option = `${long ? "--" : "-"}${name}`;
  const spelling = value === undefined ? option : `${option}=${value}`;
  const message = `${word} starts with a typographic dash, so it is not an option`;
  const correction = value === undefined ? option : flag?.type === "string" ? `--${flag.name}=${shellWord(value)}` : undefined;
  return { message, spelling, flagName: flag?.name, remedy: correction && `type the option with hyphens: ${correction}` };
}

function typographicOptions(cmd: Command, flagNames?: readonly string[]) {
  const names = new Set<string>([...(flagNames ?? (cmd.flags ?? []).map((flag) => flag.name)), ...GLOBAL_FLAGS, "help"]);
  const flags: FlagSpec[] = [...(cmd.flags ?? []), { name: "help", short: "h", type: "boolean" }];
  return (word: string) => typographicOption(word, names, flags);
}

/** Identify seed before recovery, even when a typographic maintenance flag precedes it. */
function extSeedSubcommand(cmd: Command, words: readonly string[]): Subcommand | undefined {
  if (cmd.name !== "ext") return undefined;
  const seed = findSubcommand(cmd, "seed");
  if (!seed) return undefined;
  const end = words.indexOf("--");
  const names = new Set(seed.flagNames);
  const scope = words.filter((word, index) => (end !== -1 && index >= end) || !typographicOption(word, names));
  return metadataPositionals(cmd, scope).positionals[0]?.value === "seed" ? seed : undefined;
}

/** An option the parser would misread without an error: a short option written `-c=value`, which
 *  takes `=value` as its value, or a declared option typed with a typographic dash pasted from typeset
 *  text, which is read as a positional. */
function misspelledOption(cmd: Command, rest: readonly string[], flagNames: readonly string[] | undefined): { message: string; remedy?: string } | undefined {
  const recognize = typographicOptions(cmd, flagNames);
  const positionals = new Set(metadataPositionals(cmd, rest).positionals.map(({ index }) => index));
  for (const [index, word] of rest.entries()) {
    if (word === "--") return undefined;
    const previous = rest[index - 1];
    if (previous !== undefined && cmd.flags?.some((flag) => flag.type === "string" && (previous === `--${flag.name}` || previous === `-${flag.short}`))) continue;
    const short = /^-([^-=])=(.*)$/su.exec(word);
    const flag = short && cmd.flags?.find((item) => item.short === short[1] && item.type === "string");
    if (short && flag) {
      const value = short[2]!;
      const quoted = shellWord(value);
      const long = `--${flag.name}=${quoted}`;
      const correction = value.startsWith("-") ? long : `-${short[1]} ${quoted} or ${long}`;
      return { message: `${word} gives -${short[1]} the value "=${value}"`, remedy: `write ${correction}` };
    }
    const typed = positionals.has(index) ? recognize(word) : undefined;
    if (typed && cmd.name === "ext" && typed.flagName && typed.flagName !== "help") {
      const first = metadataPositionals(cmd, rest, { optionSpelling: (arg) => recognize(arg)?.spelling }).positionals[0]?.value;
      const sub = findSubcommand(cmd, first);
      const accepted = sub ? sub.flagNames : cmd.flagNames;
      if (accepted && !accepted.includes(typed.flagName))
        return { message: typed.message, remedy: `omit this option; \`cotal ext${sub ? ` ${sub.name}` : ""}\` does not take --${typed.flagName}` };
    }
    if (typed) return typed;
  }
  return undefined;
}

function parserOptions(cmd: Command) {
  return Object.fromEntries((cmd.flags ?? []).map(({ name, type, short }) => [name, { type, ...(short ? { short } : {}) }]));
}

/** Strip standalone globals, but keep any global where a string option needs its value. */
function stripGlobalFlags(cmd: Command, words: string[]): string[] {
  if (takesWordsRaw(cmd)) return words;
  const end = words.indexOf("--");
  const head = end === -1 ? words : words.slice(0, end);
  if (!head.some((word) => GLOBAL_FLAG_WORDS.has(word))) return words;
  const { tokens } = parseArgs({ args: head, options: parserOptions(cmd), strict: false, allowPositionals: true, tokens: true });
  const globals = new Set(tokens.filter((token) => token.kind === "option" && GLOBAL_FLAG_WORDS.has(head[token.index]!)).map((token) => token.index));
  return words.filter((_, index) => !globals.has(index));
}

function missingValue(flag: FlagSpec, beforeSeparator = false) {
  return { message: `--${flag.name} needs a value`, remedy: `write --${flag.name} ${flag.value ?? "<value>"}${beforeSeparator ? " before --" : ""}` };
}

/** A parse error as a refusal. A mistyped option names its spelling. A word that starts with `-`
 *  goes after `--` only where the command has room for an operand and there is no spelling suggestion.
 *  An option value that starts with `-` is written `--name=value`, and an option given with no value,
 *  last, before `--`, or before another of the command's options, is named with its placeholder. */
function parseRefusal(error: Error & { code?: string }, cmd: Command, rest: readonly string[], flagNames: readonly string[] | undefined, takesOperands: boolean, operandsFull: boolean): { message: string; remedy?: string } {
  if (error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    const reason = error.message.replace(/'\. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "(?:[^"\\]|\\.)*"$/u, "'");
    const option = /^Unknown option '(--.+)'$/su.exec(reason)?.[1];
    const nearest = option ? nearestWords(option, [...(flagNames ?? (cmd.flags ?? []).map((flag) => flag.name)).map((name) => `--${name}`), "--no-color", "--no-input", "--help"]) : [];
    const spellings = nearest.join(" or ");
    const flag = cmd.flags?.find((item) => `--${item.name}` === spellings);
    if (flag && !flag.multiple && typeof parseArgs({ args: [...rest], options: parserOptions(cmd), strict: false, allowPositionals: true }).values[flag.name] === flag.type) {
      const value = flag.type === "string" ? " and its value, if any" : "";
      return { message: reason, remedy: `drop the unknown option${value}; --${flag.name} is already set` };
    }
    const message = spellings ? `${reason} - did you mean ${spellings}?` : reason;
    const remedy = cmd.name === "completion" ? "drop the unknown option"
      : !takesOperands ? undefined : spellings ? `use ${spellings}`
      : operandsFull ? "drop the unknown option" : "to pass a word that starts with \"-\", put -- before it";
    return { message, remedy };
  }
  if (error.code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") {
    return { message: error.message.replace(/\. This command does not take positional arguments\.?$/u, "") };
  }
  const bare = /^Option '(?:-[^,']+, )?--([^ ']+) <value>' argument missing/.exec(error.message)?.[1];
  const last = bare === undefined ? undefined : cmd.flags?.find((item) => item.name === bare);
  if (error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && last) return missingValue(last);
  const long = /use '--([^=']+)=-XYZ'/.exec(error.message)?.[1];
  const flag = long === undefined ? undefined : cmd.flags?.find((item) => item.name === long);
  if (error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && flag) {
    const options = parserOptions(cmd);
    const { tokens } = parseArgs({ args: [...rest], options, strict: false, allowPositionals: true, tokens: true });
    let seen = false;
    for (const token of tokens) {
      if (token.kind !== "option" || token.name !== flag.name) continue;
      const value = token.value;
      // The strict parser accepts a dash and digit after a standalone string option.
      const numeric = rest[token.index] === token.rawName && /^-\d/.test(value ?? "");
      if (token.inlineValue === false && !numeric && value?.startsWith("-") && value !== "-") {
        if (seen && !flag.multiple) return { message: `--${flag.name} cannot be repeated`, remedy: `use --${flag.name} once` };
        if (value === "--") return missingValue(flag, true);
        if (GLOBAL_FLAG_WORDS.has(value)) return missingValue(flag);
        const next = parseArgs({ args: [value], options, strict: false, allowPositionals: true, tokens: true });
        if (next.tokens.every((item) => item.kind === "option" && Object.hasOwn(options, item.name)))
          return missingValue(flag);
        return { message: `the value of --${flag.name} starts with "-", so it reads as an option`, remedy: `write it as --${flag.name}=${shellWord(value)}` };
      }
      seen = true;
    }
  }
  return { message: error.message };
}

/** `rest` parsed against `cmd`'s declared flags, positionals and subcommands, or a usage exit. */
function parseOrExit(cmd: Command, rest: string[]): ParsedArgs {
  rest = stripGlobalFlags(cmd, rest);
  const seed = extSeedSubcommand(cmd, rest);
  const json = !seed && asksForJson(cmd, rest);
  const plain = !seed && rest.includes("--plain");
  const flagNames = seed?.flagNames ?? (cmd.name === "spawn" ? cmd.flagNames : undefined);
  const misspelled = cmd.rawArgs ? undefined : misspelledOption(cmd, rest, flagNames);
  if (misspelled) usageExit(misspelled.message, cmd, json, plain, misspelled.remedy, seed ? [seed.name] : rest);
  let parsed: ParsedArgs;
  try {
    parsed = parseCommandArgs(cmd, rest);
  } catch (e) {
    if (isArgError(e)) {
      const { positionals } = metadataPositionals(cmd, rest);
      const first = positionals[0]?.value;
      let selected: Command | Subcommand = cmd;
      for (const { value } of positionals) {
        const sub = findSubcommand(selected, value);
        if (!sub) break;
        selected = sub;
      }
      const takesOperands = !seed && cmd.positionals !== undefined &&
        (!cmd.subcommands?.length || cmd.name === "history" || (first !== undefined && findSubcommand(cmd, first) !== undefined));
      const operandsFull = (cmd.name === "config" && selected.name === "get" && positionals.length >= 2)
        || (cmd.name === "space" && selected.name === "add" && positionals.length >= 2)
        || (cmd.name === "team" && ["check", "boot", "deploy"].includes(selected.name) && positionals.length >= 2)
        || (cmd.name === "endpoint" && ((selected.name === "check" && positionals.length >= 2)
          || (first === "work" && selected.name === "lease" && positionals.length >= 4)));
      const refusal = parseRefusal(e as Error & { code?: string }, cmd, rest, seed?.flagNames ?? selected.flagNames, takesOperands, operandsFull);
      usageExit(refusal.message, cmd, json, plain, refusal.remedy, rest);
    }
    throw e;
  }
  const first = parsed.positionals[0];
  const canonical = canonicalSubcommand(cmd, parsed, json, plain);
  const spaceFailure = emptySpaceFailure(cmd, parsed);
  if (spaceFailure) failureExit(cmd, spaceFailure, json, parsed.values.plain === true, undefined, rest, parsed);
  // An empty --store-dir reads as no value and opens the default store, and a ~ no shell expanded
  // names a folder called ~ in the working folder.
  const storeDir = parsed.values["store-dir"];
  if (!(cmd.name === "clean" && first === "history") && typeof storeDir === "string" && (!storeDir.trim() || storeDir.startsWith("~")))
    failureExit(cmd, storeDirRefusal(storeDir), json, parsed.values.plain === true, undefined, rest);
  // `--json` implies `--no-input`: a script reading one document cannot answer a prompt.
  if (structured(cmd, first) && parsed.values.json === true) disableInput();
  refuseRemovedFolder(cmd, canonical, rest);
  try {
    cmd.validate?.(canonical);
  } catch (error) {
    if (isCommandFailure(error)) failureExit(cmd, error, json, canonical.values.plain === true, undefined, rest, canonical);
    if (isArgError(error)) usageExit((error as Error).message.split(".")[0]!, cmd, json, plain, undefined, rest);
    throw error;
  }
  const serverFailure = serverFlagFailure(cmd, canonical);
  if (serverFailure) failureExit(cmd, serverFailure, json, canonical.values.plain === true, undefined, rest, canonical);
  return canonical;
}

/** Check a suggested spawn without changing input mode, resolving its target or running it. */
export function validateSpawnRetry(cmd: Command, words: string[]): void {
  const rest = stripGlobalFlags(cmd, words);
  const spelling = misspelledOption(cmd, rest, cmd.flagNames);
  if (spelling) throw new CommandFailure("refused", "USAGE_INVALID", spelling.message, { remedy: spelling.remedy });
  const parsed = parseCommandArgs(cmd, rest);
  const spaceFailure = emptySpaceFailure(cmd, parsed);
  if (spaceFailure) throw spaceFailure;
  cmd.validate?.(parsed);
  const serverFailure = serverFlagFailure(cmd, parsed);
  if (serverFailure) throw serverFailure;
}

function emptySpaceFailure(cmd: Command, parsed: ParsedArgs): CommandFailure | undefined {
  // An explicitly empty space must not resolve to the selected one.
  const flag = cmd.flags?.find((flag) => flag.name === "space");
  if (flag && typeof parsed.values.space === "string" && !parsed.values.space.trim())
    return new CommandFailure("refused", "USAGE_INVALID", `--space${flag.short ? `/-${flag.short}` : ""} is empty; name one space`, { remedy: "name the space; `cotal space` lists the spaces this machine knows" });
  return undefined;
}

function serverFlagFailure(cmd: Command, parsed: ParsedArgs): CommandFailure | undefined {
  // The TCP client drops URL components beyond host and port. Apply registration's syntax rule
  // before any command connects. A command's narrower rule, such as `up`'s, has run above.
  if (cmd.flags?.some((flag) => flag.name === "server") && typeof parsed.values.server === "string") {
    // Manifest up owns the single-listener refusal. Check each entry first so a credential or
    // malformed entry is still refused before that command reads the manifest or starts anything.
    const servers = cmd.name === "up" && typeof parsed.values.file === "string"
      ? parsed.values.server.split(",").map(server => server.trim())
      : [parsed.values.server];
    for (const server of servers) {
      const checked = checkServer(server, "--server");
      if (!checked.ok)
        return new CommandFailure("refused", "USAGE_INVALID", `${checked.message.replace(/^✗ /, "")}; the command did not run`, { remedy: checked.remedy, selfContained: true });
    }
  }
  return undefined;
}

/** The refusal of a `--store-dir` that is empty, or that starts with a `~` no shell expanded. */
function storeDirRefusal(value: string): CommandFailure {
  if (!value.trim()) return new CommandFailure("refused", "USAGE_INVALID", "--store-dir is empty; the command did not run", { remedy: "name the store directory, or omit --store-dir to use the default store", selfContained: true });
  const home = value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(2)) : undefined;
  return new CommandFailure("refused", "USAGE_INVALID", `--store-dir ${JSON.stringify(value)} starts with ~, which no shell expanded, so it names a folder called ${value.split("/")[0]} in ${process.cwd()}; the command did not run`, { target: { storeDir: value }, remedy: home ? `name the absolute path: --store-dir ${shellWord(home)}` : "name the store directory by its absolute path", selfContained: true });
}

/** The commands that never read the working folder, so they run from one that was removed. */
const FOLDERLESS = new Set(["help", "version", "completion", "docs", "telemetry", "daemon"]);

/** A working folder removed before this process read it fails every cwd read the command makes, and
 *  Node caches the first read that succeeds. One read refuses that case before the command's own
 *  checks, such as `up`'s, or any effect, unless the command never reads the folder. */
function refuseRemovedFolder(cmd: Command, parsed: ParsedArgs, rest: readonly string[]): void {
  if (cmd.name === "update") {
    // Global maintenance must not inherit an unrelated disposable working folder. Keep the
    // project's root when one exists and preserve relative credentials and tool paths.
    const removed = workingFolderRemoved();
    const root = removed ? undefined : findCotalRoot();
    if (typeof parsed.values.creds === "string" && !isAbsolute(parsed.values.creds) && !removed)
      parsed.values.creds = resolve(parsed.values.creds);
    if (!removed) preserveUpdatePath();
    process.chdir(root && existsSync(join(root, ".cotal")) ? root : parse(homedir()).root);
    return;
  }
  if (cmd.name.startsWith("__") || FOLDERLESS.has(cmd.name) || !workingFolderRemoved()) return;
  failureExit(cmd, new CommandFailure("refused", "USAGE_INVALID", "this folder no longer exists", { remedy: "cd to an existing folder and run the command again", selfContained: true }), structured(cmd, parsed.positionals[0]) && parsed.values.json === true, parsed.values.plain === true, undefined, rest);
}

/** Resolve subcommand aliases and refuse a word that names no subcommand before checking operands. */
function canonicalSubcommand(cmd: Command, parsed: ParsedArgs, json: boolean, plain: boolean): ParsedArgs {
  const positionals = [...parsed.positionals];
  let surface: Pick<Command, "subcommands"> = cmd;
  let changed = false;
  for (let index = 0; index < positionals.length && surface.subcommands?.length; index++) {
    const word = positionals[index]!;
    const sub: Subcommand | undefined = findSubcommand(surface, word);
    if (!sub) {
      // History also accepts a channel as its first positional.
      if (index === 0 && cmd.name === "history") break;
      const message = unknownSubcommandMessage([cmd.name, ...positionals.slice(0, index)].join(" "), surface, word);
      if (index === 0) usageExit(message, cmd, json, plain);
      failureExit(cmd, new CommandFailure("refused", "USAGE_INVALID", message), json, plain, undefined, parsed.raw);
    }
    changed ||= sub.name !== word;
    positionals[index] = sub.name;
    surface = sub;
  }
  return changed ? { ...parsed, positionals } : parsed;
}

/** The subcommand path and its operands for help, and the first word where a subcommand belongs
 *  that names none. Read from the declared specs, so a stub's help never imports its package. */
function helpPath(cmd: Command, rest: readonly string[]): { path: string[]; unknown?: string } {
  const words = metadataPositionals(cmd, rest).positionals.map((item) => item.value);
  let surface: Pick<Command, "subcommands"> = cmd;
  const path: string[] = [];
  for (const word of words) {
    const sub: Subcommand | undefined = findSubcommand(surface, word);
    // History's own first word may be a channel.
    if (!sub && surface.subcommands?.length && !(surface === cmd && cmd.name === "history")) return { path, unknown: word };
    if (!sub || sub.hidden) break;
    path.push(sub.name); surface = sub;
    if (!sub.subcommands?.length) return { path: [...path, ...words.slice(path.length)] };
  }
  return { path };
}

/** `-h`/`--help` anywhere after a command: that command's help, or its subcommand's when the first
 *  positional names one. A word where a subcommand belongs that names none refuses as `cotal help`
 *  does, so a mistyped subcommand never gets its group's help. */
function printHelpFor(cmd: Command, rest: readonly string[]): void {
  const { path, unknown } = helpPath(cmd, rest);
  paintFor(process.stdout, () => printHelpPath(cmd, unknown === undefined ? path : [...path, unknown]));
}

/** A service invocation takes its preset's flags, and `manager <verb>` is `service <verb> manager`.
 *  Preset details can enrich a duplicate refusal but cannot replace it. */
async function serviceSurface(found: Command | undefined, words: string[], forRefusal = false): Promise<{ cmd: Command | undefined; rest: string[] }> {
  if (found?.name !== "service" && found?.name !== "manager") return { cmd: found, rest: words };
  try {
    const [{ servicePresetCommand }, { managerServiceCommand }] = await serviceSurfaces();
    if (found.name === "service") return { cmd: servicePresetCommand(found, words), rest: words };
    const lifecycle = managerServiceCommand(found, words, forRefusal);
    return lifecycle ? { cmd: lifecycle.cmd, rest: lifecycle.argv } : { cmd: found, rest: words };
  } catch (error) {
    if (forRefusal || asksForHelp(words)) return { cmd: found, rest: words };
    const failure = isCommandFailure(error) ? error : new CommandFailure("refused", "SCHEMA_INVALID", "service preset metadata could not be read; no provider was imported or installed");
    return failureExit(found, failure, asksForJson(found, words), words.includes("--plain"), undefined, words);
  }
}

/**
 * Dispatch `argv` against the commands self-registered in a {@link Registry}. The single entry point
 * a composition root calls — no hardcoded command list.
 *
 * It runs in two phases. The front end reads only local metadata: it resolves the command by exact
 * name or alias (never a prefix), answers help and version, and parses a built-in command's flags
 * against its declared specs. Only an invocation that passed it reaches the effects: the connector
 * seed, provider materialization, target preparation and `run`. So a usage error seeds, writes and
 * launches nothing. An extension command's flags are parsed after the seed, because its live specs
 * come from importing a package the seed keeps current.
 */
export async function runCli(registry: Registry, argv: string[], opts: RunCliOptions = {}): Promise<void> {
  const startedAt = Date.now();
  const { leading, original, word, args } = leadingInvocation(argv);
  const { output, leadingGlobals, repeatedLeading } = prepareLeadingFlags(leading);
  const words = [...output, ...args];
  const wantsHelp = asksForHelp(args);
  const builtin = findCommand(registry.all<Command>("command"), word);
  const globals = collectGlobalFlags(words, leadingGlobals);
  const ownWords = (cmd: Command | undefined): string[] => {
    if (!takesWordsRaw(cmd)) for (const option of globals.flags) takeGlobalFlag(option);
    return [...words];
  };
  const duplicate = (cmd: Command | undefined) => repeatedLeading ?? (takesWordsRaw(cmd) ? undefined : globals.repeated);
  if (repeatedLeading && (word === undefined || takesWordsRaw(builtin))) return repeatedGlobalFlag(repeatedLeading, undefined, []);
  if (output.length && word === undefined) usageExit(`${output[0]} needs a command after it - run \`cotal help\` to list commands`);
  if (output.length && takesWordsRaw(builtin))
    usageExit(`${output[0]} before ${original} is not read - ${original} takes its words raw, with no output flags`);
  // A recorded unit boots from built-in code only. Even reading the extension overlay can
  // prevent recovery from an unrelated broken manifest. Validate before any handoff custody,
  // installation repair, package materialization or target preparation. This is one exact
  // private entry, not an exemption for arbitrary internal or extension command names.
  if (word === "__service-unit") {
    if (!registry.has("command", "__service-unit")) usageExit("the native unit entry is not available in this composition root");
    const unit = registry.resolve<Command>("command", "__service-unit");
    const parsed = parseOrExit(unit, words);
    try { await unit.run(parsed); }
    catch (error) {
      failureExit(unit, isCommandFailure(error) ? error : new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original unit entry did not confirm its outcome; no replacement or repair was attempted"), false, true);
    }
    return;
  }
  // Before any ordinary dispatch outcome can exit, a spawn takes its handoff, and no command lets a
  // child inherit the variable. The unit entry refuses such a handoff without consuming its file.
  takeManagedHandoffCustody(process.env, builtin?.name === "spawn");
  setInstalledExtensionsEnabled(Boolean(opts.extensions));
  const builtinDuplicate = builtin && duplicate(builtin);
  if (builtinDuplicate) return repeatedGlobalFlag(builtinDuplicate, builtin, ownWords(builtin));
  if (word === "-v") usageExit("-v is not the version flag - run `cotal version` or `cotal -V`");
  // The built-in check reports an unreadable inventory itself. Do not require that inventory to
  // construct its command surface, or recover an installation as a prelude to this read-only mode.
  const updateCheck = builtin?.name === "update" && words.includes("--check") && !wantsHelp
    && parseOrExit(builtin, ownWords(builtin)).values.check === true;
  // Structured version reports inventory failures itself and needs no extension commands.
  const versionJson = builtin?.name === "version" && !wantsHelp && asksForJson(builtin, words);
  // The built-in updater repairs its connector paths before opening any promotion journal.
  const selfUpdate = builtin?.name === "update" && words.includes("--self") && !wantsHelp
    && parseOrExit(builtin, ownWords(builtin)).values.self === true;
  // The removed start command only gives migration advice and needs no extension inventory.
  let useExtensionOverlay = opts.extensions && !updateCheck && !selfUpdate && builtin?.name !== "start";
  function skipUnreadableConnectorOverlay(error: unknown): boolean {
    if (!(error instanceof UnreadableConnectorSelection) || !builtin || !["version", "status", "down"].includes(builtin.name)) return false;
    if (builtin.name === "down") {
      const parsed = parseOrExit(builtin, ownWords(builtin));
      if (parsed.positionals.length || parsed.values.file || parsed.values.run || parsed.values["with-agents"] || parsed.values["preserve-state"]) return false;
    }
    // These built-ins can report or stop recorded state without loading extension commands.
    // Status still reports the unreadable inventory from its own readers.
    useExtensionOverlay = false;
    setInstalledExtensionsEnabled(false);
    return true;
  }
  const configFolder = globalConfigDirProblem();
  if (useExtensionOverlay) {
    try {
      if (builtin?.name === "ext" && await extSeedGate(builtin, ownWords(builtin), configFolder, opts.startupNotice)) return;
      // Topology only renders a manifest. Read the installed overlay normally without finishing an install.
      if (!configFolder && builtin?.name !== "topology") recoverExtensionPromotion();
    } catch (e) {
      if (!skipUnreadableConnectorOverlay(e)) {
        if (repeatedLeading) {
          const warnings: OutputWarning[] = [];
          let found: Command | undefined;
          try { found = findCommand(overlayExtensions(registry, collisionWarning(warnings)), word); }
          catch { /* The current manifest cannot supply refusal context. */ }
          return repeatedGlobalFlag(repeatedLeading, found, ownWords(found), warnings);
        }
        seedRefusal(e);
        process.exit(1);
      }
    }
  }
  function collisionWarning(warnings: OutputWarning[]) {
    return (message: string) => { warnings.push({ code: "EXTENSION_COMMAND_COLLISION", target: null, message: message.slice(2) }); };
  }
  const pendingWarnings: OutputWarning[] = [];
  const surface = (warnings?: OutputWarning[]): Command[] => {
    let commands: Command[];
    try {
      commands = useExtensionOverlay && !versionJson && !configFolder ? overlayExtensions(registry, warnings && collisionWarning(warnings)) : registry.all<Command>("command");
    } catch (e) {
      if (skipUnreadableConnectorOverlay(e)) commands = registry.all<Command>("command");
      else {
        if (repeatedLeading) usageExit(`Option '${repeatedLeading}' cannot be repeated`);
        // A corrupt extensions manifest must not silently shrink the surface.
        stderrLine("✗ ", (e as Error).message, c.red);
        process.exit(1);
      }
    }
    for (const cmd of commands) {
      const problems = [
        ...commandDeclarationProblems(cmd),
        ...outputDeclarationProblems(cmd),
        ...(cmd.subcommands ?? []).flatMap((sub) => outputDeclarationProblems({ name: `${cmd.name} ${sub.name}`, outputs: sub.outputs, flags: cmd.flags })),
        ...globalFlagDeclarationProblems(cmd),
      ];
      if (problems.length) usageExit(`internal error: ${problems.join("; ")}`);
    }
    setCommandSurface(commands); // the completion dispatcher reads the SAME surface help renders
    return commands;
  };
  let commands = surface(duplicate(undefined) ? pendingWarnings : undefined);
  if (word === undefined) return paintFor(process.stdout, () => printEntry(commands));
  let cmd = findCommand(commands, word);
  let rest = ownWords(cmd);
  const repeated = duplicate(cmd);
  if (repeated) return repeatedGlobalFlag(repeated, cmd, rest, pendingWarnings);
  for (const warning of pendingWarnings) console.error(c.red(`! ${warning.message}`));
  ({ cmd, rest } = await serviceSurface(cmd, rest));
  // The usage telemetry hook is armed as soon as the command is known, so a usage refusal below
  // counts too, and before anything runs, so the one-time notice precedes the command's output.
  const arm = (): void => {
    if (!cmd) return;
    try {
      armTelemetry(registry, cmd, words, startedAt);
    } catch (e) {
      if (isCommandFailure(e)) failureExit(cmd, e, asksForJson(cmd, rest), rest.includes("--plain"), undefined, rest);
      throw e;
    }
  };
  arm();
  // A seeded package's command (`web`) can be absent only because the first seed has not installed
  // it yet, so running it seeds and resolves again. Asking for its help seeds nothing, and any other
  // unknown word is a usage error.
  const awaitingSeed = !cmd && opts.extensions === true && isSeededCommand(word) && !wantsHelp && !skipsSeed(word, rest[0], rest);
  // A leading flag typed with a typographic dash is read as the command word, so it is refused as the
  // same word after the command word is.
  const typed = cmd || awaitingSeed ? undefined : typographicOption(word, new Set(LEADING_FLAGS.map((flag) => flag.slice(2))), [
    jsonFlag, { name: "help", short: "h", type: "boolean" }, { name: "version", short: "V", type: "boolean" },
  ]);
  if (typed) usageExit(typed.message, undefined, false, false, typed.remedy);
  if (!cmd && !awaitingSeed) usageExit(unknownCommandMessage(commands, word));
  // `cotal <cmd> --help` / `-h` → that command's help, never run it. This intercept also covers
  // rawArgs commands and extension STUBS (cached specs are exactly the display surface) — only
  // `__`-internal ones are exempt, because __complete's argv is ANOTHER command's half-typed
  // line, where `--help` is a word being completed, not a request.
  if (cmd && !cmd.name.startsWith("__") && wantsHelp) return printHelpFor(cmd, rest);
  let parsed = cmd && !isExtensionStub(cmd) ? parseOrExit(cmd, rest) : undefined;
  // ---- Effects: only a validated invocation reaches this line. ----
  // A config folder that is a file fails every read and write of the preferences, the config file and
  // the extensions, so a command that could use them stops here, before the seed would write there.
  // Help, shell completion, version and docs use none of them.
  if (configFolder && cmd && parsed && !cmd.name.startsWith("__") && !["help", "completion", "version", "docs"].includes(cmd.name))
    failureExit(cmd, configFolderRefusal(configFolder), structured(cmd, parsed.positionals[0]) && parsed.values.json === true, parsed.values.plain === true, undefined, rest, parsed);
  // The seed can install or upgrade an extension package, so the surface is read again after it and
  // an extension stub resolves against the manifest the seed left.
  const controlOnlyManager = parsed?.values.execution === "none" && (cmd?.name === "supervise" || cmd?.name === "__daemon-manager");
  if (opts.extensions && !controlOnlyManager && !skipsSeed(cmd?.name ?? word, parsed ? parsed.positionals[0] : rest[0], rest, cmd, parsed?.values)) {
    // Startup checks seed compatibility here and reconciles at launch. A restore that refuses
    // before launch leaves the operator-global store as it found it.
    const deferred = cmd?.name === "up" || (cmd?.name === "backup" && parsed?.positionals[0] === "restore");
    try {
      if (deferred) {
        // Broker-only startup still checks the store generation. An explicit restore can start its
        // recorded manager even when --no-manager is present, so it retains the full seed path.
        const brokerOnly = parsed?.values["no-manager"] === true && !parsed.values.restore;
        const refusal = brokerOnly ? seedDowngradeRefusal() : deferredSeedRefusal();
        if (refusal) throw refusal;
        if (!brokerOnly) deferSeedToLaunch();
      } else await reconcileSeededConnectors(cmd?.name === "setup");
    } catch (e) {
      // The seed runs before the command reaches its own failure path. A structured command still
      // reports the same outcome and exit status in every presentation.
      const sub = parsed?.positionals[0] ?? (cmd && metadataPositionals(cmd, rest).positionals[0]?.value);
      if (cmd && structured(cmd, sub)) {
        const message = e instanceof Error ? e.message : String(e);
        const failure = isCommandFailure(e) ? e : new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", displayRemedy(message),
          e instanceof SeedChildFailure ? { remedy: displayRemedy("fix that, then run `cotal ext seed --repair`") } : {});
        const end = rest.indexOf("--");
        const plain = parsed?.values.plain === true || (!parsed && (end === -1 ? rest : rest.slice(0, end)).includes("--plain"));
        failureExit(cmd, failure, asksForJson(cmd, rest), plain, undefined, rest);
      }
      seedRefusal(e);
      process.exit(1);
    }
    if (!deferred) {
      const warnings: OutputWarning[] = [];
      commands = surface(duplicate(undefined) ? warnings : undefined);
      cmd = findCommand(commands, word);
      if (!cmd) usageExit(unknownCommandMessage(commands, word));
      const repeated = duplicate(cmd);
      if (repeated) return repeatedGlobalFlag(repeated, cmd, ownWords(cmd), warnings);
      for (const warning of warnings) console.error(c.red(`! ${warning.message}`));
      ({ cmd, rest } = await serviceSurface(cmd, ownWords(cmd)));
      arm();
    }
  }
  // An extension stub materializes before parsing: verify the version pin, import the package
  // (self-registers), and parse with the LIVE specs — the cache never drives run's input.
  if (cmd && isExtensionStub(cmd)) {
    try {
      cmd = await materializeExtensionCommand(cmd);
    } catch (e) {
      stderrLine("✗ ", (e as Error).message, c.red);
      process.exit(1);
    }
    parsed = parseOrExit(cmd, rest);
  }
  if (!cmd || !parsed) throw new Error("internal error: dispatch reached its effects without a parsed command");
  // A preferences file that does not validate stops every command that could act on a default, as a
  // broken config file does, so nothing runs on a default the person did not mean. Help, shell
  // completion, version, docs and machine-daemon operations need no preference defaults, and status
  // reports the file as a warning, so they still run. `--help` has already returned above.
  if (!cmd.name.startsWith("__") && cmd.name !== "help" && cmd.name !== "completion") {
    // A relative COTAL_HOME would name another home in each folder a command runs in, and a
    // COTAL_HOME that cannot be a directory can hold no record: both stop them before any command
    // reads it.
    const home = process.env.COTAL_HOME;
    if (home && !isAbsolute(home)) failureExit(cmd, new CommandFailure("refused", "USAGE_INVALID", `COTAL_HOME ${JSON.stringify(home)} is a relative path, so each folder a command runs in would have its own Cotal home; the command did not run`, { remedy: `set COTAL_HOME to an absolute path, or unset it to use ${userCotalDir()}` }), structured(cmd, parsed.positionals[0]) && parsed.values.json === true, parsed.values.plain === true, undefined, rest, parsed);
    const homeProblem = cotalHomeProblem();
    if (homeProblem) failureExit(cmd, new CommandFailure("refused", "SCHEMA_INVALID", `${homeProblem}; the command did not run`, { remedy: `point COTAL_HOME at a directory, or unset it to use ${userCotalDir()}` }), structured(cmd, parsed.positionals[0]) && parsed.values.json === true, parsed.values.plain === true, undefined, rest);
    // A `.cotal` that is a file in the folder the command uses, such as someone's notes, holds no
    // records, and every reader would otherwise report a different wrong cause. The machine daemon
    // uses its selected home, not the invoking project's records.
    const dirProblem = cmd.name === "version" || cmd.name === "daemon" || workingFolderRemoved() ? undefined : cotalDirProblem(typeof parsed.values.root === "string" ? resolve(parsed.values.root) : findCotalRoot());
    if (dirProblem) failureExit(cmd, new CommandFailure("refused", "CONFLICT", `${dirProblem}; the command did not run`, { remedy: "rename or move that file, then run the command again" }), structured(cmd, parsed.positionals[0]) && parsed.values.json === true, parsed.values.plain === true, undefined, rest, parsed);
    if (!["version", "docs", "status", "daemon"].includes(cmd.name)) {
      try {
        cachedPreferences();
      } catch (e) {
        if (!isCommandFailure(e)) throw e;
        failureExit(cmd, e, structured(cmd, parsed.positionals[0]) && parsed.values.json === true, parsed.values.plain === true, undefined, rest);
      }
    }
  }
  // A failure raised after the command recorded the space it resolved is reported in that space. A
  // completion writes its warnings, as its errors, only under COTAL_COMPLETE_DEBUG.
  const scope: OperationScope = cmd.name === "__complete" && !debugFlag("COTAL_COMPLETE_DEBUG") ? { quiet: true } : {};
  const execute = async () => {
    if (opts.extensions && cmd.requiredExtensions) {
      for (const ref of cmd.requiredExtensions(parsed)) await materializeExtension(ref);
    }
    await prepareCatalogForCommand(cmd, parsed);
    await runOperation(scope, async () => {
      // Preferences that another local account could change still apply, so each command that uses
      // them says so, with the change that protects their folder.
      if (!cmd.name.startsWith("__") && !["help", "completion", "version", "docs"].includes(cmd.name)) {
        const folder = preferencesFolderWarning();
        // Under --json the warning lives in the envelope only: an immediate echo would put it on
        // stderr as well, so a JSON refusal would break the "envelope on stdout, nothing on
        // stderr" contract (docs/UPGRADING.md, "JSON refusals after 0.100.2"). Human mode still
        // prints it at once, as before.
        const jsonOutput = structured(cmd, parsed.positionals[0]) && parsed.values.json === true;
        if (folder) recordOperationWarning(folder.warning, { echo: !jsonOutput });
      }
      if (cmd.prepare) await cmd.prepare(parsed);
      await cmd.run(parsed);
    });
  };
  if (opts.startupNotice && cmd.keepsStartupNotice) keepStartupNotice(opts.startupNotice);
  else await opts.startupNotice?.release();
  try {
    await execute();
  } catch (e) {
    // On a terminal, a refused unpinned manager selection among several live managers is asked
    // once, and the command runs again on the manager picked, as the refusal's Next would rerun it.
    if (await pinPickedManager(e, cmd, parsed, argv)) {
      try { await execute(); return; } catch (again) { e = again; }
    }
    recordTelemetryError(e);
    const mode = parsed.positionals[0];
    const json = structured(cmd, mode) && parsed.values.json === true;
    // A usage error a command raises from its own checks prints the command's help, not a stack trace.
    if (isArgError(e)) usageExit((e as Error).message.split(".")[0]!, cmd, json, parsed.values.plain === true, undefined, rest);
    // A refused manager selection among several live managers becomes the choice: each manager
    // and the command again with `--on` for it. A space whose stack folder is gone names its stop.
    const target = { space: typeof parsed.values.space === "string" ? parsed.values.space : undefined, server: typeof parsed.values.server === "string" ? parsed.values.server : undefined };
    const choice = async (failure: CommandFailure) => {
      const [{ managerChoiceFailure, rosterOf }, { goneStackRefusal }] = await Promise.all([managerChoice(), import("./commands/stack-gone.js")]);
      return (await managerChoiceFailure(failure, () => rosterOf(target), argv)) ?? goneStackRefusal(failure);
    };
    if (isCommandFailure(e)) failureExit(cmd, inOperationSpace(await choice(e), scope.space), json, parsed.values.plain === true, scope, rest);
    // A command that declares a structured output reports by the outcome table. A target it could
    // not resolve or connect to is refused before any request, under the refusal's own code; a
    // failure it did not classify is unknown: it may have had effects that cannot be attributed.
    if (structured(cmd, mode)) {
      const targetError = isConnectRefusal(e) ? e.cause : e;
      const spaceRemedy = spaceChoiceRemedy(targetError, cmd.name, parsed, rest);
      const renderRemedy = spaceRemedy !== undefined ? () => spaceRemedy
        : hasMovedStackRemedy(targetError) || ["status", "ps", "space", "whoami"].includes(cmd.name) ? displayRemedy : undefined;
      if (isConnectRefusal(e)) {
        const failure = e.failure(renderRemedy), cause = e.cause;
        if (isWorkspaceTargetError(cause) && cause.code === "not-started" && cause.details.stopped && !cause.details.unsettled && cause.details.root && cause.details.space) {
          const { stackStartAddressProblem } = await import("./commands/stack-up.js");
          const held = await stackStartAddressProblem(cause.details.root, cause.details.space);
          if (held) failureExit(cmd, inOperationSpace(new CommandFailure("refused", failure.code, `${failure.message}; ${held.message}`, { remedy: held.remedy, target: failure.target }), scope.space), json, parsed.values.plain === true, scope, rest);
        }
        failureExit(cmd, inOperationSpace(await choice(failure), scope.space), json, parsed.values.plain === true, scope, rest);
      }
      if (isWorkspaceTargetError(e)) {
        const { message, remedy } = workspaceErrorParts({ kind: "target", error: e });
        const target = spaceRootTarget({ root: e.details.root, space: targetErrorSpace(e.details) });
        failureExit(cmd, inOperationSpace(new CommandFailure("refused", targetErrorCode(e.code), message, { ...(remedy ? { remedy: renderRemedy?.(remedy) ?? remedy } : {}), ...(target ? { target } : {}) }), scope.space), json, parsed.values.plain === true, scope, rest);
      }
      // A registry record or directory it could not read is refused by its file, as `space` reports
      // it, and as a target it could not resolve is refused above.
      if (isMeshRegistryError(e)) failureExit(cmd, inOperationSpace(registryFailure(e), scope.space), json, parsed.values.plain === true, scope, rest);
      if (e instanceof CatalogPreparationError) failureExit(cmd, new CommandFailure("refused", e.code, e.message), json, parsed.values.plain === true, scope, rest);
      failureExit(cmd, inOperationSpace(new CommandFailure("unknown", "OPERATION_UNKNOWN", e instanceof Error ? e.message : String(e), { cause: e }), scope.space), json, parsed.values.plain === true, scope, rest);
    }
    // A workspace TARGET error carries structured recovery — which entry, whether it was removed,
    // what to run next — and has its own renderer. Its raw `.message` is deliberately dev-safe
    // rather than product copy, so falling through to the generic line below strips the removed
    // fact and the action, leaving the operator a diagnosis they cannot act on. Rendering it HERE
    // covers every path that lets one reach the boundary, not just the ones that happen to call an
    // `…OrExit` helper.
    if (isWorkspaceTargetError(e)) {
      console.error(paintFor(process.stderr, () => c.red(renderWorkspaceError({ kind: "target", error: e }))));
      if (debugFlag("COTAL_DEBUG") && e instanceof Error && e.stack) console.error(c.dim(e.stack));
      process.exit(1);
    }
    // A command without structured output shows the same choice and keeps its exit 1.
    const restated = isConnectRefusal(e) ? await managerChoice().then(({ managerChoiceFailure, rosterOf }) => managerChoiceFailure(e.failure(), () => rosterOf(target), argv)) : undefined;
    if (restated) {
      writeSync(2, `${renderReport(commandFailureReport(restated), parsed.values.plain === true ? "plain" : "rich", process.stderr)}\n`);
      process.exit(1);
    }
    // Every other command failure (a broker permission denial, a missing --creds file, a failed
    // connect) is presented as ONE clean line, never a raw Node stack trace: the CLI's fail-loud
    // contract is "denied, not absent", not a crash. The full stack stays available under
    // COTAL_DEBUG for diagnosis.
    const msg = e instanceof Error ? e.message : String(e);
    stderrLine("✗ ", msg, c.red);
    // Known failure signatures get a one-line operator hint (e.g. a stale-store durable
    // collision names the `cotal clean` reset) - the error itself stays verbatim.
    const hint = staleStoreHint(msg);
    if (hint) stderrLine("  ↳ ", hint, c.dim);
    if (debugFlag("COTAL_DEBUG") && e instanceof Error && e.stack) console.error(c.dim(e.stack));
    process.exit(1);
  }
}
