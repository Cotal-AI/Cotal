// The Plane-3 registries, leases and durable membership writes of CotalEndpoint, as an internal
// component. Moved verbatim from endpoint.ts; the endpoint keeps the public methods and forwards to
// them. Not re-exported by the index.
import { jetstream, jetstreamManager, JetStreamApiCodes, type JetStreamClient, type JetStreamManager, type ConsumerInfo, type JetStreamPublishOptions } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import { openAclRegistry, readAcl, readAclForAlias, AmbiguousAclAlias, commitAcl as writeAclRecord, reissueAcl as writeAclReissue } from "./acls.js";
import { effectiveDeliveryClass, readChannelConfig, readChannelDefaults } from "./channels.js";
import type { EndpointDeliveryPlane } from "./endpoint-delivery-plane.js";
import type { EndpointPresence } from "./endpoint-presence.js";
import { isCasLoss } from "./endpoint-records.js";
import type { ManagerLeaseInfo } from "./lease.js";
import { openMembersRegistry, commitMemberRevision, tombstoneMember, activateMember, readMember, deleteMember, listMembers } from "./members.js";
import { MANAGER_LEASE_TTL_MS, MANAGER_LEASE_ATTEMPT_MS } from "./streams.js";
import { chatStream, dinboxSubject, FANOUT_DURABLE, isConcreteChannel, managerBucket, MANAGER_LEASE_KEY, MANAGER_RENEWAL_LEASE_KEY, managerLeaseKey, memberKey, parsePrincipalKey } from "./subjects.js";
import type { AgentCard, DeliveryClass, MembershipRecord, Plane3Entry } from "./types.js";

/** What the durable backstop reads from its endpoint. State is read when it is used, never copied,
 *  and every method is looked up on the endpoint at call time. The connection-scoped handles stay
 *  fields of the endpoint, which drops them on reconnect; the component reads and sets them there. */
export interface EndpointDurableBackstopDeps {
  nc: () => NatsConnection | undefined;
  js: () => JetStreamClient | undefined;
  jsm: () => JetStreamManager | undefined;
  setJsm: (manager: JetStreamManager) => void;
  space: () => string;
  card: () => AgentCard;
  authed: () => boolean;
  channelKv: () => KV | undefined;
  presence: () => EndpointPresence;
  deliveryPlane: () => EndpointDeliveryPlane;
  membersKv: () => KV | undefined;
  setMembersKv: (kv: KV | undefined) => void;
  aclKv: () => KV | undefined;
  setAclKv: (kv: KV | undefined) => void;
  managerLeaseKv: () => KV | undefined;
  setManagerLeaseKv: (kv: KV | undefined) => void;
  daemonRenewalLeaseRevision: () => number | undefined;
  setDaemonRenewalLeaseRevision: (revision: number | undefined) => void;
  notLiveMsg: () => string;
  consumerInfo: (stream: string, durable: string) => Promise<ConsumerInfo | null>;
  manager: () => Promise<JetStreamManager>;
  chatFrontier: () => Promise<number>;
  aclAllows: (owner: string, lifecycleUid: string, channel: string) => Promise<boolean>;
  catchupCopy: (owner: string, lifecycleUid: string, channel: string, fromSeqExcl: number, toSeqIncl: number, generation: number) => Promise<number>;
}

/** The Plane-3 durable backstop's state outside the delivery loops: the members and read-ACL
 *  registries, the manager and daemon-renewal leases, and the durable join and leave writes the
 *  delivery daemon serves. Internal: `CotalEndpoint` keeps the public methods and forwards to it. */
export class EndpointDurableBackstop {
  constructor(private readonly deps: EndpointDurableBackstopDeps) {}

  private get nc() { return this.deps.nc(); }
  private get js() { return this.deps.js(); }
  private get jsm() { return this.deps.jsm(); }
  private set jsm(manager: JetStreamManager | undefined) { if (manager) this.deps.setJsm(manager); }
  private get space() { return this.deps.space(); }
  private get card() { return this.deps.card(); }
  private get authed() { return this.deps.authed(); }
  private get channelKv() { return this.deps.channelKv(); }
  private get presence() { return this.deps.presence(); }
  private get deliveryPlane() { return this.deps.deliveryPlane(); }
  private get membersKv() { return this.deps.membersKv(); }
  private set membersKv(kv: KV | undefined) { this.deps.setMembersKv(kv); }
  private get aclKv() { return this.deps.aclKv(); }
  private set aclKv(kv: KV | undefined) { this.deps.setAclKv(kv); }
  private get managerLeaseKv() { return this.deps.managerLeaseKv(); }
  private set managerLeaseKv(kv: KV | undefined) { this.deps.setManagerLeaseKv(kv); }
  private get daemonRenewalLeaseRevision() { return this.deps.daemonRenewalLeaseRevision(); }
  private set daemonRenewalLeaseRevision(revision: number | undefined) { this.deps.setDaemonRenewalLeaseRevision(revision); }
  private notLiveMsg() { return this.deps.notLiveMsg(); }
  private consumerInfo(stream: string, durable: string) { return this.deps.consumerInfo(stream, durable); }
  private manager() { return this.deps.manager(); }
  private chatFrontier() { return this.deps.chatFrontier(); }
  private aclAllows(owner: string, lifecycleUid: string, channel: string) { return this.deps.aclAllows(owner, lifecycleUid, channel); }
  private catchupCopy(owner: string, lifecycleUid: string, channel: string, fromSeqExcl: number, toSeqIncl: number, generation: number) {
    return this.deps.catchupCopy(owner, lifecycleUid, channel, fromSeqExcl, toSeqIncl, generation);
  }

  /** Lazily open the privileged members registry KV (delivery daemon / open-mode self). */
  async membersRegistry(): Promise<KV> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    this.membersKv ??= await openMembersRegistry(this.nc, this.space);
    return this.membersKv;
  }

  /** Lazily open the durable read-ACL registry KV. Privileged write (the manager records an agent's
   *  ACL at mint); the delivery daemon reads it fresh per durable entry to re-authorize. */
  async aclRegistry(): Promise<KV> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    this.aclKv ??= await openAclRegistry(this.nc, this.space);
    return this.aclKv;
  }

  /** Privileged ({@link DurableProvisioner}): record an agent's read ACL in the durable registry at
   *  provision/mint time — the same act as baking it into the JWT, persisted so the server-side
   *  delivery daemon can re-authorize the agent's durable entries and validate its runtime
   *  durable-joins without holding any in-memory ledger. Written ATOMICALLY ({@link writeAclRecord}),
   *  so a present record is always complete (`[]` = known no-read, never a half-write). */
  async commitAcl(targetId: string, lifecycleUid: string, allowSubscribe: string[]): Promise<void> {
    await writeAclRecord(await this.aclRegistry(), targetId, lifecycleUid, allowSubscribe);
  }

  /**
   * Raise the mint-time ACL ceiling. Provision/remint only — see {@link reissueAcl}.
   * Process discipline: call only in the same act that bakes `allowSubscribe` into the JWT; the
   * write is not crypto-bound to credential bytes.
   */
  async reissueAcl(targetId: string, lifecycleUid: string, allowSubscribe: string[]): Promise<void> {
    await writeAclReissue(await this.aclRegistry(), targetId, lifecycleUid, allowSubscribe);
  }

  /** The server-side delivery daemon's fresh-per-entry ACL read: one LIFECYCLE's current read ACL
   *  (`allowSubscribe`) from the durable registry (exact key `<owner>.<actor>.<uid>`), or `undefined`
   *  if no record (an unknown lifecycle — the reader DEFERS, never drops). A present `[]` (known
   *  no-read) returns `[]` (the reader DROPS). */
  async aclForOwner(owner: string, lifecycleUid: string): Promise<string[] | undefined> {
    return (await readAcl(await this.aclRegistry(), owner, lifecycleUid))?.record.allowSubscribe;
  }

  /** Resolve an ALIAS to its single live lifecycle-keyed ACL row (`readAclForAlias`): the daemon's
   *  authz seam for callers that arrive with alias identity only (a `ctl.delivery` durable-join).
   *  THROWS {@link AmbiguousAclAlias} on two live rows — first-match would let a stale lifecycle
   *  authorize the successor (SPEC 13.1: at most one live lifecycle per alias). */
  async aclForAlias(principal: string): Promise<{
    allowSubscribe: string[];
    issuedAllowSubscribe: string[];
    lifecycleUid: string;
  } | undefined> {
    const row = await readAclForAlias(await this.aclRegistry(), principal);
    if (row === undefined) return undefined;
    const allow = row.record.allowSubscribe;
    // Legacy rows predate the ceiling field: treat missing as equal to allowSubscribe so behaviour
    // matches what that row already exposed. New rows always carry an explicit ceiling.
    const issued = row.record.issuedAllowSubscribe ?? allow;
    return { allowSubscribe: allow, issuedAllowSubscribe: issued, lifecycleUid: row.lifecycleUid };
  }

  /** Ensure + bind the manager singleton-lease bucket. Mirrors the presence-bucket pattern (connectAndBind):
   *  AUTH mode OPENs the bucket pre-created at `cotal up` (the scoped `supervisor` cred holds no
   *  STREAM.CREATE — and `open` binds direct=false, so the CAS-conflict `kv.get` inside `acquire` rides
   *  STREAM.MSG.GET, the verb the supervisor grants, never DIRECT.GET). OPEN mode (no creds) create-firsts:
   *  `Kvm.open` binds LAZILY — it does NOT verify the stream exists or throw when it's missing (a fresh
   *  bucket then fails 'stream not found' on the first write), so `create` is the ensure-exists call (it
   *  makes the bucket or, when another endpoint already did, throws and we bind the existing one). Either
   *  way the per-KEY CAS create stays the only single-flight gate, so a lost bucket-create race never reads
   *  as "lease held". */
  private async managerLeaseRegistry(): Promise<KV> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    if (this.managerLeaseKv) return this.managerLeaseKv;
    // A JetStream client of its own, so every operation on this bucket carries the lease budget's
    // attempt deadline rather than the library default. The default is TTL/2, which would let one
    // attempt spend the whole renew window (see MANAGER_LEASE_ATTEMPT_MS). Scoped to this bucket:
    // every op on it is a single small keyed request, and nothing else shares this client.
    const kvm = new Kvm(jetstream(this.nc, { timeout: MANAGER_LEASE_ATTEMPT_MS }));
    if (this.authed) {
      this.managerLeaseKv = await kvm.open(managerBucket(this.space));
    } else {
      try {
        this.managerLeaseKv = await kvm.create(managerBucket(this.space), { ttl: MANAGER_LEASE_TTL_MS });
      } catch {
        // OPEN mode has no broker ACLs, so a permission denial is impossible here. `create` is only
        // the ensure-exists attempt; `open` below is the authority after either a pre-existing bucket
        // or a create race, and it still throws if the bucket cannot actually be used.
        this.managerLeaseKv = await kvm.open(managerBucket(this.space));
      }
    }
    return this.managerLeaseKv;
  }
  /** Take or keep the per-SPACE daemon-credential renewal lease (#1634), returning whether THIS
   *  instance now holds it. One atomic CAS `create` per pass: it succeeds for whoever arrives first
   *  and throws for everyone else, so exactly one manager remints even when several share the
   *  daemon's store. The holder re-`update`s its own key by revision, which both keeps it and proves
   *  it never lost it. Losing the CAS is an ordinary outcome (a peer holds it) and returns false; it
   *  never fails a start. A crashed holder's key TTL-expires with the bucket, so the next pass hands
   *  the lease to a survivor with no operator step. */
  async holdDaemonRenewalLease(instanceId: string): Promise<boolean> {
    const kv = await this.managerLeaseRegistry();
    const held = this.daemonRenewalLeaseRevision;
    if (held !== undefined) {
      try {
        this.daemonRenewalLeaseRevision = await kv.update(MANAGER_RENEWAL_LEASE_KEY, this.encodeDaemonRenewalLease(instanceId), held);
        return true;
      } catch {
        // The revision moved (our key TTL-expired and a peer took it). Re-contend below rather than
        // keep reminting on a lease we no longer hold.
        this.daemonRenewalLeaseRevision = undefined;
      }
    }
    try {
      this.daemonRenewalLeaseRevision = await kv.create(MANAGER_RENEWAL_LEASE_KEY, this.encodeDaemonRenewalLease(instanceId));
      return true;
    } catch {
      return false; // another manager holds it: exactly one owner is the point
    }
  }

  /** Release the renewal lease on a clean stop so a peer takes over at once rather than at the TTL.
   *  CAS-guarded, so a lease we already lost is never deleted out from under its new holder. */
  async releaseDaemonRenewalLease(): Promise<void> {
    const held = this.daemonRenewalLeaseRevision;
    this.daemonRenewalLeaseRevision = undefined;
    if (held === undefined) return;
    try {
      await (await this.managerLeaseRegistry()).delete(MANAGER_RENEWAL_LEASE_KEY, { previousSeq: held });
    } catch {
      // Best-effort: a moved revision means it is not ours, and a broker failure is recovered by the
      // bucket TTL. Shutdown must not claim deletion.
    }
  }

  private encodeDaemonRenewalLease(instanceId: string): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ instanceId, since: Date.now() }));
  }

  /** Read the per-space daemon-credential renewal-lease row (the one {@link holdDaemonRenewalLease}
   *  CAS-writes), or `undefined` when nothing holds it. A `doctor auth --fix` that lost `hold` calls
   *  this through the SAME bucket the hold attempt opened, to name the live holder in its refusal —
   *  `managerLeaseKv` is private, so this is the exported read beside {@link readManagerLease}. */
  async readDaemonRenewalLease(): Promise<{ instanceId: string; since: number } | undefined> {
    const e = await (await this.managerLeaseRegistry()).get(MANAGER_RENEWAL_LEASE_KEY);
    if (!e || e.operation !== "PUT") return undefined;
    return JSON.parse(new TextDecoder().decode(e.value)) as { instanceId: string; since: number };
  }

  private encodeManagerLease(info: ManagerLeaseInfo): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(info));
  }
  /** Acquire THIS logical instance's liveness lease via ATOMIC CAS create on its own per-instance key
   *  ({@link managerLeaseKey}). THROWS only if that SAME instance id already holds a live key (a same-root
   *  concurrent double-start, or a restart racing the crashed predecessor's not-yet-expired key) — a loud
   *  refusal, never a retry. A DIFFERENT instance (second workspace root ⇒ different id) creates its OWN
   *  key and coexists. A crashed holder's key auto-expires (bucket TTL). Returns the
   *  lease revision (for renew). */
  async acquireManagerLease(info: Omit<ManagerLeaseInfo, "since">): Promise<number> {
    return (await this.managerLeaseRegistry()).create(managerLeaseKey(info.instanceId), this.encodeManagerLease({ ...info, since: Date.now() }));
  }
  /** Renew THIS instance's held key (CAS update against `revision`) before the bucket TTL expires it.
   *  Throws if the revision moved (lost the lease). Returns the new revision. */
  async renewManagerLease(info: Omit<ManagerLeaseInfo, "since">, revision: number): Promise<number> {
    return (await this.managerLeaseRegistry()).update(managerLeaseKey(info.instanceId), this.encodeManagerLease({ ...info, since: Date.now() }), revision);
  }
  /** Read THIS instance's OWN lease key, keyed (not the `lease.*` sweep {@link readManagerLease} does).
   *
   *  `undefined` means the key IS NOT THERE — a definite absence, established by a completed read.
   *  A read that could not be completed THROWS instead, so a caller can tell "it is gone" from "I could
   *  not find out". That distinction is the whole point of the method: a renew that got no answer has
   *  proved nothing, and only a definite answer here may be acted on.
   *
   *  `created` is the broker's write time of the row (epoch ms), which is what the bucket TTL counts
   *  from. */
  async readOwnManagerLease(instanceId: string): Promise<{ info: ManagerLeaseInfo; revision: number; created: number } | undefined> {
    const e = await (await this.managerLeaseRegistry()).get(managerLeaseKey(instanceId));
    if (!e || e.operation !== "PUT") return undefined;
    return { info: JSON.parse(new TextDecoder().decode(e.value)) as ManagerLeaseInfo, revision: e.revision, created: e.created.getTime() };
  }
  /** Release THIS instance's key on clean shutdown so a same-id restart re-acquires immediately. CAS-guarded
   *  by `revision`: if we already LOST it (renew gap) the stored revision has moved, and the conditional
   *  delete is refused and rejects, like any broker failure; a shutdown that must finish anyway catches
   *  it. Keyed per instance, so a release NEVER touches a sibling manager's key (security pin 6). */
  async releaseManagerLease(instanceId: string, revision?: number): Promise<void> {
    const kv = await this.managerLeaseRegistry();
    if (revision === undefined) await kv.delete(managerLeaseKey(instanceId));
    else await kv.delete(managerLeaseKey(instanceId), { previousSeq: revision });
  }
  /** Read a live manager liveness lease, or undefined if NONE (no manager instance holds the space). A
   *  presence/existence check for the CLI's `spawn -f` reuse and `waitLeaseGone`, which only need "is any
   *  manager here". Open-only — never creates the bucket, so a probe that finds no manager leaves none
   *  behind. (Instance-precise enumeration for the class scatter comes from the registration records KV
   *  in 3b-4, not this liveness bucket.)
   *
   *  MULTI-INSTANCE EXACT, and it has to be read that way rather than as a point get. Several managers
   *  may hold one space, each renewing its own `lease.<instanceId>`. A single `last_by_subj` over
   *  `lease.*` returns the newest message under the wildcard REGARDLESS OF KEY — so a stopping peer's
   *  DEL tombstone, being newest, answered "no manager here" while a sibling was alive and renewing.
   *  Only an explicit `kv.delete` writes that tombstone: a manager whose lease TTL-expires is removed by
   *  limits and leaves nothing behind, so the poisoning case was the ORDINARY one (stop a manager
   *  cleanly, then `spawn -f`), not the crash. Enumerating live entries collapses to the greatest
   *  revision PER KEY and drops keys whose final state is a marker, so a peer's DEL can only retire that
   *  peer's own key and can never mask a live one. */
  async readManagerLease(): Promise<ManagerLeaseInfo | undefined> {
    if (!this.nc) return undefined;
    try {
      const jsm = this.jsm ?? (this.jsm = await jetstreamManager(this.nc));
      const stream = `KV_${managerBucket(this.space)}`;
      const prefix = `$KV.${managerBucket(this.space)}.${MANAGER_LEASE_KEY}.`;
      // STREAM.INFO to learn WHICH instance keys exist, then one point-get per key. NOT a bucket
      // scan: `liveKvEntries` binds a push consumer, and this principal's grant on this bucket is
      // STREAM.INFO + STREAM.MSG.GET + the `lease.*` publish only (`provision.ts`, supervisor). A
      // consumer here is a permissions violation for the very callers this probe serves, and no
      // open-mesh test can see that, because an open mesh has no permissions to violate.
      const info = await jsm.streams.info(stream, { subjects_filter: `${prefix}*` });
      let newest: { data: Uint8Array; seq: number } | undefined;
      for (const subject of Object.keys(info.state.subjects ?? {})) {
        // `last_by_subj` is CORRECT PER KEY and wrong across keys. Scoped to one instance's subject
        // it returns that instance's latest state, so a DEL here retires only its own key. The
        // defect was asking one wildcard for the newest message in the whole subtree, where a
        // stopping peer's tombstone outranks a live sibling's older PUT.
        let m;
        try {
          m = await jsm.streams.getMessage(stream, { last_by_subj: subject });
        } catch (e) {
          if ((e as { code?: unknown }).code === JetStreamApiCodes.NoMessageFound) continue;
          throw e;
        }
        if (m === null) continue; // key vanished between INFO and GET: it is not a live holder
        // A 10037 above means the key vanished between INFO and GET: it is not a live holder. A
        // denial or failed read is not absence and is rethrown.
        const op = m.header?.get("KV-Operation");
        if (op === "DEL" || op === "PURGE" || m.data.length === 0) continue;
        if (newest === undefined || m.seq > newest.seq) newest = { data: m.data, seq: m.seq };
      }
      if (newest === undefined) return undefined;
      return JSON.parse(new TextDecoder().decode(newest.data)) as ManagerLeaseInfo;
    } catch (e) {
      // ABSENCE MUST BE PROVEN, NOT INFERRED FROM A FAILED READ. Exactly two outcomes mean "genuinely
      // no manager": 10037, no message on the subtree, and a missing bucket — this probe is open-only
      // and on an authed mesh nothing creates it until a manager first takes a lease, so a space that
      // has never run one has no stream to read. Every OTHER failure (a JetStream hiccup, a request
      // timeout, a permissions refusal, or `liveKvEntries` refusing a pass that died mid-delivery) used
      // to return undefined here as well, and every caller reads undefined as "the space is empty": the
      // CLI's `spawn -f` reuse stands a SECOND manager up against a live one and `waitLeaseGone` reports
      // the space free. A read that failed is not evidence of absence, so refuse loudly rather than
      // degrade (AGENTS.md: no fallbacks). This is the wider of the two doors the point-get fix closes:
      // it needs only a transient error, where the tombstone path needed a peer to stop.
      const code = (e as { code?: unknown }).code;
      if (code === 10037) return undefined;
      if (code === 404 || /stream not found/i.test((e as Error)?.message ?? "")) return undefined;
      throw e;
    }
  }

  /** Privileged: one owner's NON-TOMBSTONED durable memberships as `{channel, generation, activated}` —
   *  the server-side delivery daemon serves this to a connecting agent (the `listMemberships` op on
   *  `ctl.delivery`). The agent seeds its leave mirror from the ACTIVATED ones (the confirmed backstops),
   *  but the non-activated ones are returned too so `leaveChannel` can discover + close a record that
   *  still routes under the pure-interval predicate (a crash-stuck pending activation) — without reading
   *  the privileged KV itself. */
  async ownerMemberships(owner: string, lifecycleUid: string): Promise<{ channel: string; generation: number; activated: boolean }[]> {
    // LIFECYCLE-EXACT (SPEC 13.1): an alias-wide listing would hand a same-alias successor the
    // PREDECESSOR's rows/generations (both incarnations share the alias), and a first-match consumer
    // like leaveChannel could then act on the wrong incarnation's state. Rows are filtered to the
    // caller's own uid; the uid is caller-asserted but confined to its own authenticated alias, the
    // same trust shape as durableLeave.
    const recs = await listMembers(await this.membersRegistry(), { owner });
    return recs
      .filter((r) => r.lifecycleUid === lifecycleUid && r.leaveCursor === undefined)
      .map((r) => ({ channel: r.channel, generation: r.generation, activated: r.activated === true }));
  }

  /** Effective delivery class read AUTHORITATIVELY from the registry KV (not the watch cache) — so a
   *  `live`→`durable` flip is seen by fan-out without a cache-propagation gap (red-team MED-3), and a
   *  reader just started need not wait for the cache to fill. */
  async deliveryClassFresh(channel: string): Promise<DeliveryClass> {
    if (!this.channelKv) return effectiveDeliveryClass(undefined, undefined);
    const [cfg, defaults] = await Promise.all([
      isConcreteChannel(channel) ? readChannelConfig(this.channelKv, channel) : Promise.resolve(undefined),
      readChannelDefaults(this.channelKv),
    ]);
    return effectiveDeliveryClass(cfg, defaults);
  }

  /** Collision-safe `@mention` → owner-id resolution: a name that resolves to exactly one present
   *  peer wins; 0 or >1 matches drop (never fan a directed durable copy to an unrelated same-named
   *  bystander — red-team LOW; SPEC §4 unique instance id). */
  resolveOwnerByName(name: string): string | undefined {
    const matches = [...this.presence.values()].filter((p) => p.card.name.toLowerCase() === name.toLowerCase());
    return matches.length === 1 ? matches[0].card.id : undefined;
  }

  /** Plane-3 publish-dedupe key for a fan-out/transfer entry: the message id plus the member
   *  lifecycle (`keySuffix`). One message reaches one lifecycle once, whichever membership row and
   *  whichever writer (fan-out or any row's catch-up) produced the copy (#5404), within the stream's
   *  duplicate window. An empty `msg.id` contributes NO msgID (#673, SPEC §4: two `id: ""` posts MUST
   *  NOT collapse to one delivery) — a plain publish, never an empty or salted one — so an id-less
   *  message is at-least-once on the durable plane (a redelivery may reach the member twice; the
   *  receiver already treats each as its own delivery). */
  plane3MsgId(entry: Plane3Entry, keySuffix: string): Partial<JetStreamPublishOptions> {
    return entry.msg.id === "" ? {} : { msgID: `${entry.msg.id}:${keySuffix}` };
  }

  /** Publish one fan-out entry into a member LIFECYCLE's mixed inbox (`dinbox.<o>.<a>.<uid>`, SPEC
   *  §13.1: fan-out addresses the member row's RECORDED lifecycle, never the alias's current
   *  occupant), idempotent via `Nats-Msg-Id` (`<msgId>:<principal>:<lifecycleUid>`) so a catch-up copy
   *  and a racing fan-out copy collapse, from the same row or from two rows that both cover the post.
   *  The `principal` is the member's owner+actor dot-form. */
  async publishDinbox(principal: string, lifecycleUid: string, entry: Plane3Entry): Promise<void> {
    if (!this.js) return;
    const p = parsePrincipalKey(principal);
    if (!p) throw new Error(`publishDinbox: "${principal}" is not a valid member principal <owner>.<actor>`);
    await this.js.publish(dinboxSubject(this.space, p.owner, p.actor, lifecycleUid), JSON.stringify(entry), {
      // JetStream dedupe is STREAM-WIDE, so the id must carry the LIFECYCLE too: with an alias-keyed
      // id, lifecycle A's copy would suppress a same-alias successor B's copy of the same message —
      // cross-lifecycle suppression, not dedup. It carries no row generation: two rows of one
      // lifecycle covering the post must collapse to one copy.
      ...this.plane3MsgId(entry, `${principal}:${lifecycleUid}`),
    });
  }

  /** The fan-out consumer's delivered stream-seq — the activation-fence upper bound (red-team
   *  BLOCKER-1: the shared fan-out cursor advances independently of the stream frontier). */
  private async fanoutDeliveredSeq(): Promise<number> {
    const info = await this.consumerInfo(chatStream(this.space), FANOUT_DURABLE);
    return info?.delivered?.stream_seq ?? 0;
  }

  /**
   * Privileged durable-JOIN write (v3: the delivery daemon calls this from its `ctl.delivery` handler
   * after validating channel ⊆ the caller's read ACL): capture `joinCursor`, commit a `durable-active`
   * record (CAS + generation bump), then ACTIVATION CATCH-UP idempotently copies `(joinCursor, fence]`
   * into the owner inbox where `fence = max(frontier, fanoutDelivered)` — fan-out owns `seq > fence`.
   * Idempotent against a timeout-retry (an already-activated membership no-ops). Returns `{durable:false}`
   * only when a concurrent leave or rejoin superseded the activation. Catch-up copies what the stream
   * still holds and does not judge retention: a post the history limit removed before its copy was
   * taken is outside the durable guarantee (SPEC §4), and stream state cannot show which channel a
   * removed sequence belonged to.
   *
   * Runs on the daemon (which hosts the fan-out/reader loops + the members KV), so catch-up + the
   * activation fence read are in-process — no cross-process cursor read.
   *
   * `aclFence` (the `ctl.delivery` join always sets it) re-reads the lifecycle's exact ACL row
   * immediately before the write that creates or reopens its row, and again after it. When the channel
   * is no longer within that row, the join is refused, and a row it already wrote is removed first.
   * A retirement narrows that ACL row before it reads the lifecycle's inventory (fenceLifecycleAcl),
   * so a row written too late for the inventory removes itself, whichever daemon process wrote it.
   * Without the option the write is a privileged assertion that consults no ACL.
   */
  async durableJoinFor(
    owner: string,
    channel: string,
    lifecycleUid: string,
    opts: { aclFence?: boolean } = {},
  ): Promise<{ durable: boolean; reason?: string; generation?: number }> {
    if (!this.js) throw new Error(this.notLiveMsg());
    await this.manager(); // ensure jsm — a non-consuming provisioner inits it lazily; catch-up + fence need it
    const kv = await this.membersRegistry();
    const existing = await readMember(kv, channel, owner, lifecycleUid);
    const open = existing?.record.state === "durable-active" && existing.record.leaveCursor === undefined;
    if (open && existing!.record.activated)
      return { durable: true, generation: existing!.record.generation }; // fully activated — idempotent
    // Either a NEW join (no record / a tombstone to supersede) → fresh joinCursor + bumped generation,
    // OR a retry of an INCOMPLETE activation (durable-active but not yet activated, from an earlier
    // crash or failed catch-up) → re-run catch-up over the SAME join window, no bump. The record is committed
    // `activated:false` first and routes IN-INTERVAL immediately (fan-out + reader deliver via the
    // pure-interval durableEligible) so no live message published during catch-up is lost. `activated`
    // gates only the REPORT — durableJoin returns true / channelMembers lists the owner only after the
    // catch-up confirms. A join that never completes catch-up still routes live (harmless: the agent is
    // live-subscribed and DLV is id-deduped) but honestly reports durable:false and stays hidden.
    const joinCursor = open ? existing!.record.joinCursor : await this.chatFrontier();
    const generation = open ? existing!.record.generation : (existing?.record.generation ?? 0) + 1;
    const base: MembershipRecord = {
      channel, owner, lifecycleUid, state: "durable-active", joinCursor, generation,
      activated: false, writerIdentity: this.card.id, updatedAt: Date.now(),
    };
    if (!open) {
      if (opts.aclFence && !(await this.aclAllows(owner, lifecycleUid, channel)))
        throw new Error(`durableJoin: "${channel}" is no longer within the read ACL of lifecycle ${lifecycleUid} (narrowed or retired); no membership row was written`);
      const written = await commitMemberRevision(kv, base);
      if (opts.aclFence) await this.keepRowIfAclAllows(kv, owner, lifecycleUid, channel, written.revision);
    }
    const fence = Math.max(await this.chatFrontier(), await this.fanoutDeliveredSeq());
    await this.catchupCopy(owner, lifecycleUid, channel, joinCursor, fence, generation);
    // Flip → reported durable, ATOMICALLY: refuse if a concurrent SAME-generation leave (tombstone) or a
    // rejoin superseded this pending join while catch-up ran. A blind same-gen commit would clobber the
    // tombstone (clear leaveCursor) and resurrect the membership, reopening §7 (review-general-2 BLOCKER).
    const activated = await activateMember(kv, channel, owner, lifecycleUid, generation, joinCursor);
    if (!activated)
      return { durable: false, reason: "activation superseded by a concurrent leave or rejoin", generation };
    return { durable: true, generation };
  }

  /** The post-write half of {@link durableJoinFor}'s `aclFence`: keep the row just written (at
   *  `revision`) only on proof that the lifecycle's ACL row still allows the channel, and refuse the
   *  join otherwise. When the ACL row proves the channel is no longer allowed, no row of the lifecycle
   *  on that channel is wanted, so the row goes by its exact key whoever wrote its latest revision.
   *  When the read itself fails, nothing is proven either way, so only this write is taken back: a
   *  later revision belongs to another join of the same lifecycle, which may have been authorized. */
  private async keepRowIfAclAllows(kv: KV, owner: string, lifecycleUid: string, channel: string, revision: number): Promise<void> {
    let disallowed = false;
    let why: string;
    try {
      if (await this.aclAllows(owner, lifecycleUid, channel)) return;
      disallowed = true;
      why = "was narrowed or retired while the row was written";
    } catch (e) {
      why = `could not be re-read after the row was written (${(e as Error).message})`;
    }
    const fail = (outcome: string, cause?: unknown) =>
      new Error(`durableJoin: the read ACL of lifecycle ${lifecycleUid} ${why}; ${outcome}`, cause === undefined ? undefined : { cause });
    try {
      if (disallowed) await deleteMember(kv, channel, owner, lifecycleUid);
      else await kv.purge(memberKey(channel, owner, lifecycleUid), { previousSeq: revision });
    } catch (e) {
      if (!disallowed && isCasLoss(e))
        throw fail(`a later write replaced its "${channel}" row, which was left to that write`);
      throw fail(`removing its "${channel}" row failed (${(e as Error).message})`, e);
    }
    throw fail(`its "${channel}" row was removed`);
  }

  /** Privileged durable-LEAVE write: tombstone the membership at `leaveCursor = frontier` so the
   *  backstop denies `seq > leaveCursor` while a pre-leave entry stays deliverable (SPEC §7 interval). */
  async durableLeaveFor(owner: string, channel: string, lifecycleUid: string, expectedGeneration?: number): Promise<void> {
    if (!this.deliveryPlane.plane3) return; // not a Plane-3 host — no membership to tombstone
    const kv = await this.membersRegistry();
    // expectedGeneration (captured by the agent at durableJoin) refuses a stale leave from tombstoning
    // a newer rejoin (StaleMembershipWrite) — a durable-disable primitive otherwise.
    await tombstoneMember(kv, channel, owner, lifecycleUid, await this.chatFrontier(), this.card.id, expectedGeneration);
  }}
