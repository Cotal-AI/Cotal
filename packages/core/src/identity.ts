import { createUser, fromSeed } from "@nats-io/nkeys";

/**
 * A locally-generated agent identity (an nkey user keypair).
 *
 * The public key is the **stable id** used identically everywhere — `card.id`, the
 * subject-encoded sender token, the JWT subject, and the DM durable name — so the
 * server's ACLs and the wire layout stay in lockstep. The seed is the private half:
 * it never goes on the wire and (from the provisioning step on) is signed into a
 * creds file the endpoint loads to authenticate as this id.
 */
export interface Identity {
  /** User nkey public key (`U…`). The stable agent id. */
  id: string;
  /** User nkey seed (`SU…`). Private — kept off the wire. */
  seed: string;
}

/** Generate a fresh user nkey identity locally. The seed is derived here and never
 *  leaves the generating process except as a creds file handed to its own agent. */
export function newIdentity(): Identity {
  const kp = createUser();
  const seed = new TextDecoder().decode(kp.getSeed());
  return { id: kp.getPublicKey(), seed };
}

/** The signing half an authority-bearing artifact needs: `signArtifact` / `mintSessionGrant`
 *  take exactly `{ sign(input): Uint8Array }`, and the matching `publicKey` is what the
 *  verifying anchor pins. An nkey KeyPair already satisfies both; this narrows it to the
 *  artifact surface so a consumer that must not depend on `@nats-io/nkeys` directly (an
 *  `implementations/*` package) can still sign — core owns the signing primitive. */
export interface ArtifactSigner {
  /** The signer's nkey public key (`U…`) — the `SignerAnchor.publicKey` a verifier resolves. */
  publicKey: string;
  /** Ed25519 signature over an artifact's canonical signature input. */
  sign(input: Uint8Array): Uint8Array;
}

/** Build an artifact signer from an existing nkey seed (e.g. an endpoint's own key material).
 *  The seed never leaves the process; only signatures + the public key do. */
export function artifactSignerFromSeed(seed: string): ArtifactSigner {
  const kp = fromSeed(new TextEncoder().encode(seed));
  return { publicKey: kp.getPublicKey(), sign: (input) => kp.sign(input) };
}

/** A fresh artifact signer (its own keypair + seed): for a self-signing endpoint that mints its
 *  own session grants and registers the matching public key as its `sessions` trust anchor. */
export function newArtifactSigner(): ArtifactSigner & { seed: string } {
  const { seed } = newIdentity();
  return { ...artifactSignerFromSeed(seed), seed };
}

/** The stable id carried by a creds file: the agent's nkey public key. Derived from the
 *  seed block (format-independent) and cross-checked against the JWT subject — a mismatch
 *  means a corrupt or spliced creds file (a seed paired with someone else's JWT), which
 *  would otherwise auth as one identity while the subject token claims another. Lets an
 *  endpoint that authenticates with creds adopt the matching `card.id`, keeping one id
 *  everywhere. */
export function idFromCreds(creds: string): string {
  return identityFromCreds(creds).id;
}

/** The decoded (UNVERIFIED) claims of a creds file's user JWT — shared parse for every local
 *  inspector (credential health, renewal scheduling, identity checks). Unverified is correct here:
 *  the broker is the enforcement boundary; local readers only need the claims to schedule and
 *  diagnose. Throws on a structurally-unusable file (no JWT block / undecodable payload). */
export function credsClaims(creds: string): { sub?: string; iat?: number; exp?: number; name?: string } {
  const jwtM = creds.match(/BEGIN NATS USER JWT-----\s*([\s\S]*?)\s*------END NATS USER JWT/);
  const payload = jwtM?.[1].trim().split(".")[1];
  if (!payload) throw new Error("creds: no NATS user JWT block found");
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string; iat?: number; exp?: number; name?: string };
  } catch {
    throw new Error("creds: undecodable user JWT payload");
  }
}

/** The full identity (id + seed) carried by a creds file — what a standing-renewal REMINTER needs:
 *  re-signing a fresh JWT for the file's EXISTING nkey (never a new one) is what lets the renewed
 *  cred pass the endpoint's identity pin, so renewal can never silently swap who a daemon is. Same
 *  seed-block parse + JWT-subject cross-check as {@link idFromCreds}. */
export function identityFromCreds(creds: string): Identity {
  const seedM = creds.match(/BEGIN USER NKEY SEED-----\s*([\s\S]*?)\s*------END USER NKEY SEED/);
  if (!seedM) throw new Error("creds: no user nkey seed block found");
  const seed = seedM[1].trim();
  const id = fromSeed(new TextEncoder().encode(seed)).getPublicKey();
  const jwtM = creds.match(/BEGIN NATS USER JWT-----\s*([\s\S]*?)\s*------END NATS USER JWT/);
  const payload = jwtM?.[1].trim().split(".")[1];
  const sub = payload
    ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string }).sub
    : undefined;
  if (sub && sub !== id) throw new Error(`creds: seed identity ${id} != JWT subject ${sub}`);
  return { id, seed };
}
