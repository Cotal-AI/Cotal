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

/** The stable id carried by a creds file: the agent's nkey public key. Derived from the
 *  seed block (format-independent) and cross-checked against the JWT subject — a mismatch
 *  means a corrupt or spliced creds file (a seed paired with someone else's JWT), which
 *  would otherwise auth as one identity while the subject token claims another. Lets an
 *  endpoint that authenticates with creds adopt the matching `card.id`, keeping one id
 *  everywhere. */
export function idFromCreds(creds: string): string {
  return identityFromCreds(creds).id;
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
