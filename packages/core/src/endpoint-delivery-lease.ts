import { randomUUID } from "node:crypto";
import type { KV } from "@nats-io/kv";
import type { NatsConnection } from "@nats-io/transport-node";
import type { AgentCard } from "./types.js";
import { openDeliveryRegistry, type DeliveryLeaseInfo } from "./lease.js";
import { leaseKey } from "./subjects.js";
import type { CotalEndpoint } from "./endpoint.js";
import { kvWatchConsumer } from "./endpoint-dial.js";

type LeaseWatch = Awaited<ReturnType<KV["watch"]>>;

/** Connection and consumer custody shared with the endpoint's other broker readers. */
export interface EndpointDeliveryLeaseDeps {
  card: () => AgentCard;
  space: () => string;
  connection: () => NatsConnection | undefined;
  epoch: () => number;
  notLiveMsg: () => string;
  deleteWatchConsumer: (iter: LeaseWatch) => Promise<void>;
  recoverable: (error: Error) => void;
  emit: (event: string, error: Error) => boolean;
}

/** Delivery lease ownership, readiness and watch intent for one endpoint instance. */
export class EndpointDeliveryLease {

  private deliveryKv?: KV;


  /** This endpoint instance's LEASE INCARNATION: which run of this principal a lease row was written
   *  by. Minted per construction and never re-derived, because the credential cannot supply it, the
   *  daemon's cred is a file on disk that every restart re-reads, so `card.id` is stable across
   *  processes by design. See {@link DeliveryLeaseInfo.incarnation}. */
  private readonly leaseIncarnation = randomUUID();


  /** When this endpoint last WON each shard's lease create. Every later write of that row carries it
   *  unchanged, while `since` is re-stamped. See {@link DeliveryLeaseInfo.acquiredAt}. */
  private readonly leaseAcquiredAt = new Map<number, number>();

  /** The daemon's lease-loss watch (#1596): the INTENT that survives a connection rebuild, plus the
   *  live iterator. See {@link watchDeliveryLease}. */
  private leaseWatchIntent?: { shardIndex: number; onEvent: (info: DeliveryLeaseInfo | undefined) => void };

  private leaseWatchIter?: Awaited<ReturnType<KV["watch"]>>;

  /** Consumer deletes of retired lease watches still in flight. The stop handle cannot await its
   *  delete, so endpoint shutdown and a live-epoch rebuild await these before they close the connection
   *  that carries them (#3966). */
  private readonly leaseWatchDeletes = new Set<Promise<void>>();

  /** Lease-watch binds still awaiting the broker. One that lands after endpoint shutdown or a rebuild
   *  moved the epoch retires its watch and starts that delete itself, so the same two paths wait for
   *  these first. Each is bounded by the JetStream request timeout. */
  private readonly leaseWatchBinds = new Set<Promise<void>>();

  constructor(private readonly deps: EndpointDeliveryLeaseDeps) {}

  private get card() { return this.deps.card(); }
  private get space() { return this.deps.space(); }
  private get nc() { return this.deps.connection(); }
  private get presenceEpoch() { return this.deps.epoch(); }
  private notLiveMsg() { return this.deps.notLiveMsg(); }
  private emitRecoverable(error: Error) { this.deps.recoverable(error); }
  private emit(event: string, error: Error) { return this.deps.emit(event, error); }

  get hasWatchIntent(): boolean { return this.leaseWatchIntent !== undefined; }
  resetConnection(): void { this.deliveryKv = undefined; }



  /** Lazily open the delivery lease/readiness KV (pre-created at `cotal up`; bind, never create). */
  private async deliveryRegistry(): Promise<KV> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    this.deliveryKv ??= await openDeliveryRegistry(this.nc, this.space);
    return this.deliveryKv;
  }


  private encodeLease(shardIndex: number, ready: boolean, acquiredAt = this.leaseAcquiredAt.get(shardIndex)): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ holder: this.card.id, incarnation: this.leaseIncarnation, acquiredAt, since: Date.now(), ready } satisfies DeliveryLeaseInfo));
  }


  /** Is this shard's lease row one THIS ENDPOINT INSTANCE wrote? The question a daemon whose renew
   *  just failed has to answer before it decides whether it still owns the shard.
   *
   *  Both halves are required. `holder` alone is not sufficient (a successor daemon re-reading the
   *  same creds file presents the same principal, so its row would read as ours), and `incarnation`
   *  alone is not sufficient either, it is a bare uuid with no claim to the principal, so a row
   *  bearing ours but a foreign holder is not something we should ever adopt. A row with NO
   *  incarnation predates the field and cannot be proven ours, which is the safe reading: it leads
   *  to the takeover path rather than to serving on someone else's claim. */
  ownsDeliveryLease(info: DeliveryLeaseInfo): boolean {
    return info.holder === this.card.id && info.incarnation !== undefined && info.incarnation === this.leaseIncarnation;
  }


  /** Acquire the single-flight delivery lease for a shard via an ATOMIC CAS create, marked NOT-ready.
   *  THROWS if a live lease exists - a loud refusal-to-bind (the daemon exits), never a retry, so two
   *  daemons can't split a durable's delivery. A crashed holder's lease auto-expires (bucket TTL),
   *  freeing a re-acquire. Acquired BEFORE binding (single-flight gate); {@link markDeliveryLeaseReady}
   *  flips it ready AFTER the loops + `ctl.delivery` are bound. Returns the lease revision. */
  async acquireDeliveryLease(shardIndex: number): Promise<number> {
    // Recorded only once the create wins: a refused create leaves the held row, and so its time, as it was.
    const acquiredAt = Date.now();
    const revision = await (await this.deliveryRegistry()).create(leaseKey(shardIndex), this.encodeLease(shardIndex, false, acquiredAt));
    this.leaseAcquiredAt.set(shardIndex, acquiredAt);
    return revision;
  }


  /** Flip the held lease to READY (CAS `kv.update`) AFTER `startPlane3` has bound the loops + the
   *  `ctl.delivery` responder - so "lease ready" proves the responder is up, not just that the slot was
   *  claimed. Returns the new revision. */
  async markDeliveryLeaseReady(shardIndex: number, revision: number): Promise<number> {
    return (await this.deliveryRegistry()).update(leaseKey(shardIndex), this.encodeLease(shardIndex, true), revision);
  }


  /** Flip the held lease back to NOT-ready, the counterpart to {@link markDeliveryLeaseReady}, for a
   *  holder that has UNBOUND its loops and control responder but has not given up the shard.
   *
   *  `ready` is a claim about the RESPONDER, not about the row's existence: `ensureDelivery` waits on
   *  it and the channel-health surface reports it. A daemon that goes quiet to re-check its ownership
   *  still holds the key, so without this the space would be told a responder is up while nothing is
   *  bound, a readiness lie of exactly the kind #1318 is about, just pointed the other way. Keeping
   *  the row (rather than deleting it) is deliberate: the shard is still claimed, so no third daemon
   *  should be invited in; what is being withdrawn is only the claim to be answering. */
  async markDeliveryLeaseNotReady(shardIndex: number, revision: number): Promise<number> {
    return (await this.deliveryRegistry()).update(leaseKey(shardIndex), this.encodeLease(shardIndex, false), revision);
  }


  /** Renew the held lease (CAS `kv.update` against `revision`, keeping `ready:true`) to refresh it before
   *  the bucket TTL expires it. Returns the new revision. Throws if the revision moved (lost the lease -
   *  the daemon should exit). */
  async renewDeliveryLease(shardIndex: number, revision: number): Promise<number> {
    return (await this.deliveryRegistry()).update(leaseKey(shardIndex), this.encodeLease(shardIndex, true), revision);
  }


  /** Release the held lease on clean shutdown so a replacement daemon re-acquires immediately (a
   *  crash just lets the bucket TTL expire it).
   *
   *  THE REVISION IS WHAT MAKES THIS A RELEASE RATHER THAN A DELETE. An unconditional delete removes
   *  whatever row is there, and by shutdown time the row is not necessarily still ours: the exit
   *  paths that matter most are precisely the ones where another daemon has taken the shard, so the
   *  departing process would delete the REPLACEMENT's lease on its way out and leave the shard with
   *  no holder at all. Passing the revision this endpoint last owned makes the delete a compare-and-
   *  swap (`previousSeq` becomes JetStream's `ExpectedLastSubjectSequence`), so a row that has moved
   *  on is left alone.
   *
   *  A RELEASE THAT DID NOT COMMIT REJECTS. The broker's CAS refusal and any broker failure reach the
   *  caller, because only the caller knows whether that matters: a shutdown that must finish anyway
   *  catches it, and a close that reports whether a successor can start learns the outcome here.
   *
   *  THE ARGUMENT IS REQUIRED, AND EXPLICITLY NULLABLE RATHER THAN OPTIONAL. `undefined` means "this
   *  process no longer holds a revision it can argue for", which is the takeover paths' honest
   *  answer and correctly releases nothing, the bucket TTL is the crash-safe authority and expires
   *  a genuinely stale row. But if that were the DEFAULT, every existing `releaseDeliveryLease(0)`
   *  call site would keep compiling and silently stop releasing: the same omission hole
   *  `standaloneConnectOpts` closed by deleting its `= {}`. Measured, not theorised, this landed as
   *  a red in `smoke:delivery-lease`, where a caller that genuinely held the lease released nothing
   *  and the next acquire was refused. A caller must now say which it means. */
  async releaseDeliveryLease(shardIndex: number, revision: number | undefined): Promise<void> {
    if (revision === undefined) return;
    await (await this.deliveryRegistry()).delete(leaseKey(shardIndex), { previousSeq: revision });
  }


  /** Read a shard's delivery lease (the daemon-availability signal), or `undefined` if none is live.
   *  READ-ONLY surface - drives Component 6's `cotal_channels` delivery-health field (an agent reads it
   *  under its own cred, which holds lease-bucket read but no write). */
  async readDeliveryLease(shardIndex: number): Promise<DeliveryLeaseInfo | undefined> {
    return (await this.readDeliveryLeaseEntry(shardIndex))?.info;
  }


  /** Watch THIS shard's lease key and nothing else, for the daemon's loss trigger (#1596).
   *
   *  A KV watch is the native JetStream push for "the row changed hands NOW": a filtered ordered
   *  consumer on the lease bucket delivers the row's own writes the moment the broker applies them,
   *  instead of the daemon waiting for its next renew tick to notice. The watch is a TRIGGER, never a
   *  decision: every event is handed to `onEvent` with the row as the broker now states it (PUT) or
   *  the fact it is gone (DEL/PURGE, `info` undefined), and the caller re-runs the SAME decision tree
   *  its renew tick would (`leaseAction`, `mayServeOn`, `readOwnLease`-style ownership tests). An
   *  event the daemon itself caused (its acquire, its renew, its ready flip) is an ordinary input to
   *  that tree - the row still reads `held` by this endpoint - so it never quiesces on its own write;
   *  no event filtering happens here.
   *
   *  Like the presence watch, this survives a connection rebuild as INTENT: the iterator dies with
   *  its connection and the endpoint connection bind rebinds it onto the fresh one, so a reconnect can
   *  never leave the daemon blind to the row for the rest of its life. The rebind replays the
   *  bucket's current last-per-subject state, so a change that landed during the null window is
   *  delivered on the fresh watch. Resolves a stop handle. */
  async watchDeliveryLease(shardIndex: number, onEvent: (info: DeliveryLeaseInfo | undefined) => void): Promise<() => void> {
    this.leaseWatchIntent = { shardIndex, onEvent };
    await this.bindDeliveryLeaseWatch();
    return () => {
      if (this.leaseWatchIntent?.onEvent !== onEvent) return; // a later watch owns the slot
      this.leaseWatchIntent = undefined;
      this.stopDeliveryLeaseWatch();
    };
  }


  stopDeliveryLeaseWatch(): void {
    if (this.leaseWatchIter) this.retireDeliveryLeaseWatch(this.leaseWatchIter);
    this.leaseWatchIter = undefined;
  }


  /** Stop a lease watch and delete its ordered consumer, which the stop alone leaves on the broker
   *  until its five-minute inactive threshold (#3966). A connection that closed on its own cannot
   *  carry the delete, so that consumer is left to the threshold. A failed delete is a warning: the
   *  broker still reaps the consumer, and the daemon's synchronous stop handle has no caller to
   *  reject. */
  private retireDeliveryLeaseWatch(iter: Awaited<ReturnType<KV["watch"]>>): void {
    try { iter.stop(); } catch { /* already closed with its connection */ }
    if (!this.nc || this.nc.isClosed()) return;
    const deleting = this.deps.deleteWatchConsumer(iter).catch((e: Error) => this.emitRecoverable(
      new Error(`a retired delivery lease watch consumer was not deleted (${e.message}); the broker reaps it at its inactive threshold`),
    ));
    this.leaseWatchDeletes.add(deleting);
    void deleting.then(() => this.leaseWatchDeletes.delete(deleting));
  }


  /** Wait for the lease-watch binds still in flight, then for every retired watch's consumer delete.
   *  endpoint shutdown and a live-epoch rebuild run this before they close the connection those deletes
   *  need (#3966). */
  async settleDeliveryLeaseWatches(): Promise<void> {
    await Promise.allSettled(this.leaseWatchBinds);
    await Promise.all(this.leaseWatchDeletes);
  }


  /** Bind the lease watch on the current connection. A bind that lands after a newer watch replaced
   *  its intent, or after a stop or connection teardown moved the epoch, retires its watch instead of
   *  installing it: the epoch it was bound for is gone, and a rebuilt one binds its own. */
  bindDeliveryLeaseWatch(): Promise<void> {
    const binding = this.bindDeliveryLeaseWatchOnce();
    const settled = () => { this.leaseWatchBinds.delete(binding); };
    this.leaseWatchBinds.add(binding);
    void binding.then(settled, settled);
    return binding;
  }


  private async bindDeliveryLeaseWatchOnce(): Promise<void> {
    const intent = this.leaseWatchIntent!;
    const epoch = this.presenceEpoch;
    const iter = await (await this.deliveryRegistry()).watch({ key: leaseKey(intent.shardIndex) });
    if (this.leaseWatchIntent !== intent || epoch !== this.presenceEpoch) {
      this.retireDeliveryLeaseWatch(iter);
      return;
    }
    this.leaseWatchIter = iter;
    void (async () => {
      for await (const e of iter) {
        if (this.leaseWatchIter !== iter) break;
        if (e.operation === "DEL" || e.operation === "PURGE") { intent.onEvent(undefined); continue; }
        try { intent.onEvent(e.json<DeliveryLeaseInfo>()); } catch { intent.onEvent(undefined); }
      }
    })().catch((e) => this.emit("error", e as Error));
  }


  /** The principal recorded as holding a shard's delivery lease, read by THIS process from the row,
   *  or `undefined` when no row is live or the read failed.
   *
   *  THE POINT IS WHO ESTABLISHES THE FACT. Everything a requester learns from a request/reply rail
   *  is something a responder chose to send, and the delivery-admin rail is queue-grouped, so any
   *  process permitted to serve it decides what arrives. The lease row is the other kind of fact: a
   *  KV key whose only writer is the `delivery` credential's own `lease.*` grant, read here under
   *  THIS endpoint's credential, which no reply on any rail participates in. A caller comparing an
   *  answerer against the holder needs that, rather than the answerer's word for which one it is.
   *
   *  `undefined` is a genuine unknown and is NEVER a statement that nobody holds the shard: a read
   *  that throws (a denied or unreadable bucket, a broker that will not answer) must not collapse
   *  into "nothing is there". Callers must treat it as a failure to determine (#1694). */
  async deliveryLeaseHolder(shardIndex: number): Promise<string | undefined> {
    try { return (await this.readDeliveryLeaseEntry(shardIndex))?.info.holder; }
    catch { return undefined; }
  }


  /** The lease row AND the KV revision it is at. The revision is the CAS token every renew and the
   *  CAS release are argued against, so a caller re-establishing ownership after a failed renew
   *  needs the BROKER's sequence, not the one it last cached: a renew can fail with its write
   *  already applied (a lost reply, a reconnect mid-request), which leaves the cached revision one
   *  behind forever and every subsequent CAS refused over a sequence this process itself moved ,
   *  read as somebody else's takeover, which is the #1318 misreading in a second costume.
   *
   *  ABSENT and UNREADABLE are different facts and this method keeps them apart (#1694): `undefined`
   *  means NO row is live (no key, or DEL/PURGE), while a key that EXISTS but does not parse as a
   *  {@link DeliveryLeaseInfo} THROWS. Folding the parse failure into `undefined` made a live-but-
   *  corrupt row read as "nothing there", and the store-identity challenge's absence settlement
   *  then certified a remint over a row it could not read. A caller that wants the old swallow
   *  (an owner testing "is this provably MINE") still gets its safe answer: an unparseable row is
   *  not provably anyone's, and catching here reads as `false` exactly as before. */
  async readDeliveryLeaseEntry(shardIndex: number): Promise<{ info: DeliveryLeaseInfo; revision: number } | undefined> {
    const e = await (await this.deliveryRegistry()).get(leaseKey(shardIndex));
    if (!e || e.operation === "DEL" || e.operation === "PURGE") return undefined;
    try { return { info: e.json<DeliveryLeaseInfo>(), revision: e.revision }; }
    catch (err) { throw new Error(`delivery lease row "${leaseKey(shardIndex)}" exists but does not parse as a lease record (${(err as Error).message}) - it is unreadable, not absent`); }
  }
}

/** The deps of one endpoint's {@link EndpointDeliveryLease}. Every value is read from `ep` when it is used, so a field
 *  assigned after construction is seen, and a member a caller replaced on the endpoint is the one that runs. */
export function endpointDeliveryLeaseDeps(ep: CotalEndpoint): EndpointDeliveryLeaseDeps {
  return {
    card: () => ep["card"],
    space: () => ep["space"],
    connection: () => ep["nc"],
    epoch: () => ep["presenceEpoch"],
    notLiveMsg: () => ep["notLiveMsg"](),
    deleteWatchConsumer: (iter) => ep["deleteOwnConsumer"](kvWatchConsumer(iter)),
    recoverable: (error) => ep["emitRecoverable"](error),
    emit: (event, error) => ep["emit"](event, error),
  };
}
