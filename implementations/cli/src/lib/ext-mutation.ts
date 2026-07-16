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
/** Claim the extension-prefix writer lock. `waitMs` defaults to 0 — an interactive operator `cotal
 *  ext` fails FAST on a live holder ("retry once it finishes"), never a 5-minute wait; a dead owner is
 *  still reclaimed. The reconcile passes a modest wait so a brief concurrent operator op doesn't fail
 *  the boot-gate. */
export function claimExtensionMutation(opts: { waitMs?: number } = {}): () => void {
  const held = acquireLock(extensionMutationLockPath(), {
    label: "a `cotal ext` mutation",
    waitMs: opts.waitMs ?? 0,
    onTimeout: (owner) => new Error(`another \`cotal ext\` mutation is in progress (pid ${owner.pid}) - retry once it finishes`),
  });
  return () => held.release();
}
