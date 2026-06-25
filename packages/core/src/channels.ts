/**
 * Channel registry — the read/write helpers over the per-space channels KV bucket.
 *
 * The bucket holds one {@link ChannelConfig} per channel (key = the concrete channel token)
 * plus the space-wide defaults under {@link CHANNEL_DEFAULTS_KEY}. Writes are **privileged**
 * (manager / `cotal up` / `cotal channels`); agents read it (the live cache lives on the
 * endpoint). Because description/instructions reach the model, both text fields are bounded
 * here and oversize is **rejected at the write path** — never silently truncated.
 */
import { Kvm, type KV } from "@nats-io/kv";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { channelBucket, CHANNEL_DEFAULTS_KEY } from "./subjects.js";
import type { ChannelConfig, ChannelDefaults, DeliveryClass } from "./types.js";

/** The declarative channel-config file read at `cotal up` to seed the registry. */
export interface ChannelRegistryFile {
  defaults?: ChannelDefaults;
  /** Map of channel token → its config. */
  channels?: Record<string, ChannelConfig>;
}

/** Length caps on the model-facing registry text — unbounded text would stuff every agent's
 *  context and bloat the KV, so a write past these throws rather than clamps. */
export const MAX_CHANNEL_DESCRIPTION = 200;
export const MAX_CHANNEL_INSTRUCTIONS = 2000;

/** Throw if a config is invalid: oversize text (rejected, never clamped — a write past the cap
 *  is a caller bug) or an unparseable `replayWindow`. */
export function validateChannelConfig(cfg: ChannelConfig): void {
  if (cfg.description !== undefined && cfg.description.length > MAX_CHANNEL_DESCRIPTION)
    throw new Error(
      `channel description too long (${cfg.description.length} > ${MAX_CHANNEL_DESCRIPTION} chars)`,
    );
  if (cfg.instructions !== undefined && cfg.instructions.length > MAX_CHANNEL_INSTRUCTIONS)
    throw new Error(
      `channel instructions too long (${cfg.instructions.length} > ${MAX_CHANNEL_INSTRUCTIONS} chars)`,
    );
  if (cfg.replayWindow !== undefined) parseDuration(cfg.replayWindow); // throws if unparseable
  if (
    cfg.deliveryClass !== undefined &&
    cfg.deliveryClass !== "live" &&
    cfg.deliveryClass !== "durable"
  )
    throw new Error(`invalid deliveryClass "${cfg.deliveryClass}" — expected "live" or "durable"`);
}

/** Validate a defaults patch the same way per-channel config is — the space default feeds
 *  {@link effectiveDeliveryClass} as a co-equal input, so a bad value must fail loud here, not
 *  silently become the space-wide effective class. */
export function validateChannelDefaults(d: ChannelDefaults): void {
  if (d.replayWindow !== undefined) parseDuration(d.replayWindow); // throws if unparseable
  if (d.deliveryClass !== undefined && d.deliveryClass !== "live" && d.deliveryClass !== "durable")
    throw new Error(`invalid deliveryClass "${d.deliveryClass}" — expected "live" or "durable"`);
}

/** Parse a duration like `"24h"`, `"30m"`, `"7d"`, `"90s"` into milliseconds. Throws on a bad
 *  format — a typo'd window must fail loud, not silently mean "no window". */
export function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`invalid duration "${s}" — expected <number><s|m|h|d>, e.g. "24h"`);
  const n = Number(m[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return n * unit;
}

/** Effective replay-on-join policy for a channel: per-channel override ?? space default ??
 *  `true`. Default-true preserves Cotal's original always-replay behavior. */
export function effectiveReplay(
  cfg: ChannelConfig | undefined,
  defaults: ChannelDefaults | undefined,
): boolean {
  return cfg?.replay ?? defaults?.replay ?? true;
}

/** Effective backfill window in ms (per-channel ?? space default), or undefined for "the full
 *  retained window". Only meaningful when {@link effectiveReplay} is true. */
export function effectiveReplayWindowMs(
  cfg: ChannelConfig | undefined,
  defaults: ChannelDefaults | undefined,
): number | undefined {
  const w = cfg?.replayWindow ?? defaults?.replayWindow;
  return w === undefined ? undefined : parseDuration(w);
}

/** Effective delivery class for a channel (SPEC §4): per-channel override ?? space default ??
 *  `"durable"`. Default-durable keeps persistence on when a space declares no default — the safe
 *  fallback; a space sets `defaults.deliveryClass` at creation per deployment profile. The SAME
 *  resolution MUST drive live join, durable fan-out, history read, and membership surfacing, so
 *  every path agrees on a channel's class. */
export function effectiveDeliveryClass(
  cfg: ChannelConfig | undefined,
  defaults: ChannelDefaults | undefined,
): DeliveryClass {
  return cfg?.deliveryClass ?? defaults?.deliveryClass ?? "durable";
}

/** Open the channels registry bucket. Auth mode (creds present) OPENs the bucket pre-created
 *  at `cotal up`; open dev mode lazily CREATEs it. Mirrors the presence-bucket open/create
 *  split (and, like presence, agents are denied KV stream-create so they must OPEN). */
export async function openChannelRegistry(
  nc: NatsConnection,
  space: string,
  opts: { create?: boolean } = {},
): Promise<KV> {
  const kvm = new Kvm(nc);
  return opts.create ? kvm.create(channelBucket(space)) : kvm.open(channelBucket(space));
}

/** Read one channel's config (or undefined if unset/deleted). */
export async function readChannelConfig(
  kv: KV,
  channel: string,
): Promise<ChannelConfig | undefined> {
  return decode<ChannelConfig>(kv, channel);
}

/** Read the space-wide defaults (or undefined if unset). */
export async function readChannelDefaults(kv: KV): Promise<ChannelDefaults | undefined> {
  return decode<ChannelDefaults>(kv, CHANNEL_DEFAULTS_KEY);
}

/** Privileged write of a channel's config. **Merges** over any existing entry so a partial
 *  set (e.g. `--desc` only) doesn't wipe `replay`. Validated before the put. */
export async function writeChannelConfig(
  kv: KV,
  channel: string,
  patch: ChannelConfig,
): Promise<void> {
  validateChannelConfig(patch);
  const merged: ChannelConfig = { ...(await readChannelConfig(kv, channel)), ...patch };
  await kv.put(channel, JSON.stringify(merged));
}

/** Privileged write of the space-wide defaults (merged over any existing). Validated before the
 *  put — a bad default would otherwise feed {@link effectiveDeliveryClass} silently. */
export async function writeChannelDefaults(kv: KV, patch: ChannelDefaults): Promise<void> {
  validateChannelDefaults(patch);
  const merged: ChannelDefaults = { ...(await readChannelDefaults(kv)), ...patch };
  await kv.put(CHANNEL_DEFAULTS_KEY, JSON.stringify(merged));
}

async function decode<T>(kv: KV, key: string): Promise<T | undefined> {
  const e = await kv.get(key);
  if (!e || e.operation === "DEL" || e.operation === "PURGE") return undefined;
  try {
    return e.json<T>();
  } catch {
    return undefined;
  }
}

/** Connect (with the given privileged creds, or open if none), seed the registry from a
 *  declarative {@link ChannelRegistryFile} (defaults + per-channel config, merged), disconnect.
 *  Used by `cotal up` to seed once at setup, and by `cotal channels` for runtime writes.
 *  Each field in the file overwrites that field in the registry; unspecified fields are kept. */
export async function seedChannelRegistry(opts: {
  servers: string;
  space: string;
  creds?: string;
  file: ChannelRegistryFile;
}): Promise<void> {
  const nc = await connect({
    servers: opts.servers,
    ...(opts.creds
      ? { authenticator: credsAuthenticator(new TextEncoder().encode(opts.creds)) }
      : {}),
  });
  try {
    // The seed path is privileged (manager creds or open) so it may CREATE the bucket — this
    // makes `cotal channels` work on a space whose bucket wasn't pre-created (e.g. one set up
    // before this feature). Idempotent when `cotal up` already created it.
    const kv = await openChannelRegistry(nc, opts.space, { create: true });
    if (opts.file.defaults) await writeChannelDefaults(kv, opts.file.defaults);
    for (const [channel, cfg] of Object.entries(opts.file.channels ?? {}))
      await writeChannelConfig(kv, channel, cfg);
  } finally {
    await nc.drain();
  }
}

/** Connect (privileged/open), delete the given channel-registry keys, disconnect. Used by
 *  `cotal down -f` to remove ONLY the cards a `spawn -f` run created (ownership-scoped); the caller is
 *  responsible for the members-present safety check. The bucket must already exist (no create on a
 *  delete path); a key that's already absent is a no-op. The space-wide defaults key is never a
 *  channel name, so it can't be removed here. */
export async function deleteChannels(opts: {
  servers: string;
  space: string;
  creds?: string;
  channels: string[];
}): Promise<void> {
  const nc = await connect({
    servers: opts.servers,
    ...(opts.creds ? { authenticator: credsAuthenticator(new TextEncoder().encode(opts.creds)) } : {}),
  });
  try {
    const kv = await openChannelRegistry(nc, opts.space, { create: false });
    for (const channel of opts.channels) await kv.delete(channel);
  } finally {
    await nc.drain();
  }
}

/** Connect, read the whole registry (defaults + every channel entry) into a
 *  {@link ChannelRegistryFile}, disconnect. The read side of {@link seedChannelRegistry},
 *  used by `cotal channels list`. */
export async function readChannelRegistry(opts: {
  servers: string;
  space: string;
  creds?: string;
}): Promise<ChannelRegistryFile> {
  const nc = await connect({
    servers: opts.servers,
    ...(opts.creds
      ? { authenticator: credsAuthenticator(new TextEncoder().encode(opts.creds)) }
      : {}),
  });
  try {
    const kv = await openChannelRegistry(nc, opts.space, { create: true });
    const channels: Record<string, ChannelConfig> = {};
    let defaults: ChannelDefaults | undefined;
    for await (const key of await kv.keys()) {
      if (key === CHANNEL_DEFAULTS_KEY) {
        defaults = await readChannelDefaults(kv);
        continue;
      }
      const cfg = await readChannelConfig(kv, key);
      if (cfg) channels[key] = cfg;
    }
    return { defaults, channels };
  } finally {
    await nc.drain();
  }
}
