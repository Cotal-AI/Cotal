import {
  claimExtensionMutationLock,
  claimExtensionUpdatePass,
  extensionUpdatePassOwnedBy,
} from "@cotal-ai/workspace";

/**
 * Extension mutations use a pass guard followed by the prefix writer lock. Ordinary add/remove and
 * seeding hold both; `cotal update` holds the pass guard across its whole inventory and npm check,
 * while each isolated child owns the writer lock for its actual npm transaction. Both use the shared
 * crash-safe advisory primitive. This lives outside commands/seed so every path shares one lock order.
 */
/** Claim the extension-prefix writer lock. `waitMs` defaults to 0 — an interactive operator `cotal
 *  ext` fails FAST on a live holder ("retry once it finishes"), never a 5-minute wait; a dead owner is
 *  still reclaimed. The reconcile passes a modest wait so a brief concurrent operator op doesn't fail
 *  the boot-gate. */
export function claimExtensionMutation(opts: { waitMs?: number; borrowUpdateParent?: number } = {}): () => void {
  return claimExtensionMutationLock({
    ...opts,
    label: "a `cotal ext` mutation",
    timeoutMessage: (pid) => `another \`cotal ext\` mutation is in progress (pid ${pid}) - retry once it finishes`,
  });
}

/** Reserve a whole multi-child update pass. Children borrow this guard but own the normal mutation
 * lock while touching npm state, so an orphan still blocks concurrent writers after its parent dies. */
export { claimExtensionUpdatePass, extensionUpdatePassOwnedBy };
