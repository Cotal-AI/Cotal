import { writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
  brokerUrlCredentialRefusal,
  brokerUrlHasUserinfo,
  isConnectRefusal,
  isMeshRegistryError,
  isSeededCommand,
  isWorkspaceTargetError,
  localeIsUtf8,
  operationWarnings,
  outputDeclarationProblems,
  oneLine,
  preferencesFolderWarning,
  recordOperationWarning,
  renderReport,
  renderWorkspaceError,
  runOperation,
  workspaceErrorParts,
  spaceRootTarget,
  targetErrorCode,
  terminalWidth,
  userCotalDir,
  type OperationScope,
  type OutputWarning,
} from "@cotal-ai/workspace";
import { c, staleStoreHint, stderrLine } from "./ui.js";
import { debugFlag } from "./lib/debug-flag.js";
import {
  isExtensionStub,
  materializeExtension,
  materializeExtensionCommand,
  overlayExtensions,
  setCommandSurface,
  setInstalledExtensionsEnabled,
} from "./ext-loader.js";
import { deferredSeedRefusal, reconcileSeededConnectors } from "./seed/reconcile.js";
import { deferSeedToLaunch } from "./seed/launch.js";
import { isAuthenticSeedChild } from "./seed/lock.js";
import { printCommandHelp, printHelpPath, printEntry } from "./help.js";
import { CatalogPreparationError, prepareCatalogCommand } from "./commands/sync.js";
import { keepStartupNotice, type StartupNotice } from "./lib/interrupt-notice.js";
import { metadataPositionals } from "./lib/command-path.js";
import { chooseMeshTarget } from "./lib/choose-target.js";
import { registryFailure } from "./lib/registry-errors.js";
import { FlagValueRefusal } from "./lib/flag-value-refusal.js";
import { workingFolderRemoved } from "./lib/paths.js";
import { reportLostOutput } from "./lib/stdout-owner.js";
import { shellWord } from "./lib/endpoint-errors.js";
import { GLOBAL_FLAG_WORDS, OUTPUT_FLAG_WORDS } from "./lib/leading-flags.js";
import { takeManagedHandoffCustody } from "./managed-handoff.js";
import { didYouMean, unknownCommandMessage, unknownSubcommandMessage } from "./lib/nearest-word.js";
import { UnusableFile } from "./lib/unusable-file.js";
import { armTelemetry, recordTelemetryError, recordTelemetryFailure } from "./telemetry.js";

// The service surfaces, the manager choice and the gone-stack refusal are imported where a command
// or a failure needs them, so a process that runs one daemon command never loads them.
const serviceSurfaces = () => Promise.all([import("./lib/service-presets.js"), import("./commands/manager-service.js")]);
const managerChoice = () => import("./lib/manager-choice.js");

/** Whether `args` ask for help: `--help` or `-h` before any `--`, after which every word is text. */
function asksForHelp(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  return options.includes("--help") || options.includes("-h");
}

/** Whether a global flag ({@link GLOBAL_FLAG_WORDS}: `--no-color`, `--no-input`) is `word`, applying
 *  it when it is. */
function takeGlobalFlag(word: string): boolean {
  if (!GLOBAL_FLAG_WORDS.has(word)) return false;
  if (word === "--no-color") disableColor();
  else if (word === "--no-input") disableInput();
  else return false;
  return true;
}

/** Node's unknown-option error, trimmed to its first sentence, with the nearest of `cmd`'s flags. */
function parseErrorMessage(cmd: Command, e: Error): string {
  const message = e.message.split(".")[0]!;
  const option = (e as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? /^Unknown option '(--[^']+)'/.exec(message)?.[1] : undefined;
  const hint = option ? didYouMean(option, [...(cmd.flags ?? []).map((flag) => `--${flag.name}`), "--no-color", "--no-input", "--help"]) : "";
  return hint ? `${message} - ${hint}` : message;
}

/** `words` without the global flags before any `--`, each applied. A global flag is given once, as
 *  any flag is: one already in `words` or in `leading`, those taken before the command word, is the
 *  usage error a repeated flag of `cmd` is. */
function stripGlobalFlags(words: readonly string[], leading: ReadonlySet<string> = new Set(), cmd?: Command): string[] {
  const end = words.indexOf("--");
  const taken = new Set(leading);
  const head = (end === -1 ? words : words.slice(0, end)).filter((word) => {
    if (taken.has(word)) usageExit(`Option '${word}' cannot be repeated`, cmd, cmd !== undefined && asksForJson(cmd, words), words.includes("--plain"));
    if (!takeGlobalFlag(word)) return true;
    taken.add(word);
    return false;
  });
  return end === -1 ? head : [...head, ...words.slice(end)];
}

/** Whether `cmd` takes its words raw: it declares so, or it is an internal command, whose words are
 *  another command line. Such a command parses no flags of its own. */
function takesWordsRaw(cmd: Command | undefined): boolean {
  return Boolean(cmd && (cmd.rawArgs || cmd.name.startsWith("__")));
}

/** The words `cmd` parses: the global flags are the kernel's, except for a command that takes its
 *  words raw. */
function ownWords(cmd: Command | undefined, words: readonly string[], leading: ReadonlySet<string>): string[] {
  return takesWordsRaw(cmd) ? [...words] : stripGlobalFlags(words, leading, cmd);
}

/** Whether the invoked mode declares a structured output, so it reports every outcome by the 0 to 5
 *  table: the subcommand `first` selects, else the command's bare form. */
function structured(cmd: Command, first: string | undefined): boolean {
  const sub = findSubcommand(cmd, first);
  return ((sub ? sub.outputs : cmd.outputs) ?? []).some((mode) => mode === "json" || mode === "ndjson");
}

/** Whether `args` ask `cmd` for JSON before any `--`: `--json`, `-j`, or `-j` in a group of the
 *  command's boolean short flags. Read from the words, because a usage error has no parse, so the mode
 *  is the first word that is not a flag. */
function asksForJson(cmd: Command, args: readonly string[]): boolean {
  if (!structured(cmd, args.find((word) => !word.startsWith("-")))) return false;
  const booleans = new Set((cmd.flags ?? []).flatMap((flag) => (flag.type === "boolean" && flag.short ? [flag.short] : [])));
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).some(
    (word) => word === "--json" || word === "-j" || (/^-[A-Za-z]{2,}$/.test(word) && word.includes("j") && [...word.slice(1)].every((ch) => booleans.has(ch))),
  );
}

/** Under COTAL_DEBUG, print the failure's stack and the stack of each error that caused it. */
function debugStacks(failure: Error): void {
  if (!debugFlag("COTAL_DEBUG")) return;
  let error: unknown = failure;
  for (let depth = 0; error instanceof Error && depth < 8; error = error.cause, depth++) if (error.stack) console.error(c.dim(error.stack));
}

/** A classified failure: its line and remedy on stderr, its envelope on stdout when one was asked
 *  for, and the exit code its outcome sets. The envelope is written synchronously, because stdout
 *  to a pipe is asynchronous on some platforms and `exit` would cut it short. */
function failureExit(cmd: Command, failure: CommandFailure, json: boolean, plain = false, scope?: OperationScope): never {
  const warnings = scope ? scope.warnings ?? [] : operationWarnings();
  recordTelemetryFailure(failure.outcome, failure.code, failure);
  // A command's own usage refusal reads as the parser's: the error, its remedy, then the help. A
  // missing --yes, a missing scripted input or a removed working folder is not a grammar mistake,
  // and its remedy says the whole fix. A file the command cannot use is reported like one that does
  // not exist, and a refused flag value names its corrected value, so it gets the classified report.
  if (failure.code === "USAGE_INVALID" && !json && !(failure instanceof UnusableFile) && !(failure instanceof FlagValueRefusal)) {
    usageRefusal(failure, plain, failure.selfContained ? undefined : cmd);
    debugStacks(failure);
    process.exit(1);
  }
  // Rendered in the run's scope, so the `Mesh:` heading keeps the note on how the run chose its space.
  const report = () => renderReport(commandFailureReport(failure), plain ? "plain" : "rich", terminalWidth(process.stderr));
  const writeReport = () => writeSync(2, `${scope ? runOperation(scope, report) : report()}
`);
  // Under --json the envelope alone reports the failure. Its text report goes to stderr only when the
  // envelope cannot be written, and the exit status below stands either way.
  if (!json) writeReport();
  else try { writeSync(1, envelopeLine(failureEnvelope(cmd.name, failure, warnings))); }
  catch (error) {
    reportLostOutput(error as NodeJS.ErrnoException);
    try { writeReport(); } catch { /* stderr failed too; the exit status still says so */ }
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
async function extSeedGate(registry: Registry, argv: string[], configFolder: ConfigFolderProblem | undefined, leading: ReadonlySet<string>): Promise<boolean> {
  const [word, sub] = argv;
  const extCmd = word === undefined || !registry.has("command", word) ? undefined : registry.resolve<Command>("command", word);
  if (extCmd?.name !== "ext" || sub !== "seed") return false;
  // A help request short-circuits to usage and mutates NOTHING (the maintenance run writes the seed
  // stamp/manifest).
  if (asksForHelp(argv)) {
    printCommandHelp(extCmd);
    return true;
  }
  if (configFolder) failureExit(extCmd, configFolderRefusal(configFolder), false);
  await extCmd.run(parseCommandArgs(extCmd, stripGlobalFlags(argv.slice(1), leading, extCmd)));
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
function skipsSeed(name: string, sub: string | undefined, argv: readonly string[], cmd?: Command): boolean {
  if (name === "help" || name === "version" || name === "__complete" || name === "completion") return true;
  if (cmd && readsOnly(cmd, sub)) return true;
  if (name === "use" && sub === undefined) return true; // bare `use` shows the selection: a read
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
  if (name === "reset" || name === "down" || name === "doctor" || name === "feedback" || (name === "backup" && sub !== "restore") || name === "mint" || (name === "manager" && sub !== "start" && sub !== "restart") || name === "channel" || name === "stop" || name === "input" || name === "auth" || name === "endpoint" || name === "service" || name === "daemon") return true; // native maintenance and channel policy never install connector packages
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
  if (name === "agent-bearer") return true;
  // `app-identity` is machine-facing too: the Claude connector's local server runs it on every
  // connection, so, like a credential exchange, it must not seed the store under a running connector.
  if (name === "app-identity") return true;
  return false;
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

/** A usage refusal on stderr, then `cmd`'s help when one is given. Plain output and a locale without
 *  UTF-8 have no refusal mark, so there the refusal is the classified report, which names its outcome
 *  in words. Either way the words it quotes are escaped, as the report escapes every text. */
function usageRefusal(failure: CommandFailure, plain: boolean, cmd?: Command): void {
  const report = plain || !localeIsUtf8();
  if (report) writeSync(2, `${renderReport(commandFailureReport(failure), plain ? "plain" : "rich", terminalWidth(process.stderr))}\n`);
  else {
    stderrLine("✗ ", oneLine(failure.message), c.red);
    if (failure.remedy) stderrLine("  ", oneLine(failure.remedy), c.dim);
  }
  if (!cmd) return;
  if (report) console.error("");
  printCommandHelp(cmd, undefined, (line) => console.error(line), terminalWidth(process.stderr));
}

/** A usage error, written by {@link usageRefusal} with the command's help when there is one, and
 *  with `remedy` under the message when the parser can name one. Exit 1. */
function usageExit(message: string, cmd?: Command, json = false, plain = false, remedy?: string): never {
  // A JSON caller gets the refusal as an envelope, so stdout stays one document and the help text
  // the remedy names stays out of it.
  if (cmd && json) failureExit(cmd, new CommandFailure("refused", "USAGE_INVALID", message, { remedy: remedy ?? `run \`cotal help ${cmd.name}\`` }), true);
  recordTelemetryFailure("refused", "USAGE_INVALID", message);
  // The help goes to stderr with the reason, so a refused run leaves stdout empty and a script that
  // sources or parses it gets nothing.
  usageRefusal(new CommandFailure("refused", "USAGE_INVALID", message, remedy === undefined ? undefined : { remedy }), plain, cmd);
  process.exit(1);
}

/** An option the parser would misread without an error: a short option written `-c=value`, which
 *  takes `=value` as its value, or a declared option typed with a typographic dash pasted from typeset
 *  text, which is read as a positional. */
function misspelledOption(cmd: Command, rest: readonly string[]): { message: string; remedy: string } | undefined {
  const names = new Set<string>([...(cmd.flags ?? []).map((flag) => flag.name), ...GLOBAL_FLAGS]);
  const shorts = new Set<string>((cmd.flags ?? []).flatMap((flag) => (flag.short ? [flag.short] : [])));
  for (const [index, word] of rest.entries()) {
    if (word === "--") return undefined;
    const previous = rest[index - 1];
    if (previous !== undefined && cmd.flags?.some((flag) => flag.type === "string" && (previous === `--${flag.name}` || previous === `-${flag.short}`))) continue;
    const short = /^-([^-=])=(.*)$/su.exec(word);
    const flag = short && cmd.flags?.find((item) => item.short === short[1] && item.type === "string");
    if (short && flag) return { message: `${word} gives -${short[1]} the value "=${short[2]}"`, remedy: `write -${short[1]} ${short[2]} or --${flag.name}=${short[2]}` };
    const typed = /^[\u2010-\u2015\u2212][-\u2010-\u2015\u2212]*([^=]+)/u.exec(word);
    if (typed && (names.has(typed[1]!) || shorts.has(typed[1]!)))
      return { message: `${word} starts with a typographic dash, so it is not an option`, remedy: `type the option with hyphens: ${names.has(typed[1]!) ? "--" : "-"}${typed[1]}` };
  }
  return undefined;
}

/** A parse error as a refusal. Node's message is trimmed to its first sentence, and the hint its tail
 *  carries is given as the remedy in this CLI's words: a word that starts with `-` goes after `--`,
 *  an option value that starts with `-` is written `--name=value`, and an option given with no value,
 *  last or before another of the command's options, is named with its placeholder. */
function parseRefusal(error: Error & { code?: string }, cmd: Command, rest: readonly string[]): { message: string; remedy?: string } {
  const message = parseErrorMessage(cmd, error);
  if (error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && cmd.positionals !== undefined)
    return { message, remedy: "to pass a word that starts with \"-\", put -- before it" };
  const missingValue = (flag: FlagSpec) => ({ message: `--${flag.name} needs a value`, remedy: `write --${flag.name} ${flag.value ?? "<value>"}` });
  const bare = /^Option '(?:-[^,']+, )?--([^ ']+) <value>' argument missing/.exec(error.message)?.[1];
  const last = bare === undefined ? undefined : cmd.flags?.find((item) => item.name === bare);
  if (error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && last) return missingValue(last);
  const long = /use '--([^=']+)=-XYZ'/.exec(error.message)?.[1];
  const flag = long === undefined ? undefined : cmd.flags?.find((item) => item.name === long);
  if (error.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" && flag) {
    const at = rest.findIndex((word) => word === `--${flag.name}` || (flag.short !== undefined && word === `-${flag.short}`));
    const value = at < 0 ? undefined : rest[at + 1];
    if (value !== undefined && cmd.flags?.some((item) => value === `--${item.name}` || value.startsWith(`--${item.name}=`) || (item.short !== undefined && value === `-${item.short}`)))
      return missingValue(flag);
    if (value?.startsWith("-")) return { message: `the value of --${flag.name} starts with "-", so it reads as an option`, remedy: `write it as --${flag.name}=${value}` };
  }
  return { message };
}

/** `rest` parsed against `cmd`'s declared flags, positionals and subcommands, or a usage exit. */
function parseOrExit(cmd: Command, rest: string[]): ParsedArgs {
  const json = asksForJson(cmd, rest);
  const plain = rest.includes("--plain");
  const misspelled = cmd.rawArgs ? undefined : misspelledOption(cmd, rest);
  if (misspelled) usageExit(misspelled.message, cmd, json, plain, misspelled.remedy);
  let parsed: ParsedArgs;
  try {
    parsed = parseCommandArgs(cmd, rest);
  } catch (e) {
    if (isArgError(e)) {
      const refusal = parseRefusal(e as Error & { code?: string }, cmd, rest);
      usageExit(refusal.message, cmd, json, plain, refusal.remedy);
    }
    throw e;
  }
  const first = parsed.positionals[0];
  // History also accepts a root channel positional; only its reserved clear token is a mode.
  if (cmd.subcommands?.length && first !== undefined && cmd.name !== "history" && !findSubcommand(cmd, first))
    usageExit(unknownSubcommandMessage(cmd.name, cmd, first), cmd, json, plain);
  // Target resolution reads an empty space as no space and falls back to the selected one, so a script
  // whose variable is unset would act on whichever space is selected.
  const spaceFlag = cmd.flags?.find((flag) => flag.name === "space");
  if (spaceFlag && typeof parsed.values.space === "string" && !parsed.values.space.trim())
    failureExit(cmd, new CommandFailure("refused", "USAGE_INVALID", `--space${spaceFlag.short ? `/-${spaceFlag.short}` : ""} is empty; name one space`, { remedy: "name the space; `cotal space` lists the spaces this machine knows" }), json, parsed.values.plain === true);
  // An empty --store-dir reads as no value and opens the default store, and a ~ no shell expanded
  // names a folder called ~ in the working folder.
  const storeDir = parsed.values["store-dir"];
  if (typeof storeDir === "string" && (!storeDir.trim() || storeDir.startsWith("~")))
    failureExit(cmd, storeDirRefusal(storeDir), json, parsed.values.plain === true);
  // `--json` implies `--no-input`: a script reading one document cannot answer a prompt.
  if (structured(cmd, first) && parsed.values.json === true) disableInput();
  const canonical = canonicalSubcommand(cmd, parsed);
  refuseRemovedFolder(cmd, canonical);
  try {
    cmd.validate?.(canonical);
  } catch (error) {
    if (isCommandFailure(error)) failureExit(cmd, error, json, canonical.values.plain === true);
    if (isArgError(error)) usageExit((error as Error).message.split(".")[0]!, cmd, json, plain);
    throw error;
  }
  // The NATS client keeps only the host and port of a broker URL, so a user and password in it were
  // dropped in silence and the command connected with whatever credential it resolved instead. A
  // command whose own check names this, such as `up`'s, has refused above. The value is never repeated.
  if (cmd.flags?.some((flag) => flag.name === "server") && typeof canonical.values.server === "string" && brokerUrlHasUserinfo(canonical.values.server))
    failureExit(cmd, brokerUrlCredentialRefusal("--server"), json, canonical.values.plain === true);
  return canonical;
}

/** The refusal of a `--store-dir` that is empty, or that starts with a `~` no shell expanded. */
function storeDirRefusal(value: string): CommandFailure {
  if (!value.trim()) return new CommandFailure("refused", "USAGE_INVALID", "--store-dir is empty; the command did not run", { remedy: "name the store directory, or omit --store-dir to use the default store", selfContained: true });
  const home = value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(2)) : undefined;
  return new CommandFailure("refused", "USAGE_INVALID", `--store-dir ${JSON.stringify(value)} starts with ~, which no shell expanded, so it names a folder called ${value.split("/")[0]} in ${process.cwd()}; the command did not run`, { target: { storeDir: value }, remedy: home ? `name the absolute path: --store-dir ${shellWord(home)}` : "name the store directory by its absolute path", selfContained: true });
}

/** The commands that never read the working folder, so they run from one that was removed. */
const FOLDERLESS = new Set(["help", "version", "completion", "docs", "telemetry"]);

/** A working folder removed before this process read it fails every cwd read the command makes, and
 *  Node caches the first read that succeeds. One read refuses that case before the command's own
 *  checks, such as `up`'s, or any effect, unless the command never reads the folder. */
function refuseRemovedFolder(cmd: Command, parsed: ParsedArgs): void {
  if (cmd.name.startsWith("__") || FOLDERLESS.has(cmd.name) || !workingFolderRemoved()) return;
  failureExit(cmd, new CommandFailure("refused", "USAGE_INVALID", "this folder no longer exists", { remedy: "cd to an existing folder and run the command again", selfContained: true }), structured(cmd, parsed.positionals[0]) && parsed.values.json === true, parsed.values.plain === true);
}

/** The parsed args with a subcommand alias in the first positional replaced by its name, so `run`
 *  only ever sees canonical subcommands. */
function canonicalSubcommand(cmd: Command, parsed: ParsedArgs): ParsedArgs {
  const positionals = [...parsed.positionals];
  let surface: Pick<Command, "subcommands"> = cmd;
  let changed = false;
  for (let index = 0; index < positionals.length; index++) {
    const sub = findSubcommand(surface, positionals[index]);
    if (!sub) break;
    changed ||= sub.name !== positionals[index]; positionals[index] = sub.name;
    surface = sub;
    if (!sub.subcommands?.length) break;
  }
  return changed ? { ...parsed, positionals } : parsed;
}

/** `-h`/`--help` anywhere after a command: that command's help, or its subcommand's when the first
 *  positional names one. Read from the declared specs, so a stub's help never imports its package. */
function printHelpFor(cmd: Command, rest: readonly string[]): void {
  const words = metadataPositionals(cmd, rest).positionals.map((item) => item.value);
  let surface: Pick<Command, "subcommands"> = cmd;
  const path: string[] = [];
  for (const word of words) {
    const sub: Subcommand | undefined = findSubcommand(surface, word);
    // A word where a subcommand belongs that names none refuses as `cotal help` does, so a mistyped
    // subcommand never gets its group's help. History's own first word may be a channel.
    if (!sub && surface.subcommands?.length && !(surface === cmd && cmd.name === "history")) return printHelpPath(cmd, [...path, word]);
    if (!sub || sub.hidden) break;
    path.push(sub.name); surface = sub;
    if (!sub.subcommands?.length) break;
  }
  printHelpPath(cmd, path);
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
  // Global flags before the command word apply whatever the command is. The output flags are the
  // command's own, so one written before the command word moves after it, and a `--` there ends
  // the leading flags. A command that takes its words raw has no flags to read them as, so it
  // refuses them there. The built-in surface decides that before any extension overlay is read.
  const output: string[] = [];
  const leadingGlobals = new Set<string>();
  let lead = 0;
  for (; lead < argv.length; lead++) {
    const word = argv[lead]!;
    if (OUTPUT_FLAG_WORDS.has(word)) output.push(word);
    else if (leadingGlobals.has(word)) usageExit(`Option '${word}' cannot be repeated`);
    else if (takeGlobalFlag(word)) leadingGlobals.add(word);
    else break;
  }
  if (argv[lead] === "--") lead++;
  if (output.length && lead >= argv.length) usageExit(`${output[0]} needs a command after it - run \`cotal help\` to list commands`);
  if (output.length && takesWordsRaw(findCommand(registry.all<Command>("command"), argv[lead])))
    usageExit(`${output[0]} before ${argv[lead]} is not read - ${argv[lead]} takes its words raw, with no output flags`);
  argv = [...argv.slice(lead, lead + 1), ...output, ...argv.slice(lead + 1)];
  // A recorded unit boots from built-in code only. Even reading the extension overlay can
  // prevent recovery from an unrelated broken manifest. Validate before any handoff custody,
  // installation repair, package materialization or target preparation. This is one exact
  // private entry, not an exemption for arbitrary internal or extension command names.
  if (argv[0] === "__service-unit") {
    if (!registry.has("command", "__service-unit")) usageExit("the native unit entry is not available in this composition root");
    const unit = registry.resolve<Command>("command", "__service-unit");
    const parsed = parseOrExit(unit, argv.slice(1));
    try { await unit.run(parsed); }
    catch (error) {
      failureExit(unit, isCommandFailure(error) ? error : new CommandFailure("unknown", "OPERATION_UNKNOWN", "the original unit entry did not confirm its outcome; no replacement or repair was attempted"), false, true);
    }
    return;
  }
  // Before any ordinary dispatch outcome can exit, a spawn takes its handoff, and no command lets a
  // child inherit the variable. The unit entry refuses such a handoff without consuming its file.
  takeManagedHandoffCustody(process.env, findCommand(registry.all<Command>("command"), argv[0])?.name === "spawn");
  setInstalledExtensionsEnabled(Boolean(opts.extensions));
  // The global spellings of help and version are the `help` and `version` commands.
  if (argv[0] === "-v") usageExit("-v is not the version flag - run `cotal version` or `cotal -V`");
  if (argv[0] === "--version" || argv[0] === "-V") argv = ["version", ...argv.slice(1)];
  else if (argv[0] === "--help" || argv[0] === "-h") argv = ["help", ...argv.slice(1)];
  const configFolder = globalConfigDirProblem();
  if (opts.extensions) {
    try {
      if (await extSeedGate(registry, argv, configFolder, leadingGlobals)) return;
    } catch (e) {
      stderrLine("✗ ", (e as Error).message, c.red);
      process.exit(1);
    }
  }
  const surface = (): Command[] => {
    let commands: Command[];
    try {
      commands = opts.extensions ? overlayExtensions(registry) : registry.all<Command>("command");
    } catch (e) {
      // A corrupt extensions manifest must not silently shrink the surface — fatal and loud, but
      // rendered as the CLI's one red line, not an unhandled-rejection stack dump.
      stderrLine("✗ ", (e as Error).message, c.red);
      process.exit(1);
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
  let commands = surface();
  const [word, ...words] = argv;
  if (word === undefined) return printEntry(commands);
  let cmd = findCommand(commands, word);
  let rest = ownWords(cmd, words, leadingGlobals);
  const wantsHelp = asksForHelp(rest);
  // A service invocation takes its preset's flags, and `manager <verb>` is `service <verb> manager`.
  // Both are read again after the seed below re-resolves the command.
  const serviceSurface = async (found: Command | undefined, words: string[]): Promise<{ cmd: Command | undefined; rest: string[] }> => {
    if (found?.name !== "service" && found?.name !== "manager") return { cmd: found, rest: words };
    const [{ servicePresetCommand }, { managerServiceCommand }] = await serviceSurfaces();
    try {
      if (found.name === "service") return { cmd: servicePresetCommand(found, words), rest: words };
      const lifecycle = managerServiceCommand(found, words);
      return lifecycle ? { cmd: lifecycle.cmd, rest: lifecycle.argv } : { cmd: found, rest: words };
    } catch (error) {
      const failure = isCommandFailure(error) ? error : new CommandFailure("refused", "SCHEMA_INVALID", "service preset metadata could not be read; no provider was imported or installed");
      return failureExit(found, failure, asksForJson(found, words), words.includes("--plain"));
    }
  };
  ({ cmd, rest } = await serviceSurface(cmd, rest));
  // The usage telemetry hook is armed as soon as the command is known, so a usage refusal below
  // counts too, and before anything runs, so the one-time notice precedes the command's output.
  const arm = (): void => {
    if (!cmd) return;
    try {
      armTelemetry(registry, cmd, words, startedAt);
    } catch (e) {
      if (isCommandFailure(e)) failureExit(cmd, e, asksForJson(cmd, rest), rest.includes("--plain"));
      throw e;
    }
  };
  arm();
  // A seeded package's command (`web`) can be absent only because the first seed has not installed
  // it yet, so running it seeds and resolves again. Asking for its help seeds nothing, and any other
  // unknown word is a usage error.
  const awaitingSeed = !cmd && opts.extensions === true && isSeededCommand(word) && !wantsHelp && !skipsSeed(word, rest[0], rest);
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
    failureExit(cmd, configFolderRefusal(configFolder), structured(cmd, parsed.positionals[0]) && parsed.values.json === true, parsed.values.plain === true);
  // The seed can install or upgrade an extension package, so the surface is read again after it and
  // an extension stub resolves against the manifest the seed left.
  const controlOnlyManager = parsed?.values.execution === "none" && (cmd?.name === "supervise" || cmd?.name === "__daemon-manager");
  if (opts.extensions && !controlOnlyManager && !skipsSeed(cmd?.name ?? word, parsed ? parsed.positionals[0] : rest[0], rest, cmd)) {
    // `up` meets the seed's refusals here but seeds only when it first starts a process, so a refusal
    // in its own body leaves the operator-global store as it found it.
    const deferred = cmd?.name === "up";
    try {
      if (deferred) {
        const refusal = deferredSeedRefusal();
        if (refusal) throw refusal;
        deferSeedToLaunch();
      } else await reconcileSeededConnectors();
    } catch (e) {
      stderrLine("✗ ", (e as Error).message, c.red);
      process.exit(1);
    }
    if (!deferred) {
      commands = surface();
      cmd = findCommand(commands, word);
      if (!cmd) usageExit(unknownCommandMessage(commands, word));
      ({ cmd, rest } = await serviceSurface(cmd, ownWords(cmd, words, leadingGlobals)));
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
  // completion, version and docs use no preference, and status reports the file as a warning, so they
  // still run. `--help` on a command has already returned above.
  if (!cmd.name.startsWith("__") && cmd.name !== "help" && cmd.name !== "completion") {
    // A relative COTAL_HOME would name another home in each folder a command runs in, and a
    // COTAL_HOME that cannot be a directory can hold no record: both stop them before any command
    // reads it.
    const home = process.env.COTAL_HOME;
    if (home && !isAbsolute(home)) failureExit(cmd, new CommandFailure("refused", "USAGE_INVALID", `COTAL_HOME ${JSON.stringify(home)} is a relative path, so each folder a command runs in would have its own Cotal home; the command did not run`, { remedy: `set COTAL_HOME to an absolute path, or unset it to use ${userCotalDir()}` }), structured(cmd, parsed.positionals[0]) && parsed.values.json === true, parsed.values.plain === true);
    const homeProblem = cotalHomeProblem();
    if (homeProblem) failureExit(cmd, new CommandFailure("refused", "SCHEMA_INVALID", `${homeProblem}; the command did not run`, { remedy: `point COTAL_HOME at a directory, or unset it to use ${userCotalDir()}` }), structured(cmd, parsed.positionals[0]) && parsed.values.json === true, parsed.values.plain === true);
    // A `.cotal` that is a file in the folder the command uses, such as someone's notes, holds no
    // records, and every reader would otherwise report a different wrong cause.
    const dirProblem = cmd.name === "version" || workingFolderRemoved() ? undefined : cotalDirProblem(typeof parsed.values.root === "string" ? resolve(parsed.values.root) : findCotalRoot());
    if (dirProblem) failureExit(cmd, new CommandFailure("refused", "CONFLICT", `${dirProblem}; the command did not run`, { remedy: "rename or move that file, then run the command again" }), structured(cmd, parsed.positionals[0]) && parsed.values.json === true, parsed.values.plain === true);
    if (!["version", "docs", "status"].includes(cmd.name)) {
      try {
        cachedPreferences();
      } catch (e) {
        if (!isCommandFailure(e)) throw e;
        failureExit(cmd, e, structured(cmd, parsed.positionals[0]) && parsed.values.json === true, parsed.values.plain === true);
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
        if (folder) recordOperationWarning(folder.warning);
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
    if (isArgError(e)) usageExit((e as Error).message.split(".")[0]!, cmd, json, parsed.values.plain === true);
    // A refused manager selection among several live managers becomes the choice: each manager
    // and the command again with `--on` for it. A space whose stack folder is gone names its stop.
    const target = { space: typeof parsed.values.space === "string" ? parsed.values.space : undefined, server: typeof parsed.values.server === "string" ? parsed.values.server : undefined };
    const choice = async (failure: CommandFailure) => {
      const [{ managerChoiceFailure, rosterOf }, { goneStackRefusal }] = await Promise.all([managerChoice(), import("./commands/stack-gone.js")]);
      return (await managerChoiceFailure(failure, () => rosterOf(target), argv)) ?? goneStackRefusal(failure);
    };
    if (isCommandFailure(e)) failureExit(cmd, inOperationSpace(await choice(e), scope.space), json, parsed.values.plain === true, scope);
    // A command that declares a structured output reports by the outcome table. A target it could
    // not resolve or connect to is refused before any request, under the refusal's own code; a
    // failure it did not classify is unknown: it may have had effects that cannot be attributed.
    if (structured(cmd, mode)) {
      if (isConnectRefusal(e)) failureExit(cmd, inOperationSpace(await choice(e.failure()), scope.space), json, parsed.values.plain === true, scope);
      if (isWorkspaceTargetError(e)) {
        const { message, remedy } = workspaceErrorParts({ kind: "target", error: e });
        const target = spaceRootTarget(e.details);
        failureExit(cmd, inOperationSpace(new CommandFailure("refused", targetErrorCode(e.code), message, { ...(remedy ? { remedy } : {}), ...(target ? { target } : {}) }), scope.space), json, parsed.values.plain === true, scope);
      }
      // A registry record or directory it could not read is refused by its file, as `space` reports
      // it, and as a target it could not resolve is refused above.
      if (isMeshRegistryError(e)) failureExit(cmd, inOperationSpace(registryFailure(e), scope.space), json, parsed.values.plain === true, scope);
      if (e instanceof CatalogPreparationError) failureExit(cmd, new CommandFailure("refused", e.code, e.message), json, parsed.values.plain === true, scope);
      failureExit(cmd, inOperationSpace(new CommandFailure("unknown", "OPERATION_UNKNOWN", e instanceof Error ? e.message : String(e), { cause: e }), scope.space), json, parsed.values.plain === true, scope);
    }
    // A workspace TARGET error carries structured recovery — which entry, whether it was removed,
    // what to run next — and has its own renderer. Its raw `.message` is deliberately dev-safe
    // rather than product copy, so falling through to the generic line below strips the removed
    // fact and the action, leaving the operator a diagnosis they cannot act on. Rendering it HERE
    // covers every path that lets one reach the boundary, not just the ones that happen to call an
    // `…OrExit` helper.
    if (isWorkspaceTargetError(e)) {
      console.error(c.red(renderWorkspaceError({ kind: "target", error: e })));
      if (debugFlag("COTAL_DEBUG") && e instanceof Error && e.stack) console.error(c.dim(e.stack));
      process.exit(1);
    }
    // A command without structured output shows the same choice and keeps its exit 1.
    const restated = isConnectRefusal(e) ? await managerChoice().then(({ managerChoiceFailure, rosterOf }) => managerChoiceFailure(e.failure(), () => rosterOf(target), argv)) : undefined;
    if (restated) {
      writeSync(2, `${renderReport(commandFailureReport(restated), parsed.values.plain === true ? "plain" : "rich", terminalWidth(process.stderr))}\n`);
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
