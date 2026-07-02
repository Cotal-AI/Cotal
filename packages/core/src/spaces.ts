// listSpaces — discover the spaces present on a NATS server, with light per-space stats.
// A space materializes as JetStream streams (CHAT_/DM_/TASK_<space>) plus a presence KV bucket
// (cotal_presence_<space>); we read those names back to enumerate spaces. This works on an
// open/dev mesh — one server, every space's streams visible to a bare connection. Under auth a
// server hosts a single account/space, so this is really an open-mode admin capability.

import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { DEFAULT_SERVER } from "./endpoint.js";
import {
  parseSubject, chatStream, dmStream, taskStream, inboxStream, dlvStream,
  presenceBucket, channelBucket, membersBucket, aclBucket, membershipBucket,
  deliveryBucket, managerBucket,
} from "./subjects.js";
import { idFromCreds } from "./identity.js";

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
  agents: number; // presence KV entries (≈ agents currently present)
  channels: number; // distinct chat channels with backlog
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
  const nc = await connect({
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

    // Chat stream per space → message total + channel count (same subject-breakdown parse as
    // endpoint.listChannels()).
    for await (const name of jsm.streams.names()) {
      const m = /^CHAT_(.+)$/.exec(name);
      if (!m) continue;
      const s = get(m[1]);
      try {
        const info = await jsm.streams.info(name, { subjects_filter: ">" });
        s.messages = info.state.messages;
        const chans = new Set<string>();
        for (const subject of Object.keys(info.state.subjects ?? {})) {
          const p = parseSubject(subject);
          if (p?.kind === "chat") chans.add(p.rest);
        }
        s.channels = chans.size;
      } catch {
        /* leave stats at 0 if the stream can't be inspected */
      }
    }

    // Presence KV per space → agents present.
    try {
      for await (const st of new Kvm(nc).list()) {
        const m = /^cotal_presence_(.+)$/.exec(st.bucket);
        if (m) get(m[1]).agents = st.values;
      }
    } catch {
      /* no KV access (restricted creds) — leave agent counts at 0 */
    }

    return [...bySpace.values()].sort((a, b) => a.space.localeCompare(b.space));
  } finally {
    await nc.close();
  }
}

/** Tear down a space — delete its chat/DM/task streams plus the presence and channel-registry KV
 *  buckets. Irreversible; all history, presence, and channel config for the space is gone. Open
 *  mode, or a cred allowing STREAM.DELETE. Not-found streams are ignored (idempotent). */
export async function deleteSpace(opts: { servers?: string; creds?: string; space: string }): Promise<void> {
  const nc = await connect({
    servers: opts.servers ?? DEFAULT_SERVER,
    reconnect: false,
    maxReconnectAttempts: 0,
    ...scopedConnectOpts(opts.creds),
  });
  try {
    const jsm = await jetstreamManager(nc);
    // Delete EVERY stream + KV bucket `setupSpaceStreams` creates — otherwise `down` leaves the DLV/INBOX
    // streams and the members/acl/membership/delivery/manager buckets orphaned (a space leak), and since
    // `teardown` is the sole STREAM.DELETE holder, nothing else could ever reap them. Best-effort.
    const streams = [
      chatStream(opts.space),
      dmStream(opts.space),
      taskStream(opts.space),
      inboxStream(opts.space),
      dlvStream(opts.space),
      `KV_${presenceBucket(opts.space)}`,
      `KV_${channelBucket(opts.space)}`,
      `KV_${membersBucket(opts.space)}`,
      `KV_${aclBucket(opts.space)}`,
      `KV_${membershipBucket(opts.space)}`,
      `KV_${deliveryBucket(opts.space)}`,
      `KV_${managerBucket(opts.space)}`,
    ];
    for (const s of streams) await jsm.streams.delete(s).catch(() => {});
  } finally {
    await nc.close();
  }
}
