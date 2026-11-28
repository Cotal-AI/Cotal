/**
 * Repair for a hosted Manager whose cleanup record names an older instance than the one this
 * computer now runs. Disconnect refuses that pair ("cleanup identity differs"), so the old
 * registration stays in the space and nothing in the app could remove it.
 *
 * The record proves the old instance was this computer's own. Repair asks the space to remove only
 * that instance, through the same guarded deregistration as disconnect, with the record's verified
 * authority. The space refuses while the old instance still answers or cannot be shown gone, so a
 * live copy is never removed; that refusal is reported in its own sentence. On removal the record is
 * rebound to the current instance and the space's Manager starts again. Anything else keeps the
 * record unchanged. The current instance is never deregistered.
 */
import type { RemoteEndpointDeregisterRequest, RemoteEndpointDeregisterResult } from "@cotal-ai/core";

export interface StaleCleanup {
  readonly space: string;
  /** The older instance the cleanup record names. */
  readonly recorded: string;
  /** The instance the Manager identity file names now. */
  readonly current: string;
}

export interface StaleCleanupDeps {
  /** Re-read both identities under the space's operation queue. */
  readonly read: () => StaleCleanup | undefined;
  /** Verify the record's root, provider and store identity before any request. */
  readonly verifyAuthority: () => void;
  readonly deregister: (request: RemoteEndpointDeregisterRequest) => Promise<RemoteEndpointDeregisterResult>;
  /** Rebind the record to `current`, phase hosted. */
  readonly rebind: (current: string) => void;
  readonly start: () => Promise<void>;
}

export type StaleCleanupOutcome =
  | { readonly state: "removed"; readonly message: string }
  | { readonly state: "still-answers"; readonly message: string }
  | { readonly state: "kept"; readonly message: string };

export async function repairStaleCleanup(deps: StaleCleanupDeps): Promise<StaleCleanupOutcome> {
  const stale = deps.read();
  if (!stale || stale.recorded === stale.current) return { state: "kept", message: "Nothing needed to change." };
  deps.verifyAuthority();
  const request = { v: 1, kind: "endpoint-deregister", space: stale.space, endpoint: "manager", instanceId: stale.recorded } as const;
  const result = await deps.deregister(request);
  if (result.instanceId !== stale.recorded) throw new Error("the space answered for another instance; nothing was changed");
  if (result.state === "removed" || (result.state === "refused" && result.condition === "not-registered")) {
    deps.rebind(stale.current);
    await deps.start();
    return { state: "removed", message: `The old registration in ${stale.space} was removed and the agent host started again.` };
  }
  if (result.state === "refused" && (result.condition === "instance-answered" || result.condition === "instance-not-affirmed-gone"))
    return { state: "still-answers", message: `An older copy of this computer's agent host still answers in ${stale.space}, so Repair left it alone.` };
  return { state: "kept", message: `The space did not confirm removing the old registration in ${stale.space}, so Repair left it as it was.` };
}
