import { MANAGED_HANDOFF_FILE_ENV, takeManagedHandoffFile } from "@cotal-ai/core";
import { c } from "./ui.js";

let held: string | undefined;

/** The first statement of `runCli`. When `MANAGED_HANDOFF_FILE_ENV` is set under any letter case,
 *  delete every such key from `env`, then run `takeManagedHandoffFile` on each distinct path it
 *  names and hold the text in this module. Spellings that name different files are refused, after
 *  every one of them was taken, so no file survives the ambiguity. A refusal prints one line naming
 *  the check and exits 1. With the variable absent it does nothing. */
export function takeManagedHandoffCustody(env: Record<string, string | undefined>): void {
  const paths = new Set<string>();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== MANAGED_HANDOFF_FILE_ENV) continue;
    const path = env[key];
    if (path) paths.add(path);
    delete env[key];
  }
  let refusal: string | undefined;
  for (const path of paths) {
    try {
      held = takeManagedHandoffFile(path);
    } catch (e) {
      refusal ??= (e as Error).message;
    }
  }
  if (paths.size > 1) refusal = `${MANAGED_HANDOFF_FILE_ENV} names ${paths.size} different files under different letter cases`;
  if (refusal === undefined) return;
  console.error(c.red(`✗ ${refusal}`));
  process.exit(1);
}

/** The text custody holds, handed over once. A later call returns undefined. Only the spawn
 *  handler calls it. */
export function claimManagedHandoff(): string | undefined {
  const text = held;
  held = undefined;
  return text;
}
