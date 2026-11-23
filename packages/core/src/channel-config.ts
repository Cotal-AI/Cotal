import type { KV } from "@nats-io/kv";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { JetStreamApiCodes, type JetStreamManager } from "@nats-io/jetstream";
import { assertValidChannel, channelBucket, channelConfigReplySubject, channelConfigSubject, isConcreteChannel, parsePrincipalKey, principalKey } from "./subjects.js";
import { ChannelRegistryConflict, decodeChannelEntry, validateChannelConfig, UndecodableRegistryEntry } from "./channels.js";
import { isCasLoss } from "./endpoint-records.js";
import type { ChannelConfig } from "./types.js";

/** Fields a channel administrator can replace. Space defaults and history purge are separate authority. */
export type ChannelPatch = Pick<ChannelConfig, "description" | "instructions" | "replay" | "replayWindow" | "deliveryClass">;
export type ChannelChange = { expectedRevision: number } & ({ patch: ChannelPatch; remove?: never } | { remove: true; patch?: never });
export interface ChannelState {
  revision: number;
  config?: ChannelConfig;
  writer?: string;
}

const PATCH_FIELDS = ["description", "instructions", "replay", "replayWindow", "deliveryClass"];

/** Validate untrusted tool and wire input without accepting caller-authored attribution or defaults. */
export function validateChannelChange(change: ChannelChange): void {
  if (!change || typeof change !== "object" || Array.isArray(change)
    || Object.keys(change).some((k) => !["expectedRevision", "patch", "remove"].includes(k))
    || !Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0)
    throw new Error("channel change needs a non-negative expectedRevision and only patch or remove");
  if (change.remove === true && change.patch === undefined) return;
  const patch = change.patch;
  if (change.remove !== undefined || !patch || typeof patch !== "object" || Array.isArray(patch)
    || !Object.keys(patch).length || Object.keys(patch).some((k) => !PATCH_FIELDS.includes(k)))
    throw new Error("channel change needs a nonempty configuration patch or remove: true");
  validateChannelConfig(patch);
}

/** Read the current revision even after removal. A subsequent write must still win the broker CAS. */
export async function readChannelState(kv: KV, channel: string): Promise<ChannelState> {
  const entry = await kv.get(channel);
  if (!entry) return { revision: 0 };
  if (entry.operation !== "PUT") return { revision: entry.revision };
  return channelPutState(channel, entry.revision, () => entry.json());
}

function channelPutState(channel: string, revision: number, json: () => unknown): ChannelState {
  let config: ChannelConfig;
  try { config = decodeChannelEntry({ key: channel, json }); }
  catch (e) { throw new UndecodableRegistryEntry(channel, (e as Error).message); }
  return { revision, writer: config.writer, ...(config.removed ? {} : { config }) };
}

/** Read the leader rather than a replica, using the point-read authority carried by existing agents. */
export async function readChannelStateLeader(jsm: JetStreamManager, space: string, channel: string): Promise<ChannelState> {
  const bucket = channelBucket(space);
  try {
    const entry = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${channel}` });
    if (!entry) return { revision: 0 };
    if (["DEL", "PURGE"].includes(entry.header?.get("KV-Operation") ?? "")) return { revision: entry.seq };
    return channelPutState(channel, entry.seq, () => entry.json());
  } catch (e) {
    if ((e as { code?: unknown })?.code === JetStreamApiCodes.NoMessageFound) return { revision: 0 };
    throw e;
  }
}

/** One explicit-revision write. A removal keeps an attributed tombstone, without changing messages or ACLs. */
export async function changeChannelConfig(kv: KV, channel: string, change: ChannelChange, writer: string, mayAct: () => boolean = () => true): Promise<ChannelState> {
  assertValidChannel(channel);
  if (!isConcreteChannel(channel)) throw new Error("channel change needs one concrete channel");
  validateChannelChange(change);
  if (writer !== "operator" && !parsePrincipalKey(writer)) throw new Error("invalid channel writer principal");
  const current = await readChannelState(kv, channel);
  if (current.revision !== change.expectedRevision) throw new ChannelRegistryConflict("channel revision changed; read it before retrying");
  if (change.remove && !current.config) return current;
  if (change.patch && current.config && Object.entries(change.patch).every(([key, value]) => current.config?.[key as keyof ChannelPatch] === value)) return current;
  const config: ChannelConfig = change.remove
    ? { removed: true, writer }
    : { ...current.config, ...change.patch, writer };
  if (!mayAct()) throw new Error("The service that saves channel settings isn't running. Tell the user.");
  let revision: number;
  try { revision = await kv.put(channel, JSON.stringify(config), { previousSeq: change.expectedRevision }); }
  catch (e) {
    if (isCasLoss(e)) throw new ChannelRegistryConflict("channel revision changed; read it before retrying");
    throw e;
  }
  return { revision, writer, ...(change.remove ? {} : { config }) };
}

/** Bind the delivery host's channel writer. Identity and channel come only from the broker-policed subject. */
export function serveChannelConfig(nc: NatsConnection, space: string, kv: KV, mayAct: () => boolean, onError: (e: Error) => void): Subscription {
  const filter = channelConfigSubject(space, "*.*", ">");
  const sub = nc.subscribe(filter, { queue: "channel-config" });
  void (async () => {
    for await (const msg of sub) {
      const [, , , , owner, actor, , ...tail] = msg.subject.split(".");
      if (!owner || !actor) continue;
      const replyPrefix = channelConfigReplySubject(space, `${owner}.${actor}`, "");
      if (!msg.reply?.startsWith(replyPrefix) || !/^[a-f0-9-]{36}$/.test(msg.reply.slice(replyPrefix.length))) continue;
      let body: object;
      try {
        if (!mayAct()) throw new Error("The service that saves channel settings isn't running. Tell the user.");
        const change = msg.json<ChannelChange>();
        const state = await changeChannelConfig(kv, tail.join("."), change, principalKey(owner, actor).key, mayAct);
        body = { ok: true, data: state };
      } catch (e) { body = { ok: false, error: (e as Error).message, ...(e instanceof ChannelRegistryConflict ? { code: "CONFLICT" } : {}) }; }
      msg.respond(JSON.stringify(body));
    }
  })().catch(onError);
  return sub;
}
