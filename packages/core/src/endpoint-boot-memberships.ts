// The boot durable memberships of CotalEndpoint, as an internal component. Moved verbatim from
// endpoint.ts; the endpoint keeps the public methods and forwards to them. Not re-exported by the index.
import type { DeliveryState } from "./endpoint-delivery-state.js";
import type { LifecycleState } from "./endpoint-lifecycle-state.js";
import type { EndpointIdentity } from "./endpoint-identity.js";
import type { EndpointParts } from "./endpoint-parts.js";
import { isChannelFamily, isConcreteChannel } from "./subjects.js";
import type { ControlReply } from "./types.js";

/** What the boot-membership component reads from its endpoint. State is read when it is used, never
 *  copied, and every method is looked up on the endpoint at call time. A peer part is read from the
 *  parts record at call time. */
export interface EndpointBootMembershipsDeps {
  requireLifecycleUid: (what: string) => string;
  emitRecoverable: (err: Error) => void;
}

/** One endpoint's boot durable memberships: the first-connect self-join of its durable boot channels,
 *  the capped-backoff reconcile that restores one after a daemon outage, and the membership read and
 *  check the leave path and the delivery-health surface use. Internal: `CotalEndpoint` keeps the
 *  public methods and forwards to it. */
export class EndpointBootMemberships {
  /** Boot durable channels whose self-join hasn't yet established a membership (daemon down/absent at
   *  first connect, or a transient `durable:false`). {@link reconcileBootJoin} retries with capped
   *  backoff until the membership exists or the channel is left — so a first-connect daemon outage
   *  self-heals on recovery instead of leaving the channel silently live-only. Surfaced to the connector
   *  via {@link hasDurableMembership} (a joined durable channel NOT yet a member renders degraded). */
  private readonly pendingBootJoins = new Set<string>();

  constructor(private readonly identity: Readonly<EndpointIdentity>, private readonly lifecycle: Readonly<LifecycleState>, private readonly delivery: Readonly<DeliveryState>, private readonly deps: EndpointBootMembershipsDeps, private readonly parts: Pick<EndpointParts, "anycastRail" | "controlPlane" | "durable" | "durableBackstop" | "reconnection">) {}

  private requireLifecycleUid(what: string) { return this.deps.requireLifecycleUid(what); }
  private emitRecoverable(err: Error) { this.deps.emitRecoverable(err); }

  /** Agent-side: current lifecycle memberships, or all principal-owned rows for an explicit channel,
   *  from the delivery service. The agent holds no read on the privileged members KV. `undefined` ⇒ NO control responder
   *  (open / no delivery daemon, so there is no Plane-3 and no memberships). THROWS on a responder-present RPC
   *  failure, so a caller can FAIL-CLOSED rather than mistaking a transient error for "no membership". */
  async fetchMemberships(channel?: string): Promise<{ channel: string; generation: number; activated: boolean; lifecycleUid?: string }[] | undefined> {
    let reply: ControlReply;
    try {
      reply = await this.parts.controlPlane.requestDelivery("listMemberships", { lifecycleUid: this.requireLifecycleUid("listing durable memberships"), ...(channel === undefined ? {} : { channel }) }, 5_000);
    } catch (e) {
      if (this.parts.anycastRail.isNoResponders(e)) return undefined; // no delivery daemon — open / daemon-less, no Plane-3
      throw e; // responder present but errored — surface it (leaveChannel fails closed)
    }
    if (!reply.ok) throw new Error(reply.error ?? "listMemberships failed");
    return (reply.data as { memberships?: { channel: string; generation: number; activated: boolean; lifecycleUid?: string }[] } | undefined)?.memberships ?? [];
  }

  /** Agent-side, first connect (auth): SELF-JOIN this session's durable boot channels via the
   *  server-side delivery daemon — replacing the old manager-written boot membership. Each concrete
   *  `durable`-class boot channel, and each family such as `review.>`, gets a `durableJoin` whose
   *  returned generation seeds the leave mirror
   *  + durable-state surface; an already-active membership (a relaunch) is idempotent (no re-catch-up).
   *  If the daemon is down/absent at first connect (or reports a transient `durable:false`), the channel
   *  is handed to {@link reconcileBootJoin} for capped-backoff retry — so the backstop is RESTORED once
   *  the daemon recovers, not left silently live-only. Until a membership exists the channel renders
   *  degraded in `cotal_channels` ({@link hasDurableMembership}). */
  async armBootDurableMemberships(): Promise<void> {
    for (const channel of this.identity.channels) {
      if (this.delivery.plane3Channels.has(channel)) continue;
      // A family (`review.>`) asks for its row whatever the default class: each channel under it decides
      // its own at fan-out (#5404). Any other pattern has no durable membership.
      if (!isChannelFamily(channel)) {
        if (!isConcreteChannel(channel)) continue;
        // A missing channel row legitimately resolves through the defaults. A failed/denied registry
        // read does not prove the channel is live-only, so let it fail startup loudly.
        const cls = await this.parts.durableBackstop.deliveryClassFresh(channel);
        if (cls !== "durable") continue;
      }
      try {
        const r = await this.parts.durable.durableJoinChannel(channel);
        if (r.durable) this.delivery.plane3Channels.set(channel, r.generation ?? 0);
        else void this.reconcileBootJoin(channel); // present but not yet durable — reconcile to recovery
      } catch (e) {
        if (!this.parts.anycastRail.isNoResponders(e)) this.emitRecoverable(e as Error); // no daemon ⇒ retry until it recovers
        void this.reconcileBootJoin(channel);
      }
    }
  }

  /** Retry a boot durable self-join with capped backoff until a membership EXISTS (success → seed
   *  `plane3Channels`) or the channel is left / the endpoint stops. Mirrors {@link closeRefusedMembership}:
   *  a one-shot first-connect attempt that swallowed a daemon outage would leave the boot channel live-only
   *  forever after the daemon recovers (and the lease-based health could then read "active" with no owner
   *  membership). This loop is the reconcile that closes that gap. Idempotent — a channel already pending
   *  is not double-driven; survives reconnect (it re-issues `durableJoinChannel` on the current connection). */
  private async reconcileBootJoin(channel: string): Promise<void> {
    if (this.pendingBootJoins.has(channel)) return; // already reconciling
    this.pendingBootJoins.add(channel);
    for (let attempt = 0; ; attempt++) {
      await this.parts.reconnection.membershipPause(attempt);
      if (this.lifecycle.stopped || !this.identity.channels.includes(channel) || this.delivery.plane3Channels.has(channel)) {
        this.pendingBootJoins.delete(channel);
        return; // stopped, left, or another path established it
      }
      try {
        const r = await this.parts.durable.durableJoinChannel(channel);
        if (r.durable) {
          this.delivery.plane3Channels.set(channel, r.generation ?? 0);
          this.pendingBootJoins.delete(channel);
          return;
        }
        // present but durable:false (e.g. catch-up window evicted) — keep retrying; the channel stays
        // honestly degraded meanwhile, never silently "active".
      } catch (e) {
        if (attempt === 0 && !this.parts.anycastRail.isNoResponders(e))
          this.emitRecoverable(new Error(`channel "${channel}": boot durable self-join not yet established - retrying until the delivery daemon is reachable (${(e as Error).message})`));
      }
    }
  }

  /** True if this session holds an established Plane-3 durable membership for `channel` (in `plane3Channels`).
   *  Drives the membership-aware delivery-health surface: a joined durable channel that is NOT yet a member
   *  (boot self-join pending / daemon down) must render degraded, never "active" off a live lease alone. */
  hasDurableMembership(channel: string): boolean {
    return this.delivery.plane3Channels.has(channel);
  }
}
