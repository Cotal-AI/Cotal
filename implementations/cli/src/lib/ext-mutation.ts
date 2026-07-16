import { acquireLock, extensionMutationLockPath } from "@cotal-ai/workspace";

/**
 * The extension-prefix writer lock: serializes every `cotal ext` mutation (add/remove) AND the
 * built-in seeding reconcile against each other, over the shared crash-safe advisory-lock primitive
 * (atomic `mkdir` publish, PID + process-start liveness, bounded wait, nonce-guarded release). Lives
 * in its own lib so both `commands/ext.ts` and the `seed/` reconcile hold it without an import cycle:
 * the reconcile keeps it for its WHOLE run (across every seed child) so an operator `ext add`/`remove`
 * can't interleave between children and strand a stale refresh decision; each seed child skips
 * claiming it (its parent already holds it — see `commands/ext.ts`).
 */
export function claimExtensionMutation(): () => void {
  const held = acquireLock(extensionMutationLockPath(), {
    label: "a `cotal ext` mutation",
    // Fail FAST on a live holder (the interactive-operator contract): a concurrent `cotal ext` is a
    // "retry once it finishes", not a 5-minute wait. A dead owner is still reclaimed. (The reconcile
    // takes the SAME lock for its whole run, so an operator command during a first-boot seed retries.)
    waitMs: 0,
    onTimeout: (owner) => new Error(`another \`cotal ext\` mutation is in progress (pid ${owner.pid}) - retry once it finishes`),
  });
  return () => held.release();
}
