// The channel discovery region of CotalEndpoint (the channel registry cache, its replay and
// delivery-class lookups, and the registry watch or read that fills it), as an internal component.
// Moved verbatim from endpoint.ts; the endpoint keeps the public methods and forwards to them. Not
// re-exported by the index.
import type { ChannelRegistryState } from "./endpoint-channel-registry-state.js";
import type { ConnectionState } from "./endpoint-connection-state.js";
import type { EndpointIdentity } from "./endpoint-identity.js";
import type { EndpointParts } from "./endpoint-parts.js";
import { JetStreamApiCodes } from "@nats-io/jetstream";
import type { KvEntry } from "@nats-io/kv";
import {
  openChannelRegistry,
  effectiveReplay,
  effectiveDeliveryClass,
  readChannelConfig,
  readChannelDefaults,
  decodeChannelEntry,
} from "./channels.js";
import { isPublishPermissionDenied } from "./endpoint-dial.js";
import { isJetStreamMissing } from "./jetstream-missing.js";
import { lastKvEntries } from "./kv-scan.js";
import { CHANNEL_DEFAULTS_KEY, channelBucket, isConcreteChannel } from "./subjects.js";
import type { ChannelConfig, ChannelDefaults, DeliveryClass } from "./types.js";

/** What the channel discovery component reads from its endpoint. State is read when it is used,
 *  never copied, and every method is looked up on the endpoint at call time. */
export interface EndpointChannelDiscoveryDeps {
  notLiveMsg: () => string;
  emitRecoverable: (err: Error) => void;
  emit: (event: string, ...args: unknown[]) => boolean;
}

/** One endpoint's view of the channel registry: the on-demand read, the cache lookups and the
 *  replay and delivery-class policy they answer, and the registry watch or one-shot read that keeps
 *  the cache. Internal: `CotalEndpoint` keeps the public methods and forwards to it. */
export class EndpointChannelDiscovery {
  constructor(private readonly identity: Readonly<EndpointIdentity>, private readonly conn: ConnectionState, private readonly channelRegistry: ChannelRegistryState, private readonly deps: EndpointChannelDiscoveryDeps, private readonly parts: Pick<EndpointParts, "connection">) {}

  private notLiveMsg() { return this.deps.notLiveMsg(); }
  private emitRecoverable(err: Error) { this.deps.emitRecoverable(err); }
  private emit(event: string, ...args: unknown[]) { return this.deps.emit(event, ...args); }

  /** A consumer that reads presence on demand reads the channel registry on demand too: it holds no
   *  watch on either, so a seat binds no consumer per member on these buckets (SPEC §6, §7). */
  get readsChannelsOnDemand(): boolean {
    return this.identity.doConsume && this.identity.doWatchChannels && !this.identity.doWatch;
  }

  /**
   * Read the channel registry from the broker now, for a consumer that reads presence on demand. One
   * batched Direct Get that binds no consumer, decoded as the watch decodes; the result replaces the
   * cache, so an entry removed since the last read is gone. {@link listChannels} and a join or leave
   * read through here first; other cache readers see the last read.
   *
   * Calls made while a read is in flight share it, and every other call reads anew. A failed read
   * throws and changes nothing. A credential that may not make the read is refused with the grant it lacks.
   */
  async readChannels(): Promise<void> {
    if (!this.readsChannelsOnDemand)
      throw new Error("readChannels is for a consumer that reads presence on demand; this endpoint watches the channel registry or keeps no cache of it");
    const kv = this.conn.channelKv;
    if (!kv) throw new Error(this.notLiveMsg());
    if (this.channelRegistry.channelRead) return this.channelRegistry.channelRead;
    const generation = ++this.channelRegistry.channelReadGeneration;
    const read = (async () => {
      let entries: KvEntry[];
      try {
        entries = await lastKvEntries(kv);
      } catch (e) {
        if (!isPublishPermissionDenied(e)) throw e;
        throw new Error(
          `channel registry read refused for ${this.identity.card.id}: this credential may not publish $JS.API.DIRECT.GET.KV_${channelBucket(this.identity.space)}, the on-demand registry read (SPEC Appendix B). A credential minted by an older issuer can lack this grant even when newly minted; upgrade the manager or auth service that issues credentials, then mint a new credential. Reusing credentials or reconnecting does not add the grant.`,
          { cause: e },
        );
      }
      if (generation <= this.channelRegistry.channelReadApplied) return;
      this.channelRegistry.channelReadApplied = generation;
      this.channelRegistry.channelConfigs.clear();
      this.channelRegistry.channelDefaults = {};
      for (const e of entries) this.handleChannelEntry(e);
    })();
    this.channelRegistry.channelRead = read;
    const settled = () => { if (this.channelRegistry.channelRead === read) this.channelRegistry.channelRead = undefined; };
    read.then(settled, settled);
    return read;
  }

  /** This channel's registry config from the local cache (undefined if unset). */
  getChannelConfig(channel: string): ChannelConfig | undefined {
    return this.channelRegistry.channelConfigs.get(channel);
  }

  /** Effective replay-on-join policy for a channel: per-channel override ?? space default ??
   *  true. Reads the live cache, so it reflects runtime registry edits. */
  channelReplay(channel: string): boolean {
    return effectiveReplay(this.channelRegistry.channelConfigs.get(channel), this.channelRegistry.channelDefaults);
  }

  /** Effective replay window for a channel (per-channel override ?? space default), or undefined
   * for the full retained window. Only meaningful when {@link channelReplay} is true. */
  channelReplayWindow(channel: string): string | undefined {
    return this.channelRegistry.channelConfigs.get(channel)?.replayWindow ?? this.channelRegistry.channelDefaults.replayWindow;
  }

  /** A channel's effective replay policy read straight from the registry bucket, for a caller that
   *  reads it right after start, before any watch cache has caught up, or that watches nothing. A
   *  wildcard reads the space defaults only. A space with no registry bucket has the built-in policy.
   *  `registered` says whether the channel has its own registry entry. */
  async channelReplayPolicy(channel: string): Promise<{ replay: boolean; window: string | null; registered: boolean }> {
    if (!this.conn.nc) throw new Error(this.notLiveMsg());
    const kv = this.conn.channelKv ?? (await openChannelRegistry(this.conn.nc, this.identity.space, { create: false }));
    let cfg: ChannelConfig | undefined;
    let defaults: ChannelDefaults | undefined;
    try {
      [cfg, defaults] = await Promise.all([
        isConcreteChannel(channel) ? readChannelConfig(kv, channel) : Promise.resolve(undefined),
        readChannelDefaults(kv),
      ]);
    } catch (e) {
      // `open` binds lazily, so a space with no registry bucket surfaces on the first read.
      if (!isJetStreamMissing(e, JetStreamApiCodes.StreamNotFound)) throw e;
    }
    return { replay: effectiveReplay(cfg, defaults), window: cfg?.replayWindow ?? defaults?.replayWindow ?? null, registered: cfg !== undefined };
  }

  /** Effective delivery class for a channel (per-channel override ?? space default ?? "durable"),
   *  from the live watch cache — drives the non-gating delivery-health surface (only durable-class
   *  channels have a Plane-3 backstop to report on). */
  channelDeliveryClass(channel: string): DeliveryClass {
    return effectiveDeliveryClass(this.channelRegistry.channelConfigs.get(channel), this.channelRegistry.channelDefaults);
  }

  /** Watch the channel registry: replay existing keys, then stream updates, into the local
   *  cache. A failed bind throws out of connect; an entry that does not decode or validate is
   *  reported as a `warning` and dropped, so its channel resolves to the default policy. */
  async startChannelWatch(): Promise<void> {
    if (!this.conn.channelKv) return;
    const bound = await this.parts.connection.bindKvWatch(this.conn.channelKv);
    if (!bound) return;
    const { iter } = bound;
    this.conn.channelWatchIter = iter;
    void (async () => {
      for await (const e of iter) this.handleChannelEntry(e);
    })().catch((e) => this.emit("error", e as Error));
  }

  /** {@link EndpointOptions.readOnce}: fill the channel cache from one read of the registry. */
  async readChannelsOnce(): Promise<void> {
    if (!this.conn.channelKv) return;
    for (const e of await lastKvEntries(this.conn.channelKv)) this.handleChannelEntry(e);
  }

  private handleChannelEntry(e: KvEntry): void {
    // Cleared before the decode, so an entry that does not decode resolves to the default as the
    // fresh registry reads do.
    const isDefaults = e.key === CHANNEL_DEFAULTS_KEY;
    if (isDefaults) this.channelRegistry.channelDefaults = {};
    else this.channelRegistry.channelConfigs.delete(e.key);
    if (e.operation === "DEL" || e.operation === "PURGE") return;
    try {
      if (isDefaults) this.channelRegistry.channelDefaults = decodeChannelEntry(e);
      else this.channelRegistry.channelConfigs.set(e.key, decodeChannelEntry(e));
    } catch (err) {
      this.emitRecoverable(new Error(`dropped channel registry entry for key ${JSON.stringify(e.key)}: ${(err as Error).message}`));
    }
  }
}
