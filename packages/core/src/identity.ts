import { createHash } from "node:crypto";
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

/** The compact USER JWT carried by a creds file — ONE extraction, shared by every reader that
 *  needs the token rather than the whole envelope. Returns undefined when there is no JWT block;
 *  callers decide whether that is fatal. */
export function jwtFromCreds(creds: string): string | undefined {
  return creds.match(/BEGIN NATS USER JWT-----\s*([\s\S]*?)\s*------END NATS USER JWT/)?.[1].trim();
}

/** A non-secret GENERATION token for a credential: SHA-256 of its compact USER JWT.
 *
 *  The JWT, not the whole creds envelope, on purpose. The JWT is exactly what the broker is
 *  presented with, so hashing it binds the claims, permissions, and signature of the generation
 *  being adopted. The envelope additionally carries the nkey SEED, so hashing that would put a
 *  stable secret-derived token on a control rail and make the value sensitive to envelope
 *  formatting, without proving anything more about broker authorization. The seed stays bound
 *  separately: {@link identityFromCreds} rejects a seed whose public key is not the JWT subject.
 *
 *  Safe to send on the privileged rail as an EXPECTED-generation token; the credential itself is
 *  never sent. Ephemeral by contract — it must not be persisted (see the renewal record). */
export function credsFingerprint(creds: string): string {
  const jwt = jwtFromCreds(creds);
  if (!jwt) throw new Error("creds: no NATS user JWT block found - cannot fingerprint");
  return createHash("sha256").update(jwt).digest("hex");
}

/** The decoded (UNVERIFIED) claims of a creds file's user JWT — shared parse for every local
 *  inspector (credential health, renewal scheduling, identity checks). Unverified is correct here:
 *  the broker is the enforcement boundary; local readers only need the claims to schedule and
 *  diagnose. Throws on a structurally-unusable file (no JWT block / undecodable payload). */
export function credsClaims(creds: string): { sub?: string; iat?: number; exp?: number; name?: string; iss?: string } {
  const payload = jwtFromCreds(creds)?.split(".")[1];
  if (!payload) throw new Error("creds: no NATS user JWT block found");
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string; iat?: number; exp?: number; name?: string; iss?: string };
  } catch {
    throw new Error("creds: undecodable user JWT payload");
  }
}

/** Ms until a source-fed cred's RENEWAL point — 75% of its iat→exp lifetime (the cert-manager-style
 *  renew-early convention: the remaining 25% is the loud-failure window, wide for day-scale standing
 *  creds). Negative when already past it. A source-fed cred WITHOUT a numeric `exp` is fail-loud: the
 *  renewal seam exists precisely for bounded creds, so an unbounded one signals a matrix/caller
 *  mismatch, not a cred to keep silently forever. Shared by the endpoint's `delivery.creds` renewal
 *  and the membership feed's rw-cred renewal so the 75% convention is defined once. */
export function credsRenewalDelayMs(creds: string): number {
  const claims = credsClaims(creds); // throws on a structurally-unusable file (fail-loud)
  if (typeof claims.exp !== "number")
    throw new Error("creds source returned a cred without a numeric exp - a standing-renewal endpoint requires bounded creds (mint with a lifetime, or pass a static string instead of a source)");
  const iatMs = (typeof claims.iat === "number" ? claims.iat : Date.now() / 1000) * 1000;
  const expMs = claims.exp * 1000;
  return iatMs + 0.75 * (expMs - iatMs) - Date.now();
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
  const payload = jwtFromCreds(creds)?.split(".")[1];
  const sub = payload
    ? (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string }).sub
    : undefined;
  if (sub && sub !== id) throw new Error(`creds: seed identity ${id} != JWT subject ${sub}`);
  return { id, seed };
}
