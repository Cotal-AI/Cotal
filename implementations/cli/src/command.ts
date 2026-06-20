import type { Command, Registry } from "@cotal-ai/core";
import { c } from "./ui.js";

function help(commands: Command[]): void {
  // `__`-prefixed commands are internal (e.g. `__complete`, the completion dispatcher) — hide them.
  const visible = commands.filter((cmd) => !cmd.name.startsWith("__"));
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

/** One-line help for a single command: its usage (or summary as fallback). */
function commandHelp(cmd: Command): void {
  console.log(`${c.bold(`cotal ${cmd.name}`)} — ${cmd.summary}`);
  if (cmd.usage) console.log(c.dim(cmd.usage));
}

/** node's parseArgs throws these for unknown/malformed flags; treat as a usage error. */
function isArgError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

/** Dispatch `argv` against the commands self-registered in a {@link Registry}.
 *  The single entry point a composition root calls — no hardcoded command list. */
export async function runCli(registry: Registry, argv: string[]): Promise<void> {
  const commands = registry.all<Command>("command");
  const [name, ...rest] = argv;
  if (name === undefined || name === "help" || name === "-h" || name === "--help") {
    help(commands);
    return;
  }
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) {
    console.error(c.red(`unknown command: ${name}`));
    help(commands);
    process.exit(1);
  }
  // `cotal <cmd> --help` / `-h` → that command's help, never run it.
  if (rest.includes("--help") || rest.includes("-h")) {
    commandHelp(cmd);
    return;
  }
  try {
    await cmd.run(rest);
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
