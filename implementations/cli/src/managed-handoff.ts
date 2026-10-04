import { MANAGED_HANDOFF_FILE_ENV, takeManagedHandoffFile } from "@cotal-ai/core";
import { c } from "./ui.js";

let held: string | undefined;

/** The first statement of `runCli`. When `MANAGED_HANDOFF_FILE_ENV` is set under any letter case,
 *  delete every such key from `env`, then run `takeManagedHandoffFile` on the named path and hold
 *  the text in this module. A refusal prints one line naming the check and exits 1; the file is
 *  already unlinked by then. With the variable absent it does nothing. */
export function takeManagedHandoffCustody(env: Record<string, string | undefined>): void {
  let path: string | undefined;
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== MANAGED_HANDOFF_FILE_ENV) continue;
    path ||= env[key];
    delete env[key];
  }
  if (!path) return;
  try {
    held = takeManagedHandoffFile(path);
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
}

/** The text custody holds, handed over once. A later call returns undefined. Only the spawn
 *  handler calls it. */
export function claimManagedHandoff(): string | undefined {
  const text = held;
  held = undefined;
  return text;
}
