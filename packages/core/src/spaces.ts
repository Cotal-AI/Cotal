// listSpaces — discover the spaces present on a NATS server, with light per-space stats.
// A space materializes as JetStream streams (CHAT_/DM_/TASK_<space>) plus a presence KV bucket
// (cotal_presence_<space>); we read those names back to enumerate spaces. This works on an
// open/dev mesh — one server, every space's streams visible to a bare connection. Under auth a
// server hosts a single account/space, so this is really an open-mode admin capability.

import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { JetStreamApiCodes, JetStreamApiError, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { DEFAULT_SERVER, dialerFor } from "./endpoint.js";
import { CHANNEL_DEFAULTS_KEY, channelBucket, chatStream, isPrincipalOwnerToken, parseSubject, isTransferStream, mintLifecycleUid, isPresenceRow } from "./subjects.js";
import { decodeChannelEntry } from "./channels.js";
import { isEventChannel } from "./event-channel.js";
import { spaceDeletionStreams } from "./space-deletion-targets.js";
import { pluginChannelStream } from "./plugin-channel-route.js";
import { idFromCreds, newIdentity } from "./identity.js";
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
  channels: number; // distinct configured or retained chat channels, excluding events
  messages: number; // total chat messages
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
  const nc = await dialerFor(opts.servers ?? DEFAULT_SERVER)({
    servers: opts.servers ?? DEFAULT_SERVER,
    timeout: opts.timeoutMs ?? 2000,
    reconnect: false,
    maxReconnectAttempts: 0,
    ...scopedConnectOpts(opts.creds),
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
    for await (const name of jsm.streams.names()) {
      streamNames.add(name);
      const m = /^CHAT_(.+)$/.exec(name);
      if (m) get(m[1]);
    }

    // Presence KV per space → count agents using the roster's card kind.
    const kvm = new Kvm(nc);
    try {
      for await (const st of kvm.list()) {
        const m = /^cotal_presence_(.+)$/.exec(st.bucket);
        if (!m) continue;
        const s = get(m[1]);
        try {
          for (const entry of await lastKvEntries(await kvm.open(st.bucket))) {
            if (entry.operation !== "PUT") continue;
            try {
              const row = entry.json<unknown>();
              if (isPresenceRow(row, entry.key) && row.card.kind === "agent") s.agents++;
            } catch {
              /* skip malformed JSON without discarding other presence rows */
            }
          }
        } catch {
          /* leave agent count at 0 if this bucket can't be inspected */
        }
      }
    } catch {
      /* no KV access (restricted creds) — leave agent counts at 0 */
    }

    for (const s of bySpace.values()) {
      const chans = new Set<string>();
      const chat = chatStream(s.space);
      if (streamNames.has(chat)) {
        try {
          const info = await jsm.streams.info(chat, { subjects_filter: ">" });
          s.messages = info.state.messages;
          for (const subject of Object.keys(info.state.subjects ?? {})) {
            const p = parseSubject(subject);
            if (p?.kind === "chat" && isPrincipalOwnerToken(p.owner) && !isEventChannel(p.rest)) chans.add(p.rest);
          }
        } catch {
          /* message totals and retained channels are best-effort */
        }
      }
      const bucket = channelBucket(s.space);
      if (streamNames.has(`KV_${bucket}`)) {
        try {
          for (const entry of await lastKvEntries(await kvm.open(bucket))) {
            if (entry.operation !== "PUT" || entry.key === CHANNEL_DEFAULTS_KEY || isEventChannel(entry.key)) continue;
            try {
              decodeChannelEntry(entry);
              chans.add(entry.key);
            } catch {
              /* skip invalid channel config without discarding other channels */
            }
          }
        } catch {
          /* keep retained channels if the registry can't be inspected */
        }
      }
      s.channels = chans.size;
    }

    return [...bySpace.values()].sort((a, b) => a.space.localeCompare(b.space));
  } finally {
    await nc.close();
  }
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
