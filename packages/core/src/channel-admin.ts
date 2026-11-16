import type { KV } from "@nats-io/kv";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import { randomUUID } from "node:crypto";
import { assertValidChannel, isConcreteChannel, parsePrincipalKey, principalKey, spacePrefix } from "./subjects.js";
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

/** Read the current revision even after removal, so recreating a channel cannot ignore a concurrent edit. */
export async function readChannelState(kv: KV, channel: string): Promise<ChannelState> {
  const entry = await kv.get(channel);
  if (!entry) return { revision: 0 };
  if (entry.operation !== "PUT") return { revision: entry.revision };
  let config: ChannelConfig;
  try { config = decodeChannelEntry(entry); }
  catch (e) { throw new UndecodableRegistryEntry(channel, (e as Error).message); }
  return { revision: entry.revision, writer: config.writer, ...(config.removed ? {} : { config }) };
}

/** One explicit-revision write. A removal keeps an attributed tombstone, without changing messages or ACLs. */
export async function changeChannelConfig(kv: KV, channel: string, change: ChannelChange, writer: string, mayAct: () => boolean = () => true): Promise<ChannelState> {
  assertValidChannel(channel);
  if (!isConcreteChannel(channel)) throw new Error("channel change needs one concrete channel");
  validateChannelChange(change);
  if (writer !== "operator" && !parsePrincipalKey(writer)) throw new Error("invalid channel writer principal");
  const current = await readChannelState(kv, channel);
  if (current.revision !== change.expectedRevision) throw new ChannelRegistryConflict("channel revision changed; read it before retrying");
  const config: ChannelConfig = change.remove
    ? { removed: true, writer }
    : { ...current.config, ...change.patch, writer };
  if (!mayAct()) throw new Error("channel administration stopped serving before the write; read before retrying");
  let revision: number;
  try { revision = await kv.put(channel, JSON.stringify(config), { previousSeq: change.expectedRevision }); }
  catch (e) {
    if (isCasLoss(e)) throw new ChannelRegistryConflict("channel revision changed; read it before retrying");
    throw e;
  }
  return { revision, writer, ...(change.remove ? {} : { config }) };
}

/** The request carries the channel in the subject, where the broker can enforce the caller's post ACL. */
export function channelAdminSubject(space: string, owner: string, actor: string, channel: string): string {
  return `${spacePrefix(space)}.ctl.channel-admin.${principalKey(owner, actor).key}.write.${channel}`;
}

/** Caller reply rail, separate from every write subject so a channel wildcard cannot forge replies. */
export function channelAdminReply(space: string, owner: string, actor: string): string {
  return `${spacePrefix(space)}.ctl.channel-admin.${principalKey(owner, actor).key}.reply.${randomUUID()}`;
}

/** Bind the delivery host's channel writer. Identity and channel come only from the broker-policed subject. */
export function serveChannelAdmin(nc: NatsConnection, space: string, kv: KV, mayAct: () => boolean, onError: (e: Error) => void): Subscription {
  const prefix = `${spacePrefix(space)}.ctl.channel-admin.`;
  const sub = nc.subscribe(`${prefix}*.*.write.>`, { queue: "channel-admin" });
  void (async () => {
    for await (const msg of sub) {
      const parts = msg.subject.slice(prefix.length).split(".");
      const [owner, actor, verb, ...tail] = parts;
      if (!owner || !actor || verb !== "write") continue;
      const replyPrefix = `${prefix}${owner}.${actor}.reply.`;
      if (!msg.reply?.startsWith(replyPrefix) || !/^[a-f0-9-]{36}$/.test(msg.reply.slice(replyPrefix.length))) continue;
      let body: object;
      try {
        if (!mayAct()) throw new Error("channel administration is not serving; retry after reading the channel");
        const change = msg.json<ChannelChange>();
        validateChannelChange(change);
        const state = await changeChannelConfig(kv, tail.join("."), change, principalKey(owner, actor).key, mayAct);
        body = { ok: true, data: state };
      } catch (e) { body = { ok: false, error: (e as Error).message, ...(e instanceof ChannelRegistryConflict ? { code: "CONFLICT" } : {}) }; }
      msg.respond(JSON.stringify(body));
    }
  })().catch(onError);
  return sub;
}
