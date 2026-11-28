// The agent-side durable membership of CotalEndpoint, as an internal component: ask the delivery daemon to
// join or leave a channel's Plane-3 backstop, retry the tombstone of a membership a refused live sub forced
// out, check a lifecycle's ACL row and copy the catch-up window for a privileged join. Moved verbatim from
// endpoint.ts; the component owns its pending leaves, reads the endpoint's identity and remaining shared
// fields through its dependencies, and the endpoint forwards to it. Not re-exported by the index.
import type { DeliveryState } from "./endpoint-delivery-state.js";
import type { LifecycleState } from "./endpoint-lifecycle-state.js";
import type { ConnectionState } from "./endpoint-connection-state.js";
import type { EndpointIdentity } from "./endpoint-identity.js";
import type { EndpointParts } from "./endpoint-parts.js";
import { readAcl } from "./acls.js";
import { isFromSubjectSender } from "./endpoint-messages.js";
import { hasStoredOrigin } from "./endpoint-provenance.js";
import { membershipInAllow, chatSubject, isChannelFamily, parsePrincipalKey, lifecycleNameKey, token, chatStream, parseSubject } from "./subjects.js";
import type { CotalMessage } from "./types.js";
import { AckPolicy, DeliverPolicy } from "@nats-io/jetstream";
import { nanos } from "@nats-io/transport-node";

/** What the durable-membership component reads from its endpoint. State is read when it is used, never
 *  copied, and every method is looked up on the endpoint at call time, so a member a caller replaced on
 *  the endpoint is the one that runs. A peer part is read from the parts record at call time. */
export interface EndpointDurableDeps {
  requireLifecycleUid: (what: string) => string;
  emitRecoverable: (err: Error) => void;
}

/** One endpoint's durable membership. Internal: it owns its pending leaves, and `CotalEndpoint` keeps the shared fields and forwards to it. */
export class EndpointDurable {
  /** Channels whose live sub was REFUSED while they held a Plane-3 durable membership, whose §7
   *  tombstone has not yet confirmed (channel → join generation). {@link closeRefusedMembership} retries
   *  the tombstone until it lands; until then this is a `durable-unclosed` state surfaced via
   *  {@link pendingDurableLeaves} (the connector shows it in `cotal_channels`, never as ordinary
   *  absence). Persists across reconnect; cleared on tombstone success or full stop. */
  private readonly pendingDurableLeave = new Map<string, number>();

  constructor(private readonly identity: Readonly<EndpointIdentity>, private readonly conn: Readonly<ConnectionState>, private readonly lifecycle: Readonly<LifecycleState>, private readonly delivery: Readonly<DeliveryState>, private readonly deps: EndpointDurableDeps, private readonly parts: Pick<EndpointParts, "consumers" | "controlPlane" | "durableBackstop" | "reconnection">) {}

  private requireLifecycleUid(what: string): string { return this.deps.requireLifecycleUid(what); }
  private emitRecoverable(err: Error): void { return this.deps.emitRecoverable(err); }

  /** Whether one lifecycle's exact ACL row allows a membership on `channel` now (a family must lie
   *  inside one entry, {@link membershipInAllow}). A leader-served read: the handle is opened without
   *  direct reads, so a row narrowed before this read began is the row it returns. */
  async aclAllows(owner: string, lifecycleUid: string, channel: string): Promise<boolean> {
    const row = await readAcl(await this.parts.durableBackstop.aclRegistry(), owner, lifecycleUid);
    return row !== undefined && membershipInAllow(row.record.allowSubscribe, channel);
  }

  /** Idempotently copy the eligible chat messages in `(fromSeqExcl, toSeqIncl]` for `channel` into the
   *  owner inbox, via a DEDICATED per-(owner,join) ephemeral consumer (NOT the agent-scoped
   *  `chathist_<id>`/`histLock` — red-team HIGH-8). It copies what the stream still holds in that
   *  window; a post the history limit removed first is not copied and is not reported (SPEC §4).
   *
   *  A FAMILY row (`review.>`, #5404) reads the window on every channel under it and copies a post only
   *  when that post's own channel is durable-class. Each copy names the post's own channel, never the
   *  family, and it skips nothing another row of the lifecycle covers: two joins can both be pending
   *  when a post lands, so neither proves the other copied it. The per-message, per-lifecycle dedupe id
   *  keeps one copy. */
  async catchupCopy(
    owner: string, lifecycleUid: string, channel: string, fromSeqExcl: number, toSeqIncl: number, generation: number,
  ): Promise<number> {
    if (!this.conn.js || !this.conn.jsm || toSeqIncl <= fromSeqExcl) return 0;
    const subject = chatSubject(this.identity.space, "*", "*", channel);
    const family = isChannelFamily(channel);
    const durableClass = new Map<string, Promise<boolean>>();
    const stored = (ch: string): Promise<boolean> => {
      if (!family) return Promise.resolve(true);
      let cls = durableClass.get(ch);
      if (cls === undefined) durableClass.set(ch, (cls = this.parts.durableBackstop.deliveryClassFresh(ch).then((c) => c === "durable")));
      return cls;
    };
    // Consumer NAME must be JetStream-safe (no `.`) AND collision-free: use the principal DASH-form
    // (`<owner>-<actor>`, `-` reserved as the sole separator), NOT `token(owner)` — `token()` maps the
    // dot-form `.`→`_`, which is NOT collision-free (`_` is legal inside a token, so `a.b_c` and `a_b.c`
    // would both underscore to `a_b_c`). LIFECYCLE-KEYED (SPEC 13.1): generations restart at 1 per
    // lifecycle, so an alias-keyed `cu_<principal>_<gen>` would let a same-alias successor
    // delete/recreate a predecessor's in-flight catch-up consumer — the uid disambiguates.
    const cuP = parsePrincipalKey(owner);
    const name = `cu_${cuP ? lifecycleNameKey(cuP.owner, cuP.actor, lifecycleUid) : `${token(owner)}-${lifecycleUid}`}_${generation}`;
    // A failed read throws, leaving the pending row to retry over the same window.
    await this.parts.consumers.deleteConsumerIfPresent(chatStream(this.identity.space), name);
    await this.conn.jsm.consumers.add(chatStream(this.identity.space), {
      name, filter_subject: subject, ack_policy: AckPolicy.None, mem_storage: true,
      inactive_threshold: nanos(30_000), deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: fromSeqExcl + 1,
    });
    let copied = 0;
    try {
      const consumer = await this.conn.js.consumers.get(chatStream(this.identity.space), name);
      let pending = (await consumer.info()).num_pending;
      while (pending > 0) {
        const want = Math.min(pending, 256);
        const iter = await consumer.fetch({ max_messages: want, expires: 5_000 });
        let got = 0;
        for await (const m of iter) {
          got++;
          if (m.seq > toSeqIncl) return copied;
          if (hasStoredOrigin(m.headers)) continue;
          let msg: CotalMessage;
          try { msg = m.json<CotalMessage>(); } catch { continue; }
          const parsed = parseSubject(m.subject);
          if (!parsed || !isFromSubjectSender(msg, parsed) || msg.from.id === owner) continue;
          if (!(await stored(parsed.rest))) continue;
          await this.parts.durableBackstop.publishDinbox(owner, lifecycleUid, {
            msg, channel: parsed.rest, seq: m.seq, reason: "durable-channel", generation, ...(family ? { row: channel } : {}),
          });
          copied++;
        }
        if (got < want) break;
        pending -= got;
      }
    } finally {
      await this.parts.consumers.deleteConsumerIfPresent(chatStream(this.identity.space), name);
    }
    return copied;
  }

  /** Agent-side: request a Plane-3 durable backstop for a channel via the server-side delivery daemon (ctl.delivery). Throws
   *  when no privileged writer is present (open / no delivery daemon). 30s timeout — activation catch-up may
   *  run before the reply (the window is small, but a busy channel can take more than the 5s default). */
  async durableJoinChannel(channel: string): Promise<{ durable: boolean; reason?: string; generation?: number }> {
    const reply = await this.parts.controlPlane.requestDelivery("durableJoin", { channel }, 30_000);
    if (!reply.ok) throw new Error(reply.error ?? "durable join rejected");
    return (reply.data as { durable: boolean; reason?: string; generation?: number }) ?? { durable: false };
  }

  /** Agent-side: release a Plane-3 durable backstop (tombstone membership at the leave cursor). Passes
   *  the join generation so a stale leave can't tombstone a newer rejoin (the delivery daemon validates
   *  it) AND this incarnation's lifecycleUid — membership rows are lifecycle-keyed (SPEC 13.1), and a
   *  leave must resolve the selected principal-owned row even after the ACL row was narrowed or purged. */
  async durableLeaveChannel(channel: string, generation?: number, lifecycleUid = this.requireLifecycleUid("leaving a durable channel")): Promise<void> {
    const reply = await this.parts.controlPlane.requestDelivery("durableLeave", { channel, generation, lifecycleUid });
    if (!reply.ok) throw new Error(reply.error ?? "durable leave rejected");
  }

  /** Fail-closed async cleanup for a channel forced out by a LATE sub.allow refusal (the broker revoked
   *  the live read). The sync sub callback can't await, so this RETRIES the Plane-3 tombstone with capped
   *  backoff UNTIL IT SUCCEEDS (or the endpoint stops) — the §7 boundary always closes once the manager
   *  is reachable, never a silent give-up. While pending, the channel is tracked in
   *  {@link pendingDurableLeave} and surfaced via {@link pendingDurableLeaves} (the connector shows it in
   *  `cotal_channels` as `durable-unclosed`, never ordinary absence). The generation is kept the whole
   *  time. Authoritative closure of a revoked membership is also handled by revocation (rotate creds + tear down). */
  async closeRefusedMembership(channel: string, generation: number): Promise<void> {
    this.pendingDurableLeave.set(channel, generation);
    for (let attempt = 0; ; attempt++) {
      if (this.lifecycle.stopped) return;
      try {
        await this.durableLeaveChannel(channel, generation);
        this.delivery.plane3Channels.delete(channel);
        this.pendingDurableLeave.delete(channel);
        return;
      } catch (e) {
        if (attempt === 0)
          this.emitRecoverable(new Error(`channel "${channel}": Plane-3 durable membership (generation ${generation}) not yet tombstoned after a refused live sub - retrying; §7 boundary may be open until it succeeds (${(e as Error).message})`));
        await this.parts.reconnection.membershipPause(attempt);
      }
    }
  }

  /** Channels with a Plane-3 durable membership whose §7 tombstone is still pending after a refused live
   *  sub (see {@link closeRefusedMembership}) — surfaced by the connector as a `durable-unclosed` state so
   *  it is never presented as ordinary "not subscribed". */
  pendingDurableLeaves(): string[] {
    return [...this.pendingDurableLeave.keys()];
  }
}
