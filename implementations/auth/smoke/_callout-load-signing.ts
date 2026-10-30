import { identityFromCreds, jwtFromCreds, nativeNkeySigner } from "@cotal-ai/core";
import { encode } from "@nats-io/nkeys";
import type { Authenticator } from "@nats-io/transport-node";

export type ClientSigning = "nats" | "native" | "core";

/** The explicitly selected load-client backend; unknown child jobs and flags refuse. */
export function clientSigning(value: unknown): ClientSigning {
  if (value === "nats" || value === "native" || value === "core") return value;
  throw new Error("callout-load: --client-signing must be nats, native or core");
}

/** Test-only native nonce signing for this job's generated, static sentinel credential. The JWT,
 * public key and nonce signature still travel through the public NATS Authenticator interface. */
export function nativeLoadAuthenticator(creds: string): { authenticator: Authenticator; clear(): void } {
  const jwt = jwtFromCreds(creds);
  if (!jwt) throw new Error("callout-load: sentinel credential has no user JWT");
  const seed = new TextEncoder().encode(identityFromCreds(creds).seed);
  let signer: ReturnType<typeof nativeNkeySigner>;
  try { signer = nativeNkeySigner(seed); }
  finally { seed.fill(0); }
  return {
    authenticator(nonce) {
      return {
        jwt,
        nkey: signer.getPublicKey(),
        sig: nonce ? encode(signer.sign(new TextEncoder().encode(nonce))) : "",
      };
    },
    clear() { signer.clear(); },
  };
}
