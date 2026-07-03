import { commandUsage, parseCommandArgs, type Command, type Registry } from "@cotal-ai/core";
import { c } from "./ui.js";
import { isExtensionStub, materializeExtensionCommand, overlayExtensions, setCommandSurface } from "./ext-loader.js";

function help(commands: Command[]): void {
  // `__`-prefixed commands are internal (e.g. `__complete`, the completion dispatcher); `hidden`
  // ones are runnable dev/test aids (e.g. `demo`) kept off the surface — hide both.
  const visible = commands.filter((cmd) => !cmd.name.startsWith("__") && !cmd.hidden);
  const groups = new Map<string, Command[]>();
  for (const cmd of visible) {
    const g = cmd.group ?? "Commands";
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(cmd);
  }
  const pad = Math.max(...visible.map((c) => c.name.length));
  let out = `${c.bold("cotal")} — lateral agent coordination over NATS\n`;
  for (const [group, cmds] of groups) {
    out += `\n${c.bold(group)}\n`;
    for (const cmd of cmds) out += `  ${cmd.name.padEnd(pad)}  ${c.dim(cmd.summary)}\n`;
  }
  console.log(out);
}

/** Full help for one command, generated from its declared specs: summary, usage line, and a
 *  flag table (short, long, metavar, description). */
function commandHelp(cmd: Command): void {
  console.log(`${c.bold(`cotal ${cmd.name}`)} — ${cmd.summary}`);
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
    await cmd.run(parseCommandArgs(cmd, rest));
  } catch (e) {
    // A bad flag/arg prints the command's help, not a stack trace. Trim node's verbose
    // "To specify a positional argument starting with a '-' …" tail to the first sentence.
    if (isArgError(e)) {
      const msg = (e as Error).message.split(".")[0];
      console.error(c.red(`✗ ${msg}`));
      commandHelp(cmd);
      process.exit(1);
    }
    throw e;
  }
}
