import { commandDeclarationProblems, findCommand, findSubcommand, parseCommandArgs, type Command, type ParsedArgs, type Registry } from "@cotal-ai/core";
import { hasMeshTargetFlags, isSeededCommand, isWorkspaceTargetError, renderWorkspaceError } from "@cotal-ai/workspace";
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
import { prepareCatalogCommand } from "./commands/sync.js";
import { takeManagedHandoffCustody } from "./managed-handoff.js";

/** Whether `args` ask for help: `--help` or `-h` before any `--`, after which every word is text. */
function asksForHelp(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  return options.includes("--help") || options.includes("-h");
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
  await extCmd.run(parseCommandArgs(extCmd, argv.slice(1)));
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
function usageExit(message: string, cmd?: Command): never {
  console.error(c.red(`✗ ${message}`));
  if (cmd) printCommandHelp(cmd);
  process.exit(1);
}

/** `rest` parsed against `cmd`'s declared flags, positionals and subcommands, or a usage exit. Node's
 *  parse error is trimmed to its first sentence: the verbose "To specify a positional argument
 *  starting with a '-' …" tail is dropped. */
function parseOrExit(cmd: Command, rest: string[]): ParsedArgs {
  let parsed: ParsedArgs;
  try {
    parsed = parseCommandArgs(cmd, rest);
  } catch (e) {
    if (isArgError(e)) usageExit((e as Error).message.split(".")[0]!, cmd);
    throw e;
  }
  const first = parsed.positionals[0];
  if (cmd.subcommands?.length && first !== undefined && !findSubcommand(cmd, first))
    usageExit(`cotal ${cmd.name} has no subcommand "${first}" - run \`cotal help ${cmd.name}\``, cmd);
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
      const problems = commandDeclarationProblems(cmd);
      if (problems.length) usageExit(`internal error: ${problems.join("; ")}`);
    }
    setCommandSurface(commands); // the completion dispatcher reads the SAME surface help renders
    return commands;
  };
  let commands = surface();
  const [word, ...rest] = argv;
  if (word === undefined) return printEntry(commands);
  const wantsHelp = asksForHelp(rest);
  let cmd = findCommand(commands, word);
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
    // A usage error a command raises from its own checks prints the command's help, not a stack trace.
    if (isArgError(e)) usageExit((e as Error).message.split(".")[0]!, cmd);
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
