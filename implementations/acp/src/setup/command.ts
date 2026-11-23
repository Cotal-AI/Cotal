/**
 * The command an ACP client runs to reach one space, as setup writes it. A GUI application sees
 * neither the shell's PATH nor its environment, so the command names this Cotal's Node and entry by
 * absolute path, and the Cotal locations the shell set travel in the entry's own environment.
 */
import { existsSync } from "node:fs";

/** What a client runs for `space`: the Node and entry of the running Cotal, then `acp --space`. */
export function acpCommand(cotal: readonly string[], space: string): { command: string; args: string[] } {
  const [node, ...entry] = cotal;
  if (!node || entry.length === 0) throw new Error("the Cotal CLI record has no Node executable and entry");
  return { command: node, args: [...entry, "acp", "--space", space] };
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

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
 *  this process runs on. An entry whose executable is a launcher, as one a person added by hand may be,
 *  is checked only for being there. */
export function staleCommand(command: unknown, args: unknown, here = process.execPath): string | undefined {
  if (typeof command !== "string" || !command) return "it names no executable";
  if (!existsSync(command)) return `${command} is gone`;
  if (!strings(args)) return "its arguments are not a list";
  const entry = args.slice(0, args.indexOf("acp")).at(-1);
  if (entry !== undefined && !existsSync(entry)) return `${entry} is gone`;
  if (entry !== undefined && command !== here) return `it runs ${command}, not this Cotal's ${here}`;
  return undefined;
}
