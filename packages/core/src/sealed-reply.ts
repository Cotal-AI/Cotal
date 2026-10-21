/**
 * One-time sealing of a reply to its caller. The caller mints a {@link SealRecipient}, sends only
 * its public `X…` curve key, and keeps the private half in memory. The replier calls
 * {@link sealJson}, which seals under a fresh one-time sender key and clears that key before it
 * returns, and sends the sender's public key beside the sealed bytes. Only the recipient opens
 * them.
 *
 * The cryptography is `@nats-io/nkeys` curve keys, unchanged: NaCl box (X25519 and
 * XSalsa20-Poly1305) framed as `xkv1`, a random 24-byte nonce, then the box. That is the xkey format
 * NATS uses to seal auth-callout responses. A sealed reply is confidential to its recipient. It
 * does not identify the replier, because the sender key is one-time, so the rail that carried the
 * reply stays the trust anchor and the opener checks every field it expects inside.
 */
import { createCurve, fromPublic, type KeyPair } from "@nats-io/nkeys";
import { base64url, fromBase64url } from "./base64url.js";

/** Whether `key` is an encoded curve public key: `X`, 55 more base32 characters and a valid
 *  checksum. */
export function isCurvePublicKey(key: string): boolean {
  if (!/^X[A-Z2-7]{55}$/.test(key)) return false;
  try {
    fromPublic(key);
    return true;
  } catch {
    return false;
  }
}

/** Seal `value`, as JSON, to the curve key `recipient` under a one-time sender key. `sealed` is
 *  base64url. Throws for a recipient that is not a curve public key. */
export function sealJson(value: unknown, recipient: string): { sealer: string; sealed: string } {
  if (!isCurvePublicKey(recipient)) throw new Error("the seal recipient is not a curve public key");
  const sender = createCurve();
  try {
    const sealed = sender.seal(new TextEncoder().encode(JSON.stringify(value)), recipient);
    return { sealer: sender.getPublicKey(), sealed: base64url(sealed) };
  } finally {
    sender.clear();
  }
}

/** A one-time curve key for receiving one sealed reply. It opens at most once and is cleared
 *  then, or by {@link SealRecipient.clear}. */
export class SealRecipient {
  readonly publicKey: string;
  private key: KeyPair | undefined;

  constructor() {
    this.key = createCurve();
    this.publicKey = this.key.getPublicKey();
  }

  /** The JSON value `sealer` sealed to this key, or undefined when the bytes do not open or are
   *  not JSON, or this key was already used or cleared. */
  openJson(sealed: string, sealer: string): unknown {
    const key = this.key;
    this.key = undefined;
    if (!key) return undefined;
    try {
      const opened = key.open(fromBase64url(sealed), sealer);
      return opened ? JSON.parse(new TextDecoder().decode(opened)) : undefined;
    } catch {
      return undefined;
    } finally {
      key.clear();
    }
  }

  clear(): void {
    this.key?.clear();
    this.key = undefined;
  }
}
