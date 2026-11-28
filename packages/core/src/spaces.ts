// listSpaces — discover the spaces present on a NATS server, with light per-space stats.
// A space materializes as JetStream streams (CHAT_/DM_/TASK_<space>) plus a presence KV bucket
// (cotal_presence_<space>); we read those names back to enumerate spaces. This works on an
// open/dev mesh — one server, every space's streams visible to a bare connection. Scoped signed
// viewers can instead verify the space named by their own CHAT metadata grant.

import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { JetStreamApiCodes, JetStreamApiError, jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { DEFAULT_SERVER, dialerFor } from "./endpoint.js";
import { CHANNEL_DEFAULTS_KEY, channelBucket, chatStream, isPrincipalOwnerToken, parseSubject, isTransferStream, mintLifecycleUid, isPresenceRow, presenceBucket, token } from "./subjects.js";
import { decodeChannelEntry } from "./channels.js";
import { admittedPluginReadChannels, isRoutedPluginChannel } from "./endpoint-channel-route.js";
import { isEventChannel } from "./event-channel.js";
import { importNativeSubjectPermissions, type IssuedSubjectPermissions } from "./issued-authority.js";
import { isPermissionDenied } from "./permission-denied.js";
import { readPluginChannelRouteProjection } from "./plugin-channel-projection.js";
import { spaceDeletionStreams } from "./space-deletion-targets.js";
import { pluginChannelStream } from "./plugin-channel-route.js";
import { credsClaims, idFromCreds, newIdentity } from "./identity.js";
import { mintCreds, type SpaceAuth } from "./provision.js";
import { lastKvEntries } from "./kv-scan.js";

/** Connect opts for a possibly-scoped cred: an authenticator plus the per-id `inboxPrefix` a scoped
 *  cred needs (its `sub.allow` is `_INBOX_<id>.>`, so JS API replies must land there, not the default
 *  `_INBOX.<nuid>`). Bare/open mode → default inbox. Mirrors `streams.ts authConnectOpts`. */
function scopedConnectOpts(creds?: string): Record<string, unknown> {
  if (!creds) return {};
  return {
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${idFromCreds(creds)}`,
  };
}

/** One row of the space overview. */
export interface SpaceInfo {
  space: string;
  agents: number; // agent presence records, excluding endpoints
  channels: number; // distinct visible channels, excluding events
  /** Retained CHAT messages. Reserved plugin names count only when routing is known to be legacy. */
  messages: number;
}

export interface ListSpacesOptions {
  servers?: string;
  creds?: string;
  timeoutMs?: number;
}

/** Enumerate spaces by reading back the per-space chat streams + presence buckets. Opens a
 *  short-lived connection (bare, or with `creds`) and closes it. Per-space stats are best-effort:
 *  a stream/bucket that can't be inspected just leaves its counts at 0. */
export async function listSpaces(opts: ListSpacesOptions = {}): Promise<SpaceInfo[]> {
  const creds = opts.creds;
  const nc = await dialerFor(opts.servers ?? DEFAULT_SERVER)({
    servers: opts.servers ?? DEFAULT_SERVER,
    timeout: opts.timeoutMs ?? 2000,
    reconnect: false,
    maxReconnectAttempts: 0,
    ...scopedConnectOpts(creds),
  });
  try {
    const jsm = await jetstreamManager(nc);
    const bySpace = new Map<string, SpaceInfo>();
    const get = (space: string): SpaceInfo => {
      let s = bySpace.get(space);
      if (!s) bySpace.set(space, (s = { space, agents: 0, channels: 0, messages: 0 }));
      return s;
    };

    const streamNames = new Set<string>();
    // scopedConnectOpts presents this exact static credential, and reconnect is disabled. Decode
    // it only after the broker accepts the connection, never as evidence of the space's mode.
    const permissions = creds ? spaceViewerPermissions(creds) : undefined;
    try {
      for await (const name of jsm.streams.names()) {
        streamNames.add(name);
        const m = /^CHAT_(.+)$/.exec(name);
        if (m) get(m[1]);
      }
    } catch (error) {
      if (!isPermissionDenied(error) || !permissions) throw error;
      const scoped = await listScopedEnabledSpaces(nc, jsm, permissions);
      if (scoped.length === 0) throw error;
      return scoped;
    }

    // Presence KV per space → count agents using the roster's card kind.
    const kvm = new Kvm(nc);
    try {
      for await (const st of kvm.list()) {
        const m = /^cotal_presence_(.+)$/.exec(st.bucket);
        if (!m) continue;
        const s = get(m[1]);
        s.agents = await countSpaceAgents(kvm, st.bucket);
      }
    } catch {
      /* no KV access (restricted creds) — leave agent counts at 0 */
    }

    for (const s of bySpace.values()) {
      const registryPresent = streamNames.has(`KV_${channelBucket(s.space)}`);
      const mode = creds && registryPresent ? await spaceViewerMode(nc, s.space) : "legacy";
      const chans = new Set<string>();
      const chat = chatStream(s.space);
      if (streamNames.has(chat)) {
        try {
          const info = await jsm.streams.info(chat, { subjects_filter: ">" });
          s.messages = countChatChannels(info.state, chans, mode);
        } catch {
          /* message totals and retained channels are best-effort */
        }
      }
      if (registryPresent) await addConfiguredChannels(kvm, s.space, chans, mode);
      if (mode === "isolated" && permissions)
        for (const channel of admittedPluginReadChannels(s.space, permissions)) chans.add(channel);
      s.channels = chans.size;
    }

    return [...bySpace.values()].sort((a, b) => a.space.localeCompare(b.space));
  } finally {
    await nc.close();
  }
}

type SpaceViewerMode = "legacy" | "isolated" | undefined;

function spaceViewerPermissions(creds: string): IssuedSubjectPermissions | undefined {
  try {
    const nats = credsClaims(creds).nats;
    if (nats?.sub !== undefined)
      return importNativeSubjectPermissions({ ...(nats.pub === undefined ? {} : { pub: nats.pub }), sub: nats.sub });
  } catch { /* unrecognized permission claims do not supply plugin rows */ }
  return undefined;
}

async function spaceViewerMode(nc: NatsConnection, space: string): Promise<SpaceViewerMode> {
  try { return (await readPluginChannelRouteProjection(nc, space)).enabled ? "isolated" : "legacy"; }
  catch { return undefined; }
}

function countChatChannels(state: { messages: number; subjects?: Record<string, number> }, channels: Set<string>, mode: SpaceViewerMode): number {
  let ordinaryMessages = 0;
  for (const [subject, count] of Object.entries(state.subjects ?? {})) {
    const parsed = parseSubject(subject);
    if (parsed?.kind !== "chat" || (mode !== "legacy" && isRoutedPluginChannel(true, parsed.rest))) continue;
    ordinaryMessages += count;
    if (isPrincipalOwnerToken(parsed.owner) && !isEventChannel(parsed.rest)) channels.add(parsed.rest);
  }
  return mode === "legacy" ? state.messages : ordinaryMessages;
}

async function addConfiguredChannels(kvm: Kvm, space: string, channels: Set<string>, mode: SpaceViewerMode): Promise<void> {
  try {
    for (const entry of await lastKvEntries(await kvm.open(channelBucket(space)))) {
      if (entry.operation !== "PUT" || entry.key === CHANNEL_DEFAULTS_KEY || isEventChannel(entry.key) ||
          (mode !== "legacy" && isRoutedPluginChannel(true, entry.key))) continue;
      try { decodeChannelEntry(entry); channels.add(entry.key); }
      catch { /* skip invalid config without discarding other channels */ }
    }
  } catch { /* the credential may see retained CHAT but not the registry */ }
}

async function countSpaceAgents(kvm: Kvm, bucket: string): Promise<number> {
  let agents = 0;
  try {
    for (const entry of await lastKvEntries(await kvm.open(bucket))) {
      if (entry.operation !== "PUT") continue;
      try {
        const row = entry.json<unknown>();
        if (isPresenceRow(row, entry.key) && row.card.kind === "agent") agents++;
      } catch { /* skip malformed presence */ }
    }
  } catch { /* not all viewers can inspect presence */ }
  return agents;
}

async function listScopedEnabledSpaces(nc: NatsConnection, jsm: JetStreamManager, permissions: IssuedSubjectPermissions): Promise<SpaceInfo[]> {
  if (permissions.publish.allow.mode !== "patterns") return [];
  const prefix = `$JS.API.STREAM.INFO.${chatStream("").slice(0, -1)}`;
  const kvm = new Kvm(nc);
  const rows: SpaceInfo[] = [];
  for (const grant of permissions.publish.allow.patterns) {
    if (!grant.startsWith(prefix)) continue;
    const space = grant.slice(prefix.length);
    if (!space || token(space) !== space || await spaceViewerMode(nc, space) !== "isolated") continue;
    // The scope hint is not a grant: this read must succeed on the same admitted wire before
    // naming a space, and plugin counts never inspect EXT or the names it retains.
    const state = (await jsm.streams.info(chatStream(space), { subjects_filter: ">" })).state;
    const channels = new Set(admittedPluginReadChannels(space, permissions));
    const messages = countChatChannels(state, channels, "isolated");
    await addConfiguredChannels(kvm, space, channels, "isolated");
    const agents = await countSpaceAgents(kvm, presenceBucket(space));
    rows.push({ space, agents, channels: channels.size, messages });
  }
  return rows.sort((a, b) => a.space.localeCompare(b.space));
}

async function listTransferStreams(nc: NatsConnection, space: string): Promise<string[]> {
  const names: string[] = [];
  const pluginHistory = pluginChannelStream(space);
  for await (const name of (await jetstreamManager(nc)).streams.names())
    if (isTransferStream(space, name) || name === pluginHistory) names.push(name);
  return names;
}

async function withSpaceConnection<T>(servers: string | undefined, creds: string | undefined, fn: (nc: NatsConnection) => Promise<T>): Promise<T> {
  const nc = await dialerFor(servers ?? DEFAULT_SERVER)({
    servers: servers ?? DEFAULT_SERVER,
    reconnect: false,
    maxReconnectAttempts: 0,
    ...scopedConnectOpts(creds),
  });
  try {
    return await fn(nc);
  } finally {
    await nc.close();
  }
}

const mintTeardown = (auth: SpaceAuth, transferStreams: string[]): Promise<string> =>
  mintCreds(auth, newIdentity(), "teardown", { lifecycleUid: mintLifecycleUid(), transferStreams });

/** Tear down a space — delete its chat/DM/task streams plus the presence and channel-registry KV
 *  buckets. Irreversible; all history, presence, and channel config for the space is gone. Open
 *  mode, a `creds` whose grants cover every delete, or the space's trust material (`auth`), from
 *  which it mints its own `teardown`. Not-found streams are ignored (idempotent); any other refusal
 *  throws, naming every stream that survived. */
export async function deleteSpace(opts: { servers?: string; creds?: string; auth?: SpaceAuth; space: string }): Promise<void> {
  if (opts.auth && opts.creds !== undefined) throw new Error("deleteSpace: pass creds or auth, not both");
  if (opts.auth && opts.auth.space !== opts.space) throw new Error(`deleteSpace: the trust material is for ${opts.auth.space}, not ${opts.space}`);
  // A teardown grant names each transfer stream it may delete, and those names are found only by
  // listing the space's streams, so trust material mints one teardown to list them and a second
  // that names them.
  const creds = opts.auth
    ? await mintTeardown(opts.auth, await withSpaceConnection(opts.servers, await mintTeardown(opts.auth, []), (nc) => listTransferStreams(nc, opts.space)))
    : opts.creds;
  await withSpaceConnection(opts.servers, creds, async (nc) => {
    const jsm = await jetstreamManager(nc);
    // Delete EVERY stream + KV bucket `setupSpaceStreams` creates — otherwise `down` leaves the DLV/INBOX
    // streams and the members/acl/membership/delivery/manager buckets orphaned (a space leak), and since
    // `teardown` is the only STREAM.DELETE holder for every one of them, nothing else could ever reap them.
    // The same closed target list mints teardown's exact grants. Transfer streams are enumerated
    // under this account and filtered to this space, never inferred from a prefix alone.
    const streams = spaceDeletionStreams(opts.space, await listTransferStreams(nc, opts.space));
    const survived: string[] = [];
    for (const s of streams)
      await jsm.streams.delete(s).catch((e: unknown) => {
        if (!(e instanceof JetStreamApiError && e.code === JetStreamApiCodes.StreamNotFound)) survived.push(`${s} (${(e as Error).message})`);
      });
    if (survived.length) throw new Error(`deleteSpace: ${opts.space} kept ${survived.length} of ${streams.length} streams: ${survived.join(", ")}`);
  });
}
