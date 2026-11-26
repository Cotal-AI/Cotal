/**
 * The command an ACP client runs to reach one space, as setup writes it. A GUI application sees
 * neither the shell's PATH nor its environment, so the command names this Cotal's Node and entry by
 * absolute path, and the Cotal locations the shell set travel in the entry's own environment.
 *
 * The paths are the ones that survive an upgrade. The running Node's own path can name one version's
 * folder, as Homebrew's `Cellar/node/<version>` does, and that folder is removed when Node upgrades.
 * The running entry names one install generation, and a later update moves to another.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { executionIdentity } from "@cotal-ai/workspace";

/** The Node a client runs: the get.cotal.ai launcher's Node link when this Cotal runs under that
 *  launcher and the link resolves to `node`, else `node`. The launcher exports `COTAL_LAUNCHER=1`
 *  and its install root as `npm_config_prefix`, and keeps `<root>/nodebin/node` pointing at the Node
 *  it chose; it refuses to start when that link is gone. */
export function durableNode(node: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = env.COTAL_LAUNCHER === "1" ? env.npm_config_prefix : undefined;
  if (!root) return node;
  const link = join(root, "nodebin", "node");
  return existsSync(link) && realpathSync(link) === realpathSync(node) ? link : node;
}

/** The entry a client runs: the install's own entry when `entry` is the generation this process
 *  loaded, so the client follows the next update, else `entry`. */
export function durableEntry(entry: string): string {
  const identity = executionIdentity();
  return identity !== undefined && existsSync(entry) && realpathSync(entry) === identity.loadedEntry ? identity.logicalEntry : entry;
}

/** What a client runs for `space`: the running Cotal's Node and entry by the paths that survive an
 *  upgrade, then `acp --space`. */
export function acpCommand(cotal: readonly string[], space: string): { command: string; args: string[] } {
  const [node, ...rest] = cotal;
  const entry = rest.at(-1);
  if (!node || entry === undefined) throw new Error("the Cotal CLI record has no Node executable and entry");
  return { command: durableNode(node), args: [...rest.slice(0, -1), durableEntry(entry), "acp", "--space", space] };
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** Recognize direct Cotal launchers and Node invocations of the Cotal entry, even after they move. */
export function runsCotal(command: unknown, args: unknown): boolean {
  if (typeof command !== "string" || !Array.isArray(args)) return false;
  const at = args.indexOf("acp");
  const launcher = basename(command);
  if (at === 0) return /^(?:cotal(?:\.(?:cmd|exe|bat|js|ts))?|cotal-npm)$/i.test(launcher);
  const entry = args[at - 1];
  return at > 0 && /^(?:node|nodejs|cotal-node)(?:\.exe)?$/i.test(launcher) && typeof entry === "string" &&
    /^cotal(?:\.(?:js|ts))?$/i.test(basename(entry));
}

/** The space an entry's arguments run `cotal acp` for, or undefined when they run something else.
 *  This is how setup recognises an entry it wrote or one a person added by hand, such as
 *  `cotal acp --space <space>` with `cotal` as the executable. */
export function acpSpace(args: unknown): string | undefined {
  if (!strings(args)) return undefined;
  const at = args.indexOf("acp");
  if (at < 0) return undefined;
  const rest = args.slice(at + 1);
  const flag = rest.indexOf("--space");
  if (flag >= 0) return rest[flag + 1] || undefined;
  return rest.find((arg) => arg.startsWith("--space="))?.slice("--space=".length) || undefined;
}

/** An entry's arguments rewritten to run this Cotal: everything up to `acp` is replaced, and the flags
 *  after it, the space among them, are kept. */
export function refreshedArgs(args: readonly string[], cotal: readonly string[]): string[] {
  const at = args.indexOf("acp");
  if (at < 0) throw new Error(`the arguments ${JSON.stringify(args)} do not run \`cotal acp\``);
  return [...acpCommand(cotal, "").args.slice(0, -2), ...args.slice(at + 1)];
}

/** The Cotal locations this shell set that a client must pass on, by variable. */
export function passedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["COTAL_HOME", "XDG_CONFIG_HOME"]) {
    const value = env[name]?.trim();
    if (value) out[name] = value;
  }
  return out;
}

/** Why an entry's command does not run this Cotal, or undefined when it does. `here` is the Node
 *  this process runs on; a link to it, such as the launcher's Node link, runs it too. An entry whose
 *  executable is a launcher, as one a person added by hand may be, is checked only for being there. */
export function staleCommand(command: unknown, args: unknown, here = process.execPath): string | undefined {
  if (typeof command !== "string" || !command) return "it names no executable";
  if (!existsSync(command)) return `${command} is gone`;
  if (!strings(args)) return "its arguments are not a list";
  const entry = args.slice(0, args.indexOf("acp")).at(-1);
  if (entry !== undefined && !existsSync(entry)) return `${entry} is gone`;
  if (entry !== undefined && realpathSync(command) !== realpathSync(here)) return `it runs ${command}, not this Cotal's ${here}`;
  return undefined;
}
