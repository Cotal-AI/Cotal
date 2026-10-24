/** The node-free half of `issued-authority.ts`: the issued reference, the accepted-row store names and
 *  the client-side accepted-row read, shared by the Node caller and the browser entry. Moved unchanged;
 *  the token derivation stays with each host (`connectionAcceptedToken` hashes synchronously in Node). */
import type { NatsConnection } from "@nats-io/nats-core";
import { EpEnvelopeError } from "./endpoint-error.js";
import { assertGeneration, callerTokens, type EpCaller, type IssuedCaller } from "./endpoint-subjects.js";
import { token } from "./subjects.js";

const dec = new TextDecoder("utf-8", { fatal: true });

/** Issued coordinates carry a canonical space token, never a lossy display-name rewrite. */
export function assertIssuedSpace(space: string): void {
  if (typeof space !== "string" || space.length === 0 || token(space) !== space)
    throw new Error("issued space must be a nonempty canonical subject token ([A-Za-z0-9_-])");
}

/** The four caller coordinates plus the generation. `generation` is 32 lowercase hex characters
 *  of issuer-chosen entropy (at least 128 bits); it is an identifier, never a bearer secret. */
export interface IssuedAuthorityRef extends EpCaller {
  readonly space: string;
  readonly generation: string;
}

export function refSnapshot(value: IssuedAuthorityRef): IssuedAuthorityRef {
  closed(value, ["space", "owner", "actor", "uid", "generation"], "issued reference");
  assertIssuedSpace(value.space);
  callerTokens(value);
  assertGeneration(value.generation);
  return Object.freeze({ space: value.space, owner: value.owner, actor: value.actor, uid: value.uid, generation: value.generation });
}

export function closed(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new Error(`${label} must be a plain record`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) throw new Error(`${label} carries an unsupported field ${String(key)}`);
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) throw new Error(`${label} cannot carry accessors`);
  }
  return value as Record<string, unknown>;
}

/** The per-space accepted-row store. Its own bucket, and `allow_direct` ON: per-key scoping is
 *  only expressible on a `DIRECT.GET` grant, and a stream-wide `STREAM.MSG.GET` on a shared bucket
 *  would let a client read every other client's row. */
export function acceptedBucket(space: string): string {
  return `cotal_accepted_${token(space)}`;
}

export function acceptedKey(acceptedToken: string): string {
  return `accepted.v1.${assertGeneration(acceptedToken, "accepted token")}`;
}

/** Read by the CLIENT over its own connection: the reference the ISSUER wrote, so a client that
 *  proposed or was told a different generation learns the accepted one here. The broker admits
 *  the read only under the ceiling's per-key grant, which is what binds the answer to the
 *  credential this connection presented. */
export async function readAcceptedRow(nc: NatsConnection, space: string, acceptedToken: string, timeoutMs = 3000): Promise<IssuedAuthorityRef> {
  const bucket = acceptedBucket(space);
  const response = await nc.request(`$JS.API.DIRECT.GET.KV_${bucket}.$KV.${bucket}.${acceptedKey(acceptedToken)}`, new Uint8Array(0), { timeout: timeoutMs });
  const status = response.headers?.get("Status");
  if (status) throw new EpEnvelopeError("permission-denied", `no accepted row for this token (${status}); the connection holds no issued authority (SPEC 13.15)`);
  const row = closed(JSON.parse(dec.decode(response.data)), ["version", "ref"], "accepted row");
  if (row.version !== 1) throw new Error("unsupported accepted-row version");
  const ref = refSnapshot(row.ref as IssuedAuthorityRef);
  if (ref.space !== space) throw new EpEnvelopeError("permission-denied", "the accepted row names a foreign space");
  return ref;
}

export async function issuedCallerOfToken(nc: NatsConnection, space: string, acceptedToken: string, expected: EpCaller): Promise<IssuedCaller> {
  const ref = await readAcceptedRow(nc, space, acceptedToken);
  if (ref.owner !== expected.owner || ref.actor !== expected.actor || ref.uid !== expected.uid)
    throw new EpEnvelopeError("permission-denied", `this connection's accepted row names ${ref.owner}.${ref.actor}/${ref.uid}, not the caller ${expected.owner}.${expected.actor}/${expected.uid}; refused (SPEC 13.15)`);
  return { owner: ref.owner, actor: ref.actor, uid: ref.uid, generation: ref.generation } as IssuedCaller;
}
