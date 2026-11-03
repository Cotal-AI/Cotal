import type { Authenticator } from "@nats-io/nats-core";
import { encode } from "@nats-io/nkeys";
import { nativeNkeySigner } from "./nkey-signer.js";

/** Node connection authentication through the public NATS callback. Read the credential on every
 * attempt and release its temporary signer afterward; no key cache outlives an authentication. */
export function nativeCredsAuthenticator(creds: string | (() => string)): Authenticator {
  return (nonce) => {
    // Match nats-core's decorated-block grammar, including its LF-only envelope handling. Its
    // public credsAuthenticator bundles parsing with JavaScript signing; it exposes no parser hook.
    const blocks = /\s*(?:(?:[-]{3,}[^\n]*[-]{3,}\n)(.+)(?:\n\s*[-]{3,}[^\n]*[-]{3,}\n))/ig;
    const text = typeof creds === "function" ? creds() : creds;
    const jwtBlock = blocks.exec(text);
    if (!jwtBlock) throw new Error("unable to parse credentials");
    const seedBlock = blocks.exec(text);
    if (!seedBlock) throw new Error("unable to parse credentials");
    const seed = new TextEncoder().encode(seedBlock[1]!.trim());
    let signer: ReturnType<typeof nativeNkeySigner> | undefined;
    try {
      signer = nativeNkeySigner(seed);
      return {
        jwt: jwtBlock[1]!.trim(),
        nkey: signer.getPublicKey(),
        sig: nonce ? encode(signer.sign(new TextEncoder().encode(nonce))) : "",
      };
    } finally {
      seed.fill(0);
      signer?.clear();
    }
  };
}
