import type { SpaceAuth } from "@cotal-ai/core";

/** What ManagerBoot.start learns about this manager. Start writes it once; parts read it at use. */
export interface ManagerStartState {
  /** Space trust material when the mesh runs in auth mode (`.cotal/auth` present); the manager mints
   *  per-agent creds from it at spawn. Undefined when the mesh is open. */
  auth?: SpaceAuth;
  /** True on a USER-AUTH space (the on-disk marker; cross-checked against the registry at start).
   *  Gates the whole spawn path: user mode grants ledger actors + bearer plumbing, never static mints. */
  userMode: boolean;
  /** This manager's persisted instance id, restored or minted at start (or the remote authority's). */
  managerInstanceId?: string;
}
