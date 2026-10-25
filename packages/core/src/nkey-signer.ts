import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { NKeysError, NKeysErrorCode, Prefix, type KeyPair } from "@nats-io/nkeys";
import { Codec } from "@nats-io/nkeys/lib/codec.js";

const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

/** A NATS signing key backed by Node's Ed25519 implementation. NATS still owns key encoding,
 * checksum validation and JWT construction; no key material is cached outside this pair. */
export function nativeNkeySigner(seed: Uint8Array): KeyPair {
  const encodedSeed = Uint8Array.from(seed);
  const decoded = Codec.decodeSeed(encodedSeed);
  if (decoded.buf.byteLength !== 32) {
    decoded.buf.fill(0);
    encodedSeed.fill(0);
    throw new NKeysError(NKeysErrorCode.InvalidSeedLen);
  }
  if (decoded.prefix === Prefix.Curve) {
    decoded.buf.fill(0);
    encodedSeed.fill(0);
    throw new NKeysError(NKeysErrorCode.InvalidCurveOperation);
  }
  const der = Buffer.concat([ED25519_PKCS8, decoded.buf]);
  let privateKey: KeyObject | undefined;
  let publicKey: KeyObject;
  let publicBytes: Buffer;
  let publicNkey: string;
  try {
    privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    publicKey = createPublicKey(privateKey);
    const jwk = publicKey.export({ format: "jwk" });
    if (jwk.crv !== "Ed25519" || typeof jwk.x !== "string") throw new Error("native nkey signer did not derive an Ed25519 public key");
    publicBytes = Buffer.from(jwk.x, "base64url");
    publicNkey = new TextDecoder().decode(Codec.encode(decoded.prefix, publicBytes));
  } catch (error) {
    encodedSeed.fill(0);
    throw error;
  } finally {
    decoded.buf.fill(0);
    der.fill(0);
  }
  const active = (): KeyObject => {
    if (!privateKey) throw new NKeysError(NKeysErrorCode.ClearedPair);
    return privateKey;
  };
  return {
    getPublicKey() { active(); return publicNkey; },
    getSeed() { active(); return encodedSeed.slice(); },
    getPrivateKey() {
      active();
      const raw = Codec.decodeSeed(encodedSeed).buf;
      const secret = Buffer.concat([raw, publicBytes]);
      try { return Codec.encode(Prefix.Private, secret); }
      finally { raw.fill(0); secret.fill(0); }
    },
    sign(input) { return sign(null, input, active()); },
    verify(input, signature) { active(); return verify(null, input, publicKey, signature); },
    clear() { encodedSeed.fill(0); privateKey = undefined; },
    seal() { throw new NKeysError(NKeysErrorCode.InvalidNKeyOperation); },
    open() { throw new NKeysError(NKeysErrorCode.InvalidNKeyOperation); },
  };
}
