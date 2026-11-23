import type { SpaceAuth } from "@cotal-ai/core";

/** How this manager's space authenticates. ManagerBoot.start writes it once; parts read it at use. */
export interface ManagerAuthState {
  /** Space trust material when the mesh runs in auth mode (`.cotal/auth` present); the manager mints
   *  per-agent creds from it at spawn. Undefined when the mesh is open. */
  auth?: SpaceAuth;
  /** True on a USER-AUTH space (the on-disk marker; cross-checked against the registry at start).
   *  Gates the whole spawn path: user mode grants ledger actors + bearer plumbing, never static mints. */
  userMode: boolean;
}
