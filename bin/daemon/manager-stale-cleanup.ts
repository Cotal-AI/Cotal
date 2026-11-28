/**
 * Repair for a hosted Manager whose cleanup record names an older instance than the one this
 * computer now runs. Disconnect refuses that pair ("cleanup identity differs"), so the old
 * registration stays in the space and nothing in the app could remove it.
 *
 * The record proves the old instance was this computer's own. Repair asks the space to remove only
 * that instance, through the same guarded deregistration as disconnect, with the record's verified
 * authority. The space refuses while the old instance still answers or cannot be shown gone, so a
 * live copy is never removed; that refusal is reported in its own sentence. On removal the record is
 * rebound to the current instance. A space this computer still hosts starts its Manager again. A space
 * the person disconnected stays disconnected: Repair finishes that disconnect, which removes the
 * current instance through disconnect's own guarded path. Anything else keeps the record unchanged.
 * Repair's own request never names the current instance.
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
  /** This computer still means to host the space: its hosting intent exists. Disconnect removes it first. */
  readonly intended: () => boolean;
  /** Re-read both identities just before the request. */
  readonly read: () => StaleCleanup | undefined;
  /** Verify the record's root, provider and store identity before any request. */
  readonly verifyAuthority: () => void;
  readonly deregister: (request: RemoteEndpointDeregisterRequest) => Promise<RemoteEndpointDeregisterResult>;
  /** Rebind the record to `current`, phase hosted. */
  readonly rebind: (current: string) => void;
  readonly start: () => Promise<void>;
  /** Finish the disconnect the person asked for, now that the record names the current instance. */
  readonly finishDisconnect: () => Promise<void>;
}

export type StaleCleanupOutcome =
  | { readonly state: "removed"; readonly message: string }
  | { readonly state: "still-answers"; readonly message: string }
  | { readonly state: "kept"; readonly message: string };

export async function repairStaleCleanup(deps: StaleCleanupDeps): Promise<StaleCleanupOutcome> {
  // Read the intent before anything else: a disconnected space must not be started again.
  const intended = deps.intended();
  const stale = deps.read();
  if (!stale || stale.recorded === stale.current) return { state: "kept", message: "Nothing needed to change." };
  deps.verifyAuthority();
  const request = { v: 1, kind: "endpoint-deregister", space: stale.space, endpoint: "manager", instanceId: stale.recorded } as const;
  const result = await deps.deregister(request);
  if (result.instanceId !== stale.recorded) throw new Error("the space answered for another instance; nothing was changed");
  if (result.state === "removed" || (result.state === "refused" && result.condition === "not-registered")) {
    deps.rebind(stale.current);
    // A disconnect that ran during the request withdrew the intent too.
    if (!intended || !deps.intended()) {
      await deps.finishDisconnect();
      return { state: "removed", message: `The old registration in ${stale.space} was removed and the space stays disconnected from this computer.` };
    }
    await deps.start();
    return { state: "removed", message: `The old registration in ${stale.space} was removed and the agent host started again.` };
  }
  if (result.state === "refused" && (result.condition === "instance-answered" || result.condition === "instance-not-affirmed-gone"))
    return { state: "still-answers", message: `An older copy of this computer's agent host still answers in ${stale.space}, so Repair left it alone.` };
  return { state: "kept", message: `The space did not confirm removing the old registration in ${stale.space}, so Repair left it as it was.` };
}
