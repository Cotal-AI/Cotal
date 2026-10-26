import { writeSync } from "node:fs";
import { CommandFailure } from "@cotal-ai/workspace";
import { seedDir } from "./paths.js";
import { reconcileSeededConnectors, seedStoreMoved } from "./reconcile.js";

/** `up` reconciles the connector seed store when it first starts a process, not at the dispatcher's
 *  boot gate, so every refusal before that leaves the operator-global store as it found it. */
let deferred = false;
let moveReported = false;

/** Called by the dispatcher in place of the boot-gate reconcile, for `up` only. */
export function deferSeedToLaunch(): void {
  deferred = true;
}

/** Reconcile the deferred seed once, before the first process this run starts. A no-op for every
 *  command the dispatcher already seeded. Once it moved the store, a run that then exits non-zero
 *  says so, also on the routes that print their own failure and exit. */
export async function seedBeforeLaunch(): Promise<void> {
  if (!deferred) return;
  deferred = false;
  try {
    await reconcileSeededConnectors();
  } catch (error) {
    throw new CommandFailure("failed", "OPERATION_FAILED", `the connector seed failed, so up started no further process: ${(error as Error).message}`, { cause: error });
  }
  if (seedStoreMoved()) process.once("exit", (code) => {
    const note = code === 0 ? undefined : seedMoveNote();
    if (note) writeSync(2, `  ${note}\n`);
  });
}

/** The sentence a failed `up` adds once its seed moved the store, or undefined when it moved none or
 *  the sentence was already given. */
export function seedMoveNote(): string | undefined {
  const moved = seedStoreMoved();
  if (!moved || moveReported) return undefined;
  moveReported = true;
  return `the connector seed store ${seedDir()} had already moved to generation ${moved.to}${moved.from === undefined ? "" : ` from ${moved.from}`}`;
}
