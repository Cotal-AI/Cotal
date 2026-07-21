import { commandUsage, parseCommandArgs, type Command, type Registry } from "@cotal-ai/core";
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
import { cliVersion, extensionVersions } from "./lib/version.js";

/** Display order for the help groups — an explicit ranking, NOT registration order: modules
 *  self-register on import and the dev runner (tsx) doesn't guarantee entry-import evaluation
 *  order, so the daemon surface could otherwise print above Setup. Groups not listed here
 *  (e.g. an extension's custom group) follow, in first-registered order. */
const GROUP_ORDER = ["Setup", "Mesh", "Messaging", "Agents", "Observe", "Extensions", "Manager"];

function help(commands: Command[]): void {
  // `__`-prefixed commands are internal (e.g. `__complete`, the completion dispatcher); `hidden`
  // ones are runnable dev/test aids (e.g. `demo`) kept off the surface — hide both.
  const visible = commands.filter((cmd) => !cmd.name.startsWith("__") && !cmd.hidden);
  const groups = new Map<string, Command[]>();
  for (const cmd of visible) {
    const g = cmd.group ?? "Commands";
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(cmd);
  }
  const rank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  const ordered = [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b));
  const pad = Math.max(...visible.map((c) => c.name.length));
  let out = `${c.bold("cotal")} - lateral agent coordination over NATS\n`;
  for (const [group, cmds] of ordered) {
    out += `\n${c.bold(group)}\n`;
    for (const cmd of cmds) out += `  ${cmd.name.padEnd(pad)}  ${c.dim(cmd.summary)}\n`;
  }
  console.log(out);
}

/** Full help for one command, generated from its declared specs: summary, usage line, and a
 *  flag table (short, long, metavar, description). */
function commandHelp(cmd: Command): void {
  console.log(`${c.bold(`cotal ${cmd.name}`)} - ${cmd.summary}`);
  console.log(c.dim(`usage: ${commandUsage(cmd)}`));
  const flags = cmd.flags ?? [];
  if (!flags.length) return;
  const left = flags.map((f) => {
    const metavar = f.type === "string" ? ` ${f.value ?? "<value>"}` : "";
    return `${f.short ? `-${f.short}, ` : "    "}--${f.name}${metavar}`;
  });
  const pad = Math.max(...left.map((s) => s.length));
  console.log(c.bold("flags:"));
  flags.forEach((f, i) => console.log(`  ${left[i].padEnd(pad)}  ${c.dim(f.description ?? "")}`));
}

/**
 * The connector-seeding boot gate. Returns `true` iff it fully handled the command (maintenance
 * `ext seed`), so the caller returns without the normal dispatch.
 *
 *  - `ext seed [--repair|--reset|--force]` is dispatched HERE, before the manifest overlay, so repair
 *    survives a corrupt manifest.
 *  - every other real command reconciles first (so `npm i -g cotal-ai && cotal ext list` shows the
 *    four, and a first-command `ext add` still seeds), EXCEPT completion/help and an AUTHENTIC seed
 *    CHILD — an `ext add` whose `COTAL_EXT_SEEDING` nonce + parent PID match the live reconcile lock
 *    (a forged marker no longer skips, so it can't bypass the recursive-reconcile guard or the lock).
 */
async function seedBoot(registry: Registry, argv: string[]): Promise<boolean> {
  const [name, sub] = argv;
  if (name === "ext" && sub === "seed") {
    const extCmd = registry.all<Command>("command").find((cmd) => cmd.name === "ext");
    if (!extCmd) throw new Error("internal error: the `ext` command is not registered");
    // `ext seed` is dispatched HERE, before the global/per-command help intercepts, so `--repair` can
    // fix a corrupt manifest. A help request must still short-circuit to usage and mutate NOTHING
    // (the maintenance run below writes the seed stamp/manifest).
    if (argv.includes("--help") || argv.includes("-h")) {
      commandHelp(extCmd);
      return true;
    }
    await extCmd.run(parseCommandArgs(extCmd, argv.slice(1)));
    return true;
  }
  if (skipAutoReconcile(argv)) return false;
  await reconcileSeededConnectors();
  return false;
}

function skipAutoReconcile(argv: string[]): boolean {
  const [name, sub] = argv;
  if (name === undefined || name === "help" || name === "-h" || name === "--help" || name === "__complete") return true;
  if (argv.includes("--help") || argv.includes("-h")) return true; // command-specific help must not mutate state
  if (name === "update") return true; // update owns one explicit reconcile; never auto-refresh then force-refresh
  // The seed is skipped for an INTERNAL CHILD re-exec — the `up`/`spawn` that spawns the delivery
  // daemon / manager / auth service sets COTAL_SKIP_CONNECTOR_SEED=1 in their env AFTER it reconciled,
  // so the child doesn't redo the seed on boot. A USER running the same public command directly (e.g.
  // `cotal supervise --roster`, the agent supervisor + container entrypoint) still seeds on first run.
  if (process.env.COTAL_SKIP_CONNECTOR_SEED === "1") return true;
  if (name === "ext" && sub === "seed") return true; // the explicit maintenance command self-reconciles
  if (name === "ext" && sub === "add" && isAuthenticSeedChild()) return true; // a seed child must not recurse
  return false;
}

/** node's parseArgs throws these for unknown/malformed flags; treat as a usage error. */
function isArgError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

/** Options a composition root passes to {@link runCli}. */
export interface RunCliOptions {
  /** Load operator-installed extensions (`cotal ext add …`) into the surface: help/completion see
   *  manifest-cached stubs (no import), dispatch imports the owning package lazily with LIVE
   *  specs. OFF by default — library composition roots keep the explicit-import model; only the
   *  published binary opts in. */
  extensions?: boolean;
}

/** Dispatch `argv` against the commands self-registered in a {@link Registry}.
 *  The single entry point a composition root calls — no hardcoded command list.
 *  Parsing happens HERE, from the command's declared specs; `run` gets parsed args. */
export async function runCli(registry: Registry, argv: string[], opts: RunCliOptions = {}): Promise<void> {
  // `-v` / `--version` short-circuits before any extension seeding or dispatch: a side-effect-free
  // print of this binary's version plus each installed extension's, read straight off disk. First,
  // so it never triggers the connector reconcile. Plain text (no ANSI) — a `--version` line is
  // routinely machine-read.
  if (argv[0] === "-v" || argv[0] === "--version") {
    const exts = extensionVersions();
    const lines = [`cotal-ai ${cliVersion()}`];
    if (exts.length) {
      const pad = Math.max(...exts.map((e) => e.label.length));
      for (const e of exts) lines.push(`  ${e.label.padEnd(pad)}  ${e.version}`);
    }
    console.log(lines.join("\n"));
    return;
  }
  setInstalledExtensionsEnabled(Boolean(opts.extensions));
  // On the published binary, keep the four built-in connectors seeded (first run + version bump)
  // through the SAME `ext add` path a third party uses. This runs BEFORE the manifest overlay so
  // `ext seed --repair` can fix a corrupt manifest (the overlay is fatal on corrupt JSON).
  if (opts.extensions) {
    try {
      if (await seedBoot(registry, argv)) return;
    } catch (e) {
      console.error(c.red(`✗ ${(e as Error).message}`));
      process.exit(1);
    }
  }
  let commands: Command[];
  try {
    commands = opts.extensions ? overlayExtensions(registry) : registry.all<Command>("command");
  } catch (e) {
    // A corrupt extensions manifest must not silently shrink the surface — fatal and loud, but
    // rendered as the CLI's one red line, not an unhandled-rejection stack dump.
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  setCommandSurface(commands); // the completion dispatcher reads the SAME surface help renders
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "-h" || name === "--help") {
    help(commands);
    return;
  }
  let cmd = commands.find((c) => c.name === name);
  if (!cmd) {
    console.error(c.red(`unknown command: ${name}`));
    help(commands);
    process.exit(1);
  }
  // `cotal <cmd> --help` / `-h` → that command's help, never run it. This intercept also covers
  // rawArgs commands and extension STUBS (cached specs are exactly the display surface) — only
  // `__`-internal ones are exempt, because __complete's argv is ANOTHER command's half-typed
  // line, where `--help` is a word being completed, not a request.
  if (!cmd.name.startsWith("__") && (rest.includes("--help") || rest.includes("-h"))) {
    commandHelp(cmd);
    return;
  }
  // An extension stub materializes before parsing: verify the version pin, import the package
  // (self-registers), and parse with the LIVE specs — the cache never drives run's input.
  if (isExtensionStub(cmd)) {
    try {
      cmd = await materializeExtensionCommand(cmd);
    } catch (e) {
      console.error(c.red(`✗ ${(e as Error).message}`));
      process.exit(1);
    }
  }
  try {
    const parsed = parseCommandArgs(cmd, rest);
    if (opts.extensions && cmd.requiredExtensions) {
      for (const ref of cmd.requiredExtensions(parsed)) await materializeExtension(ref);
    }
    await cmd.run(parsed);
  } catch (e) {
    // A bad flag/arg prints the command's help, not a stack trace. Trim node's verbose
    // "To specify a positional argument starting with a '-' …" tail to the first sentence.
    if (isArgError(e)) {
      const msg = (e as Error).message.split(".")[0];
      console.error(c.red(`✗ ${msg}`));
      commandHelp(cmd);
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
