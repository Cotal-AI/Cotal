import type { NatsConnection } from "@nats-io/transport-node";
import type { KV } from "@nats-io/kv";
import { canonicalJson } from "../../src/canonical.js";
import { evidenceKey, type IssuedRef } from "./issued-authority-lifecycle.js";

/**
 * The alternative to reading the accepted generation out of `$SYS.REQ.USER.INFO`: the issuer
 * writes it to one row, and the client reads that row itself.
 *
 * This does NOT cost zero delivery paths, and an earlier version of this comment said it did.
 * `readAccepted` is an `nc.request`, so the reply subject is chosen by the caller and the grant
 * does not stop a holder naming the rail instead of its own inbox. The grant therefore adds a
 * `stored-marked` path. Three things still make it the better option: that path arrives carrying
 * `Nats-` markers an endpoint can refuse at ingress, the client cannot write this bucket so it
 * cannot choose the bytes that come back, and `$SYS.REQ.USER.INFO` would instead add a second
 * UNMARKED path whose body carries the connection's own permission ceiling.
 *
 * The key is a token the CLIENT chose and therefore always knows, on both the static and the
 * callout path, where it may not know its own lifecycle uid before connecting.
 */
export function acceptedKey(token: string): string {
  if (!/^[a-f0-9]{32}$/.test(token)) throw new Error("an accepted-row token is 32 lowercase hex characters");
  return `accepted.v1.${token}`;
}

/** Its own bucket, and not the evidence store. Per-key scoping is only expressible on a
 *  `DIRECT.GET` grant, and direct get needs `allow_direct`, which the evidence store deliberately
 *  has off. A stream-wide `STREAM.MSG.GET` would let a client read every other client's row. */
export const acceptedBucket = (space: string) => `cotal_accepted_${space}`;

/** The read grant an issued ceiling carries for exactly its own row, and nothing else. */
export function acceptedReadGrant(space: string, token: string): string {
  const bucket = acceptedBucket(space);
  return `$JS.API.DIRECT.GET.KV_${bucket}.$KV.${bucket}.${acceptedKey(token)}`;
}

/** Written by the issuer at release, create-only: a token is redeemed once. */
export async function writeAccepted(kv: KV, token: string, ref: IssuedRef): Promise<void> {
  evidenceKey(ref);
  await kv.create(acceptedKey(token), new TextEncoder().encode(canonicalJson({ version: 1, ref })));
}

/**
 * Read by the client over its own connection. It returns the reference the ISSUER wrote, so a
 * client that guessed or proposed a different generation learns the real one here.
 */
export async function readAccepted(nc: NatsConnection, space: string, token: string): Promise<IssuedRef> {
  const bucket = acceptedBucket(space);
  const response = await nc.request(
    `$JS.API.DIRECT.GET.KV_${bucket}.$KV.${bucket}.${acceptedKey(token)}`,
    new Uint8Array(0),
    { timeout: 3000 },
  );
  if (response.headers?.get("Status")) throw new Error(`no accepted row for this token: ${response.headers.get("Status")}`);
  const row = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.data)) as { version?: number; ref?: IssuedRef };
  if (row.version !== 1 || !row.ref) throw new Error("unsupported accepted-row version or shape");
  if (row.ref.space !== space) throw new Error("accepted row names a foreign space");
  evidenceKey(row.ref);
  return Object.freeze({ ...row.ref });
}
