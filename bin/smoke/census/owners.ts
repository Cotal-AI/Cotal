/**
 * The capability census owner map and its offline checks.
 *
 * An owner is one of:
 *   current:<command> [mode] [--flag ...]    a registered command that performs the item today
 *   pending:<command> [words] [--flag ...]   the command the CLI redesign adds for it
 *   internal:<reason>                        machinery that is not a user capability
 *
 * Flags are named by their long form. A current owner's mode must be one its command's usage
 * declares. An item that more than one entry point issues lists each owner.
 *
 * `internal` is accepted only for environment variables, historical CLI entries and auth HTTP
 * routes. An endpoint command or field, an agent tool argument, or a persona, manifest, config,
 * roster or presence field is always a user capability, so it needs a command.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CensusItem } from "./sources.js";

export const OWNER_MAP_PATH = join(import.meta.dirname, "owner-map.json");

export interface OwnerMap {
  owners: Record<string, string | string[]>;
  checklist: Record<string, string>;
}

export function readOwnerMap(path = OWNER_MAP_PATH): OwnerMap {
  return JSON.parse(readFileSync(path, "utf8")) as OwnerMap;
}

/** An item's owners: one, several, or none when it has no row. */
export function ownersOf(map: OwnerMap, item: string): string[] {
  const owner = map.owners[item];
  return owner === undefined ? [] : typeof owner === "string" ? [owner] : owner;
}

const COMMAND_OWNER = /^(current|pending):([a-z_][a-z0-9_-]*)((?: [a-z][a-z0-9-]*)*)((?: --[a-z][a-z0-9-]*)*)$/;
const INTERNAL_OWNER = /^internal:[a-z].{3,}$/;
const INTERNAL_KINDS = new Set(["env", "cli", "auth-http"]);

/** A parsed `current:` or `pending:` owner. */
export interface CommandOwner {
  state: "current" | "pending";
  command: string;
  words: string[];
  flags: string[];
}

export function parseOwner(owner: string): CommandOwner | "internal" | undefined {
  if (INTERNAL_OWNER.test(owner)) return "internal";
  const m = COMMAND_OWNER.exec(owner);
  if (!m) return undefined;
  return {
    state: m[1] as "current" | "pending",
    command: m[2]!,
    words: m[3]!.trim().split(" ").filter(Boolean),
    flags: m[4]!.trim().split(" ").filter(Boolean),
  };
}

/** Registered commands and their long flags, read from the `cli:` census items. */
function registeredFlags(items: readonly CensusItem[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { id } of items) {
    if (!id.startsWith("cli:") || id.includes(" ")) continue;
    const [command, flag] = id.slice(4).split("--", 2) as [string, string | undefined];
    const flags = out.get(command) ?? out.set(command, new Set()).get(command)!;
    if (flag !== undefined) flags.add(flag);
  }
  return out;
}

/** Why one owner is wrong for the item it owns, or undefined when it is well formed. */
function ownerProblem(item: string, owner: string, registered: Map<string, Set<string>>, live: Set<string>): string | undefined {
  const parsed = parseOwner(owner);
  if (parsed === undefined) return `${item}: owner "${owner}" does not match current:, pending: or internal: grammar`;
  if (parsed === "internal") {
    const kind = item.split(":", 1)[0]!;
    return INTERNAL_KINDS.has(kind) ? undefined : `${item}: a ${kind} item is a user capability and cannot be internal`;
  }
  if (parsed.state === "pending") return undefined;
  const flags = registered.get(parsed.command);
  if (!flags) return `${item}: owner names "${parsed.command}", which is not a registered command`;
  const mode = parsed.words.join(" ");
  if (mode && !live.has(`cli:${parsed.command} ${mode}`)) return `${item}: "${parsed.command}" declares no "${mode}" mode`;
  for (const flag of parsed.flags) if (!flags.has(flag.slice(2))) return `${item}: "${parsed.command}" declares no ${flag} flag`;
  return undefined;
}

/** Every problem with the owner map against the live census items. Empty means it passes. */
export function ownerMapProblems(items: readonly CensusItem[], map: OwnerMap): string[] {
  const problems: string[] = [];
  const live = new Set(items.map((i) => i.id));
  const registered = registeredFlags(items);
  for (const { id } of items) {
    const owner = map.owners[id];
    if (owner === undefined) problems.push(`${id}: no owner row`);
    else if (Array.isArray(owner) && (owner.length < 2 || new Set(owner).size !== owner.length))
      problems.push(`${id}: an owner list names two or more different owners; write one owner as a string`);
    else
      for (const one of ownersOf(map, id)) {
        const p = ownerProblem(id, one, registered, live);
        if (p) problems.push(p);
      }
  }
  for (const id of Object.keys(map.owners)) if (!live.has(id)) problems.push(`${id}: owner row names no census item`);
  for (const [entry, owner] of Object.entries(map.checklist)) {
    const p = ownerProblem(`checklist ${entry}`, owner, registered, live);
    if (p) problems.push(p);
  }
  return problems;
}
