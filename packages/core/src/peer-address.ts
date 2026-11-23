import { randomUUID } from "node:crypto";
import type { NatsConnection } from "@nats-io/transport-node";
import { AmbiguousPeerError, resolvePeer } from "./resolve.js";
import { DEV_OWNER, parsePrincipalKey, principalKey, spacePrefix } from "./subjects.js";
import { LIFECYCLE_TOKEN } from "./subject-grammar.js";
import type { Presence } from "./types.js";
import { assertValidUsername, readUsername, readUsernameOwner } from "./username-registry.js";

export type PeerAddressAuthority =
  | { mode: "open" | "static" }
  | { mode: "user"; owner: string; actor: string; space: string; nc: NatsConnection };

export interface PeerAddressOptions {
  /** The caller's bound messaging principal and connection, not a claimed identity. */
  authority: PeerAddressAuthority;
  selfId?: string;
}

export class PeerAddressError extends Error {
  constructor(readonly target: string, readonly code: "USAGE_INVALID" | "TARGET_NOT_FOUND" | "TARGET_UNAVAILABLE", message: string,
    readonly addresses: readonly string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = "PeerAddressError";
  }
}

/** The caller-scoped request route for an exact principal's addressability. */
export function peerAddressLookupSubject(space: string, caller: { owner: string; actor: string }): string {
  return `${spacePrefix(space)}.address.${principalKey(caller.owner, caller.actor).key}`;
}

export function peerAddressLookupFilter(space: string): string {
  return `${spacePrefix(space)}.address.*.*`;
}

export function withPeerAddressLookup(space: string, caller: { owner: string; actor: string }, permissions: Record<string, unknown>): Record<string, unknown> {
  const subject = peerAddressLookupSubject(space, caller);
  const pub = permissions.pub as { allow?: string[] } | undefined;
  const sub = permissions.sub as { allow?: string[] } | undefined;
  return { ...permissions, pub: { ...pub, allow: [...pub?.allow ?? [], subject] }, sub: { ...sub, allow: [...sub?.allow ?? [], `${subject}.reply.*`] } };
}

type UserAuthority = Extract<PeerAddressAuthority, { mode: "user" }>;

async function readRegistry<T>(target: string, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (cause) { throw new PeerAddressError(target, "TARGET_UNAVAILABLE", `Cannot read the username registry for ${JSON.stringify(target)}.`, [], { cause }); }
}

const ACTOR = /^[A-Za-z0-9_]{1,64}$/;

async function qualifiedPeer(roster: readonly Presence[], target: string, authority: UserAuthority, selfId: string | undefined): Promise<Presence> {
  const [user, actor, extra] = target.trim().split("/");
  let username: string;
  try {
    if (!user || !ACTOR.test(user) || !actor || !ACTOR.test(actor) || extra !== undefined) throw new Error();
    username = assertValidUsername(user.toLowerCase());
  } catch {
    throw new PeerAddressError(target, "USAGE_INVALID", `Invalid peer address ${JSON.stringify(target)}. Use user/agent with a username and a launch name.`);
  }
  const { nc, space } = authority;
  const owner = await readRegistry(target, () => readUsernameOwner(nc, space, username));
  if (owner === undefined) throw new PeerAddressError(target, "TARGET_NOT_FOUND", `Unknown username ${JSON.stringify(username)}.`);
  const id = principalKey(owner, actor).key;
  if (id === selfId) throw new PeerAddressError(target, "USAGE_INVALID", `${JSON.stringify(target)} is this session. Choose another peer.`);
  const subject = peerAddressLookupSubject(space, authority);
  let lifecycleUid: string | null;
  try {
    const reply = await nc.request(subject, id, { timeout: 2_000, noMux: true, reply: `${subject}.reply.${randomUUID()}` });
    const result = reply.json<{ id?: unknown; lifecycleUid?: unknown }>();
    if (result.id !== id || (result.lifecycleUid !== null && (typeof result.lifecycleUid !== "string" || !LIFECYCLE_TOKEN.test(result.lifecycleUid))))
      throw new Error("invalid principal lookup reply");
    lifecycleUid = result.lifecycleUid;
  } catch (cause) {
    throw new PeerAddressError(target, "TARGET_UNAVAILABLE", `Cannot verify the registered agent for ${JSON.stringify(target)}.`, [], { cause });
  }
  if (!lifecycleUid) throw new PeerAddressError(target, "TARGET_NOT_FOUND", `Username ${JSON.stringify(username)} has no agent ${JSON.stringify(actor)}.`);
  const observed = roster.find((p) => p.card.id === id && p.lifecycleUid === lifecycleUid);
  return observed ?? { card: { id, name: actor, kind: "agent", owner, actor }, lifecycleUid, status: "offline", ts: 0 };
}

/** Resolve a typed target without crossing owner namespaces on a bare name. Exact roster IDs win. */
export async function resolvePeerAddress(roster: readonly Presence[], target: string, options: PeerAddressOptions): Promise<Presence | undefined> {
  const { authority, selfId } = options;
  const peers = roster.filter((p) => p.card.id !== selfId);
  const exact = peers.find((p) => p.card.id === target);
  if (exact) return exact;
  if (authority.mode !== "user") {
    const legacy = resolvePeer(peers, target);
    if (!legacy && target.includes("/"))
      throw new PeerAddressError(target, "USAGE_INVALID", "A user/agent address requires a signed-in space. Use a bare name or an instance ID here.");
    return legacy;
  }
  if (target.includes("/")) return qualifiedPeer(peers, target, authority, selfId);
  const want = target.trim();
  const own: Presence[] = [];
  const foreign: { peer: Presence; owner: string; actor: string }[] = [];
  for (const peer of peers) {
    const principal = parsePrincipalKey(peer.card.id);
    if (principal?.actor !== want) continue;
    if (principal.owner === authority.owner) own.push(peer);
    else foreign.push({ peer, ...principal });
  }
  const live = own.filter((p) => p.status !== "offline");
  if (live.length || (own.length && !foreign.some(({ peer }) => peer.status !== "offline"))) {
    const pool = live.length ? live : own;
    if (pool.length === 1) return pool[0];
    throw new AmbiguousPeerError(target, pool.map(({ card: { id, name, role }, status, ts }) => ({ id, name, role, status, ts })));
  }
  if (!foreign.length) return undefined;
  const addresses = [...new Set(await readRegistry(target, () => Promise.all(foreign.map(async ({ peer, owner, actor }) => {
    const username = owner === DEV_OWNER ? undefined : await readUsername(authority.nc, authority.space, owner);
    return username ? `${username}/${actor}` : peer.card.id;
  }))))].sort();
  throw new PeerAddressError(target, "TARGET_NOT_FOUND",
    `No agent you own matches ${JSON.stringify(target)}. Address another owner's agent explicitly: ${addresses.join(", ")}.`, addresses);
}
