import { writeSync } from "node:fs";
import { commandDeclarationProblems, findCommand, findSubcommand, parseCommandArgs, type Command, type ParsedArgs, type Registry } from "@cotal-ai/core";
import {
  CommandFailure,
  disableColor,
  disableInput,
  envelopeLine,
  exitCode,
  failureEnvelope,
  globalFlagDeclarationProblems,
  hasMeshTargetFlags,
  isCommandFailure,
  isConnectRefusal,
  isSeededCommand,
  isWorkspaceTargetError,
  outputDeclarationProblems,
  renderWorkspaceError,
  targetErrorCode,
} from "@cotal-ai/workspace";
import { c, staleStoreHint } from "./ui.js";
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
import { printCommandHelp, printEntry } from "./help.js";
import { CatalogPreparationError, prepareCatalogCommand } from "./commands/sync.js";
import { takeManagedHandoffCustody } from "./managed-handoff.js";

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

/** The words `cmd` parses: the global flags are the kernel's, except for a command that takes its
 *  words raw or an internal one, whose words are another command line. */
function ownWords(cmd: Command | undefined, words: readonly string[]): string[] {
  return cmd && (cmd.rawArgs || cmd.name.startsWith("__")) ? [...words] : stripGlobalFlags(words);
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

/** A classified failure: its line and remedy on stderr, its envelope on stdout when one was asked
 *  for, and the exit code its outcome sets. The envelope is written synchronously, because stdout
 *  to a pipe is asynchronous on some platforms and `exit` would cut it short. */
function failureExit(cmd: Command, failure: CommandFailure, json: boolean): never {
  console.error(c.red(`✗ ${failure.message}`));
  if (failure.remedy) console.error(c.dim(`  ↳ ${failure.remedy}`));
  if (json) writeSync(1, envelopeLine(failureEnvelope(cmd.name, failure)));
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
 * Whether a validated invocation skips the connector seed. Every real command reconciles first (so
 * `npm i -g cotal-ai && cotal ext list` shows the four, and a first-command `ext add` still seeds),
 * EXCEPT help, version, completion and the cases below. `name` is the canonical command and `sub` its
 * first positional; an AUTHENTIC seed CHILD is an `ext add` whose `COTAL_EXT_SEEDING` nonce + parent
 * PID match the live reconcile lock (a forged marker no longer skips, so it can't bypass the
 * recursive-reconcile guard or the lock).
 */
function skipsSeed(name: string, sub: string | undefined, argv: readonly string[]): boolean {
  if (name === "help" || name === "version" || name === "__complete" || name === "completion") return true;
  // A dry run promises to plan and print while mutating NOTHING, and the boot-gate reconcile is a
  // mutation of the operator-global seed store, manifest and npm prefix — it ran BEFORE the command
  // body could reject the invocation, so `down --preserve-state --dry-run` (an unsupported
  // combination) migrated the whole store to the invoking binary's generation and only then printed
  // the usage refusal, leaving an older live deployment on a store it no longer matches (#1620). The
  // planning surface reads what is installed; it never seeds to make the plan prettier.
  if (argv.includes("--dry-run")) return true;
  if (name === "update") return true; // update owns one explicit reconcile; never auto-refresh then force-refresh
  // The seed is skipped for an INTERNAL CHILD re-exec — the `up`/`spawn` that spawns the delivery
  // daemon / manager / auth service sets COTAL_SKIP_CONNECTOR_SEED=1 in their env AFTER it reconciled,
  // so the child doesn't redo the seed on boot. A USER running the same public command directly (e.g.
  // `cotal supervise --roster`, the agent supervisor + container entrypoint) still seeds on first run.
  if (process.env.COTAL_SKIP_CONNECTOR_SEED === "1") return true;
  if (name === "ext" && sub === "root") return true; // a side-effect-free path print: no seed noise, so `$(cotal ext root)` stays exactly one line even on first run
  if (name === "ext" && sub === "seed") return true; // the explicit maintenance command self-reconciles
  if (name === "ext" && sub === "add" && isAuthenticSeedChild()) return true; // a seed child must not recurse
  // `agent-bearer` is machine-facing: a spawned seat execs it on EVERY bearer refresh to read one 0600
  // token file, exchange it, print the bearer and exit. It must not depend on or mutate the
  // operator-global store — a newer store generation refused the boot before the token was ever read
  // (disconnecting a live seat at its token's expiry, #1857), and a matching generation seeded every
  // connector as a side effect of a credential exchange. The seat's env carries no
  // COTAL_SKIP_CONNECTOR_SEED (only an operator-set one is forwarded), so the skip is by name.
  if (name === "agent-bearer") return true;
  return false;
}

/** node's parseArgs throws these for unknown/malformed flags; treat as a usage error. */
function isArgError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

/** One dispatcher-owned catalog gate for every command that uses the shared mesh target grammar,
 * including commands self-registered by other packages. Registry-local `meshes add/rm` stay
 * offline. `use` takes its target positionally, and status keeps stale bytes diagnostic-only. */
async function prepareCatalogForCommand(cmd: Command, args: ReturnType<typeof parseCommandArgs>): Promise<void> {
  if (cmd.name === "meshes") {
    const sub = args.positionals[0];
    if (sub === undefined || sub === "list") await prepareCatalogCommand(args, false, "meshes");
    return;
  }
  if (cmd.name === "use") return prepareCatalogCommand(args, false, "use");
  if (cmd.name === "status") return prepareCatalogCommand(args, true);
  if (cmd.name === "personas" && args.values.running !== true) return;
  if (cmd.prepareMeshTarget !== false && hasMeshTargetFlags(cmd.flags)) await prepareCatalogCommand(args);
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
  // The help goes to stderr with the reason, so a refused run leaves stdout empty and a script that
  // sources or parses it gets nothing.
  console.error(c.red(`✗ ${message}`));
  if (cmd) printCommandHelp(cmd, undefined, (line) => console.error(line));
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
  if (cmd.subcommands?.length && first !== undefined && !findSubcommand(cmd, first))
    usageExit(`cotal ${cmd.name} has no subcommand "${first}" - run \`cotal help ${cmd.name}\``, cmd, json);
  // `--json` implies `--no-input`: a script reading one document cannot answer a prompt.
  if (structured(cmd, first) && parsed.values.json === true) disableInput();
  return canonicalSubcommand(cmd, parsed);
}

/** The parsed args with a subcommand alias in the first positional replaced by its name, so `run`
 *  only ever sees canonical subcommands. */
function canonicalSubcommand(cmd: Command, parsed: ParsedArgs): ParsedArgs {
  const sub = findSubcommand(cmd, parsed.positionals[0]);
  if (!sub || sub.name === parsed.positionals[0]) return parsed;
  return { ...parsed, positionals: [sub.name, ...parsed.positionals.slice(1)] };
}

/** `-h`/`--help` anywhere after a command: that command's help, or its subcommand's when the first
 *  positional names one. Read from the declared specs, so a stub's help never imports its package. */
function printHelpFor(cmd: Command, rest: readonly string[]): void {
  const sub = findSubcommand(cmd, rest.find((t) => !t.startsWith("-")));
  printCommandHelp(cmd, sub?.hidden ? undefined : sub);
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
  // Before anything that can exit, so every outcome leaves no handoff file and no child inherits
  // the variable naming it.
  takeManagedHandoffCustody(process.env);
  setInstalledExtensionsEnabled(Boolean(opts.extensions));
  // Global flags before the command word apply whatever the command is.
  let lead = 0;
  while (lead < argv.length && takeGlobalFlag(argv[lead]!)) lead++;
  argv = argv.slice(lead);
  // The global spellings of help and version are the `help` and `version` commands.
  if (argv[0] === "-v") usageExit("-v is not the version flag - run `cotal version` or `cotal -V`");
  if (argv[0] === "--version" || argv[0] === "-V") argv = ["version", ...argv.slice(1)];
  else if (argv[0] === "--help" || argv[0] === "-h") argv = ["help", ...argv.slice(1)];
  if (opts.extensions) {
    try {
      if (await extSeedGate(registry, argv)) return;
    } catch (e) {
      console.error(c.red(`✗ ${(e as Error).message}`));
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
      console.error(c.red(`✗ ${(e as Error).message}`));
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
  if (opts.extensions && !skipsSeed(cmd?.name ?? word, parsed ? parsed.positionals[0] : rest[0], rest)) {
    try {
      await reconcileSeededConnectors();
    } catch (e) {
      console.error(c.red(`✗ ${(e as Error).message}`));
      process.exit(1);
    }
    commands = surface();
    cmd = findCommand(commands, word);
    if (!cmd) usageExit(`unknown command: ${word} - run \`cotal help\` to list commands`);
    rest = ownWords(cmd, words);
  }
  // An extension stub materializes before parsing: verify the version pin, import the package
  // (self-registers), and parse with the LIVE specs — the cache never drives run's input.
  if (cmd && isExtensionStub(cmd)) {
    try {
      cmd = await materializeExtensionCommand(cmd);
    } catch (e) {
      console.error(c.red(`✗ ${(e as Error).message}`));
      process.exit(1);
    }
    parsed = parseOrExit(cmd, rest);
  }
  if (!cmd || !parsed) throw new Error("internal error: dispatch reached its effects without a parsed command");
  try {
    if (opts.extensions && cmd.requiredExtensions) {
      for (const ref of cmd.requiredExtensions(parsed)) await materializeExtension(ref);
    }
    await prepareCatalogForCommand(cmd, parsed);
    if (cmd.prepare) await cmd.prepare(parsed);
    await cmd.run(parsed);
  } catch (e) {
    const mode = parsed.positionals[0];
    const json = structured(cmd, mode) && parsed.values.json === true;
    // A usage error a command raises from its own checks prints the command's help, not a stack trace.
    if (isArgError(e)) usageExit((e as Error).message.split(".")[0]!, cmd, json);
    if (isCommandFailure(e)) failureExit(cmd, e, json);
    // A command that declares a structured output reports by the outcome table. A target it could
    // not resolve or connect to is refused before any request, under the refusal's own code; a
    // failure it did not classify is unknown: it may have had effects that cannot be attributed.
    if (structured(cmd, mode)) {
      if (isConnectRefusal(e)) failureExit(cmd, e.failure(), json);
      if (isWorkspaceTargetError(e))
        failureExit(cmd, new CommandFailure("refused", targetErrorCode(e.code), renderWorkspaceError({ kind: "target", error: e }).replace(/^✗ /, "")), json);
      if (e instanceof CatalogPreparationError) failureExit(cmd, new CommandFailure("refused", e.code, e.message), json);
      failureExit(cmd, new CommandFailure("unknown", "OPERATION_UNKNOWN", e instanceof Error ? e.message : String(e)), json);
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
    console.error(c.red(`✗ ${msg}`));
    // Known failure signatures get a one-line operator hint (e.g. a stale-store durable
    // collision names the `cotal clean` reset) - the error itself stays verbatim.
    const hint = staleStoreHint(msg);
    if (hint) console.error(c.dim(`  ↳ ${hint}`));
    if (process.env.COTAL_DEBUG && e instanceof Error && e.stack) console.error(c.dim(e.stack));
    process.exit(1);
  }
}
