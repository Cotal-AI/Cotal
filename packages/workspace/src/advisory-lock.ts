/**
 * The advisory lock now lives in `@cotal-ai/core`. This is a RE-EXPORT, not a second copy.
 *
 * It moved because it was never a workspace concern: the implementation imports nothing but Node
 * builtins (`child_process`, `fs`, `crypto`, `path`) and has no coupling to `~/.cotal`, the mesh
 * registry, or anything else this package is about. It was a generic filesystem primitive that
 * happened to be written here, and `extensions/connector-core` needed it for the event emitter's
 * one-per-principal lock — which it cannot reach, because extensions peer-depend on core alone.
 *
 * **The alternative was a second implementation, and that is the outcome this file exists to
 * prevent.** A duplicated hardened lock does not stay duplicated; it diverges in the direction of
 * whoever needed it less, and the copy that drifts is the one quietly missing the release nonce or
 * the PID-reuse token. One lock, one set of rules about ownership, liveness and reclaim.
 *
 * This shim keeps every existing import line working — both the relative `./advisory-lock.js`
 * imports inside this package and `@cotal-ai/workspace`'s public surface via `index.ts` — so the
 * move is invisible to consumers. Names are re-exported EXPLICITLY rather than with a blanket
 * `export *` from core, which would silently widen this package's surface to all of core.
 */
export {
  acquireLock,
  inspectLock,
  breakLock,
  lockIsActive,
  liveLockOwnerPid,
  processStartToken,
} from "@cotal-ai/core";
export type { LockOwner, HeldLock, AcquireOptions, LockInspection } from "@cotal-ai/core";
