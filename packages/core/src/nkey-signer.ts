import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { fromPublic, NKeysError, NKeysErrorCode, Prefix, type KeyPair } from "@nats-io/nkeys";
import { Codec } from "@nats-io/nkeys/lib/codec.js";

const ED25519_PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

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

/** The claims of a NATS JWT whose signature its own `iss` public nkey verifies. It makes the checks
 * `@nats-io/jwt`'s `decode` makes and reads the JSON as it does, one byte per character, but verifies
 * the Ed25519 signature with Node rather than that library's JavaScript curve, which costs
 * milliseconds per call. Like `decode`, it proves only that the issuer signed the token: the caller
 * decides whether it trusts that issuer. */
export function decodeNatsJwt<T>(jwt: string): T {
  const chunks = jwt.split(".");
  if (chunks.length !== 3) throw new Error(`invalid jwt - ${chunks.length} chunks`);
  const header = JSON.parse(Buffer.from(chunks[0]!, "base64url").toString("latin1")) as { typ?: unknown; alg?: unknown };
  if (header.typ !== "jwt" && header.typ !== "JWT") throw new Error(`not a nats jwt - typ ${String(header.typ)}`);
  if (header.alg !== "ed25519" && header.alg !== "ed25519-nkey") throw new Error(`not a nats jwt - alg ${String(header.alg)}`);
  const claims = JSON.parse(Buffer.from(chunks[1]!, "base64url").toString("latin1")) as { iss?: unknown };
  if (typeof claims.iss !== "string") throw new Error("not a nats jwt - no issuer");
  fromPublic(claims.iss); // a public nkey with a valid prefix and checksum
  const raw = Codec._decode(new TextEncoder().encode(claims.iss));
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw.subarray(1)]), format: "der", type: "spki" });
  const signed = header.alg === "ed25519-nkey" ? `${chunks[0]}.${chunks[1]}` : chunks[1]!;
  if (!verify(null, Buffer.from(signed), key, Buffer.from(chunks[2]!, "base64url"))) throw new Error("sig verification failed");
  return claims as T;
}
