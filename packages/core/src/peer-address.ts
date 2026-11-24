import type { NatsConnection } from "@nats-io/transport-node";
import { AmbiguousPeerError, resolvePeer } from "./resolve.js";
import { DEV_OWNER, parsePrincipalKey, principalKey } from "./subjects.js";
import type { Presence } from "./types.js";
import type { LivenessAnswer } from "./liveness.js";
import { assertValidUsername, readUsername, readUsernameOwner, UsernameRegistryReadError } from "./username-registry.js";

export type PeerAddressAuthority =
  | { mode: "open" | "static" }
  | { mode: "user"; owner: string; actor: string; space: string; nc: NatsConnection };

export interface PeerAddressOptions {
  /** The caller's bound messaging principal and connection, not a claimed identity. */
  authority: PeerAddressAuthority;
  selfId?: string;
}

export class PeerAddressError extends Error {
  constructor(readonly target: string, readonly code: "USAGE_INVALID" | "TARGET_NOT_FOUND" | "TARGET_UNAVAILABLE" | "PERMISSION_DENIED", message: string,
    readonly addresses: readonly string[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = "PeerAddressError";
  }
}

type UserAuthority = Extract<PeerAddressAuthority, { mode: "user" }>;

async function readRegistry<T>(target: string, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch (cause) {
    if (cause instanceof UsernameRegistryReadError && cause.code === "denied")
      throw new PeerAddressError(target, "PERMISSION_DENIED", `The username registry denied the read for ${JSON.stringify(target)}.`, [], { cause });
    throw new PeerAddressError(target, "TARGET_UNAVAILABLE", `Cannot read the username registry for ${JSON.stringify(target)}.`, [], { cause });
  }
}

export type PeerAddress = { kind: "principal"; value: string } | { kind: "name"; value: string } | { kind: "qualified"; username: string; actor: string };

/** Classify an entire target before performing any lookup. */
export function parsePeerAddress(target: string): PeerAddress {
  const value = target.trim();
  if (parsePrincipalKey(value)) return { kind: "principal", value };
  if (!value.includes("/")) return { kind: "name", value };
  const [user, actor, extra] = value.split("/");
  try {
    if (!user || !/^[A-Za-z0-9_]+$/.test(user) || !actor || !parsePrincipalKey(`local.${actor}`) || extra !== undefined) throw new Error();
    return { kind: "qualified", username: assertValidUsername(user.toLowerCase()), actor };
  } catch {
    throw new PeerAddressError(target, "USAGE_INVALID", `Invalid peer address ${JSON.stringify(target)}. Use user/agent with a username and an actor token.`);
  }
}

/** A routing-only result carries an address but makes no presence observation. */
export interface PrincipalAddress {
  readonly card: { readonly id: string; readonly name: string; readonly kind: "endpoint" };
  readonly routingOnly: true;
  readonly status?: never;
}

export type ResolvedPeerAddress = Presence | PrincipalAddress;

/** A qualified write must see an upgraded delivery reader; an old reply is not a version claim. */
export async function requireQualifiedDmVersion(target: string, peer: ResolvedPeerAddress | undefined, probe: () => Promise<LivenessAnswer>): Promise<ResolvedPeerAddress | undefined> {
  if (!peer || !("routingOnly" in peer)) return peer;
  const delivery = await probe().catch(() => undefined);
  if (delivery?.responder !== "bound" || delivery.qualifiedDmVersion !== 1)
    throw new PeerAddressError(target, "TARGET_UNAVAILABLE", "Qualified direct messages require an upgraded delivery responder. Nothing was sent.");
  return peer;
}

async function qualifiedPeer(target: string, address: Extract<PeerAddress, { kind: "qualified" }>, authority: UserAuthority, selfId: string | undefined): Promise<PrincipalAddress> {
  const { username, actor } = address;
  const { nc, space } = authority;
  const owner = await readRegistry(target, () => readUsernameOwner(nc, space, username));
  if (owner === undefined) throw new PeerAddressError(target, "TARGET_NOT_FOUND", `Unknown username ${JSON.stringify(username)}.`);
  const id = principalKey(owner, actor).key;
  if (id === selfId) throw new PeerAddressError(target, "USAGE_INVALID", `${JSON.stringify(target)} is this session. Choose another peer.`);
  return { card: { id, name: actor, kind: "endpoint" }, routingOnly: true };
}

/** Resolve a typed target without crossing owner namespaces on a bare name. Exact roster IDs win. */
export async function resolvePeerAddress(roster: readonly Presence[], target: string, options: PeerAddressOptions): Promise<ResolvedPeerAddress | undefined> {
  const { authority, selfId } = options;
  const address = parsePeerAddress(target);
  const peers = roster.filter((p) => p.card.id !== selfId);
  if (address.kind === "principal") return peers.find((p) => p.card.id === address.value);
  if (authority.mode !== "user") {
    if (address.kind === "qualified")
      throw new PeerAddressError(target, "USAGE_INVALID", "A user/agent address requires a signed-in space. Use a bare name or an instance ID here.");
    return resolvePeer(peers, target);
  }
  if (address.kind === "qualified") return qualifiedPeer(target, address, authority, selfId);
  const want = address.value;
  const own: Presence[] = [];
  const foreign: { peer: Presence; owner: string; actor: string }[] = [];
  for (const peer of peers) {
    const principal = parsePrincipalKey(peer.card.id);
    if (!principal || (principal.actor !== want && !(peer.card.kind === "agent" && principal.actor.toLowerCase() === want.toLowerCase()))) continue;
    if (principal.owner === authority.owner) own.push(peer);
    else foreign.push({ peer, ...principal });
  }
  const eligible = own.filter((peer) => peer.status !== "offline" || !foreign.some(({ peer: other }) => other.status !== "offline"));
  const explicit = eligible.find((p) => parsePrincipalKey(p.card.id)?.actor === want);
  const pool = explicit ? [explicit] : eligible;
  if (pool.length) {
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
