import { MANAGED_HANDOFF_FILE_ENV, takeManagedHandoffFile } from "@cotal-ai/core";
import { CommandFailure, oneLine } from "@cotal-ai/workspace";

let held: string | undefined;
let refusal: CommandFailure | undefined;

/** The first statement of `runCli` after its leading flags. Every command deletes from `env` each key
 *  that spells `MANAGED_HANDOFF_FILE_ENV` under any letter case, so no child inherits it. Only a
 *  `spawn`, the command a managed launch runs, then runs `takeManagedHandoffFile` on each distinct path
 *  those keys name and holds the text in this module; any other command leaves the file where it is.
 *  A path it cannot take, or spellings that name different files, become one `USAGE_INVALID` refusal
 *  that spawn throws before its other checks, after every path was taken, so no file survives the
 *  ambiguity. With the variable absent it does nothing. */
export function takeManagedHandoffCustody(env: Record<string, string | undefined>, spawn: boolean): void {
  const keys = new Map<string, string>();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== MANAGED_HANDOFF_FILE_ENV) continue;
    const path = env[key];
    if (path && !keys.has(path)) keys.set(path, key);
    delete env[key];
  }
  if (!spawn) return;
  let problem: string | undefined;
  for (const [path, key] of keys) {
    try {
      held = takeManagedHandoffFile(path);
    } catch (e) {
      problem ??= `${(e as Error).message}: ${key} names ${oneLine(path)}`;
    }
  }
  if (keys.size > 1) problem = `${MANAGED_HANDOFF_FILE_ENV} names ${keys.size} different files under different letter cases`;
  if (problem === undefined) return;
  held = undefined;
  refusal = new CommandFailure("refused", "USAGE_INVALID", problem, { remedy: `unset ${[...new Set(keys.values())].join(" ")}` });
}

/** The refusal custody holds for a handoff file it could not take. Spawn throws it first. */
export function managedHandoffRefusal(): CommandFailure | undefined {
  return refusal;
}

/** Whether custody holds a handoff, without handing it over. Spawn's argument check reads this,
 *  because custody already removed the variable it would otherwise see. */
export function holdsManagedHandoff(): boolean {
  return held !== undefined;
}

/** The text custody holds, handed over once. A later call returns undefined. Only the spawn
 *  handler calls it. */
export function claimManagedHandoff(): string | undefined {
  const text = held;
  held = undefined;
  return text;
}
