import { writeSync } from "node:fs";
import { commandDeclarationProblems, findCommand, findSubcommand, parseCommandArgs, type Command, type ParsedArgs, type Registry, type Subcommand } from "@cotal-ai/core";
import {
  CommandFailure,
  commandFailureReport,
  cachedPreferences,
  disableColor,
  disableInput,
  envelopeLine,
  exitCode,
  failureEnvelope,
  globalFlagDeclarationProblems,
  hasMeshTargetFlags,
  inOperationSpace,
  isCommandFailure,
  isConnectRefusal,
  isSeededCommand,
  isWorkspaceTargetError,
  outputDeclarationProblems,
  renderReport,
  renderWorkspaceError,
  runOperation,
  workspaceErrorParts,
  targetErrorCode,
  terminalWidth,
  type OperationScope,
} from "@cotal-ai/workspace";
import { c, staleStoreHint, stderrLine } from "./ui.js";
import {
  isExtensionStub,
  materializeExtension,
  materializeExtensionCommand,
  overlayExtensions,
  setCommandSurface,
  setInstalledExtensionsEnabled,
} from "./ext-loader.js";
import { reconcileSeededConnectors } from "./seed/reconcile.js";
import { isAuthenticSeedChild } from "./seed/lock.js";
import { printCommandHelp, printHelpPath, printEntry } from "./help.js";
import { CatalogPreparationError, prepareCatalogCommand } from "./commands/sync.js";
import { servicePresetCommand } from "./lib/service-presets.js";
import { metadataPositionals } from "./lib/command-path.js";
import { chooseMeshTarget } from "./lib/choose-target.js";
import { ConfirmationRequired } from "./lib/confirmation-required.js";
import { MissingFlags } from "./lib/missing-flags.js";
import { takeManagedHandoffCustody } from "./managed-handoff.js";
import { armTelemetry, recordTelemetryError, recordTelemetryFailure } from "./telemetry.js";

/** Whether `args` ask for help: `--help` or `-h` before any `--`, after which every word is text. */
function asksForHelp(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  return options.includes("--help") || options.includes("-h");
}

/** Whether a global flag (`--no-color`, `--no-input`) is `word`, applying it when it is. */
function takeGlobalFlag(word: string): boolean {
  if (word === "--no-color") disableColor();
  else if (word === "--no-input") disableInput();
  else return false;
  return true;
}

/** `words` without the global flags before any `--`, each applied. */
function stripGlobalFlags(words: readonly string[]): string[] {
  const end = words.indexOf("--");
  const head = (end === -1 ? words : words.slice(0, end)).filter((word) => !takeGlobalFlag(word));
  return end === -1 ? head : [...head, ...words.slice(end)];
}

/** Whether `cmd` takes its words raw: it declares so, or it is an internal command, whose words are
 *  another command line. Such a command parses no flags of its own. */
function takesWordsRaw(cmd: Command | undefined): boolean {
  return Boolean(cmd && (cmd.rawArgs || cmd.name.startsWith("__")));
}

/** The words `cmd` parses: the global flags are the kernel's, except for a command that takes its
 *  words raw. */
function ownWords(cmd: Command | undefined, words: readonly string[]): string[] {
  return takesWordsRaw(cmd) ? [...words] : stripGlobalFlags(words);
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
  if (!process.env.COTAL_DEBUG) return;
  let error: unknown = failure;
  for (let depth = 0; error instanceof Error && depth < 8; error = error.cause, depth++) if (error.stack) console.error(c.dim(error.stack));
}

/** A classified failure: its line and remedy on stderr, its envelope on stdout when one was asked
 *  for, and the exit code its outcome sets. The envelope is written synchronously, because stdout
 *  to a pipe is asynchronous on some platforms and `exit` would cut it short. */
function failureExit(cmd: Command, failure: CommandFailure, json: boolean, plain = false): never {
  recordTelemetryFailure(failure.outcome, failure.code, failure);
  // A command's own usage refusal reads as the parser's: the error, its remedy, then the help. A
  // missing --yes or a missing scripted input is not a grammar mistake, and its remedy says the
  // whole fix.
  if (failure.code === "USAGE_INVALID" && !json) {
    stderrLine("✗ ", failure.message, c.red);
    if (failure.remedy) stderrLine("  ", failure.remedy, c.dim);
    if (!(failure instanceof ConfirmationRequired) && !(failure instanceof MissingFlags)) printCommandHelp(cmd, undefined, (line) => console.error(line), terminalWidth(process.stderr));
    debugStacks(failure);
    process.exit(1);
  }
  writeSync(2, `${renderReport(commandFailureReport(failure), plain ? "plain" : "rich", terminalWidth(process.stderr))}
`);
  if (json) writeSync(1, envelopeLine(failureEnvelope(cmd.name, failure)));
  debugStacks(failure);
  process.exit(exitCode(failure.outcome, failure.code));
}

/**
 * `ext seed [--repair|--reset|--force]`, dispatched before the manifest overlay so repair survives a
 * corrupt manifest. Returns `true` iff `argv` was that command (or its help), so the caller returns.
 * The overlay cannot list the command yet, so the built-in `ext` is found through the registry,
 * which resolves its alias too.
 */
async function extSeedGate(registry: Registry, argv: string[]): Promise<boolean> {
  const [word, sub] = argv;
  const extCmd = word === undefined || !registry.has("command", word) ? undefined : registry.resolve<Command>("command", word);
  if (extCmd?.name !== "ext" || sub !== "seed") return false;
  // A help request short-circuits to usage and mutates NOTHING (the maintenance run writes the seed
  // stamp/manifest).
  if (asksForHelp(argv)) {
    printCommandHelp(extCmd);
    return true;
  }
  await extCmd.run(parseCommandArgs(extCmd, stripGlobalFlags(argv.slice(1))));
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
  if (name === "reset" || name === "down" || name === "doctor" || name === "feedback" || (name === "backup" && sub !== "restore") || name === "mint" || name === "manager" || name === "channel" || name === "stop" || name === "input" || name === "auth" || name === "endpoint" || name === "service" || name === "daemon") return true; // native maintenance and channel policy never install connector packages
  if (name === "run" && (sub === "turns" || sub === "yield")) return true; // self-only relay does not repair the operator installation
  if (name === "update") return true; // update owns one explicit reconcile; never auto-refresh then force-refresh
  // The seed is skipped for an INTERNAL CHILD re-exec — the `up`/`spawn` that spawns the delivery
  // daemon / manager / auth service sets COTAL_SKIP_CONNECTOR_SEED=1 in their env AFTER it reconciled,
  // so the child doesn't redo the seed on boot. A USER running the same public command directly (e.g.
  // `cotal supervise --roster`, the agent supervisor + container entrypoint) still seeds on first run.
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
}

/** A usage error, rendered as one red line plus the command's help when there is one. Exit 1. */
function usageExit(message: string, cmd?: Command, json = false): never {
  // A JSON caller gets the refusal as an envelope, so stdout stays one document and the help text
  // the remedy names stays out of it.
  if (cmd && json) failureExit(cmd, new CommandFailure("refused", "USAGE_INVALID", message, { remedy: `run \`cotal help ${cmd.name}\`` }), true);
  recordTelemetryFailure("refused", "USAGE_INVALID", message);
  // The help goes to stderr with the reason, so a refused run leaves stdout empty and a script that
  // sources or parses it gets nothing.
  stderrLine("✗ ", message, c.red);
  if (cmd) printCommandHelp(cmd, undefined, (line) => console.error(line), terminalWidth(process.stderr));
  process.exit(1);
}

/** `rest` parsed against `cmd`'s declared flags, positionals and subcommands, or a usage exit. Node's
 *  parse error is trimmed to its first sentence: the verbose "To specify a positional argument
 *  starting with a '-' …" tail is dropped. */
function parseOrExit(cmd: Command, rest: string[]): ParsedArgs {
  const json = asksForJson(cmd, rest);
  let parsed: ParsedArgs;
  try {
    parsed = parseCommandArgs(cmd, rest);
  } catch (e) {
    if (isArgError(e)) usageExit((e as Error).message.split(".")[0]!, cmd, json);
    throw e;
  }
  const first = parsed.positionals[0];
  // History also accepts a root channel positional; only its reserved clear token is a mode.
  if (cmd.subcommands?.length && first !== undefined && cmd.name !== "history" && !findSubcommand(cmd, first))
    usageExit(`cotal ${cmd.name} has no subcommand "${first}" - run \`cotal help ${cmd.name}\``, cmd, json);
  // `--json` implies `--no-input`: a script reading one document cannot answer a prompt.
  if (structured(cmd, first) && parsed.values.json === true) disableInput();
  const canonical = canonicalSubcommand(cmd, parsed);
  try {
    cmd.validate?.(canonical);
  } catch (error) {
    if (isCommandFailure(error)) failureExit(cmd, error, json, canonical.values.plain === true);
    if (isArgError(error)) usageExit((error as Error).message.split(".")[0]!, cmd, json);
    throw error;
  }
  return canonical;
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
  let lead = 0;
  for (; lead < argv.length; lead++) {
    const word = argv[lead]!;
    if (word === "--json" || word === "-j" || word === "--plain") output.push(word);
    else if (!takeGlobalFlag(word)) break;
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
  // Before any ordinary dispatch outcome can exit, take the spawn handoff and ensure no child
  // inherits its variable. The unit entry refuses such a handoff without consuming its file.
  takeManagedHandoffCustody(process.env);
  setInstalledExtensionsEnabled(Boolean(opts.extensions));
  // The global spellings of help and version are the `help` and `version` commands.
  if (argv[0] === "-v") usageExit("-v is not the version flag - run `cotal version` or `cotal -V`");
  if (argv[0] === "--version" || argv[0] === "-V") argv = ["version", ...argv.slice(1)];
  else if (argv[0] === "--help" || argv[0] === "-h") argv = ["help", ...argv.slice(1)];
  if (opts.extensions) {
    try {
      if (await extSeedGate(registry, argv)) return;
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
  let rest = ownWords(cmd, words);
  const wantsHelp = asksForHelp(rest);
  if (cmd?.name === "service") {
    try { cmd = servicePresetCommand(cmd, rest); }
    catch (error) {
      const failure = isCommandFailure(error) ? error : new CommandFailure("refused", "SCHEMA_INVALID", "service preset metadata could not be read; no provider was imported or installed");
      failureExit(cmd, failure, asksForJson(cmd, rest), rest.includes("--plain"));
    }
  }
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
  if (!cmd && !awaitingSeed) usageExit(`unknown command: ${word} - run \`cotal help\` to list commands`);
  // `cotal <cmd> --help` / `-h` → that command's help, never run it. This intercept also covers
  // rawArgs commands and extension STUBS (cached specs are exactly the display surface) — only
  // `__`-internal ones are exempt, because __complete's argv is ANOTHER command's half-typed
  // line, where `--help` is a word being completed, not a request.
  if (cmd && !cmd.name.startsWith("__") && wantsHelp) return printHelpFor(cmd, rest);
  let parsed = cmd && !isExtensionStub(cmd) ? parseOrExit(cmd, rest) : undefined;
  // ---- Effects: only a validated invocation reaches this line. ----
  // The seed can install or upgrade an extension package, so the surface is read again after it and
  // an extension stub resolves against the manifest the seed left.
  const controlOnlyManager = parsed?.values.execution === "none" && (cmd?.name === "supervise" || cmd?.name === "__daemon-manager");
  if (opts.extensions && !controlOnlyManager && !skipsSeed(cmd?.name ?? word, parsed ? parsed.positionals[0] : rest[0], rest, cmd)) {
    try {
      await reconcileSeededConnectors();
    } catch (e) {
      stderrLine("✗ ", (e as Error).message, c.red);
      process.exit(1);
    }
    commands = surface();
    cmd = findCommand(commands, word);
    if (!cmd) usageExit(`unknown command: ${word} - run \`cotal help\` to list commands`);
    rest = ownWords(cmd, words);
    arm();
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
  // A preferences file that does not validate stops every command except help and shell completion,
  // as a broken config file does, so nothing runs on a default the person did not mean. `--help` on a
  // command has already returned above.
  if (!cmd.name.startsWith("__") && cmd.name !== "help" && cmd.name !== "completion") {
    try {
      cachedPreferences();
    } catch (e) {
      if (!isCommandFailure(e)) throw e;
      failureExit(cmd, e, structured(cmd, parsed.positionals[0]) && parsed.values.json === true, parsed.values.plain === true);
    }
  }
  // A failure raised after the command recorded the space it resolved is reported in that space.
  const scope: OperationScope = {};
  try {
    if (opts.extensions && cmd.requiredExtensions) {
      for (const ref of cmd.requiredExtensions(parsed)) await materializeExtension(ref);
    }
    await prepareCatalogForCommand(cmd, parsed);
    await runOperation(scope, async () => {
      if (cmd.prepare) await cmd.prepare(parsed);
      await cmd.run(parsed);
    });
  } catch (e) {
    recordTelemetryError(e);
    const mode = parsed.positionals[0];
    const json = structured(cmd, mode) && parsed.values.json === true;
    // A usage error a command raises from its own checks prints the command's help, not a stack trace.
    if (isArgError(e)) usageExit((e as Error).message.split(".")[0]!, cmd, json);
    if (isCommandFailure(e)) failureExit(cmd, inOperationSpace(e, scope.space), json, parsed.values.plain === true);
    // A command that declares a structured output reports by the outcome table. A target it could
    // not resolve or connect to is refused before any request, under the refusal's own code; a
    // failure it did not classify is unknown: it may have had effects that cannot be attributed.
    if (structured(cmd, mode)) {
      if (isConnectRefusal(e)) failureExit(cmd, inOperationSpace(e.failure(), scope.space), json, parsed.values.plain === true);
      if (isWorkspaceTargetError(e)) {
        const { message, remedy } = workspaceErrorParts({ kind: "target", error: e });
        failureExit(cmd, new CommandFailure("refused", targetErrorCode(e.code), message, remedy ? { remedy } : {}), json, parsed.values.plain === true);
      }
      if (e instanceof CatalogPreparationError) failureExit(cmd, new CommandFailure("refused", e.code, e.message), json, parsed.values.plain === true);
      failureExit(cmd, inOperationSpace(new CommandFailure("unknown", "OPERATION_UNKNOWN", e instanceof Error ? e.message : String(e), { cause: e }), scope.space), json, parsed.values.plain === true);
    }
    // A workspace TARGET error carries structured recovery — which entry, whether it was removed,
    // what to run next — and has its own renderer. Its raw `.message` is deliberately dev-safe
    // rather than product copy, so falling through to the generic line below strips the removed
    // fact and the action, leaving the operator a diagnosis they cannot act on. Rendering it HERE
    // covers every path that lets one reach the boundary, not just the ones that happen to call an
    // `…OrExit` helper.
    if (isWorkspaceTargetError(e)) {
      console.error(c.red(renderWorkspaceError({ kind: "target", error: e })));
      if (process.env.COTAL_DEBUG && e instanceof Error && e.stack) console.error(c.dim(e.stack));
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
    if (process.env.COTAL_DEBUG && e instanceof Error && e.stack) console.error(c.dim(e.stack));
    process.exit(1);
  }
}
